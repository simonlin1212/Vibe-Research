"""polymarket: one Gamma parser, one cache family, not review warmup."""
from __future__ import annotations

import inspect

import polymarket
import review_jobs

SAMPLE = {
    "id": "e1",
    "slug": "us-announces-end-of-iranian-blockade-byptptpt-20260713152715080",
    "title": "US announces end of Iranian blockade by...?",
    "description": "On July 13, 2026, Trump announced...",
    "volume": 18197772,
    "volume24hr": 2100000,
    "liquidity": 80000,
    "endDate": "2026-12-31T23:59:00Z",
    "tags": [{"label": "Politics"}, {"label": "Iran"}],
    "markets": [
        {
            "id": "m1",
            "question": "by August 22?",
            "groupItemTitle": "August 22",
            "outcomePrices": '["0.003", "0.997"]',
            "outcomes": '["Yes", "No"]',
            "volumeNum": 1391117,
            "endDate": "2026-08-22T23:59:00Z",
            "closed": False,
            "oneHourPriceChange": -0.002,
        },
        {
            "id": "m2",
            "question": "by December 31?",
            "groupItemTitle": "December 31",
            "outcomePrices": ["0.673", "0.335"],
            "outcomes": ["Yes", "No"],
            "volumeNum": 845047,
            "endDate": "2026-12-31T23:59:00Z",
            "closed": False,
        },
    ],
}


def test_norm_slug_from_url():
    url = "https://polymarket.com/event/us-announces-end-of-iranian-blockade-byptptpt-20260713152715080"
    assert polymarket.norm_slug(url) == SAMPLE["slug"]
    assert polymarket.norm_slug("  ABC Def  ") == "abc-def"
    assert polymarket.norm_query(url) == SAMPLE["slug"]


def test_parse_yes_no_and_featured():
    m = polymarket.parse_market(SAMPLE["markets"][0])
    assert m is not None
    assert m["title"] == "August 22"
    assert m["yes"] == 0.3
    assert m["outcomes"][1]["pct"] == 99.7
    assert m["chg"] == -0.2
    ev = polymarket.parse_event(SAMPLE)
    assert ev is not None
    assert ev["slug"] == SAMPLE["slug"]
    assert ev["tags"] == ["Politics", "Iran"]
    assert ev["featured"]["label"] == "December 31"
    assert abs(ev["featured"]["pct"] - 67.3) < 1e-6
    assert ev["n_markets"] == 2
    assert ev["markets"][0]["end"] < ev["markets"][1]["end"]


def test_board_uses_injected_fetch():
    seen: list[str] = []

    def fetch(url: str):
        seen.append(url)
        return [SAMPLE]

    out = polymarket.board(fetch=fetch, limit=10)
    assert polymarket.board_ok(out)
    assert seen and "order=volume24hr" in seen[0]
    assert out["events"][0]["slug"] == SAMPLE["slug"]
    assert len(out["events"][0]["markets"]) <= polymarket.BOARD_MARKETS


def test_search_slug_hits_event_endpoint():
    seen: list[str] = []

    def fetch(url: str):
        seen.append(url)
        return [SAMPLE]

    out = polymarket.search(SAMPLE["slug"], fetch=fetch)
    assert out["events"][0]["title"].startswith("US announces")
    assert any("slug=" in u for u in seen)


def test_search_title_uses_public_search():
    seen: list[str] = []

    def fetch(url: str):
        seen.append(url)
        return {"events": [SAMPLE], "pagination": {}}

    out = polymarket.search("iran blockade", fetch=fetch)
    assert seen and "public-search" in seen[0]
    assert out["q"] == "iran blockade"
    assert out["events"][0]["slug"] == SAMPLE["slug"]


def test_resolve_proxies_env_then_system():
    assert polymarket.resolve_proxies(env={"VR_POLYMARKET_PROXY": "127.0.0.1:10808"}, system={}) == {
        "http": "http://127.0.0.1:10808",
        "https": "http://127.0.0.1:10808",
    }
    assert polymarket.resolve_proxies(
        env={},
        system={"https": "http://127.0.0.1:10808"},
    ) == {
        "http": "http://127.0.0.1:10808",
        "https": "http://127.0.0.1:10808",
    }
    assert polymarket.resolve_proxies(env={}, system={}) is None
    src = inspect.getsource(polymarket._get_json)
    assert "resolve_proxies" in src and "proxies" in src


def test_parse_slugs_from_urls():
    blob = (
        "https://polymarket.com/event/nato-x-russia-military-clash-in-2025\n"
        "https://polymarket.com/event/what-price-will-wti-hit-in-august-2026"
    )
    assert polymarket.parse_slugs(blob) == [
        "nato-x-russia-military-clash-in-2025",
        "what-price-will-wti-hit-in-august-2026",
    ]


def test_http_keys_not_in_review_jobs():
    from routers import event_routes

    helper = inspect.getsource(event_routes._pm)
    assert '"polymarket"' in helper and "_cached" in helper and "_serve" in helper
    board = inspect.getsource(event_routes.polymarket_board)
    assert '"board"' in board and "60" in board
    ev = inspect.getsource(event_routes.polymarket_event)
    assert "event::{s}" in ev and "30" in ev
    se = inspect.getsource(event_routes.polymarket_search)
    assert "search::{query}" in se and "60" in se
    watch = inspect.getsource(event_routes.polymarket_watch)
    assert "event::{s}" in watch and "parse_slugs" in watch
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    assert "polymarket" not in warm
    assert "polymarket" not in live
