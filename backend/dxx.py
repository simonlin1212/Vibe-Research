"""Duanxianxia public board. One cache family (dxx). Not review warmup, not quote hub.

Upstream fields (QX etc.) are their numbers. We only parse and show, no score of our own.
"""
from __future__ import annotations

import html as html_lib
import logging
import re
from typing import Any, Callable

import astock
import requests

log = logging.getLogger("dxx")

HOST = "https://www.duanxianxia.com"
SRC = f"{HOST}/"
HIST_N = 60
WAJUE_N = 80

QX_LABELS = {
    "QX": "情绪",
    "KQXY": "亏钱效应",
    "LBGD": "连板高度",
    "CIGAO": "次高",
    "CYBGD": "创业板高度",
    "ZT": "涨停",
    "DT": "跌停",
    "SZ": "上涨",
    "XD": "下跌",
    "FB": "封板率",
    "ths_qx": "同花顺情绪",
    "PB": "炸板",
    "ZTBX": "昨涨停表现",
    "LBBX": "昨连板表现",
    "PBBX": "昨炸板表现",
    "LB": "连板家数",
    "HSLN": "换手量能",
    "ZHULI": "主力",
    "ZTLN": "涨停量能",
    "ZBLN": "炸板量能",
    "ZRLN": "昨日量能",
}

Fetch = Callable[[str], Any]

_TD = re.compile(r"<td[^>]*\bcode=['\"](\d{6})['\"][^>]*>(.*?)</td>", re.I | re.S)
_NAME = re.compile(r"<b>([^<]+)", re.I)
_P = re.compile(r"<p>(.*?)</p>", re.I | re.S)
_SPAN = re.compile(r"<span>(.*?)</span>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")
_YIZHI = re.compile(r"一字[:：]\s*(\d+)")
_SEAL = re.compile(r"封单[:：]\s*([^<|]+)")
_FP_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})\s*涨停复盘")
_FP_QX = re.compile(r"情绪指标[:：]\s*([\d.]+)")
_FP_ZT = re.compile(r"涨停家数[:：]\s*(\d+)")
_FP_DT = re.compile(r"跌停家数[:：]\s*(\d+)")
_FP_FB = re.compile(r"封板率[:：]\s*([\d.]+)%?")
_FP_ZTBX = re.compile(r"涨停表现[:：]\s*([-\d.]+)%?")
_FP_LBBX = re.compile(r"连板表现[:：]\s*([-\d.]+)%?")


def _plain(raw: str) -> str:
    return html_lib.unescape(_TAG.sub("", raw or "")).strip()


def _sfloat(v: Any) -> float | None:
    if v is None or v == "" or v == "none":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return n


def _sint(v: Any) -> int | None:
    n = _sfloat(v)
    if n is None:
        return None
    return int(n)


def _code6(v: Any) -> str:
    s = str(v or "").strip()
    if s.isdigit() and len(s) <= 6:
        return s.zfill(6)
    return s


def _nums(seq: Any, n: int = 0) -> list[float]:
    out: list[float] = []
    if not isinstance(seq, list):
        return out
    for x in seq:
        v = _sfloat(x)
        if v is None:
            continue
        out.append(v)
    return out[-n:] if n else out


def _last_map(series: dict[str, Any], n: int = 0) -> dict[str, Any]:
    last: dict[str, float] = {}
    hist: dict[str, list[float]] = {}
    for k, seq in series.items():
        vals = _nums(seq, n)
        if not vals:
            continue
        hist[k] = vals
        last[k] = vals[-1]
    return {"last": last, "series": hist, "labels": {k: QX_LABELS.get(k, k) for k in hist}}


def parse_fengdan(raw: Any) -> dict[str, Any]:
    """9:15/9:20/9:25 seal snapshots. HTML table -> rows."""
    days: list[dict[str, Any]] = []
    if not isinstance(raw, dict):
        return {"days": days}
    for date in sorted(raw, reverse=True):
        block = raw.get(date)
        if not isinstance(block, dict):
            continue
        th = str(block.get("th") or "")
        ym = _YIZHI.search(th)
        yizhi = _sint(ym.group(1)) if ym else None
        seal_m = _SEAL.search(th)
        rows: list[dict[str, Any]] = []
        for code, bit in _TD.findall(str(block.get("table") or "")):
            name_m = _NAME.search(bit)
            spans = [_plain(s) for s in _SPAN.findall(bit)]
            tags = [_plain(p) for p in _P.findall(bit) if _plain(p)]
            rows.append({
                "code": code,
                "name": _plain(name_m.group(1)) if name_m else code,
                "tags": tags,
                "a15": spans[0] if len(spans) > 0 else "",
                "a20": spans[1] if len(spans) > 1 else "",
                "a25": spans[2] if len(spans) > 2 else "",
            })
        days.append({
            "date": str(date),
            "yizhi": yizhi,
            "seal": _plain(seal_m.group(1)) if seal_m else "",
            "t15": str(block.get("t15") or ""),
            "t20": str(block.get("t20") or ""),
            "t25": str(block.get("t25") or ""),
            "rows": rows,
        })
    return {"days": days}


def parse_daban(raw: Any) -> dict[str, Any]:
    """GET /api/getDabanData list rows. Field order from live sample."""
    rows: list[dict[str, Any]] = []
    items = raw.get("list") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return {"rows": rows}
    for it in items:
        if not isinstance(it, list) or len(it) < 4:
            continue
        concepts = str(it[11]) if len(it) > 11 and it[11] not in (None, "none") else ""
        board = str(it[16]) if len(it) > 16 and it[16] not in (None, "none") else ""
        rows.append({
            "code": _code6(it[0]),
            "name": str(it[1] or ""),
            "price": _sfloat(it[2]),
            "pct": _sfloat(it[3]),
            "amount": _sfloat(it[4]),
            "jj_pct": _sfloat(it[5]) if len(it) > 5 else None,
            "jj_amt": _sfloat(it[6]) if len(it) > 6 else None,
            "turn": _sfloat(it[7]) if len(it) > 7 else None,
            "concepts": concepts,
            "mcap": _sfloat(it[12]) if len(it) > 12 else None,
            "net": _sfloat(it[15]) if len(it) > 15 else None,
            "board": board,
        })
    return {"rows": rows}


