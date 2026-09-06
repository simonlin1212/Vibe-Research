/**
 * Codex 线程驱动:用官方 TS SDK 拉起 codex 二进制(零 fork),一个研究 run = 一个 thread,每个阶段 = 一个 turn。
 * cwd = 运行目录(沙箱只放行运行目录写入);无网络;引擎路径可配置(SDK codexPathOverride);显式 CODEX_HOME;
 * 工具执行环境排除密钥类变量;每 turn 超时(AbortSignal);流级 error 视为失败;所有事件(带 run_id / seq / attempt)逐条落 events.jsonl(fsync + 全文 sha256 摘要 + 密钥脱敏)。
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Codex, CodexOptions, Thread, ThreadOptions, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { runCodexSdkTurn } from "./codex_sdk_process.ts";

import { EventsLog, type AgentRunner, type TurnOutcome } from "./agent_runner.ts";
import { CODEX_SHELL_ENV_POLICY, codexEnvFor, secretsFor, type RunConfig, type Stage } from "./config.ts";
import { nowIso } from "./fsutil.ts";
import { codexProviderConfig, structuredOutputMode, withOutputSchema } from "./providers.ts";

export { EventsLog, redactEnvironment } from "./agent_runner.ts";
export type { AgentRunner, CommandRecord, TurnOutcome } from "./agent_runner.ts";

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`)
      .join(", ")}}`;
  }
  throw new Error(`MCP 隔离配置含不支持的值:${String(value)}`);
}

/**
 * 列出 Codex 实际会读到的 MCP 名。
 *
 * 不能只传 `mcp_servers={}`。Codex 对配置表做递归合并，空表不会删掉
 * config.toml 里已有的 server。仅扫文件也不对：未启用 profile 和 Apps 运行时名称
 * 并不是当前 bootstrap 配置的 server，把它们投影成只含 `{ enabled = false }` 的根表会让
 * Codex 在发起模型请求前因缺少 command / url 报 `invalid transport`。
 *
 * 因此以同一引擎、同一 CODEX_HOME、同一 cwd 运行官方 `codex mcp list --json`，
 * 并先关闭本轮本就不允许的 Apps / MCP Apps / plugins；只禁用它报出的当前有效集合。
 * 官方命令报出的集合就是该引擎入口当前真正有效的集合；未激活 profile 不影响当前线程。
 * 引擎无法核验时仍失败关闭。
 */
