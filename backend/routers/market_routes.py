from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import astock
import review_context
import review_mail
import review_snapshot
import review_warmup
from api_common import BOARD_FLOW_N, BOARD_FLOW_TTL, _cached, _DC_CACHE, _dc, commodity_quote_ttl

router = APIRouter(tags=["market"])

@router.get("/api/market/review-warmup")
def market_review_warmup_status():
    """复盘缓存预热状态（后台 daemon；可用 VR_REVIEW_WARMUP=0 关闭）。"""
    return {"data": review_warmup.status()}


class ReviewMailPrefsIn(BaseModel):
    enabled: bool | None = None
    at: str | None = Field(None, description="HH:MM, Asia/Shanghai")
    to: str | None = Field(None, description="recipient; empty falls back to env")


@router.get("/api/market/review-mail")
def market_review_mail_status():
    """定时复盘邮件状态。不返回 SMTP 密码或 API key。"""
    return {"data": review_mail.status()}


@router.put("/api/market/review-mail")
def market_review_mail_save(body: ReviewMailPrefsIn):
    """保存开关 / 时间 / 收件人。立刻生效, 不必重启。不写 SMTP 密码或模型 key。"""
    try:
        review_mail.save_prefs(body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"data": review_mail.status()}


@router.post("/api/market/review-mail/run")
def market_review_mail_run():
    """立刻跑一轮复盘并发信 (忽略当日是否已发)。配置不全时 400。"""
    out = review_mail.run_once(force=True)
    if not out.get("ok"):
        raise HTTPException(400, out.get("error") or "复盘邮件失败")
    return {"data": out}


@router.get("/api/market/review-snapshot")
def market_review_snapshot(
    scope: str = Query("full", description="paint|top|full"),
):
    """每日复盘首屏聚合。读同一套 TTL 缓存, 避免前端 10+ 请求撞东财串行锁。"""
    sc = (scope or "full").strip().lower()
    if sc not in ("paint", "top", "full"):
        raise HTTPException(400, "scope 须为 paint / top / full")
    try:
        return {"data": review_snapshot.build_review_snapshot(scope=sc)}
    except Exception as e:
        raise HTTPException(502, f"复盘快照异常：{e}") from e


class ReviewContextIn(BaseModel):
    watch_codes: list[str] = Field(default_factory=list)
    sector_kind: str = "01"
    news_source: str = "cls"


@router.post("/api/market/review-context")
def market_review_context(body: ReviewContextIn):
    """Pack 复盘上下文 for 问 AI. Same text as the scheduled review mail."""
    kind = "02" if str(body.sector_kind) == "02" else "01"
    src = str(body.news_source)
    if src not in ("lives", "jin10"):
        src = "cls"
    codes = [str(c).strip() for c in (body.watch_codes or []) if str(c).strip()][:20]
    try:
        data, errors = review_snapshot.collect_review_bundle(
            sector_kind=kind,
            news_source=src,
            watch_codes=codes,
        )
        text = review_context.pack_review_context(data)
        review_context.save_archive(text)
    except Exception as e:
        raise HTTPException(502, f"复盘上下文异常：{e}") from e
    return {
        "data": {
            "text": text,
            "missing": review_context.missing_panels(text),
            "prompt_task": review_context.REVIEW_PROMPT_TASK,
            "errors": errors[-8:],
        }
    }


@router.get("/api/market/review-archive-diff")
def market_review_archive_diff():
    """今日打包 vs 上一档. 钥匙 review_archive_diff, 不进预热, 不另开 snapshot."""

    def fetch():
        data, errors = review_snapshot.collect_review_bundle()
        text = review_context.pack_review_context(data)
        out = review_context.archive_diff(text)
        out["errors"] = errors[-8:]
        return out

    try:
        return {"data": _cached(
            "review_archive_diff",
            review_context.today_bj(),
            60,
            fetch,
            valid=lambda v: isinstance(v, dict) and v.get("status") in (
                "need_two_runs", "unchanged", "changed",
            ),
        )}
    except Exception as e:
        raise HTTPException(502, f"复盘对照异常：{e}") from e


def _parse_flow_codes(codes: str, cap: int = 40) -> list[str]:
    raw: list[str] = []
    seen: set[str] = set()
    for part in codes.split(","):
        k = part.strip()
        if len(k) >= 8 and k[:2].isalpha():
            k = k[2:]
        if not (k.isdigit() and len(k) == 6) or k in seen:
            continue
        seen.add(k)
        raw.append(k)
        if len(raw) >= cap:
            break
    return raw


