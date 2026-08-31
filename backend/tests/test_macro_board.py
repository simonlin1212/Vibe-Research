"""macro_board parsers: one cache key, not warmup / quote hub / index catalog."""
from __future__ import annotations

import inspect

import macro_board
import review_jobs
from routers.market_routes import market_macro_board


SHIBOR = [
    {
        "9M": "1.4700",
        "1W": "1.4140",
        "3M": "1.4300",
        "ON": "1.4130",
        "showDateCN": "2026-08-31",
        "showDateEN": "31 Aug 2026",
    },
    {
        "1W": "1.4000",
        "3M": "1.4200",
        "ON": "1.4000",
        "showDateCN": "2026-08-28",
    },
]

FRR = [
    {
        "lfiProducDate": "2026-08-31",
        "frValueMap": {
            "date": "2026-08-31",
            "FDR007": "1.4100",
            "FR007": "1.4250",
            "FR001": "1.4400",
        },
    }
]

CPI = {
    "REPORT_DATE": "2026-07-01 00:00:00",
    "TIME": "2026年07月份",
    "NATIONAL_SAME": 0.5,
    "NATIONAL_SEQUENTIAL": -0.1,
}
PPI = {"REPORT_DATE": "2026-07-01 00:00:00", "TIME": "2026年07月份", "BASE": 103.5, "BASE_SAME": 3.5}
PMI = {"REPORT_DATE": "2026-08-01 00:00:00", "TIME": "2026年08月份", "MAKE_INDEX": 49.8, "NMAKE_INDEX": 49}
M2 = {
    "REPORT_DATE": "2026-07-01 00:00:00",
    "TIME": "2026年07月份",
    "BASIC_CURRENCY": 3555077.24,
    "BASIC_CURRENCY_SAME": 7.7,
    "CURRENCY_SAME": 4.0,
    "FREE_CASH_SAME": 11.6,
}
SFIN = [
    {"date": "202603", "tiosfs": 5000, "rmblaon": 1000},
    {"date": "202604", "tiosfs": 6245, "rmblaon": -4006},
]
FRED = "DATE,DGS10\n2026-08-26,4.66\n2026-08-27,4.67\n2026-08-28,.\n"
EM_DIFF = [
    {"f2": 99.54, "f3": -0.14, "f4": -0.14, "f12": "UDI", "f14": "美元指数", "f18": 99.68},
]


def test_parse_money_and_month():
    sh = macro_board.parse_shibor(SHIBOR)
    assert sh["date"] == "2026-08-31"
    by = {it["key"]: it["value"] for it in sh["items"]}
    assert by["shibor_on"] == 1.413
    assert by["shibor_1w"] == 1.414
    assert by["shibor_3m"] == 1.43

    fr = macro_board.parse_frr(FRR)
    assert fr["date"] == "2026-08-31"
    keys = {it["key"]: it for it in fr["items"]}
    assert keys["dr007"]["value"] == 1.41
    assert "FDR007" in (keys["dr007"].get("label") or "")
    assert keys["fr007"]["value"] == 1.425

    assert macro_board.parse_cpi(CPI)["value"] == 0.5
    assert macro_board.parse_ppi(PPI)["value"] == 3.5
    assert macro_board.parse_pmi(PMI)["value"] == 49.8
    m2 = macro_board.parse_m2(M2)
    assert m2["value"] == 7.7
    assert m2["stock"] == 3555077.24
    sfin = macro_board.parse_sfin(SFIN)
    assert sfin["value"] == 6245
    assert sfin["period"] == "2026-04"
    assert sfin["loan"] == -4006


def test_parse_us_and_board_ok():
    us10 = macro_board.parse_fred_csv(FRED)
    assert us10["value"] == 4.67
    assert us10["date"] == "2026-08-27"
    live = macro_board.parse_fred_csv("observation_date,DGS10\n2026-08-26,4.66\n2026-08-27,4.67\n")
    assert live["value"] == 4.67
    assert live["date"] == "2026-08-27"
    dxy = macro_board.parse_em_ulist(EM_DIFF, "100.UDI", "dxy", "美元指数")
    assert dxy["value"] == 99.54
    assert dxy["pct"] == -0.14
    packed = {
        "money": {"items": [{"key": "dr007", "value": 1.41}]},
        "month": {"items": []},
        "us": {"items": []},
    }
    assert macro_board.board_ok(packed)
    assert not macro_board.board_ok({"money": {"items": [{"value": None}]}})
    assert not macro_board.board_ok({})


def test_http_shares_macro_board_key_not_warmup():
    route = inspect.getsource(market_macro_board)
    assert '_cached("macro_board", "board"' in route
    live = inspect.getsource(review_jobs.live_jobs)
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    money = inspect.getsource(review_jobs.money_jobs)
    assert "macro_board" not in live
    assert "macro_board" not in warm
    assert "macro_board" not in money
    src = inspect.getsource(macro_board)
    assert "whUSDCNY" in src
    assert "INDEX_CATALOG" not in src
    assert "quotes_map" not in src
