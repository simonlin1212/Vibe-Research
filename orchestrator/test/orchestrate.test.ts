/**
 * 主流程端到端(假运行器 + 假取数执行器 + 假复算):验证状态机、补跑、gate 重写、状态推导、manifest 契约。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { stages, codexEnv, codexEnvFor, fetchEnv, makeConfig, type RunConfig, type Stage } from "../src/config.ts";
import { saveLedger, type FetchExecutor } from "../src/fetchrun.ts";
import { sha256File, writeJson } from "../src/fsutil.ts";
import { hooksIneffectiveReason, deriveRunStatus, exitCodeFor, prepareRunDir, runResearch } from "../src/orchestrate.ts";
import { CodexRunner, EventsLog, codexOptionsFor, type AgentRunner, type TurnOutcome } from "../src/runner.ts";
import { noopLifecycle } from "../src/engine.ts";
import { codexCapabilities } from "../src/engines/codex_lifecycle.ts";
import { directCapabilities } from "../src/engines/direct_lifecycle.ts";
import { currentPlugin } from "../src/plugin.ts";
import { validateManifest } from "../src/schemas.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { appendHookLog } from "../src/hooks.ts";
import { loadRegistry } from "../src/registry.ts";
import { mergeEvidence } from "../src/merge.ts";
import { LocalAgentError } from "../src/local_agent_runtime.ts";
const TS = "2026-08-21T10:00:00+08:00";
const ev = (id: string, field: string, value: unknown, extra: Record<string, unknown> = {}) => ({ id, symbol: "300308", market: "SZ", field, value, unit: "元", currency: "CNY",
  period: "2026-08-21", as_of: "2026-08-21", source: "tencent", endpoint: "qt", fetched_at: TS, adjustment: "none", raw_ref: null, ...extra });
const CAL = { session_phase: "non_trading_day", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-21" };
const PE_PERIOD = "2026-08-20..2026-08-21";
const PE_SERIES = { raw_ref: "raw/fake_fetch_pe_history.csv", column: "peTTM", where: { tradestatus: "1" }, date_column: "date" };

const REAL_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-repo-"));
  fs.mkdirSync(path.join(repo, ".local", "runs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# 测试宪法\n");
  // 产品必需件:项目技能目录(引擎按 <指令根>/.agents/skills 发现;缺了就是装坏了,preflight 会拒绝运行)
  fs.mkdirSync(path.join(repo, ".agents", "skills"), { recursive: true });
  // 产品随仓库发行的数据表(卡口事件分类表 / 产业标签表):缺失按配置错误直接抛,所以假仓库要带上
  fs.mkdirSync(path.join(repo, "datasources"), { recursive: true });
  for (const f of ["chokepoint_keywords.json", "industry_tags.json"]) fs.copyFileSync(path.join(REAL_REPO, "datasources", f), path.join(repo, "datasources", f));
  return repo;
}

/** 假取数证据:按脚本给出与真实脚本同名的 field,便于槽位校验 */
const FIELDS: Record<string, { field: string; value: number; unit?: string; period?: string }[]> = {
  fetch_quote: [{ field: "price", value: 943 }, { field: "total_market_cap", value: 1.0e12 }, { field: "pe_ttm", value: 50, unit: "倍" }],
  fetch_financials: [{ field: "revenue_cum", value: 5e9, period: "2026Q2" }, { field: "net_profit_parent_cum", value: 1.1e9, period: "2026Q2" }, { field: "net_profit_deducted_cum", value: 1e9, period: "2026Q2" }],
  fetch_estimates: [{ field: "eps_consensus_mean", value: 10, period: "FY2026" }, { field: "eps_consensus_mean", value: 20, period: "FY2028" }, { field: "eps_consensus_min", value: 5, period: "FY2028" }, { field: "eps_consensus_max", value: 30, period: "FY2028" }],
  fetch_pe_history: [{ field: "pe_ttm_traded_history_points", value: 2, unit: "个", period: PE_PERIOD }],
};
const evId = (s: string, field = s, period = "") => `ev-${crypto.createHash("sha256").update(`${s}|${field}|${period}`).digest("hex").slice(0, 6)}`;

/** 假取数执行器:按脚本名写信封 + 内存账本;可指定失败脚本 */
function fakeFetch(failed: string[] = []): FetchExecutor {
  return (cfg, stage, scripts, log, ledger) => {
    for (const s of scripts) {
      if (ledger[s]) continue;
      const f = path.join(cfg.runDir, "fetch", `${s}.json`);
      const isFail = failed.includes(s);
      const extra = s === "fetch_quote" ? { is_stale: false, quote_date: "2026-08-21" } : s === "fetch_trade_calendar" ? CAL : s === "fetch_estimates" ? { current_fy: "FY2026", years: ["FY2026", "FY2027", "FY2028"] } : {};
      const spec = FIELDS[s] ?? [{ field: s, value: 1 }];
      // 每个脚本一份假 raw 响应:证据 raw_ref 指向它,账本 raw_files 登记其 sha(与真实取数一致,满足"每条证据必有 raw_ref"规则)
      const rawName = s === "fetch_pe_history" ? "fake_fetch_pe_history.csv" : `fake_${s}.json`;
      fs.writeFileSync(path.join(cfg.runDir, "raw", rawName), s === "fetch_pe_history"
        ? "date,peTTM,tradestatus\n2026-08-20,40,1\n2026-08-21,60,1\n" : JSON.stringify({ fake: s }));
      const evidence = isFail ? [] : spec.map((x) => ev(evId(s, x.field, x.period ?? ""), x.field, x.value,
        { raw_ref: `raw/${rawName}`, ...(x.unit ? { unit: x.unit } : {}), ...(x.period ? { period: x.period } : {}), ...(s === "fetch_trade_calendar" ? { market: "CN", symbol: "MARKET", currency: "n/a", adjustment: "not_applicable" } : {}) }));
      const env = { script: s, symbol: cfg.symbol, market: cfg.market, status: isFail ? "failed" : "ok", fetched_at: TS, primary_source: isFail ? null : "tencent",
        used_sources: isFail ? [] : ["tencent"], evidence, extra, errors: [], missing: [] };
      writeJson(f, env);
      ledger[s] = { script: s, argv: [], exit_code: isFail ? 3 : 0, duration_ms: 1, status: isFail ? "failed" : "ok", file: `fetch/${s}.json`, sha256: sha256File(f), raw_files: { [rawName]: sha256File(path.join(cfg.runDir, "raw", rawName)) }, started_at: TS, finished_at: TS, stage };
      log("fetch.executed", { script: s });
    }
    saveLedger(cfg.runDir, ledger);
    return ledger;
  };
}

type Behaviour = (stage: Stage, attempt: number, cfg: RunConfig, prompt: string) => void;

