"""东财(eastmoney)源:研报 / 板块归属 / 资金流 / 龙虎榜 / 解禁 / 行业排名 / 板块资金 / 两融 / 大宗 / 股东户数 / 分红 / 个股基本面 / 新闻 / 打板 / 人气。
移植自 simonlin1212/a-stock-data SKILL.md(V3.7.x)对应代码块;全部请求走 _http.em(跨进程串行锁 + 代理回退 + raw 落盘),403 不重试。
函数只返回结构化结果;信封 / 证据由 mappers 统一完成。单位按源字段口径原样返回(不换算),字段含义见各函数注释。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import EM_PUSH2_HOSTS, EM_PUSH2HIS_HOSTS, TZ_SH, UA, em_secid, norm_ticker  # noqa: E402
from sources._http import em, em_json, last_raw_ref  # noqa: E402


def _multi_json(hosts: tuple, path: str, **kw):
    """按 hosts 顺序请求同一 path(push2 在部分网络被重置,push2delay 可达;与 legacy 脚本的 em_multi_host 同策略),全失败抛最后一个异常。"""
    import requests
    last: Optional[Exception] = None
    for h in hosts:
        try:
            r = em(f"https://{h}{path}", **kw)
            if r.status_code == 200:
                return r.json()
            last = RuntimeError(f"{h} HTTP {r.status_code}")
        except (requests.exceptions.RequestException, ValueError) as e:
            last = e
    raise last if last else RuntimeError("无可用东财主机")


def _push2_json(path: str, **kw):
    return _multi_json(EM_PUSH2_HOSTS, path, **kw)


def _push2his_json(path: str, **kw):
    return _multi_json(EM_PUSH2HIS_HOSTS, path, **kw)

DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT_API = "https://reportapi.eastmoney.com/report/list"
PDF_TPL = "https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf"
_REF = {"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"}


def _secid(code: str) -> str:
    d, m = norm_ticker(code, stock_only=False)
    return em_secid(d, m)


def _today() -> str:
    return datetime.now(TZ_SH).strftime("%Y-%m-%d")


# ---------- 数据中心统一查询 ----------
def eastmoney_datacenter(report_name: str, columns: str = "ALL", filter_str: str = "", page_size: int = 50,
                         sort_columns: str = "", sort_types: str = "-1", page: int = 1) -> list[dict]:
    params = {"reportName": report_name, "columns": columns, "filter": filter_str, "pageNumber": str(page), "pageSize": str(page_size),
              "sortColumns": sort_columns, "sortTypes": sort_types, "source": "WEB", "client": "WEB"}
    d = em_json(DATACENTER_URL, params=params, timeout=15)
    if d.get("result") and d["result"].get("data"):
        return d["result"]["data"]
    return []


# ---------- 2.1 研报 ----------
def eastmoney_reports(code: str, max_pages: int = 3) -> list[dict]:
    """个股研报列表(标题 / 机构 / 评级 / 三年 EPS 预测 / infoCode);reportapi 只认纯 6 位。"""
    digits, _ = norm_ticker(code, stock_only=True)
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        params = {"industryCode": "*", "pageSize": "100", "industry": "*", "rating": "*", "ratingChange": "*",
                  "beginTime": "2000-01-01", "endTime": "2030-01-01", "pageNo": str(page), "fields": "", "qType": "0",
                  "orgCode": "", "code": digits, "rcode": "", "p": str(page), "pageNum": str(page), "pageNumber": str(page)}
        d = em_json(REPORT_API, params=params, headers={"Referer": "https://data.eastmoney.com/"}, timeout=30)
        rows = d.get("data") or []
        if not rows:
            break
        ref = last_raw_ref()
        out.extend({**r, "_raw": ref} for r in rows)
        if page >= (d.get("TotalPage", 1) or 1):
            break
    if not out and digits[:2] in ("43", "83", "87"):
        raise ValueError(f"{digits} 属北交所老号段,东财研报库已不再按老码索引;请按名称反查现行 920 代码")
    return out


def eastmoney_industry_reports(industry_code: str = "*", max_pages: int = 2, begin: str = "") -> list[dict]:
    """行业研报列表(qType=1);industry_code="*" 全行业;begin 留空 = 近两年。"""
    if not begin:
        begin = (datetime.now(TZ_SH) - timedelta(days=730)).strftime("%Y-%m-%d")
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        params = {"industryCode": industry_code, "pageSize": "100", "industry": "*", "rating": "*", "ratingChange": "*",
                  "beginTime": begin, "endTime": "2030-01-01", "pageNo": str(page), "fields": "", "qType": "1"}
        d = em_json(REPORT_API, params=params, headers={"Referer": "https://data.eastmoney.com/"}, timeout=30)
        rows = d.get("data") or []
        if not rows:
            break
        ref = last_raw_ref()
        out.extend({**r, "_raw": ref} for r in rows)
        if page >= (d.get("TotalPage", 1) or 1):
            break
    return out


def report_pdf_url(info_code: str) -> str:
    return PDF_TPL.format(info_code=info_code)


# ---------- 3.3 板块归属 / 3.4 分钟资金流 / 4.5 120 日资金流 ----------
def eastmoney_concept_blocks(code: str) -> dict:
    """个股所属板块 / 概念(slist 一次拿全):{total, boards:[{name, code, change_pct, lead_stock}], concept_tags}"""
    params = {"fltt": "2", "invt": "2", "secid": _secid(code), "spt": "3", "pi": "0", "pz": "200", "po": "1", "fields": "f12,f14,f3,f128"}
    d = _push2_json("/api/qt/slist/get", params=params, headers=_REF, timeout=15)
    diff = (d.get("data") or {}).get("diff") or {}
    items = diff.values() if isinstance(diff, dict) else diff
    boards = [{"name": it.get("f14", ""), "code": it.get("f12", ""), "change_pct": it.get("f3", ""), "lead_stock": it.get("f128", "")} for it in items]
    return {"total": len(boards), "boards": boards, "concept_tags": [b["name"] for b in boards]}


def eastmoney_fund_flow_minute(code: str) -> list[dict]:
    """个股资金流(分钟级,当日盘中);单位 元。ETF 不覆盖。"""
    params = {"secid": _secid(code), "klt": 1, "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57"}
    d = _push2_json("/api/qt/stock/fflow/kline/get", params=params, headers={**_REF, "Origin": "https://quote.eastmoney.com"}, timeout=10)
    rows = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) >= 6:
            rows.append({"time": p[0], "main_net": float(p[1]), "small_net": float(p[2]), "mid_net": float(p[3]), "large_net": float(p[4]), "super_net": float(p[5])})
    return rows


def stock_fund_flow_120d(code: str) -> list[dict]:
    """个股资金流(日级,最近 120 个交易日);单位 元。push2his 在部分网络不通(本机如此),由取数器记失败。"""
    params = {"secid": _secid(code), "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65", "lmt": "120"}
    d = _push2his_json("/api/qt/stock/fflow/daykline/get", params=params, headers={**_REF, "Origin": "https://quote.eastmoney.com"}, timeout=15)
    rows = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) >= 7:
            f = lambda x: float(x) if x not in ("-", "") else 0.0  # noqa: E731
            rows.append({"date": p[0], "main_net": f(p[1]), "small_net": f(p[2]), "mid_net": f(p[3]), "large_net": f(p[4]), "super_net": f(p[5])})
    return rows


# ---------- 3.5 龙虎榜 / 3.6 解禁 ----------
def dragon_tiger_board(code: str, trade_date: Optional[str] = None, look_back: int = 30) -> dict:
    """个股龙虎榜:{records:[{date, reason, net_buy(万元), turnover(%)}], seats:{buy:[..], sell:[..]}(万元), institution:{buy_amt, sell_amt, net_amt}(万元)}"""
    digits, _ = norm_ticker(code, stock_only=True)
    trade_date = trade_date or _today()
    start = (datetime.strptime(trade_date, "%Y-%m-%d") - timedelta(days=look_back)).strftime("%Y-%m-%d")
    data = eastmoney_datacenter("RPT_DAILYBILLBOARD_DETAILSNEW", filter_str=f"(TRADE_DATE>='{start}')(TRADE_DATE<='{trade_date}')(SECURITY_CODE=\"{digits}\")",
                                page_size=50, sort_columns="TRADE_DATE", sort_types="-1")
    raw_records = last_raw_ref()
    records = [{"date": str(r.get("TRADE_DATE", ""))[:10], "reason": r.get("EXPLANATION", ""), "net_buy": round((r.get("BILLBOARD_NET_AMT") or 0) / 10000, 1),
                "turnover": round(float(r.get("TURNOVERRATE") or 0), 2), "_raw": raw_records} for r in data]
    buy_data: list = []
    sell_data: list = []
    seats: dict = {"buy": [], "sell": []}
    if records:
        latest = records[0]["date"]
        buy_data = eastmoney_datacenter("RPT_BILLBOARD_DAILYDETAILSBUY", filter_str=f"(TRADE_DATE='{latest}')(SECURITY_CODE=\"{digits}\")", page_size=10, sort_columns="BUY", sort_types="-1")
        sell_data = eastmoney_datacenter("RPT_BILLBOARD_DAILYDETAILSSELL", filter_str=f"(TRADE_DATE='{latest}')(SECURITY_CODE=\"{digits}\")", page_size=10, sort_columns="SELL", sort_types="-1")
        for rows_, side in ((buy_data, "buy"), (sell_data, "sell")):
            for r in rows_[:5]:
                seats[side].append({"name": r.get("OPERATEDEPT_NAME", ""), "buy_amt": round((r.get("BUY") or 0) / 10000, 1), "sell_amt": round((r.get("SELL") or 0) / 10000, 1), "net": round((r.get("NET") or 0) / 10000, 1)})
    inst = {"buy_amt": 0.0, "sell_amt": 0.0, "net_amt": 0.0}
    for rows_, side in ((buy_data, "buy"), (sell_data, "sell")):
        for r in rows_:
            if str(r.get("OPERATEDEPT_CODE", "")) == "0":
                inst["buy_amt" if side == "buy" else "sell_amt"] += (r.get("BUY") or 0) if side == "buy" else (r.get("SELL") or 0)
    inst = {k: round(v / 10000, 1) for k, v in inst.items()}
    inst["net_amt"] = round(inst["buy_amt"] - inst["sell_amt"], 1)
    return {"records": records, "seats": seats, "institution": inst, "window": [start, trade_date]}


def lockup_expiry(code: str, trade_date: Optional[str] = None, forward_days: int = 90) -> dict:
    """限售解禁:{history:[{date, type, shares(万股), able_shares(万股), ratio(小数)}], upcoming:[...]}"""
    digits, _ = norm_ticker(code, stock_only=True)
    trade_date = trade_date or _today()
    conv = lambda r: {"date": str(r.get("FREE_DATE", ""))[:10], "type": r.get("FREE_SHARES_TYPE", ""), "shares": r.get("FREE_SHARES", 0),  # noqa: E731
                      "able_shares": r.get("ABLE_FREE_SHARES", 0), "ratio": r.get("FREE_RATIO", 0)}
    history = [conv(r) for r in eastmoney_datacenter("RPT_LIFT_STAGE", filter_str=f"(SECURITY_CODE=\"{digits}\")", page_size=15, sort_columns="FREE_DATE", sort_types="-1")]
    ref_h = last_raw_ref()
    history = [{**r, "_raw": ref_h} for r in history]
    end = (datetime.strptime(trade_date, "%Y-%m-%d") + timedelta(days=forward_days)).strftime("%Y-%m-%d")
    upcoming = [conv(r) for r in eastmoney_datacenter("RPT_LIFT_STAGE", filter_str=f"(SECURITY_CODE=\"{digits}\")(FREE_DATE>='{trade_date}')(FREE_DATE<='{end}')",
                                                        page_size=20, sort_columns="FREE_DATE", sort_types="1")]
    ref_u = last_raw_ref()
    upcoming = [{**r, "_raw": ref_u} for r in upcoming]
    return {"history": history, "upcoming": upcoming, "window": [trade_date, end]}


# ---------- 3.7 行业排名 / 3.8 板块资金流 / 3.9 全市场龙虎榜 ----------
def industry_comparison(top_n: int = 20) -> dict:
    params = {"pn": "1", "pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": "f3", "fs": "m:90+t:2",
              "fields": "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141,f207"}
    d = _push2_json("/api/qt/clist/get", params=params, headers={"User-Agent": UA}, timeout=15)
    items = (d.get("data") or {}).get("diff") or []
    rows = [{"rank": i + 1, "name": it.get("f14", ""), "change_pct": it.get("f3", 0), "code": it.get("f12", ""), "up_count": it.get("f104", 0),
             "down_count": it.get("f105", 0), "leader": it.get("f140", ""), "leader_change": it.get("f136", 0)} for i, it in enumerate(items)]
    return {"top": rows[:top_n], "bottom": rows[-top_n:] if rows else [], "total": len(rows), "rows": rows}


_BOARD_FS = {"industry": "m:90+t:2", "concept": "m:90+t:3", "region": "m:90+t:1"}
_BOARD_PERIOD = {"today": ("f62", "f62", "f184", "f3", "f204"), "5d": ("f164", "f164", "f165", "f109", "f257"), "10d": ("f174", "f174", "f175", "f160", None)}


def board_fund_flow(board_type: str = "industry", period: str = "today", top_n: int = 20) -> dict:
    """板块资金流向排名(主力净额降序);main_net 元,main_pct %;today 另有四档净额。"""
    if board_type not in _BOARD_FS:
        raise ValueError(f"board_type 须为 {list(_BOARD_FS)}")
    if period not in _BOARD_PERIOD:
        raise ValueError(f"period 须为 {list(_BOARD_PERIOD)}")
    fid, f_main, f_pct, f_chg, f_leader = _BOARD_PERIOD[period]
    fields = ["f12", "f14", f_chg, f_main, f_pct] + ([f_leader] if f_leader else []) + (["f66", "f72", "f78", "f84"] if period == "today" else [])
    base = {"pz": "200", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": fid, "fs": _BOARD_FS[board_type], "fields": ",".join(dict.fromkeys(fields))}

    def page(pn: int):
        d = _push2_json("/api/qt/clist/get", params={**base, "pn": str(pn)}, headers={"User-Agent": UA}, timeout=15).get("data") or {}
        return (d.get("diff") or []), int(d.get("total") or 0)

    items, total = page(1)
    # 🔴 **别假设上游认你请求的页大小**。这里 pz=200,而东财实际每页只给 100 条 ——
    #    原来的 `if len(more) < 200: break` 于是在第 2 页就停了:上游 total=496,我们只拿 200,
    #    而且**界面上完全看不出来**(看着像"就这么多板块")。
    #    实测:pn=1/2/3 各回 100 条、total 都报 496。
    #    ⇒ 页大小以**第一页实际回了多少**为准;只有"这一页一条都没有"或已达 total/top_n 才停。
    page_size = len(items) or 1
    pn = 2
    while len(items) < top_n and not (total and len(items) >= total):
        more, _ = page(pn)
        if not more:
            break
        items += more
        pn += 1
        if len(more) < page_size:   # 不满一页 = 最后一页
            break
    total = max(total, len(items))
    rows = []
    for i, it in enumerate(items):
        row = {"rank": i + 1, "name": it.get("f14", ""), "code": it.get("f12", ""), "change_pct": it.get(f_chg, 0), "main_net": it.get(f_main, 0), "main_pct": it.get(f_pct, 0),
               "leader": it.get(f_leader, "") if f_leader else ""}
        if period == "today":
            row.update({"super_large_net": it.get("f66", 0), "large_net": it.get("f72", 0), "medium_net": it.get("f78", 0), "small_net": it.get("f84", 0)})
        rows.append(row)
    return {"board_type": board_type, "period": period, "total": total, "rows": rows[:top_n]}


def daily_dragon_tiger(trade_date: Optional[str] = None, min_net_buy: Optional[float] = None) -> dict:
    trade_date = trade_date or _today()
    data = eastmoney_datacenter("RPT_DAILYBILLBOARD_DETAILSNEW", filter_str=f"(TRADE_DATE>='{trade_date}')(TRADE_DATE<='{trade_date}')", page_size=500,
                                sort_columns="BILLBOARD_NET_AMT", sort_types="-1")
    if not data:
        return {"date": trade_date, "total_records": 0, "stocks": [], "note": "无数据(非交易日或盘后未更新)"}
    actual = str(data[0].get("TRADE_DATE", ""))[:10]
    stocks = []
    for r in data:
        net_buy = (r.get("BILLBOARD_NET_AMT") or 0) / 10000
        if min_net_buy is not None and net_buy < min_net_buy:
            continue
        stocks.append({"code": r.get("SECURITY_CODE", ""), "name": r.get("SECURITY_NAME_ABBR", ""), "reason": r.get("EXPLANATION", ""), "close": r.get("CLOSE_PRICE") or 0,
                       "change_pct": round(float(r.get("CHANGE_RATE") or 0), 2), "net_buy_wan": round(net_buy, 1), "buy_wan": round((r.get("BILLBOARD_BUY_AMT") or 0) / 10000, 1),
                       "sell_wan": round((r.get("BILLBOARD_SELL_AMT") or 0) / 10000, 1), "turnover_pct": round(float(r.get("TURNOVERRATE") or 0), 2)})
    return {"date": actual, "total_records": len(stocks), "stocks": stocks}


# ---------- 4.x 资金面 / 筹码(数据中心) ----------
def margin_trading(code: str, page_size: int = 30) -> list[dict]:
    """融资融券明细(日级):rzye 融资余额 / rzmre 融资买入额 / rzche 融资偿还额 / rqye 融券余额(元);rqmcl 融券卖出量 / rqchl 偿还量(股);rzrqye 合计(元)"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPTA_WEB_RZRQ_GGMX", filter_str=f'(SCODE="{digits}")', page_size=page_size, sort_columns="DATE", sort_types="-1")
    return [{"date": str(r.get("DATE", ""))[:10], "rzye": r.get("RZYE", 0), "rzmre": r.get("RZMRE", 0), "rzche": r.get("RZCHE", 0), "rqye": r.get("RQYE", 0),
             "rqmcl": r.get("RQMCL", 0), "rqchl": r.get("RQCHL", 0), "rzrqye": r.get("RZRQYE", 0)} for r in data]