def _flow_cached(raw: list[str]) -> dict[str, dict]:
    import cockpit_live
    out: dict[str, dict] = {}
    miss: list[str] = []
    for c in raw:
        key = ("stock_flow_ulist", c)
        if key in _DC_CACHE:
            out[c] = _DC_CACHE.get(key)
        else:
            miss.append(c)
    if miss:
        fetched = cockpit_live.stock_flow_map(miss)
        for c in miss:
            val = fetched.get(c) or {"main_net": None, "main_pct": None, "netIn": None, "netRatio": None}
            _DC_CACHE.set(("stock_flow_ulist", c), val, ttl=30)
            out[c] = val
    return out


@router.get("/api/market/stock-flows")
def market_stock_flows(codes: str = Query(..., min_length=6, max_length=400)):
    """Quote-row fund flow. Same as marketingdashboard /api/stock-flows: ulist, 30s, max 40."""
    raw = _parse_flow_codes(codes)
    if not raw:
        raise HTTPException(400, "codes 须为逗号分隔的 6 位 A 股代码")
    try:
        cached = _flow_cached(raw)
    except Exception as e:
        raise HTTPException(502, f"自选资金流异常: {e}") from e
    rows = []
    for c in raw:
        rec = cached.get(c) or {}
        if rec.get("netIn") is None and rec.get("main_net") is None:
            continue
        net = rec.get("netIn") if rec.get("netIn") is not None else rec.get("main_net")
        ratio = rec.get("netRatio") if rec.get("netRatio") is not None else rec.get("main_pct")
        rows.append({"code": c, "netIn": net, "netRatio": ratio})
    return {"data": rows}


@router.get("/api/market/stock-flow-batch")
def market_stock_flow_batch(codes: str = Query(..., min_length=6, max_length=400)):
    """Map form of stock-flows (code -> main_net / main_pct)."""
    raw = _parse_flow_codes(codes)
    if not raw:
        raise HTTPException(400, "codes 须为逗号分隔的 6 位 A 股代码")
    try:
        return {"data": _flow_cached(raw)}
    except Exception as e:
        raise HTTPException(502, f"自选资金流异常: {e}") from e


@router.get("/api/market/stock-flow")
def market_stock_flow(
    top: int = Query(15, ge=5, le=40),
    board: str | None = Query(None, description="BK#### industry/concept board"),
):
    """个股主力净流入排行(东财 clist). 可按板块成分过滤. 缓存 2 分钟."""
    import astock_boards
    try:
        key = f"{(board or 'all').strip().upper()}:{top}"
        data = _dc(
            "stock_flow",
            key,
            120,
            lambda: astock_boards.stock_moneyflow(top, board),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"个股资金流异常：{e}") from e


@router.get("/api/market/hsgt")
def market_hsgt():
    """北向资金分钟流向（同花顺；深股通仅供参考）。缓存 2 分钟。"""
    import astock_boards
    try:
        data = _dc("hsgt", "live", 120, astock_boards.hsgt_realtime)
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"北向资金异常：{e}") from e


@router.get("/api/market/breadth")
def market_breadth():
    """Full A-share change-pct percentiles + 8-band histogram. Cache 3 min."""
    import cross_section
    try:
        return {"data": cross_section.market_breadth()}
    except Exception as e:
        raise HTTPException(502, f"涨跌幅分位异常：{e}") from e


@router.get("/api/market/ths-profile")
def market_ths_profile(code: str = Query(..., description="6-digit A-share code")):
    """shy313 Tonghuashun industry path + concepts for one stock."""
    import ths_ext
    c = (code or "").strip()
    if not c.isdigit() or len(c) != 6:
        raise HTTPException(400, "代码必须是 6 位数字")
    try:
        return {"data": ths_ext.profile(c)}
    except Exception as e:
        raise HTTPException(502, f"同花顺归属异常：{e}") from e


@router.get("/api/market/ths-rotation")
def market_ths_rotation(
    kind: str = Query("concept", description="concept|industry"),
    top: int = Query(15, ge=5, le=40),
):
    """THS concept/industry today avg change-pct (shy313 members x Eastmoney clist)."""
    import ths_ext
    k = (kind or "concept").strip().lower()
    if k not in ("concept", "industry"):
        raise HTTPException(400, "kind 须为 concept 或 industry")
    try:
        return {"data": ths_ext.rotation(k, top)}
    except Exception as e:
        raise HTTPException(502, f"同花顺轮动异常：{e}") from e


@router.get("/api/iwencai/status")
def iwencai_status():
    """iwencai 是否已配置 API key（不暴露 key）。"""
    return {"data": {"configured": astock.iwencai_configured()}}


