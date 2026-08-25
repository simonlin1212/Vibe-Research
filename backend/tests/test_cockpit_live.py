"""Pure parse tests for cockpit_live (no network)."""
import cockpit_live as cl


def test_parse_tencent_a_share_index():
    f = [""] * 40
    f[1] = "上证指数"
    f[3] = "3089.12"
    f[4] = "3080.00"
    f[31] = "9.12"
    f[32] = "0.30"
    f[37] = "12345.6"
    line = f'v_sh000001="{"~".join(f)}"'
    q = cl.parse_tencent_quote_line(line)
    assert q is not None
    assert q["symbol"] == "sh000001"
    assert q["name"] == "上证指数"
    assert q["price"] == 3089.12
    assert q["pct"] == 0.30
    assert q["amount"] == 12345.6


def test_warm_hub_quotes_writes_quote_one(monkeypatch):
    from api_common import _DC_CACHE

    item = {"symbol": "sh000001", "name": "上证指数", "price": 3089.12, "pct": 0.3}
    monkeypatch.setattr(cl, "quotes_map", lambda _c: {"sh000001": item})
    monkeypatch.setattr(cl.astock, "quote_ttl", lambda: 90.0)
    _DC_CACHE.clear()
    n = cl.warm_hub_quotes(["sh000001"])
    assert n >= 1
    hit = _DC_CACHE.get(("quote_one", "sh000001"))
    assert hit["price"] == 3089.12
    assert hit["pct"] == 0.3


def test_quote_item_pct_follows_price_prev():
    q = {"name": "x", "price": 11.0, "prev": 10.0, "pct": 0.0, "change": 0.0}
    item = cl._quote_item(q, "sz000001")
    assert item["pct"] == 10.0
    assert item["change"] == 1.0
    flat = cl._quote_item({"name": "y", "price": 10.0, "prev": 10.0, "pct": 9.9}, "sz000001")
    assert flat["pct"] == 0.0


def test_quote_item_keeps_valuation():
    item = cl._quote_item(
        {
            "name": "长鑫科技", "price": 60.15, "prev": 55.18,
            "pe_ttm": 142.68, "pb": 28.87, "mcap_yi": 40228.85,
            "turnover": 8.48, "open": 56.0, "high": 61.2, "low": 55.5,
            "amplitude_pct": 10.3, "vol_ratio": 2.4, "float_mcap_yi": 2708.58,
            "limit_up": 66.22, "limit_down": 44.14, "pe_static": 80.1,
        },
        "sh688825",
        turnover=8.48,
    )
    assert item["pe_ttm"] == 142.68
    assert item["pb"] == 28.87
    assert item["mcap_yi"] == 40228.85
    assert item["turnover"] == 8.48
    assert item["open"] == 56.0
    assert item["vol_ratio"] == 2.4
    assert item["float_mcap_yi"] == 2708.58
    assert item["pe_static"] == 80.1


def test_parse_tencent_forex():
    line = 'v_whUSDCNY="200~美元人民币~USDCNY~7.1800~0~0~7.17~0~7.19~7.16~0~0~0.0200~0.28"'
    q = cl.parse_tencent_quote_line(line)
    assert q is not None
    assert q["symbol"] == "whUSDCNY"
    assert abs(q["price"] - 7.18) < 1e-6
    assert q["pct"] == 0.28


def test_parse_sina_hf_and_nf():
    hf = 'hq_str_hf_GC="2345.6,0,0,0,2350,2330,10:01,2300.0,2310,0,0,0,2026-08-15,纽约黄金,0";'
    nf = 'hq_str_nf_AU0="沪金,0,780,790,770,785,784,786,780,0,0,0,0,0,0,0,2026-08-15";'
    h = cl.parse_sina_hf(hf)
    n = cl.parse_sina_nf(nf)
    assert h["hf_GC"]["price"] == 2345.6
    assert h["hf_GC"]["prev"] == 2300.0
    assert h["hf_GC"]["pct"] == cl._pct(2345.6, 2300.0)
    assert h["hf_GC"]["time"] == "2026-08-15 10:01"
    assert n["nf_AU0"]["name"] == "沪金"
    assert n["nf_AU0"]["price"] == 785


