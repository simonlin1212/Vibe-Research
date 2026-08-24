"""dxx: one board parser, one cache family, not review warmup."""
from __future__ import annotations

import inspect

import dxx
import review_jobs
from routers import dxx_routes

FENG_HTML = (
    "<table class=\"table stock\">"
    "<tr><td code='688356' class='fd' ><b>键凯科技<i><p>疫苗</p><p>2板</p></i></b>"
    "<br><span>30.3亿</span> | <span>32.7亿</span> | <span>32.9亿</span></td></tr>"
    "</table>"
)

FUPAN_HTML = (
    "<div>2026-08-24 涨停复盘</div>"
    "<button>情绪指标:40</button>"
    "<span>涨停家数:46</span>"
    "<span>跌停家数:11</span>"
    "<span>封板率:74.2%</span>"
    "<span>涨停表现:0.67%</span>"
    "<span>连板表现:2.94%</span>"
)


def test_parse_fengdan_rows_and_th():
    out = dxx.parse_fengdan({
        "2026-08-21": {
            "t15": "58.7亿", "t20": "38亿", "t25": "44.4亿",
            "th": "2026-08-21<br><span>一字:6个  |  封单:44.4亿</span>",
            "table": FENG_HTML,
        },
    })
    assert dxx.fengdan_ok(out)
    day = out["days"][0]
    assert day["date"] == "2026-08-21"
    assert day["yizhi"] == 6
    assert day["seal"] == "44.4亿"
    assert day["rows"][0]["code"] == "688356"
    assert day["rows"][0]["name"] == "键凯科技"
    assert day["rows"][0]["tags"] == ["疫苗", "2板"]
    assert day["rows"][0]["a25"] == "32.9亿"


def test_parse_daban_and_ztlive():
    daban = dxx.parse_daban({
        "list": [[
            "2015", "协鑫能科", 15.57, 10.04, 1199146905, 10.04, 72575270, 0.7,
            1, 2, 3, "储能、绿色电力", 14634320094, 1, 2, -117081700, "首板", 34820,
        ]],
    })
    assert dxx.daban_ok(daban)
    row = daban["rows"][0]
    assert row["code"] == "002015"
    assert row["pct"] == 10.04
    assert row["board"] == "首板"
    zt = dxx.parse_ztlive({
        "list": [{"code": "600403", "name": "大有能源", "ztyy": "煤炭", "zt": "4天2板", "time": "14:16:58"}],
    })
    assert zt["rows"][0]["reason"] == "煤炭"
    assert zt["count"] == 1


def test_parse_curves_fupan_wajue():
    qx = dxx.parse_qingxu({"series": {"QX": ["41", "48"], "ZT": [None, 54]}}, n=10)
    assert qx["last"]["QX"] == 48
    assert qx["series"]["QX"] == [41.0, 48.0]
    live = dxx.parse_qxlive({"qxlast": {"QX": [65, 48], "ZT": [10, 54]}})
    assert live["last"]["ZT"] == 54
    strong = dxx.parse_strong({
        "legend": ["储能"],
        "series": [{"name": "储能", "type": "line", "data": [1, 2, 3]}],
    })
    assert strong["last"]["储能"] == 3
    fp = dxx.parse_fupan({"htmlcopy": FUPAN_HTML})
    assert fp["date"] == "2026-08-24"
    assert fp["qx"] == 40
    assert fp["zt"] == 46
    assert fp["seal_rate"] == 74.2
    wj = dxx.parse_wajue({"match": {"002183": 5413, "000671": 12}}, names={"002183": "怡亚通"})
    assert wj["rows"][0] == {"code": "002183", "name": "怡亚通", "hits": 5413}


def test_board_inject_fetch():
    def fetch(path: str):
        if path.endswith("getFengdanLast"):
            return {"2026-08-21": {"t15": "1亿", "t20": "1亿", "t25": "1亿", "th": "一字:1个 | 封单:1亿", "table": FENG_HTML}}
        if path.endswith("getDabanData"):
            return {"list": [["600000", "浦发", 10, 1, 1, 1, 1, 1, 1, 1, 1, "银行", 1, 1, 1, 1, "首板", 1]]}
        if path.endswith("getZtliveData"):
            return {"list": [{"code": "600000", "name": "浦发", "ztyy": "银行", "zt": "首板", "time": "09:30:00"}]}
        if path.endswith("getChartByQingxu"):
            return {"series": {"QX": [1, 2]}}
        if path.endswith("getLastQxlive"):
            return {"qxlast": {"QX": [2]}}
        if path.endswith("getLiveByStrong"):
            return {"legend": ["银行"], "series": [{"name": "银行", "data": [1]}]}
        if path.endswith("getFupanByYidong"):
            return {"htmlcopy": FUPAN_HTML}
        if path.endswith("getWajueMatch"):
            return {"match": {"600000": 9}}
        raise AssertionError(path)

    out = dxx.board(fetch=fetch)
    assert dxx.board_ok(out)
    assert out["src"] == dxx.SRC
    assert out["fengdan"]["days"][0]["rows"][0]["code"] == "688356"
    assert out["daban"]["rows"][0]["name"] == "浦发"
    assert out["fupan"]["zt"] == 46


def test_http_key_not_in_review_jobs():
    src = inspect.getsource(dxx_routes._part)
    assert '"dxx"' in src and "_cached" in src and "_serve" in src
    route = inspect.getsource(dxx_routes.dxx_board)
    assert "dxx.SRC" in route and "60" in route
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    assert "dxx" not in warm
    assert "dxx" not in live
    assert "duanxianxia" not in warm
    assert "getFengdanLast" not in warm
