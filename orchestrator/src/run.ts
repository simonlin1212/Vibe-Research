#!/usr/bin/env node
/**
 * 薄编排器 CLI 入口。
 * 用法:node orchestrator/src/run.ts --symbol 300308 [--run-id X] [--python /path/python] [--model m] [--reasoning medium]
 *      [--max-retries 2] [--gate-retries 2] [--turn-timeout-min 20] [--stages profile,financials] [--no-agent] [--overwrite]
 *      [--scenario scenario.json](故障注入:fail_scripts / timeout_scripts / inject_evidence / knowledge / induce_text)
 *      [--config <用户配置.json>] [--codex-path <引擎二进制>] [--codex-home <目录>](默认读 vibe-research.config.json + .local/config.json + 环境变量 VRA_*)
 *      [--no-hooks](不安装 Stop / PreToolUse 钩子;默认安装到产品 CODEX_HOME)
 *      [--execution-mode shell_hooks|controlled_mcp](默认:Windows=controlled_mcp,其他平台=shell_hooks；受控模式关闭 Shell 与 hooks)
 *      [--endpoints full|core](full = 注册表全部启用端点(默认);core = 仅 Phase 0 的 8 个 legacy 脚本)
 *      [--knowledge on|off](默认 on:召回 .local/knowledge 里该主体的档案注入提示词)[--no-archive](不生成 viewer / 附录、不归档知识层)
 *      [--progress on|off](默认 on:把阶段进度与各阶段 summary 实时打到 **stderr**,首次可读产出 ~80 秒;stdout 的 JSON 契约不变)
 *      [--seed-from <夹具目录>] [--allow-stale-fixture](**仅硬测试用**:播种前几个阶段的产物并跳过它们,省约一半墙钟;播种运行按测试运行隔离,不进知识层,不能替代发布前的完整运行)
 *      [--provider <id>](providers/<id>.json;默认 openai;非 openai 只能 api_key,未显式指定 auth 时自动选模板唯一支持的模式;也可用环境变量 VRA_PROVIDER)
 *      [--auth api_key|chatgpt_login](显式指定认证方式,优先级最高;也可用环境变量 VRA_PROVIDER_AUTH)
 *      [--experimental-direct-deep](开发者实验入口；必须与 --engine direct 同时使用，不是产品 Quick)
 * 退出码:0 complete / 2 incomplete|stale / 3 failed 或编排异常。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeConfig, secretsFor, type RunConfig, type Scenario, type Stage } from "./config.ts";
import type { EngineLifecycle, EngineRuntime } from "./engine.ts";
import { CodexEngineLifecycle, codexCapabilities } from "./engines/codex_lifecycle.ts";
import { DirectEngineLifecycle, directCapabilities } from "./engines/direct_lifecycle.ts";
import { DirectStageAgent } from "./engines/direct_stage_agent.ts";
import { LocalAgentEngineLifecycle, localAgentCapabilities } from "./engines/local_agent_lifecycle.ts";
import { LocalAgentStageAgent } from "./engines/local_agent_stage_agent.ts";
import { directCapabilityOf, structuredOutputMode } from "./providers.ts";
import type { AgentRunner } from "./agent_runner.ts";
import { runFetchScripts } from "./fetchrun.ts";
import { watchResearchCancellation, updateResearchControl, isResearchCancellation } from "./research_control.ts";
import { ProgressReporter } from "./progress.ts";
import { runResearch } from "./orchestrate.ts";
import { loadProductConfig } from "./productConfig.ts";
import { resolveRuntimeProvider, type LlmOverride } from "./runtime_provider.ts";
import { probeClaude, probeCodeBuddy } from "./local_agent_runtime.ts";
import { isStage } from "./schemas.ts";
import { verifyCalcs } from "./validator.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function parseExecutionMode(v: string | undefined): "shell_hooks" | "controlled_mcp" | undefined {
  if (v === undefined) return undefined;
  if (v === "shell_hooks" || v === "controlled_mcp") return v;
  throw new Error(`--execution-mode 只能是 shell_hooks 或 controlled_mcp,收到 ${v}`);
}

/** 认不出的引擎名一律报错 —— 静默落回默认会让用户以为在用自己选的那个,而账单和产出来自另一个 */
function parseEngine(v: string | undefined): "codex" | "direct" | undefined {
  if (v === undefined) return undefined;
  if (v === "codex" || v === "direct") return v;
  throw new Error(`--engine 只能是 codex 或 direct,收到 ${v}`);
}

