/**
 * 主流程(可注入依赖,便于用假运行器做端到端状态机测试):
 * 每阶段:编排器执行取数(账本)→ agent turn → validator(+ agent 行为 + 复算)→ 不过自动补跑 → 阶段状态确定性推导
 * → 合规 gate 重写循环(重写后全量复验)→ 最终状态(failed > stale > incomplete > complete)→ 报告状态归一
 * → 合并产物 + 最终 schema 校验 + manifest。
 */
import { spawnSync } from "node:child_process";
import { repositoryVersion } from "./repository_version.ts";
import fs from "node:fs";
import path from "node:path";

import { stages as packStages, STATUS_PRIORITY, needsTurnContext, type RunConfig, type RunStatus, type Stage, gateProbeLine } from "./config.ts";
import { ledgerSummary, loadLedgerFromDisk, type FetchExecutor, type Ledger } from "./fetchrun.ts";
import { PLAN_REL, planFileOf } from "./registry.ts";
import { archiveRun, recallKnowledge, shouldRecall } from "./knowledge.ts";
import { FixtureError, fixtureFreshness, readFixture, seedRunDir, verifyFixture, type FixtureManifest } from "./fixture.ts";
import { writeViewer } from "./viewer.ts";
import { atomicWrite, ensureDirs, nowIso, sha256File, sha256Text, writeJson } from "./fsutil.ts";
import { complianceGate, normalizeReportStatus, probeReportLine } from "./gate.ts";
// turn 上下文(stage/attempt)留在本文件写:它是**受控工具**判断当前阶段的依据,两个引擎都要;
// Codex 专属的那半(指令根 / skills 隔离 / hooks 安装与汇总)已移入 engines/codex_lifecycle.ts。
import { HOOK_CONTEXT_REL, writeHookContext } from "./hooks.ts";
import { CONSTITUTION_FILENAME } from "./instructions_root.ts";
import type { EngineLifecycle, EngineRuntime, LifecycleContext } from "./engine.ts";
import { CodexEngineLifecycle, codexCapabilities } from "./engines/codex_lifecycle.ts";
import { structuredOutputMode } from "./providers.ts";
import { currentPlugin } from "./plugin.ts";
import { rawHashes, writeConflicts, writeManifest, writeMergedArtifacts, type Manifest, type StageRecord } from "./merge.ts";
import type { AgentRunner } from "./agent_runner.ts";
import { turnReplySchema, validateManifest } from "./schemas.ts";
import { reportContext, reportsForSymbol, type ReportContext } from "./report_library.ts";
import { isResearchCancellation } from "./research_control.ts";
import { classifyResearchFailure, researchFailure, type ResearchFailureCode } from "./research_failure.ts";
import { LocalAgentError } from "./local_agent_runtime.ts";
import { allCriticalFetchFailed, checkAgentTrace, deriveQuoteDecision, deriveStageStatus, loadRun, summarizeErrorsForAgent, validateFetchIntegrity, validateFinalArtifacts, validateProtectedArtifacts, validateReport, validateStage, type AgentTrace, type CalcVerifier, type ProtectedExpectation, type ValidationResult, isUpstreamContractError } from "./validator.ts";

export interface Deps {
  signal?: AbortSignal;
  checkpoint?: () => void;
  /** Atomic boundary: once acquired, cancellation is no longer accepted. */
  beginFinalization?: () => void;
  runner: AgentRunner;
  fetchRunner: FetchExecutor;
  verify: CalcVerifier;
  /**
   * 引擎生命周期。缺省 = Codex(现有唯一引擎,行为与拆分前逐字一致)。
   * ⚠️ 直连引擎接入后,`run.ts` 必须**显式**传;缺省回落只是过渡期的向后兼容,
   *    不要让它变成"忘了传就静默用 Codex"——那正是本产品最不该有的那类静默失败。
   */
  lifecycle?: EngineLifecycle;
  /** 实际运行时信息；历史字段名保留到下一次 manifest 版本迁移。 */
  sdkVersion: () => EngineRuntime | ({ version: string; binary: string | null } & Partial<EngineRuntime>);
}

export interface RunResult { status: RunStatus; exitCode: number; manifest: Manifest }

export function exitCodeFor(status: RunStatus): number {
  return status === "complete" ? 0 : status === "failed" ? 3 : 2;
}

export function deriveRunStatus(input: { stages: StageRecord[]; gateOk: boolean; reportExists: boolean; quoteDecision: string | null;
  criticalAllFailed: boolean; partial: boolean; hooksIneffective?: string | null }): RunStatus {
  const c: RunStatus[] = [];
  if (!input.reportExists || !input.gateOk || input.criticalAllFailed || input.stages.some((s) => s.status === "failed")) c.push("failed");
  if (input.quoteDecision === "stale") c.push("stale");
  // 🔴 执行层没生效 ⇒ 不许宣称 complete(全审 r2-P1-1)。
  //    钩子 enabled + installed 却**零调用**、或每次调用都报上下文错误,都意味着 PreToolUse / Stop
  //    那层纪律**全程没起作用**,而产出看起来完全正常 —— 我真跑分离安装时就撞到过
  //    (5 次调用 5 次 error、阶段照样 complete,只有 manifest 里一个计数字段写着 5)。
  //    ⚠️ 判 incomplete 不判 failed:研究结果本身可能是好的,只是少了一层保证,该让人知道。
  if (input.hooksIneffective) c.push("incomplete");
  if (input.partial || input.stages.some((s) => s.status !== "complete")) c.push("incomplete");
  c.push("complete");
  return STATUS_PRIORITY.find((s) => c.includes(s)) ?? "incomplete";
}

/**
 * 钩子这一层到底有没有真的在跑。返回 null = 正常;返回字符串 = 失效原因。
 * ⚠️ 只在**真有 agent 轮次**时判:`--no-agent` 与纯播种运行本来就没有 turn,零调用是正常的。
 */
export function hooksIneffectiveReason(input: { enabled: boolean; installed: boolean; agentTurns: number; invocations: number; errors: number }): string | null {
  if (!input.enabled || !input.installed || input.agentTurns === 0) return null;
  if (input.invocations === 0) return "钩子已安装但整轮零调用:执行层(PreToolUse / Stop)实际没有生效";
  if (input.errors > 0) return `钩子有 ${input.errors} 次调用报错(多为上下文与 cwd 不一致):这些调用一律放行,该层纪律在这些点上没生效`;
  return null;
}