def test_normalize_board_code():
    assert cl.normalize_board_code("bk0474") == "BK0474"
    assert cl.normalize_board_code("BK0474") == "BK0474"
    assert cl.normalize_board_code("0474") == "BK0474"
    assert cl.normalize_board_code("bk474") == "BK0474"
    assert cl.normalize_board_code("pt01801712") == "pt01801712"
    assert cl.normalize_board_code("pt01801764") == "pt01801764"
    assert cl.normalize_board_code("pt02GN2422") == "pt02GN2422"


def test_parse_qq_board_rank():
    rows = cl.parse_qq_board_rank([
        {
            "code": "sz002080",
            "name": "中材科技",
            "zxj": "59.93",
            "zdf": "7.48",
            "hsl": "3.61",
            "volume": "606524",
        },
        {"code": "bad", "zxj": "10", "zdf": "1"},
    ], 20)
    assert len(rows) == 1
    assert rows[0]["code"] == "002080"
    assert rows[0]["symbol"] == "sz002080"
    assert rows[0]["pct"] == 7.48
    assert abs(rows[0]["amount"] - 606524 * 100 * 59.93) < 1
    assert rows[0]["turnover"] == 3.61


def test_attach_em_flow(monkeypatch):
    monkeypatch.setattr(cl, "_em_ulist_flow", lambda codes: {"002080": (8.718e7, 2.4)})
    rows = [{"code": "002080", "name": "中材科技", "main_net": None, "main_pct": None}]
    cl._attach_em_flow(rows)
    assert rows[0]["main_net"] == 8.718e7
    assert rows[0]["main_pct"] == 2.4


def test_stock_flow_map(monkeypatch):
    monkeypatch.setattr(cl, "_em_ulist_flow", lambda codes: {"600519": (1.2e8, -3.1)})
    out = cl.stock_flow_map(["600519", "000858"])
    assert out["600519"]["main_net"] == 1.2e8
    assert out["600519"]["netRatio"] == -3.1
    assert out["000858"]["main_net"] is None
    rows = cl.stock_flows(["600519", "000858"])
    assert rows == [{"code": "600519", "netIn": 1.2e8, "netRatio": -3.1}]


def test_board_stocks_prefers_tencent_pt(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_board_stocks", lambda raw, n: [{
        "code": "002080", "name": "中材科技", "price": 59.93, "pct": 7.48,
        "amount": 1e8, "turnover": 3.6,
    }])
    monkeypatch.setattr(cl, "_attach_em_flow", lambda rows: rows)
    out = cl.board_stocks("pt01801712", 20)
    assert out[0]["code"] == "002080"


