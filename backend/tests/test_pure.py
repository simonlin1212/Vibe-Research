"""纯逻辑单测（无网络、快、确定）：市场前缀、估值计算、行情解析。"""
import math

import astock


def test_get_prefix():
    assert astock.get_prefix("600519") == "sh"
    assert astock.get_prefix("900001") == "sh"   # 900 沪 B
    assert astock.get_prefix("920010") == "bj"   # 920 北交所
    assert astock.get_prefix("000001") == "sz"
    assert astock.get_prefix("300750") == "sz"
    assert astock.get_prefix("832000") == "bj"   # 8 开头北交所
    assert astock.get_prefix("430047") == "bj"   # 4 开头北交所老号段
    assert astock.get_prefix("510300") == "sh"   # 沪 ETF（issue #10：曾误判 sz → 行情为 0）
    assert astock.get_prefix("588000") == "sh"   # 科创 50 ETF
    assert astock.get_prefix("159915") == "sz"   # 深 ETF 15 开头走默认 sz
    # a-stock-data v3.7.1: suffix == prefix. Bare 000016 stays 深市, not 沪指数白名单.
    assert astock.get_prefix("000016.SH") == "sh"
    assert astock.get_prefix("000016") == "sz"
    assert astock.get_prefix("000016.SZ") == "sz"
    assert astock.get_prefix("sh000016") == "sh"
    assert astock.get_prefix("920982.BJ") == "bj"
    assert astock.get_prefix("600519.SH") == "sh"
    assert astock.get_prefix("SH600519") == "sh"


def test_resolve_symbol():
    assert astock.resolve_symbol("600519") == "sh600519"
    assert astock.resolve_symbol("000001") == "sz000001"       # bare = 平安银行
    assert astock.resolve_symbol("sh000001") == "sh000001"     # 上证须显式前缀
    assert astock.resolve_symbol("000016.SH") == "sh000016"    # 上证50, not 深康佳
    assert astock.resolve_symbol("000016") == "sz000016"
    assert astock.resolve_symbol("SZ399006") == "sz399006"
    assert astock.resolve_symbol("hkHSI") == "hkHSI"           # case-sensitive on wire
    assert astock.resolve_symbol("hkhstech") == "hkHSTECH"
    assert astock.resolve_symbol("usIXIC") == "usIXIC"
    assert astock.resolve_symbol("usixic") == "usIXIC"
    assert astock.resolve_symbol("usDJI") == "usDJI"
    assert astock.resolve_symbol("whUSDCNY") == "whUSDCNY"
    assert astock.resolve_symbol("whusdcny") == "whUSDCNY"
    assert astock.resolve_symbol("jpN225") == "jpN225"
    assert astock.resolve_symbol("jpn225") == "jpN225"
    assert astock.resolve_symbol("ksKOSPI") == "ksKOSPI"
    assert astock.resolve_symbol("kskospi") == "ksKOSPI"
    assert astock.resolve_symbol("bad") == ""


def test_em_secid():
    """Eastmoney secid: SH=1, SZ/BJ=0. Suffix market wins; bare 000016 stays SZ."""
    assert astock.em_secid("000016.SH") == "1.000016"
    assert astock.em_secid("000016") == "0.000016"
    assert astock.em_secid("510300") == "1.510300"
    assert astock.em_secid("588000") == "1.588000"
    assert astock.em_secid("600519") == "1.600519"
    assert astock.em_secid("300750") == "0.300750"
    assert astock.em_secid("920982") == "0.920982"
    assert astock.em_secid("159915") == "0.159915"


def test_em_callers_not_digit6():
    """Fund-flow / boards / hot concepts / cninfo must not guess SH from startswith 6."""
    import inspect

    for fn in (
        astock.stock_fund_flow_120d,
        astock.eastmoney_fund_flow_minute,
        astock.concept_blocks,
        astock.hot_concepts,
        astock.disclosure,
    ):
        src = inspect.getsource(fn)
        assert 'startswith("6")' not in src, fn.__name__
    import astock_boards

    assert "em_secid" in inspect.getsource(astock_boards.stock_basic_info)
    assert 'startswith(("5", "6", "9"))' not in inspect.getsource(astock_boards.stock_basic_info)