function sh(cmd: string, args: string[], cwd: string): string {
  try { return (spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: 30_000 }).stdout || "").trim(); } catch { return ""; }
}

/** 运行目录必须在 <repo>/.local/runs/ 之下;已存在且非空 → 需 overwrite */
export function prepareRunDir(cfg: RunConfig): void {
  const runsRoot = path.resolve(cfg.dataRoot, "runs");
  const rd = path.resolve(cfg.runDir);
  if (path.dirname(rd) !== runsRoot) throw new Error(`运行目录必须是 ${runsRoot} 的直接子目录:${rd}`);
  // 宪法必须存在,且**发现链**必须成立。发现链的规则与三种静默失效见 instructions_root.ts 文件头
  // (原先这里硬性要求"运行目录在产品根之内",既挡住了分离安装,也没拦住"无 .git 时静默丢宪法")。
  if (!fs.existsSync(cfg.constitutionPath)) throw new Error(`宪法文件不存在:${cfg.constitutionPath}`);
  // ⚠️ 这里比的是**产品根**的宪法,不是指令根的:分离安装时指令根上那份是同步过去的副本,
  //    而 prepareRunDir 跑在同步之前。副本与母本逐字节相同由 preflightInstructions 保证。
  const expected = path.join(path.resolve(cfg.repoRoot), CONSTITUTION_FILENAME);
  if (path.resolve(cfg.constitutionPath) !== expected)
    throw new Error(`宪法必须是产品根的 ${CONSTITUTION_FILENAME}(${expected}),它是引擎实际加载那份的母本;配置为 ${cfg.constitutionPath} 不会生效`);
  // 🔴 夹具的校验放在**清空之前**:夹具坏了 / 过期 / 主体不符时,不该先把旧运行目录毁掉再失败
  //    (Codex fixture-r1 P2)。这里只校验不落盘,播种在建目录之后。
  // 顺序:①不改磁盘的 overwrite 门控 → ②夹具校验(也不改磁盘)→ ③清空 → ④建目录 → ⑤播种。
  // 前两步都不动磁盘,所以夹具坏 / 过期 / 口径不符时旧运行目录**原封不动**(Codex fixture-r1 P2 / r2 P3)。
  const dirBusy = fs.existsSync(rd) && fs.readdirSync(rd).length > 0;
  if (dirBusy && !cfg.overwrite) throw new Error(`运行目录已存在且非空:${rd}(复用 run-id 会混入旧证据;换 run-id 或加 --overwrite)`);
  if (cfg.seedFrom) {
    // 夹具若就在运行目录里(或反之),下一步的清空会把刚校验通过的夹具本身删掉(Codex fixture-r3 P2)
    const fx = path.resolve(cfg.seedFrom), rel = path.relative(fx, rd);
    if (fx === rd || !rel.startsWith("..") || !path.relative(rd, fx).startsWith("..")) {
      throw new FixtureError(`夹具目录与运行目录不得相同或互相包含:夹具 ${fx} / 运行 ${rd}`);
    }
  }
  const fixture = cfg.seedFrom ? checkFixture(cfg) : null;
  if (dirBusy) fs.rmSync(rd, { recursive: true, force: true });
  ensureDirs(rd, ["raw", "fetch", "calcs", "stages"]);
  if (fixture) {
    // 播种中途失败会留下"半个运行目录",而旧目录此时已经删掉了(不可恢复)——
    // 至少不要把半成品留在那里冒充一次运行(Codex fixture-r2 P2)。
    try { seedRunDir(cfg.seedFrom as string, rd, fixture); }
    catch (e) {
      fs.rmSync(rd, { recursive: true, force: true });
      throw new FixtureError(`播种失败,已清除半成品运行目录 ${rd}${dirBusy ? "(注意:同名的旧运行目录已在此之前被 --overwrite 清除,无法恢复)" : ""}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * 用夹具播种运行目录(只在 cfg.seedFrom 时)。**校验在前、播种在后**:
 * 完整性(逐文件哈希 + 树哈希 + 不许有清单外的多余文件)与新鲜度(同一数据日)任一不过就抛,
 * 绝不"降级继续" —— 拿上周的数配今天的数,硬测试会因错误的原因通过或失败。
 */
/** 当前 calc 库版本(与 runResearchInner 里取法一致;取不到则 "unknown") */
function calcVersionOf(cfg: RunConfig): string {
  try { return JSON.parse(sh(cfg.python, [path.join(cfg.repoRoot, cfg.calcCliRel), "list"], cfg.repoRoot)).calc_version ?? "unknown"; }
  catch { return "unknown"; }
}

/** @param calcVersion 显式给出当前 calc 版本(测试用);不给就现探 */
export function checkFixture(cfg: RunConfig, calcVersion?: string): FixtureManifest {
  const m = verifyFixture(cfg.seedFrom as string);
  if (m.symbol !== cfg.symbol || m.market !== cfg.market) {
    throw new FixtureError(`夹具是 ${m.symbol}.${m.market} 的,本次运行是 ${cfg.symbol}.${cfg.market}`);
  }
  // 口径指纹:任一不同,夹具里的前四阶段产物就与本次运行不是一回事(取了不同端点 / 不同 calc 形状)
  const mism: string[] = [];
  // 三项指纹同一口径:**任一边为空或 unknown 都判不一致** —— "两边都不知道"证明不了口径相同
  // (Codex fixture-r4 P1:早先只对 calc 这么做,registry / endpoint 仍允许空等于空)
  const cmp = (name: string, mine: string, theirs: string) => {
    const bad = (x: string) => !x || x === "unknown";
    if (bad(theirs)) mism.push(`本次 ${name} 未知(${theirs || "空"}),无法证明与夹具口径一致`);
    else if (bad(mine)) mism.push(`夹具没有记录 ${name}`);
    else if (mine !== theirs) mism.push(`${name} ${mine} ≠ ${theirs}`);
  };
  cmp("registry", m.fingerprint.registry_version, String(cfg.registryVersion ?? ""));
  cmp("endpoint scope", m.fingerprint.endpoint_scope, String(cfg.endpointScope ?? ""));
  cmp("calc 版本", m.fingerprint.calc_version, calcVersion ?? calcVersionOf(cfg));   // 只探一次
  if (mism.length) throw new FixtureError(`夹具口径与本次运行不一致:${mism.join(";")};重建夹具`);
  const fresh = fixtureFreshness(m);
  if (!fresh.fresh && !cfg.allowStaleFixture) {
    throw new FixtureError(`夹具数据日 ${m.data_day} 不是今天(${fresh.today}):数据逐日变化,跨日复用会让硬测试因错误的原因通过或失败;重建夹具,或显式加 --allow-stale-fixture 承担这个代价`);
  }
  return m;
}

/** 校验 + 播种(测试与外部调用方用;正式路径见 prepareRunDir) */
export function seedFixtureInto(cfg: RunConfig, runDir: string, calcVersion?: string): FixtureManifest {
  const m = checkFixture(cfg, calcVersion);
  seedRunDir(cfg.seedFrom as string, runDir, m);
  return m;
}

export async function runResearch(cfg: RunConfig, deps: Deps, onlyStages?: Stage[]): Promise<RunResult> {
  prepareRunDir(cfg);
  try {
    return await runResearchInner(cfg, deps, onlyStages);
  } catch (e) {
    // 异常路径也要闭合领域事件(API / UI 不会永远停在 running),并把 manifest 标为 failed
    const msg = e instanceof Error ? e.message : String(e);
    const cancelled = isResearchCancellation(e, deps.signal);
    try {
      const mp = path.join(cfg.runDir, "manifest.json");
      const m = fs.existsSync(mp) ? (JSON.parse(fs.readFileSync(mp, "utf8")) as Manifest) : null;
      if (m) { m.status = "failed"; m.exit_code = 3; m.finished_at = nowIso();
        if (cancelled) m.cancelled = true;
        // 这里只识别订阅执行器的类型化异常；取数/校验异常不是模型错误。
        else if (e instanceof LocalAgentError) {
          m.failure_code = classifyResearchFailure(`${e.code}: ${msg}`);
          if (m.failure_code) m.final_errors = [...(m.final_errors ?? []), `execution:${m.failure_code}: ${researchFailure(m.failure_code)!.message}`];
        }
        m.final_errors = [...(m.final_errors ?? []), `exception:${msg}`]; writeManifest(cfg, m); }
    } catch { /* 尽力而为 */ }
    deps.runner.log("orchestrator", cancelled ? "research.cancelled" : "research.failed", { error: msg });
    deps.runner.log("orchestrator", "research.finished", { run_id: cfg.runId, status: cancelled ? "cancelled" : "failed", exit_code: 3, error: msg });
    throw e;
  }
}

async function runResearchInner(cfg: RunConfig, deps: Deps, onlyStages?: Stage[]): Promise<RunResult> {
  const REPORT_STAGE = currentPlugin().reportStage as Stage;   // 报告阶段由契约给,Core 不写死阶段名(全审 r4)
  const { runner } = deps;
  const sdk = deps.sdkVersion();
  const runtimeKind = sdk.kind ?? cfg.engine;
  const actualModel = sdk.model ?? cfg.model ?? null;
  let calcVersion = "unknown";
  try { calcVersion = JSON.parse(sh(cfg.python, [path.join(cfg.repoRoot, cfg.calcCliRel), "list"], cfg.repoRoot)).calc_version ?? "unknown"; } catch { /* unknown */ }
  const repoVersion = repositoryVersion(cfg.repoRoot);
  // 夹具已经"跑过"的阶段自动跳过;若调用方显式点名要跑其中之一,说明意图冲突,直接报错而不是默默二选一
  const seededStages = cfg.seedFrom ? readFixture(cfg.seedFrom).stages : [];
  if (onlyStages?.some((s) => seededStages.includes(s))) {
    throw new FixtureError(`--stages 里含夹具已播种的阶段(${onlyStages.filter((s) => seededStages.includes(s)).join(", ")}):要重跑它就别用夹具`);
  }
  const allStages = packStages();
  const stagesToRun = allStages.filter((s) => (!onlyStages || onlyStages.includes(s)) && !seededStages.includes(s));
  const partial = stagesToRun.length !== allStages.length;
  const configHash = sha256Text(JSON.stringify({ ...cfg, runDir: undefined, repoRoot: undefined })).slice(0, 16);
  const providerOrigin = (() => {
    if (!cfg.provider.base_url) return null;
    try {
      const parsed = new URL(cfg.provider.base_url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch { return null; }
  })();

  const manifest: Manifest = {
    run_id: cfg.runId, symbol: cfg.symbol, market: cfg.market, started_at: nowIso(), finished_at: null, status: "running", stages: [],
    codex_version: sdk.version,
    model: actualModel,
    model_note: runtimeKind === "local_agent"
      ? "本机订阅 Agent 的实际模型由已登录 CLI 决定；CLI 未向产品回报模型名"
      : cfg.model
      ? "显式指定"
      : actualModel
        ? `provider 默认模型，已由 ${runtimeKind === "direct" ? "Direct" : "Codex"} 运行时解析`
        : "未指定:使用 provider 的默认模型(事件流不回报实际模型名)",
    // 运行记账只需要识别 provider，不需要可能含租户路径或凭据的完整端点。
    provider: { name: cfg.provider.name, wire_api: cfg.provider.wire_api, base_url: providerOrigin, env_key: cfg.provider.env_key, auth: cfg.provider.auth, profile: cfg.providerProfile?.id ?? null, matrix_status: cfg.providerProfile?.matrix?.status ?? null },
    engine: {
      codex_path: runtimeKind === "codex" ? (sdk.codexPath ?? cfg.codexPath) : null,
      codex_home: runtimeKind === "codex" ? (sdk.codexHome ?? cfg.codexHome) : null,
      binary: sdk.binary,
    },
    constitution: { path: cfg.constitutionPath, sha256: sha256File(cfg.constitutionPath) },
    hooks: { enabled: cfg.hooksEnabled, installed: false, hooks_json: null, invocations: 0, stop_blocks: 0, stop_terminations: 0, pre_tool_use_blocks: 0, errors: 0, log_trust: "diagnostic_untrusted" },
    calc_version: calcVersion, repo_version: repoVersion, config_hash: configHash, raw_hashes: {}, execution_scope: [...stagesToRun], partial_run: partial,
    thread_id: null, fetch_ledger: {}, evidence_count: 0, calculation_count: 0, evidence_conflicts: [], gate: { ok: true, hits: [] }, exit_code: 2,
    // 🔴 隔离标记**在 manifest 一创建时就置位**,而不是等收尾 —— 运行中途崩了,磁盘上的 manifest
    //    也必须一眼看得出这是播种运行,否则它会像一次普通研究(Codex fixture-r2 P2)。收尾处只做补全。
    ...(cfg.seedFrom ? { test_scenario: true } : {}),
    endpoint_scope: cfg.endpointScope, registry_version: cfg.registryVersion,
    user_reports: [],
  };
  /** 编排器自有产物的 sha256(conflicts.json / manifest.json),与 runner 的 events 摘要一起构成"受保护产物"认证 */
  const protectedFiles: Record<string, string> = {};
  const persistManifest = () => { writeManifest(cfg, manifest); protectedFiles["manifest.json"] = sha256File(path.join(cfg.runDir, "manifest.json")); };
  const protectedNow = (): ProtectedExpectation => ({ files: { ...protectedFiles }, eventsSha: runner.eventsDigest() });
  // 引擎生命周期(engine.ts):Codex 要准备指令发现链 / skills 隔离 / lifecycle hooks,直连引擎一样都不碰。
  // ⚠️ noAgent(干跑)不准备任何引擎环境 —— 原行为如此,别改成"总是 prepare"。
  const lifecycle = deps.lifecycle ?? new CodexEngineLifecycle(cfg, codexCapabilities(cfg, structuredOutputMode(cfg.providerProfile) === "prompt" ? "prompt" : "server_schema"));
  const lifecycleCtx: LifecycleContext = {
    log: (stage, type, payload) => runner.log(stage, type, payload),
    markProtected: (rel) => { protectedFiles[rel] = sha256File(path.join(cfg.runDir, rel)); },
    unmarkProtected: (rel) => { delete protectedFiles[rel]; },
    manifest: manifest as unknown as Record<string, unknown>,
  };
  manifest.engine.capabilities = lifecycle.capabilities;
  if (!cfg.noAgent) lifecycle.prepare(lifecycleCtx);
  const hookCtx = (stage: Stage, attempt: number) => {
    // 受控工具(Windows 的 MCP 链路、直连引擎)都复用这份逐 turn 上下文;它们不执行 hook,
    // 只用 stage/attempt 判当前阶段、约束写入范围。判据见 config.ts 的 needsTurnContext。
    if (!needsTurnContext(cfg)) return;
    lifecycle.beforeTurn(lifecycleCtx, stage, attempt);
    if (cfg.scenario?.hook_fault === "context_missing" && stage === (cfg.scenario.probe_stage ?? "profile")) {
      // 故障注入:本阶段不写钩子上下文 → 钩子应放行但出声(hooks.log error),编排器 validator 兜底
      const p = path.join(cfg.runDir, HOOK_CONTEXT_REL); if (fs.existsSync(p)) fs.rmSync(p); delete protectedFiles[HOOK_CONTEXT_REL];
      runner.log(stage, "scenario.hook_context_withheld", { attempt });
      return;
    }
    writeHookContext(cfg, stage, attempt);
    protectedFiles[HOOK_CONTEXT_REL] = sha256File(path.join(cfg.runDir, HOOK_CONTEXT_REL));
  };
  /** 真实跑过的 agent 轮次数:零调用只有在**有过 turn** 时才算钩子失效(--no-agent / 纯播种运行本来就没有) */
  let agentTurns = 0;
  /** turn 后汇总钩子日志(诊断,不可信);Stop 钩子留下终止标记 → 该 turn 视为失败(缺产物不许正常收工) */
  /** turn 后的引擎收尾:返回非 null = 该 turn 判失败(Codex 下即 Stop 钩子终止;详见 engines/codex_lifecycle.ts) */
  const hookSummary = (stage: Stage, attempt: number): string | null => lifecycle.afterTurn(lifecycleCtx, stage, attempt);
  // M2 知识层召回:只在未由 scenario 注入且开启时;注入文本进全阶段提示词,由 knowledge_conflicts 裁决
  if (shouldRecall(cfg)) {
    const k = recallKnowledge(cfg);
    const reports = researchReportContext(cfg);
    manifest.user_reports = reports?.hits.map((x) => ({ id: x.id, name: x.name, page: x.page })) ?? [];
    if (k || reports) {
      const reportText = reports ? `\n\n## 用户资料库命中（上传时间不是资料期）\n${reports.text}` : "";
      const asOf = k?.as_of ?? reports!.hits.map((x) => x.uploaded_at.slice(0, 10)).sort().at(-1) ?? "1970-01-01";
      const text = `${k?.text ?? ""}${reportText}`.trim();
      const sourcePath = k?.path ?? path.join(cfg.dataRoot, "knowledge", "reports", "manifest.json");
      const truncated = (k?.truncated ?? false) || (reports?.truncated ?? false);
      cfg.knowledge = { as_of: asOf, text, status: k?.status ?? "stale", path: sourcePath };
      manifest.knowledge_recalled = { path: sourcePath, as_of: asOf, status: k?.status ?? "stale", truncated };
      runner.log("orchestrator", "knowledge.recalled", { path: sourcePath, as_of: asOf, status: k?.status ?? "stale", chars: text.length, truncated, user_reports: reports?.hits.length ?? 0 });
    } else { manifest.knowledge_recalled = null; runner.log("orchestrator", "knowledge.none", { dir: path.join(cfg.dataRoot, "knowledge") }); }
  } else manifest.knowledge_recalled = null;
  persistManifest();
  const loggedConfig: Record<string, unknown> = { ...cfg, endpoints: Object.keys(cfg.endpoints).length };
  delete loggedConfig.taskObjective;
  delete loggedConfig.reportIds;
  delete loggedConfig.reportRevisions;
  loggedConfig.provider = { ...cfg.provider, base_url: providerOrigin };
  loggedConfig.providerProfile = cfg.providerProfile ? {
    id: cfg.providerProfile.id,
    wire_api: cfg.providerProfile.wire_api,
    env_key: cfg.providerProfile.env_key,
    matrix_status: cfg.providerProfile.matrix?.status ?? null,
  } : null;
  runner.log("orchestrator", "run.start", { config: loggedConfig, codex_version: sdk.version, codex_binary: sdk.binary, calc_version: calcVersion, repo_version: repoVersion, stages: stagesToRun });
  // 领域事件(v2.1 §5 ④,供 API / UI 消费):research.started / stage.completed / gate.failed / report.ready / research.finished
  runner.log("orchestrator", "research.started", { run_id: cfg.runId, symbol: cfg.symbol, market: cfg.market, stages: stagesToRun, run_dir: cfg.runDir });

  const stageRecords: StageRecord[] = [];
  const trace: AgentTrace = { commands: [], fileChanges: [] };
  const statusSoFar: Record<string, string> = {};
  /** 权威账本:只存在于编排器内存;磁盘上的 _ledger.json 仅供审计,validator 从不读它 */
  const ledger: Ledger = {};
  // 夹具运行:被跳过的那几个阶段没有机会往内存账本里写,必须把夹具里那部分补回来,
  // 否则它们的证据会被 validator 判成"没有账本条目"。这里用的是 loadLedgerFromDisk ——
  // 产品既有的受限通道(原用于审计 / --no-agent 复核),而**播种运行本身已按测试运行隔离**
  // (test_scenario=true、不进知识层),所以不削弱"正式运行只信内存账本"这条不变量。
  if (cfg.seedFrom) {
    // 🔴 先把隔离标记**落盘**,再做可能抛错的账本加载(Codex fixture-r3 P2):
    //    否则"运行目录里已经有播种证据、磁盘 manifest 却还看不出这是播种运行"的窗口是真实存在的。
    const fm = readFixture(cfg.seedFrom);
    manifest.seeded_from = { fixture_data_day: fm.data_day, source_run_id: fm.source_run_id, stages: seededStages, stale: !fixtureFreshness(fm).fresh };
    manifest.test_scenario = true;
    persistManifest();
    const seededLedger = loadLedgerFromDisk(cfg.runDir);
    Object.assign(ledger, seededLedger);
    runner.log("orchestrator", "fixture.seeded", { ...manifest.seeded_from, ledger_entries: Object.keys(seededLedger).length });
  }
  /** 阶段计划(注册表推导):validator 用内存计划;fetch/_plan.json 仅供审计与 --no-agent 复核 */
  const planOf = { plan: cfg.stagePlan, critical: cfg.criticalScripts, endpoints: cfg.endpoints };
  writeJson(path.join(cfg.runDir, PLAN_REL), planFileOf(cfg.endpointScope, cfg.registryVersion, cfg.stagePlan, cfg.criticalScripts, cfg.endpoints));
  runner.log("orchestrator", "plan.written", { scope: cfg.endpointScope, registry_version: cfg.registryVersion, stages: Object.fromEntries(Object.entries(cfg.stagePlan).map(([k, v]) => [k, { required: v.required.length, optional: v.optional.length }])) });

  let stoppedFailure: ResearchFailureCode | null = null;
  for (const stage of stagesToRun) {
    deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    const scripts = cfg.stagePlan[stage];
    let toFetch = [...scripts.required, ...scripts.optional];
    // 取数前的垂类门控:Core 无条件调用一次,由插件决定实际跑哪些端点(原本这段直接 import 金融模块)。
    toFetch = currentPlugin().beforeFetch?.({
      stage, runDir: cfg.runDir, repoRoot: cfg.repoRoot, planned: toFetch, endpoints: cfg.endpoints,
      protect: (rel) => { protectedFiles[rel] = sha256File(path.join(cfg.runDir, rel)); },
      record: (key, value) => { (manifest as unknown as Record<string, unknown>)[key] = value; },
      log: (type, payload) => runner.log(stage, type, payload),
    }) ?? toFetch;
    await deps.fetchRunner(cfg, stage, toFetch, (t, p) => runner.log(stage, t, p), ledger, deps.signal);
    deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    // 取数后的垂类后处理:Core **无条件调用一次**,由插件自己决定管不管这个阶段、做什么。
    // 🔴 这里原本写死 `if (stage === "risk" || stage === "report")` 并直接 import 金融模块(全审 r4-P1)。
    currentPlugin().afterFetch?.({
      stage, runDir: cfg.runDir, repoRoot: cfg.repoRoot,
      protect: (rel) => { protectedFiles[rel] = sha256File(path.join(cfg.runDir, rel)); },
      record: (key, value) => { (manifest as unknown as Record<string, unknown>)[key] = value; },
      log: (type, payload) => runner.log(stage, type, payload),
    });
    // 取数后即刷新权威冲突集(risk / report 阶段的 agent 读 conflicts.json;validator 核对 risk.source_conflicts 覆盖)
    const conf = writeConflicts(cfg);
    protectedFiles["conflicts.json"] = sha256File(path.join(cfg.runDir, "conflicts.json"));
    if (conf.sourceConflicts.length || conf.idConflicts.length) runner.log(stage, "conflicts.updated", { source: conf.sourceConflicts.length, id: conf.idConflicts.length });
    const rec: StageRecord = { stage, status: "failed", attempts: 0, errors: [], validator_ok: false };
    let res: ValidationResult = { ok: false, errors: ["未运行"], warnings: [] };
    let lastErrors: string[] | undefined;
    let turnFailed = false;
    let executionFailure: ResearchFailureCode | null = null;
    const maxAttempts = cfg.noAgent ? 1 : cfg.maxRetries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      deps.checkpoint?.();
      deps.signal?.throwIfAborted();
      rec.attempts = attempt + 1;
      turnFailed = false;
      executionFailure = null;
      if (!cfg.noAgent) {
        const prompt = currentPlugin().buildStagePrompt(stage, cfg, { attempt, validatorErrors: lastErrors, stageStatusSoFar: statusSoFar, ledger });
        console.error(`[orchestrator] stage=${stage} attempt=${attempt + 1}/${maxAttempts}`);
        hookCtx(stage, attempt + 1);
        agentTurns += 1;
        const turn = await runner.runTurn(stage, attempt + 1, prompt, turnReplySchema, deps.signal);
        deps.checkpoint?.();
        deps.signal?.throwIfAborted();
        const stopFail = hookSummary(stage, attempt + 1);
        trace.commands.push(...turn.commands.map((c) => c.command));
        trace.fileChanges.push(...turn.fileChanges);
        if (turn.failed) {
          turnFailed = true; rec.errors.push(`turn 失败:${turn.failed}`);
          const code = classifyResearchFailure(turn.failed);
          executionFailure = code;
          if (code && (!researchFailure(code)!.retryable || attempt + 1 === maxAttempts)) stoppedFailure = code;
        }
        if (stopFail) { turnFailed = true; rec.errors.push(stopFail); }
      }
      const run = loadRun(cfg.runDir, ledger, planOf);
      res = validateStage(stage, run);
      const behaviour = checkAgentTrace(trace, cfg);
      if (!behaviour.ok) res = { ok: false, errors: [...res.errors, ...behaviour.errors], warnings: res.warnings };
      const prot = validateProtectedArtifacts(cfg.runDir, protectedNow());
      if (!prot.ok) res = { ok: false, errors: [...res.errors, ...prot.errors], warnings: res.warnings };
      if (res.ok && run.calcs.length) {
        const rv = deps.verify(cfg, run);
        if (!rv.ok) res = { ok: false, errors: rv.errors, warnings: res.warnings };
      }
      runner.log(stage, "validator", { attempt: attempt + 1, ok: res.ok, errors: res.errors, warnings: res.warnings });
      if (stoppedFailure) break;
      if (res.ok && !turnFailed) break; // turn 本身失败(含 Stop 钩子终止)即使产物恰好过校验也要补跑
      lastErrors = res.errors;
      console.error(`[orchestrator] stage=${stage} validator 未通过(${res.errors.length} 条)\n${summarizeErrorsForAgent(res, 6)}`);
      // 🔴 取数层的契约违约,**再补跑多少次都不可能过** —— agent 改不了 fetch/ 下的产物
      //    (钩子也禁止它写)。继续重试只是白烧时间,而且日志上"自动补跑"会把上游的数据问题
      //    说成 agent 没做好。⇒ 立刻停下并如实归因。
      const upstream = res.errors.filter(isUpstreamContractError);
      if (upstream.length) {
        // 上游契约已不可由模型修复；若同时有执行错误，整次停止而非继续后续阶段。
        stoppedFailure = executionFailure;
        console.error(`[orchestrator] stage=${stage} 其中 ${upstream.length} 条是**取数层**契约违约(agent 无法修复),不再补跑:\n  ${upstream.slice(0, 3).join("\n  ")}`);
        runner.log(stage, "validator.upstream_contract", { attempt: attempt + 1, errors: upstream });
        break;
      }
    }
    rec.validator_ok = res.ok;
    rec.errors.push(...res.errors);
    rec.status = deriveStageStatus(stage, res.ok, turnFailed, loadRun(cfg.runDir, ledger, planOf));
    stageRecords.push(rec);
    statusSoFar[stage] = rec.status;
    manifest.stages = stageRecords;
    manifest.fetch_ledger = ledgerSummary(ledger);
    manifest.thread_id = runner.threadId;
    if (stoppedFailure) manifest.failure_code = stoppedFailure;
    persistManifest();
    runner.log(stage, "stage.completed", { stage, status: rec.status, attempts: rec.attempts, validator_ok: rec.validator_ok, errors: rec.errors.length });
    if (stoppedFailure) { runner.log(stage, "research.execution_stopped", { code: stoppedFailure }); break; }
  }

  // ── 阶段终复核(恢复路径)─────────────────────────────────────────────────────────────────────────
  // Stop 钩子的"缺产物"预算可能在模型的最后一步"写 stage 文件"之前被烧尽(攒 N 轮 calc 才写
  //  stage 文件是合规工作流),本轮被强制终止;而后续轮次常常把那个文件补写落盘且完全合法 ——
  //  但主循环只校验"当前阶段的当前轮",前面阶段的记录就此定格,账本与磁盘脱节。
  //  (2026-09-05 600519 run: financials/estimates 被判 failed,stage 文件却已在 16:45/16:46 落盘
  //   且 status=complete,编排器从未回头认领。)
  //  恢复的边界(两条,缺一会误伤安全语义):
  //   1) 只认领"失败原因纯属收工时机"的阶段 —— rec.errors 里每条都是 Stop 终止/缺产物类;
  //      行为违规(篡改 events.jsonl / 受保护产物)、turn 失败、取数契约违约导致的失败**不恢复**
  //      (产物后来得再齐,违规事实不因此消失)。
  //   2) 恢复校验 = validateStage + 受保护产物 + calc DAG 复核(与主循环同一套尺子),
  //      但**不重跑 checkAgentTrace**:trace 是跨阶段累积的行为审计,主循环每阶段已判过,
  //      这里重跑会把后续阶段的行为错误错算到前面阶段头上。
  //  只"认领"已存在的合法产物,不降低任何校验标准,不凭空制造产物。report 阶段由下方 gate
  //  重写循环复验,这里不碰(它还会走 normalizeReportStatus,口径不同)。
  for (let i = 0; i < stageRecords.length - 1; i++) {
    const rec = stageRecords[i];
    if (rec.status === "complete" || rec.status === "skipped") continue;
    if (!rec.errors.every((e) => e.startsWith("Stop 钩子终止本轮") || /缺少 stages\//.test(e))) {
      runner.log(rec.stage, "stage.recover_rejected", { from: rec.status, reason: "失败原因含非收工时机类错误(行为违规 / turn 失败 / 契约违约),不恢复" });
      continue;
    }
    const reRun = loadRun(cfg.runDir, ledger, planOf);
    if (!reRun.stage(rec.stage)) continue; // 磁盘仍无产物 ⇒ 无物可认领,维持原判
    let reRes: ValidationResult = validateStage(rec.stage, reRun);
    const reProt = validateProtectedArtifacts(cfg.runDir, protectedNow());
    if (!reProt.ok) reRes = { ok: false, errors: [...reRes.errors, ...reProt.errors], warnings: reRes.warnings };
    if (reRes.ok && reRun.calcs.length) { const rv = deps.verify(cfg, reRun); if (!rv.ok) reRes = rv; }
    if (!reRes.ok) { runner.log(rec.stage, "stage.recover_rejected", { from: rec.status, errors: reRes.errors.slice(0, 4) }); continue; }
    const recovered = deriveStageStatus(rec.stage, true, false, reRun);
    if (recovered !== rec.status) {
      runner.log(rec.stage, "stage.recovered", { from: rec.status, to: recovered, attempts: rec.attempts });
      rec.validator_ok = true;
      rec.status = recovered;
      rec.errors = [];
      statusSoFar[rec.stage] = recovered;
      manifest.stages = stageRecords;
      persistManifest();
    }
  }

  // 合规 gate:报告阶段 validator 已含 gate;这里是独立的最终一道闸 + 重写循环(重写后全量复验 report 阶段)
  const reportPath = path.join(cfg.runDir, "report.md");
  if (cfg.scenario?.force_gate_hit && fs.existsSync(reportPath) && stagesToRun.includes(REPORT_STAGE)) {
    // 故障注入(仅硬测试):确定性制造一份命中 gate 的报告,验证"gate 拦截 → 重写 → 复验"链路本身(与 agent 是否自律无关)
    fs.appendFileSync(reportPath, `\n${probeReportLine(gateProbeLine())}\n`);
    runner.log(REPORT_STAGE, "scenario.gate_hit_injected", {});
  }
  let gate = complianceGate(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "");
  const reportRec = stageRecords.find((s) => s.stage === REPORT_STAGE);
  // 未发生成功重写时，不能抹掉成稿 turn/Stop 的既有失败。
  let rewriteTurnFailed = !!stoppedFailure || reportRec?.status === "failed";
  let rewriteFailure: ResearchFailureCode | null = null;
  if (!gate.ok) runner.log(REPORT_STAGE, "gate.failed", { hits: gate.hits, will_rewrite: cfg.gateRetries > 0 && !cfg.noAgent && !!reportRec });
  for (let i = 0; i < cfg.gateRetries && !stoppedFailure && !gate.ok && !cfg.noAgent && reportRec; i++) {
    runner.log(REPORT_STAGE, "gate.rewrite", { attempt: i + 1, hits: gate.hits });
    hookCtx(REPORT_STAGE, 100 + i);
    agentTurns += 1;
    deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    const turn = await runner.runTurn(REPORT_STAGE, 100 + i, currentPlugin().buildRewritePrompt(cfg, gate.hits), turnReplySchema, deps.signal);
    deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    const stopFail = hookSummary(REPORT_STAGE, 100 + i);
    trace.commands.push(...turn.commands.map((c) => c.command));
    trace.fileChanges.push(...turn.fileChanges);
    rewriteTurnFailed = !!turn.failed || !!stopFail;
    rewriteFailure = turn.failed ? classifyResearchFailure(turn.failed) : null;
    if (stopFail) reportRec.errors.push(stopFail);
    if (turn.failed) {
      reportRec.errors.push(`gate 重写 turn 失败:${turn.failed}`);
      const code = classifyResearchFailure(turn.failed);
      if (code && (!researchFailure(code)!.retryable || i + 1 === cfg.gateRetries)) {
        stoppedFailure = code; manifest.failure_code = code;
        runner.log(REPORT_STAGE, "research.execution_stopped", { code });
      }
    }
    const run = loadRun(cfg.runDir, ledger, planOf);
    let rv = validateStage(REPORT_STAGE, run);
    const behaviour = checkAgentTrace(trace, cfg);
    if (!behaviour.ok) rv = { ok: false, errors: [...rv.errors, ...behaviour.errors], warnings: rv.warnings };
    const prot = validateProtectedArtifacts(cfg.runDir, protectedNow());
    if (!prot.ok) rv = { ok: false, errors: [...rv.errors, ...prot.errors], warnings: rv.warnings };
    if (rv.ok && run.calcs.length) { const v = deps.verify(cfg, run); if (!v.ok) rv = v; }
    runner.log(REPORT_STAGE, "validator", { attempt: 100 + i + 1, ok: rv.ok, errors: rv.errors, warnings: rv.warnings });
    reportRec.validator_ok = rv.ok;
    reportRec.errors = [...reportRec.errors.filter((e) => e.startsWith("gate 重写 turn 失败")), ...rv.errors];
    reportRec.attempts += 1;
    gate = complianceGate(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "");
    if (!gate.ok) runner.log(REPORT_STAGE, "gate.failed", { hits: gate.hits, after_rewrite: i + 1 });
  }
  // 重写过程中正文可能已修好，但 turn 随后超时；即使 gate 提前结束也保留执行失败原因。
  if (rewriteTurnFailed && rewriteFailure) { stoppedFailure = rewriteFailure; manifest.failure_code = rewriteFailure; }
  if (reportRec) reportRec.status = deriveStageStatus(REPORT_STAGE, reportRec.validator_ok && gate.ok, rewriteTurnFailed, loadRun(cfg.runDir, ledger, planOf));

  // 最终状态(确定性)
  deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const finalRun = loadRun(cfg.runDir, ledger, planOf);
  const qd = deriveQuoteDecision(finalRun);
  const reportInScope = stagesToRun.includes(REPORT_STAGE);
  const hooksIneffective = hooksIneffectiveReason({ enabled: cfg.hooksEnabled, installed: manifest.hooks.installed, agentTurns,
    invocations: manifest.hooks.invocations, errors: manifest.hooks.errors });
  if (hooksIneffective) runner.log("orchestrator", "hooks.ineffective", { reason: hooksIneffective, agent_turns: agentTurns, invocations: manifest.hooks.invocations, errors: manifest.hooks.errors });
  let status = deriveRunStatus({ stages: stageRecords, gateOk: gate.ok, reportExists: reportInScope ? !!finalRun.report : true, quoteDecision: qd.decision,
    criticalAllFailed: allCriticalFetchFailed(finalRun), partial, hooksIneffective });

  // 报告首行状态归一(不动正文),并核对一致性;最终校验失败 → 进入状态推导(产物不齐 / 校验不过不得宣称完成)
  const finalErrors: string[] = [];
  if (stoppedFailure) finalErrors.push(`execution:${stoppedFailure}: ${researchFailure(stoppedFailure)!.message}`);
  if (finalRun.report) {
    const n = normalizeReportStatus(finalRun.report, status);
    if (n.changed) { atomicWrite(reportPath, n.text); runner.log(REPORT_STAGE, "report.status_normalized", { to: status }); }
    const rv = validateReport(loadRun(cfg.runDir, ledger, planOf), status);
    if (!rv.ok) { runner.log(REPORT_STAGE, "report.final_check", { errors: rv.errors }); finalErrors.push(...rv.errors.map((e) => `report:${e}`)); }
  }
  const integrity = validateFetchIntegrity(loadRun(cfg.runDir, ledger, planOf));
  if (!integrity.ok) finalErrors.push(...integrity.errors.map((e) => `fetch:${e}`));
  const protFinal = validateProtectedArtifacts(cfg.runDir, protectedNow());
  if (!protFinal.ok) finalErrors.push(...protFinal.errors.map((e) => `protected:${e}`));

  const merged = writeMergedArtifacts(cfg);
  const finalCheck = validateFinalArtifacts(cfg.runDir);
  if (!finalCheck.ok) { runner.log("orchestrator", "final_artifacts.invalid", { errors: finalCheck.errors }); finalErrors.push(...finalCheck.errors.map((e) => `artifacts:${e}`)); }
  if (finalErrors.length && status !== "failed") { runner.log("orchestrator", "status.downgraded", { from: status, to: "failed", reason: finalErrors.slice(0, 5) }); status = "failed"; }
  manifest.status = status;
  manifest.finished_at = nowIso();
  manifest.raw_hashes = rawHashes(cfg.runDir);
  manifest.evidence_count = merged.evidence.length;
  manifest.calculation_count = merged.calcs.length;
  manifest.evidence_conflicts = [...merged.idConflicts.map((c) => ({ kind: "id", detail: c })), ...merged.sourceConflicts.map((c) => ({ kind: "source", ...c }))];
  manifest.gate = { ok: gate.ok, hits: gate.hits };
  manifest.exit_code = exitCodeFor(status);
  manifest.thread_id = runner.threadId;
  manifest.fetch_ledger = ledgerSummary(ledger);
  manifest.quote_decision = qd.decision;
  manifest.final_errors = finalErrors;
  const me = validateManifest(manifest);
  if (me.length) {
    runner.log("orchestrator", "manifest.schema_errors", { errors: me });
    manifest.final_errors = [...finalErrors, ...me.map((e) => `manifest:${e}`)];
    if (manifest.status !== "failed") { manifest.status = "failed"; manifest.exit_code = exitCodeFor("failed"); status = "failed"; }
    const me2 = validateManifest(manifest); // 修改后的最终对象再校验一次;仍不过则记录(状态已是 failed)
    if (me2.length) runner.log("orchestrator", "manifest.schema_errors_after_fix", { errors: me2 });
  }
  // 报告首行与最终状态再对齐一次(状态可能在最终校验后被降级)
  if (fs.existsSync(reportPath)) {
    const n2 = normalizeReportStatus(fs.readFileSync(reportPath, "utf8"), status);
    if (n2.changed) atomicWrite(reportPath, n2.text);
  }
  // No model/fetch work remains. Atomically close cancellation before any
  // archival side effect; a competing cancellation wins or is explicitly late.
  deps.beginFinalization?.();
  deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  // M2:查看器 / 附录(运行目录内,非受保护文件)+ 知识层归档(.local/knowledge);都在最终状态定下之后,失败只记事件不改状态
  manifest.viewer = null;
  manifest.knowledge_archived = null;
  // 任何 scenario(硬测试旋钮:注入冲突 / 证据 / 帖子、超时、钩子故障…)都意味着产物含合成数据 → 绝不归档进知识层(否则伪造证据会被下次召回)
  // 播种运行的产物混了**别次运行**的阶段数据 → 与 scenario 运行同等隔离(不进知识层、不进温度计历史)
  const isTestScenario = !!cfg.seedFrom || (!!cfg.scenario && Object.values(cfg.scenario).some((v) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0)));
  manifest.test_scenario = isTestScenario;
  if (cfg.knowledgeArchive) {
    const viewRun = loadRun(cfg.runDir, ledger, planOf);
    try { const v = writeViewer(cfg, viewRun, manifest); manifest.viewer = { html: v.htmlPath, appendix: v.appendixPath }; runner.log("orchestrator", "viewer.written", { html: v.htmlPath, appendix: v.appendixPath }); }
    catch (e) { runner.log("orchestrator", "viewer.failed", { error: e instanceof Error ? e.message : String(e) }); }
    if (stagesToRun.includes(REPORT_STAGE) && status !== "failed" && !isTestScenario) {
      try { const a = archiveRun(cfg, viewRun, manifest); manifest.knowledge_archived = { latest: a.latestFile, run_file: a.runFile, gate_removed: a.gateRemoved.length }; runner.log("orchestrator", "knowledge.archived", { latest: a.latestFile, gate_removed: a.gateRemoved.length }); }
      catch (e) { runner.log("orchestrator", "knowledge.archive_failed", { error: e instanceof Error ? e.message : String(e) }); }
    } else runner.log("orchestrator", "knowledge.archive_skipped", { reason: isTestScenario ? "测试场景运行(scenario)含合成数据,不归档" : status === "failed" ? "运行 failed 不归档" : "未含 report 阶段" });
    // 温度计历史序列:与知识层同规矩(scenario / failed 不写),但不要求 report 阶段——risk 阶段已校验的温度计信封就够
    manifest.thermo_archived = null;
    if (status !== "failed" && !isTestScenario) {
      try {
        currentPlugin().afterRun?.({ cfg, ledger,
          record: (key, value) => { (manifest as unknown as Record<string, unknown>)[key] = value; },
          log: (ty, p) => runner.log("orchestrator", ty, p) });
      }
      catch (e) { runner.log("orchestrator", "thermo_history.archive_failed", { error: e instanceof Error ? e.message : String(e) }); }
    } else runner.log("orchestrator", "thermo_history.archive_skipped", { reason: isTestScenario ? "测试场景运行(scenario)含合成数据" : "运行 failed" });
  }
  persistManifest();
  if (fs.existsSync(reportPath)) runner.log("orchestrator", "report.ready", { status, report: reportPath, manifest: path.join(cfg.runDir, "manifest.json"), evidence: path.join(cfg.runDir, "evidence.json"), calculations: path.join(cfg.runDir, "calculations.json") });
  runner.log("orchestrator", "research.finished", { run_id: cfg.runId, status, exit_code: manifest.exit_code, final_errors: finalErrors.length });
  runner.log("orchestrator", "run.done", { status, exit_code: manifest.exit_code, evidence: merged.evidence.length, calculations: merged.calcs.length, conflicts: manifest.evidence_conflicts.length });
  console.error(`[orchestrator] done status=${status} exit=${manifest.exit_code} evidence=${merged.evidence.length} calcs=${merged.calcs.length} conflicts=${manifest.evidence_conflicts.length}`);
  return { status, exitCode: manifest.exit_code, manifest };
}

/** Deep 任务圈选了资料时只使用这份白名单；旧研究入口仍沿用按对象召回。 */
export function researchReportContext(cfg: Pick<RunConfig, "dataRoot" | "symbol" | "companyName" | "taskObjective" | "reportIds" | "reportRevisions">): ReportContext | null {
  return cfg.reportIds?.length
    ? reportContext(cfg.dataRoot, cfg.taskObjective ?? cfg.symbol, {
        // Deep 最多允许 16 份；单份检索片段上限约 1,780 字，40K 足以让每份至少进入一个片段。
        // 不能沿用普通对话的 10K，否则明确圈选的后几份会被静默截掉。
        limit: Math.min(cfg.reportIds.length, 16), maxChars: 40_000, reportIds: cfg.reportIds, mustInclude: true,
        expectedRevisions: cfg.reportRevisions,
      })
    : reportsForSymbol(cfg.dataRoot, cfg.symbol, { maxChars: 10_000, companyName: cfg.companyName });
}
