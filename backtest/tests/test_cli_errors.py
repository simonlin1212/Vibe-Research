"""离线替换取数，真实 CLI/引擎必须返回一份可读 JSON，不能只退出。"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

REPO = Path(__file__).resolve().parents[2]


def test_catalog_names_actual_request_fields():
    from backtest.cli import _catalog
    from backtest.gate import Plan, plan_backtest

    catalog = _catalog()
    schema = catalog["input_schema"]
    assert schema["required"] == ["codes", "start", "end"]
    assert schema["properties"]["codes"]["type"] == "array"
    assert set(schema["properties"]) == {
        "codes", "start", "end", "style", "strategy", "params", "initial_cash", "allow_short",
    }
    example = catalog["example_request"]
    plan = plan_backtest(**{k: v for k, v in example.items() if k not in ("strategy", "params")})
    assert isinstance(plan, Plan)
    assert plan.codes == ["AAPL"]
    assert plan.initial_cash == 100000


@pytest.mark.parametrize("mode,reason", [
    ("failed", "测试取数端点超时"),
    ("empty", "区间内一根 bar 都没有"),
    ("mixed", "测试取数端点超时"),
    ("bad_signal", "pd.Series"),
    ("bad_signal_map", "Dict[str, pd.Series]"),
    ("no_signal", "有效信号"),
])
def test_cli_engine_failure_is_json_with_cause(tmp_path, mode, reason):
    # 子进程保留真实 UTF-8 stdio，避免 pytest 捕获器替换标准流掩盖原缺陷。
    code = f'''
import json
import pandas as pd
from pathlib import Path
from unittest.mock import patch
import backtest.run as run_module
import backtest.cli as cli
from backtest.loader import VibeLoader, LoaderError, SymbolProvenance

mode = {mode!r}
def fetch_one(self, code, start, end):
    if mode == "failed" or (mode == "mixed" and code == "600519.SH"):
        raise LoaderError("测试取数端点超时")
    index = pd.date_range("2021-01-04", periods=0 if mode == "empty" else 400 if mode == "mixed" else 600, freq="B")
    frame = pd.DataFrame({{"open": 10., "high": 10., "low": 10., "close": 10., "volume": 10.}}, index=index)
    return frame, SymbolProvenance(code=code, market="a_share", endpoint="synthetic", rows=len(frame))

class BadSignal:
    def generate(self, data):
        if mode == "bad_signal_map":
            return None
        return {{"600519.SH": [1.]}} if mode == "bad_signal" else {{}}

def run_in_test(plan, strategy):
    return run_module.run(plan, strategy, run_dir=Path({str(tmp_path)!r}))

with patch.object(VibeLoader, "_fetch_one", fetch_one), patch.object(cli, "run", run_in_test):
    if mode in ("bad_signal", "bad_signal_map", "no_signal"):
        cli.BUILTIN["synthetic"] = BadSignal
    cli.main()
'''
    request = {"codes": ["600519.SH"], "start": "2021-01-01", "end": "2025-12-31", "style": "long",
               "strategy": "synthetic" if mode in ("bad_signal", "bad_signal_map", "no_signal") else "buy_and_hold"}
    if mode == "mixed":
        request["codes"].append("300308.SZ")
    result = subprocess.run([sys.executable, "-c", code], cwd=REPO,
                            input=json.dumps(request).encode(), capture_output=True,
                            env={**os.environ, "PYTHONIOENCODING": "gbk"}, timeout=30, check=False)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    payload = json.loads(result.stdout.decode("utf-8"))
    assert payload["ok"] is False and "refused" not in payload
    assert reason in payload["error"]
    if mode in ("failed", "empty"):
        assert "600519.SH" in payload["error"]
    if mode == "mixed":
        assert "600519.SH" in payload["error"] and "400 根" in payload["error"]
    assert not list(tmp_path.glob("metrics*.json")), "错误时不能留下成功指标"
