"""Event cockpit HTTP: calendar. Key event_cal."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

import event_cal
from api_common import _cached, _serve

router = APIRouter(tags=["event"])


def _cal(code: str, ttl: float, fetch, valid, empty: str):
    """Calendar. One key event_cal. Not telegraph."""
    try:
        data = _cached("event_cal", code, ttl, fetch, valid=valid)
        if valid(data):
            return data
    except Exception as e:
        last = _serve("event_cal", code)
        if valid(last):
            return last
        raise HTTPException(502, f"{empty}: {e}") from e
    last = _serve("event_cal", code)
    if valid(last):
        return last
    return None


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