export function configuredMcpServerNames(cfg: RunConfig, engineEnv: NodeJS.ProcessEnv = codexEnvFor(cfg)): string[] {
  const codexBin = cfg.codexPath ?? sdkCodexVersion().binary;
  if (!codexBin) throw new Error("无法核验 MCP 隔离配置:找不到官方 Codex 引擎");
  // 配置预检也会在建立 run 目录前被调用（如研究入口与单测）。spawn 的 cwd
  // 不存在时 Node 会把它报成近似“二进制 ENOENT”，因此退到已存在的数据根；
  // 对话入口会先建立会话目录，仍使用精确 cwd。
  const configCwd = fs.existsSync(cfg.runDir) ? cfg.runDir : fs.existsSync(cfg.dataRoot) ? cfg.dataRoot : cfg.repoRoot;
  // #44：调用方传入裸环境或其他 CODEX_HOME 时也不得回落到用户配置。
  // 官方引擎要求 CODEX_HOME 已存在；首次预检时可能还未初始化。
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  const discoveryEnv = { ...engineEnv, CODEX_HOME: cfg.codexHome };
  const effective = spawnSync(codexBin, [
    "-c", "features.apps=false",
    "-c", "features.enable_mcp_apps=false",
    "-c", "features.plugins=false",
    "mcp", "list", "--json",
  ], {
    cwd: configCwd,
    env: discoveryEnv,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (effective.error || effective.status !== 0) {
    const detail = String(effective.stderr || effective.error?.message || "unknown error").trim().slice(0, 300);
    throw new Error(`无法核验 Codex 有效 MCP 配置:${detail}`);
  }
  try {
    const parsed = JSON.parse(String(effective.stdout || "[]"));
    if (!Array.isArray(parsed)) throw new Error("bad result");
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string") throw new Error("bad item");
    }
    return parsed.map((item) => (item as { name: string }).name).sort();
  } catch {
    throw new Error("无法核验 Codex 有效 MCP 配置:引擎返回格式错误");
  }
}

/** 生成一条原子 CLI 覆盖：禁用所有旧 MCP，可选加入本轮唯一的受控 MCP。 */
export function mcpIsolationOverride(cfg: RunConfig, ownServer?: Record<string, unknown>, engineEnv: NodeJS.ProcessEnv = codexEnvFor(cfg)): { override: string; ownName: string | null } {
  const existing = configuredMcpServerNames(cfg, engineEnv);
  const servers: Record<string, unknown> = Object.fromEntries(existing.map((name) => [name, { enabled: false }]));
  let ownName: string | null = null;
  if (ownServer) {
    const stem = `vra_run_${crypto.createHash("sha256").update(cfg.runDir).digest("hex").slice(0, 12)}`;
    ownName = stem;
    for (let i = 1; Object.prototype.hasOwnProperty.call(servers, ownName); i += 1) ownName = `${stem}_${i}`;
    servers[ownName] = { ...ownServer, enabled: true };
  }
  return { override: `mcp_servers=${tomlValue(servers)}`, ownName };
}

/** events.jsonl 写入器:每条 fsync,维护全文 sha256 摘要;已知密钥值与常见 key 形态在落盘前脱敏(纵深防御,主防线是工具环境不含密钥) */
/**
 * 环境类脱敏:主目录路径中的**用户名**、内网地址、`user:pass@` 形式的凭据。
 *
 * 🔴 全审 r3-P1-4:`redact()` 原本只替换**已知密钥值**与 `sk-…`。而 events 会经 API / MCP
 *    回传给调用方,里面有 `run.start` 展开的整份 cfg、agent 执行的完整命令、`file_change.path`、
 *    命令 `output_tail`、SDK 异常消息 —— **一次普通运行就把用户名、仓库根、运行目录送出去**;
 *    命令输出里若有 `http://10.0.0.8:8080` 也原样回传。
 *
 * ⚠️ 刻意只替换**用户名那一段**、保留路径其余部分:全删的话事件流会失去可读性(排障要看目录结构),
 *    而泄露面主要是"这台机器的用户是谁"。同理内网地址只替换主机部分、保留端口形态。
 * ⚠️ 这是**纵深防御不是安全边界**:自由文本里的敏感信息不可能靠正则枚举干净
 *    (与 core/retrieval 那次同一口径:第三方凭据只能模式匹配,所以文档不承诺"绝不回显")。
 */
/**
 * Codex SDK 选项(v2.1 §5 ①②):引擎路径 codexPathOverride(空 = SDK 内置);env 只含显式 CODEX_HOME(+ api_key 模式的 CODEX_API_KEY);
 * config 注入工具执行环境策略——agent 的 shell 命令不继承任何密钥类变量(主防线;Codex 默认 ignore_default_excludes=true 即会继承)。
 */
export function codexOptionsFor(cfg: RunConfig, env: NodeJS.ProcessEnv = process.env): CodexOptions {
  // M4:非 openai provider 注入 model_provider + model_providers.<id>(base_url / env_key / wire_api / requires_openai_auth=false …);openai 原生沿用引擎默认
  const providerCfg = cfg.providerProfile ? codexProviderConfig(cfg.providerProfile) : {};
  const controlled = cfg.executionMode === "controlled_mcp";
  const engineEnv = codexEnvFor(cfg, env);
  const controlledMcp = controlled ? mcpIsolationOverride(cfg, {
    command: process.execPath,
    args: [path.join(cfg.repoRoot, "orchestrator", "src", "finance", "run_tools_mcp.ts")],
    cwd: cfg.runDir,
    env: { VRA_RUN_DIR: cfg.runDir, VRA_REPO_ROOT: cfg.repoRoot, VRA_PYTHON: cfg.python },
    required: true,
    startup_timeout_sec: 20,
    tool_timeout_sec: 130,
    default_tools_approval_mode: "approve",
    enabled_tools: ["list_run_files", "read_run_file", "calculate", "write_stage", "write_report"],
  }, engineEnv) : null;
  const controlledConfig = controlled ? {
    features: {
      shell_tool: false,
      unified_exec: false,
      view_image: false,
      multi_agent: false,
      multi_agent_v2: false,
      apps: false,
      enable_mcp_apps: false,
      plugins: false,
      code_mode: false,
      standalone_web_search: false,
    },
  } : {};
  return {
    env: engineEnv,
    config: { ...(CODEX_SHELL_ENV_POLICY as unknown as Record<string, unknown>), ...providerCfg, ...controlledConfig } as unknown as NonNullable<CodexOptions["config"]>,
    ...(controlledMcp ? { configOverrides: [controlledMcp.override] } : {}),
    ...(cfg.codexPath ? { codexPathOverride: cfg.codexPath } : {}),
  };
}

export class CodexRunner implements AgentRunner {
  private thread: Thread | null = null;
  private readonly codex: Codex | null;
  private workerThreadId: string | null = null;
  private readonly cfg: RunConfig;
  private readonly events: EventsLog;
  private seq = 0;
  /** 实际传给 SDK 的选项(测试可断言:含工具环境策略 / 显式 CODEX_HOME / 引擎路径) */
  readonly codexOptions: CodexOptions;

  /** 事件旁路观察者(进度渲染用)。**只观察不参与** —— 它抛错不得影响运行,见 log()。 */
  private readonly observer: ((ev: Record<string, unknown>) => void) | null;

  constructor(cfg: RunConfig, eventsPath: string, codexFactory?: (opts: CodexOptions) => Codex,
              observer?: (ev: Record<string, unknown>) => void) {
    this.cfg = cfg;
    this.events = new EventsLog(eventsPath, secretsFor(cfg));   // 已知密钥值落盘前脱敏(纵深)
    this.codexOptions = codexOptionsFor(cfg);
    this.codex = codexFactory ? codexFactory(this.codexOptions) : null;
    this.observer = observer ?? null;
  }

  eventsDigest(): string | null { return this.events.digest(); }

  get threadId(): string | null {
    return this.thread?.id ?? this.workerThreadId;
  }

  private ensureThread(): Thread {
    if (this.thread) return this.thread;
    this.thread = this.codex!.startThread(this.threadOptions());
    return this.thread;
  }

  private threadOptions(): ThreadOptions {
    return {
      workingDirectory: this.cfg.runDir,
      // Windows 原生模式不把可写目录交给模型；所有落盘只经受控 MCP 工具完成。
      sandboxMode: this.cfg.executionMode === "controlled_mcp" ? "read-only" : "workspace-write",
      // 🔴 必开。引擎在 `exec` 入口有一道门:cwd 不在 git 仓库里就直接 exit 1,报
      //    `Not inside a trusted directory and --skip-git-repo-check was not specified.`
      //    (codex-rs/exec/src/lib.rs:798 —— 判据其实**只是 `get_git_repo_root(cwd).is_none()`**,
      //     与 `[projects] trust_level` 无关,那句话的措辞有误导性)。
      //    我们的运行目录是**产品自管的数据目录**、不是用户源码树,agent 只往里写本次运行产物,
      //    这道门保护不到任何东西,却会让两种正常安装直接跑不起来(都已实测):
      //      · 用户下载 zip 解压(没有 .git)→ 每次运行 exit 1;
      //      · 数据根在产品根之外(分离安装)→ 同上。
      skipGitRepoCheck: true,
      networkAccessEnabled: false,          // 解释阶段不联网:取数已由编排器执行,calc / jq 不需要网络(AGENTS.md §5)
      approvalPolicy: "never",              // 非交互
      webSearchMode: "disabled",            // 不联网搜索,数据只来自登记脚本
      model: this.cfg.model ?? this.cfg.providerProfile?.default_model ?? undefined,  // 未指定模型时用 provider 模板默认(openai 模板为 null → 引擎默认)
      modelReasoningEffort: this.cfg.reasoning as never,
    };
  }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.seq += 1;
    const ev = { ts: nowIso(), run_id: this.cfg.runId, seq: this.seq, stage, type, ...payload };
    this.events.append(ev);
    // 落盘在前、旁路在后:观察者出任何问题都不能影响事件账本的完整性
    if (this.observer) { try { this.observer(ev); } catch { /* 显示层永不影响运行 */ } }
  }

  async runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome> {
    signal?.throwIfAborted();
    const thread = this.codex ? this.ensureThread() : null;
    const t0 = Date.now();
    const outcome: TurnOutcome = { finalResponse: "", usage: null, commands: [], fileChanges: [], itemCount: 0, durationMs: 0, failed: null, threadId: null };
    this.log(stage, "turn.prompt", { attempt, chars: prompt.length });
    const ac = new AbortController();
    const cancel = () => ac.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => ac.abort(), this.cfg.turnTimeoutMs);
    try {
      // provider 不认服务端 schema 时(如小米 MiMo 的 Responses 只收 text / json_object),
      // 把 schema 写进提示词而不是硬传 —— 传了会被整轮拒掉,阶段直接 failed。
      const shaped = withOutputSchema(prompt, outputSchema, structuredOutputMode(this.cfg.providerProfile));
      const record = (ev: ThreadEvent) => {
        if (ev.type === "thread.started") this.workerThreadId = ev.thread_id;
        this.record(stage, attempt, ev, outcome);
        if (ev.type === "turn.failed") outcome.failed ??= ev.error?.message ?? "turn.failed";
        if (ev.type === "error") outcome.failed ??= `stream error: ${ev.message}`;
      };
      if (thread) {
        const { events } = await thread.runStreamed(shaped.prompt, { ...(shaped.outputSchema ? { outputSchema: shaped.outputSchema } : {}), signal: ac.signal });
        for await (const ev of events) { record(ev); if (outcome.failed) break; }
      } else {
        await runCodexSdkTurn({ options: this.codexOptions, threadOptions: this.threadOptions(), threadId: this.workerThreadId,
          prompt: shaped.prompt, ...(shaped.outputSchema ? { outputSchema: shaped.outputSchema } : {}) }, ac.signal, this.cfg.turnTimeoutMs + 5000, record);
      }
    } catch (e) {
      // A failed tree shutdown is not a cancellation acknowledgement.
      if ((e as NodeJS.ErrnoException)?.code === "STOP_FAILED") throw e;
      outcome.failed = signal?.aborted ? "用户取消研究" : outcome.failed ?? (ac.signal.aborted ? `turn 超时(${this.cfg.turnTimeoutMs} ms)` : e instanceof Error ? e.message : String(e));
      this.log(stage, "turn.exception", { attempt, message: outcome.failed });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    outcome.durationMs = Date.now() - t0;
    outcome.threadId = this.threadId;
    this.log(stage, "turn.done", { attempt, duration_ms: outcome.durationMs, commands: outcome.commands.length, failed: outcome.failed, usage: outcome.usage });
    return outcome;
  }

  private record(stage: Stage, attempt: number, ev: ThreadEvent, outcome: TurnOutcome): void {
    switch (ev.type) {
      case "thread.started": this.log(stage, "thread.started", { attempt, thread_id: ev.thread_id }); break;
      case "turn.started": this.log(stage, "turn.started", { attempt }); break;
      case "turn.completed": outcome.usage = ev.usage as unknown as Record<string, number>; this.log(stage, "turn.completed", { attempt, usage: ev.usage }); break;
      case "turn.failed": this.log(stage, "turn.failed", { attempt, error: ev.error }); break;
      case "error": this.log(stage, "stream.error", { attempt, message: ev.message }); break;
      case "item.completed": outcome.itemCount += 1; this.recordItem(stage, attempt, ev.item, outcome); break;
      default: break; // item.started / item.updated 不落盘
    }
  }

  private recordItem(stage: Stage, attempt: number, item: ThreadItem, outcome: TurnOutcome): void {
    switch (item.type) {
      case "command_execution":
        outcome.commands.push({ command: item.command, exit_code: item.exit_code ?? null, status: item.status });
        this.log(stage, "command", { attempt, command: item.command.slice(0, 4000), exit_code: item.exit_code ?? null, status: item.status, output_tail: (item.aggregated_output ?? "").slice(-2000) });
        break;
      case "file_change":
        outcome.fileChanges.push(...item.changes.map((c) => c.path));
        this.log(stage, "file_change", { attempt, status: item.status, changes: item.changes });
        break;
      case "agent_message": outcome.finalResponse = item.text; this.log(stage, "agent_message", { attempt, text: item.text.slice(0, 4000) }); break;
      case "reasoning": this.log(stage, "reasoning", { attempt, text: item.text.slice(0, 1000) }); break;
      case "error": this.log(stage, "item.error", { attempt, message: item.message }); break;
      case "web_search": this.log(stage, "web_search", { attempt, query: item.query }); break;
      case "mcp_tool_call": this.log(stage, "mcp_tool_call", { attempt, server: item.server, tool: item.tool, status: item.status, arguments: item.arguments }); break;
      case "todo_list": this.log(stage, "todo_list", { attempt, items: item.items }); break;
      default: break;
    }
  }
}

/** 实际拉起的 codex 二进制版本:有 codexPath 则问它;否则问 SDK 内置二进制(与 PATH 上的 codex 无关) */
export function sdkCodexVersion(codexPath: string | null = null): { version: string; binary: string | null } {
  if (codexPath) {
    try {
      const p = spawnSync(codexPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
      return { version: (p.stdout || "").trim() || "unknown", binary: codexPath };
    } catch { return { version: "unknown", binary: codexPath }; }
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@openai/codex/package.json");
    const triple: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl", "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };
    const t = triple[`${process.platform}-${process.arch}`];
    const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
    const pp = req.resolve(`${platformPkg}/package.json`, { paths: [path.dirname(pkgJson)] });
    const bin = path.join(path.dirname(pp), "vendor", t, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const p = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return { version: (p.stdout || "").trim() || "unknown", binary: bin };
  } catch {
    return { version: "unknown", binary: null };
  }
}