/** 配置优先级:内置默认 ← 产品配置文件 ← 用户配置文件 ← 环境变量 ← CLI 参数 */
function parseScope(v: string | undefined): "core" | "full" {
  if (v === undefined || v === "full") return "full";
  if (v === "core") return "core";
  throw new Error(`--endpoints 只能是 full 或 core,收到 ${v}`);
}

export function configFromArgs(args: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): { cfg: RunConfig; stages?: Stage[]; sources: string[]; progress: boolean } {
  if (!str(args.symbol)) throw new Error("缺少 --symbol");
  let scenario: Scenario | null = null;
  if (str(args.scenario)) scenario = JSON.parse(fs.readFileSync(str(args.scenario)!, "utf8")) as Scenario;
  const repoRoot = str(args["repo-root"]) ?? repoRootFromHere();
  const requestMeta = String(env.VRA_REQUEST_LLM_META ?? "").trim();
  const pc = loadProductConfig(repoRoot, { userConfigPath: str(args.config), env,
    providerOverride: str(args.provider), authOverride: str(args.auth), ...(requestMeta ? { requireAuth: false as const } : {}) });
  let requestRuntime: ReturnType<typeof resolveRuntimeProvider> | null = null;
  if (requestMeta) {
    let llm: LlmOverride;
    try {
      const parsed = JSON.parse(requestMeta) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          Object.keys(parsed).some((key) => !["provider", "baseURL", "model", "envKey"].includes(key)) ||
          typeof parsed.provider !== "string" ||
          (parsed.envKey !== undefined && (typeof parsed.envKey !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.envKey))) ||
          (!parsed.provider.startsWith("cli-") && typeof parsed.envKey !== "string") ||
          ["baseURL", "model"].some((key) => parsed[key] !== undefined && typeof parsed[key] !== "string")) {
        throw new TypeError("shape");
      }
      llm = { provider: parsed.provider, baseURL: parsed.baseURL as string | undefined,
        model: parsed.model as string | undefined,
        ...(typeof parsed.envKey === "string" ? { apiKey: String(env[parsed.envKey] ?? "") } : {}) };
    } catch { throw new Error("VRA_REQUEST_LLM_META 格式无效"); }
    requestRuntime = resolveRuntimeProvider(repoRoot, pc.resolved.dataRoot, llm, env);
  }
  const d = pc.defaults;
  const taskObjective = String(env.VRA_TASK_OBJECTIVE ?? "").trim();
  if (taskObjective.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskObjective)) {
    throw new Error("VRA_TASK_OBJECTIVE 格式无效");
  }
  const reportIds = String(env.VRA_TASK_REPORT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (reportIds.length > 16 || new Set(reportIds).size !== reportIds.length ||
      reportIds.some((id) => !/^[0-9a-f]{32}$/.test(id))) throw new Error("VRA_TASK_REPORT_IDS 格式无效");
  let reportRevisions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(env.VRA_TASK_REPORT_REVISIONS ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("not object");
    reportRevisions = { ...(parsed as Record<string, string>) };
  } catch { throw new Error("VRA_TASK_REPORT_REVISIONS 格式无效"); }
  if (Object.keys(reportRevisions).length !== reportIds.length ||
      reportIds.some((id) => !Object.hasOwn(reportRevisions, id) || !/^[a-f0-9]{64}$/.test(String(reportRevisions[id] ?? ""))) ||
      Object.keys(reportRevisions).some((id) => !reportIds.includes(id))) {
    throw new Error("VRA_TASK_REPORT_REVISIONS 格式无效");
  }
  const requestedEngine = parseEngine(str(args.engine));
  if (requestRuntime?.runtime === "local-agent" && requestedEngine !== undefined) {
    throw new Error("请求级本机 Agent 运行时不能再用 --engine 覆盖");
  }
  if (requestRuntime?.runtime === "local-agent" && (str(args.model) !== undefined || str(args.reasoning) !== undefined)) {
    throw new Error("本机订阅 Agent 的模型与推理档位由已登录 CLI 决定，不能用 --model / --reasoning 冒充覆盖");
  }
  const engine = requestRuntime?.runtime === "local-agent" ? "local_agent" : requestedEngine;
  if (engine === "direct" && args["experimental-direct-deep"] !== true) {
    throw new Error("--engine direct 是实验性 Direct Deep，不是产品 Quick；开发验证必须同时显式传 --experimental-direct-deep");
  }
  if (args["experimental-direct-deep"] === true && engine !== "direct") {
    throw new Error("--experimental-direct-deep 只能与 --engine direct 同时使用");
  }
  const cfg = makeConfig({
    symbol: str(args.symbol)!,
    companyName: str(args["company-name"]),
    ...(taskObjective ? { taskObjective } : {}),
    ...(reportIds.length ? { reportIds } : {}),
    ...(reportIds.length ? { reportRevisions } : {}),
    market: str(args.market) ?? "",
    repoRoot,
    dataRoot: pc.resolved.dataRoot,
    runId: str(args["run-id"]),
    python: str(args.python) ?? pc.python ?? undefined,
    codexPath: str(args["codex-path"]) ?? pc.resolved.codexPath,
    codexHome: str(args["codex-home"]) ?? pc.resolved.codexHome,
    provider: requestRuntime?.runtime === "codex"
      ? { ...pc.provider, auth: requestRuntime.auth, env_key: requestRuntime.profile.env_key, name: requestRuntime.profile.id,
          wire_api: requestRuntime.profile.wire_api, base_url: requestRuntime.profile.base_url }
      : requestRuntime?.runtime === "local-agent"
        ? { ...pc.provider, name: `cli-${requestRuntime.agent}`, base_url: null, env_key: "", auth: "subscription_login" }
        : pc.provider,
    providerProfile: requestRuntime?.runtime === "codex"
      ? requestRuntime.profile
      : requestRuntime?.runtime === "local-agent" ? null : pc.providerProfile,
    scriptsRel: pc.resolved.scriptsRel,
    calcCliRel: pc.paths.calc_cli,
    constitutionPath: pc.resolved.constitution,
    model: requestRuntime?.runtime === "local-agent"
      ? undefined
      : str(args.model) ?? (requestRuntime?.runtime === "codex" ? requestRuntime.model ?? undefined : d.model ?? undefined),
    reasoning: requestRuntime?.runtime === "local-agent" ? undefined : str(args.reasoning) ?? d.reasoning ?? undefined,
    maxRetries: str(args["max-retries"]) !== undefined ? Number(args["max-retries"]) : d.max_retries,
    gateRetries: str(args["gate-retries"]) !== undefined ? Number(args["gate-retries"]) : d.gate_retries,
    turnTimeoutMs: str(args["turn-timeout-min"]) !== undefined ? Number(args["turn-timeout-min"]) * 60_000 : d.turn_timeout_min * 60_000,
    fetchTimeoutMs: d.fetch_timeout_sec * 1000,
    noAgent: args["no-agent"] === true,
    hooksEnabled: args["no-hooks"] !== true,
    executionMode: parseExecutionMode(str(args["execution-mode"])),
    engine,
    ...(requestRuntime?.runtime === "local-agent" ? { localAgent: requestRuntime.agent } : {}),
    overwrite: args.overwrite === true,
    scenario,
    endpointScope: parseScope(str(args.endpoints)),
    knowledgeRecall: str(args.knowledge) === undefined ? true : str(args.knowledge) === "on",
    knowledgeArchive: args["no-archive"] !== true,
    seedFrom: str(args["seed-from"]),
    allowStaleFixture: args["allow-stale-fixture"] === true,
  });
  let stages: Stage[] | undefined;
  if (str(args.stages)) {
    stages = str(args.stages)!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { if (!isStage(s)) throw new Error(`未知阶段 ${s}`); return s; });
  }
  return { cfg, stages, sources: requestRuntime ? [...pc.sources, "request-runtime"] : pc.sources, progress: str(args.progress) !== "off" };
}