def test_norm_ticker():
    assert astock.norm_ticker("600519") == "600519"
    assert astock.norm_ticker("SH600519") == "600519"
    assert astock.norm_ticker("600519.SH") == "600519"
    assert astock.norm_ticker("bj920982") == "920982"
    assert astock.norm_ticker("sz000016") == "000016"
    try:
        astock.norm_ticker("6005190")
        raise AssertionError("7-digit must fail")
    except ValueError:
        pass
    try:
        astock.norm_ticker("SZ600519")
        raise AssertionError("contradicting market must fail")
    except ValueError:
        pass
    try:
        astock.norm_ticker("SH000001", stock_only=True)
        raise AssertionError("SH index must fail stock_only")
    except ValueError:
        pass
    try:
        astock.norm_ticker("000001.SH", stock_only=True)
        raise AssertionError("suffix SH index must fail stock_only")
    except ValueError:
        pass


def test_profit_forecast_rejects_sh_index():
    try:
        astock.profit_forecast("SH000001")
        raise AssertionError("SH index must fail before akshare")
    except ValueError:
        pass


def test_tencent_minute_url():
    assert "usMinute" in astock.tencent_minute_url("usIXIC")
    assert "usMinute" in astock.tencent_minute_url("usDJI")
    assert "/minute/query" in astock.tencent_minute_url("sh000001")
    assert "usMinute" not in astock.tencent_minute_url("hkHSI")


def test_tencent_daily_falls_back_host(monkeypatch):
    calls: list[str] = []

    def fake(url: str):
        calls.append(url)
        if "web.ifzq" in url:
            raise OSError("501")
        return {"data": {"sh600519": {"day": [["2026-08-14", "1", "1", "1", "1", "1"]]}}}

    monkeypatch.setattr(astock, "_tencent_json", fake)
    out = astock._tencent_daily("sh600519", 10, "none")
    assert len(out["bars"]) == 1
    assert any("web.ifzq" not in u and "fqkline/get" in u for u in calls)


def test_parse_tencent_daily_rows_keeps_amount():
    bars = astock._parse_tencent_daily_rows(
        [["2026-08-20", "10", "11", "12", "9", "1000", "25000.5"]],
        10,
    )
    assert bars[0]["amount"] == 25000.5
    assert astock._parse_tencent_daily_rows([["2026-08-20", "10", "11", "12", "9", "1000"]], 10)[0]["amount"] == 0.0


def test_delta_session_totals_splits_cum_vol_and_amount():
    bars = [
        {"datetime": "2026-08-20 09:30", "volume": 100, "amount": 5000.0},
        {"datetime": "2026-08-20 09:31", "volume": 180, "amount": 8000.0},
        {"datetime": "2026-08-21 09:30", "volume": 40, "amount": 900.0},
    ]
    astock._delta_session_totals(bars)
    assert [b["volume"] for b in bars] == [100, 80, 40]
    assert [b["amount"] for b in bars] == [5000.0, 3000.0, 900.0]


def test_light_kline_us_minute(monkeypatch):
    payload = {
        "data": {
            "usIXIC": {
                "data": {"data": ["0930 100 0", "0931 101 10"], "date": "20260814"},
                "qt": {"usIXIC": ["", "纳斯达克", "", "", "99"]},
            }
        }
    }
    monkeypatch.setattr(astock, "_tencent_json", lambda url: payload)
    out = astock.light_kline("usIXIC", "1", num=240)
    assert out["symbol"] == "usIXIC"
    assert out["name"] == "纳斯达克"
    assert out["prev_close"] == 99
    assert [b["close"] for b in out["bars"]] == [100.0, 101.0]


