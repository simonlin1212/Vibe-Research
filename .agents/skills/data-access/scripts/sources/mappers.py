"""映射层:把源函数的结构化结果变成契约证据(evidence)+ extra + missing。

约定:每个 mapper 签名 mapper(result, ctx) -> {"evidence": [...], "extra": {...}, "missing": [...], "status"?: ok|partial|failed, "degraded"?: str, "reason"?: str}
ctx = {script, symbol, market, source, endpoint, raw_ref, raws, as_of, args, ep}
原则(AGENTS.md §4 / data-access 手册):
- 单位按源原样,不换算;金额 currency 默认 CNY(美股 USD / 港股 HKD 由各 mapper 指定);非金额 currency="n/a"
- 时间序列 / 多行表:原始数据已在 raw/ 落盘;evidence 只放"最新值 + 统计(条数 / 起止)"或逐行关键字段(带 record_key,避免撞 id)
- 缺关键字段 → missing;一条证据都没有 → failed(由取数器判),不伪造
"""
from __future__ import annotations

import json
import re
import os
import sys
from typing import Any, Callable, Iterable, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import evidence as _ev, to_float, today_str  # noqa: E402
from sources._http import record_raw, dump_json_bytes  # noqa: E402

MONEY_UNITS = {"元", "万元", "亿元", "元/股", "美元", "港元", "万美元", "亿美元", "万港元", "亿港元"}


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ]")


def _as_of_date(v: str) -> str:
    """
    证据契约要求 as_of 是 **YYYY-MM-DD**。在这里收口,不靠每个 mapper 自己记得截断。

    🔴 为什么放在 ev():原来是"每个 mapper 各自 `[:10]`",于是**有一个忘了** ——
       宏观概率那条把完整时间戳 `2026-08-26T02:20:07Z` 写进 as_of,取数当时不报错,
       一路跑到四分钟后的阶段校验才炸,而且 agent 重试三次也修不好(取数产物不是它能改的)。
       同一个不变量散在九个 mapper 里,迟早漏一个。
    ⚠️ 非法值**当场抛错**,不"尽力修好":取数阶段失败是有兜底的(记 gap、照常往下走),
       而一个违约的信封会让整个阶段失败 —— 早失败、错得清楚,比晚失败、错得含糊好。
    ⚠️ 诚实的边界:带 Z 的时间戳截出来的是 **UTC 日期**,靠近 UTC 午夜时可能与当地交易日差一天。
       调用方要当地日期就自己先转好再传进来。
    """
    v = str(v)
    if _DATE_RE.match(v):
        return v
    m = _TS_RE.match(v)
    if m:
        return m.group(1)
    raise ValueError(f"as_of 必须是 YYYY-MM-DD 或 ISO 时间戳,收到 {v!r}")


def ev(ctx: dict, field: str, value: Any, unit: str, period: str, *, currency: Optional[str] = None, as_of: Optional[str] = None,
       record_key: Optional[str] = None, note: Optional[str] = None, adjustment: str = "not_applicable", raw_ref: Optional[str] = None,
       source: Optional[str] = None, endpoint: Optional[str] = None) -> dict:
    """构造一条证据;currency 未指定时:金额单位 → 按市场(CN=CNY / US=USD / HK=HKD),其余 n/a。"""
    if currency is None:
        currency = {"US": "USD", "HK": "HKD"}.get(ctx["market"], "CNY") if unit in MONEY_UNITS or unit.endswith(("元", "美元", "港元")) else "n/a"
    return _ev(script=ctx["script"], symbol=ctx["symbol"], market=ctx["market"], field=field, value=value, unit=unit, period=str(period),
               source=source or ctx["source"], endpoint=endpoint or ctx["endpoint"], raw_ref=raw_ref if raw_ref is not None else ctx.get("raw_ref"),
               currency=currency, as_of=_as_of_date(as_of or ctx.get("as_of") or today_str()), adjustment=adjustment, note=note, record_key=record_key)


def out(evidence: list, extra: Optional[dict] = None, missing: Optional[list] = None, status: Optional[str] = None, degraded: Optional[str] = None,
        reason: Optional[str] = None) -> dict:
    d: dict[str, Any] = {"evidence": evidence, "extra": extra or {}, "missing": missing or []}
    if status:
        d["status"] = status
    if degraded:
        d["degraded"] = degraded
    if reason:
        d["reason"] = reason
    return d


def extracted(ctx: dict, obj: Any, ext: str = "json") -> Optional[str]:
    """把 SDK / TCP 拼装的结果以 extracted_ 前缀落盘(不冒充传输层原文),返回 raw_ref。"""
    if ext == "json":
        return record_raw(dump_json_bytes(obj), "json", kind="extracted")
    return record_raw(obj if isinstance(obj, bytes) else str(obj).encode("utf-8"), ext, kind="extracted")


