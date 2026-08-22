"""Event cockpit HTTP: Polymarket probabilities. Keys under polymarket."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import polymarket
from api_common import _cached, _serve

router = APIRouter(tags=["event"])


def _pm(code: str, ttl: float, fetch, valid, empty: str):
    """Expire refetch. Upstream fail serves last fill. Gamma is overseas."""
    try:
        data = _cached("polymarket", code, ttl, fetch, valid=valid)
        if valid(data):
            return data
    except Exception as e:
        last = _serve("polymarket", code)
        if valid(last):
            return last
        raise HTTPException(502, f"{empty}: {e}") from e
    last = _serve("polymarket", code)
    if valid(last):
        return last
    return None


@router.get("/api/polymarket/board")
def polymarket_board(limit: int = Query(30, ge=5, le=50)):
    """Active events by 24h volume. Key polymarket/board, 60s."""
    data = _pm(
        "board",
        60,
        lambda: polymarket.board(limit=limit),
        polymarket.board_ok,
        "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY",
    )
    if not data:
        raise HTTPException(502, "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY")
    return {"data": data}


@router.get("/api/polymarket/event")
def polymarket_event(slug: str = Query(..., min_length=3, max_length=200)):
    """One event by slug (or polymarket.com/event/... URL). Key polymarket/event::slug, 30s."""
    s = polymarket.norm_slug(slug)
    if not s:
        raise HTTPException(400, "bad slug")
    data = _pm(
        f"event::{s}",
        30,
        lambda: polymarket.event_by_slug(s),
        polymarket.event_ok,
        "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY",
    )
    if not data:
        raise HTTPException(404, f"event not found: {s}")
    return {"data": data}


@router.get("/api/polymarket/search")
def polymarket_search(q: str = Query(..., min_length=1, max_length=120)):
    """Title search or slug/URL lookup. Key polymarket/search::q, 60s."""
    query = polymarket.norm_query(q)
    if not query:
        raise HTTPException(400, "empty query")
    data = _pm(
        f"search::{query}",
        60,
        lambda: polymarket.search(query),
        lambda d: isinstance(d, dict) and isinstance(d.get("events"), list),
        "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY",
    )
    if not data:
        raise HTTPException(502, "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY")
    return {"data": data}


@router.get("/api/polymarket/watch")
def polymarket_watch(slugs: str = Query("", max_length=4000)):
    """Watched events. Each slug reuses polymarket/event::slug, 30s."""
    parts = polymarket.parse_slugs(slugs)
    if not parts:
        return {"data": {"events": []}}
    events = []
    for s in parts:
        ev = _pm(
            f"event::{s}",
            30,
            lambda s=s: polymarket.event_by_slug(s),
            polymarket.event_ok,
            "连不上 Polymarket Gamma, 检查系统代理或 VR_POLYMARKET_PROXY",
        )
        if ev:
            events.append(ev)
    return {"data": {"events": events}}

