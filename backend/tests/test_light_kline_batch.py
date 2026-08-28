"""Batch light-kline map (no network)."""
import api_common


def test_light_kline_map_parallel_and_alias(monkeypatch):
    calls: list[str] = []

    def fake_kline(sym, res, num=240):
        calls.append(sym)
        return {"symbol": sym, "resolution": res, "bars": [{"close": 1}]}

    monkeypatch.setattr(api_common.astock, "light_kline", fake_kline)
    api_common._DC_CACHE.clear()
    out = api_common.light_kline_map(["sh000001", "usIXIC", "bad!!", "sh000001"], "1", 240)
    assert out["sh000001"]["symbol"] == "sh000001"
    assert out["usIXIC"]["symbol"] == "usIXIC"
    assert out["bad!!"] is None
    assert calls.count("sh000001") == 1
    assert "usIXIC" in calls


def test_light_kline_map_hits_same_cache(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: calls.append(sym) or {"symbol": sym, "bars": [{"close": 2}]},
    )
    api_common._DC_CACHE.clear()
    api_common.light_kline_map(["600519"], "1", 240)
    api_common._cached(
        "ashare_light:1:240",
        "sh600519",
        120,
        lambda: (_ for _ in ()).throw(AssertionError("should be cached")),
    )
    assert calls == ["sh600519"]


def test_light_kline_map_accepts_fx():
    assert api_common._validate_symbol("whUSDCNY") == "whUSDCNY"
    assert api_common._validate_symbol("whusdcny") == "whUSDCNY"


def test_light_kline_ttl_outlasts_keep_warm():
    assert api_common.light_kline_ttl("sh000001", "1", session="open") == 4
    assert api_common.light_kline_ttl("usIXIC", "1", session="open") == 4
    assert api_common.light_kline_ttl("jpN225", "1", session="open") == 4
    assert api_common.light_kline_ttl("ksKOSPI", "1", session="open") == 4
    assert api_common.light_kline_ttl("whUSDCNY", "1", session="open") == 4
    assert api_common.light_kline_ttl("sh600519", "1", session="open") == 120
    assert api_common.light_kline_ttl("sh000001", "1", session="lunch") == 180
    assert api_common.light_kline_ttl("sh000001", "1", session="closed") == 960
    assert api_common.light_kline_ttl("sh000001", "1D") == 60


def test_catalog_minute_incomplete_refetch_when_closed(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(api_common, "_session_kind", lambda: "closed")
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: calls.append(sym) or {
            "symbol": sym,
            "bars": [{"datetime": "2026-08-28 15:00", "close": 2}],
        },
    )
    api_common._DC_CACHE.clear()
    api_common._put(
        "ashare_light:1:240",
        "sh000300",
        {"symbol": "sh000300", "bars": [{"datetime": "2026-08-28 13:03", "close": 1}]},
        960,
    )
    out = api_common.serve_light_kline("sh000300", "1", 240)
    assert calls == ["sh000300"]
    assert out["bars"][-1]["datetime"] == "2026-08-28 15:00"


def test_catalog_minute_complete_stays_last_when_closed(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(api_common, "_session_kind", lambda: "closed")
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda *_a, **_k: calls.append("hit") or {"bars": [{"datetime": "2026-08-28 15:00"}]},
    )
    api_common._DC_CACHE.clear()
    api_common._put(
        "ashare_light:1:240",
        "sh000300",
        {"symbol": "sh000300", "bars": [{"datetime": "2026-08-28 15:00", "close": 1}]},
        960,
    )
    out = api_common.serve_light_kline("sh000300", "1", 240)
    assert calls == []
    assert out["bars"][0]["close"] == 1


def test_catalog_minute_refetches_when_open(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: calls.append(sym) or {"symbol": sym, "bars": [{"close": len(calls)}]},
    )
    monkeypatch.setattr(api_common, "_session_kind", lambda: "open")
    api_common._DC_CACHE.clear()
    first = api_common.serve_light_kline("sh000001", "1", 240)
    api_common._DC_CACHE.expire(("ashare_light:1:240", "sh000001"))
    second = api_common.serve_light_kline("sh000001", "1", 240)
    assert calls == ["sh000001", "sh000001"]
    assert first["bars"][0]["close"] == 1
    assert second["bars"][0]["close"] == 2


def test_put_light_kline_rewrites_same_key(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: calls.append(sym) or {"symbol": sym, "bars": [{"close": len(calls)}]},
    )
    api_common._DC_CACHE.clear()
    first = api_common.put_light_kline("sh000001")
    second = api_common.put_light_kline("sh000001")
    assert calls == ["sh000001", "sh000001"]
    assert first["bars"][0]["close"] == 1
    assert second["bars"][0]["close"] == 2
    hit = api_common._cached(
        "ashare_light:1:240",
        "sh000001",
        45,
        lambda: (_ for _ in ()).throw(AssertionError("should be cached")),
    )
    assert hit["bars"][0]["close"] == 2
    api_common.put_light_kline("600519")
    assert calls[-1] == "sh600519"
    stock = api_common._cached(
        "ashare_light:1:240",
        "sh600519",
        120,
        lambda: (_ for _ in ()).throw(AssertionError("6-digit must write sh key")),
    )
    assert stock["symbol"] == "sh600519"
