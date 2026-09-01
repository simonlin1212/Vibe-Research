"""Tool execution handlers (trim heavy payloads for LLM context)."""
from __future__ import annotations

from typing import Any

import astock
import etf_shares
import gstock
import market
import newsradar
import ovlab

from tools.schema import _pick

_TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"


def _kline_tencent(code: str, period: str, n: int) -> list[dict]:
    """腾讯前复权 K 线（备用源）。

    mootdx 走 TCP 7709，在部分网络下连不通（实测本机返回空）；东财 push2his 的 kline 路径
    也可能被拦。腾讯 HTTP 接口实测不封 IP（项目数据源分层里的首选行情源），拿它兜底。
    返回字段顺序：日期, 开, 收, 高, 低, 成交量。
    """
    import requests

    prefix = astock.get_prefix(code)
    sym = f"{prefix}{code}"
    r = requests.get(_TENCENT_KLINE, params={"param": f"{sym},{period},,,{n},qfq"},
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=12)
    d = (r.json().get("data") or {}).get(sym) or {}
    raw = d.get("qfq" + period) or d.get(period) or []
    out = []
    for it in raw:
        if not isinstance(it, list) or len(it) < 6:
            continue
        def _f(x):
            try:
                return float(x)
            except (TypeError, ValueError):
                return None
        out.append({"date": it[0], "open": _f(it[1]), "close": _f(it[2]),
                    "high": _f(it[3]), "low": _f(it[4]), "volume": _f(it[5])})
    return out


def _kline(args: dict):
    period = str(args.get("period") or "day")
    if period not in ("day", "week", "month"):
        period = "day"
    cat = {"day": 4, "week": 5, "month": 6}[period]
    n = max(5, min(int(args.get("count") or 60), 250))
    code = str(args["code"])
    # 腾讯优先：HTTP、实测不封 IP、亚秒级返回；mootdx 走 TCP 7709，连不通时要等十几秒超时
    # （实测本机就是这种情况），放在后面当备份而不是主路径。
    try:
        rows = _kline_tencent(code, period, n)
    except Exception:  # noqa: BLE001 — 网络问题转备用源
        rows = []
    if not rows:
        try:
            rows = astock.kline(code, category=cat, offset=n)
        except Exception:  # noqa: BLE001
            rows = []
    if not rows and period == "day":
        try:
            import ext_feeds
            bs = ext_feeds.baostock_kline(code, n)
            rows = [
                {
                    "date": b.get("date"),
                    "open": b.get("open"),
                    "close": b.get("close"),
                    "high": b.get("high"),
                    "low": b.get("low"),
                    "volume": b.get("volume"),
                }
                for b in (bs.get("bars") or [])
            ]
        except Exception:  # noqa: BLE001
            rows = []
    if not rows:
        return {"error": "K 线数据源当前不可达（腾讯 / mootdx / baostock 均无返回）"}
    closes = [r.get("close") for r in rows if isinstance(r.get("close"), (int, float))]
    highs = [r.get("high") for r in rows if isinstance(r.get("high"), (int, float))]
    lows = [r.get("low") for r in rows if isinstance(r.get("low"), (int, float))]
    stat = {}
    if closes:
        first, last = closes[0], closes[-1]
        stat = {
            "bars": len(rows), "first_close": first, "last_close": last,
            "change_pct": round((last - first) / first * 100, 2) if first else None,
            "highest": max(highs) if highs else None, "lowest": min(lows) if lows else None,
        }
        if stat["highest"] and stat["lowest"] and stat["lowest"]:
            stat["amplitude_pct"] = round((stat["highest"] - stat["lowest"]) / stat["lowest"] * 100, 2)
            stat["drawdown_from_high_pct"] = round((last - stat["highest"]) / stat["highest"] * 100, 2)
    # 明细只回最近 30 根，避免长周期请求把上下文撑爆
    detail = _pick(rows[-30:], ("date", "open", "close", "high", "low", "volume"), 30)
    return {"summary": stat, "recent": detail}