/** 假 agent:按回调在运行目录写产物 */
class FakeRunner implements AgentRunner {
  threadId: string | null = "fake-thread";
  calls: { stage: Stage; attempt: number; prompt: string }[] = [];
  logs: { stage: string; type: string }[] = [];
  private readonly behave: Behaviour;
  private readonly cfg: RunConfig;
  private events: EventsLog | null = null;
  constructor(behave: Behaviour, cfg: RunConfig) { this.behave = behave; this.cfg = cfg; }
  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.logs.push({ stage, type });
    if (!this.events) this.events = new EventsLog(path.join(this.cfg.runDir, "events.jsonl")); // 运行目录由 prepareRunDir 准备好后首次写
    this.events.append({ stage, type, ...payload });
  }
  eventsDigest(): string | null { return this.events?.digest() ?? null; }
  async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
    this.calls.push({ stage, attempt, prompt });
    // 真引擎每个 turn 收工前会调 Stop 钩子 —— 假运行器也要模拟,否则"钩子零调用"会被
    // 新的执行层有效性判定当成失效(全审 r2-P1-1)。这里写一条 allow,与真实 allow 路径同形。
    if (this.cfg.hooksEnabled) appendHookLog(this.cfg.runDir, { ts: new Date().toISOString(), hook: "stop", decision: "allow" });
    this.behave(stage, attempt, this.cfg, prompt);
    return { finalResponse: "{}", usage: null, commands: [], fileChanges: [], itemCount: 0, durationMs: 1, failed: null, threadId: this.threadId };
  }
}

const E = (id: string) => ({ ref_type: "evidence" as const, ref_id: id });
const C = (id: string) => ({ ref_type: "calculation" as const, ref_id: id });
const CALC = (fn: string, id: string, refs: { ref_type: "evidence" | "calculation"; ref_id: string }[], inputs: Record<string, unknown> = { a: 1 }, out: { value: number | null; unit: string } = { value: 1.5, unit: "倍" }) => ({ calculation_id: id, function: fn, calc_version: "0.2.0", inputs,
  // 复算仍由此状态机测试的替身负责；序列槽位的生产校验必须看到正确的输入元数据。
  inputs_resolved: fn === "percentile_rank" ? { history: { ...PE_SERIES, period: PE_PERIOD, rows_used: 2 } } : {}, inputs_refs: refs, output: { status: out.value === null ? "not_meaningful" : "ok", value: out.value, unit: out.unit, reason: "", details: {} } });
const cid = (n: number) => `calc-${n.toString(16).padStart(16, "0")}`;
const QUOTE = { price: evId("fetch_quote", "price"), cap: evId("fetch_quote", "total_market_cap"), pe: evId("fetch_quote", "pe_ttm") };
const FIN = { rev: evId("fetch_financials", "revenue_cum", "2026Q2"), par: evId("fetch_financials", "net_profit_parent_cum", "2026Q2"), ded: evId("fetch_financials", "net_profit_deducted_cum", "2026Q2") };
const EST = { m26: evId("fetch_estimates", "eps_consensus_mean", "FY2026"), m28: evId("fetch_estimates", "eps_consensus_mean", "FY2028"), min: evId("fetch_estimates", "eps_consensus_min", "FY2028"), max: evId("fetch_estimates", "eps_consensus_max", "FY2028") };
const PEH = evId("fetch_pe_history", "pe_ttm_traded_history_points", PE_PERIOD);
/** 计算 id 约定:1-3 quarterize(营收 / 归母 / 扣非),4 latest_quarter,5 ttm_sum,6 ttm_yoy,7 qoq;10 forward_cagr,11 dispersion;20-26 估值 */
type Ref = { ref_type: "evidence" | "calculation"; ref_id: string };
type CalcSpec = [string, number, Ref[], Record<string, unknown>, { value: number | null; unit: string }];
const OUT = { lq: { value: 2.5e8, unit: "元" }, ttm: { value: 9.5e8, unit: "元" }, yoy: { value: 2.0, unit: "小数" }, qoq: { value: 0.3, unit: "小数" },
  cagr: { value: 0.4142, unit: "小数" }, pe: { value: 1000, unit: "倍" }, pe_ttm: { value: 1052.63, unit: "倍" } };
const FIN_CALCS: CalcSpec[] = [
  ["quarterize", 1, [E(FIN.rev)], { a: 1 }, { value: 3, unit: "期" }], ["quarterize", 2, [E(FIN.par)], { a: 1 }, { value: 3, unit: "期" }], ["quarterize", 3, [E(FIN.ded)], { a: 1 }, { value: 3, unit: "期" }],
  ["latest_quarter", 4, [C(cid(3))], { a: 1 }, OUT.lq], ["ttm_sum", 5, [C(cid(2))], { a: 1 }, OUT.ttm], ["ttm_yoy", 6, [C(cid(2))], { a: 1 }, OUT.yoy], ["qoq", 7, [C(cid(3))], { a: 1 }, OUT.qoq],
];
const EST_CALCS: CalcSpec[] = [
  ["forward_cagr", 10, [E(EST.m26), E(EST.m28)], { eps_t: 10, eps_t_plus_n: 20, years: 2 }, OUT.cagr],
  ["consensus_dispersion", 11, [E(EST.min), E(EST.m28), E(EST.max)], { low: 5, mean: 20, high: 30 }, { value: 6, unit: "倍" }],
];
const VAL_CALCS: CalcSpec[] = [
  ["pe_deducted_annualized", 20, [E(QUOTE.cap), C(cid(4))], { total_market_cap: 1.0e12, cap_unit: "元", latest_quarter_deducted_profit: OUT.lq.value, profit_unit: "元" }, OUT.pe],
  ["forward_pe", 21, [E(QUOTE.price), E(EST.m26)], { price: 943, eps_forecast: 10 }, { value: 94.3, unit: "倍" }],
  ["pe_ttm_from_parts", 22, [E(QUOTE.cap), C(cid(5))], { total_market_cap: 1.0e12, cap_unit: "元", ttm_profit: OUT.ttm.value, profit_unit: "元" }, OUT.pe_ttm],
  ["percentile_rank", 23, [E(PEH), E(QUOTE.pe)], { current: 50, history: { history_csv: PE_SERIES } }, { value: 64.9, unit: "%" }],
  ["peg", 24, [C(cid(20)), C(cid(10))], { pe: OUT.pe.value, cagr: OUT.cagr.value }, { value: 24.1, unit: "倍" }],
  ["pe_digestion_scenarios", 25, [C(cid(20)), C(cid(10))], { pe: OUT.pe.value, cagr: OUT.cagr.value }, { value: null, unit: "年" }],
  ["forward_vs_ttm_judgement", 26, [C(cid(10)), C(cid(6))], { forward_cagr_value: OUT.cagr.value, ttm_yoy_value: OUT.yoy.value }, { value: -158.6, unit: "百分点" }],
];

