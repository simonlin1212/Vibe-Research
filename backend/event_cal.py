"""Event-page calendar. Same feed as jiuyan.033533.online (duanxianxia timeline).

One cache family (event_cal). Not review warmup, not quote hub, not telegraph.
"""
from __future__ import annotations

import html as html_lib
import logging
import re
from typing import Any, Callable

import astock
import requests

log = logging.getLogger("event_cal")

URL = "https://www.duanxianxia.com/api/getHotNewsByType"
SRC = "https://jiuyan.033533.online/"

_HEAD = re.compile(r"<div class=['\"]panel-heading[^>]*>", re.I)
_DATE = re.compile(r"^\s*(\d{4}-\d{2}-\d{2})")
_ITEM = re.compile(r"<li class=['\"]list-group-item[^'\"]*['\"][^>]*>(.*?)</li>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")

Fetch = Callable[[], Any]


def parse_timeline_html(raw: str) -> list[dict[str, str]]:
    """Date + text rows. Same split as the public page's parseTimelineHTML."""
    text = raw or ""
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for chunk in _HEAD.split(text)[1:]:
        m = _DATE.match(chunk)
        if not m:
            continue
        day = m.group(1)
        for bit in _ITEM.findall(chunk):
            item = html_lib.unescape(_TAG.sub("", bit)).strip()
            if not item:
                continue
            key = (day, item)
            if key in seen:
                continue
            seen.add(key)
            out.append({"date": day, "text": item})
    out.sort(key=lambda r: (r["date"], r["text"]))
    return out


def group_days(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    by: dict[str, list[str]] = {}
    for r in rows:
        by.setdefault(r["date"], []).append(r["text"])
    return [{"date": d, "items": by[d]} for d in sorted(by)]


def calendar_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("days"), list)


def _post() -> Any:
    r = requests.post(
        URL,
        data="type=timeline",
        headers={
            "User-Agent": astock.UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "https://www.duanxianxia.com/",
        },
        timeout=12,
    )
    r.raise_for_status()
    return r.json()


def calendar(fetch: Fetch | None = None) -> dict[str, Any]:
    raw = (fetch or _post)()
    html = ""
    if isinstance(raw, dict) and raw.get("result") in (None, "success"):
        html = str(raw.get("html") or "")
    elif isinstance(raw, str):
        html = raw
    rows = parse_timeline_html(html)
    days = group_days(rows)
    return {"days": days, "count": sum(len(d["items"]) for d in days), "src": SRC}
