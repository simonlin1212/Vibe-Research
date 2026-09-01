"""Clock-fed keys: HTTP reads last-good and does not hit upstream."""
import api_common
import cockpit_live as cl
import review_jobs


def test_read_serves_last_after_hot_expires():
    api_common._DC_CACHE.clear()
    api_common._put("world_indices", "live", [{"symbol": "sh000001", "price": 1}], 20)
    api_common._DC_CACHE.expire(("world_indices", "live"))
    calls: list[int] = []

    def boom():
        calls.append(1)
        raise AssertionError("clock-fed HTTP must not fetch")

    out = api_common._read("world_indices", "live", 20, boom)
    assert out[0]["price"] == 1
    assert calls == []
    assert api_common._serve("world_indices", "live")[0]["price"] == 1


def test_clear_wipes_last():
    api_common._DC_CACHE.clear()
    api_common._put("hsgt", "live", {"north": 1}, 120)
    api_common._DC_CACHE.clear()
    assert api_common._serve("hsgt", "live") is None
    calls: list[int] = []
    api_common._read("hsgt", "live", 120, lambda: calls.append(1) or {"north": 2})
    assert calls == [1]


def test_put_commodities_and_kline_write_last(monkeypatch):
    monkeypatch.setattr(
        cl,
        "futures_quotes",
        lambda raw: [{"symbol": "hf_GC", "price": 9}],
    )
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: {"symbol": sym, "bars": [{"close": 3}]},
    )
    api_common._DC_CACHE.clear()
    api_common.put_commodities()
    api_common.put_light_kline("sh000001")
    api_common._DC_CACHE.expire(("commodities", cl.DEFAULT_FUTURES))
    api_common._DC_CACHE.expire(("ashare_light:1:240", "sh000001"))
    assert api_common._serve("commodities", cl.DEFAULT_FUTURES)[0]["price"] == 9
    hit = api_common.serve_light_kline("sh000001", "1", 240)
    assert hit["bars"][0]["close"] == 3


def test_watchlist_minute_refetches_after_expire(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        api_common.astock,
        "light_kline",
        lambda sym, res, num=240: calls.append(sym) or {"symbol": sym, "bars": [{"close": 1}]},
    )
    api_common._DC_CACHE.clear()
    api_common.light_kline_map(["600519"], "1", 240)
    api_common._DC_CACHE.expire(("ashare_light:1:240", "sh600519"))
    api_common.light_kline_map(["600519"], "1", 240)
    assert calls == ["sh600519", "sh600519"]


def test_catalog_quotes_stale_refresh(monkeypatch):
    api_common._DC_CACHE.clear()
    calls: list[list[str]] = []

    def fake_map(codes):
        calls.append(list(codes))
        return {c: {"symbol": c, "name": c, "price": 10.0 + len(calls), "pct": 0.1} for c in codes}

    class ImmediateThread:
        def __init__(self, target=None, args=(), kwargs=None, **_):
            self._target = target
            self._args = args
            self._kwargs = kwargs or {}

        def start(self):
            self._target(*self._args, **self._kwargs)

    monkeypatch.setattr(cl, "quotes_map", fake_map)
    monkeypatch.setattr(cl.threading, "Thread", ImmediateThread)
    cl.quotes_cached(["sh000001"])
    api_common._DC_CACHE.expire(("quote_one", "sh000001"))
    out = cl.quotes_cached(["sh000001"])
    assert out["sh000001"]["price"] == 11.0
    assert calls == [["sh000001"], ["sh000001"]]
    assert cl.quotes_cached(["sh000001"])["sh000001"]["price"] == 12.0


def test_stock_flow_warmup_uses_http_key():
    import inspect

    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    mins = inspect.getsource(review_jobs.minute_symbols)
    assert "ALL:15" in warm
    assert "ALL:15" in live
    assert "ALL:15" in mins
    assert "all:15" not in warm
    assert "all:15" not in live
    assert "all:15" not in mins


def test_dc_default_serves_last_after_expire():
    api_common._DC_CACHE.clear()
    calls: list[int] = []
    api_common._dc("world_indices", "live", 20, lambda: calls.append(1) or [{"price": 1}])
    api_common._DC_CACHE.expire(("world_indices", "live"))
    out = api_common._dc("world_indices", "live", 20, lambda: calls.append(1) or [{"price": 2}])
    assert out[0]["price"] == 1
    assert calls == [1]


def test_cached_refetches_after_expire():
    api_common._DC_CACHE.clear()
    calls: list[int] = []
    api_common._cached("market_lives", "1:40", 8, lambda: calls.append(1) or [{"id": 1}])
    api_common._DC_CACHE.expire(("market_lives", "1:40"))
    out = api_common._cached("market_lives", "1:40", 8, lambda: calls.append(1) or [{"id": 2}])
    assert out[0]["id"] == 2
    assert calls == [1, 1]


def test_routes_default_last_explicit_refetch():
    import inspect

    from routers import ashare, fin_routes, market_routes

    src = inspect.getsource(market_routes)
    assert "last=" not in src
    assert 'op = _cached if k == "02" else _dc' in src
    assert 'op = _cached if key == "changepercent" else _dc' in src
    assert "_cached" in inspect.getsource(market_routes.market_board_stocks)
    assert "_cached" in inspect.getsource(market_routes.market_lives)
    assert "_cached" in inspect.getsource(market_routes.cls_telegraph)
    assert "10," in inspect.getsource(market_routes.cls_telegraph)
    assert "_cached" in inspect.getsource(market_routes.market_commodities)
    assert "_cached" in inspect.getsource(market_routes.market_commodity_minutes)
    assert ",\n            4," in inspect.getsource(market_routes.market_commodity_minutes)
    assert "jin10" in inspect.getsource(market_routes.market_lives)
    assert "_cached" in inspect.getsource(ashare.fund_flow_minute)
    assert "_cached" in inspect.getsource(fin_routes.fin_suggest)


def test_peek_codes_falls_back_to_last():
    api_common._DC_CACHE.clear()
    api_common._put("stock_rank", "amount:0:30", [{"code": "600519"}], 20)
    api_common._put("stock_flow", "ALL:15", [{"code": "000001"}], 120)
    api_common._DC_CACHE.expire(("stock_rank", "amount:0:30"))
    api_common._DC_CACHE.expire(("stock_flow", "ALL:15"))
    assert "600519" in review_jobs.minute_symbols()
    assert "000001" in review_jobs.minute_symbols()