def test_light_kline_cn_index_falls_back_to_eastmoney(monkeypatch):
    class _Resp:
        def json(self):
            return {
                "data": {
                    "preKPrice": 4000.0,
                    "klines": [
                        "2026-08-28 13:00,4000,4001,4002,3999,0",
                        "2026-08-28 15:00,4010,4011,4012,4009,0",
                    ],
                }
            }

    monkeypatch.setattr(astock, "_tencent_json", lambda url: {"data": {}})
    monkeypatch.setattr(astock, "em_get", lambda *_a, **_k: _Resp())
    astock._em_kline_host[0] = 0
    out = astock.light_kline("sh000300", "1", num=240)
    assert out["symbol"] == "sh000300"
    assert out["source"] == "eastmoney 1.000300"
    assert out["bars"][-1]["datetime"] == "2026-08-28 15:00"
    assert [b["close"] for b in out["bars"]] == [4001.0, 4011.0]


def test_light_kline_us_falls_back_to_eastmoney(monkeypatch):
    class _Resp:
        def json(self):
            return {
                "data": {
                    "preKPrice": 53700.0,
                    "klines": [
                        "2026-08-14 09:30,53700,53710,53720,53690,0",
                        "2026-08-14 09:31,53710,53720,53730,53700,0",
                    ],
                }
            }

    monkeypatch.setattr(astock, "_tencent_json", lambda url: {"data": {}})
    monkeypatch.setattr(astock, "em_get", lambda *_a, **_k: _Resp())
    astock._em_kline_host[0] = 0
    out = astock.light_kline("usDJI", "1", num=240)
    assert out["symbol"] == "usDJI"
    assert out["source"] == "eastmoney 100.DJIA"
    assert [b["close"] for b in out["bars"]] == [53710.0, 53720.0]


def test_light_kline_fx_usdcnh(monkeypatch):
    class _Resp:
        def json(self):
            return {
                "data": {
                    "preKPrice": 7.17,
                    "klines": [
                        "2026-08-15 09:30,7.17,7.18,7.19,7.16,0",
                        "2026-08-15 09:31,7.18,7.19,7.20,7.17,0",
                    ],
                }
            }

    monkeypatch.setattr(astock, "em_get", lambda *_a, **_k: _Resp())
    astock._em_kline_host[0] = 0
    out = astock.light_kline("whUSDCNY", "1", num=240)
    assert out["symbol"] == "whUSDCNY"
    assert out["source"] == "eastmoney USDCNH"
    assert out["prev_close"] == 7.17
    assert [b["close"] for b in out["bars"]] == [7.18, 7.19]


def test_em_kline_falls_back_to_push2delay(monkeypatch):
    calls: list[str] = []

    class _Resp:
        def json(self):
            return {
                "data": {
                    "preKPrice": 6.74,
                    "klines": [
                        "2026-08-17 05:01,6.74,6.75,6.76,6.73,0",
                        "2026-08-17 05:02,6.75,6.76,6.77,6.74,0",
                    ],
                }
            }

    def fake_get(url, **_k):
        calls.append(url)
        if "push2his" in url:
            raise ConnectionError("reset")
        return _Resp()

    monkeypatch.setattr(astock, "em_get", fake_get)
    astock._em_kline_host[0] = 0
    out = astock.light_kline("whUSDCNY", "1", num=240)
    assert [b["close"] for b in out["bars"]] == [6.75, 6.76]
    assert any("push2his" in u for u in calls)
    assert any("push2delay" in u for u in calls)
    calls.clear()
    astock.light_kline("whUSDCNY", "1", num=240)
    assert calls and all("push2delay" in u for u in calls)
    astock._em_kline_host[0] = 0


def test_calc_peg():
    assert astock.calc_peg(20, 0.2) == 20 / (0.2 * 100)  # =1.0
    assert astock.calc_peg(20, 0) == float("inf")        # 增速<=0 → inf
    assert astock.calc_peg(20, -0.1) == float("inf")