def block_trade(code: str, page_size: int = 20) -> list[dict]:
    """大宗交易:price 成交价(元) / close 收盘价(元) / premium_pct(%) / vol(万股,源口径) / amount(万元,源口径) / buyer / seller"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_DATA_BLOCKTRADE", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="TRADE_DATE", sort_types="-1")
    rows = []
    for r in data:
        close = r.get("CLOSE_PRICE") or 0
        price = r.get("DEAL_PRICE") or 0
        rows.append({"date": str(r.get("TRADE_DATE", ""))[:10], "price": price, "close": close, "premium_pct": round(((price / close - 1) * 100) if close else 0, 2),
                     "vol": r.get("DEAL_VOLUME", 0), "amount": r.get("DEAL_AMT", 0), "buyer": r.get("BUYER_NAME", ""), "seller": r.get("SELLER_NAME", "")})
    return rows


def holder_num_change(code: str, page_size: int = 10) -> list[dict]:
    """股东户数(季度):holder_num(户) / change_num(户) / change_ratio(环比 %) / avg_shares(户均持股,股)"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_HOLDERNUMLATEST", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="END_DATE", sort_types="-1")
    return [{"date": str(r.get("END_DATE", ""))[:10], "holder_num": r.get("HOLDER_NUM", 0), "change_num": r.get("HOLDER_NUM_CHANGE", 0),
             "change_ratio": r.get("HOLDER_NUM_RATIO", 0), "avg_shares": r.get("AVG_FREE_SHARES", 0)} for r in data]


