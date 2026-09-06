import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packCriticalScripts, stages, stageScripts, makeConfig } from "../src/config.ts";
import { buildStagePlan, criticalScripts, endpointsById, fetchArgv, loadRegistry, planFileOf, regionOf } from "../src/registry.ts";
import { loadRun, validateFetchIntegrity } from "../src/validator.ts";
import { sha256File, writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("用户端点目录与当前注册表逐项一致，不只验证标题数字", () => {
  const reg = loadRegistry(REPO)!;
  const catalog = fs.readFileSync(path.join(REPO, "datasources/CATALOG.md"), "utf8");
  assert.ok(catalog.includes(`共 ${reg.endpoints.length} 个`));
  const ids = [...catalog.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.deepEqual(ids.sort(), reg.endpoints.map(endpoint => endpoint.id).sort());
});

test("注册表可读;core 计划与 Phase 0 stageScripts() 完全一致;关键端点一致", () => {
  const reg = loadRegistry(REPO);
  assert.ok(reg && reg.endpoints.length > 80, "注册表应已接入 80+ 端点");
  assert.deepEqual(buildStagePlan(reg!, stages(), { market: "SZ", scope: "core" }), stageScripts());
  assert.deepEqual(criticalScripts(reg!), packCriticalScripts());
});

test("full 计划:必需项不变,只增加可选端点;美股 / 港股端点不进 A 股计划;禁用端点排除", () => {
  const reg = loadRegistry(REPO)!;
  const full = buildStagePlan(reg, stages(), { market: "SZ", scope: "full" });
  for (const s of stages()) {
    assert.deepEqual(full[s].required, stageScripts()[s].required, `${s} required 不得变`);
    for (const id of stageScripts()[s].optional) assert.ok(full[s].optional.includes(id));
  }
  assert.ok(full.profile.optional.includes("em_concept_blocks"));
  assert.ok(full.risk.optional.includes("cninfo_announcements"));
  const byId = endpointsById(reg);
  for (const s of stages()) for (const id of [...full[s].required, ...full[s].optional]) assert.ok(byId[id].market.includes("CN"), `${id} 不是 CN 端点却进了 A 股计划`);
  const reg2 = { ...reg, endpoints: reg.endpoints.map((e) => (e.id === "em_concept_blocks" ? { ...e, enabled: false } : e)) };
  assert.ok(!buildStagePlan(reg2, stages(), { market: "SZ", scope: "full" }).profile.optional.includes("em_concept_blocks"));
  const us = buildStagePlan(reg, stages(), { market: "US", scope: "full" });
  assert.deepEqual(us.profile.required, []);
  assert.equal(regionOf("SH"), "CN"); assert.equal(regionOf(""), "CN"); assert.equal(regionOf("us"), "US"); assert.equal(regionOf("HK"), "HK");
  assert.throws(() => regionOf("XX"), /未知市场/);
  assert.throws(() => makeConfig({ symbol: "300308", market: "XX", repoRoot: REPO, runId: "t-reg-bad" }), /未知市场/);
});

test("fetchArgv:legacy 走脚本自身;其余走 fetch_endpoint.py;symbol_kind=none 不传 --symbol", () => {
  const o = { scriptsDir: "/s", symbol: "300308", runDir: "/r" };
  assert.deepEqual(fetchArgv({ id: "fetch_quote", module: "legacy", function: "fetch_quote.py", market: ["CN"] }, "fetch_quote", o), ["/s/fetch_quote.py", "--symbol", "300308", "--out-dir", "/r"]);
  assert.deepEqual(fetchArgv(undefined, "fetch_quote", o), ["/s/fetch_quote.py", "--symbol", "300308", "--out-dir", "/r"]);
  assert.deepEqual(fetchArgv({ id: "em_reports", module: "eastmoney", function: "eastmoney_reports", market: ["CN"], symbol_kind: "cn6" }, "em_reports", o), ["/s/fetch_endpoint.py", "--endpoint", "em_reports", "--out-dir", "/r", "--symbol", "300308"]);
  assert.deepEqual(fetchArgv({ id: "em_hot_rank", module: "eastmoney", function: "em_hot_rank", market: ["CN"], symbol_kind: "none" }, "em_hot_rank", o), ["/s/fetch_endpoint.py", "--endpoint", "em_hot_rank", "--out-dir", "/r"]);
});

test("makeConfig:默认 core(硬测试 / 旧行为);full 才接入注册表端点;无注册表的仓库回退常量", () => {
  const c1 = makeConfig({ symbol: "300308", market: "SZ", repoRoot: REPO, runId: "t-reg-1" });
  assert.equal(c1.endpointScope, "core");
  assert.deepEqual(c1.stagePlan, stageScripts());
  assert.ok(c1.registryVersion);
  const c2 = makeConfig({ symbol: "300308", market: "SZ", repoRoot: REPO, runId: "t-reg-2", endpointScope: "full" });
  assert.ok(c2.stagePlan.risk.optional.length > stageScripts().risk.optional.length);
  assert.deepEqual(c2.criticalScripts, packCriticalScripts());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vra-noreg-"));
  const c3 = makeConfig({ symbol: "300308", market: "SZ", repoRoot: tmp, runId: "t-reg-3", endpointScope: "full" });
  assert.deepEqual(c3.stagePlan, stageScripts());
  assert.equal(c3.registryVersion, null);
  assert.deepEqual(c3.endpoints, {});
});

test("validator:raw 类端点的 market=CN 非 MARKET 证据豁免;US 全市场证据 symbol=MARKET 合法;计划文件可被 loadRun 读回", () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-"));
  for (const d of ["fetch", "raw", "calcs", "stages"]) fs.mkdirSync(path.join(run, d));
  const ev = (id: string, script: string, market: string, symbol: string) => ({ id, symbol, market, field: "f", value: 1, unit: "个", currency: "n/a", period: "2026-01-01", as_of: "2026-01-01", source: "s", endpoint: script, fetched_at: "2026-01-01T00:00:00+08:00", adjustment: "not_applicable", raw_ref: null });
  const envOf = (script: string, market: string, symbol: string) => ({ script, symbol, market, status: "ok", fetched_at: "2026-01-01T00:00:00+08:00", primary_source: "s", used_sources: ["s"], evidence: [ev(`ev-${script.length}abcdef`, script, market, symbol)], extra: {}, errors: [], missing: [] });
  const ledger: Record<string, unknown> = {};
  const put = (script: string, market: string, symbol: string) => {
    const f = path.join(run, "fetch", `${script}.json`);
    writeJson(f, envOf(script, market, symbol));
    ledger[script] = { script, argv: [], exit_code: 0, duration_ms: 1, status: "ok", file: `fetch/${script}.json`, sha256: sha256File(f), raw_files: {}, started_at: "", finished_at: "", stage: "profile" };
  };
  put("em_stock_search", "CN", "苹果");
  put("finra_short_ranking", "US", "MARKET");
  put("tx_us_quote", "US", "AAPL");
  const plan = planFileOf("full", "1.0.0", stageScripts(), packCriticalScripts(), { em_stock_search: { id: "em_stock_search", module: "eastmoney", function: "stock_search", market: ["US", "HK"], symbol_kind: "raw" } });
  // planFileOf 只收录计划内端点;这里直接构造 endpoints 映射写盘
  plan.endpoints = { em_stock_search: { module: "eastmoney", symbol_kind: "raw" } };
  writeJson(path.join(run, "fetch", "_plan.json"), plan);
  const view = loadRun(run, ledger as never);
  assert.deepEqual(view.plan, stageScripts());
  assert.equal(view.endpoints.em_stock_search.symbol_kind, "raw");
  const r = validateFetchIntegrity(view);
  assert.deepEqual(r.errors.filter((e) => e.includes("market/symbol")), []);
  // 去掉 raw 豁免 → 该证据报错
  const view2 = loadRun(run, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  assert.equal(validateFetchIntegrity(view2).errors.filter((e) => e.includes("market/symbol")).length, 1);
});

test("validator:账本状态与信封 status 不一致 → 完整性错误;证据缺 raw_ref → 错误(injected 除外)", () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run2-"));
  for (const d of ["fetch", "raw", "calcs", "stages"]) fs.mkdirSync(path.join(run, d));
  fs.writeFileSync(path.join(run, "raw", "a.json"), "{}");
  const ev = (id: string, extra: Record<string, unknown> = {}) => ({ id, symbol: "300308", market: "SZ", field: "f", value: 1, unit: "个", currency: "n/a", period: "2026-01-01", as_of: "2026-01-01", source: "s", endpoint: "e", fetched_at: "2026-01-01T00:00:00+08:00", adjustment: "not_applicable", raw_ref: "raw/a.json", ...extra });
  const env = (script: string, status: string, evidence: unknown[]) => ({ script, symbol: "300308", market: "SZ", status, fetched_at: "2026-01-01T00:00:00+08:00", primary_source: "s", used_sources: ["s"], evidence, extra: {}, errors: [], missing: [] });
  const ledger: Record<string, unknown> = {};
  const put = (script: string, envStatus: string, ledgerStatus: string, evidence: unknown[], injected?: string) => {
    const f = path.join(run, "fetch", `${script}.json`);
    writeJson(f, env(script, envStatus, evidence));
    ledger[script] = { script, argv: [], exit_code: ledgerStatus === "ok" ? 0 : ledgerStatus === "partial" ? 2 : 3, duration_ms: 1, status: ledgerStatus, file: `fetch/${script}.json`, sha256: sha256File(f), raw_files: { "a.json": sha256File(path.join(run, "raw", "a.json")) }, started_at: "", finished_at: "", stage: "profile", ...(injected ? { injected } : {}) };
  };
  put("s_ok", "ok", "ok", [ev("ev-aaaaa1")]);
  put("s_mismatch", "failed", "ok", [ev("ev-aaaaa2")]);
  put("s_timeout", "failed", "timeout", []);
  put("s_noraw", "ok", "ok", [ev("ev-aaaaa3", { raw_ref: null })]);
  put("s_inj", "ok", "ok", [ev("ev-aaaaa4", { raw_ref: null, source: "injected" })], "inject_evidence");
  // 账本自身不自洽:退出码 2 却记 ok
  put("s_selfbad", "ok", "ok", [ev("ev-aaaaa5")]);
  (ledger.s_selfbad as { exit_code: number }).exit_code = 2;
  // 账本条目的产物被删除
  put("s_deleted", "ok", "ok", [ev("ev-aaaaa6")]);
  fs.rmSync(path.join(run, "fetch", "s_deleted.json"));
  const r = validateFetchIntegrity(loadRun(run, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} }));
  assert.equal(r.errors.filter((e) => e.includes("不一致") && e.includes("s_mismatch")).length, 1);
  assert.equal(r.errors.filter((e) => e.includes("s_selfbad") && e.includes("不自洽")).length, 1);
  assert.equal(r.errors.filter((e) => e.includes("s_deleted") && e.includes("已不存在")).length, 1);
  assert.equal(r.errors.filter((e) => e.includes("s_timeout")).length, 0);
  assert.equal(r.errors.filter((e) => e.includes("ev-aaaaa3") && e.includes("raw_ref")).length, 1);
  assert.equal(r.errors.filter((e) => e.includes("ev-aaaaa4")).length, 0);
  assert.equal(r.errors.filter((e) => e.includes("ev-aaaaa1")).length, 0);
  // 账本 file 缺失 / 错名 / 越界 / 指向目录 → 都判错(不能靠省略 file 绕过)
  put("s_nofile", "ok", "ok", [ev("ev-aaaaa7")]);
  delete (ledger.s_nofile as { file?: string }).file;
  put("s_wrong", "ok", "ok", [ev("ev-aaaaa8")]);
  (ledger.s_wrong as { file: string }).file = "fetch/other.json";
  put("s_escape", "ok", "ok", [ev("ev-aaaaa9")]);
  (ledger.s_escape as { file: string }).file = "fetch/../s_escape.json";
  put("s_dir", "ok", "ok", [ev("ev-aaaab0")]);
  fs.rmSync(path.join(run, "fetch", "s_dir.json"));
  fs.mkdirSync(path.join(run, "fetch", "s_dir.json"));
  const r2 = validateFetchIntegrity(loadRun(run, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} }));
  assert.equal(r2.errors.filter((e) => e.includes("s_nofile") && e.includes("缺 file")).length, 1);
  assert.equal(r2.errors.filter((e) => e.includes("s_wrong") && e.includes("与脚本名不符")).length, 1);
  assert.equal(r2.errors.filter((e) => e.includes("s_escape") && e.includes("与脚本名不符")).length, 1);
  assert.ok(r2.errors.filter((e) => e.includes("s_dir") && e.includes("不是普通文件")).length >= 1);
});