# ---------- 通用:字典 → 多条证据 ----------
FieldSpec = tuple  # (result_key, field, unit) 或 (result_key, field, unit, currency)


def dict_fields(ctx: dict, d: dict, specs: Iterable[FieldSpec], period: str, *, as_of: Optional[str] = None, note: Optional[str] = None,
                record_key: Optional[str] = None, numeric: bool = True) -> tuple[list, list]:
    """按 specs 从字典里取字段 → 证据;缺失 / 非数 → missing。numeric=False 时字符串原样(unit 通常 'text')。"""
    evs, missing = [], []
    for spec in specs:
        key, field, unit = spec[0], spec[1], spec[2]
        cur = spec[3] if len(spec) > 3 else None
        v = d.get(key)
        if numeric and unit != "text":
            v = to_float(v)
        if v is None or v == "":
            missing.append({"field": field, "period": period, "reason": f"源字段 {key} 缺失"})
            continue
        evs.append(ev(ctx, field, v, unit, period, currency=cur, as_of=as_of, note=note, record_key=record_key))
    return evs, missing


# ---------- 通用:行列表 → 逐行证据 ----------
def rows_fields(ctx: dict, rows: list[dict], specs: Iterable[FieldSpec], *, period_of: Callable[[dict], str], key_of: Callable[[dict], str],
                as_of_of: Optional[Callable[[dict], Optional[str]]] = None, note_of: Optional[Callable[[dict], Optional[str]]] = None,
                limit: Optional[int] = None, numeric: bool = True) -> list:
    """每行按 specs 产出若干证据,period / record_key 由回调给出(同日多条靠 record_key 区分)。"""
    evs = []
    for i, row in enumerate(rows if limit is None else rows[:limit]):
        period = period_of(row)
        rk = key_of(row)
        for spec in specs:
            key, field, unit = spec[0], spec[1], spec[2]
            cur = spec[3] if len(spec) > 3 else None
            v = row.get(key)
            if numeric and unit != "text":
                v = to_float(v)
            if v is None or v == "":
                continue
            evs.append(ev(ctx, field, v, unit, period, currency=cur, as_of=as_of_of(row) if as_of_of else None, record_key=rk,
                          note=note_of(row) if note_of else None, raw_ref=row.get("_raw")))  # 行级 _raw(多请求端点逐请求绑定)优先
    return evs


def series_summary(ctx: dict, rows: list[dict], *, field_prefix: str, value_key: str, unit: str, date_key: str, currency: Optional[str] = None,
                   note: Optional[str] = None) -> list:
    """时间序列只给"最新值 + 起止 + 条数"三类证据;全序列在 raw/ 里。"""
    if not rows:
        return []
    rows_sorted = sorted(rows, key=lambda r: str(r.get(date_key, "")))
    last = rows_sorted[-1]
    first = rows_sorted[0]
    evs = []
    v = to_float(last.get(value_key))
    if v is not None:
        evs.append(ev(ctx, f"{field_prefix}_latest", v, unit, str(last.get(date_key)), currency=currency, as_of=str(last.get(date_key))[:10], note=note))
    evs.append(ev(ctx, f"{field_prefix}_points", len(rows), "条", f"{str(first.get(date_key))[:10]}..{str(last.get(date_key))[:10]}", currency="n/a"))
    return evs


def text_items(ctx: dict, items: list[dict], *, field: str, title_key: str, date_key: str, key_of: Callable[[dict], str], limit: int = 30,
               extra_keys: Iterable[str] = ()) -> list:
    """新闻 / 公告 / 研报标题类:每条一证据(value = 标题文本,period = 日期,record_key 唯一),附 note 放来源 / 链接等。"""
    evs = []
    for it in items[:limit]:
        title = str(it.get(title_key, "")).strip()
        if not title:
            continue
        date = str(it.get(date_key, ""))[:10] or today_str()
        note = "; ".join(f"{k}={str(it.get(k))[:120]}" for k in extra_keys if it.get(k) not in (None, ""))
        evs.append(ev(ctx, field, title[:300], "text", date, currency="n/a", as_of=date, record_key=key_of(it), note=note or None, raw_ref=it.get("_raw")))
    return evs


def empty(reason: str) -> dict:
    return out([], status="failed", reason=reason)


