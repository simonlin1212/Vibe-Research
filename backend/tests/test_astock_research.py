"""a-stock-data v3.7 extras: parsers + routing. No network."""
from __future__ import annotations

import inspect

import astock_research as ar
import review_jobs
from routers import ashare


def test_apply_adjust_qfq_divides():
    """2015-01-05 茅台 202.52 / factor -> 143.46 (not multiply)."""
    factor = 202.52 / 143.46
    out = ar.apply_adjust(
        [{"date": "2015-01-05", "close": 202.52, "open": 202.52}],
        [{"date": "1900-01-01", "factor": factor}],
        "qfq",
    )
    assert abs(out[0]["close"] - 143.46) < 0.02
    assert out[0]["adj_factor"] == factor


def test_apply_adjust_hfq_multiplies():
    factor = 1274.28 / 202.52
    out = ar.apply_adjust(
        [{"date": "2015-01-05", "close": 202.52}],
        [{"date": "1900-01-01", "factor": factor}],
        "hfq",
    )
    assert abs(out[0]["close"] - 1274.28) < 0.02


def test_apply_adjust_empty_factors_raises():
    try:
        ar.apply_adjust([{"date": "2015-01-05", "close": 1}], [], "qfq")
    except ValueError as e:
        assert "空" in str(e)
    else:
        raise AssertionError("empty factors must raise")


def test_chip_seeds_day1_not_50_50():
    """Two 1% days at 10 then 100 stay ~99/1, not 50/50."""
    r = ar.chip_distribution([
        {"date": "2020-01-02", "high": 100, "low": 100, "close": 100, "turn": 1},
        {"date": "2020-01-01", "high": 10, "low": 10, "close": 10, "turn": 1},
    ])
    mass_low = sum(c for p, c in r["histogram"] if p < 20)
    mass_high = sum(c for p, c in r["histogram"] if p > 80)
    assert mass_low > 0.95
    assert mass_high < 0.05
    assert r["avg_cost"] < 20
    assert r["profit_ratio"] > 0.95
    assert 0 <= r["profit_ratio"] <= 1


def test_bs_code_rejects_bj_before_login():
    for code in ("920982", "430047", "832000", "870001"):
        try:
            ar.bs_code(code)
        except ValueError as e:
            assert "北交所" in str(e)
        else:
            raise AssertionError(code)
    assert ar.bs_code("600519") == "sh.600519"
    assert ar.bs_code("000001") == "sz.000001"
    assert ar.bs_code("000016.SH") == "sh.000016"
    assert ar.bs_code("510300") == "sh.510300"


def test_parse_sina_factor_ignores_trailer():
    text = 'var sh600519qfq={"data":[{"d":"2026-06-26","f":1.0}]}/* base64 junk */'
    assert ar.parse_sina_factor(text) == [{"date": "2026-06-26", "factor": 1.0}]


def test_sina_adjust_uses_get_prefix():
    src = inspect.getsource(ar.sina_adjust_factor)
    assert "get_prefix" in src
    assert 'startswith("6")' not in src


def test_month_label_eaten_tail_zero():
    assert ar.month_label("2026.01") == "2026-01"
    assert ar.month_label("2026.1") == "2026-10"
    assert ar.month_label(2026.1) == "2026-10"
    assert ar.month_label("2026.11") == "2026-11"
    assert ar.month_label("bad") is None


def test_parse_pboc_sfin_year_window():
    grid = [
        ["月份"],
        ["Month"],
        ["Unit"],
        ["2026.01", 72185, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [2026.1, 8000, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        ["2025.12", 999, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        ["2026.12", None, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ]
    rows = ar.parse_pboc_sfin(grid, 2026)
    months = [r["month"] for r in rows]
    assert months == ["2026-01", "2026-10"]
    assert rows[0]["afre_total"] == 72185


def test_parse_nbs_pmi_fullwidth_parens():
    title = "2026年7月份采购经理指数"
    html = (
        "<p>制造业采购经理指数（ PMI ）为 49.2%。"
        "非制造业商务活动指数为 49.0%。"
        "综合PMI产出指数为 49.3%。"
        "大、中、小型企业PMI分别为 49.5%、49.7%和47.4%。</p>"
    )
    p = ar.parse_nbs_pmi(title, html, "https://example.test/pmi")
    assert p["period"] == "2026-07"
    assert p["manufacturing_pmi"] == 49.2
    assert p["non_manufacturing_pmi"] == 49.0
    assert p["composite_pmi"] == 49.3
    assert p["pmi_large"] == 49.5
    assert p["pmi_medium"] == 49.7
    assert p["pmi_small"] == 47.4


def test_parse_nbs_pmi_missing_core_raises():
    try:
        ar.parse_nbs_pmi("2026年7月", "<p>没有数字</p>")
    except RuntimeError as e:
        assert "无法解析" in str(e)
    else:
        raise AssertionError("missing core must raise")


def test_sw_industry_as_of():
    rows = [
        {"code": "000001", "start_date": "1991-04-03", "industry_code": "440101"},
        {"code": "000001", "start_date": "2014-02-21", "industry_code": "480101"},
    ]
    early = ar.sw_industry_as_of(rows, "000001", "2013-01-01")
    late = ar.sw_industry_as_of(rows, "000001", "2016-01-01")
    assert early is not None and late is not None
    assert early["industry_code"] == "440101"
    assert early["l1_code"] == "440000"
    assert late["industry_code"] == "480101"
    assert late["l1_code"] == "480000"
    assert late["since"] == "2014-02-21"
    assert ar.sw_industry_as_of(rows, "000001", "1990-01-01") is None


def test_http_keys_not_warmup_or_macro_board():
    src = inspect.getsource(ashare)
    for key in (
        "astock_chips", "astock_adj", "astock_valhist", "astock_ipo",
        "astock_sw", "astock_pboc", "astock_nbs_pmi",
    ):
        assert f'"{key}"' in src
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    money = inspect.getsource(review_jobs.money_jobs)
    for blob in (warm, live, money):
        assert "astock_chips" not in blob
        assert "astock_pboc" not in blob
        assert "astock_nbs_pmi" not in blob
        assert "astock_sw" not in blob
    assert '_read("macro_board"' not in src
    assert '_read("lpr"' not in src
    assert "cn_bond_yield" not in inspect.getsource(ar)


def test_tools_registered():
    import tools

    for name in ("query_chips", "query_valuation_history", "query_list_status", "query_sw_industry"):
        assert name in tools.TOOL_NAMES
        assert name in tools._HANDLERS
