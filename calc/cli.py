#!/usr/bin/env python3
"""calc 命令行入口:agent / 编排器只通过它做计算,结果带确定性 calculation_id,可直接写入 calculations.json。

用法:
  python3 calc/cli.py <function> --args '<JSON 对象>' [--evidence ev-... ...] [--calc calc-... ...] [--run-dir DIR]
  python3 calc/cli.py <function> --args-file args.json
  python3 calc/cli.py list
示例:
  python3 calc/cli.py pe_deducted_annualized --args '{"total_market_cap": 1000, "cap_unit": "亿元", "latest_quarter_deducted_profit": 1e9, "profit_unit": "元"}' --evidence ev-aaa ev-bbb
  python3 calc/cli.py percentile_rank --args '{"history": {"history_csv": {"raw_ref": "raw/xxx.csv", "column": "peTTM", "where": {"tradestatus": "1"}, "date_column": "date"}}, "current": 73.8}' --run-dir .local/runs/x --evidence ev-hist
  python3 calc/cli.py technical_indicators --args '{"klines": {"history_json": {"raw_ref": "raw/tencent_fqkline.json", "rows_path": "data.sz300308.qfqday", "columns": {"date": 0, "open": 1, "close": 2, "high": 3, "low": 4}}}}' --run-dir .local/runs/x --evidence ev-kline
  python3 calc/cli.py chip_distribution --args '{"klines": {"history_json": {"raw_ref": "raw/extracted_baostock_....json", "rows_path": "rows", "columns": {"date": "date", "high": "high", "low": "low", "close": "close", "turn": "turn"}, "where": {"tradestatus": "1"}}}}' --run-dir .local/runs/x --evidence ev-bs

身份(calculation_id):sha256 的前 16 hex,输入 = function + calc_version + 规范化实参(其中 history_csv 被替换为
  {raw_ref, column, where, sha256, rows_used})+ 规范化 inputs_refs(按类型 / id 排序去重)。
  同一文件内容变化、过滤条件变化、引用 DAG 变化 → 不同 id;键序与 -0.0/0.0 差异不影响 id。
输入引用:--evidence 必须形如 ev-xxx,--calc 必须形如 calc-xxx;空 / 类型错配 → error 退出码 3。
序列输入:参数值形如 {"history_csv": {raw_ref, column, where}} 时从 <run-dir>/raw/ 确定性加载(raw_ref 必须是相对路径;
  realpath 校验,文件必须位于 raw/ 内,拒绝符号链接越界),加载记录写入 inputs_resolved。
输入 JSON 严格解析:NaN / Infinity 字面量 → bad_args 退出码 3。
输出(stdout,严格 JSON,allow_nan=False;兜底信封不回显原始输入):
  {calculation_id, function, calc_version, inputs, inputs_resolved, inputs_refs, output:{status,value,unit,reason,details,display}}
  display = 展示层字符串(calc/display.py 确定性格式化;status ≠ ok 时为 null),报告正文照抄它、不抄 value 原始浮点。
退出码:0 = ok;2 = not_meaningful;3 = error(含参数错误 / 未知函数 / 库内部异常 internal_error)。
"""
from __future__ import annotations

import argparse
import csv
from datetime import date
import hashlib
import inspect
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from calc import formulas, indicators, series  # noqa: E402
from calc.formulas import CALC_VERSION  # noqa: E402
from calc.display import attach_display  # noqa: E402
from calc.stdio_utf8 import force_utf8_stdio  # noqa: E402

