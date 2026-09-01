"""Yesterday archive vs today pack: need_two_runs is not an empty change list."""
from __future__ import annotations

import inspect

import review_context as rc
import review_jobs
from routers.market_routes import market_review_archive_diff


def _enable(monkeypatch, tmp_path):
    monkeypatch.setenv("VR_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VR_REVIEW_ARCHIVE", "1")


def test_need_two_runs_is_not_empty_changes(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    today = "【全球指数】\n上证 3200 +0.80%"
    out = rc.archive_diff(today, today="2026-09-01")
    assert out["status"] == "need_two_runs"
    assert out["changes"] is None
    assert "还只有一天" in out["message"]
    packed = rc.format_vs_prior(today, today="2026-09-01")
    assert "【相对昨日】" in packed
    assert "空变化" in packed


def test_unchanged_after_compare(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    body = "【全球指数】\n上证 3200 +0.80%\n\n【涨跌分布】\n上涨2000"
    rc.save_archive(body, day="2026-08-31")
    out = rc.archive_diff(body + "\n【相对昨日】对照 2026-08-30: 涨跌分布 有变化。", today="2026-09-01")
    assert out["status"] == "unchanged"
    assert out["prior"] == "2026-08-31"
    assert out["changes"] == []
    assert "比过了没变" in out["message"]
    assert "不是缺档" in rc.format_vs_prior(body, today="2026-09-01")


def test_changed_lists_sections(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    rc.save_archive("【全球指数】\n上证 3200 +0.80%\n\n【涨跌分布】\n上涨1800", day="2026-08-29")
    today = "【全球指数】\n上证 3200 +0.80%\n\n【涨跌分布】\n上涨2100"
    out = rc.archive_diff(today, today="2026-09-01")
    assert out["status"] == "changed"
    assert out["prior"] == "2026-08-29"
    assert [c["name"] for c in out["changes"]] == ["涨跌分布"]
    assert out["changes"][0]["kind"] == "changed"


def test_empty_list_is_not_need_two_runs():
    """Client must branch on status, not on changes==[]."""
    need = {"status": "need_two_runs", "changes": None}
    same = {"status": "unchanged", "changes": []}
    assert need["changes"] is None
    assert same["changes"] == []
    assert need["status"] != same["status"]


def test_pack_adds_vs_prior_not_expected(monkeypatch, tmp_path):
    monkeypatch.setenv("VR_REVIEW_ARCHIVE", "0")
    text = rc.pack_review_context({
        "world": [{"name": "上证指数", "price": 3200, "change_pct": 0.85}],
    })
    assert "【相对昨日】" in text
    assert "相对昨日" not in rc.EXPECTED
    assert "相对昨日" not in rc.missing_panels(text)


def test_http_key_not_warmup():
    src = inspect.getsource(market_review_archive_diff)
    assert "_cached" in src and '"review_archive_diff"' in src
    assert "collect_review_bundle" in src
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    assert "review_archive_diff" not in warm
    assert "review_archive_diff" not in live
