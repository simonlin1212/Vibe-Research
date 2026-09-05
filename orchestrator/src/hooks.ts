/**
 * hooks v0(Phase 0 第 5 步,执行层):把纪律从"提示 + 事后校验"再往前推一层——
 *  - Stop 钩子:每个 turn 收工前检查本阶段产物是否齐全 / 过阶段校验,缺则 block(agent 在同一 turn 内继续补,连续 MAX_STOP_BLOCKS 次**无推进**空转后终止本轮);
 *    "推进" = 两次拦截之间 calcs/ 有新文件落盘(攒 N 轮 calc 才写 stage 文件是合规工作流,不占空转额度)
 *  - PreToolUse 钩子:agent 每条 shell / apply_patch 调用执行前做行为检查(自跑取数脚本 / 读禁区 / 写受保护产物 / 联网),命中即 block
 * 零 fork:钩子是 Codex 0.149 原生 lifecycle hooks(feature "hooks" 默认开启),配置写在**产品自己的 CODEX_HOME**(hooks.json),
 * 非托管钩子必须在同一 CODEX_HOME 的 config.toml 里登记 trusted_hash 才会执行——这里按 Codex 源码复刻其哈希算法(codex-rs/hooks/src/engine/discovery.rs hook_hash +
 * config/src/fingerprint.rs version_for_toml):规范化 handler → 规范 JSON(键排序)→ sha256。
 * 钩子的裁决不是真理源:编排器 validator 仍是最终裁判;钩子只负责"做不对也过不去"的即时拦截与即时纠正。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findMultilineClose, scanTomlLine } from "./tomlscan.ts";

import type { RunConfig, Stage } from "./config.ts";
import { atomicWrite, readJsonIfExists, writeJson } from "./fsutil.ts";

export const HOOK_CONTEXT_REL = path.join(".vibe", "hook-context.json");
export const HOOK_LOG_REL = path.join(".vibe", "hooks.log");
/** Stop 钩子多次拦截仍不合格时写的终止标记(编排器据此把该 turn 判为失败,进入补跑) */
export const STOP_FAILED_REL = path.join(".vibe", "stop-failed.json");
/**
 * 同一 (stage, attempt) 内 Stop 最多连续**空转** block 的次数,之后终止本轮。
 * 6 次给"攒 N 轮 calc 才写 stage 文件"的合规工作流留足预算(配合 stop.ts 的推进感知:
 * calcs/ 有新落盘的拦截不占额度);2 次是 2026-09-05 600519 run 误杀 financials 事故的直接诱因。
 */
export const MAX_STOP_BLOCKS = 6;
export interface StopFailedMarker { stage: string; attempt: number; problems: string[]; blocks: number; ts: string }
export function readStopFailed(runDir: string): StopFailedMarker | null { return readJsonIfExists<StopFailedMarker>(path.join(runDir, STOP_FAILED_REL)); }
export function clearStopFailed(runDir: string): void { const p = path.join(runDir, STOP_FAILED_REL); if (fs.existsSync(p)) fs.rmSync(p); }
export const STOP_TIMEOUT_SEC = 120;
export const PRE_TOOL_USE_TIMEOUT_SEC = 30;
const BLOCK_BEGIN = "# >>> vibe-research hooks state (generated; do not edit) >>>";
const BLOCK_END = "# <<< vibe-research hooks state <<<";

export interface CommandHookConfig { type: "command"; command: string; timeout?: number; async?: boolean; statusMessage?: string; additionalContextLimit?: number }
export interface MatcherGroup { matcher?: string; hooks: CommandHookConfig[] }
export type HooksJson = { hooks: Record<string, MatcherGroup[]> };

/** hooks.json 事件名 → Codex 内部 key label(hook_event_key_label) */
const EVENT_KEY_LABEL: Record<string, string> = {
  PreToolUse: "pre_tool_use", PermissionRequest: "permission_request", PostToolUse: "post_tool_use", PreCompact: "pre_compact", PostCompact: "post_compact",
  SessionStart: "session_start", SessionEnd: "session_end", UserPromptSubmit: "user_prompt_submit", SubagentStart: "subagent_start", SubagentStop: "subagent_stop", Stop: "stop",
};
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/** 复刻 Codex 的规范化:command 钩子 → {type, command, timeout(默认 600,SessionEnd 另算), async, statusMessage?, additionalContextLimit?(≠2500 才保留)} */
export function normalizedHandler(event: string, h: CommandHookConfig): Record<string, unknown> {
  let timeout = Math.max(1, h.timeout ?? 600);
  if (event === "SessionEnd") timeout = Math.min(Math.max(1, h.timeout ?? 1), 3);
  const out: Record<string, unknown> = { type: "command", command: h.command, timeout, async: h.async ?? false };
  if (h.statusMessage !== undefined) out.statusMessage = h.statusMessage;
  const ctxEvents = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"];
  if (h.additionalContextLimit !== undefined && ctxEvents.includes(event) && h.additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) out.additionalContextLimit = h.additionalContextLimit;
  return out;
}