# =====================================================================
# 东财(eastmoney)端点
# =====================================================================
def em_reports(result: list, ctx: dict) -> dict:
    """研报列表:每篇一条标题证据(record_key=infoCode;note 含机构 / 评级 / 三年 EPS 预测),再给近一年篇数 / 评级分布汇总。"""
    if not result:
        return empty("东财无该标的研报")
    rows = sorted(result, key=lambda r: str(r.get("publishDate", "")), reverse=True)
    evs = text_items(ctx, rows, field="research_report_title", title_key="title", date_key="publishDate",
                     key_of=lambda r: str(r.get("infoCode") or r.get("encodeUrl") or f"{r.get('orgSName')}-{str(r.get('publishDate'))[:10]}"), limit=int(ctx["args"].get("limit", 40)),
                     extra_keys=("orgSName", "emRatingName", "predictThisYearEps", "predictNextYearEps", "predictNextTwoYearEps", "author"))
    cutoff = (__import__("datetime").datetime.now() - __import__("datetime").timedelta(days=365)).strftime("%Y-%m-%d")
    last_year = [r for r in rows if str(r.get("publishDate", ""))[:10] >= cutoff]
    ratings: dict[str, int] = {}
    for r in last_year:
        k = str(r.get("emRatingName") or "未评级")
        ratings[k] = ratings.get(k, 0) + 1
    period = f"{cutoff}..{today_str()}"
    evs.append(ev(ctx, "research_report_count_1y", len(last_year), "篇", period, currency="n/a", note="东财 reportapi 近一年研报篇数"))
    for k, n in sorted(ratings.items(), key=lambda x: -x[1]):
        evs.append(ev(ctx, "research_report_rating_count_1y", n, "篇", period, currency="n/a", record_key=k, note=f"评级={k}"))
    return out(evs, extra={"total_reports": len(rows), "orgs": len({r.get("orgSName") for r in rows}), "ratings_1y": ratings})


