"""event_cal: one timeline parser, one cache family, not review warmup."""
from __future__ import annotations

import inspect

import event_cal
import review_jobs
from routers import event_routes

SAMPLE = """
<div class='panel panel-danger'>
<div class='panel-heading' style='font-size:16px;font-weight:bold;'>2026-08-24</div>
<ul class='list-group'>
<li class='list-group-item' >A 股半年报披露截止日</li>
<li class='list-group-item' >美联储主席讲话</li>
</ul></div>
<div class='panel panel-danger'>
<div class='panel-heading'>2026-08-25</div>
<ul class='list-group'>
<li class='list-group-item' >中证发布科创创业电池指数</li>
<li class='list-group-item' >中证发布科创创业电池指数</li>
</ul></div>
"""


def test_parse_timeline_html_groups_and_dedupes():
    rows = event_cal.parse_timeline_html(SAMPLE)
    assert [r["date"] for r in rows] == ["2026-08-24", "2026-08-24", "2026-08-25"]
    assert rows[0]["text"] == "A 股半年报披露截止日"
    days = event_cal.group_days(rows)
    assert days[1]["date"] == "2026-08-25"
    assert days[1]["items"] == ["中证发布科创创业电池指数"]


def test_calendar_inject_fetch():
    out = event_cal.calendar(fetch=lambda: {"result": "success", "html": SAMPLE})
    assert event_cal.calendar_ok(out)
    assert out["count"] == 3
    assert out["src"] == event_cal.SRC
    assert out["days"][0]["items"][1] == "美联储主席讲话"


def test_http_key_not_in_review_jobs():
    src = inspect.getsource(event_routes._cal)
    assert '"event_cal"' in src and "_cached" in src and "_serve" in src
    route = inspect.getsource(event_routes.event_calendar)
    assert '"timeline"' in route and "300" in route
    assert "event_cal.calendar" in route
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    assert "event_cal" not in warm
    assert "event_cal" not in live
    assert "duanxianxia" not in warm