_FFLOW_DELAY = "https://push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get"


def _fund_flow_today(code: str) -> list[dict]:
    """当日资金流（备用源）。

    主源 push2his 在部分网络下连不通（本机实测被拒），push2delay 这条延迟行情线路仍可达，
    代价是只给当天一条、拿不到历史。宁可给「今天」也不要整块缺失。
    """
    import requests

    secid = f"{1 if code.startswith('6') else 0}.{code}"
    params = {"secid": secid, "fields1": "f1,f2,f3,f7",
              "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
              "lmt": "120", "klt": "101"}
    headers = {"User-Agent": astock.UA, "Referer": "https://quote.eastmoney.com/",
               "Origin": "https://quote.eastmoney.com"}
    d = requests.get(_FFLOW_DELAY, params=params, headers=headers, timeout=12).json()
    out = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) < 6:
            continue
        def _f(x):
            try:
                return float(x)
            except (TypeError, ValueError):
                return 0.0
        out.append({"date": p[0], "main_net": _f(p[1]), "small_net": _f(p[2]),
                    "mid_net": _f(p[3]), "large_net": _f(p[4]), "super_net": _f(p[5])})
    return out


def _fund_flow(args: dict):
    code = str(args["code"])
    rows = astock.stock_fund_flow_120d(code)
    if not rows:
        try:
            rows = _fund_flow_today(code)
        except Exception:  # noqa: BLE001
            rows = []
        if rows:  # 备用源只有当日，明说清楚，别让模型误以为是完整历史
            return {"unit": "元", "note": "主源不可达，以下仅为当日资金流，无历史累计",
                    "recent": rows}
    if not rows:
        return {"error": "无资金流数据"}
    days = max(1, min(int(args.get("days") or 10), 60))
    tail = rows[-days:]
    def _sum(n: int) -> float:
        return round(sum(r.get("main_net", 0) for r in rows[-n:]) / 1e8, 3)
    return {
        "unit": "元（汇总项单位：亿元）",
        "main_net_5d_yi": _sum(5), "main_net_20d_yi": _sum(20), "main_net_60d_yi": _sum(60),
        "recent": _pick(tail, ("date", "main_net", "super_net", "large_net", "mid_net", "small_net"), days),
    }


def _fund_flow_minute(args: dict):
    code = str(args["code"])
    rows = astock.eastmoney_fund_flow_minute(code)
    if not rows:
        return {"error": "无分钟资金流数据（非交易时段或源不可用）"}
    day_main = round(sum(float(r.get("main_net") or 0) for r in rows), 2)
    return {
        "code": code,
        "unit": "元",
        "day_main_net": day_main,
        "latest": rows[-1],
        "recent": _pick(
            rows[-20:],
            ("time", "main_net", "super_net", "large_net", "mid_net", "small_net"),
            20,
        ),
    }


def _concepts(args: dict):
    code = str(args["code"])
    blocks = astock.concept_blocks(code)
    try:
        hot = astock.hot_concepts(code)
    except Exception:  # noqa: BLE001 — 热门概念是加分项，挂了不该拖垮板块归属
        hot = []
    return {
        "total_blocks": blocks.get("total", 0),
        "blocks": _pick(blocks.get("boards", []), ("name", "change_pct", "lead_stock"), 30),
        "hot_concepts": _pick(hot, ("concept", "hit"), 15),
    }