def em_industry_reports(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财无行业研报")
    rows = sorted(result, key=lambda r: str(r.get("publishDate", "")), reverse=True)
    evs = text_items(ctx, rows, field="industry_report_title", title_key="title", date_key="publishDate", key_of=lambda r: str(r.get("infoCode") or r.get("encodeUrl")),
                     limit=int(ctx["args"].get("limit", 40)), extra_keys=("industryName", "orgSName", "emRatingName"))
    return out(evs, extra={"total": len(rows)})


def em_concept_blocks(result: dict, ctx: dict) -> dict:
    boards = (result or {}).get("boards") or []
    if not boards:
        return empty("东财 slist 无板块归属")
    evs = [ev(ctx, "board_membership", b.get("name", ""), "text", today_str(), currency="n/a", record_key=str(b.get("code")), note=f"板块代码={b.get('code')};当日涨跌={b.get('change_pct')}%;龙头={b.get('lead_stock')}") for b in boards if b.get("name")]
    evs.append(ev(ctx, "board_membership_count", len(boards), "个", today_str(), currency="n/a"))
    return out(evs, extra={"concept_tags": result.get("concept_tags", [])})


def em_fund_flow_minute(result: list, ctx: dict) -> dict:
    """分钟资金流:东财 fflow/kline 的各档净额为**当日累计值**(盘中逐分钟刷新,收盘后为全天值),不做求和。"""
    if not result:
        return empty("当日无分钟资金流(非交易时段 / ETF 不覆盖 / 接口不通)")
    last = result[-1]
    t = str(last.get("time", ""))
    day = t[:10] if len(t) >= 10 else today_str()
    evs = [ev(ctx, "main_net_inflow_intraday_cum", last.get("main_net"), "元", day, as_of=day, note=f"主力净流入当日累计至 {t};共 {len(result)} 个分钟点"),
           ev(ctx, "super_net_inflow_intraday_cum", last.get("super_net"), "元", day, as_of=day, note=f"超大单净流入当日累计至 {t}"),
           ev(ctx, "large_net_inflow_intraday_cum", last.get("large_net"), "元", day, as_of=day, note=f"大单净流入当日累计至 {t}"),
           ev(ctx, "fund_flow_minute_points", len(result), "条", day, currency="n/a", as_of=day)]
    return out(evs, extra={"first_time": result[0].get("time"), "last_time": t})


def em_fund_flow_120d(result: list, ctx: dict) -> dict:
    if not result:
        return empty("120 日资金流为空(push2his 在部分网络不通)")
    rows = sorted(result, key=lambda r: r.get("date", ""))
    evs = series_summary(ctx, rows, field_prefix="main_net_inflow_daily", value_key="main_net", unit="元", date_key="date")
    degraded = None
    if len(rows) < 5:
        degraded = f"仅 {len(rows)} 条:push2his 不通时回落 push2delay 只给最新一日;历史序列请用备源 sina_fund_flow"
    # 多日合计等派生量不在取数层计算(AGENTS §0.2:派生量只由 calc 计算并记 DAG);全序列在 raw 里,agent 用 calc 读 raw 求和
    return out(evs, status="partial" if degraded else None, degraded=degraded)


def em_dragon_tiger(result: dict, ctx: dict) -> dict:
    recs = (result or {}).get("records") or []
    w = (result or {}).get("window") or ["", ""]
    period = f"{w[0]}..{w[1]}"
    evs = [ev(ctx, "dragon_tiger_count", len(recs), "次", period, currency="n/a", note="回看窗口内上榜次数")]
    evs += rows_fields(ctx, recs, [("net_buy", "dragon_tiger_net_buy", "万元"), ("turnover", "dragon_tiger_turnover", "%")], period_of=lambda r: r["date"],
                       key_of=lambda r: f"{r['date']}|{r.get('reason','')[:40]}", note_of=lambda r: f"上榜原因={r.get('reason','')[:80]}")
    inst = (result or {}).get("institution") or {}
    if recs and inst:
        evs.append(ev(ctx, "dragon_tiger_institution_net", inst.get("net_amt", 0), "万元", recs[0]["date"], note=f"机构买 {inst.get('buy_amt')} 卖 {inst.get('sell_amt')}(万元)"))
    return out(evs, extra={"seats": (result or {}).get("seats"), "window": w})


def em_lockup(result: dict, ctx: dict) -> dict:
    hist = (result or {}).get("history") or []
    up = (result or {}).get("upcoming") or []
    w = (result or {}).get("window") or ["", ""]
    specs = [("shares", "lockup_shares", "万股"), ("able_shares", "lockup_able_shares", "万股"), ("ratio", "lockup_ratio_of_total", "小数")]
    up = [{**r, "_i": i} for i, r in enumerate(up)]
    hist = [{**r, "_i": i} for i, r in enumerate(hist)]
    evs = rows_fields(ctx, up, specs, period_of=lambda r: r["date"], key_of=lambda r: f"up|{r['date']}|{r['_i']}|{r.get('type','')}", note_of=lambda r: f"待解禁:{r.get('type','')}")
    evs += rows_fields(ctx, hist, specs, period_of=lambda r: r["date"], key_of=lambda r: f"hist|{r['date']}|{r['_i']}|{r.get('type','')}", note_of=lambda r: f"历史解禁:{r.get('type','')}", limit=10)
    evs.append(ev(ctx, "lockup_upcoming_count", len(up), "批", f"{w[0]}..{w[1]}", currency="n/a", note="未来窗口待解禁批次"))
    return out(evs)


def em_industry_comparison(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    if not rows:
        return empty("行业板块列表为空")
    evs = rows_fields(ctx, rows, [("change_pct", "industry_board_change_pct", "%"), ("up_count", "industry_board_up_count", "只"), ("down_count", "industry_board_down_count", "只")],
                      period_of=lambda r: today_str(), key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('name')} 排名 {r.get('rank')} 领涨 {r.get('leader')}")
    evs.append(ev(ctx, "industry_board_total", len(rows), "个", today_str(), currency="n/a"))
    return out(evs, extra={"top": result.get("top", [])[:10], "bottom": result.get("bottom", [])[-10:]})


def em_board_fund_flow(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    if not rows:
        return empty("板块资金流为空")
    per = result.get("period", "today")
    specs = [("main_net", f"board_main_net_{per}", "元"), ("main_pct", f"board_main_pct_{per}", "%"), ("change_pct", f"board_change_pct_{per}", "%")]
    evs = rows_fields(ctx, rows, specs, period_of=lambda r: today_str(), key_of=lambda r: f"{result.get('board_type')}|{r.get('code')}", note_of=lambda r: f"{r.get('name')} 排名 {r.get('rank')}")
    return out(evs, extra={"board_type": result.get("board_type"), "period": per, "total": result.get("total")})


def em_daily_dragon_tiger(result: dict, ctx: dict) -> dict:
    stocks = (result or {}).get("stocks") or []
    day = (result or {}).get("date") or today_str()
    if not stocks:
        return out([ev(ctx, "dragon_tiger_market_count", 0, "条", day, currency="n/a", note=(result or {}).get("note", ""))], status="partial", degraded="无龙虎榜数据(非交易日或盘后未更新)")
    evs = rows_fields(ctx, stocks, [("net_buy_wan", "dragon_tiger_market_net_buy", "万元"), ("change_pct", "dragon_tiger_market_change_pct", "%")], period_of=lambda r: day,
                      key_of=lambda r: f"{r.get('code')}|{r.get('reason','')[:30]}", note_of=lambda r: f"{r.get('code')} {r.get('name')}:{r.get('reason','')[:60]}", limit=int(ctx["args"].get("limit", 100)))
    evs.append(ev(ctx, "dragon_tiger_market_count", len(stocks), "条", day, currency="n/a"))
    return out(evs)


def em_margin(result: list, ctx: dict) -> dict:
    if not result:
        return empty("无两融明细(非两融标的或接口为空)")
    rows = sorted(result, key=lambda r: r["date"])
    evs = series_summary(ctx, rows, field_prefix="margin_financing_balance", value_key="rzye", unit="元", date_key="date", note="融资余额")
    evs += series_summary(ctx, rows, field_prefix="margin_short_balance", value_key="rqye", unit="元", date_key="date", note="融券余额")
    evs += rows_fields(ctx, rows[-10:], [("rzye", "margin_financing_balance", "元"), ("rzmre", "margin_financing_buy", "元"), ("rqye", "margin_short_balance", "元")],
                       period_of=lambda r: r["date"], key_of=lambda r: r["date"])
    return out(evs)


def em_block_trade(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "block_trade_count", 0, "笔", today_str(), currency="n/a")], status="ok")
    rows = [{**r, "_i": i} for i, r in enumerate(result)]  # 同日同买卖方同价可多笔,record_key 必须带行号防 id 撞车
    evs = rows_fields(ctx, rows, [("price", "block_trade_price", "元"), ("premium_pct", "block_trade_premium_pct", "%"), ("vol", "block_trade_volume", "万股"), ("amount", "block_trade_amount", "万元")],
                      period_of=lambda r: r["date"], key_of=lambda r: f"{r['date']}|{r['_i']}|{r.get('buyer','')[:20]}|{r.get('seller','')[:20]}", note_of=lambda r: f"买方={r.get('buyer','')[:40]};卖方={r.get('seller','')[:40]};单位按东财数据中心口径")
    evs.append(ev(ctx, "block_trade_count", len(result), "笔", f"{result[-1]['date']}..{result[0]['date']}", currency="n/a"))
    return out(evs)


def em_holder_num(result: list, ctx: dict) -> dict:
    if not result:
        return empty("股东户数为空")
    evs = rows_fields(ctx, result, [("holder_num", "shareholder_count", "户"), ("change_ratio", "shareholder_count_change_pct", "%"), ("avg_shares", "shareholder_avg_free_shares", "股")],
                      period_of=lambda r: r["date"], key_of=lambda r: r["date"])
    return out(evs)


def em_dividend(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "dividend_record_count", 0, "次", today_str(), currency="n/a")], status="ok")
    rows = [{**r, "_i": i} for i, r in enumerate(result) if r.get("date")]
    evs = rows_fields(ctx, rows, [("bonus_rmb", "dividend_pretax_per_share", "元/股"), ("transfer_ratio", "transfer_per_10_shares", "股"), ("bonus_ratio", "bonus_per_10_shares", "股")],
                      period_of=lambda r: r["date"], key_of=lambda r: f"{r['date']}|{r['_i']}|{r.get('report_date','')}", note_of=lambda r: f"进度={r.get('plan','')};报告期={r.get('report_date','')};源字段 PRETAX_BONUS_RMB 口径")
    evs.append(ev(ctx, "dividend_record_count", len(result), "次", f"{result[-1].get('date','')}..{result[0].get('date','')}", currency="n/a"))
    return out(evs)


