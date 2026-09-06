/** Claude Code / WorkBuddy 订阅 CLI 的六阶段运行器。 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { EventsLog, type AgentRunner, type TurnOutcome } from "../agent_runner.ts";
import type { Stage } from "../config.ts";
import { RUN_TOOLS } from "../run_tools.ts";
import { LocalAgentError, runLocalAgent, type LocalAgentId, type RunLocalAgentOptions } from "../local_agent_runtime.ts";

type Complete = (agent: LocalAgentId, options: RunLocalAgentOptions) => Promise<string>;

const FATAL_LOCAL_AGENT_ERRORS = new Set([
  "agent_not_installed", "agent_not_authenticated", "agent_probe_failed",
  "agent_cli_too_old", "unsupported_cli", "agent_bad_timeout", "agent_quota",
  "agent_shutdown_failed",
]);

export interface LocalAgentStageAgentOptions {
  agent: LocalAgentId;
  runId: string;
  runDir: string;
  repoRoot: string;
  python: string;
  eventsPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  observer?: (event: Record<string, unknown>) => void;
  complete?: Complete;
}

const SERVER_NAME = "vra";
const allowedTools = RUN_TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`);

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 只记账 agent 合法可写的三类产物；受保护文件另有编排器 hash 校验。 */
function writableSnapshot(runDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (file: string) => {
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink()) out.set(path.resolve(file), digest(file));
    } catch { /* 不存在就没有快照项 */ }
  };
  for (const dir of ["calcs", "stages"]) {
    const base = path.join(runDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) if (/^[A-Za-z0-9._-]+\.json$/.test(name)) add(path.join(base, name));
  }
  add(path.join(runDir, "report.md"));
  return out;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.entries()].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file).sort();
}

const SYSTEM_PROMPT = `
你正在 Vibe Research 的受控六阶段执行器中工作。
宿主 Shell、任意文件读写、浏览器、网络和子 Agent 都不可用。
只使用显式提供的 VRA MCP 工具：list_run_files、read_run_file、calculate、write_stage、write_report。
用户消息里若有 shell 命令示例，它们只表达要完成的操作；必须翻译成上述受控工具，不得尝试执行命令。
严格完成当前阶段产物，最后按给定 JSON Schema 汇报。`.trim();

export class LocalAgentStageAgent implements AgentRunner {
  readonly threadId: string | null = null;
  readonly #options: LocalAgentStageAgentOptions;
  readonly #events: EventsLog;
  readonly #complete: Complete;
  #sequence = 0;

  constructor(options: LocalAgentStageAgentOptions) {
    this.#options = options;
    this.#events = new EventsLog(options.eventsPath);
    this.#complete = options.complete ?? runLocalAgent;
  }

  eventsDigest(): string | null { return this.#events.digest(); }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    const event = { ts: new Date().toISOString(), run_id: this.#options.runId, seq: ++this.#sequence, stage, type, ...payload };
    this.#events.append(event);
    if (this.#options.observer) { try { this.#options.observer(event); } catch { /* 观察者不影响研究 */ } }
  }

  async runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome> {
    signal?.throwIfAborted();
    const started = Date.now();
    const before = writableSnapshot(this.#options.runDir);
    let finalResponse = "";
    let failed: string | null = null;
    let fatal: LocalAgentError | null = null;
    this.log(stage, "local_agent.turn_start", { attempt, agent: this.#options.agent });
    try {
      finalResponse = await this.#complete(this.#options.agent, {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
        // 不把 --json-schema 与工具放在同一轮：真实 WorkBuddy 会因此直接回汇报、零工具调用。
        // turn 汇报不是真理源；stages/report 产物由受控工具 schema + 编排器 validator 双重强制。
        outputSchema: undefined,
        env: this.#options.env,
        timeoutMs: this.#options.timeoutMs,
        signal,
        controlledMcp: {
          serverName: SERVER_NAME,
          command: process.execPath,
          args: [path.join(this.#options.repoRoot, "orchestrator", "src", "finance", "run_tools_mcp.ts")],
          env: {
            VRA_RUN_DIR: this.#options.runDir,
            VRA_REPO_ROOT: this.#options.repoRoot,
            VRA_PYTHON: this.#options.python,
          },
          allowedTools,
          maxTurns: 32,
        },
      });
    } catch (error) {
      failed = error instanceof LocalAgentError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      if (error instanceof LocalAgentError && FATAL_LOCAL_AGENT_ERRORS.has(error.code)) fatal = error;
      this.log(stage, "local_agent.turn_failed", { attempt, agent: this.#options.agent,
        code: error instanceof LocalAgentError ? error.code : "unknown", message: failed });
    }
    const fileChanges = changedFiles(before, writableSnapshot(this.#options.runDir));
    const durationMs = Date.now() - started;
    this.log(stage, "local_agent.turn_end", { attempt, agent: this.#options.agent,
      file_changes: fileChanges.length, duration_ms: durationMs, failed });
    // 登录失效、未安装与额度耗尽都不是“让模型再写一遍”能修复的问题。
    // 直接交给编排器的异常收口，避免同一错误在六个阶段里连续调用十八次。
    if (fatal) throw fatal;
    return { finalResponse, usage: null, commands: [], fileChanges,
      itemCount: failed ? 0 : 1, durationMs, failed, threadId: null };
  }
}
