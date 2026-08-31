"""Macro page extras: money-market, monthly CN prints, US 10Y / DXY.

One cache key `macro_board`. Not index-catalog, not quote-hub, not warmup.
USD/CNY stays on the quote hub (whUSDCNY already in the catalog).
"""
from __future__ import annotations

import csv
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

import astock

log = logging.getLogger("macro_board")

TTL = 600
UA = astock.UA
CM_SHIBOR = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-shibor/ShiborHis"
CM_FRR = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/FrrHis"
MOFCOM_SFIN = "https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery"
FRED_DGS10 = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"
EM_ULIST = "https://push2delay.eastmoney.com/api/qt/ulist.np/get"


def _num(v: Any) -> float | None:
    if v is None:
        return None
    s = str(v).replace(",", "").replace("%", "").strip()
    if not s or s in (".", "-", "--", "—"):
        return None
    try:
        n = float(s)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def _date10(v: Any) -> str:
    s = astock._norm_date(v)
    return s if s and len(s) >= 8 else ""


def _item(key: str, name: str, value: float | None, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {"key": key, "name": name, "value": value}
    row.update(extra)
    return row


def board_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    for bucket in (data.get("money"), data.get("month"), data.get("us")):
        items = bucket.get("items") if isinstance(bucket, dict) else None
        if not isinstance(items, list):
            continue
        if any(isinstance(it, dict) and _num(it.get("value")) is not None for it in items):
            return True
    return False


def parse_shibor(records: list[Any]) -> dict[str, Any]:
    """Latest chinamoney ShiborHis row -> ON / 1W / 3M."""
    rows = [r for r in records if isinstance(r, dict)]
    rows.sort(key=lambda r: _date10(r.get("showDateCN") or r.get("showDateEN")), reverse=True)
    out: dict[str, Any] = {"date": "", "items": []}
    if not rows:
        return out
    row = rows[0]
    dt = _date10(row.get("showDateCN") or row.get("showDateEN"))
    out["date"] = dt
    mapping = (("shibor_on", "SHIBOR ON", "ON"), ("shibor_1w", "SHIBOR 1W", "1W"), ("shibor_3m", "SHIBOR 3M", "3M"))
    out["items"] = [
        _item(key, name, _num(row.get(col)), date=dt, unit="%", source="chinamoney")
        for key, name, col in mapping
    ]
    return out


def parse_frr(records: list[Any]) -> dict[str, Any]:
    """Latest FrrHis row. FDR007 is the deposit-institution 7d fixing (DR007 定盘)."""
    rows = [r for r in records if isinstance(r, dict)]
    dated: list[tuple[str, dict]] = []
    for r in rows:
        raw_map = r.get("frValueMap")
        one_map: dict[str, Any] = raw_map if isinstance(raw_map, dict) else {}
        dt = _date10(one_map.get("date") or r.get("lfiProducDate") or r.get("lfiProducDateEn"))
        if dt:
            dated.append((dt, r))
    dated.sort(key=lambda x: x[0], reverse=True)
    out: dict[str, Any] = {"date": "", "items": []}
    if not dated:
        return out
    dt, row = dated[0]
    latest_map = row.get("frValueMap")
    fmap: dict[str, Any] = latest_map if isinstance(latest_map, dict) else {}
    out["date"] = dt
    out["items"] = [
        _item(
            "dr007",
            "DR007",
            _num(fmap.get("FDR007")),
            date=dt,
            unit="%",
            label="银银间7天定盘 FDR007",
            source="chinamoney",
        ),
        _item(
            "fr007",
            "FR007",
            _num(fmap.get("FR007")),
            date=dt,
            unit="%",
            label="银行间7天定盘",
            source="chinamoney",
        ),
    ]
    return out


def parse_cpi(row: dict[str, Any]) -> dict[str, Any]:
    return _item(
        "cpi",
        "CPI",
        _num(row.get("NATIONAL_SAME")),
        period=str(row.get("TIME") or "")[:20],
        date=_date10(row.get("REPORT_DATE")),
        unit="%",
        kind="yoy",
        source="eastmoney",
    )


def parse_ppi(row: dict[str, Any]) -> dict[str, Any]:
    return _item(
        "ppi",
        "PPI",
        _num(row.get("BASE_SAME")),
        period=str(row.get("TIME") or "")[:20],
        date=_date10(row.get("REPORT_DATE")),
        unit="%",
        kind="yoy",
        source="eastmoney",
    )


def parse_pmi(row: dict[str, Any]) -> dict[str, Any]:
    return _item(
        "pmi",
        "制造业PMI",
        _num(row.get("MAKE_INDEX")),
        period=str(row.get("TIME") or "")[:20],
        date=_date10(row.get("REPORT_DATE")),
        unit="",
        kind="index",
        source="eastmoney",
    )


def parse_m2(row: dict[str, Any]) -> dict[str, Any]:
    return _item(
        "m2",
        "M2",
        _num(row.get("BASIC_CURRENCY_SAME")),
        period=str(row.get("TIME") or "")[:20],
        date=_date10(row.get("REPORT_DATE")),
        unit="%",
        kind="yoy",
        stock=_num(row.get("BASIC_CURRENCY")),
        source="eastmoney",
    )


def parse_sfin(rows: list[Any]) -> dict[str, Any]:
    """mofcom social-financing increment. date YYYYMM, tiosfs = 增量 (yi)."""
    dated: list[tuple[str, dict]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        raw = str(r.get("date") or "").strip()
        if len(raw) == 6 and raw.isdigit():
            period = f"{raw[:4]}-{raw[4:]}"
        elif len(raw) >= 7:
            period = raw[:7]
        else:
            continue
        dated.append((period, r))
    dated.sort(key=lambda x: x[0], reverse=True)
    if not dated:
        return _item("sfin", "社融增量", None, unit="亿", kind="flow", source="mofcom")
    period, row = dated[0]
    return _item(
        "sfin",
        "社融增量",
        _num(row.get("tiosfs")),
        period=period,
        date=period,
        unit="亿",
        kind="flow",
        loan=_num(row.get("rmblaon")),
        source="mofcom",
    )


def parse_fred_csv(text: str, key: str = "us10y", name: str = "美债10Y") -> dict[str, Any]:
    """Last non-empty FRED observation (DGS10 = US 10Y yield)."""
    empty = _item(key, name, None, unit="%", source="FRED DGS10")
    if not text or "DGS10" not in text[:120]:
        return empty
    reader = csv.DictReader(io.StringIO(text))
    last_dt = ""
    last_val: float | None = None
    for row in reader:
        vals = list(row.values())
        raw = row.get("DGS10") or row.get("value") or (vals[-1] if vals else None)
        val = _num(raw)
        if val is None:
            continue
        last_dt = _date10(row.get("observation_date") or row.get("DATE") or row.get("date"))
        last_val = val
    if last_val is None:
        return empty
    return _item(key, name, last_val, date=last_dt, unit="%", source="FRED DGS10")


def parse_em_ulist(diff: list[Any], code: str, key: str, name: str) -> dict[str, Any]:
    """Eastmoney push2 ulist row (100.UDI dollar index)."""
    empty = _item(key, name, None, source="eastmoney")
    want = code.split(".", 1)[-1].upper()
    for row in diff:
        if not isinstance(row, dict):
            continue
        if str(row.get("f12") or "").upper() != want:
            continue
        price = _num(row.get("f2"))
        if price is None:
            return empty
        return _item(
            key,
            str(row.get("f14") or name),
            price,
            pct=_num(row.get("f3")),
            change=_num(row.get("f4")),
            prev=_num(row.get("f18")),
            source="eastmoney 100.UDI",
        )
    return empty


def _cm_post(url: str, referer: str, payload: dict[str, Any]) -> list[Any]:
    import requests

    r = requests.post(
        url,
        json=payload,
        headers={
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Referer": referer,
        },
        timeout=15,
    )
    r.raise_for_status()
    payload_j = r.json()
    recs = payload_j.get("records") or payload_j.get("data") or []
    return recs if isinstance(recs, list) else []


def _month_window() -> tuple[str, str]:
    end = date.today()
    start = end - timedelta(days=40)
    return start.isoformat(), end.isoformat()


def _this_month() -> tuple[str, str]:
    end = date.today()
    return end.replace(day=1).isoformat(), end.isoformat()


def _fetch_shibor() -> dict[str, Any]:
    start, end = _month_window()
    recs = _cm_post(
        CM_SHIBOR,
        "https://www.chinamoney.com.cn/chinese/bkshibor/",
        {"lang": "CN", "startDate": start, "endDate": end},
    )
    return parse_shibor(recs)


def _fetch_frr() -> dict[str, Any]:
    start, end = _this_month()
    recs = _cm_post(
        CM_FRR,
        "https://www.chinamoney.com.cn/chinese/bkfrr/",
        {"lang": "CN", "startDate": start, "endDate": end},
    )
    out = parse_frr(recs)
    if out.get("items") and any(_num(it.get("value")) is not None for it in out["items"]):
        return out
    prev_end = date.today().replace(day=1) - timedelta(days=1)
    prev_start = prev_end.replace(day=1)
    recs = _cm_post(
        CM_FRR,
        "https://www.chinamoney.com.cn/chinese/bkfrr/",
        {"lang": "CN", "startDate": prev_start.isoformat(), "endDate": prev_end.isoformat()},
    )
    return parse_frr(recs)


def _fetch_month_row(report: str, parse) -> dict[str, Any]:
    rows = astock.eastmoney_datacenter(report, page_size=2, sort_columns="REPORT_DATE", sort_types="-1")
    if not rows:
        return parse({})
    return parse(rows[0])


def _fetch_sfin() -> dict[str, Any]:
    import requests

    r = requests.post(MOFCOM_SFIN, headers={"User-Agent": UA}, timeout=15)
    r.raise_for_status()
    data = r.json()
    rows = data if isinstance(data, list) else []
    return parse_sfin(rows)


def _fetch_us10() -> dict[str, Any]:
    import requests

    r = requests.get(FRED_DGS10, headers={"User-Agent": UA}, timeout=15)
    r.raise_for_status()
    return parse_fred_csv(r.text)


def _fetch_dxy() -> dict[str, Any]:
    d = astock.em_get(
        EM_ULIST,
        params={
            "fltt": "2",
            "invt": "2",
            "secids": "100.UDI",
            "fields": "f2,f3,f4,f12,f14,f18",
        },
        timeout=10,
    ).json()
    diff = ((d.get("data") or {}).get("diff")) or []
    return parse_em_ulist(diff if isinstance(diff, list) else [], "100.UDI", "dxy", "美元指数")


def _safe(name: str, fn):
    try:
        return fn()
    except Exception as e:
        log.info("%s failed: %s", name, e)
        return None


def _merge_money(shibor: dict | None, frr: dict | None) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    date_s = ""
    if isinstance(frr, dict):
        date_s = str(frr.get("date") or "")
        items.extend(it for it in (frr.get("items") or []) if isinstance(it, dict))
    if isinstance(shibor, dict):
        date_s = date_s or str(shibor.get("date") or "")
        items.extend(it for it in (shibor.get("items") or []) if isinstance(it, dict))
    return {"date": date_s, "source": "chinamoney.com.cn", "items": items}


def board() -> dict[str, Any]:
    """One snapshot for /macro extra grids. Missing rows stay with value=None."""
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_shibor = pool.submit(_safe, "shibor", _fetch_shibor)
        f_frr = pool.submit(_safe, "frr", _fetch_frr)
        f_cpi = pool.submit(_safe, "cpi", lambda: _fetch_month_row("RPT_ECONOMY_CPI", parse_cpi))
        f_ppi = pool.submit(_safe, "ppi", lambda: _fetch_month_row("RPT_ECONOMY_PPI", parse_ppi))
        f_pmi = pool.submit(_safe, "pmi", lambda: _fetch_month_row("RPT_ECONOMY_PMI", parse_pmi))
        f_m2 = pool.submit(_safe, "m2", lambda: _fetch_month_row("RPT_ECONOMY_CURRENCY_SUPPLY", parse_m2))
        f_sfin = pool.submit(_safe, "sfin", _fetch_sfin)
        f_us10 = pool.submit(_safe, "us10", _fetch_us10)
        f_dxy = pool.submit(_safe, "dxy", _fetch_dxy)
        shibor = f_shibor.result()
        frr = f_frr.result()
        month_items = [f_cpi.result(), f_ppi.result(), f_pmi.result(), f_sfin.result(), f_m2.result()]
        us_items = [f_us10.result(), f_dxy.result()]

    return {
        "money": _merge_money(shibor if isinstance(shibor, dict) else None, frr if isinstance(frr, dict) else None),
        "month": {
            "source": "eastmoney / mofcom",
            "items": [it for it in month_items if isinstance(it, dict)],
        },
        "us": {
            "source": "FRED / eastmoney",
            "items": [it for it in us_items if isinstance(it, dict)],
        },
    }