# ---------- 东财:新闻 / 基本面 / 打板 / 监控 / 异动 / 人气 ----------
def em_stock_news(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财个股新闻为空")
    # akshare 等 SDK 源不经 _http 捕获,ctx["raw_ref"] 为 None → 证据缺 raw_ref(违反契约,
    # 2026-09-05 茅台 run:10 条新闻证据 raw_ref=None 拖挂 risk/report)。HTTP 源(原 JSONP 兜底)
    # 已有 raw_ref,不覆盖;SDK 源显式落盘结构化结果作 extracted,绑给每条证据(同 iwencai 先例)。
    if not ctx.get("raw_ref"):
        ref = extracted(ctx, result)
        for it in result:
            it.setdefault("_raw", ref)
    evs = text_items(ctx, result, field="news_title", title_key="title", date_key="time", key_of=lambda r: str(r.get("url") or r.get("title"))[:160], limit=int(ctx["args"].get("limit", 30)),
                     extra_keys=("source", "url", "content"))
    return out(evs, extra={"count": len(result)})


def em_global_news(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财 7x24 资讯为空")
    evs = text_items(ctx, result, field="market_news_title", title_key="title", date_key="time", key_of=lambda r: f"{str(r.get('time'))[:19]}|{str(r.get('title'))[:60]}",
                     limit=int(ctx["args"].get("limit", 50)), extra_keys=("summary",))
    return out(evs, extra={"count": len(result)})


def em_stock_info(result: dict, ctx: dict) -> dict:
    if not result or not result.get("name"):
        return empty("push2 stock/get 无数据")
    day = today_str()
    evs, missing = dict_fields(ctx, result, [("total_shares", "total_shares", "股"), ("float_shares", "float_shares", "股"), ("mcap", "market_cap", "元"), ("float_mcap", "float_market_cap", "元"), ("price", "price", "元")], day)
    for k, f in (("name", "company_name"), ("industry", "industry_em"), ("list_date", "list_date")):
        if result.get(k):
            evs.append(ev(ctx, f, str(result[k]), "text", day, currency="n/a"))
    return out(evs, missing=missing)


_POOL_FIELDS = {"em_zt_pool": ("limit_up_pool", [("pct", "pool_change_pct", "%"), ("limit_days", "pool_limit_days", "板"), ("seal_fund", "pool_seal_fund", "元"), ("break_times", "pool_break_times", "次"), ("turnover", "pool_turnover", "%")]),
                "em_zb_pool": ("break_board_pool", [("pct", "pool_change_pct", "%"), ("break_times", "pool_break_times", "次"), ("turnover", "pool_turnover", "%"), ("amplitude", "pool_amplitude", "%")]),
                "em_dt_pool": ("limit_down_pool", [("pct", "pool_change_pct", "%"), ("dt_days", "pool_limit_down_days", "天"), ("seal_fund", "pool_seal_fund", "元"), ("open_times", "pool_open_times", "次")]),
                "em_yzt_pool": ("yesterday_limit_up_pool", [("pct", "pool_change_pct", "%"), ("y_limit_days", "pool_y_limit_days", "板"), ("turnover", "pool_turnover", "%")])}


def em_zt_pools(result: list, ctx: dict) -> dict:
    prefix, specs = _POOL_FIELDS[ctx["ep"]["id"]]
    date = str(ctx["args"].get("date") or today_str().replace("-", ""))
    period = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date
    if not result:
        return out([ev(ctx, f"{prefix}_count", 0, "只", period, currency="n/a", note="池为空(非交易日 / 盘前 / 当日无)")], status="partial", degraded="池为空")
    evs = [ev(ctx, f"{prefix}_count", len(result), "只", period, currency="n/a")]
    evs += rows_fields(ctx, result, specs, period_of=lambda r: period, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')} {r.get('industry','')} {r.get('zt_stat','')} 首封 {r.get('first_seal', r.get('y_first_seal', ''))}",
                       limit=int(ctx["args"].get("limit", 150)))
    return out(evs, extra={"pool": prefix, "date": period})


def em_limit_up_sentiment(result: dict, ctx: dict) -> dict:
    d = str(result.get("date", ""))
    period = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d
    if not (result.get("zt_count") or result.get("zb_count") or result.get("dt_count")):
        return out([ev(ctx, "limit_up_count", 0, "只", period, currency="n/a", note="四池皆空(非交易日 / 盘前)")], status="partial", degraded="四池皆空")
    raws = {k: (result.get(k) or [{}])[0].get("_raw") if result.get(k) else None for k in ("zt", "zb", "dt")}
    evs = [ev(ctx, "limit_up_count", result["zt_count"], "只", period, currency="n/a", raw_ref=raws["zt"] or ctx.get("raw_ref")),
           ev(ctx, "break_board_count", result["zb_count"], "只", period, currency="n/a", raw_ref=raws["zb"] or ctx.get("raw_ref")),
           ev(ctx, "limit_down_count", result["dt_count"], "只", period, currency="n/a", raw_ref=raws["dt"] or ctx.get("raw_ref"))]
    # 炸板率 / 最高连板 / 梯队属派生统计,不在取数层计算(三池明细在 raw 里)
    return out(evs)


def em_stock_monitor(result: list, ctx: dict) -> dict:
    day = today_str()
    evs = [ev(ctx, "monitor_pool_count", len(result or []), "只", day, currency="n/a", note="东财重点监控池(当前生效)")]
    for r in result or []:
        evs.append(ev(ctx, "monitor_pool_member", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=str(r.get("code")), note=f"市场={r.get('market')};监控期 {r.get('start')}~{r.get('end')}"))
    return out(evs)


def em_price_anomaly(result: dict, ctx: dict) -> dict:
    items = (result or {}).get("items") or []
    day = (result or {}).get("date") or today_str()
    day = f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 and day.isdigit() else day
    evs = [ev(ctx, "price_anomaly_count", len(items), "条", day, currency="n/a")]
    evs += rows_fields(ctx, items, [("change_pct", "anomaly_change_pct", "%"), ("deviation", "anomaly_cum_deviation", "%"), ("days", "anomaly_window_days", "天")], period_of=lambda r: day,
                       key_of=lambda r: f"{r.get('code')}|{r.get('rule_code')}", note_of=lambda r: f"{r.get('code')} {r.get('name')}({r.get('market')}) {r.get('rule')}{'' if r.get('is_today') else '(非当日)'}", limit=int(ctx["args"].get("limit", 200)))
    return out(evs, status="ok" if items else "partial", degraded=None if items else "当日无异动记录")


def em_price_anomaly_count(result: dict, ctx: dict) -> dict:
    items = (result or {}).get("items") or []
    day = (result or {}).get("date") or today_str()
    day = f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 and day.isdigit() else day
    evs = [ev(ctx, "price_anomaly_stock_count", len(items), "只", day, currency="n/a")]
    evs += rows_fields(ctx, items, [("times", "anomaly_times", "次"), ("deviation", "anomaly_cum_deviation", "%"), ("price", "price", "元"), ("change_pct", "anomaly_change_pct", "%")], period_of=lambda r: day,
                       key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')}({r.get('market')}) 窗口 {r.get('days')} 天")
    return out(evs, status="ok" if items else "partial", degraded=None if items else "无异动统计")


def em_hot_rank(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财人气榜为空")
    day = today_str()
    # 🔴 `pct` 来自 push2 的 f3 = **涨跌幅**,不是排名变化 —— 旧字段名叫"排名变化百分比",名不副实。
    #    字段名会直接进证据、喂给 agent 写报告:**骗人的名字比缺数据更糟**,它不报错、只让人得出错的结论。
    #    改叫 `change_pct`(与 tx_quote / 板块等同一量同名,口径统一);
    #    **真正的排名变化 `rank_chg` 补成独立证据** —— 它原先只写在 note 里,取不出来用。
    evs = rows_fields(ctx, result, [("rank", "hot_rank", "名"), ("pct", "change_pct", "%"), ("rank_chg", "hot_rank_chg", "名"), ("price", "price", "元")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")),
                      note_of=lambda r: f"{r.get('code')} {r.get('name')} 排名变化 {r.get('rank_chg')}")
    return out(evs, extra={"top10": [(r.get("rank"), r.get("code"), r.get("name")) for r in result[:10]]})


def em_hot_concept(result: list, ctx: dict) -> dict:
    day = today_str()
    if not result:
        return out([ev(ctx, "hot_concept_count", 0, "个", day, currency="n/a")], status="partial", degraded="当前无热门概念命中")
    evs = [ev(ctx, "hot_concept_count", len(result), "个", day, currency="n/a")]
    evs += rows_fields(ctx, result, [("hit", "hot_concept_hit", "热度")], period_of=lambda r: day, key_of=lambda r: str(r.get("bk")), note_of=lambda r: f"概念={r.get('concept')}")
    return out(evs, extra={"concepts": [r.get("concept") for r in result]})


# ---------- 同花顺 ----------
def ths_hot_reason(result: list, ctx: dict) -> dict:
    date = str(ctx["args"].get("date") or today_str())
    if not result:
        return out([ev(ctx, "strong_stock_count", 0, "只", date, currency="n/a", note="当日无强势股(非交易日 / 盘前)")], status="partial", degraded="无数据")
    evs = [ev(ctx, "strong_stock_count", len(result), "只", date, currency="n/a")]
    for r in result[:int(ctx["args"].get("limit", 150))]:
        code = str(r.get("code", ""))
        # 🔴 缺的字段就不写进 note。原来是 f-string 直接插 `.get()`,拿不到时渲染成
        #    "涨幅 None% 换手 None%" —— 这条 note 同时喂给 agent 和页面,
        #    一个看着像真值的 None 比留白危险得多。
        parts = [p for p in (code, str(r.get("name") or "")) if p]
        for label, key, suffix in (("涨幅", "zhangfu", "%"), ("换手", "huanshou", "%"), ("成交额", "chengjiaoe", "")):
            val = r.get(key)
            if val is not None and str(val) != "":
                parts.append(f"{label} {val}{suffix}")
        note = " ".join(parts)
        if r.get("reason"):
            evs.append(ev(ctx, "strong_stock_reason", str(r["reason"])[:300], "text", date, currency="n/a", record_key=code, note=note))
        v = to_float(r.get("zhangfu"))
        if v is not None:
            evs.append(ev(ctx, "strong_stock_change_pct", v, "%", date, currency="n/a", record_key=code, note=note))
    return out(evs)


def ths_hsgt_realtime(result: dict, ctx: dict) -> dict:
    times = (result or {}).get("times") or []
    hgt = [x for x in (result or {}).get("hgt") or [] if x is not None]
    sgt = [x for x in (result or {}).get("sgt") or [] if x is not None]
    day = today_str()
    if not times or not (hgt or sgt):
        return out([ev(ctx, "northbound_points", len(times), "个", day, currency="n/a", note="无北向分钟数据(非交易时段或源停更)")], status="partial", degraded="无数据")
    evs = [ev(ctx, "northbound_points", len(times), "个", day, currency="n/a", note=f"{times[0]}..{times[-1]}")]
    if hgt:
        evs.append(ev(ctx, "hgt_net_buy_cum", to_float(hgt[-1]), "亿元", day, note=f"沪股通累计净买入至 {times[len(hgt) - 1] if len(hgt) <= len(times) else times[-1]}"))
    if sgt:
        evs.append(ev(ctx, "sgt_net_buy_cum", to_float(sgt[-1]), "亿元", day, note=f"深股通累计净买入至 {times[len(sgt) - 1] if len(sgt) <= len(times) else times[-1]}"))
    return out(evs)  # 沪 + 深合计属派生量,不在取数层计算


def ths_limit_up_pool(result: list, ctx: dict) -> dict:
    date = str(ctx["args"].get("date") or today_str().replace("-", ""))
    period = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date
    if not result:
        return out([ev(ctx, "ths_limit_up_count", 0, "只", period, currency="n/a")], status="partial", degraded="涨停揭秘为空(非交易日 / 盘前)")
    evs = [ev(ctx, "ths_limit_up_count", len(result), "只", period, currency="n/a")]
    evs += rows_fields(ctx, result, [("pct", "pool_change_pct", "%"), ("seal_rate", "seal_success_rate", "小数"), ("break_times", "pool_break_times", "次"), ("seal_amount", "seal_order_amount", "元")],
                       period_of=lambda r: period, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')} {r.get('high_days','')} {r.get('board_type','')} 首封 {r.get('first_time','')} 原因={str(r.get('reason',''))[:80]}",
                       limit=int(ctx["args"].get("limit", 200)))
    for r in result[:int(ctx["args"].get("limit", 200))]:
        if r.get("reason"):
            evs.append(ev(ctx, "limit_up_reason", str(r["reason"])[:200], "text", period, currency="n/a", record_key=str(r.get("code")), note=f"{r.get('code')} {r.get('name')}"))
    return out(evs)


def ths_hot_list(result: list, ctx: dict) -> dict:
    if not result:
        return empty("同花顺热榜为空")
    day = today_str()
    # 同上:`pct` 是 `rise_and_fall`(涨跌幅);`rank_chg` 才是排名变化,补成独立证据。
    evs = rows_fields(ctx, result, [("rank", "ths_hot_rank", "名"), ("heat", "ths_hot_heat", "人气值"), ("pct", "change_pct", "%"), ("rank_chg", "hot_rank_chg", "名")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")),
                      note_of=lambda r: f"{r.get('code')} {r.get('name')} 排名变化 {r.get('rank_chg')} 概念={','.join(map(str, r.get('concepts') or []))[:80]} {r.get('tag','')}")
    return out(evs, extra={"period": ctx["args"].get("period", "hour"), "top10": [(r.get("rank"), r.get("code"), r.get("name")) for r in result[:10]]})


def em_turnover_rank(result: dict, ctx: dict) -> dict:
    """全市场成交额榜 → 逐行证据(record_key = 代码,避免撞 id)。

    ⚠️ 客观公开榜单,只做客观展示 —— 非推荐、非预测、不评分。
    ⚠️ 上游给的是**全市场**排名(total 数千只),我们只取前 N;
       note 里写清"共 N 只里的前 M",别让人以为市场上就这么多。
    """
    rows = result.get("rows") or []
    total = result.get("total") or 0
    ictx = {**ctx, "symbol": "MARKET", "market": "CN"}
    evs = []
    for r in rows:
        code = str(r.get("code") or "")
        if not code:
            continue
        rk = f"stock|{code}"
        name = r.get("name") or code
        ind = r.get("industry") or ""
        note = f"{name}({code}){'·' + ind if ind else ''};成交额榜第 {r.get('rank')} 名(全市场 {total} 只)"
        for field, val, unit in (("turnover_amount", r.get("amount"), "元"),
                                 ("turnover_rank", r.get("rank"), "名"),
                                 ("last_price", r.get("price"), "元"),
                                 ("change_pct", r.get("pct"), "%")):
            if val is None:
                continue
            evs.append(ev(ictx, field, val, unit, ctx.get("as_of") or today_str(), record_key=rk, note=note))
    missing = [] if evs else ["成交额榜一条都没取到"]
    return out(evs, extra={"total": total, "returned": len(rows)}, missing=missing,
               status="ok" if evs else "failed")
