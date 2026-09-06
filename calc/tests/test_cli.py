"""cli.py 测试:退出码语义、calculation_id 身份规则、引用校验、序列文件加载与路径安全、错误分类。"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(ROOT, "calc", "cli.py")
sys.path.insert(0, ROOT)
from calc import cli  # noqa: E402


def run(*args):
    p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True)
    return p.returncode, (json.loads(p.stdout) if p.stdout.strip() else None)


def test_ok_exit_zero_and_refs_normalized():
    rc, out = run("peg", "--args", '{"pe": 30, "cagr": 0.3}', "--evidence", "ev-bbbbbb", "ev-aaaaaa", "ev-aaaaaa",
                  "--calc", "calc-0123456789ab")
    assert rc == 0
    assert out["output"]["status"] == "ok" and out["output"]["value"] == 1.0
    assert out["output"]["display"] == "1.00 倍"  # 0.3.2:展示字符串随记录落盘
    assert out["inputs_refs"] == [{"ref_type": "calculation", "ref_id": "calc-0123456789ab"},
                                  {"ref_type": "evidence", "ref_id": "ev-aaaaaa"},
                                  {"ref_type": "evidence", "ref_id": "ev-bbbbbb"}]  # 去重 + 排序
    assert out["calculation_id"].startswith("calc-") and len(out["calculation_id"]) == 5 + 16


def test_bad_refs_exit_three():
    for args in (["--evidence", "bad"], ["--evidence", "calc-aaaaaa"], ["--calc", "ev-aaaaaa"], ["--evidence", ""]):
        rc, out = run("peg", "--args", '{"pe": 30, "cagr": 0.3}', *args)
        assert rc == 3 and out["output"]["details"]["kind"] == "bad_refs", out


def test_calculation_id_identity_rules():
    base = cli.run("peg", {"pe": 30, "cagr": 0.3}, ["ev-aaaaaa"])["calculation_id"]
    assert cli.run("peg", {"cagr": 0.3, "pe": 30}, ["ev-aaaaaa"])["calculation_id"] == base       # 键序无关
    assert cli.run("peg", {"pe": 30.0, "cagr": 0.3}, ["ev-aaaaaa"])["calculation_id"] == base     # 30 与 30.0 同
    assert cli.run("peg", {"pe": 30, "cagr": 0.3}, ["ev-aaaaaa", "ev-aaaaaa"])["calculation_id"] == base  # 重复引用去重
    assert cli.run("peg", {"pe": 31, "cagr": 0.3}, ["ev-aaaaaa"])["calculation_id"] != base       # 实参变
    assert cli.run("peg", {"pe": 30, "cagr": 0.3}, ["ev-bbbbbb"])["calculation_id"] != base       # 引用 DAG 变
    assert cli.run("peg", {"pe": 30, "cagr": 0.3}, [])["calculation_id"] != base
    zero_a = cli.run("growth_rate", {"current": 0.0, "base": 1}, [])["calculation_id"]
    zero_b = cli.run("growth_rate", {"current": -0.0, "base": 1}, [])["calculation_id"]
    assert zero_a == zero_b  # -0.0 / 0.0 规范化


@pytest.mark.parametrize("kind", ["history_csv", "history_json"])
@pytest.mark.parametrize("alias", ["raw/./x", "raw/sub/../x", "raw//x", "raw/../raw/x"])
def test_series_paths_reject_ambiguous_spelling_before_creating_an_identity(tmp_path, kind, alias):
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "sub").mkdir()
    (raw / "x").write_text("v\n10\n20\n" if kind == "history_csv" else '{"rows":[{"close":10},{"close":20}]}')
    spec = {"raw_ref": alias, **({"column": "v"} if kind == "history_csv" else {"rows_path": "rows", "columns": {"date": "date", "close": "close"}})}
    with pytest.raises(ValueError, match="规范相对路径"):
        cli.resolve_inputs({"history": {kind: spec}}, str(tmp_path))


def test_not_meaningful_exit_two():
    rc, out = run("peg", "--args", '{"pe": 30, "cagr": 0}')
    assert rc == 2 and out["output"]["status"] == "not_meaningful" and out["output"]["value"] is None


def test_unknown_function_and_bad_json_and_bad_args():
    rc, out = run("no_such_fn", "--args", "{}")
    assert rc == 3 and out["output"]["status"] == "error" and out["calculation_id"] is None
    rc, out = run("peg", "--args", "{not json")
    assert rc == 3 and out["output"]["details"]["kind"] == "bad_args"
    rc, out = run("peg", "--args", '{"pe": 30, "growth": 0.3}')
    assert rc == 3 and out["output"]["details"]["kind"] == "bad_args"


def test_internal_error_classification(monkeypatch):
    """纯函数抛异常属于库缺陷,必须标 internal_error 而不是参数错误。"""
    def boom(pe, cagr):
        raise RuntimeError("bug")
    monkeypatch.setitem(cli.FUNCTIONS, "peg", boom)
    out = cli.run("peg", {"pe": 1, "cagr": 0.2}, [])
    assert out["output"]["status"] == "error" and out["output"]["details"]["kind"] == "internal_error"


def test_args_file(tmp_path):
    f = tmp_path / "a.json"
    f.write_text(json.dumps({"price": 100, "eps_forecast": 4}), encoding="utf-8")
    rc, out = run("forward_pe", "--args-file", str(f))
    assert rc == 0 and out["output"]["value"] == 25.0


def test_list():
    rc, out = run("list")
    assert rc == 0 and "quarterize" in out["functions"] and "forward_vs_ttm_judgement" in out["functions"]
    assert len(out["functions"]) == 19


def test_series_function_via_cli():
    args = {"cumulative": [{"period": "2025-03-31", "value": 100}, {"period": "2025-06-30", "value": 250}]}
    rc, out = run("quarterize", "--args", json.dumps(args))
    assert rc == 0 and [s["value"] for s in out["output"]["details"]["series"]] == [100, 150]


def _make_run_dir(tmp_path, values=None):
    raw = tmp_path / "raw"
    raw.mkdir()
    values = values or list(range(1, 26))
    rows = ["date,peTTM,tradestatus"] + [f"2025-01-{i:02d},{v},1" for i, v in enumerate(values, 1)] + ["2025-02-01,999,0"]
    (raw / "pe.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    return tmp_path


def test_history_csv_loading_and_identity(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    spec = {"history": {"history_csv": {"raw_ref": "raw/pe.csv", "column": "peTTM", "where": {"tradestatus": "1"}}}, "current": 25}
    rc, out = run("percentile_rank", "--args", json.dumps(spec), "--run-dir", str(run_dir), "--evidence", "ev-aaaaaa")
    assert rc == 0, out
    assert out["output"]["value"] == 100.0 and out["output"]["details"]["n"] == 25  # 停牌行(999)被 where 过滤
    rec = out["inputs_resolved"]["history"]
    assert rec["rows_total"] == 26 and rec["rows_used"] == 25 and len(rec["sha256"]) == 64
    id1 = out["calculation_id"]
    # 同路径不同内容 → 不同 id;不同 where → 不同 id
    (run_dir / "raw" / "pe.csv").write_text("date,peTTM,tradestatus\n" + "\n".join(f"2025-01-{i:02d},{i},1" for i in range(1, 26)) + "\n")
    rc, out2 = run("percentile_rank", "--args", json.dumps(spec), "--run-dir", str(run_dir), "--evidence", "ev-aaaaaa")
    assert out2["calculation_id"] != id1 and out2["inputs_resolved"]["history"]["sha256"] != rec["sha256"]
    spec2 = json.loads(json.dumps(spec))
    spec2["history"]["history_csv"]["where"] = {}
    rc, out3 = run("percentile_rank", "--args", json.dumps(spec2), "--run-dir", str(run_dir), "--evidence", "ev-aaaaaa")
    assert out3["calculation_id"] not in (id1, out2["calculation_id"])


def test_history_csv_period_tracks_filtered_dates(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    spec = {"history": {"history_csv": {"raw_ref": "raw/pe.csv", "column": "peTTM",
            "where": {"tradestatus": "1"}, "date_column": "date"}}, "current": 25}
    rc, out = run("percentile_rank", "--args", json.dumps(spec), "--run-dir", str(run_dir))
    assert rc == 0
    assert out["inputs_resolved"]["history"]["period"] == "2025-01-01..2025-01-25"
    assert out["inputs_resolved"]["history"]["date_column"] == "date"


def test_history_csv_path_safety(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    outside = tmp_path.parent / f"{tmp_path.name}-outside.csv"
    outside.write_text("date,peTTM,tradestatus\n2025-01-01,1,1\n")
    (run_dir / "fetch").mkdir()
    (run_dir / "fetch" / "x.csv").write_text("date,peTTM,tradestatus\n2025-01-01,1,1\n")
    os.symlink(outside, run_dir / "raw" / "link.csv")
    cases = [
        {"raw_ref": "../outside.csv", "column": "peTTM"},                 # 相对越界
        {"raw_ref": str(outside), "column": "peTTM"},                      # 绝对路径越界
        {"raw_ref": "fetch/x.csv", "column": "peTTM"},                     # 运行目录内但不在 raw/
        {"raw_ref": "raw/link.csv", "column": "peTTM"},                    # symlink 指向目录外
        {"raw_ref": "raw/pe.csv", "column": "nope"},                       # 列不存在
        {"raw_ref": "raw/missing.csv", "column": "peTTM"},                 # 文件不存在
    ]
    for c in cases:
        rc, out = run("percentile_rank", "--args", json.dumps({"history": {"history_csv": c}, "current": 1}), "--run-dir", str(run_dir))
        assert rc == 3 and out["output"]["details"]["kind"] == "bad_input", c
    rc, out = run("percentile_rank", "--args", json.dumps({"history": {"history_csv": {"raw_ref": "raw/pe.csv", "column": "peTTM"}}, "current": 1}))
    assert rc == 3  # 无 run-dir


def test_forward_vs_ttm_judgement_via_cli():
    rc, out = run("forward_vs_ttm_judgement", "--args", '{"forward_cagr_value": 0.50, "ttm_yoy_value": 0.52}')
    assert rc == 0 and out["output"]["details"]["category"] == "approx"
    rc, out = run("forward_vs_ttm_judgement", "--args", '{"forward_cagr_value": 0.80, "ttm_yoy_value": 0.30}')
    assert out["output"]["details"]["category"] == "forward_above"
    rc, out = run("forward_vs_ttm_judgement", "--args", '{"forward_cagr_value": 0.10, "ttm_yoy_value": 0.60, "tolerance_pp": 20}')
    assert out["output"]["details"]["category"] == "forward_below"


def test_main_paths_direct(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["cli", "list"])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 0 and "functions" in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["cli", "peg", "--args", '{"pe": 30, "cagr": 0}'])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 2
    monkeypatch.setattr(sys, "argv", ["cli", "nope"])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 3


def test_dump_rejects_nan(monkeypatch):
    bad = {"calculation_id": "calc-x", "output": {"status": "ok", "value": float("nan"), "unit": "", "reason": "", "details": {}}}
    s = cli._dump(bad)
    assert "nonfinite_output" in s and "NaN" not in s


def test_nan_literal_in_args_is_structured_error():
    """输入 JSON 含 NaN/Infinity 字面量:必须退出码 3、stdout 为严格 JSON、无 traceback。"""
    for bad in ('{"pe": NaN, "cagr": 0.3}', '{"pe": Infinity, "cagr": 0.3}', '{"pe": -Infinity, "cagr": 0.3}'):
        p = subprocess.run([sys.executable, CLI, "peg", "--args", bad], capture_output=True, text=True)
        assert p.returncode == 3 and "Traceback" not in p.stderr
        out = json.loads(p.stdout)  # 严格 JSON
        assert out["output"]["status"] == "error" and out["output"]["details"]["kind"] == "bad_args"


def test_dump_fallback_is_clean_even_if_inputs_contain_nan():
    bad = {"calculation_id": "calc-x", "function": "peg", "calc_version": "x", "inputs": {"pe": float("nan")},
           "inputs_resolved": {}, "inputs_refs": [], "output": {"status": "ok", "value": float("nan"), "unit": "", "reason": "", "details": {}}}
    s = cli._dump(bad)
    out = json.loads(s)
    assert out["output"]["details"]["kind"] == "nonfinite_output" and out["inputs"] is None


def test_absolute_raw_ref_rejected_even_inside_raw(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    abs_inside = str(run_dir / "raw" / "pe.csv")
    rc, out = run("percentile_rank", "--args", json.dumps({"history": {"history_csv": {"raw_ref": abs_inside, "column": "peTTM"}}, "current": 1}),
                  "--run-dir", str(run_dir))
    assert rc == 3 and out["output"]["details"]["kind"] == "bad_input"