/**
 * **组装根**:按 `--engine` 挑引擎。两个引擎的 runner 与 lifecycle 都在这里配好,
 * 编排器只认契约、不认具体实现。
 *
 * 🔴 直连的前置条件一律**当场抛错、绝不回落到 Codex** —— 用户以为在用自己选的模型,
 *    账单和产出却来自另一个引擎,而界面上一个字都看不出来。
 */
export async function makeEngine(cfg: RunConfig, eventsPath: string, observer?: (ev: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env): Promise<{
  runner: AgentRunner;
  lifecycle: EngineLifecycle;
  runtime: EngineRuntime;
}> {
  if (cfg.engine === "local_agent") {
    const agent = cfg.localAgent;
    if (!agent) throw new Error("local_agent 引擎缺少本机 Agent 种类");
    const status = agent === "claude" ? await probeClaude(env) : await probeCodeBuddy(env);
    // 探测结果只用于设置页与运行记录，不能在这里提前终止：服务层已经把 Deep 任务交给
    // 独立子进程，若在 runResearch 建立 manifest 前抛错，界面只能在宽限期后猜成
    // deep_start_lost。让 runner 的真实调用返回结构化 LocalAgentError，编排器才能把本次
    // 运行立即、明确地收口为 failed。探测与真实请求之间也天然存在登录刚好失效的竞态。
    const runner = new LocalAgentStageAgent({ agent, runId: cfg.runId, runDir: cfg.runDir,
      repoRoot: cfg.repoRoot, python: cfg.python, eventsPath, env, timeoutMs: cfg.turnTimeoutMs, observer });
    return {
      runner,
      lifecycle: new LocalAgentEngineLifecycle(localAgentCapabilities()),
      runtime: { kind: "local_agent", version: status.version ?? `${agent}/unknown`, binary: null,
        model: null, codexPath: null, codexHome: null },
    };
  }
  if (cfg.engine === "direct") {
    const cap = directCapabilityOf(cfg.providerProfile);
    if (!cap.supported) {
      throw new Error(`--engine direct 用不了 provider「${cfg.provider.name}」:${cap.reason}\n` +
        "改法:换一个已实测支持直连的 provider,或先给它的模板补上 direct 段(见 providers/README.md)。");
    }
    if (!cap.baseURL) throw new Error(`--engine direct 需要显式的 base_url,provider「${cfg.provider.name}」的模板里没有`);
    const apiKey = env[cfg.provider.env_key];
    if (!apiKey) throw new Error(`--engine direct 需要密钥:环境变量 ${cfg.provider.env_key} 是空的(密钥只从环境变量读,不进配置文件)`);
    const model = cfg.model ?? cap.model;
    if (!model) throw new Error(`--engine direct 需要模型名:既没给 --model,provider 模板里也没有 default_model`);
    const runner = new DirectStageAgent({
      runId: cfg.runId,
      toolCtx: { runDir: cfg.runDir, repoRoot: cfg.repoRoot, python: cfg.python },
      capability: cap, apiKey, model, eventsPath,
      secrets: secretsFor(cfg, env),
      requestTimeoutMs: cfg.turnTimeoutMs,
      observer,
    });
    return {
      runner,
      lifecycle: new DirectEngineLifecycle(directCapabilities(cap.structuredOutput)),
      runtime: {
        kind: "direct", version: `direct-api/${cfg.provider.name}/${model}`, binary: null, model,
        codexPath: null, codexHome: null,
      },
    };
  }
  // Codex SDK 只在 Codex 分支加载。Direct 的模块图可在 Codex 包完全不存在时启动；
  // 这不是把 Direct Deep 对外开放，只是消除“直连路径暗中依赖 Codex”的技术谎言。
  const { CodexRunner, sdkCodexVersion } = await import("./runner.ts");
  const runner = new CodexRunner(cfg, eventsPath, undefined, observer);
  const structured = structuredOutputMode(cfg.providerProfile) === "prompt" ? "prompt" : "server_schema";
  const codexRuntime = sdkCodexVersion(cfg.codexPath);
  return {
    runner,
    lifecycle: new CodexEngineLifecycle(cfg, codexCapabilities(cfg, structured)),
    runtime: {
      kind: "codex", ...codexRuntime, model: cfg.model ?? cfg.providerProfile?.default_model ?? null,
      codexPath: cfg.codexPath, codexHome: cfg.codexHome,
    },
  };
}

async function main(): Promise<number> {
  let cfg: RunConfig, stages: Stage[] | undefined, sources: string[], progress: boolean;
  try { ({ cfg, stages, sources, progress } = configFromArgs(parseArgs(process.argv.slice(2)))); }
  catch (e) { console.error(`参数 / 配置错误:${e instanceof Error ? e.message : String(e)}`); return 3; }
  const engineLabel = cfg.engine === "direct" ? "direct-api(experimental)" : cfg.engine === "local_agent" ? `local-agent:${cfg.localAgent}` : (cfg.codexPath ?? "sdk-bundled");
  console.error(`[orchestrator] run ${cfg.runId} → ${cfg.runDir}\n[orchestrator] config sources: ${sources.join(" ← ")}; CODEX_HOME=${cfg.codexHome}; engine=${engineLabel}; provider=${cfg.provider.name}/${cfg.provider.auth}`);
  // 进度只写 stderr:六阶段要跑十几分钟,没有它用户全程看不到任何内容(见 progress.ts 顶部)。
  // **连构造也要保护**:显示层任何环节出问题都只是"没有进度显示",绝不能让一次真实研究起不来(Codex progress-r1 P2)。
  let reporter: ProgressReporter | null = null;
  if (progress) {
    try { reporter = new ProgressReporter({ runDir: cfg.runDir }); }
    catch (e) { console.error(`[orchestrator] 进度显示未启用(不影响研究):${e instanceof Error ? e.message : String(e)}`); }
  }
  const token = process.env.VRA_RESEARCH_CONTROL_TOKEN;
  const control = token ? watchResearchCancellation(cfg.dataRoot, cfg.runId, token) : null;
  try {
  control?.signal.throwIfAborted();
  const { runner, lifecycle, runtime } = await makeEngine(cfg, path.join(cfg.runDir, "events.jsonl"), reporter ? (ev) => reporter.onEvent(ev) : undefined);
  control?.check();
  control?.signal.throwIfAborted();
  const res = await runResearch(cfg, { runner, lifecycle, signal: control?.signal, checkpoint: control?.checkpoint,
    beginFinalization: control?.finalize, fetchRunner: runFetchScripts, verify: verifyCalcs, sdkVersion: () => runtime }, stages);
  if (token) updateResearchControl(cfg.dataRoot, cfg.runId, token, res.status);
  console.log(JSON.stringify({ run_id: cfg.runId, run_dir: cfg.runDir, status: res.status, exit_code: res.exitCode,
    stages: res.manifest.stages.map((s) => ({ stage: s.stage, status: s.status, attempts: s.attempts, validator_ok: s.validator_ok })) }, null, 2));
  return res.exitCode;
  } catch (e) {
    if (token) updateResearchControl(cfg.dataRoot, cfg.runId, token, isResearchCancellation(e, control?.signal) ? "cancelled" : "failed");
    throw e;
  } finally { control?.close(); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(3); });
}
