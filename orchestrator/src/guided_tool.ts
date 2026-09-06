/**
 * 对话驱动的工具入口(Core)。
 *
 * Core 只负责四件事：把工具说明交给 Agent、让 Agent 补问、执行垂类工具、
 * 再把真实返回交给 Agent 写成报告。工具叫什么、参数与结果是什么，Core 一概不认识。
 */
import crypto from "node:crypto";
import AjvModule from "ajv";

import { ChatError, chatSend, type ChatTurnResult } from "./chat.ts";
import { complianceGate } from "./gate.ts";
import { gatePatterns } from "./config.ts";
import type { LlmOverride } from "./runtime_provider.ts";

export class GuidedToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GuidedToolError";
    this.code = code;
  }
}

export interface GuidedToolReply {
  status: "needs_input" | "complete";
  message: string;
  title?: string;
  question?: string;
  hypothesis?: string;
  logic?: string[];
  report?: string;
  tool_result?: unknown;
}

interface ModelTurn {
  status: "needs_input" | "ready" | "complete";
  message: string;
  title: string;
  question: string;
  hypothesis: string;
  logic: string[];
  tool_args_json: string;
  document: string;
}

export interface GuidedToolDeps {
  chat: typeof chatSend;
  runTool: (name: string, body: unknown) => Promise<unknown>;
}

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_CONTEXT = 24_000;
const MAX_REPORT = 16_000;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "message", "title", "question", "hypothesis", "logic", "tool_args_json", "document"],
  properties: {
    status: { type: "string", enum: ["needs_input", "ready", "complete"] },
    message: { type: "string", maxLength: 1200 },
    title: { type: "string", maxLength: 160 },
    question: { type: "string", maxLength: 2000 },
    hypothesis: { type: "string", maxLength: 3000 },
    logic: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
    tool_args_json: { type: "string", maxLength: 12000 },
    document: { type: "string", maxLength: MAX_REPORT },
  },
} as const;

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts: object) => {
  compile: (schema: object) => (value: unknown) => boolean;
};
const validModel = new AjvCtor({ strict: false }).compile(OUTPUT_SCHEMA);

const INSTRUCTIONS = [
  "你是一个对话驱动的任务 Agent。服务端会给你一个垂类工具的真实能力说明。",
  "先理解用户要验证的问题，再判断工具要运行还缺哪些信息。不要把整张参数表甩给用户；每轮只问当前真正缺少的一组信息。",
  "不得编造能力说明里不存在的选项、参数或数据。缺失信息不能擅自猜。",
  "信息不足时：status=needs_input，message 用自然中文追问；其余字段可留空。",
  "信息齐全时：status=ready；title/question/hypothesis/logic 填完整；tool_args_json 必须是可解析的 JSON 对象字符串，只放工具需要的参数；document 留空。",
  "服务端随后会把工具的真实返回再发给你。收到成功结果后：status=complete，基于真实返回写完整 Markdown 报告；不得补造返回中没有的数字。",
  "报告必须覆盖：问题、假设、执行逻辑、数据与口径、核心结果、限制与可验证结论。只报告验证结果，不给动作建议。",
  "工具拒绝执行或返回错误时：status=needs_input，解释原因并只追问修正所需的信息，不得写成已完成。",
  "运行错误不等于用户参数有错；没有确定依据时，不要猜测用户需要改变什么。应说明本次失败、尚不能给出结果。",
  "只输出符合 schema 的 JSON。",
].join("\n");