def test_pe_digestion():
    assert astock.pe_digestion(30, 0.2) == 0.0           # 当前<=目标PE 无需消化
    assert astock.pe_digestion(25, 0.2, target_pe=30) == 0.0
    assert astock.pe_digestion(60, 0.2) > 0              # 高于目标需消化年数
    assert astock.pe_digestion(60, 0) == float("inf")    # 零增速永远消化不掉


def _gtimg_line(**overrides) -> str:
    # 构造一条腾讯行情返回行：v_sh600519="1~名~代码~价~..."（≥53 字段）。
    parts = ["0"] * 55
    parts[1] = overrides.get("name", "贵州茅台")
    parts[3] = overrides.get("price", "1194.45")
    parts[39] = overrides.get("pe_ttm", "18.05")
    parts[44] = overrides.get("float_mcap", "15000")
    parts[45] = overrides.get("mcap", "15000")
    parts[46] = overrides.get("pb", "6.41")
    parts[30] = overrides.get("time", "20260825161402")
    return 'v_sh600519="' + "~".join(parts) + '";'


def test_parse_gtimg():
    out = astock._parse_gtimg(_gtimg_line())
    assert "600519" in out
    q = out["600519"]
    assert q["name"] == "贵州茅台"
    assert q["price"] == 1194.45
    assert q["pe_ttm"] == 18.05
    assert q["pb"] == 6.41
    assert q["mcap_yi"] == 15000
    assert q["float_mcap_yi"] == 15000
    assert q["time"] == "2026-08-25 16:14:02"
    assert q["is_stale"] is False


def test_parse_gtimg_stale_old_bj():
    parts = ["0"] * 55
    parts[1] = "锦波生物"
    parts[3] = "112.60"
    parts[4] = "112.60"
    parts[37] = "0"
    line = 'v_bj832982="' + "~".join(parts) + '";'
    q = astock.parse_gtimg_line(line)
    assert q is not None
    assert q["is_stale"] is True
    assert "920xxx" in q["stale_reason"]


