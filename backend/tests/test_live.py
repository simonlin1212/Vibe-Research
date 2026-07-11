"""真实数据源 shape 冒烟测（联网）。用于开源前 / 升级后核对上游没变。
运行：pytest -m live      跳过：pytest -m "not live"
断言偏「形状」而非「非空」——部分源受住宅 IP 风控/限流可能间歇为空，不算失败。
"""
import pytest

import astock

CODE = "600519"  # 贵州茅台，流动性好、常年有数据


@pytest.mark.live
def test_quote_shape():
    q = astock.tencent_quote([CODE]).get(CODE)
    assert q and isinstance(q["price"], float) and q["name"]
    assert "pe_ttm" in q and "pb" in q


@pytest.mark.live
def test_full_valuation_shape():
    v = astock.full_valuation(CODE)
    assert v["code"] == CODE and v["name"] and isinstance(v["price"], float)
    assert "pe_ttm" in v and "peg" in v


@pytest.mark.live
def test_reports_and_announcements():
    assert isinstance(astock.eastmoney_reports(CODE, max_pages=1), list)
    anns = astock.announcements(CODE)
    assert isinstance(anns, list)
    if anns:
        assert set(("date", "title", "url")) <= set(anns[0])


@pytest.mark.live
def test_financials_and_percentile():
    fin = astock.financials(CODE)          # 同花顺，需 akshare
    assert isinstance(fin, dict) and "revenue" in fin
    pct = astock.valuation_percentile(CODE)  # 百度股市通
    assert "metrics" in pct


@pytest.mark.live
@pytest.mark.parametrize("fn,keys", [
    (lambda: astock.margin_trading(CODE), ("date", "rzye")),
    (lambda: astock.holder_num_change(CODE), ("date", "holder_num")),
    (lambda: astock.dividend_history(CODE), ("date", "bonus_rmb")),
])
def test_v33_list_shape(fn, keys):
    rows = fn()
    assert isinstance(rows, list)
    if rows:
        assert set(keys) <= set(rows[0])


@pytest.mark.live
def test_concept_blocks_and_industry():
    b = astock.concept_blocks(CODE)
    assert "boards" in b and "concept_tags" in b
    ind = astock.industry_comparison(5)
    assert "top" in ind and isinstance(ind["top"], list)


@pytest.mark.live
def test_short_term_emotion_shape():
    """短线情绪：聚合指标 + 连板股清单（客观公开榜单）结构正确。"""
    import market
    e = market.get_short_term_emotion()
    assert isinstance(e, dict)
    if e:  # 非交易时段/风控可能空，非空时校验形状
        for k in ("zt_count", "dt_count", "max_boards", "lianban_count", "ladder", "lianban_stocks"):
            assert k in e
        assert isinstance(e["ladder"], list) and isinstance(e["lianban_stocks"], list)
        for s in e["lianban_stocks"]:
            assert set(s) == {"code", "name", "boards", "price", "pct", "amount", "float_cap", "industry"}
            assert s["boards"] >= 2  # 连板 = 2 板及以上


@pytest.mark.live
def test_turnover_top_shape():
    """全市场成交额榜 Top20：结构正确，按成交额降序。"""
    import market
    t = market.get_turnover_top()
    assert isinstance(t, dict) and "stocks" in t
    rows = t["stocks"]
    assert isinstance(rows, list)
    if rows:
        assert set(rows[0]) == {"code", "name", "price", "pct", "amount", "mcap", "float_cap", "industry"}
        amts = [r["amount"] for r in rows if r["amount"] is not None]
        assert amts == sorted(amts, reverse=True)  # 成交额降序


@pytest.mark.live
def test_global_indices_and_stock():
    """美股 / 港股：全球指数 + 个股（AAPL / 00700）shape；精确代码匹配挑正股。"""
    import gstock
    idx = gstock.global_indices()
    assert isinstance(idx, list)
    if idx:
        assert {"key", "name", "region", "price", "change_pct"} <= set(idx[0])
    aapl = gstock.us_hk_stock("AAPL")
    assert aapl.get("code") == "AAPL" and aapl.get("market") == "NASDAQ"  # 正股，非票据/ETF
    assert aapl["quote"]["price"] is not None
    hk = gstock.us_hk_stock("00700")
    assert hk.get("market") == "HK"


@pytest.mark.live
def test_hk_cashflow_shape():
    """港股现金流量表（东财 RPT_HKSK_FN_CASHFLOW）：形状正确；非港股返回 {}。"""
    import gstock
    cf = gstock.hk_cashflow("00700")
    assert cf.get("market") == "HK" and isinstance(cf.get("periods"), list)
    assert isinstance(cf.get("item_order"), list)
    if cf["periods"]:
        assert "经营活动现金流净额" in cf["item_order"]
        assert {"report_date", "items", "currency"} <= set(cf["periods"][0])
    assert gstock.hk_cashflow("AAPL") == {}  # 美股不走此接口