def _company_info(args: dict):
    """公司概况。主源东财 push2 stock/get（与 /api/stock-basic 同源），
    挂了就用腾讯行情 + 板块归属拼一份降级版。"""
    import astock_boards

    code = str(args["code"])
    try:
        info = astock_boards.stock_basic_info(code)
        if info:
            return info
    except Exception:  # noqa: BLE001 — 上游接口不稳，转降级源
        pass
    q = (astock.tencent_quote([code]) or {}).get(code) or {}
    if not q:
        return {"error": "公司概况数据源当前不可达"}
    industry = ""
    try:
        boards = (astock.concept_blocks(code).get("boards") or [])
        industry = boards[0].get("name", "") if boards else ""
    except Exception:  # noqa: BLE001 — 行业是加分项，拿不到不影响主体
        pass
    return {
        "name": q.get("name"), "code": code, "industry_or_board": industry,
        "total_mcap_yi": q.get("mcap_yi"), "float_mcap_yi": q.get("float_mcap_yi"),
        "pe_ttm": q.get("pe_ttm"), "pb": q.get("pb"),
        "note": "概况接口暂不可用，以上为行情源降级数据（市值单位：亿元）",
    }


def _investor_qa(args: dict):
    """互动易：公司回复常有整段公文，截断后再喂，否则十几条就能吃掉整个上下文。"""
    rows = astock.investor_qa(str(args["code"]))
    out = []
    for r in _pick(rows, None, 12):
        q, a = (r.get("question") or ""), (r.get("answer") or "")
        out.append({
            "ask_time": r.get("ask_time"),
            "question": q[:200],
            "answer": a[:400] if a else "（未回复）",
        })
    return out


def _market(args: dict):
    scope = str(args.get("scope") or "overview")
    if scope == "indices":
        from index_catalog import A_INDEX_CODES

        want = set(A_INDEX_CODES)
        rows = market.get_global_indices()
        return [r for r in rows if isinstance(r, dict) and r.get("symbol") in want]
    if scope == "global":
        return market.get_global_indices()
    if scope == "emotion":
        d = market.get_short_term_emotion() or {}
        keys = (
            "date", "zt_count", "dt_count", "zb_count", "yzt_count",
            "max_boards", "lianban_count", "ladder",
            "seal_rate", "break_rate", "promotion_rate", "seals",
        )
        return {k: d.get(k) for k in keys if k in d} or d
    if scope == "turnover":
        d = market.get_turnover_top() or {}
        # Field names must match sina_amount_rank (#28).
        # Old keys turnover/changePct do not exist → AI tools saw nulls.
        return {
            "stocks": _pick(
                d.get("stocks", []),
                ("name", "code", "price", "pct", "amount", "mcap", "float_cap", "industry"),
                20,
            ),
            "updated": d.get("updated"),
        }
    return market.get_overview()


def _radar(args: dict):
    """资讯雷达：数据按 12 条赛道分组，这里摊平成一张扁平清单（每条带赛道名）方便模型阅读。
    可传 track 只看某条赛道；每赛道取最新若干条，避免 12×几十条把上下文吃光。"""
    d = newsradar.get_radar(force=False) or {}
    want = str(args.get("track") or "").strip()
    per = max(1, min(int(args.get("per_track") or 5), 20))
    out, total = [], 0
    for ind in d.get("industries") or []:
        name = ind.get("name", "")
        items = ind.get("items") or []
        total += len(items)
        if want and want not in name:
            continue
        for it in items[:per]:
            out.append({"track": name, "title": it.get("title"),
                        "time": it.get("time"), "source": it.get("source")})
    return {"generated_at": d.get("generated_at"), "total_cached": total,
            "tracks": [i.get("name") for i in (d.get("industries") or [])], "items": out}


# —— OpenVlab 期权 / 期货波动率（裁剪逻辑）——
_OVLAB_MARKET_KEYS = (
    "product_alias", "prodUnd", "exchange", "sector_alias",
    "price", "ctn", "atmv_current", "atmv_1dchg", "atmv_percentile",
    "rv22", "valphaT", "carry", "skew_current", "skew_percentile",
    "exp", "expiry_date", "last_time", "has_night_trading", "is_overseas",
)


