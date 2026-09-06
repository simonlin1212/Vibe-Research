/**
 * 引擎无关的阶段运行契约与事件账本。
 *
 * 这份文件刻意不能 import `@openai/codex-sdk`：Direct Deep 的模块图会经过这里，
 * 把通用接口放在 CodexRunner 所在文件里，会让“直连”在加载阶段就依赖 Codex 包。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Stage } from "./config.ts";

export interface CommandRecord { command: string; exit_code: number | null; status: string }

export interface TurnOutcome {
  finalResponse: string;
  usage: Record<string, number> | null;
  commands: CommandRecord[];
  fileChanges: string[];
  itemCount: number;
  durationMs: number;
  failed: string | null;
  threadId: string | null;
}

/** 可注入的运行器接口（测试用假运行器实现同一接口）。 */
export interface AgentRunner {
  runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome>;
  readonly threadId: string | null;
  log(stage: Stage | "orchestrator", type: string, payload?: Record<string, unknown>): void;
  /** events.jsonl 全部已写内容的 sha256；null = 不校验。 */
  eventsDigest(): string | null;
}

const GENERIC_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const HOME_USER_RE = /(\/Users\/|\/home\/|C:\\\\Users\\\\)([^/\\\\"'\s:]+)/g;
const PRIVATE_HOST_RE = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g;
const USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]*@/gi;
const INTERNAL_HOST_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(localhost|[a-z0-9-]+\.(?:local|internal|lan|corp|intranet))\b/gi;

export function redactEnvironment(text: string): string {
  return text
    .replace(USERINFO_RE, "$1[REDACTED_USERINFO]@")
    .replace(HOME_USER_RE, "$1[USER]")
    .replace(PRIVATE_HOST_RE, "[PRIVATE_IP]")
    .replace(INTERNAL_HOST_RE, "$1[INTERNAL_HOST]");
}

/** 每条 fsync，维护全文 sha256；已知密钥与常见 key 形态在落盘前脱敏。 */
export class EventsLog {
  private readonly hash = crypto.createHash("sha256");
  private readonly path: string;
  private readonly secrets: string[];

  constructor(p: string, secrets: string[] = []) {
    this.path = p;
    this.secrets = secrets.filter((x) => x.length >= 8);
  }

  redact(text: string): string {
    let out = text;
    for (const sec of this.secrets) out = out.split(sec).join("[REDACTED]");
    out = out.replace(GENERIC_KEY_RE, "[REDACTED_KEY]");
    return redactEnvironment(out);
  }

  append(obj: unknown): void {
    const line = this.redact(JSON.stringify(obj)) + "\n";
    this.hash.update(line);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const fd = fs.openSync(this.path, "a");
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  digest(): string { return this.hash.copy().digest("hex"); }
}