@router.get("/api/iwencai/select")
def iwencai_select(
    q: str = Query(..., min_length=1, max_length=80),
    limit: int = Query(12, ge=1, le=30),
):
    """iwencai 选股 (/v1/query2data)。客观名单, 不附推荐。需 IWENCAI_API_KEY。"""
    try:
        return {"data": astock.iwencai_select(q, limit=limit)}
    except astock.DependencyMissing as e:
        raise HTTPException(501, str(e)) from e
    except Exception as e:
        msg = str(e)
        status = 429 if "次数已用完" in msg else 502
        raise HTTPException(status, f"iwencai 选股异常：{e}") from e


@router.get("/api/cls-telegraph")
def cls_telegraph(limit: int = Query(50, ge=10, le=100)):
    """财联社电报（全市场实时快讯，零 key）。缓存 120 秒，长过整页预热 90 秒。客观呈现，不附推荐。"""
    try:
        data = _dc(
            "cls_tg",
            str(limit),
            120,
            lambda: astock.cls_telegraph(limit),
        )
        if not data:
            raise HTTPException(404, "财联社电报暂无数据")
        return {"data": {"source": "财联社", "count": len(data), "items": data}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"财联社电报异常：{e}") from e


@router.get("/api/market/etf-shares")
def market_etf_shares(
    code: str = Query("510300", description="6-digit ETF code"),
    codes: str | None = Query(None, description="comma-separated, e.g. 510050,510300,510500,588000,159915,159919"),
    n: int = Query(80, ge=20, le=250),
):
    """ETF daily shares (SSE/SZSE) + quarterly subscribe/redeem (Eastmoney). Cache 10 min."""
    import etf_shares
    many = [c.strip() for c in (codes or "").split(",") if c.strip()]
    try:
        if many:
            key = f"{','.join(many)}:{n}"
            data = _dc(
                "etf_shares_many",
                key,
                600,
                lambda: etf_shares.etf_shares_many(many, n),
            )
        else:
            raw = (code or "").strip()
            data = _dc(
                "etf_shares",
                f"{raw}:{n}",
                600,
                lambda: etf_shares.etf_shares(raw, n),
            )
        return {"data": data}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"ETF份额异常：{e}") from e


@router.get("/api/market/etf-flow")
def market_etf_flow(
    sort_by: str = Query("net_inflow", description="net_inflow|change_pct"),
    limit: int = Query(40, ge=5, le=100),
):
    """ETF 资金流向排行（东财）。金额单位亿元。客观公开榜单。缓存 3 分钟。"""
    sb = sort_by if sort_by in ("net_inflow", "change_pct") else "net_inflow"
    try:
        key = f"{sb}:{limit}"
        rows = _dc(
            "etf_flow",
            key,
            180,
            lambda: astock.etf_fund_flow(sb, limit),
        )
        return {
            "data": {
                "sort_by": sb,
                "total": len(rows),
                "note": "客观公开榜单 · 东财 ETF 资金流 · 非推荐",
                "rows": rows,
            }
        }
    except Exception as e:
        raise HTTPException(502, f"ETF 资金流异常：{e}") from e


@router.get("/api/market/lpr")
def market_lpr(days: int = Query(365, ge=30, le=2000)):
    """LPR 贷款市场报价利率（全国银行间同业拆借中心）。缓存 1 小时。"""
    try:
        rows = _dc("lpr", str(days), 3600, lambda: astock.lpr_rates(days))
        latest = rows[0] if rows else None
        return {
            "data": {
                "latest": latest,
                "total": len(rows),
                "source": "chinamoney.com.cn",
                "note": "客观利率报价 · 非预测",
                "rows": rows,
            }
        }
    except Exception as e:
        raise HTTPException(502, f"LPR 异常：{e}") from e


@router.get("/api/market/quotes")
def market_quotes(
    codes: str = Query(..., min_length=3, description="comma-separated sh600519,usIXIC,whUSDCNY"),
):
    """Cockpit quote hub. Tencent equities/indices only (per-code TTL via quote_ttl). Futures use /commodities."""
    import cockpit_live
    raw = [c.strip() for c in codes.split(",") if c.strip()][:80]
    if not raw:
        raise HTTPException(400, "codes 不能为空")
    try:
        return {"data": cockpit_live.quotes_cached(raw)}
    except Exception as e:
        raise HTTPException(502, f"行情批量异常：{e}") from e