def test_eastmoney_reports_old_bj_empty_raises(monkeypatch):
    class _Resp:
        def json(self):
            return {"data": [], "TotalPage": 0}

    class _Sess:
        def get(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(astock, "_report_session", lambda: _Sess())
    try:
        astock.eastmoney_reports("832982", max_pages=1)
        raise AssertionError("old BJ empty reports must raise")
    except ValueError as e:
        assert "老号段" in str(e)


def test_eastmoney_reports_normalizes_prefix(monkeypatch):
    seen: list[str] = []

    class _Resp:
        def json(self):
            return {"data": [{"title": "x"}], "TotalPage": 1}

    class _Sess:
        def get(self, *a, **k):
            seen.append((k.get("params") or {}).get("code"))
            return _Resp()

    monkeypatch.setattr(astock, "_report_session", lambda: _Sess())
    rows = astock.eastmoney_reports("SH600519", max_pages=1)
    assert seen == ["600519"]
    assert rows[0]["title"] == "x"


def test_parse_gtimg_star_total_mcap():
    # STAR lockup: 44 float != 45 total. 市值(亿) must use total.
    out = astock._parse_gtimg(_gtimg_line(float_mcap="2708.58", mcap="40228.85"))
    q = out["600519"]
    assert q["mcap_yi"] == 40228.85
    assert q["float_mcap_yi"] == 2708.58


def test_parse_gtimg_bad_line_ignored():
    # 字段不足 / 无引号的行应被安全跳过，不抛异常。
    assert astock._parse_gtimg("garbage;no_quotes_here;") == {}
    assert astock._parse_gtimg("") == {}


def test_quote_ttl_closed_outlasts_refresh():
    assert astock.quote_ttl("open") == 5.0
    assert astock.quote_ttl("lunch") == 30.0
    assert astock.quote_ttl("closed") == 90.0


def test_gtimg_quotes_single_flight(monkeypatch):
    import threading

    astock._QUOTE_CACHE.clear()
    astock._QUOTE_LAST.clear()
    calls: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def fake_fetch(_prefixed):
        calls.append(1)
        started.set()
        release.wait(2)
        return _gtimg_line()

    monkeypatch.setattr(astock, "_fetch_gtimg", fake_fetch)
    out: list[dict] = []

    def worker():
        out.append(astock.gtimg_quotes(["sh600519"]))

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    assert started.wait(1)
    release.set()
    t1.join(2)
    t2.join(2)
    assert len(calls) == 1
    assert len(out) == 2
    assert all(o["sh600519"]["price"] == 1194.45 for o in out)


def test_tencent_quote_short_ttl(monkeypatch):
    astock._QUOTE_CACHE.clear()
    astock._QUOTE_LAST.clear()
    calls: list[int] = []

    def fake_fetch(prefixed):
        calls.append(1)
        return _gtimg_line()

    monkeypatch.setattr(astock, "_fetch_gtimg", fake_fetch)
    a = astock.tencent_quote(["600519"])
    b = astock.tencent_quote(["600519", "600519"])
    assert len(calls) == 1
    assert a["600519"]["name"] == "贵州茅台"
    assert b["600519"]["price"] == 1194.45


def test_is_ashare_stock():
    assert astock.is_ashare_stock("sh600519") is True
    assert astock.is_ashare_stock("sz000001") is True
    assert astock.is_ashare_stock("sh000001") is False
    # sz 3xxxxx includes ChiNext stocks; 399001 is an index but keeps the old amount rule
    assert astock.is_ashare_stock("sz399001") is True
    assert astock.is_ashare_stock("bj430047") is True


def test_quote_cache_shared_with_cockpit(monkeypatch):
    astock._QUOTE_CACHE.clear()
    astock._QUOTE_LAST.clear()
    calls: list[list[str]] = []

    def fake_fetch(prefixed):
        calls.append(list(prefixed))
        return _gtimg_line()

    monkeypatch.setattr(astock, "_fetch_gtimg", fake_fetch)
    astock.tencent_quote(["600519"])
    import cockpit_live as cl
    out = cl._tencent_quotes(["sh600519"])
    assert len(calls) == 1
    assert out["sh600519"]["price"] == 1194.45
    assert out["sh600519"]["name"] == "贵州茅台"
    assert out["sh600519"]["pe_ttm"] == 18.05
    assert out["sh600519"]["pb"] == 6.41
    assert out["sh600519"]["mcap_yi"] == 15000
    assert out["sh600519"]["is_stale"] is False


def test_quote_cache_index_not_aliased_to_bare(monkeypatch):
    astock._QUOTE_CACHE.clear()
    astock._QUOTE_LAST.clear()
    parts = ["0"] * 40
    parts[1] = "上证指数"
    parts[3] = "3089.12"
    parts[4] = "3080.00"
    parts[31] = "9.12"
    parts[32] = "0.30"
    line = 'v_sh000001="' + "~".join(parts) + '";'

    monkeypatch.setattr(astock, "_fetch_gtimg", lambda _c: line)
    astock.gtimg_quotes(["sh000001"])
    assert astock._quote_cache_get("sh000001")["name"] == "上证指数"
    assert astock._quote_cache_get("000001") is astock._QUOTE_MISS


def test_em_zt_topic_pool_caches(monkeypatch):
    astock._ZT_POOL_CACHE.clear()
    calls: list[tuple] = []

    class R:
        def json(self):
            return {"data": {"pool": [{"c": "600519"}]}}

    def fake_get(url, params=None, headers=None, timeout=10):
        calls.append((url, params.get("date") if params else None))
        return R()

    monkeypatch.setattr(astock, "em_get", fake_get)
    a = astock.em_zt_topic_pool("getTopicZTPool", "20260815", "fbt:asc")
    b = astock.em_zt_topic_pool("getTopicZTPool", "20260815", "fbt:asc")
    assert a == b == [{"c": "600519"}]
    assert len(calls) == 1

