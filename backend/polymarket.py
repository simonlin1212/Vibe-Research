"""Polymarket Gamma board for /event.

One cache family (polymarket). Not review warmup, not quote hub.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import quote

import astock

log = logging.getLogger("polymarket")

GAMMA = "https://gamma-api.polymarket.com"
BOARD_LIMIT = 30
BOARD_MARKETS = 8
EVENT_MARKETS = 80
SEARCH_LIMIT = 20
WATCH_MAX = 20

_SLUG_IN_URL = re.compile(r"polymarket\.com/event/([a-zA-Z0-9-]+)", re.I)
_SLUG_CLEAN = re.compile(r"[^a-z0-9-]+")

Fetch = Callable[[str], Any]


def norm_slug(raw: str) -> str:
    s = (raw or "").strip()
    m = _SLUG_IN_URL.search(s)
    if m:
        s = m.group(1)
    s = _SLUG_CLEAN.sub("-", s.lower()).strip("-")
    return s[:160]


def parse_slugs(raw: str) -> list[str]:
    """Comma / whitespace / full event URLs. Cap WATCH_MAX. Order kept."""
    out: list[str] = []
    for part in re.split(r"[,;\s]+", raw or ""):
        s = norm_slug(part)
        if s and s not in out:
            out.append(s)
        if len(out) >= WATCH_MAX:
            break
    if out:
        return out
    for m in _SLUG_IN_URL.finditer(raw or ""):
        s = norm_slug(m.group(1))
        if s and s not in out:
            out.append(s)
        if len(out) >= WATCH_MAX:
            break
    return out


def norm_query(raw: str) -> str:
    s = " ".join((raw or "").split())
    if _SLUG_IN_URL.search(s) or (len(s) >= 8 and " " not in s and re.fullmatch(r"[a-zA-Z0-9-]+", s)):
        return norm_slug(s)
    return s[:80]


def board_ok(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("events"), list)


def event_ok(data: Any) -> bool:
    return isinstance(data, dict) and bool(data.get("slug"))


def _num(v: Any) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def _as_list(v: Any) -> list[Any]:
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        try:
            out = json.loads(s)
        except json.JSONDecodeError:
            return []
        return out if isinstance(out, list) else []
    return []


def _pct(v: Any) -> float | None:
    n = _num(v)
    if n is None:
        return None
    if n > 1.5:
        return max(0.0, min(100.0, n))
    return max(0.0, min(100.0, n * 100.0))


def _proxy_url(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if "://" not in s:
        return "http://" + s
    return s


def resolve_proxies(
    env: Mapping[str, str] | None = None,
    system: Mapping[str, str] | None = None,
) -> dict[str, str] | None:
    """Gamma is overseas. Env first, then Windows system proxy. Not Eastmoney direct-first."""
    e = env if env is not None else os.environ
    raw = ""
    for k in ("VR_POLYMARKET_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        raw = str(e.get(k) or "").strip()
        if raw:
            break
    if raw:
        u = _proxy_url(raw)
        return {"http": u, "https": u} if u else None
    if system is None:
        try:
            import urllib.request

            system = urllib.request.getproxies()
        except Exception:
            system = {}
    out: dict[str, str] = {}
    for k in ("https", "http"):
        u = _proxy_url(str((system or {}).get(k) or ""))
        if u:
            out[k] = u
    if out.get("https") and "http" not in out:
        out["http"] = out["https"]
    if out.get("http") and "https" not in out:
        out["https"] = out["http"]
    return out or None


def _get_json(url: str, timeout: float = 15.0) -> Any:
    import requests

    # Pass proxies= so a long-lived uvicorn still uses Windows system proxy
    # when HTTPS_PROXY is empty. Do not reuse Eastmoney direct-first.
    kwargs: dict[str, Any] = {}
    px = resolve_proxies()
    if px:
        kwargs["proxies"] = px
    r = requests.get(
        url,
        headers={
            "User-Agent": astock.UA,
            "Accept": "application/json,text/plain,*/*",
        },
        timeout=timeout,
        **kwargs,
    )
    r.raise_for_status()
    ctype = (r.headers.get("content-type") or "").lower()
    if "text/html" in ctype:
        raise ValueError("html instead of json")
    return r.json()


def parse_market(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    mid = str(raw.get("id") or "").strip()
    question = str(raw.get("question") or "").strip()
    title = str(raw.get("groupItemTitle") or "").strip() or question
    if not mid and not title:
        return None
    labels = [str(x).strip() for x in _as_list(raw.get("outcomes")) if str(x).strip()]
    prices = _as_list(raw.get("outcomePrices"))
    outcomes: list[dict[str, Any]] = []
    yes: float | None = None
    for i, label in enumerate(labels):
        pct = _pct(prices[i]) if i < len(prices) else None
        outcomes.append({"label": label, "pct": pct})
        if label.lower() in ("yes", "y") and pct is not None:
            yes = pct
    if yes is None and len(outcomes) == 2 and outcomes[0]["label"].lower() in ("yes", "y"):
        yes = outcomes[0]["pct"]
    chg = _num(raw.get("oneHourPriceChange"))
    return {
        "id": mid,
        "title": title[:160],
        "question": question[:240],
        "yes": yes,
        "outcomes": outcomes,
        "volume": _num(raw.get("volumeNum") if raw.get("volumeNum") is not None else raw.get("volume")),
        "end": str(raw.get("endDate") or raw.get("endDateIso") or "").strip() or None,
        "closed": bool(raw.get("closed")),
        "chg": (chg * 100.0) if chg is not None else None,
    }


_DOLLAR = re.compile(r"\$\s*([\d.]+)")


def _sort_markets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(m: dict[str, Any]) -> tuple:
        end = str(m.get("end") or "9999")
        dollar = _DOLLAR.search(str(m.get("title") or ""))
        if dollar:
            return (end, 0, -float(dollar.group(1)))
        return (end, 1, -(m.get("volume") or 0.0))

    return sorted(rows, key=key)


def _featured(markets: list[dict[str, Any]]) -> dict[str, Any] | None:
    open_m = [m for m in markets if not m.get("closed")]
    pool = open_m or markets
    if not pool:
        return None
    with_yes = [m for m in pool if m.get("yes") is not None]
    m = max(with_yes, key=lambda x: float(x["yes"])) if with_yes else pool[0]
    if m.get("yes") is not None:
        return {"label": m.get("title") or "Yes", "pct": m["yes"]}
    lead: dict[str, Any] | None = None
    for o in m.get("outcomes") or []:
        if not isinstance(o, dict) or o.get("pct") is None:
            continue
        if lead is None or float(o["pct"]) > float(lead["pct"]):
            lead = o
    if not lead:
        return None
    label = f"{m.get('title') or ''} {lead['label']}".strip()
    return {"label": label, "pct": lead["pct"]}


def parse_event(raw: Any, *, market_cap: int = EVENT_MARKETS) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    slug = norm_slug(str(raw.get("slug") or ""))
    title = str(raw.get("title") or "").strip()
    if not slug or not title:
        return None
    tags: list[str] = []
    for t in raw.get("tags") or []:
        if isinstance(t, dict):
            lab = str(t.get("label") or "").strip()
            if lab and lab not in tags:
                tags.append(lab)
        if len(tags) >= 4:
            break
    parsed: list[dict[str, Any]] = []
    for m in raw.get("markets") or []:
        row = parse_market(m)
        if row:
            parsed.append(row)
    parsed = _sort_markets(parsed)
    cap = max(1, min(int(market_cap), 80))
    desc = str(raw.get("description") or "").strip()
    return {
        "id": str(raw.get("id") or slug),
        "slug": slug,
        "title": title[:240],
        "description": desc[:400] or None,
        "volume": _num(raw.get("volume")),
        "volume24hr": _num(raw.get("volume24hr")),
        "liquidity": _num(raw.get("liquidity")),
        "end": str(raw.get("endDate") or "").strip() or None,
        "image": str(raw.get("image") or raw.get("icon") or "").strip() or None,
        "tags": tags,
        "featured": _featured(parsed),
        "markets": parsed[:cap],
        "n_markets": len(parsed),
    }


def board(*, fetch: Fetch | None = None, limit: int = BOARD_LIMIT) -> dict[str, Any]:
    n = max(5, min(int(limit or BOARD_LIMIT), 50))
    url = (
        f"{GAMMA}/events?limit={n}&active=true&closed=false"
        f"&archived=false&order=volume24hr&ascending=false"
    )
    raw = (fetch or _get_json)(url)
    rows = raw if isinstance(raw, list) else []
    events = []
    for it in rows:
        ev = parse_event(it, market_cap=BOARD_MARKETS)
        if ev:
            events.append(ev)
    return {"events": events, "updated": datetime.now(timezone.utc).isoformat()}


def event_by_slug(slug: str, *, fetch: Fetch | None = None) -> dict[str, Any] | None:
    s = norm_slug(slug)
    if not s:
        return None
    raw = (fetch or _get_json)(f"{GAMMA}/events?slug={s}")
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = [raw]
    else:
        return None
    for it in rows:
        ev = parse_event(it, market_cap=EVENT_MARKETS)
        if ev:
            return ev
    return None


def search(q: str, *, fetch: Fetch | None = None, limit: int = SEARCH_LIMIT) -> dict[str, Any]:
    query = norm_query(q)
    if not query:
        return {"q": "", "events": []}
    if " " not in query and re.fullmatch(r"[a-z0-9-]{8,}", query):
        ev = event_by_slug(query, fetch=fetch)
        return {"q": query, "events": [ev] if ev else []}
    raw = (fetch or _get_json)(f"{GAMMA}/public-search?q={quote(query, safe='')}")
    rows: list[Any] = []
    if isinstance(raw, dict):
        evs = raw.get("events")
        if isinstance(evs, list):
            rows = evs
    elif isinstance(raw, list):
        rows = raw
    n = max(5, min(int(limit or SEARCH_LIMIT), 40))
    events = []
    for it in rows[:n]:
        ev = parse_event(it, market_cap=BOARD_MARKETS)
        if ev:
            events.append(ev)
    return {"q": query, "events": events}
