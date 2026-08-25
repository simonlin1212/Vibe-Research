"""9qihuo exchange fee table: per-month margin and contract multiplier.

Parked uses exchange-standard % (not broker add-on, not fees).
Multiplier = lot_margin / (price * margin). Same page, no local SPEC.
One cache family (qihuo_fee). Not review warmup, not quote hub.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Callable

import astock
import requests
from cache import TTLCache

log = logging.getLogger("qihuo_fee")

URL = "https://www.9qihuo.com/qihuoshouxufei"
SRC = URL

_CODE = re.compile(r"<b>([A-Za-z]{1,3})(\d{3,4})</b>", re.I)
_LONG = re.compile(r"title=['\"]多头保证金比例['\"]\s*>\s*(\d+(?:\.\d+)?)\s*%", re.I)
_PX = re.compile(r"title=['\"]当前价格[^'\"]*['\"]\s*>\s*([0-9,.]+)", re.I)
_LOT = re.compile(r"title=['\"]每手保证金['\"]\s*>\s*([0-9,.]+)\s*元", re.I)

Fetch = Callable[[], str]

_CACHE = TTLCache(maxsize=4, default_ttl=300, negative_ttl=0, name="qihuo_fee")


def to_yyyymm(digits: str, now_year: int | None = None) -> str | None:
    """au2610 -> 202610; CZCE TA609 -> 202609 (YMM, pivot around now_year)."""
    raw = (digits or "").strip()
    if not raw.isdigit():
        return None
    year = now_year if now_year is not None else datetime.now().year
    if len(raw) == 4:
        yy, mm = int(raw[:2]), int(raw[2:])
        if not 1 <= mm <= 12:
            return None
        return f"{2000 + yy:04d}{mm:02d}"
    if len(raw) == 3:
        y, mm = int(raw[0]), int(raw[1:])
        if not 1 <= mm <= 12:
            return None
        cands = (2010 + y, 2020 + y, 2030 + y)
        pick = min(cands, key=lambda n: abs(n - year))
        if pick < year - 1:
            pick += 10
        return f"{pick:04d}{mm:02d}"
    return None


def table_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    months = data.get("months")
    return isinstance(months, dict) and bool(months)


def _num(raw: str) -> float | None:
    try:
        n = float((raw or "").replace(",", ""))
    except ValueError:
        return None
    if n != n or n <= 0:
        return None
    return n


def infer_mult(px: float, rate: float, lot: float) -> int | None:
    """Contract size from 每手保证金 = price * mult * margin."""
    if px <= 0 or rate <= 0 or lot <= 0:
        return None
    raw = lot / (px * rate)
    n = int(round(raw))
    if n < 1:
        return None
    if abs(raw - n) > max(0.08, 0.03 * n):
        return None
    return n


def _mode_int(vals: list[int]) -> int | None:
    if not vals:
        return None
    return max(set(vals), key=vals.count)


def parse_table(html: str, now_year: int | None = None) -> dict[str, Any]:
    """Per-month margin + per-und multiplier from the same row."""
    text = html or ""
    months: dict[str, dict[str, float]] = {}
    main: dict[str, str] = {}
    mult_hits: dict[str, list[int]] = {}
    matches = list(_CODE.finditer(text))
    for i, m in enumerate(matches):
        und = m.group(1).upper()
        yyyymm = to_yyyymm(m.group(2), now_year)
        if not yyyymm:
            continue
        stop = matches[i + 1].start() if i + 1 < len(matches) else m.end() + 1400
        chunk = text[m.end() : min(stop, m.end() + 1400)]
        pct = _LONG.search(chunk)
        if not pct:
            continue
        rate = float(pct.group(1)) / 100.0
        if rate <= 0 or rate >= 1:
            continue
        months.setdefault(und, {})[yyyymm] = rate
        if "主力合约" in chunk:
            main[und] = yyyymm
        px_m = _PX.search(chunk)
        lot_m = _LOT.search(chunk)
        if px_m and lot_m:
            px = _num(px_m.group(1))
            lot = _num(lot_m.group(1))
            if px is not None and lot is not None:
                n = infer_mult(px, rate, lot)
                if n is not None:
                    mult_hits.setdefault(und, []).append(n)
    n = sum(len(v) for v in months.values())
    mults = {u: m for u, hits in mult_hits.items() if (m := _mode_int(hits))}
    return {"src": SRC, "months": months, "main": main, "mults": mults, "n": n}


def _pull() -> str:
    r = requests.get(
        URL,
        headers={"User-Agent": astock.UA, "Referer": "https://www.9qihuo.com/"},
        timeout=30,
    )
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _build(fetch: Fetch | None) -> dict[str, Any]:
    return parse_table((fetch or _pull)())


def margins(*, fetch: Fetch | None = None) -> dict[str, Any]:
    """Parsed table. Tests inject fetch(). Live: key table, 300s, last-good on fail."""
    if fetch is not None:
        return _build(fetch)
    try:
        return _CACHE.get_or_set("table", lambda: _build(None), ttl=300, valid=table_ok)
    except Exception:
        last = _CACHE.get_last("table")
        if last is not None and table_ok(last):
            log.warning("qihuo_fee upstream failed, serve last-good")
            return last
        log.warning("qihuo_fee empty, parked skips live spec")
        return {"src": SRC, "months": {}, "main": {}, "mults": {}, "n": 0}


def month_margins(und: str, tab: dict[str, Any] | None = None) -> dict[str, float]:
    data = tab if tab is not None else margins()
    raw = data.get("months", {}).get((und or "").strip().upper()) if table_ok(data) else None
    return dict(raw) if isinstance(raw, dict) else {}


def und_margin(und: str, tab: dict[str, Any] | None = None) -> float | None:
    """Main-contract rate, else median of listed months."""
    data = tab if tab is not None else margins()
    u = (und or "").strip().upper()
    mm = month_margins(u, data)
    if not mm:
        return None
    main = (data.get("main") or {}).get(u)
    if isinstance(main, str) and main in mm:
        return mm[main]
    vals = sorted(mm.values())
    return vals[len(vals) // 2]


def und_mult(und: str, tab: dict[str, Any] | None = None) -> int | None:
    data = tab if tab is not None else margins()
    raw = data.get("mults", {}).get((und or "").strip().upper()) if table_ok(data) else None
    if isinstance(raw, int) and raw > 0:
        return raw
    try:
        n = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None
