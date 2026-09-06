"""Exercise the actual JSON tool process, including its display projection."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from calc import formulas
from calc.display import attach_display


REPO = Path(__file__).resolve().parents[2]


def run_tool(request):
    completed = subprocess.run(
        [sys.executable, "-m", "calc.tool"],
        cwd=REPO,
        input=json.dumps(request, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert completed.stderr == b""
    return completed.returncode, json.loads(completed.stdout.decode("utf-8"))


@pytest.mark.parametrize("fn,args", [
    ("pe_digestion_years", {"pe": 40, "cagr": 0.3, "anchor": 25}),
    ("growth_rate", {"current": 120, "base": 100, "label": "收入同比"}),
    ("pe_digestion_scenarios", {"pe": 40, "cagr": 0.3}),
    ("pe_digestion_years", {"pe": 40, "cagr": -0.1, "anchor": 25}),
])
def test_tool_returns_display_without_changing_formula_result(fn, args):
    code, payload = run_tool({"fn": fn, "args": args})
    expected = attach_display(getattr(formulas, fn)(**args))
    assert code == 0
    assert payload == {"ok": True, "fn": fn, "result": expected}
    assert "display" in payload["result"]
    if fn == "pe_digestion_scenarios":
        assert payload["result"]["display"] is None
        scenarios = payload["result"]["details"]["scenarios"]
        assert len(scenarios) == 4
        assert all(item["display"].endswith("年") for item in scenarios.values())


@pytest.mark.parametrize("payload_input", [
    {"fn": "unknown", "args": {}},
    {"fn": "growth_rate", "args": []},
    {"fn": "growth_rate", "args": {"current": 120}},
])
def test_tool_input_errors_remain_explicit(payload_input):
    code, payload = run_tool(payload_input)
    assert code == 2
    assert payload["ok"] is False
    assert payload["error"]
    assert "result" not in payload


def test_tool_catalog_remains_a_non_calculation_response():
    code, payload = run_tool({"catalog": True})
    assert code == 0
    assert payload["ok"] is True
    assert "growth_rate" in payload["catalog"]
    assert "result" not in payload