def _ovlab_market(args: dict) -> dict:
    """市场概览: 全表可能几十上百行, 这里取关键字段 + 限制条数, 避免撑爆上下文。

    同时附「隐波最高 / 最低 TOP5」「偏度最高 / 最低 TOP5」两个机械汇总,
    让模型直接拿到密度而不是原始转储。
    """
    rows = ovlab.get_market_overview() or []
    if not rows:
        return {"error": "OpenVlab 市场概览暂无数据"}
    limit = int(args.get("limit") or 0)
    if limit > 0:
        rows = rows[:limit]
    items = [{k: r.get(k) for k in _OVLAB_MARKET_KEYS} for r in rows if isinstance(r, dict)]

    def _num(v) -> float | None:
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                return None
        return None

    def _top(key: str, reverse: bool) -> list[dict]:
        valid = [{"name": r.get("product_alias"), "code": r.get("prodUnd"),
                 "val": n} for r in items if (n := _num(r.get(key))) is not None]
        valid.sort(key=lambda x: x["val"], reverse=reverse)
        return [{key: it["val"], "name": it["name"], "code": it["code"]} for it in valid[:5]]

    return {
        "total": len(items),
        "items": items,
        "atmv_top5": _top("atmv_current", True),
        "atmv_bottom5": _top("atmv_current", False),
        "skew_top5": _top("skew_current", True),
        "skew_bottom5": _top("skew_current", False),
    }


def _ovlab_detail(args: dict) -> dict:
    """单品种详情: 原始 dto 可能很大, 这里只回关键字段, 大数组截前若干条。

    顶层字段保留; 对已知的大数组 (如 contracts / greeks / vol_curve) 截前 20 条,
    其余字段原样透传, 让模型能看到结构又不被淹没。
    """
    prod_und = str(args.get("prod_und", "")).strip()
    if not prod_und:
        return {"error": "prod_und 不能为空"}
    exps = a.get("exps") if isinstance(a := args.get("exps"), list) else None
    data = ovlab.get_product_detail(prod_und, exps) or {}
    if not data:
        return {"error": f"未找到 OpenVlab 标的「{prod_und}」的详情"}
    _ARRAY_TRUNCATE_KEYS = ("contracts", "greeks", "vol_curve", "vol_smile", "ts", "term_structure")
    out: dict = {}
    for k, v in data.items():
        if isinstance(v, list) and k in _ARRAY_TRUNCATE_KEYS and len(v) > 20:
            out[k] = v[:20]
            out[f"_{k}_truncated"] = len(v)
        else:
            out[k] = v
    return out


def _ovlab_arb_board(_args: dict) -> dict:
    """套利看板瘦身: 跨期按 |spreadChg| 前 20, 跨品种/股指全量(不含现货报价)."""
    data = ovlab.get_arb_board() or {}
    cal = [r for r in (data.get("calendar") or []) if isinstance(r, dict)]
    cal.sort(key=lambda r: abs(r.get("spreadChg") or 0), reverse=True)
    return {
        "calendar": cal[:20],
        "cross": data.get("cross") or [],
        "index": data.get("index") or [],
    }


def _ovlab_future_ts(args: dict) -> dict:
    """期货期限结构: all=全品种(按品种分组的字典, 只回非空品种) / single=单品种."""
    scope = str(args.get("scope") or "all")
    if scope == "single":
        prod = str(args.get("prod_und", "")).strip()
        if not prod:
            return {"error": "scope=single 时 prod_und 必填"}
        data = ovlab.get_future_term_structure(prod)
        return data if data else {"error": f"未找到 {prod} 的期货期限结构"}
    data = ovlab.get_future_term_structures_all() or {}
    # 只保留非空品种, 避免空字典撑爆上下文
    non_empty = {k: v for k, v in data.items() if v}
    return {"total": len(data), "non_empty": len(non_empty), "products": non_empty}