/** 复刻 hook_hash:identity = {event_name: <label>, matcher?: <matcher>, hooks: [normalized]} → 规范 JSON → sha256 */
export function hookHash(event: string, matcher: string | undefined, h: CommandHookConfig): string {
  const identity: Record<string, unknown> = { event_name: EVENT_KEY_LABEL[event] ?? event, hooks: [normalizedHandler(event, h)] };
  if (matcher !== undefined) identity.matcher = matcher;
  const json = JSON.stringify(canonical(identity));
  return "sha256:" + crypto.createHash("sha256").update(json).digest("hex");
}

/** 钩子状态 key:<hooks.json 绝对路径>:<event label>:<group 序号>:<handler 序号> */
export function hookKey(hooksJsonPath: string, event: string, groupIndex: number, handlerIndex: number): string {
  return `${hooksJsonPath}:${EVENT_KEY_LABEL[event] ?? event}:${groupIndex}:${handlerIndex}`;
}

export function hookScriptsDir(repoRoot: string): string {
  return path.join(repoRoot, "orchestrator", "hooks");
}

/** 本产品的 hooks.json 内容(命令用绝对路径:当前 node 可执行文件 + 仓库内钩子脚本) */
export function buildHooksJson(cfg: Pick<RunConfig, "repoRoot">, nodeBin: string = process.execPath, fault?: "timeout" | "crash"): HooksJson {
  const dir = hookScriptsDir(cfg.repoRoot);
  const cmd = (name: string) => `"${nodeBin}" "${path.join(dir, name)}"`;
  // 故障注入(仅硬测试):timeout = Stop 钩子睡过时限(timeout 设 5s);crash = 立即非零退出 → 观察 Codex fail-open 与编排器兜底
  const stopCmd = fault === "timeout" ? `"${nodeBin}" -e "setTimeout(()=>{}, 60000)"` : fault === "crash" ? `"${nodeBin}" -e "process.exit(7)"` : cmd("stop.ts");
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: stopCmd, timeout: fault === "timeout" ? 5 : STOP_TIMEOUT_SEC }] }],
      PreToolUse: [{ matcher: "^(Bash|apply_patch)$", hooks: [{ type: "command", command: cmd("pre_tool_use.ts"), timeout: PRE_TOOL_USE_TIMEOUT_SEC }] }],
    },
  };
}

export interface InstalledHooks { hooksJsonPath: string; configTomlPath: string; states: { key: string; trusted_hash: string }[] }

/** 生成 hooks.json + 在产品 CODEX_HOME/config.toml 里登记 trusted_hash(标记块内,幂等;不动块外内容) */
export function installHooks(cfg: Pick<RunConfig, "repoRoot" | "codexHome">, nodeBin: string = process.execPath, fault?: "timeout" | "crash"): InstalledHooks {
  const hooksJson = buildHooksJson(cfg, nodeBin, fault);
  const hooksJsonPath = path.join(cfg.codexHome, "hooks.json");
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  writeJson(hooksJsonPath, hooksJson);
  const states: { key: string; trusted_hash: string }[] = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks)) {
    groups.forEach((g, gi) => g.hooks.forEach((h, hi) => states.push({ key: hookKey(hooksJsonPath, event, gi, hi), trusted_hash: hookHash(event, g.matcher, h) })));
  }
  const block = [BLOCK_BEGIN, ...states.flatMap((s) => [`[hooks.state.${JSON.stringify(s.key)}]`, "enabled = true", `trusted_hash = ${JSON.stringify(s.trusted_hash)}`, ""]), BLOCK_END].join("\n");
  const configTomlPath = path.join(cfg.codexHome, "config.toml");
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : "";
  const next = mergeBlock(existing, block);
  if (next !== existing) atomicWrite(configTomlPath, next);
  return { hooksJsonPath, configTomlPath, states };
}