def parse_ztlive(raw: Any) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    items = raw.get("list") if isinstance(raw, dict) else None
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            code = _code6(it.get("code"))
            if not code:
                continue
            rows.append({
                "code": code,
                "name": str(it.get("name") or ""),
                "reason": str(it.get("ztyy") or ""),
                "board": str(it.get("zt") or ""),
                "time": str(it.get("time") or ""),
            })
    count = _sint(raw.get("count") if isinstance(raw, dict) else None)
    return {"count": count if count is not None else len(rows), "rows": rows}


def parse_qingxu(raw: Any, n: int = HIST_N) -> dict[str, Any]:
    series = raw.get("series") if isinstance(raw, dict) else None
    if isinstance(series, dict):
        return _last_map(series, n)
    return {"last": {}, "series": {}, "labels": {}}


def parse_qxlive(raw: Any) -> dict[str, Any]:
    block = raw.get("qxlast") if isinstance(raw, dict) else None
    if isinstance(block, dict):
        return _last_map(block, 0)
    return {"last": {}, "series": {}, "labels": {}}


def parse_strong(raw: Any, n: int = HIST_N) -> dict[str, Any]:
    legend = [str(x) for x in (raw.get("legend") or [])] if isinstance(raw, dict) else []
    series_out: list[dict[str, Any]] = []
    last: dict[str, float] = {}
    items = raw.get("series") if isinstance(raw, dict) else None
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or "")
            vals = _nums(it.get("data"), n)
            if not name or not vals:
                continue
            series_out.append({"name": name, "data": vals})
            last[name] = vals[-1]
    return {"legend": legend, "last": last, "series": series_out}


def parse_fupan(raw: Any) -> dict[str, Any]:
    html = ""
    if isinstance(raw, dict):
        html = str(raw.get("htmlcopy") or raw.get("html") or "")
    text = _plain(html.replace("<br>", "\n").replace("<br/>", "\n"))
    date_m = _FP_DATE.search(html) or _FP_DATE.search(text)
    def _g(rx: re.Pattern[str]) -> float | None:
        m = rx.search(html) or rx.search(text)
        return _sfloat(m.group(1)) if m else None
    return {
        "date": date_m.group(1) if date_m else "",
        "qx": _g(_FP_QX),
        "zt": _sint(_g(_FP_ZT)),
        "dt": _sint(_g(_FP_DT)),
        "seal_rate": _g(_FP_FB),
        "zt_ret": _g(_FP_ZTBX),
        "lb_ret": _g(_FP_LBBX),
    }


def _name_map() -> dict[str, str]:
    try:
        import universe
        return universe.name_map()
    except Exception:
        return {}


def parse_wajue(raw: Any, names: dict[str, str] | None = None) -> dict[str, Any]:
    match = raw.get("match") if isinstance(raw, dict) else None
    if not isinstance(match, dict):
        return {"rows": []}
    nm = names if names is not None else _name_map()
    ranked = sorted(
        ((_code6(k), _sint(v) or 0) for k, v in match.items()),
        key=lambda kv: kv[1],
        reverse=True,
    )
    rows = [{"code": c, "name": nm.get(c, c), "hits": h} for c, h in ranked[:WAJUE_N] if c]
    return {"rows": rows}


def fengdan_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("days"), list) and bool(data["days"])


def daban_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("rows"), list) and bool(data["rows"])


def ztlive_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("rows"), list) and bool(data["rows"])


def curve_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("last"), dict) and bool(data["last"])


def strong_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("series"), list) and bool(data["series"])


def fupan_ok(data: Any) -> bool:
    return isinstance(data, dict) and (data.get("date") or data.get("zt") is not None)


def wajue_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("rows"), list) and bool(data["rows"])


def board_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    return any((
        fengdan_ok(data.get("fengdan")),
        daban_ok(data.get("daban")),
        ztlive_ok(data.get("ztlive")),
        curve_ok(data.get("qingxu")),
        curve_ok(data.get("qxlive")),
        strong_ok(data.get("strong")),
        fupan_ok(data.get("fupan")),
        wajue_ok(data.get("wajue")),
    ))


def _pull(path: str, fetch: Fetch | None = None) -> Any:
    if fetch is not None:
        return fetch(path)
    r = requests.get(
        HOST + path,
        headers={"User-Agent": astock.UA, "Referer": SRC},
        timeout=12,
    )
    r.raise_for_status()
    return r.json()


def board(fetch: Fetch | None = None) -> dict[str, Any]:
    """Parse all no-login feeds. Tests inject fetch(path)."""
    return {
        "src": SRC,
        "fengdan": parse_fengdan(_pull("/api/getFengdanLast", fetch)),
        "daban": parse_daban(_pull("/api/getDabanData", fetch)),
        "ztlive": parse_ztlive(_pull("/api/getZtliveData", fetch)),
        "qingxu": parse_qingxu(_pull("/api/getChartByQingxu", fetch)),
        "qxlive": parse_qxlive(_pull("/api/getLastQxlive", fetch)),
        "strong": parse_strong(_pull("/api/getLiveByStrong", fetch)),
        "fupan": parse_fupan(_pull("/api/getFupanByYidong", fetch)),
        "wajue": parse_wajue(_pull("/api/getWajueMatch", fetch)),
    }