def _ovlab_flow_alert(args: dict) -> dict:
    """异动榜: 数百条, 这里取关键字段 + 限制条数, 并附机械汇总(按规则计数)."""
    from collections import Counter
    rows = ovlab.get_flow_alerts() or []
    if not rows:
        return {"error": "异动榜暂无数据"}
    keys = ("time", "instrument", "contract_code", "rule_id", "side", "price",
            "ctn", "open_interest", "window_volume", "window_premium", "pct_change",
            "exp_date", "fill_type", "price_start", "price_end")
    items = [{k: r.get(k) for k in keys} for r in rows if isinstance(r, dict)]
    # 按规则计数, 看哪种异动最多
    rule_count = Counter(r.get("rule_id") for r in items if r.get("rule_id"))
    return {
        "total": len(items),
        "recent": items[:30],
        "rule_count": dict(rule_count.most_common(10)),
    }


def _ovlab_warehouse_history(args: dict) -> dict:
    """单品种持仓历史: 返回含 year20xx 多年, 这里只回当前值 + 汇总, 明细截断."""
    product = str(args.get("product", "")).strip()
    if not product:
        return {"error": "product 必填"}
    data = ovlab.get_warehouse_history(product) or {}
    if not data:
        return {"error": f"未找到 {product} 的持仓历史"}
    # 提取各年汇总(每年取最后一条或value), 避免整块转储
    years = {k: v for k, v in data.items() if k.startswith("year") and v}
    return {
        "product": product,
        "last_update_time": data.get("last_update_time"),
        "current_value": data.get("value"),
        "category": data.get("category"),
        "years_summary": years,
        "ratio_data": data.get("ratioData"),
    }


def _ovlab_seasonal(args: dict) -> dict:
    """季节性持仓: 全品种时只回品种清单 + 每品种年数, 不转储整块."""
    years = a if isinstance(a := args.get("years"), list) else None
    product = args.get("product")
    data = ovlab.get_warehouse_seasonal_history_all(years, product) or {}
    if not data:
        return {"error": "季节性持仓暂无数据"}
    # 每品种只回它有哪些年份的 key, 不回完整序列
    summary = {k: list(v.keys()) if isinstance(v, dict) else type(v).__name__
               for k, v in data.items()}
    return {"products": list(data.keys()), "years_in_data": summary}


def _ovlab_meta(args: dict) -> dict:
    """元数据统一入口."""
    scope = str(args.get("scope") or "")
    if scope == "exchange":
        return {"exchanges": ovlab.get_exchange_info()}
    if scope == "sector":
        return {"sectors": ovlab.get_sector_info()}
    if scope == "next_trading_day":
        return {"next_trading_day": ovlab.get_next_trading_day()}
    if scope == "holidays":
        ex = str(args.get("exchange", "")).strip()
        if not ex:
            return {"error": "scope=holidays 时 exchange 必填"}
        return {"exchange": ex, "holidays": ovlab.get_holidays(ex)}
    return {"error": f"未知 scope: {scope}"}


def _ovlab_position(args: dict) -> dict:
    """持仓排名统一入口 (option-position / future-position)."""
    scope = str(args.get("scope") or "products")
    kind = str(args.get("kind") or "future")
    if scope == "products":
        if kind == "option":
            return ovlab.get_option_position_products() or {"error": "期权持仓品种暂无数据"}
        return ovlab.get_future_position_products() or {"error": "期货持仓品种暂无数据"}
    if scope == "details":
        product = str(args.get("product", "")).strip()
        code = str(args.get("code", "")).strip()
        day = str(args.get("day", "")).strip()
        if not (product and code and day):
            return {"error": "scope=details 时 product/code/day 必填"}
        if kind == "option":
            direction = str(args.get("direction", "")).strip().upper()
            if direction not in ("C", "P"):
                return {"error": "kind=option 时 direction 必填 (C 或 P)"}
            return ovlab.get_option_position_details(product, code, direction, day) or {"error": "该合约期权持仓明细暂无数据"}
        return ovlab.get_future_position_details(product, code, "0", day) or {"error": "该合约期货持仓明细暂无数据"}
    return {"error": f"未知 scope: {scope}"}