function object(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function safeJson(v: unknown, label: string): string {
  const text = JSON.stringify(v);
  if (!text || text.length > MAX_CONTEXT) throw new GuidedToolError("tool_context_too_large", `${label}过大，不能安全交给 Agent`);
  return text;
}

function parseModel(reply: string): ModelTurn {
  let raw: unknown;
  try { raw = JSON.parse(reply); }
  catch { throw new GuidedToolError("bad_agent_output", "Agent 没有返回可读的结构化结果"); }
  if (!object(raw) || !validModel(raw)) throw new GuidedToolError("bad_agent_output", "Agent 返回不符合完整结构与长度约束");
  const status = raw.status;
  if (status !== "needs_input" && status !== "ready" && status !== "complete") {
    throw new GuidedToolError("bad_agent_output", "Agent 返回了未知状态");
  }
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message || message.length > 1200) throw new GuidedToolError("bad_agent_output", "Agent 的回复为空或过长");
  const logic = Array.isArray(raw.logic) && raw.logic.every((x) => typeof x === "string")
    ? raw.logic.map((x) => x.trim()).filter(Boolean)
    : [];
  return {
    status,
    message,
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    question: typeof raw.question === "string" ? raw.question.trim() : "",
    hypothesis: typeof raw.hypothesis === "string" ? raw.hypothesis.trim() : "",
    logic,
    tool_args_json: typeof raw.tool_args_json === "string" ? raw.tool_args_json.trim() : "",
    document: typeof raw.document === "string" ? raw.document.trim() : "",
  };
}

function assertVisible(text: string): void {
  const gate = complianceGate(text);
  if (!gate.ok) throw new GuidedToolError("guided_output_blocked", "Agent 产出越过了产品边界，已停止展示与归档");
}

function parseArgs(text: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new GuidedToolError("bad_tool_args", "Agent 生成的工具参数不是合法 JSON"); }
  if (!object(raw) || Object.keys(raw).length > 30 || Object.prototype.hasOwnProperty.call(raw, "action")) {
    throw new GuidedToolError("bad_tool_args", "Agent 生成的工具参数不符合执行约束");
  }
  if (JSON.stringify(raw).length > 12_000) throw new GuidedToolError("bad_tool_args", "Agent 生成的工具参数过大");
  return raw;
}

function requiredDisclosures(toolResult: unknown): string[] {
  if (!object(toolResult) || !object(toolResult.result)) return [];
  const raw = toolResult.result.required_disclosures;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 12 || !raw.every((x) => typeof x === "string" && x.trim().length > 0 && x.trim().length <= 500)) {
    throw new GuidedToolError("bad_tool_result", "工具返回的强制披露格式不合法");
  }
  return [...new Set(raw.map((x) => x.trim()))];
}

function appendRequiredDisclosures(document: string, disclosures: readonly string[]): string {
  if (!disclosures.length) return document;
  // 工具声明的口径必须由服务端放进可见正文。不能用 includes 去重：模型可能把同一句
  // 藏进 HTML 注释、代码块或别的不可见位置，从而绕过披露。
  return `${document.trim()}\n\n## 工具口径披露\n\n${disclosures.map((line) => `- ${line}`).join("\n")}`;
}

async function ask(
  opts: { repoRoot: string; dataRoot?: string; python?: string; signal?: AbortSignal },
  session: string,
  message: string,
  context: string,
  llm: LlmOverride | undefined,
  deps: GuidedToolDeps,
): Promise<ModelTurn> {
  let correction = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    opts.signal?.throwIfAborted();
    let turn: ChatTurnResult;
    try {
      turn = await deps.chat({
        ...opts,
        maxMessage: 32_000,
        developerInstructions: `${INSTRUCTIONS}\n产品内部禁用表达（所有文本字段都不得复述，改用中性的历史事实或参数描述）：${JSON.stringify(gatePatterns())}${correction}`,
        outputSchema: OUTPUT_SCHEMA,
        preambleText: "",
        skipGate: true,
        contextText: context,
      }, { session, message, ...(llm ? { llm } : {}) });
    } catch (e) {
      if (e instanceof ChatError) throw new GuidedToolError(e.code, e.message);
      throw e;
    }
    opts.signal?.throwIfAborted();
    try {
      const parsed = parseModel(turn.reply);
      // Gate every user-visible field before execution/return, not just message.
      for (const text of [parsed.message, parsed.title, parsed.question, parsed.hypothesis, ...parsed.logic, parsed.document]) assertVisible(text);
      return parsed;
    } catch (e) {
      if (!(e instanceof GuidedToolError) || attempt === 1) throw e;
      // Retry only this model response, never the real tool. No field filling,
      // JSON repair, gate weakening, or switch to another model source.
      correction = `\n【唯一一次格式修正】上一条输出未通过 ${e.code}。重新回答本轮问题，必须符合全部 schema 与产品边界；不改变已执行的工具结果，不编造字段或数字。`;
    }
  }
  throw new GuidedToolError("bad_agent_output", "Agent 输出修正失败");
}

