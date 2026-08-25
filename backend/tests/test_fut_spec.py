"""Local parked capital: qihuo_fee + future-ts months, not future-ts-all / warmup."""
from __future__ import annotations

import inspect

import fut_spec
import ovlab
import review_jobs
from routers import ovlab_routes


_IM_TS = {
    "202609": {"future_tday": 7466.2, "oi_tday": 255263.0},
    "202610": {"future_tday": 7401.1, "oi_tday": 7365.0},
    "202612": {"future_tday": 7253.4, "oi_tday": 137323.0},
    "202703": {"future_tday": 7047.3, "oi_tday": 59216.0},
}


def test_im_formula_matches_known():
    y = fut_spec.parked_from_ts(_IM_TS, 200, 0.12)
    assert y is not None and abs(y - 80_969_406_650.4) < 1.0


def test_empty_and_unknown():
    assert fut_spec.parked_from_ts({}, 200, 0.12) is None
    assert fut_spec.parked_from_ts({"x": {"future_tday": 1}}, 200, 0.12) is None
    assert not hasattr(fut_spec, "SPEC")


def test_parked_uses_month_margin():
    ts = {
        "202609": {"future_tday": 100.0, "oi_tday": 10.0},
        "202612": {"future_tday": 100.0, "oi_tday": 10.0},
    }
    y = fut_spec.parked_from_ts(ts, 15, 0.12, {"202609": 0.22, "202612": 0.16})
    assert y is not None and abs(y - 15 * (100 * 10 * 0.22 + 100 * 10 * 0.16)) < 1e-6


def test_get_parked_reuses_future_ts_not_all(monkeypatch):
    import qihuo_fee

    calls: list[str] = []

    def fake_ts(und: str):
        calls.append(und)
        return _IM_TS if und == "IM" else {}

    monkeypatch.setattr(ovlab, "get_market_overview", lambda: [
        {"prodUnd": "IM", "product": "MO"},
        {"prodUnd": "510300", "product": "300ETF"},
        {"prodUnd": "XX", "product": "XX_O"},
    ])
    monkeypatch.setattr(ovlab, "get_future_term_structure", fake_ts)
    monkeypatch.setattr(ovlab, "deriv_market_open", lambda: True)
    monkeypatch.setattr(qihuo_fee, "margins", lambda: {
        "src": qihuo_fee.SRC,
        "months": {"IM": {k: 0.12 for k in _IM_TS}},
        "main": {"IM": "202609"},
        "mults": {"IM": 200},
        "n": 4,
    })
    ovlab._CACHE.pop("ovlab_parked", None)
    out = ovlab.get_parked_capital()
    assert [r["und"] for r in out["rows"]] == ["IM"]
    assert calls == ["IM"]
    assert out["rows"][0]["margin"] == 0.12
    assert out["rows"][0]["mult"] == 200
    src = inspect.getsource(ovlab.get_parked_capital)
    assert "ovlab_parked" in src and "300" in src
    assert "qihuo_fee" in src
    assert "get_future_term_structures_all" not in src
    assert "get_future_term_structure" in inspect.getsource(ovlab._parked_one)


def test_http_and_not_in_review_or_warm():
    route = inspect.getsource(ovlab_routes.ovlab_parked)
    assert "get_parked_capital" in route
    warm_jobs = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    warm_ov = inspect.getsource(ovlab.warm_once)
    assert "ovlab_parked" not in warm_jobs
    assert "parked" not in live
    assert "get_parked_capital" not in warm_ov
    assert "future-ts-all" in warm_ov  # comment says do not warm all
