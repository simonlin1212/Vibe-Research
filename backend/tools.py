"""AI 工具层 —— 把后端已有的全部客观数据能力暴露成 function-calling 工具。

设计原则：
- **只给客观数据**：每个工具返回的都是公开可查的事实（行情/财报/资金/公告/板块），
  不含任何评分、排名倾向、买卖建议或预测。结论一律由用户自己配置的模型给出。
- **裁剪后再喂**：原始接口动辄上百条（资金流 120 天、互动易 30 条），直接塞进上下文
  会把 token 烧光且淹没重点。每个工具在这里做「取最近 N 条 + 关键字段 + 汇总统计」，
  让模型拿到的是能直接推理的密度，而不是原始转储。
- **失败不抛**：任何异常都转成 {"error": ...} 回喂给模型，让它换个工具继续，不中断对话循环。

chat.py / mcp_server.py / debate.py 共用本模块，新增工具只需改这里一处。
"""

from __future__ import annotations

import astock
import gstock
import market
import newsradar

# ——— schema 简写：让 20+ 个工具定义保持一屏可读 ———

_CODE = {"code": {"type": "string", "description": "6 位 A 股代码，如 600519"}}


def _t(name: str, desc: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": required or []},
        },
    }


def _pick(rows: list[dict], keys: tuple[str, ...] | None, limit: int) -> list[dict]:
    """取前 limit 条（控 token）；keys 为 None 时保留全部字段，只截条数。"""
    head = (rows or [])[:limit]
    if keys is None:
        return [r for r in head if isinstance(r, dict)]
    return [{k: r.get(k) for k in keys} for r in head if isinstance(r, dict)]


TOOLS: list[dict] = [
    # —— 行情与估值 ——
    _t("query_quote", "查 A 股实时行情：现价/涨跌/PE/PB/市值/换手/涨跌停。可批量。",
       {"codes": {"type": "array", "items": {"type": "string"}, "description": "6 位代码列表，如 ['600519','000858']"}},
       ["codes"]),
    _t("query_valuation", "查单只个股的完整估值：行情 + 机构一致预期 EPS + 前向 PE / PEG / PE 消化年数。",
       _CODE, ["code"]),
    _t("query_valuation_percentile",
       "查个股 PE-TTM / PB 的历史估值分位：当前值 + 近五年 20/50/80 分位带 + 当前所处百分位。判断估值贵贱先用这个。",
       _CODE, ["code"]),
    _t("query_kline",
       "查个股 K 线并附区间统计（起止价、区间涨跌幅、最高/最低、振幅）。判断价格位置与趋势用。",
       {**_CODE,
        "period": {"type": "string", "enum": ["day", "week", "month"], "description": "周期，默认 day"},
        "count": {"type": "integer", "description": "取最近多少根，默认 60，最大 250"}},
       ["code"]),

    # —— 基本面 ——
    _t("query_financials",
       "查个股最新报告期财务关键指标：营收/净利及同比、ROE、毛利率、净利率、每股经营现金流、EPS。",
       _CODE, ["code"]),
    _t("query_company_info", "查公司基本概况：所属行业、总股本/流通股、上市日期等。", _CODE, ["code"]),
    _t("query_reports", "查个股近期研报列表（标题/机构/评级/日期）。", _CODE, ["code"]),
    _t("query_news", "查个股近期新闻（标题/时间/来源）。", _CODE, ["code"]),

    # —— 资金面与筹码 ——
    _t("query_fund_flow",
       "查个股资金流向：最近若干日主力/超大单/大单/中单/小单净流入，并附近 5 日、20 日累计主力净额。",
       {**_CODE, "days": {"type": "integer", "description": "明细返回最近多少日，默认 10，最大 60"}},
       ["code"]),
    _t("query_margin", "查个股融资融券：融资余额、融资买入/偿还、融券余额趋势（最近若干期）。", _CODE, ["code"]),
    _t("query_holders", "查个股股东户数变化（户数增减 = 筹码集中或分散的直接证据）。", _CODE, ["code"]),
    _t("query_block_trade", "查个股大宗交易记录：成交价、折溢价率、成交量、买卖营业部。", _CODE, ["code"]),
    _t("query_dragon_tiger", "查个股龙虎榜：近 30 日上榜记录、最近一次买卖席位 TOP5、机构专用席位净买额。", _CODE, ["code"]),
    _t("query_dividend", "查个股历史分红方案：每股派息、股息率、除权除息日、分红进度。", _CODE, ["code"]),

    # —— 事件与风险 ——
    _t("query_announcements", "查个股近期公告（标题/日期/类型）。查风险与重大事项先用这个。", _CODE, ["code"]),
    _t("query_lockup", "查个股限售解禁：历史解禁记录 + 未来 90 天待解禁事件（日期/类型/股数/占比）。", _CODE, ["code"]),
    _t("query_investor_qa", "查个股投资者互动易问答（公司对投资者提问的官方回复，常含经营细节）。", _CODE, ["code"]),

    # —— 行业与板块 ——
    _t("query_concepts", "查个股所属板块与概念归属，以及当下被市场归到哪些热门概念在炒。", _CODE, ["code"]),
    _t("query_industry_comparison", "查全市场行业板块横向对比：各行业涨跌幅、成交额、领涨股。看板块强弱用。",
       {"top_n": {"type": "integer", "description": "返回前 N 个行业，默认 20"}}),
    _t("query_industry_reports", "按关键词查行业研报（非个股），了解卖方对某赛道的最新覆盖。",
       {"keywords": {"type": "array", "items": {"type": "string"}, "description": "行业关键词，如 ['光模块','算力']"},
        "days": {"type": "integer", "description": "回溯天数，默认 90"}}),

    # —— 市场层 ——
    _t("query_market",
       "查大盘与市场情绪。scope: indices=A股指数 / global=全球指数 / emotion=短线情绪(连板梯队/封板率) / turnover=全市场成交额 TOP20 / overview=大盘总览(指数+情绪+板块资金流)。",
       {"scope": {"type": "string", "enum": ["indices", "global", "emotion", "turnover", "overview"],
                  "description": "要查的范围，默认 overview"}}),
    _t("query_news_radar",
       "查资讯雷达：12 条赛道的行业资讯聚合（非个股新闻，看产业面动态用）。可传 track 只看某条赛道（如「半导体」「AI」）。",
       {"track": {"type": "string", "description": "赛道名关键词，留空看全部"},
        "per_track": {"type": "integer", "description": "每条赛道取最新几条，默认 5"}}),

    # —— 海外 ——
    _t("query_global_stock",
       "查美股 / 港股 / 韩股个股：行情 + 关键财务指标（韩股仅行情）。美股用字母代码(AAPL)，港股用数字(00700)，韩股 6 位数字加 .KS(005930.KS)。",
       {"symbol": {"type": "string", "description": "美股字母代码 / 港股代码 / 韩股 XXXXXX.KS"}},
       ["symbol"]),
    _t("query_hk_cashflow",
       "查港股现金流量表：经营/投资/筹资活动现金流净额、现金及等价物净增加、期初/期末现金，多期、附同比。仅港股，代码用数字如 00700。",
       {"symbol": {"type": "string", "description": "港股代码，如 00700"}},
       ["symbol"]),
]