FUNCTIONS = {
    "pe_deducted_annualized": formulas.pe_deducted_annualized,
    "forward_pe": formulas.forward_pe,
    "pe_ttm_from_parts": formulas.pe_ttm_from_parts,
    "forward_cagr": formulas.forward_cagr,
    "growth_rate": formulas.growth_rate,
    "ratio": formulas.ratio,
    "peg": formulas.peg,
    "pe_digestion_years": formulas.pe_digestion_years,
    "pe_digestion_scenarios": formulas.pe_digestion_scenarios,
    "percentile_rank": formulas.percentile_rank,
    "consensus_dispersion": formulas.consensus_dispersion,
    "forward_vs_ttm_judgement": formulas.forward_vs_ttm_judgement,
    "quarterize": series.quarterize,
    "latest_quarter": series.latest_quarter,
    "ttm_sum": series.ttm_sum,
    "ttm_yoy": series.ttm_yoy,
    "qoq": series.qoq,
    "technical_indicators": indicators.technical_indicators,
    "chip_distribution": indicators.chip_distribution,
}
REF_PATTERNS = {"evidence": re.compile(r"^ev-[0-9a-f]{6,}$"), "calculation": re.compile(r"^calc-[0-9a-f]{6,}$")}


def _error_out(reason: str, kind: str = "error") -> dict:
    return {"status": "error", "value": None, "unit": "", "reason": reason, "details": {"kind": kind}, "display": None}


def _canon(obj):
    """规范化用于哈希:整数值浮点转 int(含 -0.0 → 0),dict 键排序。"""
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return int(obj) if obj.is_integer() else obj  # 30.0 → 30,-0.0 → 0:数值相等则身份相等
    if isinstance(obj, dict):
        return {str(k): _canon(obj[k]) for k in sorted(obj, key=str)}
    if isinstance(obj, (list, tuple)):
        return [_canon(v) for v in obj]
    return obj


def normalize_refs(evidence_ids: list, calc_ids: list) -> list[dict]:
    refs = []
    for kind, ids in (("evidence", evidence_ids), ("calculation", calc_ids)):
        for rid in ids:
            rid = str(rid).strip()
            if not REF_PATTERNS[kind].match(rid):
                raise ValueError(f"{kind} 引用 {rid!r} 格式非法(evidence 形如 ev-xxxx,calculation 形如 calc-xxxx)")
            refs.append({"ref_type": kind, "ref_id": rid})
    uniq = {(r["ref_type"], r["ref_id"]): r for r in refs}
    return [uniq[k] for k in sorted(uniq)]


def _load_history_csv(spec: dict, run_dir: str | None) -> tuple[list, dict]:
    """从 <run_dir>/raw/ 确定性加载一列数值:返回 (values, 解析记录)。realpath 校验,拒绝越出 raw/。"""
    if not run_dir:
        raise ValueError("history_csv 需要 --run-dir")
    if not isinstance(spec, dict):
        raise ValueError("history_csv 必须是对象 {raw_ref, column, where}")
    rel = str(spec.get("raw_ref") or "")
    col = spec.get("column")
    where = spec.get("where") or {}
    if not rel or not col:
        raise ValueError("history_csv 需要 raw_ref 与 column")
    target = _raw_target(rel, run_dir, "history_csv")
    data = target.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    rows = list(csv.DictReader(data.decode("utf-8").splitlines()))
    if not rows or col not in rows[0]:
        raise ValueError(f"CSV 无列 {col!r}")
    selected = [r for r in rows if all(str(r.get(k)) == str(v) for k, v in where.items())]
    vals = [r[col] for r in selected]
    record = {"raw_ref": rel, "sha256": sha, "column": col, "where": where, "rows_total": len(rows), "rows_used": len(vals)}
    if "date_column" in spec:
        date_col = spec["date_column"]
        if not isinstance(date_col, str) or date_col not in rows[0] or not selected:
            raise ValueError("history_csv 日期列缺失或过滤后无行")
        dates = [r[date_col] for r in selected]
        if any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d or "") or date.fromisoformat(d).isoformat() != d for d in dates):
            raise ValueError("history_csv 日期必须为有效 YYYY-MM-DD")
        if dates != sorted(set(dates)):
            raise ValueError("history_csv 日期必须严格递增且不重复")
        record.update(date_column=date_col, period=f"{dates[0]}..{dates[-1]}")
    return vals, record


