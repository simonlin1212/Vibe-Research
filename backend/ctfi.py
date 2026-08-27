"""Shanghai Shipping Exchange CTFI (China import crude tanker freight).

Latest composite from the official single-index page.
Not an index-catalog or quote-hub feed. Daily print, last-good cache.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import astock

log = logging.getLogger("ctfi")

PAGE = "https://www.sse.net.cn/index/singleIndex?indexType=ctfi"
IMG = "https://www.sse.net.cn/index/indexImg?name=ctfi&type=query"
TTL = 4 * 3600
_PNG = b"\x89PNG\r\n\x1a\n"

_COMPOSITE = re.compile(
    r"<td>\s*综合指数\s*</td>\s*"
    r"<td></td>\s*<td></td>\s*"
    r"<td[^>]*>\s*点\s*</td>\s*"
    r"<td[^>]*>\s*100%\s*</td>\s*"
    r"<td[^>]*>\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*</td>\s*"
    r"<td[^>]*>\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*</td>",
    re.I,
)
_DATE = re.compile(
    r"CHINA IMPORT CRUDE OIL TANKER FREIGHT INDEX[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})",
    re.I,
)
_ROUTE = re.compile(
    r"\((CT[124])\)[\s\S]{0,280}?<td[^>]*>\s*点\s*</td>[\s\S]{0,80}?"
    r"<td[^>]*>\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*</td>",
    re.I,
)


def _num(v: Any) -> float | None:
    try:
        n = float(str(v).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def latest_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    return _num(data.get("price")) is not None


def parse_page(html: str) -> dict[str, Any]:
    """Pull composite + date + CT1/CT2 points from the official HTML table."""
    if not html or "综合指数" not in html:
        raise ValueError("ctfi page missing composite")
    row = _COMPOSITE.search(html)
    if not row:
        raise ValueError("ctfi composite row not parsed")
    price = _num(row.group(1))
    chg = _num(row.group(2))
    if price is None:
        raise ValueError("ctfi composite not a number")
    prev = price - chg if chg is not None else None
    pct = None
    if prev and prev != 0 and chg is not None:
        pct = round(chg / prev * 100.0, 2)
    dm = _DATE.search(html)
    routes: dict[str, float] = {}
    for m in _ROUTE.finditer(html):
        n = _num(m.group(2))
        if n is not None:
            routes[m.group(1).upper()] = n
    extra = " ".join(f"{k} {v:g}" for k, v in (("CT1", routes.get("CT1")), ("CT2", routes.get("CT2"))) if v is not None)
    return {
        "date": dm.group(1) if dm else None,
        "price": price,
        "chg": chg,
        "pct": pct,
        "routes": routes,
        "extra": extra or None,
        "source": "sse.net.cn",
        "url": PAGE,
    }


def fetch_page(timeout: int = 15) -> str:
    import requests

    r = requests.get(
        PAGE,
        headers={"User-Agent": astock.UA, "Accept": "text/html", "Referer": "https://www.sse.net.cn/"},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.text or ""


def latest(fetch=fetch_page) -> dict[str, Any]:
    return parse_page(fetch())


def img_ok(data: Any) -> bool:
    return isinstance(data, (bytes, bytearray)) and len(data) > 200 and bytes(data[:8]) == _PNG


def fetch_img(timeout: int = 15) -> bytes:
    import requests

    r = requests.get(
        IMG,
        headers={
            "User-Agent": astock.UA,
            "Accept": "image/png,image/*",
            "Referer": PAGE,
        },
        timeout=timeout,
    )
    r.raise_for_status()
    raw = r.content or b""
    if not img_ok(raw):
        raise ValueError("ctfi img not png")
    return bytes(raw)