/** 卸载:删 hooks.json 并移除 config.toml 标记块(--no-hooks 时保证该 CODEX_HOME 里没有残留钩子) */
export function uninstallHooks(cfg: Pick<RunConfig, "codexHome">): void {
  const hp = path.join(cfg.codexHome, "hooks.json"); if (fs.existsSync(hp)) fs.rmSync(hp);
  const cp = path.join(cfg.codexHome, "config.toml");
  if (fs.existsSync(cp)) { const txt = fs.readFileSync(cp, "utf8"); const b = txt.indexOf(BLOCK_BEGIN), e = txt.indexOf(BLOCK_END); if (b >= 0 && e > b) atomicWrite(cp, (txt.slice(0, b) + txt.slice(e + BLOCK_END.length)).replace(/\s+$/, "") + "\n"); }
}

/**
 * 分隔符健全性:损坏 / 重复 / 只有一半时**必须报错**,不能当"没有块"去追加新的 —— 那样旧键新键会同时留在文件里,
 * 而 TOML 里后写的未必赢(Codex ir-r1 P2-9)。
 * ⚠️ 只认**独占整行、且不在多行字符串里**的分隔符:
 *   - 裸子串匹配 → 注释里提到这行标记(排查笔记很容易这么写)会被判成"块只有一半",
 *     此后**每次运行都抛、自己好不了**(Codex ir-r2 P2);
 *   - 只按整行匹配还不够 → TOML 多行字符串里原样贴一段配置也会整行命中(Codex ir-r3 P2)。
 */
function lineSpan(existing: string, marker: string): { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = [];
  let offset = 0;
  let multiline: ReturnType<typeof scanTomlLine>["opensMultiline"] = null;
  for (const line of existing.split("\n")) {
    if (multiline) {
      if (findMultilineClose(line, multiline) >= 0) multiline = null;  // 闭合行本身不参与匹配
    } else {
      if (line.trimEnd() === marker) hits.push({ start: offset, end: offset + line.length });
      multiline = scanTomlLine(line).opensMultiline;
    }
    offset += line.length + 1;
  }
  return hits;
}

function blockSpan(existing: string, begin: string, end: string): { b: number; e: number; eEnd: number } | null {
  const bs = lineSpan(existing, begin), es = lineSpan(existing, end);
  if (!bs.length && !es.length) return null;
  if (!bs.length || !es.length) throw new Error(`生成块只有一半(缺${bs.length ? "结束" : "开始"}标记),请手工修复:${bs.length ? begin : end}`);
  if (bs.length > 1) throw new Error(`生成块开始标记出现多次,请手工修复:${begin}`);
  if (es.length > 1) throw new Error(`生成块结束标记出现多次,请手工修复:${end}`);
  if (es[0].start < bs[0].start) throw new Error(`生成块分隔符顺序颠倒(结束标记在开始标记之前),请手工修复:${begin}`);
  return { b: bs[0].start, e: es[0].start, eEnd: es[0].end };
}

/** 合并生成块:已存在则**就地替换**(不挪位置);不存在则追加到末尾。
 *  ⚠️ 只适用于**自带表头**的块(hooks / skills);裸的顶层键要用 `mergeTopLevelBlock`。 */
export function mergeBlock(existing: string, block: string, begin: string = BLOCK_BEGIN, end: string = BLOCK_END): string {
  // 🔴 已存在的块就地替换,不挪位置。旧实现是"删掉再追加到末尾",同一个文件里有多个生成块时
  //    (config.toml 现在有 hooks / skills 隔离 / project root 三个)两个写入方会**互相把对方顶到后面**:
  //    每次运行都重写、`changed` 永远为真、"再跑一次 action=exists" 永远不成立。
  const span = blockSpan(existing, begin, end);
  if (span) {
    const next = existing.slice(0, span.b) + block + existing.slice(span.eEnd);
    return next.endsWith("\n") ? next : next + "\n";
  }
  const base = existing.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + block + "\n";
}

/**
 * 顶层键专用:块**放在文件最前面**。
 * 🔴 TOML 的表头作用域会一直延续到下一个表头 —— 把 `k = v` 追加到末尾,它会变成**最后那张表的键**。
 *    实测:本产品的 `project_root_markers` 就这样落进了 `[hooks.state."…"]`,完全不生效**而体检还报 OK**
 *    (因为体检只查了"块在不在",没查这个键是否真的在顶层)。放最前面则不存在歧义,校验也简单:文件必须以它开头。
 */