def _ovlab_chart(args: dict) -> dict:
    """K线 / ATM隐波历史统一入口."""
    kind = str(args.get("kind") or "kline").lower()
    symbol = str(args.get("symbol", "")).strip()
    if not symbol:
        return {"error": "symbol 必填"}
    resolution = str(args.get("resolution") or "1D")
    from_ts = args.get("from_ts")
    to_ts = args.get("to_ts")
    if from_ts is not None:
        from_ts = int(from_ts)
    if to_ts is not None:
        to_ts = int(to_ts)
    if kind == "atmvol":
        return ovlab.get_atmvol_history(symbol, resolution, from_ts, to_ts) or {"error": "ATM隐波历史暂无数据"}
    return ovlab.get_kline_history(symbol, resolution, from_ts, to_ts) or {"error": "K线历史暂无数据"}


def _ovlab_search(args: dict) -> dict:
    """合约搜索."""
    kw = str(args.get("keyword", "")).strip()
    if not kw:
        return {"error": "keyword 必填"}
    limit = args.get("limit")
    limit = int(limit) if limit else 30
    return {"data": ovlab.search_symbols(kw, limit) or []}


def _ovlab_flow_data(args: dict) -> dict:
    """异动资金流分页."""
    product = str(args.get("product", "")).strip() or None
    page = int(args.get("page") or 1)
    page_size = int(args.get("page_size") or 50)
    body: dict[str, Any] = {"page": page, "page_size": page_size}
    if product:
        body["product"] = product
    return ovlab.get_flow_data(body=body) or {"error": "异动资金流暂无数据"}


def _ovlab_vol_surface(args: dict) -> dict:
    """波动率曲面."""
    product = str(args.get("product", "")).strip()
    if not product:
        return {"error": "product 必填"}
    return ovlab.get_volatility_surface(product) or {"error": "波动率曲面暂无数据"}


def _ext_kline(args: dict) -> dict:
    import ext_feeds

    symbol = str(args.get("symbol") or "").strip()
    if not symbol:
        return {"error": "symbol 必填"}
    num = max(5, min(int(args.get("num") or 60), 250))
    src = str(args.get("source") or "auto")
    out = ext_feeds.fetch_kline(symbol, num=num, source=src)
    if out.get("error"):
        return out
    bars = out.get("bars") or []
    if not bars:
        return {"error": f"未取到 {symbol} 的 K 线"}
    return {
        "code": out.get("code") or symbol,
        "name": out.get("name"),
        "market": out.get("market"),
        "source": out.get("source"),
        "adjust": out.get("adjust"),
        "bars": len(bars),
        "recent": _pick(bars[-15:], ("date", "open", "high", "low", "close", "volume"), 15),
    }


def _correlation(args: dict) -> dict:
    import correlation

    raw = args.get("codes")
    if isinstance(raw, list):
        codes = [str(c).strip() for c in raw if str(c).strip()]
    else:
        codes = [c.strip() for c in str(raw or "").split(",") if c.strip()]
    window = max(20, min(int(args.get("window") or 60), 250))
    out = correlation.correlation_matrix(codes, window=window)
    if out.get("matrix"):
        out.pop("series", None)
    return out


def _etf_holdings(args: dict) -> dict:
    import etf_lookthrough

    symbol = str(args.get("symbol") or "").strip()
    if not symbol:
        return {"error": "symbol 必填"}
    out = etf_lookthrough.etf_holdings(symbol, market=str(args.get("market") or "auto"))
    holdings = out.get("holdings") or []
    if holdings:
        out = {**out, "holdings": holdings[:20], "holdings_shown": 20, "holdings_total": len(holdings)}
    return out