/** 一个"听话"的 agent 行为:每阶段写合规产物(含正确的槽位引用与实参绑定) */
function goodAgent(stage: Stage, _attempt: number, cfg: RunConfig): void {
  const R = cfg.runDir;
  const base = { summary: "ok", gaps: [] as unknown[], evidence_ids: [] as string[], calculation_ids: [] as string[] };
  if (stage === "profile") writeJson(path.join(R, "stages", "profile.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.price], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" });
  if (stage === "financials") {
    FIN_CALCS.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(R, "calcs", `0${i + 1}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "financials.json"), { stage, status: "complete", ...base, evidence_ids: [FIN.rev, FIN.par, FIN.ded], calculation_ids: FIN_CALCS.map(([, n]) => cid(n)) });
  }
  if (stage === "estimates") {
    EST_CALCS.forEach(([fn, n, refs, inputs, out]) => writeJson(path.join(R, "calcs", `${n}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "estimates.json"), { stage, status: "complete", ...base, evidence_ids: [EST.m26, EST.m28, EST.min, EST.max], calculation_ids: [cid(10), cid(11)] });
  }
  if (stage === "valuation") {
    VAL_CALCS.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(R, "calcs", `2${i}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "valuation.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.cap, QUOTE.price, PEH], calculation_ids: VAL_CALCS.map(([, n]) => cid(n)),
      standard_columns: { pe_deducted_x4: cid(20), forward_pe: cid(21), pe_ttm_percentile: cid(23), peg: cid(24), forward_cagr: cid(10), ttm_yoy: cid(6), qoq: cid(7) } });
  }
  if (stage === "risk") writeJson(path.join(R, "stages", "risk.json"), { stage, status: "complete", ...base, counter_evidence: [{ claim: "c", counter: "x", evidence_ids: [QUOTE.price] }],
    decision_points: [{ what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }], source_conflicts: [] });
  if (stage === "report") {
    fs.writeFileSync(path.join(R, "report.md"), `# 测试(SZ:300308)研究报告 · 状态:complete\n\n> PE 分位口径：当前值来源 tencent；历史序列来源 tencent；跨来源或不同财务口径的分位仅供对照，不代表同源精确比较。[${cid(23)}]\n\n## 结论摘要\n- ok\n## 事实\n- 现价 943 元(${QUOTE.price})\n## 推断\n## 估值\n- 扣非×4 PE 1.5 倍(${cid(20)})\n## 风险与反证\n## 裁决点\n## 数据缺口\n`);
    writeJson(path.join(R, "stages", "report.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.price], calculation_ids: [cid(20), cid(23)] });
  }
}

const okVerify = () => ({ ok: true, errors: [], warnings: [] });
const deps = (runner: AgentRunner, fetchRunner: FetchExecutor) => ({ runner, fetchRunner, verify: okVerify, sdkVersion: () => ({ version: "fake 0.0", binary: null }) });

test("同步最终校验后仍先检查取消，再开始归档", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-finalization", hooksEnabled: false, endpointScope: "core" });
  const ac = new AbortController();
  const runner = new FakeRunner(goodAgent, cfg);
  let closing = 0;
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fakeFetch()), signal: ac.signal,
      beginFinalization: () => { closing += 1; ac.abort(new Error("用户取消研究")); },
    }, ["profile"]), /用户取消研究/);
    assert.equal(closing, 1);
    assert.equal(runner.logs.some((e) => ["viewer.written", "knowledge.archived", "report.ready", "run.finished"].includes(e.type)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.cancelled, true);
    const events = fs.readFileSync(path.join(cfg.runDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const finished = events.filter(e => e.type === "research.finished").at(-1);
    assert.equal(finished?.status, "cancelled");
    assert.equal(manifest.stages[0].status, "complete");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("取消发生在取数后时不调用模型、不归档，保留取消终态", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-fetch", hooksEnabled: false, endpointScope: "core" });
  const ac = new AbortController();
  const runner = new FakeRunner(goodAgent, cfg);
  const fetcher: FetchExecutor = (...args) => {
    const result = fakeFetch()(...args);
    ac.abort(new Error("用户取消研究"));
    return result;
  };
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fetcher), signal: ac.signal }), /用户取消研究/);
    assert.equal(runner.calls.length, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.cancelled, true);
    assert.ok(manifest.finished_at);
    assert.equal(manifest.knowledge_archived ?? null, null);
    assert.ok(fs.existsSync(path.join(cfg.runDir, "fetch", "_ledger.json")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("模型返回后收到取消不重试、不开始下一阶段；已完成阶段仍在", async () => {
  const repo = tmpRepo();
  const ac = new AbortController();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-turn", hooksEnabled: false, endpointScope: "core" });
  const runner = new FakeRunner((stage, attempt, config) => {
    goodAgent(stage, attempt, config);
    if (stage === "financials") ac.abort(new Error("用户取消研究"));
  }, cfg);
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fakeFetch()), signal: ac.signal }), /用户取消研究/);
    assert.deepEqual(runner.calls.map((call) => call.stage), ["profile", "financials"]);
    const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(m.cancelled, true);
    assert.equal(m.stages[0].stage, "profile"); assert.equal(m.stages[0].status, "complete");
    assert.equal(fs.existsSync(path.join(cfg.runDir, "report.md")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Codex 阶段取消传入 SDK 且不误报超时", async () => {
  const repo = tmpRepo();
  const ac = new AbortController();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-sdk", hooksEnabled: false, endpointScope: "core" });
  const fakeCodex = () => ({ startThread: () => ({ id: "t", runStreamed: async (_prompt: string, options: { signal: AbortSignal }) => {
    ac.abort(new Error("用户取消研究"));
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  } }) }) as never;
  try {
    const result = await new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), fakeCodex).runTurn("profile", 1, "x", undefined, ac.signal);
    assert.equal(result.failed, "用户取消研究");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Codex 保留流里的额度原因，不被随后 worker 退出错误覆盖", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "quota-sdk", hooksEnabled: false, endpointScope: "core" });
  const fakeCodex = () => ({ startThread: () => ({ id: "t", runStreamed: async () => ({
    events: (async function* () {
      try { yield { type: "error", message: "You've hit your usage limit for GPT-5.3-Codex-Spark" }; }
      finally { throw new Error("Codex SDK worker exited 1: Reading prompt from stdin"); }
    })(),
  }) }) }) as never;
  try {
    const out = await new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), fakeCodex).runTurn("profile", 1, "x");
    assert.match(out.failed ?? "", /usage limit/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const [failure, code, attempts] of [
  ["You've hit your usage limit", "quota", 1],
  ["401 Unauthorized", "authentication", 1],
  ["turn 超时(1000 ms)", "timeout", 2],
  ["429 Too Many Requests", "rate_limit", 2],
] as const) test(`研究 ${code} 停在故障阶段并保留之前产物`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: `stop-${code}`, hooksEnabled: false, endpointScope: "core", maxRetries: 1 });
  class FailingRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const out = await super.runTurn(stage, attempt, prompt);
      return { ...out, failed: stage === "financials" ? failure : null };
    }
  }
  const runner = new FailingRunner((stage, attempt, cfg) => {
    if (stage === "profile") goodAgent(stage, attempt, cfg);
  }, cfg);
  try {
    const result = await runResearch(cfg, deps(runner, fakeFetch()));
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.failure_code, code);
    assert.deepEqual(runner.calls.map(c => c.stage), ["profile", ...Array(attempts).fill("financials")]);
    assert.deepEqual(result.manifest.stages.map(s => s.status), ["complete", "failed"]);
    assert.ok(fs.existsSync(path.join(cfg.runDir, "stages/profile.json")));
    assert.ok(result.manifest.evidence_count > 0);
    assert.equal(result.manifest.knowledge_archived, null);
    assert.deepEqual(validateManifest(result.manifest), []);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("超时与不可修复的取数契约同时出现，不继续后续阶段", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "mixed-failure", hooksEnabled: false, endpointScope: "core", maxRetries: 1 });
  class TimeoutRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      return { ...await super.runTurn(stage, attempt, prompt), failed: "turn 超时(1000 ms)" };
    }
  }
  const runner = new TimeoutRunner(goodAgent, cfg);
  const fetcher: FetchExecutor = async (...args) => {
    const ledger = await fakeFetch()(...args);
    const file = path.join(cfg.runDir, "fetch/fetch_quote.json");
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.fetched_at = 123;
    writeJson(file, envelope);
    ledger.fetch_quote.sha256 = sha256File(file);
    return ledger;
  };
  try {
    const result = await runResearch(cfg, deps(runner, fetcher));
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.failure_code, "timeout");
    assert.deepEqual(runner.calls.map(c => c.stage), ["profile"]);
    assert.ok(result.manifest.final_errors?.some(e => e.includes("不符契约")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("一次超时后成功恢复，继续后续阶段且不残留失败标签", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "recovered-timeout", hooksEnabled: false, endpointScope: "core", maxRetries: 1 });
  class RecoveringRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      return { ...await super.runTurn(stage, attempt, prompt), failed: stage === "profile" && attempt === 1 ? "timeout" : null };
    }
  }
  try {
    const result = await runResearch(cfg, deps(new RecoveringRunner(goodAgent, cfg), fakeFetch()));
    assert.equal(result.status, "complete");
    assert.equal(result.manifest.failure_code, undefined);
    assert.equal(result.manifest.stages[0].attempts, 2);
    assert.equal(result.manifest.stages.length, 6);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const isAgent of [true, false]) test(`异常只分类执行器，不误认来源错误 (${isAgent})`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: `exception-${isAgent}`, hooksEnabled: false, endpointScope: "core" });
  class ThrowingRunner extends FakeRunner {
    override async runTurn(): Promise<TurnOutcome> { throw new LocalAgentError("agent_not_authenticated", "登录失效"); }
  }
  const fetcher: FetchExecutor = () => { throw new Error("数据源 429 timeout"); };
  try {
    await assert.rejects(runResearch(cfg, deps(new ThrowingRunner(goodAgent, cfg), isAgent ? fakeFetch() : fetcher)));
    const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(m.failure_code, isAgent ? "authentication" : undefined);
    assert.equal(m.final_errors.some((s: string) => s.startsWith("execution:authentication:")), isAgent);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("成稿执行失败但遗留正文校验通过，最终仍失败且不归入知识库", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "report-worker-failed", hooksEnabled: false, endpointScope: "core", maxRetries: 0 });
  class ReportFailure extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const out = await super.runTurn(stage, attempt, prompt);
      return { ...out, failed: stage === "report" ? "worker exited unexpectedly" : null };
    }
  }
  try {
    const result = await runResearch(cfg, deps(new ReportFailure(goodAgent, cfg), fakeFetch()));
    assert.equal(result.manifest.stages.at(-1)?.validator_ok, true);
    assert.equal(result.manifest.stages.at(-1)?.status, "failed");
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.knowledge_archived, null);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("happy path:六阶段一次通过 → complete,exit 0,manifest 过 schema", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t1", python: "false" });
  const runner = new FakeRunner(goodAgent, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  assert.equal(r.status, "complete");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(validateManifest(r.manifest), []);
  assert.equal(r.manifest.stages.length, 6);
  assert.ok(r.manifest.stages.every((s) => s.status === "complete" && s.validator_ok && s.attempts === 1));
  assert.equal(runner.calls.length, 6);
  assert.ok(fs.existsSync(path.join(cfg.runDir, "evidence.json")) && fs.existsSync(path.join(cfg.runDir, "calculations.json")) && fs.existsSync(path.join(cfg.runDir, "conflicts.json")));
  assert.equal(r.manifest.evidence_count, 15);
  assert.equal(Object.keys(r.manifest.fetch_ledger).length, 8);
  // v2.1 §5:manifest 记 provider / engine(无密钥);领域事件齐全
  assert.equal(r.manifest.provider.name, "openai");
  assert.equal(r.manifest.engine.codex_home, path.join(repo, ".local", "codex-home"));
  const types = runner.logs.map((l) => l.type);
  assert.ok(types.includes("research.started") && types.includes("report.ready") && types.includes("research.finished"));
  assert.equal(types.filter((t) => t === "stage.completed").length, 6);
  assert.ok(!types.includes("gate.failed"));
});