@router.get("/api/market/boards")
def market_boards(
    kind: str = Query("01", description="01 industry / 02 concept"),
    direction: str = Query("0", description="0 down(leaders) / 1 up(laggards)"),
    n: int = Query(40, ge=5, le=200),
):
    """市场板块实时热点. 缓存 10 秒."""
    import cockpit_live
    k = "02" if kind == "02" else "01"
    d = "1" if direction == "1" else "0"
    try:
        key = f"{k}:{d}:{n}"
        op = _cached if k == "02" else _dc
        data = op(
            "sector_boards",
            key,
            10,
            lambda: cockpit_live.sector_boards(k, d, n),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"板块热点异常：{e}") from e


@router.get("/api/market/board-stocks")
def market_board_stocks(
    code: str = Query(..., description="Tencent pt* or BK####"),
    n: int = Query(12, ge=5, le=80),
):
    """板块成分股. 腾讯 pt* 优先, 东财 BK 兜底. 缓存 10 秒."""
    import cockpit_live
    raw = (code or "").strip()
    try:
        data = _cached(
            "board_stocks",
            f"{raw}:{n}",
            10,
            lambda: cockpit_live.board_stocks(raw, n),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"板块成分异常：{e}") from e


@router.get("/api/market/rank")
def market_rank(
    sort: str = Query("amount", description="amount|changepercent"),
    asc: int = Query(0, ge=0, le=1),
    n: int = Query(30, ge=5, le=50),
):
    """个股榜单 (成交额/涨跌幅), 含成交额. 缓存 20 秒."""
    import cockpit_live
    key = sort if sort in ("amount", "changepercent", "turnoverratio") else "amount"
    try:
        slot = f"{key}:{asc}:{n}"
        op = _cached if key == "changepercent" else _dc
        data = op(
            "stock_rank",
            slot,
            20,
            lambda: cockpit_live.stock_rank(key, asc, n),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"个股榜单异常：{e}") from e


@router.get("/api/market/board-flow-intraday")
def market_board_flow_intraday(
    n: int = Query(BOARD_FLOW_N, ge=6, le=30),
    curves: bool = Query(True, description="false=only ranks (2 Eastmoney pages)"),
):
    """板块资金流向. curves=0 只回流入/流出榜; curves=1 再补分钟曲线. 120s 缓存."""
    import cockpit_live
    try:
        if curves:
            data = _dc(
                "board_flow_intraday",
                str(n),
                BOARD_FLOW_TTL,
                lambda: cockpit_live.board_flow_intraday(n, curves=True),
            )
        else:
            data = _dc(
                "board_flow_ranks",
                str(n),
                BOARD_FLOW_TTL,
                lambda: cockpit_live.board_flow_intraday(n, curves=False),
                valid=lambda d: isinstance(d, list) and len(d) > 0,
            )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"板块分钟资金流异常：{e}") from e


@router.get("/api/market/commodities")
def market_commodities(
    codes: str = Query("", description="hf_XAU,hf_CL,hf_BTC"),
):
    """大宗商品快照. TTL 随交易时段, 过期重取(外盘不能 last-good 冻死)."""
    import cockpit_live
    raw = (codes or "").strip() or cockpit_live.DEFAULT_FUTURES
    try:
        data = _cached(
            "commodities",
            raw,
            commodity_quote_ttl(),
            lambda: cockpit_live.futures_quotes(raw),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"大宗商品异常：{e}") from e


@router.get("/api/market/commodity-minutes")
def market_commodity_minutes(
    codes: str = Query("", description="comma-separated hf_/nf_"),
):
    """大宗商品分钟线. 缓存 4 秒, 外盘 5s 轮询能跟上."""
    import cockpit_live
    raw = (codes or "").strip() or cockpit_live.DEFAULT_FUTURES
    try:
        data = _cached(
            "commodity_minutes",
            raw,
            4,
            lambda: cockpit_live.future_minutes([c.strip() for c in raw.split(",") if c.strip()]),
            valid=cockpit_live.future_minutes_filled,
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"商品分钟线异常：{e}") from e


@router.get("/api/market/bond-yield")
def market_bond_yield(
    curve_type: str = Query("treasury", description="treasury|policy"),
):
    """中债国债/政策性金融债收益率曲线。缓存 1 小时。"""
    ct = curve_type if curve_type in ("treasury", "policy") else "treasury"
    try:
        data = _dc(
            "cn_bond_yield",
            ct,
            3600,
            lambda: astock.bond_yield_curve(ct),
        )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"国债收益率异常：{e}") from e


@router.get("/api/market/fear-greed")
def market_fear_greed():
    """加密 + 美股 CNN + 欧/印/日/港/金/油波动率反转分. 钥匙 fear_greed, 300s."""
    import fear_greed

    try:
        data = _cached("fear_greed", "board", 300, fear_greed.board, valid=fear_greed.board_ok)
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"全球情绪异常：{e}") from e


