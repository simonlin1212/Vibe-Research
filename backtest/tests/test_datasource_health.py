"""The diagnostic must survive an endpoint violating the envelope contract."""
import json
import subprocess

import pytest

from datasources import health


@pytest.mark.parametrize("envelope", [{}, None, [], {"status": "unknown"},
    {"status": "ok", "evidence": {}}, {"status": "ok", "errors": ["broken"]},
    {"status": "ok", "extra": []}, {"status": "ok", "errors": [{"error": None}]}])
def test_invalid_envelope_is_reportable_crash_not_a_second_exception(monkeypatch, tmp_path, envelope):
    monkeypatch.setattr(health.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], 0, json.dumps(envelope), ""))
    result = health.run_one({"id": "broken", "symbol_kind": "none"}, str(tmp_path), 1, "fake")
    assert result["status"] == "crash"
    assert result["error"]
    assert f"{result['status']:8s}"
    json.dumps(result, allow_nan=False)


def test_partial_envelope_keeps_real_counts(monkeypatch, tmp_path):
    payload = {"status": "partial", "evidence": [{"id": "one"}], "missing": ["gap"],
               "errors": [{"error": "source unavailable"}], "extra": {"raw_files": ["raw/x"], "degraded": "partial source"}}
    monkeypatch.setattr(health.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], 2, json.dumps(payload), ""))
    result = health.run_one({"id": "sample"}, str(tmp_path), 1, "fake")
    assert result["status"] == "partial"
    assert result["evidence"] == result["missing"] == result["raw_files"] == 1
    assert result["exit"] == 2


def test_missing_interpreter_is_reportable(monkeypatch, tmp_path):
    def missing(*a, **k):
        raise FileNotFoundError("missing interpreter")
    monkeypatch.setattr(health.subprocess, "run", missing)
    result = health.run_one({"id": "sample"}, str(tmp_path), 1, "fake")
    assert result["status"] == "crash"