export function mergeTopLevelBlock(existing: string, block: string, begin: string, end: string): string {
  const span = blockSpan(existing, begin, end);
  const stripped = span ? existing.slice(0, span.b) + existing.slice(span.eEnd) : existing;
  const rest = stripped.trim();
  return rest ? `${block}\n\n${rest}\n` : `${block}\n`;
}

/** 每个 turn 前写给钩子的上下文(编排器所有;sha256 记入受保护产物) */
export interface HookContext {
  stage: Stage; attempt: number; run_id: string; repo_root: string; data_root: string; run_dir: string; python: string; scripts_rel: string;
  forbidden_path_patterns: string[]; allowed_path_prefixes: string[]; written_at: string;
}
export function writeHookContext(cfg: RunConfig, stage: Stage, attempt: number): string {
  const p = path.join(cfg.runDir, HOOK_CONTEXT_REL);
  const ctx: HookContext = { stage, attempt, run_id: cfg.runId, repo_root: cfg.repoRoot, data_root: cfg.dataRoot, run_dir: cfg.runDir, python: cfg.python, scripts_rel: cfg.scriptsRel,
    forbidden_path_patterns: cfg.forbiddenPathPatterns, allowed_path_prefixes: cfg.allowedPathPrefixes, written_at: new Date().toISOString() };
  writeJson(p, ctx);
  return p;
}
export function readHookContext(runDir: string): HookContext | null {
  return readJsonIfExists<HookContext>(path.join(runDir, HOOK_CONTEXT_REL));
}

/** 钩子自己的日志(每行一个 JSON;诊断用,不是真理源) */
export interface HookLogEntry { ts: string; hook: "stop" | "pre_tool_use"; stage?: string; attempt?: number; decision: "allow" | "block" | "stop" | "error"; reason?: string; tool?: string; command?: string; stop_hook_active?: boolean }
export function appendHookLog(runDir: string, entry: HookLogEntry): void {
  const p = path.join(runDir, HOOK_LOG_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n");
}
export function readHookLog(runDir: string): HookLogEntry[] {
  const p = path.join(runDir, HOOK_LOG_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as HookLogEntry; } catch { return null; } }).filter((x): x is HookLogEntry => !!x);
}
export function summarizeHookLog(entries: HookLogEntry[]): { invocations: number; stop_blocks: number; stop_terminations: number; pre_tool_use_blocks: number; errors: number } {
  return {
    invocations: entries.length,
    stop_blocks: entries.filter((e) => e.hook === "stop" && e.decision === "block").length,
    stop_terminations: entries.filter((e) => e.hook === "stop" && e.decision === "stop").length,
    pre_tool_use_blocks: entries.filter((e) => e.hook === "pre_tool_use" && e.decision === "block").length,
    errors: entries.filter((e) => e.decision === "error").length,
  };
}
/**
 * 钩子上下文与 cwd 的真实性校验:cwd 必须就是上下文里的运行目录,且运行目录在**数据根**之下
 * (防伪造上下文 / 换 cwd)。
 * 🔴 边界是**数据根**不是产品根 —— 分离安装时运行目录本来就在产品根之外。
 *    旧实现要求在产品根之下,于是 data 模式下**每一次钩子调用都报"上下文与 cwd 不一致"并放行**:
 *    PreToolUse 那层执行纪律**全程等于没有**,而阶段照样 complete(实测抓到,5/5 全 error)。
 *    ⇒ 这是"我在别处拆掉了旧假设、却漏了这一处"的典型;同一根因要一次找干净。
 * ⚠️ 旧上下文文件没有 data_root 字段 → 视为不匹配(拒绝按残缺上下文放行)。
 */
export function contextMatchesCwd(ctx: HookContext, cwd: string): boolean {
  try {
    if (!ctx.data_root) return false;
    const a = fs.realpathSync(cwd);
    const b = fs.realpathSync(ctx.run_dir);
    const dataRoot = fs.realpathSync(ctx.data_root);
    return a === b && b.startsWith(dataRoot + path.sep);
  } catch { return false; }
}

/** 读取 stdin 全文(钩子脚本用) */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
