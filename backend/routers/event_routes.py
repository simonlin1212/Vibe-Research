"""Event cockpit HTTP: calendar + hot ranks. Keys event_cal / event_rank."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException

import event_cal
import event_rank
from api_common import _cached, _serve

router = APIRouter(tags=["event"])


def _part(family: str, code: str, ttl: float, fetch, valid, empty: str):
    """Expire refetch. Upstream fail serves last fill."""
    try:
        data = _cached(family, code, ttl, fetch, valid=valid)
        if valid(data):
            return data
    except Exception as e:
        last = _serve(family, code)
        if valid(last):
            return last
        raise HTTPException(502, f"{empty}: {e}") from e
    last = _serve(family, code)
    if valid(last):
        return last
    return None


def _cal(code: str, ttl: float, fetch, valid, empty: str):
    """Calendar. One key event_cal. Not telegraph."""
    return _part("event_cal", code, ttl, fetch, valid, empty)


@router.get("/api/event/calendar")
def event_calendar():
    """Date list from duanxianxia timeline. Key event_cal/timeline, 300s."""
    data = _cal(
        "timeline",
        300,
        event_cal.calendar,
        event_cal.calendar_ok,
        "连不上财经日历",
    )
    if not data:
        raise HTTPException(502, "连不上财经日历")
    return {"data": data}


_RANK_PARTS = (
    ("sopilot", event_rank.sopilot, event_rank.sopilot_ok),
    ("newsnow", event_rank.newsnow, event_rank.newsnow_ok),
    ("rebang", event_rank.rebang, event_rank.rebang_ok),
    ("aihot", event_rank.aihot, event_rank.aihot_ok),
)


@router.get("/api/event/ranks")
def event_ranks(part: str | None = None):
    """SoPilot / NewsNow / REBANG / AIHOT. Keys event_rank/*, 180s. Not telegraph.

    part=aihot: only that key. /ai-watch hangs the same fill, no second family.
    """
    wanted = _RANK_PARTS
    if part:
        wanted = tuple(row for row in _RANK_PARTS if row[0] == part)
        if not wanted:
            raise HTTPException(400, "unknown part")
    out: dict = {}
    with ThreadPoolExecutor(max_workers=len(wanted)) as pool:
        futs = {
            code: pool.submit(
                _part, "event_rank", code, 180, fetch, valid, "连不上热榜",
            )
            for code, fetch, valid in wanted
        }
        for code, fut in futs.items():
            try:
                out[code] = fut.result()
            except HTTPException:
                out[code] = None
    if not event_rank.board_ok(out):
        raise HTTPException(502, "连不上热榜")
    return {"data": out}