def _raw_target(rel: str, run_dir: str | None, kind: str) -> Path:
    """raw_ref → 运行目录 raw/ 内的真实文件(相对路径 / realpath / 非符号链接越界 / 普通文件)。"""
    if not run_dir:
        raise ValueError(f"{kind} 需要 --run-dir")
    if not rel:
        raise ValueError(f"{kind} 需要 raw_ref")
    if Path(rel).is_absolute():
        raise ValueError(f"{kind}.raw_ref 必须是运行目录内的相对路径(raw/...),不接受绝对路径:{rel!r}")
    # Path.parts erases '.' and duplicate separators before they can be checked.
    # Reject ambiguous spelling in both loaders rather than minting another ID.
    if any(part in ("..", ".", "") for part in rel.split("/")) or "\\" in rel or not rel.startswith("raw/"):
        raise ValueError(f"{kind}.raw_ref 必须使用规范相对路径 raw/<文件>，不得含 ..、.、重复或反向分隔符:{rel!r}")
    raw_root = Path(run_dir).resolve(strict=True) / "raw"
    target = (Path(run_dir) / rel).resolve(strict=True)
    try:
        target.relative_to(raw_root.resolve(strict=True))
    except ValueError as e:
        raise ValueError(f"{kind}.raw_ref 越出运行目录的 raw/:{rel!r}") from e
    if not target.is_file():
        raise ValueError(f"{kind}.raw_ref 不是文件:{rel!r}")
    return target


def _dig(obj, dotted: str):
    """按点路径取值:data.sz300308.qfqday;数字段当列表下标。"""
    cur = obj
    for part in [p for p in dotted.split(".") if p != ""]:
        if isinstance(cur, list):
            if not part.isdigit() or int(part) >= len(cur):
                raise ValueError(f"rows_path 段 {part!r} 不是有效列表下标")
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            if part not in cur:
                raise ValueError(f"rows_path 段 {part!r} 不存在(可用键:{list(cur)[:8]})")
            cur = cur[part]
        else:
            raise ValueError(f"rows_path 在 {part!r} 处遇到非容器")
    return cur


_JSONP_RE = re.compile(r"^\s*(?:/\*\*/)?([A-Za-z_$][\w$.]*)\s*\((.*)\)\s*;?\s*$", re.S)