def test_board_stocks_empty_when_tencent_misses(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_board_stocks", lambda raw, n: [])
    assert cl.board_stocks("BK0474", 12) == []


def test_parse_jsonp():
    assert cl.parse_jsonp('var t=({"minLine_1d":[["09:31",1]]});') == {"minLine_1d": [["09:31", 1]]}


def test_board_fflow_kline_cached_hits_same_key(monkeypatch):
    from api_common import _DC_CACHE

    calls = []
    monkeypatch.setattr(cl, "_board_fflow_kline", lambda code: calls.append(code) or [{"t": "09:31", "v": 1.0}])
    _DC_CACHE.clear()
    a = cl._board_fflow_kline_cached("bk0474")
    b = cl._board_fflow_kline_cached("BK0474")
    assert a == b == [{"t": "09:31", "v": 1.0}]
    assert calls == ["BK0474"]


def test_board_flow_picks_both_sides(monkeypatch):
    pos: list[int] = []

    def pick(po: int, half: int):
        pos.append(po)
        return [{"code": f"BK000{po}", "name": str(po), "net_in": 1.0}]

    monkeypatch.setattr(cl, "_board_flow_pick", pick)
    out = cl.board_flow_intraday(6, curves=False)
    assert sorted(pos) == [0, 1]
    assert {r["code"] for r in out} == {"BK0000", "BK0001"}


def test_board_flow_n20_half_is_10(monkeypatch):
    halves: list[int] = []

    def pick(po: int, half: int):
        halves.append(half)
        return [{"code": f"BK000{po}", "name": str(po), "net_in": 1.0}]

    monkeypatch.setattr(cl, "_board_flow_pick", pick)
    cl.board_flow_intraday(20, curves=False)
    assert len(halves) == 2 and set(halves) == {10}


def test_future_minutes_runs_all_codes(monkeypatch):
    seen: list[str] = []

    def fake(code: str):
        seen.append(code)
        return {"code": code, "prec": 1, "points": []}

    monkeypatch.setattr(cl, "future_minute", fake)
    out = cl.future_minutes(["hf_GC", "nf_AU0", "hf_CL", "hf_GC"])
    assert set(out) == {"hf_GC", "nf_AU0", "hf_CL"}
    assert sorted(seen) == ["hf_CL", "hf_GC", "nf_AU0"]


def test_board_flow_ranks_skip_kline(monkeypatch):
    from api_common import _DC_CACHE

    class R:
        def json(self):
            return {"data": {"diff": [{"f12": "BK0474", "f14": "银行", "f62": 1e8}]}}

    kl_calls = []
    monkeypatch.setattr(cl, "em_get", lambda *a, **k: R())
    monkeypatch.setattr(cl, "_board_fflow_kline", lambda code: kl_calls.append(code) or [{"t": "09:31", "v": 1}])
    _DC_CACHE.clear()
    out = cl.board_flow_intraday(6, curves=False)
    assert kl_calls == []
    assert out[0]["name"] == "银行"
    assert out[0]["code"] == "BK0474"
    assert out[0]["points"] == []


def test_board_flow_ranks_peek_cached_kline(monkeypatch):
    from api_common import _DC_CACHE

    class R:
        def json(self):
            return {"data": {"diff": [{"f12": "BK0474", "f14": "银行", "f62": 1e8}]}}

    kl_calls = []
    monkeypatch.setattr(cl, "em_get", lambda *a, **k: R())
    monkeypatch.setattr(cl, "_board_fflow_kline", lambda code: kl_calls.append(code) or [{"t": "09:31", "v": 1}])
    _DC_CACHE.clear()
    _DC_CACHE.set(("board_fflow_kline", "BK0474"), [{"t": "09:31", "v": 1.0}, {"t": "09:32", "v": 2.0}])
    out = cl.board_flow_intraday(6, curves=False)
    assert kl_calls == []
    assert len(out[0]["points"]) == 2


def test_sanitize_future_codes():
    codes = cl._sanitize_future_codes("hf_GC,nf_AU0,BTCUSDT,../etc,hf_TOOLONGSYMBOLXXXX,hf_CL")
    assert codes == ["hf_GC", "nf_AU0", "hf_CL"]
    assert "hf_NQ" in cl.DEFAULT_FUTURES.split(",")
    assert "hf_BTC" in cl.DEFAULT_FUTURES.split(",")
    assert "hf_GC" not in cl.DEFAULT_FUTURES.split(",")
    assert "nf_AU0" not in cl.DEFAULT_FUTURES.split(",")
    assert "BTCUSDT" not in cl.DEFAULT_FUTURES.split(",")
    assert cl.DEFAULT_FUTURES.endswith("hf_BTC")


def test_future_minutes_filled_rejects_empty_points():
    assert not cl.future_minutes_filled({})
    assert not cl.future_minutes_filled({"hf_BTC": {"points": []}})
    assert cl.future_minutes_filled({"hf_BTC": {"points": [{"t": "06:01", "p": 1.0}]}})


def test_parse_sina_hf_btc():
    text = (
        'var hq_str_hf_BTC="64180.000,,64165.000,64185.000,64685.000,64180.000,'
        '10:45:15,64410.000,64495.000,0,5,1,2026-08-18,比特币期货,0";'
    )
    out = cl.parse_sina_hf(text)
    assert out["hf_BTC"]["name"] == "比特币期货"
    assert out["hf_BTC"]["price"] == 64180.0
    assert out["hf_BTC"]["prev"] == 64410.0


def test_parse_sina_amount_rows_converts_wan_yuan():
    rows = cl.parse_sina_amount_rows([
        {
            "code": "600519",
            "name": "贵州茅台",
            "trade": "1400",
            "changepercent": "1.25",
            "amount": "8000000000",
            "mktcap": "21890000",
            "nmc": "21880000",
        },
        {"code": "bad", "trade": "10", "amount": "1"},
    ], 20)
    assert len(rows) == 1
    assert rows[0]["code"] == "600519"
    assert rows[0]["amount"] == 8000000000.0
    assert rows[0]["mcap"] == 21890000 * 10000
    assert rows[0]["float_cap"] == 21880000 * 10000
    assert set(rows[0]) == {"code", "name", "price", "pct", "amount", "mcap", "float_cap", "industry"}


def test_stock_rank_prefers_sina(monkeypatch):
    sina_calls = []
    monkeypatch.setattr(cl, "_sina_rank", lambda *a, **k: sina_calls.append(a) or [{"code": "600519", "pct": 1}])
    monkeypatch.setattr(cl, "_attach_em_flow", lambda rows: rows)
    out = cl.stock_rank("amount", 0, 10)
    assert out[0]["code"] == "600519"
    assert sina_calls


def test_stock_rank_attaches_em_flow(monkeypatch):
    monkeypatch.setattr(cl, "_sina_rank", lambda *a, **k: [{"code": "600519", "name": "茅台"}])

    def attach(rows):
        rows[0]["main_net"] = 9.0
        rows[0]["main_pct"] = 1.2
        return rows

    monkeypatch.setattr(cl, "_attach_em_flow", attach)
    out = cl.stock_rank("amount", 0, 10)
    assert out[0]["main_net"] == 9.0
    assert out[0]["main_pct"] == 1.2


def test_stock_rank_empty_when_sina_misses(monkeypatch):
    monkeypatch.setattr(cl, "_sina_rank", lambda *a, **k: [])
    assert cl.stock_rank("changepercent", 0, 10) == []


def test_quotes_map_aliases_and_filters(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {
        "sh600519": {
            "symbol": "sh600519", "name": "贵州茅台", "price": 1400.0,
            "pct": 1.2, "change": 16.0, "prev": 1384.0, "amount": 12.5, "turnover": 0.31,
            "bid": 1399.0, "ask": 1401.0, "bid_vol": 200, "ask_vol": 80, "volume": 12345,
        },
        "usIXIC": {
            "symbol": "usIXIC", "name": "纳斯达克", "price": 21000.0,
            "pct": 0.4, "change": 80.0, "prev": 20920.0, "amount": 0, "turnover": 0,
        },
    })
    out = cl.quotes_map(["600519", "sh600519", "usIXIC", "bad!!", "600519"])
    assert out["600519"]["price"] == 1400.0
    assert out["sh600519"]["price"] == 1400.0
    assert out["600519"]["amount"] == 12.5 * 10000
    assert out["600519"]["bid"] == 1399.0
    assert out["600519"]["ask"] == 1401.0
    assert out["600519"]["volume"] == 12345
    assert out["usIXIC"]["name"] == "纳斯达克"
    assert out["usIXIC"]["amount"] == 0
    assert "bad!!" not in out


def test_quotes_map_index_and_hk_amount_yuan(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {
        "sh000001": {
            "symbol": "sh000001", "name": "上证指数", "price": 3089.12,
            "pct": 0.3, "change": 9.12, "prev": 3080.0, "amount": 99040000.0, "turnover": 0,
        },
        "hkHSI": {
            "symbol": "hkHSI", "name": "恒生指数", "price": 18000.0,
            "pct": 0.1, "change": 20.0, "prev": 17980.0, "amount": 1200000.0, "turnover": 0,
        },
        "usIXIC": {
            "symbol": "usIXIC", "name": "纳斯达克", "price": 21000.0,
            "pct": 0.4, "change": 80.0, "prev": 20920.0, "amount": 99.0, "turnover": 0,
        },
    })
    out = cl.quotes_map(["sh000001", "hkHSI", "usIXIC"])
    assert out["sh000001"]["amount"] == 99040000.0 * 10000
    assert out["hkHSI"]["amount"] == 1200000.0 * 10000
    assert out["usIXIC"]["amount"] == 0


def test_quotes_map_skips_empty_price(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {
        "sz000001": {"symbol": "sz000001", "name": "平安银行", "price": 0, "pct": 0},
    })
    assert cl.quotes_map(["000001"]) == {}


def test_quotes_map_skips_futures(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {
        "sh600519": {
            "symbol": "sh600519", "name": "贵州茅台", "price": 1400.0,
            "pct": 1.0, "change": 14.0, "prev": 1386.0, "amount": 1.0, "turnover": 0.2,
        },
    })
    called = []
    monkeypatch.setattr(cl, "futures_quotes", lambda raw: called.append(raw) or {})
    out = cl.quotes_map(["600519", "hf_CL", "nf_AU0"])
    assert out["600519"]["price"] == 1400.0
    assert "hf_CL" not in out
    assert "nf_AU0" not in out
    assert called == []


def test_futures_quotes_sina_fills_tencent_miss(monkeypatch):
    def fake_text(url, **_k):
        if "qt.gtimg.cn" in url:
            return 'v_hf_GC="1,0,1,1,1,1,10:00:00,1,1,0,1,1,2026-08-18,黄金";'
        if "sinajs" in url:
            return 'hq_str_hf_NQ="10,,10,10,11,9,10:00:00,9,9,0,1,1,2026-08-18,纳斯达克指数期货,0";'
        return ""

    monkeypatch.setattr(cl, "_fetch_text", fake_text)
    out = cl.futures_quotes("hf_GC,hf_NQ")
    assert out["hf_GC"]["price"] == 1
    assert out["hf_NQ"]["price"] == 10
    assert out["hf_NQ"]["name"] == "纳斯达克指数期货"


def test_quotes_map_fills_em_index(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {})

    class R:
        def json(self):
            return {
                "data": {
                    "diff": [
                        {"f2": 68137.94, "f3": -1.56, "f4": -1082.31, "f12": "N225", "f14": "日经225", "f18": 69220.25},
                        {"f2": 6979.7, "f3": 0.03, "f4": 1.76, "f12": "KS11", "f14": "韩国KOSPI", "f18": 6977.94},
                    ]
                }
            }

    monkeypatch.setattr(cl, "em_get", lambda *a, **k: R())
    out = cl.quotes_map(["jpN225", "ksKOSPI"])
    assert out["jpN225"]["price"] == 68137.94
    assert out["ksKOSPI"]["price"] == 6979.7


def test_quotes_map_vix_falls_back_to_sina(monkeypatch):
    monkeypatch.setattr(cl, "_tencent_quotes", lambda codes: {})
    monkeypatch.setattr(cl, "_vix_from_sina", lambda: {
        "name": "恐慌指数", "price": 16.2, "pct": 1.1, "change": 0.2, "prev": 16.0,
    })
    out = cl.quotes_map(["usVIX", "sh000001"])
    assert out["usVIX"]["price"] == 16.2
    assert out["usvix"]["price"] == 16.2


def test_quotes_cached_reuses_per_code(monkeypatch):
    import api_common

    api_common._DC_CACHE.clear()
    calls = []

    def fake_map(codes):
        calls.append(list(codes))
        return {c: {"symbol": c, "name": c, "price": 10.0, "pct": 0.1} for c in codes if c != "usIXIC"}

    monkeypatch.setattr(cl, "quotes_map", fake_map)
    a = cl.quotes_cached(["sh000001", "usIXIC"])
    b = cl.quotes_cached(["sh000001", "sz399001"])
    assert a["sh000001"]["price"] == 10.0
    assert b["sh000001"]["price"] == 10.0
    assert calls[0] == ["sh000001", "usIXIC"]
    assert calls[1] == ["sz399001"]


def test_quotes_cached_serves_last_when_fresh_expires(monkeypatch):
    import api_common

    api_common._DC_CACHE.clear()
    calls: list[list[str]] = []

    def fake_map(codes):
        calls.append(list(codes))
        return {c: {"symbol": c, "name": c, "price": 10.0, "pct": 0.1} for c in codes}

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
    assert out["sh000001"]["price"] == 10.0
    assert calls == [["sh000001"], ["sh000001"]]


def test_stock_boards_map_aliases_and_skips(monkeypatch):
    def fake(code):
        if "bad" in (code or ""):
            raise ValueError("bad code")
        return {
            "code": "sh600519", "name": "茅台", "industry": "白酒",
            "area": "贵州", "concepts": ["消费"], "source": "eastmoney",
        }

    monkeypatch.setattr(cl, "stock_boards", fake)
    out = cl.stock_boards_map(["600519", "sh600519", "bad!!"])
    assert out["600519"]["industry"] == "白酒"
    assert out["sh600519"]["industry"] == "白酒"
    assert "bad!!" not in out


def test_turnover_top_prefers_sina(monkeypatch):
    import market

    from api_common import _DC_CACHE

    _DC_CACHE.clear()
    monkeypatch.setattr(cl, "sina_amount_rank", lambda n: [{
        "code": "600519", "name": "茅台", "price": 1400.0, "pct": 1.2,
        "amount": 1e9, "mcap": 2e12, "float_cap": 2e12, "industry": "",
    }])
    out = market.get_turnover_top()
    assert out["stocks"][0]["code"] == "600519"