@router.get("/api/market/ctfi")
def market_ctfi():
    """上海航运交易所 CTFI 综合指数. 钥匙 ctfi, 4h 上一笔."""
    import ctfi

    try:
        data = _cached("ctfi", "latest", ctfi.TTL, ctfi.latest, valid=ctfi.latest_ok)
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"CTFI 异常：{e}") from e


@router.get("/api/market/ctfi-img")
def market_ctfi_img():
    """官方 CTFI 走势图. 同把钥匙 ctfi / img."""
    from fastapi.responses import Response

    import ctfi

    try:
        raw = _cached("ctfi", "img", ctfi.TTL, ctfi.fetch_img, valid=ctfi.img_ok)
        return Response(content=raw, media_type="image/png")
    except Exception as e:
        raise HTTPException(502, f"CTFI 图异常：{e}") from e


@router.get("/api/market/macro-board")
def market_macro_board():
    """银行间利率 + 月度宏观 + 美债10Y/美元指数. 钥匙 macro_board, 不进报价中心."""
    import macro_board

    try:
        data = _cached("macro_board", "board", macro_board.TTL, macro_board.board, valid=macro_board.board_ok)
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"宏观看板异常：{e}") from e


@router.get("/api/market/spot-table")
def market_spot_table():
    """生意社现货/期货基差对照表. 缓存 8 小时."""
    import sunsirs
    try:
        data = _dc("spot_table", "sf", 8 * 3600, sunsirs.spot_table)
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"生意社现期表异常：{e}") from e


@router.get("/api/market/chem-spot")
def market_chem_spot(
    cid: str = Query(..., min_length=1, max_length=10, alias="id"),
    name: str = Query("", max_length=40),
):
    """生意社化工现货中位数. 缓存 8 小时."""
    import sunsirs
    try:
        data = _dc(
            "chem_spot",
            f"{cid}:{name}",
            8 * 3600,
            lambda: sunsirs.chem_spot(cid, name),
        )
        return {"data": data}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"生意社化工现货异常：{e}") from e


@router.get("/api/market/future-daily")
def market_future_daily(
    code: str = Query(..., min_length=4, max_length=16),
    n: int = Query(400, ge=20, le=2000),
):
    """新浪期货日 K (hf_ 外盘 / nf_ 内盘). 缓存 1 小时."""
    import cockpit_live
    try:
        data = _dc(
            "future_daily",
            f"{code}:{n}",
            3600,
            lambda: cockpit_live.future_daily(code, n),
        )
        return {"data": data}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"期货日K异常：{e}") from e


@router.get("/api/market/stock-boards")
def market_stock_boards(code: str = Query(..., min_length=6, max_length=8)):
    """个股所属行业/地域/概念 (东财 f127/f128/f129). 缓存 24 小时."""
    import cockpit_live
    try:
        data = _dc(
            "stock_boards",
            code.strip().lower(),
            24 * 3600,
            lambda: cockpit_live.stock_boards(code),
        )
        return {"data": data}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"个股板块异常：{e}") from e


@router.get("/api/market/stock-boards-batch")
def market_stock_boards_batch(codes: str = Query(..., min_length=6, max_length=200)):
    """批量个股行业/概念, 最多 12 只. 与单票接口共用 24h 缓存."""
    import cockpit_live
    raw: list[str] = []
    seen: set[str] = set()
    for part in codes.split(","):
        k = part.strip()
        if not k or k in seen:
            continue
        seen.add(k)
        raw.append(k)
        if len(raw) >= 12:
            break
    def _one(c: str) -> dict:
        return _dc(
            "stock_boards",
            c.lower(),
            24 * 3600,
            lambda: cockpit_live.stock_boards(c),
        )

    return {"data": cockpit_live.stock_boards_map(raw, fetch=_one)}


@router.get("/api/market/lives")
def market_lives(
    page: int = Query(1, ge=1, le=20),
    size: int = Query(40, ge=10, le=50),
    source: str = Query("", description="jin10 uses flash_newest.js; default is sina/wscn"),
):
    """新浪7x24直播, 失败回退华尔街见闻; source=jin10 走金十 flash_newest.js. 缓存 8 秒."""
    import lives_feed
    try:
        if str(source) == "jin10":
            data = _cached(
                "market_lives",
                f"jin10:{size}",
                8,
                lambda: lives_feed.jin10_flash(size),
            )
        else:
            data = _cached(
                "market_lives",
                f"{page}:{size}",
                8,
                lambda: lives_feed.market_lives(page, size),
            )
        return {"data": data}
    except Exception as e:
        raise HTTPException(502, f"直播快讯异常：{e}") from e