test("Direct manifest 必须记录解析后的真实模型，并把未使用的 Codex 路径置空", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "direct-runtime", python: "false", engine: "direct" });
  const runner = new FakeRunner(goodAgent, cfg);
  runner.threadId = null;
  const r = await runResearch(cfg, {
    runner,
    lifecycle: noopLifecycle(directCapabilities("server_schema")),
    fetchRunner: fakeFetch(),
    verify: okVerify,
    sdkVersion: () => ({
      kind: "direct" as const,
      version: "direct-api/mimo/mimo-v2.5",
      binary: null,
      model: "mimo-v2.5",
      codexPath: null,
      codexHome: null,
    }),
  });
  assert.equal(r.manifest.model, "mimo-v2.5");
  assert.equal(r.manifest.model_note, "provider 默认模型，已由 Direct 运行时解析");
  assert.equal(r.manifest.engine.codex_path, null);
  assert.equal(r.manifest.engine.codex_home, null);
  assert.equal(r.manifest.codex_version, "direct-api/mimo/mimo-v2.5");
  assert.equal(r.manifest.hooks.enabled, false);
  assert.equal(r.manifest.hooks.installed, false);
  assert.equal(r.manifest.engine.capabilities?.hooks, false);
  assert.deepEqual(validateManifest(r.manifest), []);
});

test("Codex manifest 必须记录 provider 默认模型，而不是退回未知模型口径", async () => {
  const repo = tmpRepo();
  const base = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "codex-runtime", python: "false" });
  const cfg = { ...base, providerProfile: { ...base.providerProfile!, default_model: "codex-test-default" } };
  const runner = new FakeRunner(goodAgent, cfg);
  const r = await runResearch(cfg, {
    runner,
    lifecycle: noopLifecycle(codexCapabilities(cfg, "server_schema")),
    fetchRunner: fakeFetch(),
    verify: okVerify,
    sdkVersion: () => ({
      kind: "codex" as const,
      version: "codex-test-version",
      binary: "/test/codex",
      model: "codex-test-default",
      codexPath: "/test/codex",
      codexHome: "/test/codex-home",
    }),
  });
  assert.equal(r.manifest.model, "codex-test-default");
  assert.equal(r.manifest.model_note, "provider 默认模型，已由 Codex 运行时解析");
  assert.deepEqual(validateManifest(r.manifest), []);
});