def _parse_json_or_jsonp(data: bytes):
    """严格解析:UTF-8 必须合法;纯 JSON 直接 loads;否则只接受 <标识符>(<JSON>);? 形式的 JSONP(尾随垃圾 / 多余花括号不猜)。"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(f"history_json.raw_ref 不是合法 UTF-8:{e}") from e
    s = text.strip()
    if s.startswith("{") or s.startswith("["):
        return json.loads(s)
    m = _JSONP_RE.match(s)
    if not m:
        raise ValueError("history_json.raw_ref 既不是 JSON 也不是 <callback>(<JSON>) 形式的 JSONP")
    return json.loads(m.group(2))


def _load_history_json(spec: dict, run_dir: str | None) -> tuple[list, dict]:
    """从 <run_dir>/raw/ 的 JSON(或 JSONP:取第一个 '{' 到最后一个 '}')确定性加载一张 K 线表:
    spec = {raw_ref, rows_path: "data.sz300308.qfqday", columns: {"date": 0, "open": 1, "close": 2, "high": 3, "low": 4} 或 {"date": "date", ...}, where?: {"tradestatus": "1"}}
    返回 (rows[list[dict]], 解析记录)。行可以是数组(列给下标)或对象(列给键名);where 只对对象行生效。"""
    if not isinstance(spec, dict):
        raise ValueError("history_json 必须是对象 {raw_ref, rows_path, columns, where?}")
    rel = str(spec.get("raw_ref") or "")
    rows_path = str(spec.get("rows_path") or "")
    cols = spec.get("columns")
    where = spec.get("where") or {}
    if not isinstance(cols, dict) or not cols or "date" not in cols:
        raise ValueError("history_json.columns 必须是含 date 的映射 {字段名: 下标或键名}")
    if not isinstance(where, dict):
        raise ValueError("history_json.where 必须是对象")
    target = _raw_target(rel, run_dir, "history_json")
    data = target.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    obj = _parse_json_or_jsonp(data)
    table = _dig(obj, rows_path) if rows_path else obj
    if not isinstance(table, list):
        raise ValueError(f"history_json.rows_path={rows_path!r} 不是列表")
    kinds = {("dict" if isinstance(r, dict) else "list" if isinstance(r, (list, tuple)) else "other") for r in table}
    if "other" in kinds:
        raise ValueError("history_json 行必须是数组或对象")
    if len(kinds) > 1:
        raise ValueError("history_json 不接受数组行与对象行混合的表")
    if where and kinds == {"list"}:
        raise ValueError("history_json.where 只能用于对象行;数组行表请不要传 where")
    rows, used = [], 0
    for r in table:
        if isinstance(r, dict):
            if any(str(r.get(k)) != str(v) for k, v in where.items()):
                continue
            row = {f: r.get(src) for f, src in cols.items()}
        else:
            row = {}
            for f, src in cols.items():
                if isinstance(src, bool) or not isinstance(src, int) or src < 0 or src >= len(r):
                    raise ValueError(f"history_json.columns.{f}={src!r} 对数组行必须是有效下标")
                row[f] = r[src]
        rows.append(row)
        used += 1
    return rows, {"raw_ref": rel, "sha256": sha, "rows_path": rows_path, "columns": cols, "where": where, "rows_total": len(table), "rows_used": used}


def resolve_inputs(args: dict, run_dir: str | None) -> tuple[dict, dict, dict]:
    """返回 (可调用参数, 解析记录, 用于哈希的规范化实参)。history_csv / history_json 在哈希实参里被替换为文件身份(sha256 等)。"""
    call_args, record, ident = {}, {}, {}
    for k, v in args.items():
        if isinstance(v, dict) and "history_csv" in v:
            vals, rec = _load_history_csv(v["history_csv"], run_dir)
            call_args[k] = vals
            record[k] = rec
            ident[k] = {"history_csv": {"raw_ref": rec["raw_ref"], "column": rec["column"], "where": rec["where"],
                                        "sha256": rec["sha256"], "rows_used": rec["rows_used"]}}
            if "date_column" in rec:
                ident[k]["history_csv"].update(date_column=rec["date_column"], period=rec["period"])
        elif isinstance(v, dict) and "history_json" in v:
            rows, rec = _load_history_json(v["history_json"], run_dir)
            call_args[k] = rows
            record[k] = rec
            ident[k] = {"history_json": {"raw_ref": rec["raw_ref"], "rows_path": rec["rows_path"], "columns": rec["columns"], "where": rec["where"],
                                         "sha256": rec["sha256"], "rows_used": rec["rows_used"]}}
        else:
            call_args[k] = v
            ident[k] = v
    return call_args, record, ident


def calculation_id(function: str, ident_args: dict, refs: list[dict]) -> str:
    key = json.dumps({"f": function, "v": CALC_VERSION, "a": _canon(ident_args), "r": refs},
                     sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "calc-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def run(function: str, args: dict, evidence_ids: list | None = None, calc_ids: list | None = None,
        run_dir: str | None = None) -> dict:
    if function not in FUNCTIONS:
        return {"calculation_id": None, "function": function, "calc_version": CALC_VERSION, "inputs": args,
                "inputs_resolved": {}, "inputs_refs": [], "output": _error_out(f"未知函数 {function}")}
    fn = FUNCTIONS[function]
    try:
        refs = normalize_refs(evidence_ids or [], calc_ids or [])
    except ValueError as e:
        return {"calculation_id": None, "function": function, "calc_version": CALC_VERSION, "inputs": args,
                "inputs_resolved": {}, "inputs_refs": [], "output": _error_out(str(e), "bad_refs")}
    try:
        call_args, record, ident = resolve_inputs(args, run_dir)
    except (ValueError, OSError) as e:
        return {"calculation_id": None, "function": function, "calc_version": CALC_VERSION, "inputs": args,
                "inputs_resolved": {}, "inputs_refs": refs, "output": _error_out(f"输入解析失败:{e}", "bad_input")}
    cid = calculation_id(function, ident, refs)
    try:
        inspect.signature(fn).bind(**call_args)  # 先校验参数名,区分"调用错误"与"库内部异常"
    except TypeError as e:
        out = _error_out(f"参数错误:{e}", "bad_args")
    else:
        try:
            out = fn(**call_args)
        except Exception as e:  # noqa: BLE001 — 纯函数不应抛出;抛出即库内部缺陷,如实标记
            out = _error_out(f"库内部异常:{type(e).__name__}: {e}", "internal_error")
    return {"calculation_id": cid, "function": function, "calc_version": CALC_VERSION, "inputs": args,
            "inputs_resolved": record, "inputs_refs": refs, "output": attach_display(out)}


def _reject_constant(name: str):
    raise ValueError(f"JSON 中不允许非标准常量 {name}(NaN / Infinity),请传 null 或有限数")


def _load_json(text: str):
    """严格 JSON 解析:拒绝 NaN / Infinity / -Infinity 字面量(Python 默认会接受)。"""
    return json.loads(text, parse_constant=_reject_constant)


def _dump(obj) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False)
    except ValueError:  # 输出树含 NaN/inf(理论上被 _res 守卫挡住;此处是最后一道闸):输出全新的干净信封,不复用原对象
        safe = {"calculation_id": None, "function": str((obj or {}).get("function")), "calc_version": CALC_VERSION,
                "inputs": None, "inputs_resolved": {}, "inputs_refs": [],
                "output": _error_out("输出含非有限数,已拦截;原始输入未回显", "nonfinite_output")}
        return json.dumps(safe, ensure_ascii=False, indent=2, allow_nan=False)


def main() -> None:
    # 🔴 **必须在打任何 JSON 之前**：中文 Windows 的管道默认 GBK，
    #    含 \xa0 会当场崩、其余中文会变成 Node 按 UTF-8 读不懂的字节（上游 issue #27）。
    force_utf8_stdio()
    p = argparse.ArgumentParser(description="确定性估值计算入口")
    p.add_argument("function", help="函数名,或 list 列出全部")
    p.add_argument("--args", default=None, help="JSON 对象字符串")
    p.add_argument("--args-file", default=None, help="含 JSON 对象的文件路径")
    p.add_argument("--evidence", nargs="*", default=[], help="输入所引用的 evidence id(ev-xxxx)")
    p.add_argument("--calc", nargs="*", default=[], help="输入所引用的上游 calculation id(calc-xxxx)")
    p.add_argument("--run-dir", default=None, help="运行目录;history_csv 类输入从其下 raw/ 加载")
    a = p.parse_args()
    if a.function == "list":
        print(_dump({"calc_version": CALC_VERSION, "functions": {k: (v.__doc__ or "").strip().split("\n")[0]
                                                                 for k, v in FUNCTIONS.items()}}))
        sys.exit(0)
    try:
        if a.args_file:
            with open(a.args_file, encoding="utf-8") as f:
                args = _load_json(f.read())
        else:
            args = _load_json(a.args or "{}")
        if not isinstance(args, dict):
            raise ValueError("参数必须是 JSON 对象")
    except (ValueError, OSError) as e:
        print(_dump({"calculation_id": None, "function": a.function, "calc_version": CALC_VERSION, "inputs": None,
                     "inputs_resolved": {}, "inputs_refs": [], "output": _error_out(f"参数解析失败:{e}", "bad_args")}))
        sys.exit(3)
    if a.function == "validate":
        from calc.contracts import validate_contract
        target = args.get("function")
        target_args = args.get("args")
        error = validate_contract(target if isinstance(target, str) else "", target_args, FUNCTIONS)
        print(_dump({"valid": error is None, **({} if error is None else {"error": error})}))
        sys.exit(0 if error is None else 3)
    result = run(a.function, args, list(a.evidence), list(a.calc), a.run_dir)
    print(_dump(result))
    st = result["output"]["status"]
    sys.exit({"ok": 0, "not_meaningful": 2}.get(st, 3))


if __name__ == "__main__":
    main()