test("validator:extra_findings 的 topic 枚举 / summary 上限 / id 必须存在且列入本阶段顶层引用", async () => {
  const { validateStage } = await import("../src/validator.ts");
  const { validateStageOutput } = await import("../src/schemas.ts");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run3-"));
  for (const d of ["fetch", "raw", "calcs", "stages"]) fs.mkdirSync(path.join(run, d));
  fs.writeFileSync(path.join(run, "raw", "a.json"), "{}");
  const ev = (id: string, field: string) => ({ id, symbol: "300308", market: "SZ", field, value: 1, unit: "个", currency: "n/a", period: "2026-01-01", as_of: "2026-01-01", source: "s", endpoint: "e", fetched_at: "2026-01-01T00:00:00+08:00", adjustment: "not_applicable", raw_ref: "raw/a.json" });
  const ledger: Record<string, unknown> = {};
  let first = true;
  const put = (script: string, evidence: unknown[], extra: Record<string, unknown> = {}) => {
    const f = path.join(run, "fetch", `${script}.json`);
    writeJson(f, { script, symbol: "300308", market: "SZ", status: "ok", fetched_at: "2026-01-01T00:00:00+08:00", primary_source: "s", used_sources: ["s"], evidence, extra, errors: [], missing: [] });
    ledger[script] = { script, argv: [], exit_code: 0, duration_ms: 1, status: "ok", file: `fetch/${script}.json`, sha256: sha256File(f), raw_files: first ? { "a.json": sha256File(path.join(run, "raw", "a.json")) } : {}, started_at: "", finished_at: "", stage: "profile" };
    first = false;
  };
  put("fetch_profile", [ev("ev-aa0001", "name")]);
  put("fetch_quote", [ev("ev-bb0001", "price")], { is_stale: false, quote_date: "2026-01-01" });
  put("fetch_trade_calendar", [{ ...ev("ev-c00001", "x"), symbol: "MARKET", market: "CN" }], { session_phase: "non_trading_day", reference_quote_day: "2026-01-01", last_trading_day: "2026-01-01" });
  put("em_stock_info", [ev("ev-e00001", "total_shares")]);
  const base = { stage: "profile", status: "complete", summary: "ok", evidence_ids: ["ev-aa0001", "ev-bb0001"], calculation_ids: [], gaps: [], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" };
  const stageFile = path.join(run, "stages", "profile.json");
  const pi = { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} };
  assert.ok(validateStageOutput("profile", { ...base, extra_findings: [{ topic: "资金行为", summary: "x", evidence_ids: ["ev-aa0001"] }] }).length > 0, "非法 topic");
  assert.ok(validateStageOutput("profile", { ...base, extra_findings: [{ topic: "股本与市值", summary: "x".repeat(601), evidence_ids: ["ev-aa0001"] }] }).length > 0, "摘要超长");
  assert.ok(validateStageOutput("profile", { ...base, extra_findings: [{ topic: "股本与市值", summary: "x", evidence_ids: [] }] }).length > 0, "空 id");
  assert.equal(validateStageOutput("profile", { ...base, extra_findings: [{ topic: "股本与市值", summary: "x", evidence_ids: ["ev-aa0001"] }] }).length, 0);
  writeJson(stageFile, { ...base, extra_findings: [{ topic: "股本与市值", summary: "东财总股本", evidence_ids: ["ev-e00001"] }] });
  let r = validateStage("profile", loadRun(run, ledger as never, pi));
  assert.ok(r.errors.some((e) => e.includes("extra_findings") && e.includes("未列入本阶段顶层")), r.errors.join("|"));
  writeJson(stageFile, { ...base, extra_findings: [{ topic: "股本与市值", summary: "x", evidence_ids: ["ev-ffffff"] }] });
  r = validateStage("profile", loadRun(run, ledger as never, pi));
  assert.ok(r.errors.some((e) => e.includes("extra_findings") && e.includes("不存在")));
  writeJson(stageFile, { ...base, evidence_ids: ["ev-aa0001", "ev-bb0001", "ev-e00001"], extra_findings: [{ topic: "股本与市值", summary: "东财总股本", evidence_ids: ["ev-e00001"] }] });
  r = validateStage("profile", loadRun(run, ledger as never, pi));
  assert.ok(!r.errors.some((e) => e.includes("extra_findings")), r.errors.join("|"));
});