export async function guidedToolTurn(
  opts: { repoRoot: string; dataRoot?: string; python?: string; signal?: AbortSignal },
  req: { name: string; label: string; session: string; message: string; llm?: LlmOverride },
  deps: GuidedToolDeps = { chat: chatSend, runTool: async () => { throw new Error("runTool dependency missing"); } },
): Promise<GuidedToolReply> {
  if (!NAME_RE.test(req.name)) throw new GuidedToolError("bad_tool", "工具名不合法");
  if (!SESSION_RE.test(req.session)) throw new GuidedToolError("bad_session", "会话名不合法");
  const message = String(req.message ?? "").trim();
  if (!message || message.length > 4_000) throw new GuidedToolError("bad_message", "消息必须为 1–4000 个字符");

  opts.signal?.throwIfAborted();
  const catalog = await deps.runTool(req.name, { action: "catalog" });
  opts.signal?.throwIfAborted();
  const context = `【工具】${req.label}\n【真实能力说明】\n${safeJson(catalog, "工具能力说明")}`;
  const threadSession = `guided-${crypto.createHash("sha256").update(`${req.name}\0${req.session}`).digest("hex").slice(0, 20)}`;
  const first = await ask(opts, threadSession, message, context, req.llm, deps);
  opts.signal?.throwIfAborted();
  assertVisible(first.message);
  if (first.status === "needs_input") return { status: "needs_input", message: first.message };
  if (first.status !== "ready") throw new GuidedToolError("bad_agent_state", "工具尚未执行，Agent 却声称已经完成");
  if (!first.title || !first.question || !first.hypothesis || !first.logic.length) {
    throw new GuidedToolError("bad_agent_output", "执行前的任务假设与逻辑不完整");
  }

  const args = parseArgs(first.tool_args_json);
  const toolResult = await deps.runTool(req.name, args);
  opts.signal?.throwIfAborted();
  const explicitFailure = object(toolResult) && toolResult.ok === false;
  const disclosures = explicitFailure ? [] : requiredDisclosures(toolResult);
  const disclosureInstruction = disclosures.length
    ? `\n【必须逐字披露】\n${disclosures.map((line) => `- ${line}`).join("\n")}`
    : "";
  const follow = explicitFailure
    ? `【工具没有完成任务】\n${safeJson(toolResult, "工具返回")}\n请解释原因并追问修正所需的信息，status 必须是 needs_input。`
    : `【工具已执行，以下是唯一可用的真实结果】\n${safeJson(toolResult, "工具返回")}${disclosureInstruction}\n请据此完成报告，status 必须是 complete。`;
  const second = await ask(opts, threadSession, follow, context, req.llm, deps);
  opts.signal?.throwIfAborted();
  assertVisible(second.message);
  if (explicitFailure) {
    if (second.status !== "needs_input") throw new GuidedToolError("bad_agent_state", "工具拒绝后 Agent 没有回到补问状态");
    return { status: "needs_input", message: second.message };
  }
  if (second.status !== "complete" || !second.document) {
    throw new GuidedToolError("bad_agent_output", "工具完成后 Agent 没有生成完整报告");
  }
  const document = appendRequiredDisclosures(second.document, disclosures);
  if (document.length > MAX_REPORT) throw new GuidedToolError("bad_agent_output", "工具完成后的报告过长");
  assertVisible(document);
  return {
    status: "complete",
    message: second.message,
    title: first.title,
    question: first.question,
    hypothesis: first.hypothesis,
    logic: first.logic,
    report: document,
    tool_result: toolResult,
  };
}