def _run_backtest(args: dict) -> dict:
    from backtest.service import BacktestError, run_backtest

    try:
        out = run_backtest(args or {})
    except BacktestError as e:
        return {"error": str(e)}
    trades = out.get("trades") or []
    return {
        "disclaimer": out.get("disclaimer"),
        "run_id": out.get("run_id"),
        "data_hash": out.get("data_hash"),
        "universe": out.get("universe"),
        "strategy": out.get("strategy"),
        "stats": out.get("stats"),
        "oos": out.get("oos"),
        "walk_forward": (out.get("walk_forward") or {}).get("summary") if out.get("walk_forward") else None,
        "execution": out.get("execution"),
        "warnings": out.get("warnings") or [],
        "trades_shown": min(20, len(trades)),
        "trades": trades[-20:],
        "note": "只给摘要和最近成交, 不校准买卖。完整净值曲线在 /backtest 页。实验写完不改。",
    }


def _13f(args: dict) -> dict:
    import inst_13f

    out = inst_13f.query_13f(
        manager=args.get("manager") or None,
        cik=args.get("cik") or None,
        ticker=args.get("ticker") or None,
        top=max(5, min(int(args.get("top") or 20), 40)),
    )
    cur = (out.get("current") or {}).get("holdings")
    if isinstance(cur, list) and len(cur) > 20:
        out["current"] = {**out["current"], "holdings": cur[:20]}
    return out


def _chips(args: dict) -> dict:
    import astock_research as ar

    out = ar.chips(str(args["code"]), str(args.get("start") or ""), str(args.get("end") or ""))
    hist = out.pop("histogram", None) or []
    out["histogram_n"] = len(hist)
    return out


def _valhist(args: dict) -> dict:
    import astock_research as ar

    rows = ar.baostock_valuation_history(
        str(args["code"]), str(args.get("start") or ""), str(args.get("end") or ""),
    )
    return {
        "rows": _pick(
            rows,
            ("date", "close", "peTTM", "pbMRQ", "psTTM", "turn", "tradestatus", "isST"),
            40,
        ),
        "n": len(rows),
    }


def _list_status(args: dict) -> dict:
    import astock_research as ar

    return ar.baostock_stock_basic(str(args["code"])) or {"error": "未找到该标的上市状态"}


def _sw_industry(args: dict) -> dict:
    import astock_research as ar

    return ar.sw_industry_lookup(str(args["code"]), str(args.get("as_of") or ""))