TOOL_NAMES = [t["function"]["name"] for t in TOOLS]


# ——— 各工具的执行实现（裁剪逻辑集中在这里） ———

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
    if not rows:
        return {"error": "K 线数据源当前不可达（mootdx 与备用源均无返回）"}
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
    """公司概况。akshare 的东财概况接口时好时坏，挂了就用腾讯行情 + 板块归属拼一份降级版，
    保证这个工具任何时候都能给出「这家公司是干什么的、多大体量」，而不是一个报错。"""
    code = str(args["code"])
    try:
        info = astock.individual_info(code)
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
        return astock.index_quote()
    if scope == "global":
        return market.get_global_indices()
    if scope == "emotion":
        d = market.get_short_term_emotion() or {}
        return {k: d.get(k) for k in ("tiers", "limitUp", "limitDown", "brokenRate", "promoteRate", "updated") if k in d} or d
    if scope == "turnover":
        d = market.get_turnover_top() or {}
        return {"stocks": _pick(d.get("stocks", []), ("name", "code", "turnover", "changePct"), 20), "updated": d.get("updated")}
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
    "query_fund_flow": _fund_flow,
    "query_margin": lambda a: _pick(astock.margin_trading(str(a["code"])),
                                    ("date", "rzye", "rzmre", "rzche", "rqye", "rzrqye"), 15),
    "query_holders": lambda a: _pick(astock.holder_num_change(str(a["code"])), None, 10),
    "query_block_trade": lambda a: _pick(astock.block_trade(str(a["code"])), None, 15),
    "query_dragon_tiger": lambda a: astock.dragon_tiger_board(str(a["code"])),
    "query_dividend": lambda a: _pick(astock.dividend_history(str(a["code"])), None, 12),
    "query_announcements": lambda a: _pick(astock.announcements(str(a["code"])), ("title", "date", "type"), 15),
    "query_lockup": lambda a: astock.lockup_expiry(str(a["code"])),
    "query_investor_qa": _investor_qa,
    "query_concepts": _concepts,
    "query_industry_comparison": lambda a: astock.industry_comparison(top_n=max(5, min(int(a.get("top_n") or 20), 50))),
    "query_industry_reports": lambda a: _pick(
        astock.eastmoney_industry_reports(keywords=a.get("keywords"), days=int(a.get("days") or 90), max_pages=1),
        ("title", "publishDate", "orgSName", "industryName"), 20),
    "query_market": _market,
    "query_news_radar": _radar,
    "query_global_stock": lambda a: gstock.us_hk_stock(str(a.get("symbol", ""))) or {"error": "未找到该美股/港股/韩股代码"},
    "query_hk_cashflow": lambda a: gstock.hk_cashflow(str(a.get("symbol", ""))) or {"error": "未找到该港股现金流（仅港股支持）"},
}


def exec_tool(name: str, args: dict):
    """执行工具，返回可序列化结果（失败返回 error 字段，不抛）。"""
    fn = _HANDLERS.get(name)
    if fn is None:
        return {"error": f"未知工具 {name}"}
    try:
        return fn(args or {})
    except astock.DependencyMissing as e:
        return {"error": str(e)}
    except KeyError as e:
        return {"error": f"{name} 缺少必填参数 {e}"}
    except Exception as e:  # noqa: BLE001 — 工具错误回喂给模型，不中断循环
        return {"error": f"{name} 执行失败：{e}"}
