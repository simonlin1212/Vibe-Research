"""review_warmup: session clock + interval (no network)."""
from datetime import datetime, timezone, timedelta

import review_warmup as rw

BEIJING = timezone(timedelta(hours=8))


def test_session_weekday_open_morning():
    t = datetime(2026, 8, 6, 10, 0, tzinfo=BEIJING)  # Thursday
    assert rw.session_kind(t) == "open"


def test_session_weekday_lunch():
    t = datetime(2026, 8, 6, 12, 0, tzinfo=BEIJING)
    assert rw.session_kind(t) == "lunch"


def test_session_weekend_closed():
    t = datetime(2026, 8, 8, 10, 0, tzinfo=BEIJING)  # Saturday
    assert rw.session_kind(t) == "closed"


def test_cockpit_warm_keys_cover_first_paint():
    import inspect
    import review_jobs

    from api_common import BOARD_FLOW_N, BOARD_FLOW_TTL, COCKPIT_WARM_KEYS

    assert BOARD_FLOW_TTL == 120
    assert BOARD_FLOW_N == 20
    assert "board_flow_intraday" in COCKPIT_WARM_KEYS
    assert "world_indices" in COCKPIT_WARM_KEYS
    assert COCKPIT_WARM_KEYS[-1] == "board_flow_intraday"
    src = inspect.getsource(review_jobs.warm_dc_jobs)
    mins = inspect.getsource(review_jobs.warm_minutes)
    for key in COCKPIT_WARM_KEYS:
        if key == "commodities":
            assert "put_commodities" in mins
            assert '"commodities"' not in src
            continue
        assert f'"{key}"' in src


def test_user_busy_still_warms_paint_keys(monkeypatch):
    monkeypatch.setattr(rw, "warm_market", lambda: (_ for _ in ()).throw(AssertionError("EM market")))
    monkeypatch.setattr("review_jobs.warm_minutes", lambda: (15, 0, []))
    called: dict[str, bool] = {}

    def extra(paint_only: bool = False):
        called["paint_only"] = paint_only
        return (2, 0, [])

    with rw.user_fetch():
        out = rw.warm_once(extra=extra)
    assert called["paint_only"] is True
    assert out.get("skipped") is True
    assert out.get("last_ok") == 17
    assert out.get("last_minute_at")


def test_warm_minutes_rewrites_catalog_and_cached_rank(monkeypatch):
    import cockpit_live
    import review_jobs

    calls: list[str] = []
    monkeypatch.setattr(
        review_jobs,
        "put_light_kline",
        lambda sym, res="1", num=240: calls.append(sym) or {"symbol": sym, "bars": [1]},
    )
    monkeypatch.setattr(cockpit_live, "future_minutes", lambda _c: {"hf_GC": {"points": [1]}})
    monkeypatch.setattr(cockpit_live, "futures_quotes", lambda _c: [{"symbol": "hf_GC", "price": 1}])
    monkeypatch.setattr(cockpit_live, "warm_hub_quotes", lambda _c: 15)
    review_jobs._DC_CACHE.clear()
    review_jobs._DC_CACHE.set(("stock_rank", "amount:0:30"), [{"code": "600519"}], ttl=60)
    ok, fail, errors = review_jobs.warm_minutes()
    assert fail == 0
    assert errors == []
    assert "sh000001" in calls
    assert "whUSDCNY" in calls
    assert "600519" in calls
    assert ok >= 18
    hit = review_jobs._DC_CACHE.get(("commodities", cockpit_live.DEFAULT_FUTURES))
    assert hit[0]["symbol"] == "hf_GC"


def test_interval_defaults(monkeypatch):
    monkeypatch.delenv("VR_REVIEW_WARMUP_OPEN_SEC", raising=False)
    monkeypatch.delenv("VR_REVIEW_WARMUP_CLOSED_SEC", raising=False)
    assert rw.interval_for_session("open") == 90
    assert rw.interval_for_session("closed") == 900
    assert rw.minute_interval_for_session("open") == 20
    assert rw.minute_interval_for_session("closed") == 60
    assert rw.minute_interval_for_session("lunch") == 60


def test_money_jobs_match_http_keys():
    import inspect
    import review_jobs

    src = inspect.getsource(review_jobs.money_jobs)
    assert '"sh_chg"' in src
    assert "ALL:all:40" in src
    assert '"shareholder"' not in src
    assert "cn_bond_yield" in src
    assert '"bond_yield"' not in src
    assert "etf_shares_many" in src
    assert "DEFAULT_CODES" in src
    import etf_shares
    assert ",".join(etf_shares.DEFAULT_CODES) == "510050,510300,510500,588000,159915,159919"
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    assert "money_jobs" in warm
    assert "cls_tg" in warm
    live = inspect.getsource(review_jobs.live_jobs)
    assert "money_jobs" in live
    assert "_cls_tg_40" in live
    assert "jin10:40" in live
    assert "jin10_flash" in live


def test_commodity_quote_ttl_fits_five_second_hub():
    import api_common

    assert api_common.commodity_quote_ttl(session="open") == 4
    assert api_common.commodity_quote_ttl(session="lunch") == 4
    assert api_common.commodity_quote_ttl(session="closed") == 4
    assert api_common.commodity_quote_ttl() < 5


def test_watch_quotes_reads_quote_hub(monkeypatch):
    import cockpit_live
    import review_jobs

    calls: list[list[str]] = []
    monkeypatch.setattr(
        cockpit_live,
        "quotes_cached",
        lambda codes: calls.append(list(codes)) or {
            "600519": {"name": "茅台", "price": 1400.0, "pct": 1.2, "amount": 9},
        },
    )
    monkeypatch.setattr(
        "astock.gtimg_quotes",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("watch should use quote hub")),
    )
    out = review_jobs.watch_quotes(["600519", "bad"])
    assert calls == [["600519", "bad"]]
    assert out[0]["name"] == "茅台"
    assert out[0]["pct"] == 1.2
    assert out[1] == {"name": "bad"}
    assert review_jobs.watch_quotes([]) == []


def test_put_commodities_rewrites_same_key(monkeypatch):
    import api_common
    import cockpit_live

    calls: list[str] = []
    monkeypatch.setattr(
        cockpit_live,
        "futures_quotes",
        lambda raw: calls.append(raw) or [{"symbol": "hf_GC", "price": len(calls)}],
    )
    api_common._DC_CACHE.clear()
    first = api_common.put_commodities()
    second = api_common.put_commodities()
    assert calls == [cockpit_live.DEFAULT_FUTURES, cockpit_live.DEFAULT_FUTURES]
    assert first[0]["price"] == 1
    assert second[0]["price"] == 2
    hit = api_common._cached(
        "commodities",
        cockpit_live.DEFAULT_FUTURES,
        5,
        lambda: (_ for _ in ()).throw(AssertionError("should be cached")),
    )
    assert hit[0]["price"] == 2
