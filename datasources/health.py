#!/usr/bin/env python3
"""数据源健康检查:按 registry.json 逐端点实跑 fetch_endpoint.py(示例标的),汇总 ok / partial / failed / 耗时 / 失败原因,写 health_report.json + health_report.md。
用法:.venv/bin/python datasources/health.py [--out DIR] [--only id1,id2] [--layer 前缀] [--workers 4] [--timeout 150] [--include-disabled]
示例标的:cn6 → 300308;us → AAPL;hk → 00700;global → AAPL;raw → 端点 sample 字段;none → 不传。结果仅供评估可达性与契约形状,不作为研究证据。"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
REG = os.path.join(HERE, "registry.json")
FETCH = os.path.join(REPO, ".agents", "skills", "data-access", "scripts", "fetch_endpoint.py")
SAMPLE = {"cn6": "300308", "us": "AAPL", "hk": "00700", "global": "AAPL"}


def run_one(ep: dict, out_dir: str, timeout: int, python: str) -> dict:
    kind = ep.get("symbol_kind", "cn6")
    sym = ep.get("sample") or SAMPLE.get(kind)
    if ep.get("module") == "legacy":  # Phase 0 独立脚本:直接跑脚本本身,且总是带 --symbol(与编排器 fetchArgv 一致;trade_calendar 也要求 --symbol)
        cmd = [python, os.path.join(os.path.dirname(FETCH), ep["function"]), "--symbol", sym or SAMPLE["cn6"], "--out-dir", out_dir]
    else:
        cmd = [python, FETCH, "--endpoint", ep["id"], "--out-dir", out_dir]
        if kind != "none" and sym:
            cmd += ["--symbol", sym]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        dur = round(time.time() - t0, 1)
        try:
            d = json.loads(p.stdout)
        except json.JSONDecodeError:
            return {"id": ep["id"], "status": "crash", "exit": p.returncode, "seconds": dur, "error": (p.stderr or p.stdout)[-300:]}
        # A broken endpoint must be reported, not crash the diagnostic itself.
        valid = isinstance(d, dict) and d.get("status") in ("ok", "partial", "failed")
        if valid:
            valid = all(d.get(k) is None or isinstance(d[k], list) for k in ("evidence", "missing", "errors"))
            valid = valid and (d.get("extra") is None or isinstance(d["extra"], dict))
        if valid:
            extra = d.get("extra") or {}
            valid = (extra.get("raw_files") is None or isinstance(extra["raw_files"], list)) and (
                extra.get("degraded") is None or isinstance(extra["degraded"], str))
            valid = valid and all(isinstance(e, dict) and isinstance(e.get("error", ""), str) for e in (d.get("errors") or []))
        if not valid:
            return {"id": ep["id"], "status": "crash", "exit": p.returncode, "seconds": dur,
                    "error": "端点响应结构无效（status 或证据/错误/extra 字段不符合信封契约）",
                    "symbol": sym or "-", "layer": ep.get("layer"), "source": ep.get("source")}
        return {"id": ep["id"], "status": d.get("status"), "exit": p.returncode, "seconds": dur, "evidence": len(d.get("evidence") or []), "missing": len(d.get("missing") or []),
                "raw_files": len((d.get("extra") or {}).get("raw_files") or []), "error": (d.get("errors") or [{}])[0].get("error", "")[:200] if d.get("errors") else "", "degraded": (d.get("extra") or {}).get("degraded", ""),
                "symbol": sym or "-", "layer": ep.get("layer"), "source": ep.get("source"), "compliance": ep.get("compliance")}
    except subprocess.TimeoutExpired:
        return {"id": ep["id"], "status": "timeout", "exit": None, "seconds": timeout, "error": f"超过 {timeout}s", "symbol": sym or "-", "layer": ep.get("layer"), "source": ep.get("source")}
    except (OSError, UnicodeError) as error:
        return {"id": ep["id"], "status": "crash", "exit": None, "seconds": round(time.time() - t0, 1),
                "error": f"无法运行或读取端点输出：{type(error).__name__}", "symbol": sym or "-",
                "layer": ep.get("layer"), "source": ep.get("source")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, ".local", "health", datetime.now().strftime("%Y%m%d-%H%M%S")))
    ap.add_argument("--only", default="")
    ap.add_argument("--layer", default="")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=150)
    ap.add_argument("--include-disabled", action="store_true")
    ap.add_argument("--python", default=sys.executable)
    a = ap.parse_args()
    # 产物只写用户数据区 .local/health(产品 / 用户数据分离;防误传仓库或他人路径覆盖同名文件)
    health_root = os.path.realpath(os.path.join(REPO, ".local", "health"))
    out_abs = os.path.realpath(os.path.abspath(a.out))
    if out_abs != health_root and not out_abs.startswith(health_root + os.sep):
        raise SystemExit(f"--out 必须在 {health_root} 之内,收到 {a.out}")
    a.out = out_abs
    reg = json.load(open(REG, encoding="utf-8"))
    eps = [e for e in reg["endpoints"] if (a.include_disabled or e.get("enabled", True))]
    if a.only:
        want = set(a.only.split(","))
        eps = [e for e in eps if e["id"] in want]
    if a.layer:
        eps = [e for e in eps if str(e.get("layer", "")).startswith(a.layer)]
    os.makedirs(os.path.join(a.out, "fetch"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "raw"), exist_ok=True)
    results = []
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(run_one, e, a.out, a.timeout, a.python): e for e in eps}
        for f in as_completed(futs):
            r = f.result()
            results.append(r)
            print(f"{r['status']:8s} {r['id']:28s} {r.get('seconds', '')}s ev={r.get('evidence', '-')} {r.get('error', '')[:80]}", flush=True)
    results.sort(key=lambda r: r["id"])
    tally = {}
    for r in results:
        tally[r["status"]] = tally.get(r["status"], 0) + 1
    report = {"generated_at": datetime.now().isoformat(timespec="seconds"), "registry_version": reg.get("version"), "endpoints_total": len(reg["endpoints"]), "tested": len(results), "tally": tally, "results": results,
              "note": "健康检查结果只反映本机网络 / 该时刻源状态,不作为研究证据;需鉴权端点(auth_env)未配置时按 failed 计"}
    json.dump(report, open(os.path.join(a.out, "health_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    lines = [f"# 数据源健康检查 {report['generated_at']}", "", f"注册表 {report['registry_version']},端点 {report['endpoints_total']} 个,测试 {len(results)} 个:" + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())), "",
             "| 端点 | 层 | 源 | 状态 | 证据数 | 耗时 s | 备注 |", "|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['id']} | {r.get('layer', '')} | {r.get('source', '')} | {r['status']} | {r.get('evidence', '-')} | {r.get('seconds', '')} | {(r.get('error') or r.get('degraded') or '')[:90].replace('|', '/')} |")
    open(os.path.join(a.out, "health_report.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(json.dumps(tally, ensure_ascii=False), "→", a.out)


if __name__ == "__main__":
    main()
