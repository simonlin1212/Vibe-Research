"""A-share market boards — board fund flow / northbound / hot lists /
monitor pool / price anomaly / limit-up pools.

Ported from a-stock-data v3.5~v3.6. Objective public boards only;
no recommendation / scoring / prediction.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import requests

import astock

UA = astock.UA
em_get = astock.em_get
BEIJING = timezone(timedelta(hours=8))

# ── Board fund flow ───────────────────────────────────────────────────────

_BOARD_FS = {"industry": "m:90+t:2", "concept": "m:90+t:3", "region": "m:90+t:1"}
_BOARD_PERIOD = {
    "today": ("f62", "f62", "f184", "f3", "f204"),
    "5d": ("f164", "f164", "f165", "f109", "f257"),
    "10d": ("f174", "f174", "f175", "f160", None),
}


def board_fund_flow(
    board_type: str = "industry",
    period: str = "today",
    top_n: int = 20,
) -> dict:
    """Eastmoney board money-flow ranking (industry/concept/region x today/5d/10d)."""
    if board_type not in _BOARD_FS:
        board_type = "industry"
    if period not in _BOARD_PERIOD:
        period = "today"
    n = max(5, min(int(top_n or 20), 50))
    fid, f_main, f_pct, f_chg, f_leader = _BOARD_PERIOD[period]
    fields = ["f12", "f14", f_chg, f_main, f_pct]
    if f_leader:
        fields.append(f_leader)
    if period == "today":
        fields += ["f66", "f72", "f78", "f84"]
    params = {
        "pn": "1", "pz": str(max(n, 50)), "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": fid,
        "fs": _BOARD_FS[board_type],
        "fields": ",".join(dict.fromkeys(fields)),
    }
    data: dict = {}
    for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/clist/get",
                params=params,
                headers={"User-Agent": UA},
                timeout=15,
            )
            data = (r.json() or {}).get("data") or {}
            if data.get("diff"):
                break
        except Exception:
            continue
    items = data.get("diff") or []
    if isinstance(items, dict):
        items = list(items.values())
    rows = []
    for i, it in enumerate(items[:n]):
        if not isinstance(it, dict):
            continue
        row = {
            "rank": i + 1,
            "name": it.get("f14") or "",
            "code": it.get("f12") or "",
            "change_pct": it.get(f_chg) if isinstance(it.get(f_chg), (int, float)) else 0,
            "main_net": it.get(f_main) if isinstance(it.get(f_main), (int, float)) else 0,
            "main_pct": it.get(f_pct) if isinstance(it.get(f_pct), (int, float)) else 0,
            "leader": (it.get(f_leader) or "") if f_leader else "",
        }
        if period == "today":
            row.update({
                "super_large_net": it.get("f66") if isinstance(it.get("f66"), (int, float)) else 0,
                "large_net": it.get("f72") if isinstance(it.get("f72"), (int, float)) else 0,
                "medium_net": it.get("f78") if isinstance(it.get("f78"), (int, float)) else 0,
                "small_net": it.get("f84") if isinstance(it.get("f84"), (int, float)) else 0,
            })
        rows.append(row)
    return {
        "board_type": board_type,
        "period": period,
        "total": int(data.get("total") or len(rows)),
        "rows": rows,
        "note": "公开榜单,仅客观呈现",
    }


# A-share universe for clist money-flow (same fs as Eastmoney quote center).
_STOCK_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"


def stock_moneyflow(top_n: int = 15, board_code: str | None = None) -> dict:
    """Eastmoney clist: main-force net inflow ranking (yuan).

    board_code like BK0474 filters to that board's constituents.
    """
    n = max(5, min(int(top_n or 15), 40))
    fs = _STOCK_FS
    if board_code:
        code = str(board_code).strip().upper()
        if code.startswith("BK") and len(code) == 6 and code[2:].isdigit():
            fs = f"b:{code}"
    win = max(n * 3, 50) if board_code else n
    fields = "f12,f14,f2,f3,f62,f184,f66,f6,f8"
    params = {
        "pn": "1", "pz": str(win), "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": "f62",
        "fs": fs,
        "fields": fields,
    }
    data: dict = {}
    for host in ("push2delay.eastmoney.com", "push2.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/clist/get",
                params=params,
                headers={"User-Agent": UA},
                timeout=15,
            )
            data = (r.json() or {}).get("data") or {}
            if data.get("diff"):
                break
        except Exception:
            continue
    items = data.get("diff") or []
    if isinstance(items, dict):
        items = list(items.values())
    rows = []
    for it in items:
        if not isinstance(it, dict):
            continue
        name = it.get("f14") or ""
        price = it.get("f2")
        if not name or not isinstance(price, (int, float)) or price <= 0:
            continue
        rows.append({
            "code": it.get("f12") or "",
            "name": name,
            "price": price,
            "change_pct": it.get("f3") if isinstance(it.get("f3"), (int, float)) else 0,
            "main_net": it.get("f62") if isinstance(it.get("f62"), (int, float)) else 0,
            "main_pct": it.get("f184") if isinstance(it.get("f184"), (int, float)) else 0,
            "super_large_net": it.get("f66") if isinstance(it.get("f66"), (int, float)) else 0,
            "amount": it.get("f6") if isinstance(it.get("f6"), (int, float)) else 0,
            "turnover": it.get("f8") if isinstance(it.get("f8"), (int, float)) else 0,
        })
        if len(rows) >= n:
            break
    return {
        "board": board_code or None,
        "total": len(rows),
        "rows": rows,
        "note": "公开榜单,东财主力净流入,仅客观呈现",
    }


# ── Northbound (HSGT) ─────────────────────────────────────────────────────

def hsgt_realtime() -> dict:
    """THS northbound minute flow. hgt usable; sgt reference only since 2024-08."""
    try:
        r = requests.get(
            "https://data.hexin.cn/market/hsgtApi/method/dayChart/",
            headers={
                "User-Agent": UA,
                "Host": "data.hexin.cn",
                "Referer": "https://data.hexin.cn/",
            },
            timeout=12,
        )
        r.raise_for_status()
        d = r.json() or {}
    except Exception:
        return {"points": [], "latest": None, "note": "北向数据暂不可用"}
    times = d.get("time") or []
    hgt = d.get("hgt") or []
    sgt = d.get("sgt") or []
    points = []
    for i, t in enumerate(times):
        hv = hgt[i] if i < len(hgt) else None
        sv = sgt[i] if i < len(sgt) else None
        points.append({
            "time": t,
            "hgt_yi": float(hv) if isinstance(hv, (int, float)) else None,
            "sgt_yi": float(sv) if isinstance(sv, (int, float)) else None,
        })
    latest = points[-1] if points else None
    # Persist a simple daily snapshot under ~/.vibe-research
    if latest and latest.get("hgt_yi") is not None:
        _save_hsgt_snap(latest["hgt_yi"], latest.get("sgt_yi"))
    return {
        "date": datetime.now(BEIJING).strftime("%Y-%m-%d"),
        "points": points[-80:],  # keep payload light
        "latest": latest,
        "note": "沪股通可用;深股通仅供参考(盘中披露收紧)",
    }


def _save_hsgt_snap(hgt: float, sgt: float | None) -> None:
    try:
        from pathlib import Path
        p = Path.home() / ".vibe-research" / "northbound_daily.csv"
        p.parent.mkdir(parents=True, exist_ok=True)
        day = datetime.now(BEIJING).strftime("%Y-%m-%d")
        rows: dict[str, str] = {}
        if p.exists():
            for line in p.read_text(encoding="utf-8").strip().splitlines()[1:]:
                parts = line.split(",")
                if len(parts) >= 3:
                    rows[parts[0]] = line
        rows[day] = f"{day},{hgt},{sgt if sgt is not None else ''}"
        p.write_text(
            "date,hgt,sgt\n" + "\n".join(rows[k] for k in sorted(rows)) + "\n",
            encoding="utf-8",
        )
    except Exception:
        pass


# ── Hot lists ─────────────────────────────────────────────────────────────

def ths_hot_list(period: str = "hour", top: int = 30) -> dict:
    """10jqka hot list. period: hour | day."""
    if period not in ("hour", "day"):
        period = "hour"
    n = max(5, min(int(top or 30), 50))
    try:
        r = requests.get(
            "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock",
            params={"stock_type": "a", "type": period, "list_type": "normal"},
            headers={"User-Agent": UA},
            timeout=12,
        )
        lst = ((r.json() or {}).get("data") or {}).get("stock_list") or []
    except Exception:
        return {"period": period, "rows": []}
    rows = []
    for it in lst[:n]:
        tag = it.get("tag") or {}
        rows.append({
            "rank": it.get("order"),
            "code": it.get("code"),
            "name": it.get("name"),
            "heat": it.get("rate"),
            "pct": it.get("rise_and_fall"),
            "rank_chg": it.get("hot_rank_chg"),
            "concepts": tag.get("concept_tag") or [],
            "tag": tag.get("popularity_tag") or "",
        })
    return {"period": period, "source": "同花顺热榜", "rows": rows}


# ── Monitor + anomaly ─────────────────────────────────────────────────────

_MONITOR_URL = "https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json"
_MONITOR_MARKET = {"1": "SH", "0": "SZ", "B": "BJ"}
_ANOMALY_BASE = "https://dycalchis.eastmoney.com/price-anomaly"
_HQ_PARAMS = {
    "team": "h5", "product": "EastMoney", "client": "WAP",
    "version": "9001", "name": "WAP", "user": "123",
}
_ANOMALY_RULES = {
    1: "主板连续10个交易日内4次出现同向异常波动",
    2: "创业板连续10个交易日内3次出现同向异常波动",
    3: "科创板连续10个交易日内3次出现同向异常波动",
    4: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+100%",
    5: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-50%",
    6: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到+200%",
    7: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到-70%",
    8: "北交所连续10个交易日内3次出现同向异常波动",
    40: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+150%",
    50: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-60%",
    60: "连续30个交易日内日收盘价涨跌幅偏离值累计达到+300%",
    70: "连续30个交易日内日收盘价涨跌幅偏离值累计达到-75%",
}


def cn_today() -> str:
    return datetime.now(BEIJING).date().isoformat()


def em_stock_monitor(only_active: bool = True) -> dict:
    """Exchange risk / key-monitor list."""
    try:
        r = em_get(
            _MONITOR_URL,
            headers={"Referer": "https://vipmoney.eastmoney.com/", "User-Agent": UA},
            timeout=20,
        )
        raw = r.json() or []
    except Exception:
        return {"date": cn_today(), "rows": []}
    today = cn_today()
    rows = []
    for x in raw:
        if not isinstance(x, dict):
            continue
        start, end = x.get("VALIDATESTARTDATE") or "", x.get("VALIDATEENDDATE") or ""
        if only_active and not (start <= today <= end):
            continue
        raw_mkt = str(x.get("MARKET") or "").upper()
        rows.append({
            "code": x.get("STKCODE") or "",
            "name": x.get("STKNAME") or "",
            "market": _MONITOR_MARKET.get(raw_mkt, f"?{raw_mkt}"),
            "start": start,
            "end": end,
            "link": x.get("LINK_URL") or "",
        })
    return {"date": today, "count": len(rows), "rows": rows, "note": "交易所重点监控名单"}


def _anomaly_market(code, m, board=None) -> str:
    c = str(code or "")
    if c.startswith("920") or c[:2] in ("43", "83", "87") or board == 8:
        return "BJ"
    return "SH" if m == 1 else "SZ"


def em_price_anomaly(page_size: int = 80) -> dict:
    """Severe abnormal volatility list (exchange definition)."""
    n = max(10, min(int(page_size or 80), 200))
    try:
        r = em_get(
            f"{_ANOMALY_BASE}/list",
            params={**_HQ_PARAMS, "pageSize": str(n), "pageNo": "1"},
            headers={"Referer": "https://vipmoney.eastmoney.com/", "User-Agent": UA},
            timeout=20,
        )
        d = r.json() or {}
        if d.get("result") not in (0, None, "0"):
            return {"date": "", "items": [], "note": f"接口拒绝: {d.get('msg')}"}
    except Exception:
        return {"date": "", "items": []}
    items = []
    for x in d.get("data") or []:
        if not isinstance(x, dict):
            continue
        e = x.get("e")
        key = e * 10 if (x.get("s") == 6 and e in (4, 5, 6, 7)) else e
        items.append({
            "code": x.get("c"),
            "name": x.get("n"),
            "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")),
            "change_pct": x.get("a"),
            "deviation": x.get("x"),
            "days": x.get("d"),
            "rule_code": key,
            "rule": _ANOMALY_RULES.get(key, f"未知规则码 {key}"),
            "is_today": x.get("o") != 2,
        })
    date = str(d.get("date") or "")
    if len(date) == 8:
        date = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    return {"date": date, "count": len(items), "items": items, "note": "严重异常波动(交易所口径)"}


# ── Limit-up pools (public boards) ────────────────────────────────────────

def _fmt_zt_time(v) -> str:
    if not isinstance(v, (int, float)) or v <= 0:
        return ""
    s = str(int(v)).zfill(6)
    return f"{s[:2]}:{s[2:4]}:{s[4:]}"


def _resolve_trade_date() -> str:
    today = datetime.now(BEIJING).date()
    for back in range(10):
        d = (today - timedelta(days=back)).strftime("%Y%m%d")
        if astock.em_zt_topic_pool("getTopicZTPool", d, "fbt:asc"):
            return d
    return today.strftime("%Y%m%d")


def limit_up_pools(pool: str = "zt", date: str | None = None, top: int = 40) -> dict:
    """Public limit boards: zt / zb / dt / yzt."""
    endpoints = {
        "zt": ("getTopicZTPool", "fbt:asc"),
        "zb": ("getTopicZBPool", "fbt:asc"),
        "dt": ("getTopicDTPool", "fund:asc"),
        "yzt": ("getYesterdayZTPool", "zs:desc"),
    }
    if pool not in endpoints:
        pool = "zt"
    ep, sort = endpoints[pool]
    d = date or _resolve_trade_date()
    n = max(5, min(int(top or 40), 100))
    raw = astock.em_zt_topic_pool(ep, d, sort)
    rows = []
    for p in raw[:n]:
        if not isinstance(p, dict):
            continue
        zttj = p.get("zttj") or {}
        base = {
            "code": p.get("c"),
            "name": p.get("n"),
            "price": (p.get("p") or 0) / 1000 if isinstance(p.get("p"), (int, float)) else None,
            "pct": round(p["zdp"], 2) if isinstance(p.get("zdp"), (int, float)) else None,
            "turnover": round(p["hs"], 2) if isinstance(p.get("hs"), (int, float)) else None,
            "industry": p.get("hybk") or "",
            "zt_stat": f"{zttj.get('days', '?')}天{zttj.get('ct', '?')}板",
        }
        if pool == "zt":
            base.update({
                "limit_days": p.get("lbc"),
                "first_seal": _fmt_zt_time(p.get("fbt")),
                "last_seal": _fmt_zt_time(p.get("lbt")),
                "seal_fund": p.get("fund"),
                "break_times": p.get("zbc"),
                "amount": p.get("amount"),
            })
        elif pool == "zb":
            base.update({
                "break_times": p.get("zbc"),
                "amplitude": round(p["zf"], 2) if isinstance(p.get("zf"), (int, float)) else None,
                "speed": round(p["zs"], 2) if isinstance(p.get("zs"), (int, float)) else None,
                "first_seal": _fmt_zt_time(p.get("fbt")),
            })
        elif pool == "dt":
            base.update({
                "seal_fund": p.get("fund"),
                "dt_days": p.get("days"),
                "open_times": p.get("oc"),
                "last_seal": _fmt_zt_time(p.get("lbt")),
            })
        else:  # yzt
            base.update({
                "y_limit_days": p.get("ylbc"),
                "amplitude": round(p["zf"], 2) if isinstance(p.get("zf"), (int, float)) else None,
                "speed": round(p["zs"], 2) if isinstance(p.get("zs"), (int, float)) else None,
            })
        rows.append(base)
    if pool in ("zt", "dt") and rows:
        _annotate_seals(rows, "up" if pool == "zt" else "down")
    nice = f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else d
    return {
        "pool": pool,
        "date": nice,
        "total": len(raw),
        "rows": rows,
        "note": "客观公开榜单,非推荐非预测",
    }


def _annotate_seals(rows: list[dict], side: str) -> None:
    codes = [str(r.get("code") or "") for r in rows if str(r.get("code") or "").isdigit()]
    if not codes:
        return
    try:
        quotes = astock.tencent_quote(codes)
    except Exception:
        return
    for r in rows:
        q = quotes.get(str(r.get("code") or ""))
        if not q:
            r["sealed"] = None
            continue
        r["sealed"] = astock.seal_flag(q, side)
        r["bid1"] = q.get("bid1")
        r["ask1"] = q.get("ask1")
        r["bid1_vol"] = q.get("bid1_vol")
        r["ask1_vol"] = q.get("ask1_vol")


# ── Stock basic info (Eastmoney push2, no akshare) ────────────────────────

def stock_basic_info(code: str) -> dict:
    """Industry / area / concepts / shares / list date via Eastmoney push2 stock/get."""
    code = (code or "").strip()
    if not code.isdigit() or len(code) != 6:
        return {}
    secid = astock.em_secid(code)
    params = {
        "secid": secid,
        "fields": "f57,f58,f84,f85,f116,f117,f127,f128,f129,f162,f167,f173,f189",
    }
    d: dict = {}
    for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/stock/get",
                params=params,
                headers={"User-Agent": UA},
                timeout=12,
            )
            d = (r.json() or {}).get("data") or {}
            if d:
                break
        except Exception:
            continue
    if not d:
        return {}
    list_raw = d.get("f189")
    list_date = ""
    if isinstance(list_raw, (int, float)) and list_raw > 0:
        s = str(int(list_raw))
        if len(s) == 8:
            list_date = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    concepts = [x for x in str(d.get("f129") or "").split(",") if x]
    return {
        "code": d.get("f57") or code,
        "name": d.get("f58") or "",
        "industry": d.get("f127") or "",
        "area": d.get("f128") or "",
        "concepts": concepts,
        "total_shares": d.get("f84"),
        "float_shares": d.get("f85"),
        "mcap": d.get("f116"),
        "float_mcap": d.get("f117"),
        # push2 stock/get without fltt=2: PE/PB are *100 integers; ROE already percent
        "pe_ttm": round(d["f162"] / 100, 2) if isinstance(d.get("f162"), (int, float)) else None,
        "pb": round(d["f167"] / 100, 2) if isinstance(d.get("f167"), (int, float)) else None,
        "roe": float(d["f173"]) if isinstance(d.get("f173"), (int, float)) else None,
        "list_date": list_date,
    }