def dividend_history(code: str, page_size: int = 20) -> list[dict]:
    """分红送转:bonus_rmb 每股派息税前(元,源 PRETAX_BONUS_RMB 口径)/ transfer_ratio 每 10 股转增 / bonus_ratio 每 10 股送股 / plan 进度;date = 除权除息日"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_SHAREBONUS_DET", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="EX_DIVIDEND_DATE", sort_types="-1")
    return [{"date": str(r.get("EX_DIVIDEND_DATE", ""))[:10], "bonus_rmb": r.get("PRETAX_BONUS_RMB", 0), "transfer_ratio": r.get("TRANSFER_RATIO", 0),
             "bonus_ratio": r.get("BONUS_RATIO", 0), "plan": r.get("ASSIGN_PROGRESS", ""), "report_date": str(r.get("REPORT_DATE", ""))[:10]} for r in data]


# ---------- 5.1 个股新闻 / 5.3 全球资讯 ----------
def _stock_news_via_jsonp(digits: str, page_size: int) -> list[dict]:
    """东财个股新闻 JSONP 搜索接口（原始实现，作兜底）。"""
    import json as _json
    import re as _re
    inner = _json.dumps({"uid": "", "keyword": digits, "type": ["cmsArticleWebOld"], "client": "web", "clientType": "web", "clientVersion": "curr",
                         "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "default", "pageIndex": 1, "pageSize": page_size, "preTag": "", "postTag": ""}}}, separators=(",", ":"))
    r = em("https://search-api-web.eastmoney.com/search/jsonp", params={"cb": "jQuery_news", "param": inner}, headers={"User-Agent": UA, "Referer": "https://so.eastmoney.com/"}, timeout=15, ext="js")
    text = r.text
    d = _json.loads(text[text.index("(") + 1: text.rindex(")")])
    arts = (d.get("result") or {}).get("cmsArticleWebOld") or []
    return [{"title": _re.sub(r"<[^>]+>", "", a.get("title", "")), "content": _re.sub(r"<[^>]+>", "", a.get("content", ""))[:200], "time": a.get("date", ""),
             "source": a.get("mediaName", ""), "url": a.get("url", "")} for a in arts]


def _stock_news_via_akshare(digits: str, page_size: int) -> list[dict]:
    """akshare stock_news_em：同走东财 news 接口但带完整浏览器上下文，反爬下更稳。

    东财 search/jsonp 的 cmsArticleWebOld 返回类型对无浏览器上下文的纯服务端调用
    已恒为 0 条（只回 passportWeb），导致原实现报「东财个股新闻为空」。akshare
    封装的 stock_news_em 带 sec-fetch/cookie/referer 指纹，实测稳定。
    """
    import re as _re
    import akshare as ak
    df = ak.stock_news_em(symbol=digits)
    if df is None or df.empty:
        return []
    out = []
    for _, row in df.head(page_size).iterrows():
        out.append({
            "title": _re.sub(r"<[^>]+>", "", str(row.get("新闻标题", ""))),
            "content": _re.sub(r"<[^>]+>", "", str(row.get("新闻内容", "")))[:200],
            "time": str(row.get("发布时间", "")),
            "source": str(row.get("文章来源", "")),
            "url": str(row.get("新闻链接", "")),
        })
    return out


def eastmoney_stock_news(code: str, page_size: int = 20) -> list[dict]:
    """东财个股新闻:[{title, content, time, source, url}]。JSONP 为主, akshare 兜底。

    按上游 review 收口:simonlin1212 在新加坡出口实测 JSONP 正常返回 10 条,
    0 条是境内部分网络/代理被东财按请求指纹拦截,不是接口死了。
    故 JSONP 保持主路径(质量更高:标题括号完整),仅当返回 0 条或抛错时
    回落 akshare,让被拦环境也能拿到数据。两条路径产物都过 <[^>]+> 清洗。
    """
    digits, _ = norm_ticker(code, stock_only=True)
    try:
        rows = _stock_news_via_jsonp(digits, page_size)
        if rows:
            return rows
    except Exception:
        pass  # JSONP 抛错/超时 → 回落 akshare
    try:
        return _stock_news_via_akshare(digits, page_size)
    except Exception:
        pass  # akshare 也不可用 → 返回空,调用方按"东财个股新闻为空"处理
    return []


def eastmoney_global_news(page_size: int = 50) -> list[dict]:
    """东财全球财经资讯(7x24 滚动):[{title, summary, time}]"""
    import uuid
    params = {"client": "web", "biz": "web_724", "fastColumn": "102", "sortEnd": "", "pageSize": str(page_size), "req_trace": str(uuid.uuid4())}
    d = em_json("https://np-weblist.eastmoney.com/comm/web/getFastNewsList", params=params, headers={"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"}, timeout=10)
    return [{"title": it.get("title", ""), "summary": (it.get("summary", "") or "")[:200], "time": it.get("showTime", "")} for it in (d.get("data") or {}).get("fastNewsList") or []]


# ---------- 6.3 个股基本面 ----------
def eastmoney_stock_info(code: str) -> dict:
    """东财个股基本面:{code, name, industry, total_shares(股), float_shares(股), mcap(元), float_mcap(元), list_date(YYYYMMDD), price}"""
    d = (_push2_json("/api/qt/stock/get", params={"fltt": "2", "invt": "2", "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43", "secid": _secid(code)},
                 headers={"User-Agent": UA}, timeout=10).get("data") or {})
    return {"code": d.get("f57", ""), "name": d.get("f58", ""), "industry": d.get("f127", ""), "total_shares": d.get("f84", 0), "float_shares": d.get("f85", 0),
            "mcap": d.get("f116", 0), "float_mcap": d.get("f117", 0), "list_date": str(d.get("f189", "")), "price": d.get("f43", 0)}


# ---------- 8.x 打板层 ----------
ZTB_UT = "7eea3edcaed734bea9cbfc24409ed989"


def _fmt_zt_time(t) -> str:
    s = str(t).zfill(6)
    return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"


def _em_zt_api(endpoint: str, sort: str, date: str) -> list[dict]:
    d = em_json(f"https://push2ex.eastmoney.com/{endpoint}", params={"ut": ZTB_UT, "dpt": "wz.ztzt", "Pageindex": 0, "pagesize": 10000, "sort": sort, "date": date}, headers=_REF, timeout=10)
    return (d.get("data") or {}).get("pool") or []


def _zt_stat(p: dict) -> str:
    z = p.get("zttj") or {}
    return f"{z.get('days', '?')}天{z.get('ct', '?')}板"


def em_zt_pool(date: Optional[str] = None) -> list[dict]:
    """涨停池(date=YYYYMMDD):code/name/price/pct/amount/float_cap/turnover/limit_days/first_seal/last_seal/seal_fund(元)/break_times/industry/zt_stat"""
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "amount": p["amount"], "float_cap": p["ltsz"], "turnover": round(p["hs"], 2),
             "limit_days": p["lbc"], "first_seal": _fmt_zt_time(p["fbt"]), "last_seal": _fmt_zt_time(p["lbt"]), "seal_fund": p["fund"], "break_times": p["zbc"],
             "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)} for p in _em_zt_api("getTopicZTPool", "fbt:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_zb_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "limit_price": p["ztp"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2),
             "first_seal": _fmt_zt_time(p["fbt"]), "break_times": p["zbc"], "amplitude": round(p["zf"], 2), "speed": round(p["zs"], 2), "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)}
            for p in _em_zt_api("getTopicZBPool", "fbt:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_dt_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2), "pe": p.get("pe"), "seal_fund": p["fund"],
             "last_seal": _fmt_zt_time(p["lbt"]), "board_amount": p.get("fba"), "dt_days": p.get("days"), "open_times": p.get("oc"), "industry": p.get("hybk", "")}
            for p in _em_zt_api("getTopicDTPool", "fund:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_yzt_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2), "amplitude": round(p["zf"], 2), "speed": round(p["zs"], 2),
             "y_first_seal": _fmt_zt_time(p["yfbt"]), "y_limit_days": p["ylbc"], "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)} for p in _em_zt_api("getYesterdayZTPool", "zs:desc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def limit_up_sentiment(date: Optional[str] = None) -> dict:
    """打板情绪:连板梯队 / 炸板率 / 涨跌停对比(由四池组合)。"""
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    zt, zb, dt = em_zt_pool(date), em_zb_pool(date), em_dt_pool(date)
    # 只返回三池原始列表与计数;炸板率 / 连板梯队等派生统计由 calc 计算
    return {"date": date, "zt_count": len(zt), "zb_count": len(zb), "dt_count": len(dt), "zt": zt, "zb": zb, "dt": dt}


_MONITOR_MARKET = {"1": "SH", "0": "SZ", "B": "BJ"}


def em_stock_monitor(only_active: bool = True) -> list[dict]:
    """东财重点监控池(风险警示名单 + 生效窗口):[{code, name, market, start, end, link}]"""
    rows = em_json("https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json", headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20) or []
    today = _today()
    out = []
    for x in rows:
        start, end = x.get("VALIDATESTARTDATE", ""), x.get("VALIDATEENDDATE", "")
        if only_active and not (start <= today <= end):
            continue
        mk = str(x.get("MARKET", "")).upper()
        out.append({"code": x.get("STKCODE", ""), "name": x.get("STKNAME", ""), "market": _MONITOR_MARKET.get(mk, f"?{mk}"), "start": start, "end": end, "link": x.get("LINK_URL", "")})
    return out


ANOMALY_BASE = "https://dycalchis.eastmoney.com/price-anomaly"
HQ_PARAMS = {"team": "h5", "product": "EastMoney", "client": "WAP", "version": "9001", "name": "WAP", "user": "123"}
ANOMALY_RULES = {1: "主板连续10个交易日内4次出现同向异常波动", 2: "创业板连续10个交易日内3次出现同向异常波动", 3: "科创板连续10个交易日内3次出现同向异常波动",
                 4: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+100%", 5: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-50%", 6: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到+200%",
                 7: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到-70%", 8: "北交所连续10个交易日内3次出现同向异常波动", 40: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+150%",
                 50: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-60%", 60: "连续30个交易日内日收盘价涨跌幅偏离值累计达到+300%", 70: "连续30个交易日内日收盘价涨跌幅偏离值累计达到-75%"}


def _anomaly_market(code, m, board=None) -> str:
    c = str(code or "")
    if c.startswith("920") or c[:2] in ("43", "83", "87") or board == 8:
        return "BJ"
    return "SH" if m == 1 else "SZ"


def _anomaly_get(path: str, page_size: int, page_no: int, **extra) -> dict:
    d = em_json(f"{ANOMALY_BASE}/{path}", params={**HQ_PARAMS, "pageSize": str(page_size), "pageNo": str(page_no), **extra}, headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20)
    if d.get("result") != 0:
        raise RuntimeError(f"东财异动接口拒绝: result={d.get('result')} msg={d.get('msg')!r}")
    return d


def em_price_anomaly(page_size: int = 200, page_no: int = 1) -> dict:
    d = _anomaly_get("list", page_size, page_no)
    items = []
    for x in d.get("data") or []:
        e = x.get("e")
        key = e * 10 if (x.get("s") == 6 and e in (4, 5, 6, 7)) else e
        items.append({"code": x.get("c"), "name": x.get("n"), "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")), "change_pct": x.get("a"), "deviation": x.get("x"),
                      "days": x.get("d"), "board": x.get("s"), "rule_code": key, "rule": ANOMALY_RULES.get(key, f"未知规则码 {key}"), "is_today": x.get("o") != 2})
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}


def em_price_anomaly_count(page_size: int = 50, page_no: int = 1, sort_key: str = "", sort_dir: str = "") -> dict:
    d = _anomaly_get("count", page_size, page_no, sortKey=sort_key, sortDir=sort_dir)
    items = [{"code": x.get("c"), "name": x.get("n"), "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")), "price": x.get("p"), "change_pct": x.get("a"), "times": x.get("t"),
              "deviation": x.get("x"), "days": x.get("d"), "board": x.get("s")} for x in d.get("data") or []]
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}


# ---------- 10.2 人气榜 / 概念命中(emappdata,POST) ----------
EM_HOT_BODY = {"appId": "appId01", "globalId": "786e4c21-70dc-435a-93bb-38"}


def em_hot_rank(top: int = 50) -> list[dict]:
    """东财人气榜:rank/code/name/price/pct/rank_chg(名称 / 价格用 push2 ulist.np 批量补)。emappdata 为 POST,经 record_raw 落盘。"""
    import requests
    from sources._http import record_raw
    resp = requests.post("https://emappdata.eastmoney.com/stockrank/getAllCurrentList", json={**EM_HOT_BODY, "marketType": "", "pageNo": 1, "pageSize": top}, headers={"User-Agent": UA}, timeout=10)
    resp.raise_for_status()
    raw_rank = record_raw(resp.content, "json", resp.url)
    data = resp.json().get("data") or []
    if not data:
        return []
    secids = [("0." if it["sc"].startswith("SZ") else "1.") + it["sc"][2:] for it in data]
    u = _push2_json("/api/qt/ulist.np/get", params={"ut": "f057cbcbce2a86e2866ab8877db1d059", "fltt": 2, "invt": 2, "fields": "f14,f3,f12,f2", "secids": ",".join(secids)}, headers=_REF, timeout=10)
    diff = (u.get("data") or {}).get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    nm = {x["f12"]: (x.get("f14"), x.get("f2"), x.get("f3")) for x in diff}
    out = []
    for it in data:
        code = it["sc"][2:]
        name, price, pct = nm.get(code, ("", None, None))
        out.append({"rank": it["rk"], "code": code, "name": name, "price": price, "pct": pct, "rank_chg": it.get("hisRc"), "_raw": raw_rank})
    return out


def em_hot_concept(code: str) -> list[dict]:
    """个股热门概念命中:[{concept, bk, hit}](按热度降序)"""
    import requests
    from sources._http import record_raw
    digits, market = norm_ticker(code, stock_only=True)
    resp = requests.post("https://emappdata.eastmoney.com/stockrank/getHotStockRankList", json={**EM_HOT_BODY, "srcSecurityCode": market + digits}, headers={"User-Agent": UA}, timeout=10)
    resp.raise_for_status()
    record_raw(resp.content, "json", resp.url)
    return [{"concept": x.get("conceptName"), "bk": x.get("conceptId"), "hit": x.get("hitCount")} for x in resp.json().get("data") or []]


# ---------- 全球(美股 / 港股):global-stock-data §1.3 / §4.1 / §4.2 / §5.1 / §8.1 / §8.4 ----------
_GLOBAL_SECID: dict = {}
_MKT_SUFFIX = {105: "O", 106: "N", 107: "A"}


def stock_search(keyword: str, count: int = 10) -> list[dict]:
    """东财全球搜索:[{code, name, mkt_num(105 NASDAQ / 106 NYSE / 107 美股 ETF / 116 港股), market_name, security_type}]"""
    d = em_json("https://searchapi.eastmoney.com/api/suggest/get", params={"input": keyword, "type": 14, "token": "D43BF722C8E33BDC906FB84D85E326E8", "count": count}, timeout=10)
    out = []
    mm = {"105": "NASDAQ", "106": "NYSE", "107": "US_OTHER", "116": "HK"}
    for it in (d.get("QuotationCodeTable") or {}).get("Data") or []:
        mkt = str(it.get("MktNum", ""))
        if mkt in mm:
            out.append({"code": it.get("Code"), "name": it.get("Name"), "mkt_num": int(mkt), "market_name": mm[mkt], "security_type": it.get("SecurityTypeName")})
    return out


def resolve_global_secid(symbol: str, market: str = "US") -> tuple:
    """→ (mkt_num, code):港股固定 116;美股先查搜索接口(精确匹配 Code),再按 105/106/107 逐个试 push2。进程内缓存。"""
    from sources._http import assert_us_ticker, norm_hk
    key = (market, symbol.upper())
    if key in _GLOBAL_SECID:
        return _GLOBAL_SECID[key]
    if market == "HK":
        res = (116, norm_hk(symbol))
    else:
        t = assert_us_ticker(symbol)
        res = None
        try:
            hits = [h for h in stock_search(t, 10) if str(h.get("code", "")).upper() == t and h["mkt_num"] in (105, 106, 107)]
            if hits:
                res = (hits[0]["mkt_num"], t)
        except Exception:  # noqa: BLE001 — 搜索失败则逐个试
            pass
        if res is None:
            for p_ in (105, 106, 107):
                d = _push2_json("/api/qt/stock/get", params={"secid": f"{p_}.{t}", "fields": "f57,f58"}, timeout=10)
                if d.get("data"):
                    res = (p_, t)
                    break
        if res is None:
            raise ValueError(f"东财未收录美股 {t}(105/106/107 均无数据)")
    _GLOBAL_SECID[key] = res
    return res


def stock_quote_global(symbol: str, market: str = "US") -> dict:
    """东财 push2 实时行情(美股 / 港股):{code, name, price, high, low, open, volume(股), amount, turnover_rate(%), prev_close, change_pct(%), secid}"""
    mkt, code = resolve_global_secid(symbol, market)
    d = (_push2_json("/api/qt/stock/get", params={"secid": f"{mkt}.{code}", "fields": "f43,f44,f45,f46,f47,f48,f55,f57,f58,f59,f60,f170"}, timeout=10).get("data")) or {}
    if not d:
        return {}
    dec = d.get("f59", 3) or 3
    div = 10 ** dec

    def _p(k):
        v = d.get(k)
        return None if v in (None, "-") else round(v / div, dec)

    return {"code": d.get("f57"), "name": d.get("f58"), "price": _p("f43"), "high": _p("f44"), "low": _p("f45"), "open": _p("f46"), "volume": d.get("f47"), "amount": d.get("f48"), "turnover_rate": d.get("f55"),
            "prev_close": _p("f60"), "change_pct": round(d["f170"] / 100, 2) if d.get("f170") not in (None, "-") else None, "secid": f"{mkt}.{code}"}


def _secucode(symbol: str, market: str) -> str:
    mkt, code = resolve_global_secid(symbol, market)
    return f"{code}.HK" if market == "HK" else f"{code}.{_MKT_SUFFIX.get(mkt, 'O')}"


def financial_statements_global(symbol: str, market: str = "US", statement: str = "income", page_size: int = 200) -> list[dict]:
    """东财 datacenter 财报三表(美股 / 港股),按科目行展开:[{ITEM_NAME, AMOUNT, YOY_RATIO, REPORT, REPORT_DATE, CURRENCY, ACCOUNT_STANDARD, ...}]"""
    rm = {"balance": {"us": "RPT_USF10_FN_BALANCE", "hk": "RPT_HKF10_FN_BALANCE"}, "income": {"us": "RPT_USF10_FN_INCOME", "hk": "RPT_HKF10_FN_INCOME"},
          "cashflow": {"us": "RPT_USSK_FN_CASHFLOW", "hk": "RPT_HKSK_FN_CASHFLOW"}}
    if statement not in rm:
        raise ValueError("statement 只能是 balance / income / cashflow")
    return eastmoney_datacenter(rm[statement]["hk" if market == "HK" else "us"], filter_str=f'(SECUCODE="{_secucode(symbol, market)}")', page_size=page_size, sort_columns="REPORT_DATE", sort_types="-1")


def key_indicators_global(symbol: str, market: str = "US", page_size: int = 4) -> list[dict]:
    """东财 GMAININDICATOR 关键财务指标(中文字段名,美股 49 / 港股 75 列):[{REPORT_DATE, OPERATE_INCOME, BASIC_EPS, ROE_AVG, ...}]"""
    return eastmoney_datacenter(f"RPT_{'HK' if market == 'HK' else 'US'}F10_FN_GMAININDICATOR", filter_str=f'(SECUCODE="{_secucode(symbol, market)}")', page_size=page_size, sort_columns="REPORT_DATE", sort_types="-1")


def fund_flow_daily_global(symbol: str, market: str = "US", limit: int = 100) -> list[dict]:
    """东财 push2his 日级资金流(美股 / 港股):[{date, main_net, small_net, mid_net, big_net, super_big_net, main_pct}]"""
    mkt, code = resolve_global_secid(symbol, market)
    d = _push2his_json("/api/qt/stock/fflow/daykline/get", params={"secid": f"{mkt}.{code}", "klt": 101, "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57", "lmt": limit}, timeout=15)
    rows = []
    for line in ((d.get("data") or {}).get("klines") or []):
        p_ = line.split(",")
        f_ = lambda x: float(x) if x not in ("-", "") else 0.0  # noqa: E731
        rows.append({"date": p_[0], "main_net": f_(p_[1]), "small_net": f_(p_[2]), "mid_net": f_(p_[3]), "big_net": f_(p_[4]), "super_big_net": f_(p_[5]), "main_pct": f_(p_[6]) if len(p_) > 6 else 0.0})
    return rows


def market_stock_list(market: str = "us_nasdaq", sort_field: str = "f3", sort_desc: bool = True, page: int = 1, page_size: int = 20) -> dict:
    """东财 push2 全市场列表(涨跌幅 / 成交量 / 成交额排名):{total, stocks:[{code, name, price(原始值), change_pct, volume, amount, amplitude, ...}]}。market: us_nasdaq / us_nyse / us_etf / hk 或 fs 原串"""
    fs = {"us_nasdaq": "m:105", "us_nyse": "m:106", "us_etf": "m:107", "hk": "m:116"}.get(market, market)
    d = _push2_json("/api/qt/clist/get", params={"fs": fs, "fields": "f2,f3,f4,f5,f6,f7,f12,f14,f15,f16,f17,f18", "pn": page, "pz": page_size, "fid": sort_field, "po": 1 if sort_desc else 0}, timeout=15)
    data = d.get("data") or {}
    diff = data.get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    stocks = [{"code": it.get("f12"), "name": it.get("f14"), "price": it.get("f2"), "change_pct": round(it["f3"] / 100, 2) if it.get("f3") not in (None, "-") else None, "change_amount": it.get("f4"),
               "volume": it.get("f5"), "amount": it.get("f6"), "amplitude": round(it["f7"] / 100, 2) if it.get("f7") not in (None, "-") else None, "high": it.get("f15"), "low": it.get("f16"), "open": it.get("f17"),
               "prev_close": it.get("f18")} for it in diff]
    return {"total": data.get("total", 0), "stocks": stocks, "market": market}


# 沪深京 A 股(主板 / 创业板 / 科创板 / 北交所);与东财行情中心「沪深京 A 股」同一口径
_A_SHARE_FS = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048"


def market_turnover_rank(top_n: int = 20) -> dict:
    """全市场成交额榜(沪深京 A 股按成交额降序 TopN)。

    ⚠️ 这是**客观公开榜单**(东财行情中心同款),只做客观展示 —— 非推荐、非预测、不评分。
    🔴 分页按**第一页实际回了多少**推进,不假设上游认我们请求的 pz
       (东财实测忽略 pz=200、每页只给 100;板块资金流就是这么少拿了一半,
       导致"净流出最多"那一栏里全是净流入的板块)。
    """
    base = {"pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": "f6",
            "fs": _A_SHARE_FS, "fields": "f12,f14,f2,f3,f6,f20,f21,f100"}

    def page(pn: int):
        d = _push2_json("/api/qt/clist/get", params={**base, "pn": str(pn)}, headers={"User-Agent": UA}, timeout=15).get("data") or {}
        return (d.get("diff") or []), int(d.get("total") or 0)

    items, total = page(1)
    page_size = len(items) or 1
    pn = 2
    while len(items) < top_n and not (total and len(items) >= total):
        more, _ = page(pn)
        if not more:
            break
        items += more
        pn += 1
        if len(more) < page_size:
            break

    rows = [{"rank": i + 1, "code": str(it.get("f12", "")), "name": it.get("f14", ""),
             "price": it.get("f2"), "pct": it.get("f3"), "amount": it.get("f6"),
             "mcap": it.get("f20"), "float_cap": it.get("f21"), "industry": it.get("f100", "")}
            for i, it in enumerate(items[:top_n])]
    return {"total": max(total, len(items)), "returned": len(rows), "rows": rows}