test("必需取数失败 → 阶段 incomplete → 运行 incomplete(exit 2);三个关键脚本全失败 → failed", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t2", python: "false" });
  const honest: Behaviour = (stage, attempt, c) => {
    if (stage === "estimates") {
      writeJson(path.join(c.runDir, "stages", "estimates.json"), { stage, status: "incomplete", summary: "源失败", evidence_ids: [], calculation_ids: [],
        gaps: [{ operation: "fetch_estimates", reason_code: "source_failed", detail: "x" }, { operation: "forward_cagr", reason_code: "upstream_missing", detail: "x" }, { operation: "consensus_dispersion", reason_code: "upstream_missing", detail: "x" }] });
      return;
    }
    if (stage === "valuation") { // 没有一致预期 → 只做不依赖它的三项,其余写结构化 gaps
      const keep = VAL_CALCS.filter(([fn]) => ["pe_deducted_annualized", "pe_ttm_from_parts", "percentile_rank"].includes(fn));
      keep.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(c.runDir, "calcs", `2${i}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
      const gaps = ["forward_pe", "peg", "pe_digestion_scenarios", "forward_vs_ttm_judgement"].map((o) => ({ operation: o, reason_code: "upstream_missing", detail: "无一致预期" }));
      writeJson(path.join(c.runDir, "stages", "valuation.json"), { stage, status: "incomplete", summary: "部分", evidence_ids: [QUOTE.cap], calculation_ids: keep.map(([, n]) => cid(n)), gaps,
        standard_columns: { pe_deducted_x4: cid(20), forward_pe: "未获取:无一致预期", pe_ttm_percentile: cid(23), peg: "未获取:无一致预期", forward_cagr: "未获取:无一致预期", ttm_yoy: cid(6), qoq: cid(7) } });
      return;
    }
    goodAgent(stage, attempt, c);
  };
  let r = await runResearch(cfg, deps(new FakeRunner(honest, cfg), fakeFetch(["fetch_estimates"])));
  assert.equal(r.status, "incomplete");
  assert.equal(r.exitCode, 2);
  assert.equal(r.manifest.stages.find((s) => s.stage === "estimates")?.status, "incomplete");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t2b", python: "false" });
  const honest2: Behaviour = (stage, attempt, c) => {
    const failing: Record<string, { script: string; calcs: string[] }> = {
      profile: { script: "fetch_quote", calcs: [] },
      financials: { script: "fetch_financials", calcs: ["quarterize", "latest_quarter", "ttm_sum", "ttm_yoy", "qoq"] },
      estimates: { script: "fetch_estimates", calcs: ["forward_cagr", "consensus_dispersion"] },
    };
    const f = failing[stage];
    if (!f) { goodAgent(stage, attempt, c); return; }
    const so: Record<string, unknown> = { stage, status: "incomplete", summary: "源失败", evidence_ids: [], calculation_ids: [],
      gaps: [{ operation: f.script, reason_code: "source_failed", detail: "x" }, ...f.calcs.map((o) => ({ operation: o, reason_code: "upstream_missing", detail: "x" }))] };
    if (stage === "profile") Object.assign(so, { quote_decision: "unknown_unverified", quote_decision_reason: "quote 失败", moat_tag: "待补" });
    writeJson(path.join(c.runDir, "stages", `${stage}.json`), so);
  };
  r = await runResearch(cfg, deps(new FakeRunner(honest2, cfg), fakeFetch(["fetch_quote", "fetch_financials", "fetch_estimates"])));
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 3);
});

test("validator 不过 → 自动补跑并把报错带进提示词;仍不过 → 阶段 failed → 运行 failed", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t3", python: "false", maxRetries: 1 });
  const sloppy: Behaviour = (stage, attempt, c) => {
    goodAgent(stage, attempt, c);
    if (stage === "profile" && attempt === 1) writeJson(path.join(c.runDir, "stages", "profile.json"), { stage, status: "complete", summary: "x", evidence_ids: ["ev-ffffff"], calculation_ids: [], gaps: [], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" });
    if (stage === "risk") fs.rmSync(path.join(c.runDir, "stages", "risk.json"), { force: true }); // 永远写不出 risk
  };
  const runner = new FakeRunner(sloppy, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  const profileCalls = runner.calls.filter((x) => x.stage === "profile");
  assert.equal(profileCalls.length, 2);
  assert.ok(profileCalls[1].prompt.includes("【补跑 第 1 次】") && profileCalls[1].prompt.includes("ev-ffffff"));
  assert.equal(r.manifest.stages.find((s) => s.stage === "profile")?.status, "complete");
  assert.equal(r.manifest.stages.find((s) => s.stage === "risk")?.status, "failed");
  assert.equal(r.status, "failed");
});

test("合规 gate 命中 → 重写 → 复验通过 → complete;报告首行状态与推导不一致时被归一", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t4", python: "false", maxRetries: 0 }); // 不给阶段级补跑机会,迫使走 gate 重写循环
  let rewrites = 0;
  const tempted: Behaviour = (stage, attempt, c) => {
    if (attempt < 100) goodAgent(stage, attempt, c);
    const rp = path.join(c.runDir, "report.md");
    if (stage === "report" && attempt === 1) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- ok", "- 建议建仓").replace("状态:complete", "状态:incomplete"));
    if (stage === "report" && attempt >= 100) { rewrites++; fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- 建议建仓", "- 数据 / 框架 / 裁决点")); }
  };
  const runner = new FakeRunner(tempted, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  assert.equal(rewrites, 1);
  assert.ok(runner.logs.some((l) => l.type === "gate.failed"));
  assert.equal(r.manifest.gate.ok, true);
  assert.equal(r.status, "complete");
  assert.ok(fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8").startsWith("# 测试(SZ:300308)研究报告 · 状态:complete"));
  assert.ok(runner.logs.some((l) => l.type === "report.status_normalized"));
});

for (const failure of ["stream error: 模拟", "timeout", "usage limit"]) test(`gate 重写失败保留原因，即使正文已修好 (${failure})`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t4b", python: "false", maxRetries: 0, gateRetries: 3 });
  const tempted: Behaviour = (stage, attempt, c) => {
    if (attempt < 100) goodAgent(stage, attempt, c);
    const rp = path.join(c.runDir, "report.md");
    if (stage === "report" && attempt === 1) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- ok", "- 建议建仓"));
    if (stage === "report" && attempt >= 100) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- 建议建仓", "- ok")); // 文件修好了,但 turn 本身报失败
  };
  class FailingRewrite extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const o = await super.runTurn(stage, attempt, prompt);
      return attempt >= 100 ? { ...o, failed: failure } : o;
    }
  }
  const r = await runResearch(cfg, deps(new FailingRewrite(tempted, cfg), fakeFetch()));
  assert.equal(r.manifest.gate.ok, true);
  assert.equal(r.manifest.stages.find((s) => s.stage === "report")?.status, "failed");
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 3);
  assert.equal(r.manifest.failure_code, failure === "timeout" ? "timeout" : failure === "usage limit" ? "quota" : undefined);
});

test("agent 篡改取数文件(连同磁盘账本) → 内存账本识破 → 阶段 failed → 运行 failed;agent 自写 raw 文件同样被识破", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5", python: "false", maxRetries: 0 });
  const tamper: Behaviour = (stage, attempt, c) => {
    goodAgent(stage, attempt, c);
    if (stage === "profile") {
      const f = path.join(c.runDir, "fetch", "fetch_quote.json");
      const env = JSON.parse(fs.readFileSync(f, "utf8"));
      env.evidence[0].value = 1; // 改价格
      writeJson(f, env);
      const led = JSON.parse(fs.readFileSync(path.join(c.runDir, "fetch", "_ledger.json"), "utf8"));
      led.fetch_quote.sha256 = sha256File(f); // 连磁盘账本一起改
      writeJson(path.join(c.runDir, "fetch", "_ledger.json"), led);
    }
  };
  let r = await runResearch(cfg, deps(new FakeRunner(tamper, cfg), fakeFetch()));
  assert.equal(r.manifest.stages[0].status, "failed");
  assert.ok(r.manifest.stages[0].errors.some((e) => e.includes("sha256 不一致")));
  assert.equal(r.status, "failed");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5b", python: "false", maxRetries: 0 });
  const rawWriter: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "profile") fs.writeFileSync(path.join(c.runDir, "raw", "forged.json"), "{}"); };
  r = await runResearch(cfg, deps(new FakeRunner(rawWriter, cfg), fakeFetch()));
  assert.ok(r.manifest.stages[0].errors.some((e) => e.includes("raw/forged.json 未经编排器取数记录")));
  assert.equal(r.status, "failed");
});

test("受保护产物认证:agent 改写 events.jsonl / conflicts.json → 阶段 failed → 运行 failed", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t7", python: "false", maxRetries: 0 });
  const evTamper: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "financials") fs.appendFileSync(path.join(c.runDir, "events.jsonl"), JSON.stringify({ type: "forged" }) + "\n"); };
  let r = await runResearch(cfg, deps(new FakeRunner(evTamper, cfg), fakeFetch()));
  assert.ok(r.manifest.stages[1].errors.some((e) => e.includes("events.jsonl")), r.manifest.stages[1].errors.join("\n"));
  assert.equal(r.status, "failed");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t7b", python: "false", maxRetries: 0 });
  const cfTamper: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "risk") writeJson(path.join(c.runDir, "conflicts.json"), { id_conflicts: ["forged"], source_conflicts: [] }); };
  r = await runResearch(cfg, deps(new FakeRunner(cfTamper, cfg), fakeFetch()));
  assert.ok(r.manifest.stages.find((s) => s.stage === "risk")?.errors.some((e) => e.includes("conflicts.json")));
  assert.equal(r.status, "failed");
});

test("Stop 钩子终止标记 → 该 turn 视为失败 → 补跑;补跑成功则阶段 complete", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t8", python: "false", maxRetries: 1 });
  let first = true;
  const lazyThenGood: Behaviour = (stage, attempt, c) => {
    if (stage === "financials" && first) { // 第一轮"偷懒":不写产物,模拟 Stop 钩子拦够次数后终止本轮
      first = false;
      writeJson(path.join(c.runDir, ".vibe", "stop-failed.json"), { stage, attempt, problems: ["缺产物:stages/financials.json"], blocks: 2, ts: "x" });
      return;
    }
    goodAgent(stage, attempt, c);
  };
  const runner = new FakeRunner(lazyThenGood, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  const fin = r.manifest.stages.find((s) => s.stage === "financials")!;
  assert.equal(fin.attempts, 2);
  assert.equal(fin.status, "complete");
  assert.ok(runner.logs.some((l) => l.type === "hooks.stop_terminated"));
  assert.equal(r.status, "complete");
});

test("阶段终复核(恢复路径):收工预算烧尽被判 failed 的阶段,文件被后续轮补写落盘 → 认领为 complete;含行为违规错误的阶段不恢复", async () => {
  // 场景 A(2026-09-05 600519 真实事故):financials 的轮次里模型在写 stage 文件前被 Stop 终止,
  //   文件在**后续阶段(estimates)的轮次**里才补写落盘;主循环不再回头看 financials ⇒ 终复核认领。
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t9", python: "false", maxRetries: 0 });
  const lateWrite: Behaviour = (stage, attempt, c) => {
    if (stage === "financials") {
      writeJson(path.join(c.runDir, ".vibe", "stop-failed.json"), { stage, attempt, problems: ["缺产物:stages/financials.json"], blocks: 6, ts: "x" });
      return; // 本轮不写 financials 产物
    }
    goodAgent(stage, attempt, c);
    if (stage === "estimates") goodAgent("financials", attempt, c); // 补写:financials 的合法文件此刻才落盘
  };
  const runner = new FakeRunner(lateWrite, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  const fin = r.manifest.stages.find((s) => s.stage === "financials")!;
  assert.equal(fin.status, "complete", `financials 应被终复核认领,实际 ${fin.status}:${fin.errors.join(" | ")}`);
  assert.ok(fin.validator_ok);
  assert.ok(runner.logs.some((l) => l.type === "stage.recovered"), "应有 stage.recovered 事件");
  assert.equal(r.status, "complete", "六阶段全部认领后运行应为 complete");
  // 场景 B(安全边界):失败原因含行为违规(篡改 events.jsonl)的阶段,即使产物后来齐全也不恢复
  const repo2 = tmpRepo();
  const cfg2 = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo2, runId: "t9b", python: "false", maxRetries: 0 });
  const tamperAndLate: Behaviour = (stage, attempt, c) => {
    if (stage === "financials") {
      fs.appendFileSync(path.join(c.runDir, "events.jsonl"), JSON.stringify({ type: "forged" }) + "\n");
      writeJson(path.join(c.runDir, ".vibe", "stop-failed.json"), { stage, attempt, problems: ["缺产物:stages/financials.json"], blocks: 6, ts: "x" });
      return;
    }
    goodAgent(stage, attempt, c);
    if (stage === "estimates") goodAgent("financials", attempt, c);
  };
  const r2 = await runResearch(cfg2, deps(new FakeRunner(tamperAndLate, cfg2), fakeFetch()));
  const fin2 = r2.manifest.stages.find((s) => s.stage === "financials")!;
  assert.equal(fin2.status, "failed", "行为违规阶段不得被恢复");
  assert.ok(r2.status === "failed");
});

test("最终校验失败 → 状态降级为 failed(不得宣称完成)", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t6", python: "false", maxRetries: 0 });
  // report 阶段校验通过后,agent 在同一 turn 末尾偷偷再写一个不合契约的 calc(阶段校验只在 turn 后跑一次,这里模拟"校验后改动":直接在 verify 钩子里注入)
  let injected = false;
  const sneakyVerify = (c: RunConfig, run: { calcs: unknown[] }) => {
    if (!injected && fs.existsSync(path.join(c.runDir, "stages", "report.json"))) { injected = true; writeJson(path.join(c.runDir, "calcs", "99_bad.json"), { calculation_id: "calc-ffffffffffffffff", function: "x" }); }
    return okVerify();
  };
  const r = await runResearch(cfg, { runner: new FakeRunner(goodAgent, cfg), fetchRunner: fakeFetch(), verify: sneakyVerify as never, sdkVersion: () => ({ version: "fake", binary: null }) });
  assert.equal(r.status, "failed");
  assert.ok((r.manifest.final_errors ?? []).some((e) => e.startsWith("artifacts:")));
  assert.ok(fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8").startsWith("# 测试(SZ:300308)研究报告 · 状态:failed"));
});

test("环境隔离:取数脚本环境不含 Codex 凭据 / 配置目录;Codex 环境只含显式注入的 CODEX_HOME(不透传用户 shell 的)", () => {
  process.env.CODEX_API_KEY = "sk-test";
  process.env.CODEX_HOME = "/tmp/x";
  const fe = fetchEnv();
  assert.ok(!("CODEX_API_KEY" in fe) && !("CODEX_HOME" in fe) && !("XDG_CONFIG_HOME" in fe));
  const ce = codexEnv();
  assert.ok(!("CODEX_API_KEY" in ce) && !("CODEX_HOME" in ce));
  const cfg = makeConfig({ symbol: "1", repoRoot: "/tmp/repo" });
  assert.equal(codexEnvFor(cfg).CODEX_HOME, "/tmp/repo/.local/codex-home");
  delete process.env.CODEX_API_KEY; delete process.env.CODEX_HOME;
});

test("部分阶段运行:状态至多 incomplete,manifest 标 partial_run", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5", python: "false" });
  const r = await runResearch(cfg, deps(new FakeRunner(goodAgent, cfg), fakeFetch()), ["profile", "financials"]);
  assert.equal(r.status, "incomplete");
  assert.equal(r.manifest.partial_run, true);
  assert.deepEqual(r.manifest.execution_scope, ["profile", "financials"]);
});

test("run-id / 运行目录保护:非法 id 抛错;非空目录不加 --overwrite 抛错;--overwrite 清空", async () => {
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: "/tmp/r", runId: "../escape" }));
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: "/tmp/r", runId: "a/b" }));
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t6", python: "false" });
  fs.mkdirSync(cfg.runDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.runDir, "old.txt"), "x");
  assert.throws(() => prepareRunDir(cfg), /已存在且非空/);
  const cfg2 = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t6", python: "false", overwrite: true });
  prepareRunDir(cfg2);
  assert.ok(!fs.existsSync(path.join(cfg2.runDir, "old.txt")));
  const cfg3 = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t7", python: "false", runDir: "/tmp/elsewhere" });
  assert.throws(() => prepareRunDir(cfg3), /直接子目录/);
});

test("宪法与运行目录:数据根在产品根之外也能跑(指令资产同步到数据根);宪法缺失 → 抛错;manifest 记宪法 sha256", async () => {
  const repo = tmpRepo();
  // 分离安装:数据根与产品根毫无路径关系(将来 /Applications + ~/Library/Application Support 就是这样)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-data-"));
  fs.writeFileSync(path.join(repo, ".agents", "skills", "probe.md"), "# 探针技能\n");
  const cfgOut = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, dataRoot: outside, runId: "o1", python: "false" });
  fs.mkdirSync(path.join(outside, "runs"), { recursive: true });
  // 不再拒绝(用另一个 run-id 单独验,免得占掉下面那次运行的目录)
  assert.doesNotThrow(() => prepareRunDir(makeConfig({ symbol: "300308", repoRoot: repo, dataRoot: outside, runId: "o0", python: "false" })));
  const rOut = await runResearch(cfgOut, deps(new FakeRunner(goodAgent, cfgOut), fakeFetch()));
  assert.equal(rOut.manifest.instructions_root?.mode, "data");
  assert.equal(rOut.manifest.instructions_root?.root, path.resolve(outside));
  // 指令根上三件套齐了,且宪法副本与产品根母本逐字节相同(manifest 记的是母本 sha256)
  assert.deepEqual(fs.readFileSync(path.join(outside, "AGENTS.md")), fs.readFileSync(path.join(repo, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(outside, ".agents", "skills", "probe.md")), "项目技能要同步过去");
  assert.ok(fs.existsSync(path.join(outside, ".vibe-research-root")), "project root 标记要在指令根");
  assert.match(fs.readFileSync(path.join(cfgOut.codexHome, "config.toml"), "utf8"), /project_root_markers = \[".vibe-research-root"\]/);
  const cfgNoC = makeConfig({ symbol: "300308", repoRoot: repo, runId: "o2", python: "false", constitutionPath: path.join(repo, "NOPE.md") });
  assert.throws(() => prepareRunDir(cfgNoC), /宪法文件不存在/);
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "o3", python: "false" });
  const r = await runResearch(cfg, deps(new FakeRunner(goodAgent, cfg), fakeFetch()));
  assert.equal(r.manifest.constitution.path, path.join(repo, "AGENTS.md"));
  assert.match(r.manifest.constitution.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.manifest.provider.env_key, "OPENAI_API_KEY");
});

test("events 脱敏:已知密钥值与 sk- 形态在落盘前替换;摘要基于脱敏后内容", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ev-"));
  const log = new EventsLog(path.join(d, "events.jsonl"), ["supersecretvalue123"]);
  log.append({ type: "command", command: "echo supersecretvalue123 && echo sk-abcdefghijklmnop1234", output_tail: "supersecretvalue123" });
  const txt = fs.readFileSync(path.join(d, "events.jsonl"), "utf8");
  assert.ok(!txt.includes("supersecretvalue123") && !txt.includes("sk-abcdefghijklmnop1234"));
  assert.ok(txt.includes("[REDACTED]") && txt.includes("[REDACTED_KEY]"));
  assert.equal(sha256File(path.join(d, "events.jsonl")), log.digest());
});

test("真实构造链:CodexRunner 把工具环境策略 / 显式 CODEX_HOME / 引擎路径传给 SDK;api_key 模式下 runner 自己的事件日志会脱敏已知密钥值", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cr1", python: "false", codexPath: "/x/codex-engine", provider: { name: "openai", wire_api: "responses", base_url: null, env_key: "OPENAI_API_KEY", auth: "api_key" } });
  process.env.OPENAI_API_KEY = "verysecretapikey-9876543210";
  try {
    const opts = codexOptionsFor(cfg);
    assert.equal(opts.codexPathOverride, "/x/codex-engine");
    assert.equal(opts.env?.CODEX_HOME, path.join(repo, ".local", "codex-home"));
    assert.equal(opts.env?.CODEX_API_KEY, "verysecretapikey-9876543210");
    const policy = (opts.config as { shell_environment_policy: { ignore_default_excludes: boolean; exclude: string[] } }).shell_environment_policy;
    assert.equal(policy.ignore_default_excludes, false);
    assert.ok(policy.exclude.includes("CODEX_API_KEY") && policy.exclude.includes("*KEY*"));
    let captured: unknown = null;
    const runner = new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), (o) => { captured = o; return { startThread: () => { throw new Error("不应启动"); } } as never; });
    assert.deepEqual(captured, runner.codexOptions);
    runner.log("profile", "command", { command: "echo verysecretapikey-9876543210", output_tail: "verysecretapikey-9876543210" });
    const txt = fs.readFileSync(path.join(cfg.runDir, "events.jsonl"), "utf8");
    assert.ok(!txt.includes("verysecretapikey-9876543210") && txt.includes("[REDACTED]"));
    assert.equal(sha256File(path.join(cfg.runDir, "events.jsonl")), runner.eventsDigest());
  } finally { delete process.env.OPENAI_API_KEY; }
  // chatgpt_login 模式:env 无 CODEX_API_KEY,策略照样注入
  const cfg2 = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cr2", python: "false" });
  const o2 = codexOptionsFor(cfg2, {});
  assert.ok(!("CODEX_API_KEY" in (o2.env ?? {})) && o2.codexPathOverride === undefined && !!o2.config);
});

test("宪法语义:constitutionPath 不是产品根 AGENTS.md → prepareRunDir 拒绝", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "OTHER.md"), "x");
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "c1", python: "false", constitutionPath: path.join(repo, "OTHER.md") });
  assert.throws(() => prepareRunDir(cfg), /必须是产品根的 AGENTS.md/);
});

test("异常路径:取数执行器抛错 → research.failed / research.finished 仍写入,manifest 标 failed,异常继续抛出", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "x1", python: "false" });
  const runner = new FakeRunner(goodAgent, cfg);
  const boom: FetchExecutor = () => { throw new Error("取数执行器炸了"); };
  await assert.rejects(runResearch(cfg, deps(runner, boom)), /取数执行器炸了/);
  const types = runner.logs.map((l) => l.type);
  assert.ok(types.includes("research.failed") && types.includes("research.finished"));
  const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
  assert.equal(m.status, "failed");
});

test("deriveRunStatus 优先级与退出码", () => {
  const ok = stages().map((s) => ({ stage: s, status: "complete" as const, attempts: 1, errors: [], validator_ok: true }));
  const base = { stages: ok, gateOk: true, reportExists: true, quoteDecision: "normal", criticalAllFailed: false, partial: false };
  assert.equal(deriveRunStatus(base), "complete");
  assert.equal(deriveRunStatus({ ...base, quoteDecision: "stale" }), "stale");
  assert.equal(deriveRunStatus({ ...base, partial: true }), "incomplete");
  assert.equal(deriveRunStatus({ ...base, gateOk: false }), "failed");
  assert.equal(deriveRunStatus({ ...base, reportExists: false }), "failed");
  assert.equal(deriveRunStatus({ ...base, criticalAllFailed: true }), "failed");
  assert.equal(deriveRunStatus({ ...base, stages: ok.map((s, i) => (i === 1 ? { ...s, status: "failed" as const } : s)) }), "failed");
  assert.equal(deriveRunStatus({ ...base, stages: ok.map((s, i) => (i === 1 ? { ...s, status: "incomplete" as const } : s)), quoteDecision: "stale" }), "stale");
  assert.equal(exitCodeFor("complete"), 0); assert.equal(exitCodeFor("stale"), 2); assert.equal(exitCodeFor("failed"), 3);
});

test("执行层有效性:钩子零调用 / 全报错 → 运行不得宣称 complete(全审 r2-P1-1)", () => {
  const base = { enabled: true, installed: true, agentTurns: 6, invocations: 5, errors: 0 };
  assert.equal(hooksIneffectiveReason(base), null, "正常跑过就不该报");
  assert.match(String(hooksIneffectiveReason({ ...base, invocations: 0 })), /零调用/);
  // 🔴 我真跑分离安装时踩到的正是这个:5 次调用 5 次 error,阶段照样 complete
  assert.match(String(hooksIneffectiveReason({ ...base, errors: 5 })), /没生效/);
  // 没有 agent 轮次(--no-agent / 纯播种)时零调用是正常的,不许误报
  assert.equal(hooksIneffectiveReason({ ...base, agentTurns: 0, invocations: 0 }), null);
  assert.equal(hooksIneffectiveReason({ ...base, enabled: false, invocations: 0 }), null);
  assert.equal(hooksIneffectiveReason({ ...base, installed: false, invocations: 0 }), null);

  // 状态推导:执行层失效 → 至多 incomplete
  const okStages = [{ stage: "profile", status: "complete" }] as never;
  const args = { stages: okStages, gateOk: true, reportExists: true, quoteDecision: "normal", criticalAllFailed: false, partial: false };
  assert.equal(deriveRunStatus(args), "complete");
  assert.equal(deriveRunStatus({ ...args, hooksIneffective: "钩子零调用" }), "incomplete");
});

test("注册表:端点挂在不存在的阶段上必须当场拒绝(全审 r2-P1-4)", () => {
  const repo = tmpRepo();
  const regPath = path.join(repo, "datasources", "registry.json");
  const reg = JSON.parse(fs.readFileSync(path.join(REAL_REPO, "datasources", "registry.json"), "utf8"));
  writeJson(regPath, reg);
  assert.doesNotThrow(() => loadRegistry(repo), "真实注册表必须能过");
  // 拼错一个字母:旧实现会静默跳过,这个端点永远不执行而运行照样 complete
  reg.endpoints[0].stages = { estimte: "optional" };
  writeJson(regPath, reg);
  assert.throws(() => loadRegistry(repo), /挂在不存在的阶段 estimte/);
});

test("证据合并:同 id 但事实不同必须报冲突,不许静默折叠(全审 r1-P2-6)", () => {
  const base = { id: "ev-aaaaaa", symbol: "300308", market: "SZ", field: "close", value: 10,
    unit: "元", currency: "CNY", period: "2026-08-25", as_of: "2026-08-25", source: "s", endpoint: "e",
    fetched_at: TS, adjustment: "none", raw_ref: "raw/a.json" };
  const envOf = (evidence: unknown[]) => ({ script: "x", symbol: "300308", market: "SZ", status: "ok",
    fetched_at: TS, used_sources: [], evidence, extra: {}, errors: [] });

  // 同一条证据在两个信封里重复携带(只有元数据不同)⇒ 正常,不该报冲突
  const same = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, fetched_at: "2026-08-25T11:00:00+08:00", raw_ref: "raw/b.json" }]) as never });
  assert.deepEqual(same.idConflicts, []);
  assert.equal(same.evidence.length, 1);

  // 🔴 口径不同(adjustment)但数值相同:旧实现只比 value ⇒ 不报冲突、静默丢掉一条
  const diffAdj = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, adjustment: "qfq" }]) as never });
  assert.equal(diffAdj.idConflicts.length, 1, JSON.stringify(diffAdj.idConflicts));
  // 单位不同同理:「1 元」与「1 亿元」
  const diffUnit = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, unit: "亿元" }]) as never });
  assert.equal(diffUnit.idConflicts.length, 1);
  // 值不同仍然报
  assert.equal(mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, value: 11 }]) as never }).idConflicts.length, 1);
});

test("🔴 runner 真的按 provider 能力决定 schema 走哪条路 —— 只测那个纯函数测不出接没接上", async () => {
  const repo = tmpRepo();
  const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
  const seen: { prompt: string; opts: { outputSchema?: unknown } }[] = [];
  const fakeCodex = () =>
    ({
      startThread: () => ({
        id: "t",
        runStreamed: (prompt: string, opts: { outputSchema?: unknown }) => {
          seen.push({ prompt, opts });
          return Promise.resolve({
            events: (async function* () {
              yield { type: "item.completed", item: { type: "agent_message", text: "{}" } };
              yield { type: "turn.completed" };
            })(),
          });
        },
      }),
    }) as never;

  const mk = (structured?: "json_schema" | "prompt") =>
    makeConfig({
      symbol: "300308", repoRoot: repo, runId: `so-${structured ?? "none"}`, python: "false",
      provider: { name: "p", wire_api: "responses", base_url: "https://x.example/v1", env_key: "P_KEY", auth: "api_key" },
      providerProfile: {
        id: "p", name: "P", wire_api: "responses", base_url: "https://x.example/v1", env_key: "P_KEY",
        auth_modes: ["api_key"], requires_openai_auth: false, default_model: "m", responses_support: "native",
        ...(structured ? { structured_output: structured } : {}),
      } as never,
    });

  const stage = currentPlugin().stages[0]!;
  process.env.P_KEY = "k-for-test-0123456789"; // api_key 模式:runner 构造时就要求这个变量在
  try {
    // ① 没声明 → 照常硬传 schema
    const c1 = mk();
    await new CodexRunner(c1, path.join(c1.runDir, "events.jsonl"), fakeCodex).runTurn(stage, 1, "原提示词", schema);
    assert.deepEqual(seen[0]!.opts.outputSchema, schema, "默认必须硬传");
    assert.equal(seen[0]!.prompt, "原提示词");

    // ② 声明 prompt → 不传 outputSchema,schema 进提示词
    const c2 = mk("prompt");
    await new CodexRunner(c2, path.join(c2.runDir, "events.jsonl"), fakeCodex).runTurn(stage, 1, "原提示词", schema);
    assert.equal(seen[1]!.opts.outputSchema, undefined, "硬传会被这家整轮拒掉(实测 MiMo)");
    assert.ok(seen[1]!.prompt.includes('"summary"'), "schema 本体要出现在提示词里");
  } finally {
    delete process.env.P_KEY;
  }
});