# name -> 执行函数。绝大多数是「调后端函数 + 裁剪」，复杂的抽成上面的私有函数。
_HANDLERS = {
    "query_quote": lambda a: astock.tencent_quote([str(c) for c in a.get("codes", [])]),
    "query_valuation": lambda a: astock.full_valuation(str(a["code"])),
    "query_valuation_percentile": lambda a: astock.valuation_percentile(str(a["code"])),
    "query_kline": _kline,
    "query_financials": lambda a: astock.financials(str(a["code"])),
    "query_company_info": _company_info,
    "query_reports": lambda a: _pick(astock.eastmoney_reports(str(a["code"]), max_pages=1),
                                     ("title", "publishDate", "orgSName", "emRatingName"), 15),
    "query_news": lambda a: _pick(astock.stock_news(str(a["code"]), limit=15),
                                  ("新闻标题", "发布时间", "文章来源"), 15),
    "query_cls_telegraph": lambda a: {
        "source": "财联社",
        "items": _pick(
            astock.cls_telegraph(int(a.get("limit") or 30)),
            ("time", "title", "content"),
            int(a.get("limit") or 30),
        ),
    },
    "query_fund_flow": _fund_flow,
    "query_fund_flow_minute": lambda a: _fund_flow_minute(a),
    "query_ths_limit_up": lambda a: astock.ths_limit_up_pool(a.get("date") or None),
    "query_margin": lambda a: _pick(astock.margin_trading(str(a["code"])),
                                    ("date", "rzye", "rzmre", "rzche", "rqye", "rzrqye"), 15),
    "query_holders": lambda a: _pick(astock.holder_num_change(str(a["code"])), None, 10),
    "query_chips": _chips,
    "query_valuation_history": _valhist,
    "query_list_status": _list_status,
    "query_sw_industry": _sw_industry,
    "query_etf_shares": lambda a: etf_shares.etf_shares(
        str(a.get("code") or "510300"),
        int(a.get("n") or 80),
    ),
    "query_etf_flow": lambda a: {
        "sort_by": a.get("sort_by") or "net_inflow",
        "rows": _pick(
            astock.etf_fund_flow(
                str(a.get("sort_by") or "net_inflow"),
                int(a.get("limit") or 30),
            ),
            ("code", "name", "change_pct", "main_net_inflow", "super_large_net", "large_net"),
            int(a.get("limit") or 30),
        ),
    },
    "query_shareholder_changes": lambda a: _pick(
        astock.shareholder_changes(
            str(a.get("code") or ""),
            str(a.get("change_type") or "all"),
            int(a.get("limit") or 30),
        ),
        ("date", "code", "name", "person", "change_type", "change_shares", "avg_price", "position"),
        int(a.get("limit") or 30),
    ),
    "query_lpr": lambda a: {
        "source": "chinamoney.com.cn",
        "rows": astock.lpr_rates(int(a.get("days") or 365)),
    },
    "query_cn_bond_yield": lambda a: astock.bond_yield_curve(str(a.get("curve_type") or "treasury")),
    "query_block_trade": lambda a: _pick(astock.block_trade(str(a["code"])), None, 15),
    "query_dragon_tiger": lambda a: astock.dragon_tiger_board(str(a["code"])),
    "query_daily_dragon_tiger": lambda a: astock.daily_dragon_tiger(
        a.get("date") or None,
        top=int(a.get("top") or 30),
    ),
    "query_dividend": lambda a: _pick(astock.dividend_history(str(a["code"])), None, 12),
    "query_announcements": lambda a: _pick(astock.announcements(str(a["code"])), ("title", "date", "type"), 15),
    "query_lockup": lambda a: astock.lockup_expiry(str(a["code"])),
    "query_investor_qa": _investor_qa,
    "query_concepts": _concepts,
    "query_industry_comparison": lambda a: astock.industry_comparison(top_n=max(5, min(int(a.get("top_n") or 20), 50))),
    "query_market": _market,
    "query_news_radar": _radar,
    "query_global_stock": lambda a: gstock.us_hk_stock(str(a.get("symbol", ""))) or {"error": "未找到该美股/港股/韩股代码"},
    "query_hk_cashflow": lambda a: gstock.hk_cashflow(str(a.get("symbol", ""))) or {"error": "未找到该港股现金流（仅港股支持）"},

    # —— OpenVlab 期权 / 期货波动率 ——
    "query_ovlab_market": lambda a: _ovlab_market(a),
    "query_ovlab_detail": lambda a: _ovlab_detail(a),
    "query_ovlab_volatility_ts": lambda a: ovlab.get_volatility_term_structures() or {"error": "波动率期限结构暂无数据"},
    "query_ovlab_future_ts": lambda a: _ovlab_future_ts(a),
    "query_ovlab_arb_board": lambda a: _ovlab_arb_board(a),
    "query_ovlab_flow_alert": lambda a: _ovlab_flow_alert(a),
    "query_ovlab_warehouse_history": lambda a: _ovlab_warehouse_history(a),
    "query_ovlab_seasonal_history": lambda a: _ovlab_seasonal(a),
    "query_ovlab_product_exps": lambda a: ovlab.get_product_exps(a.get("prod_und")) or {"error": "合约月份暂无数据"},
    "query_ovlab_meta": lambda a: _ovlab_meta(a),
    "query_ovlab_position": lambda a: _ovlab_position(a),
    "query_ovlab_chart": lambda a: _ovlab_chart(a),
    "query_ovlab_search": lambda a: _ovlab_search(a),
    "query_ovlab_flow_data": lambda a: _ovlab_flow_data(a),
    "query_ovlab_vol_surface": lambda a: _ovlab_vol_surface(a),
    "query_ext_kline": _ext_kline,
    "query_correlation": _correlation,
    "query_etf_holdings": _etf_holdings,
    "query_13f": _13f,
    "run_backtest": _run_backtest,
}

