/**
 * **直连引擎的阶段执行器**:实现与 CodexRunner 同一个 `AgentRunner` 契约。
 *
 * 一个 turn = 一个阶段的一次尝试 = 一段 function calling 循环:
 *   发提示词 → 模型要工具 → 我们执行 → 结果喂回去 → …… → 模型给出最终回复
 *
 * 🔴 三处**刻意不照抄**第一版 backend/chat.py 的做法(照抄即缺陷,见双引擎方案 v2 §5):
 *  ① 工具参数解析失败**不静默换成 `{}`** —— 回喂 `invalid_arguments` 并保留 call id 让模型改。
 *     静默替换会让"模型传错了参数"变成"工具行为异常",而且模型永远学不到自己错在哪。
 *  ② 工具结果**不按字符硬截** —— 截断的 JSON 是坏 JSON,模型只会更糊涂。
 *     超限时回一个结构化说明,告诉它改用 read_run_file 的 offset/limit_chars 分段读。
 *  ③ 轮数上限**不是聊天经验值**:一个阶段可能要多次分页读取 + 多次计算,按阶段重新标定。
 *
 * ⚠️ **上下文策略 = 每阶段独立会话**(per_stage_session):`threadId` 恒为 null,不跨阶段带消息。
 *    阶段之间靠**已校验的磁盘产物**传状态,模型用 read_run_file 自取。
 *    这不是省事:providers/deepseek.json 自己写着无状态、忽略 previous_response_id、超上下文直接 400,
 *    长线程在那类 provider 上根本不成立;而磁盘产物本来就是 validator 校验的那份真理源。
 */
import path from "node:path";

import { nowIso } from "../fsutil.ts";
import { withOutputSchema, type DirectCapability } from "../providers.ts";
import { RUN_TOOLS, RunToolsError, callRunTool, runToolsAsFunctionSpecs, type RunToolsContext } from "../run_tools.ts";
import { EventsLog, type AgentRunner, type CommandRecord, type TurnOutcome } from "../agent_runner.ts";
import type { Stage } from "../config.ts";
import { DirectTransportError, chatCompletion, type ChatMessage } from "./direct_transport.ts";

/** 单条工具结果喂回模型的上限。超了给结构化说明,不截断 JSON。 */
const TOOL_RESULT_CAP = 24_000;

export interface DirectStageAgentOptions {
  runId: string;
  /** 受控工具的运行上下文(运行目录 / 产品根 / 解释器) */
  toolCtx: RunToolsContext;
  capability: DirectCapability;
  apiKey: string;
  model: string;
  eventsPath: string;
  /** 已知密钥值:落盘前脱敏(纵深防御) */
  secrets?: string[];
  /** 单次模型请求的超时 */
  requestTimeoutMs: number;
  /**
   * 一个 turn 内最多允许几轮工具往返。
   * 到顶后**不是直接失败**,而是禁用工具再要一次最终回复(照搬 chat.py:150 的做法) ——
   * 半途而废的 turn 会让编排器拿不到任何产出,而模型此时往往已经有足够材料收尾了。
   */
  maxToolRounds?: number;
  /** 事件旁路观察者(进度渲染);只观察不参与,抛错不得影响运行 */
  observer?: (ev: Record<string, unknown>) => void;
  /** 外部取消 */
  signal?: AbortSignal;
}

/** 把工具返回值转成喂给模型的文本;过大时给结构化说明而不是坏 JSON */
function toolResultText(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  if (text.length <= TOOL_RESULT_CAP) return text;
  return JSON.stringify({
    error: "result_too_large",
    bytes: text.length,
    cap: TOOL_RESULT_CAP,
    hint: "结果过大,已未返回内容。请改用 read_run_file 的 offset 与 limit_chars 分段读取。",
  });
}

/** 累加多轮 usage(各家字段名不完全一致,只加数值型) */
function mergeUsage(acc: Record<string, number> | null, next: Record<string, number> | null): Record<string, number> | null {
  if (!next) return acc;
  const out = { ...(acc ?? {}) };
  for (const [k, v] of Object.entries(next)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}

export class DirectStageAgent implements AgentRunner {
  private readonly opts: DirectStageAgentOptions;
  private readonly events: EventsLog;
  private readonly observer: ((ev: Record<string, unknown>) => void) | null;
  private seq = 0;

  /**
   * 直连没有跨阶段线程 —— 恒为 null,且这是**如实声明**不是未实现:
   * capabilities.contextStrategy = per_stage_session 说的就是这件事。
   */
  readonly threadId: string | null = null;

  constructor(opts: DirectStageAgentOptions) {
    this.opts = opts;
    this.events = new EventsLog(opts.eventsPath, opts.secrets ?? []);
    this.observer = opts.observer ?? null;
  }

  eventsDigest(): string | null { return this.events.digest(); }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.seq += 1;
    const ev = { ts: nowIso(), run_id: this.opts.runId, seq: this.seq, stage, type, ...payload };
    this.events.append(ev);
    // 落盘在前、旁路在后:观察者出任何问题都不能影响事件账本的完整性
    if (this.observer) { try { this.observer(ev); } catch { /* 显示层永不影响运行 */ } }
  }

  async runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome> {
    signal = signal && this.opts.signal ? AbortSignal.any([signal, this.opts.signal]) : signal ?? this.opts.signal;
    signal?.throwIfAborted();
    const t0 = Date.now();
    const { capability, apiKey, model } = this.opts;
    const maxRounds = this.opts.maxToolRounds ?? 24;

    // 结构化输出:能由服务端强制就强制,不能就写进提示词。**降级要出声** —— 它损的是命中率,
    // 而"命中率下降"表现为偶发的格式错,最容易被误当成模型不稳定。
    const serverSchema = capability.structuredOutput === "server_schema";
    const shaped = withOutputSchema(prompt, outputSchema, serverSchema ? "json_schema" : "prompt");
    const responseFormat = shaped.outputSchema
      ? { type: "json_schema", json_schema: { name: "stage_output", strict: false, schema: shaped.outputSchema } }
      : undefined;
    if (outputSchema && !serverSchema) {
      this.log(stage, "direct.schema_downgraded", { attempt, reason: capability.reason, unverified: capability.unverified });
    }

    const messages: ChatMessage[] = [{ role: "user", content: shaped.prompt }];
    const toolSpecs = runToolsAsFunctionSpecs();
    const fileChanges: string[] = [];
    // 直连没有 shell,`commands` 如实留空。
    // ⚠️ 别把工具调用塞进这里冒充命令:validator 的命令形态规则是为 shell 写的,
    //    塞进去既拦不住什么,又制造出"审计等价"的假象(capabilities.auditLevel 已如实标了 host_events)。
    const commands: CommandRecord[] = [];
    let usage: Record<string, number> | null = null;
    let itemCount = 0;
    let finalResponse = "";
    let failed: string | null = null;

    this.log(stage, "direct.turn_start", { attempt, model, structured_output: capability.structuredOutput, max_tool_rounds: maxRounds });

    /** 工具循环是否已自然结束(模型不再要工具);false = 撞了轮数上限 */
    let settled = false;

    // ⚠️ **工具循环期间绝不带 response_format**。
    //    实测(2026-09-04,MiMo):`response_format=json_schema` 与 `tools` 同时给,
    //    模型会**直接输出那个 JSON、一个工具都不调** —— 5 秒收工、零工具调用、
    //    阶段产物根本没写,而 finish_reason 还是正正经经的 "stop"。
    //    强制结构化输出的语义就是"立刻产出这个结构",它和"先干活再汇报"天然冲突。
    //    ⇒ 干活的时候只给工具;要格式化的汇报,等干完再单独要一轮(见下面的 finalize)。
    //    Codex 路径没这个问题:outputSchema 由引擎在 turn 层面处理。
    for (let round = 1; round <= maxRounds; round += 1) {
      signal?.throwIfAborted();
      let reply;
      try {
        reply = await chatCompletion({
          baseURL: capability.baseURL ?? "", apiKey, model, messages,
          tools: toolSpecs,
          timeoutMs: this.opts.requestTimeoutMs,
          signal,
        });
      } catch (e) {
        const err = e instanceof DirectTransportError ? e : null;
        failed = err ? `${err.code}: ${err.message}` : (e instanceof Error ? e.message : String(e));
        this.log(stage, "direct.request_failed", { attempt, round, code: err?.code ?? "unknown", status: err?.status ?? null, retryable: err?.retryable ?? false, message: failed });
        break;
      }

      itemCount += 1;
      usage = mergeUsage(usage, reply.usage);
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      this.log(stage, "direct.model_reply", { attempt, round, finish_reason: reply.finishReason, tool_calls: calls.length, duration_ms: reply.durationMs });

      if (calls.length === 0) {
        settled = true;
        finalResponse = reply.message.content ?? "";
        break;
      }

      for (const call of calls) {
        const name = call.function?.name ?? "";
        let args: unknown;
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // ① 不静默换成 {}:告诉它参数没解析成功,保留 call id 让它重来
          this.log(stage, "direct.tool_bad_arguments", { attempt, round, tool: name });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "invalid_arguments", message: "arguments 不是合法 JSON，请重新给出这次调用的参数。" }) });
          continue;
        }
        try {
          const value = callRunTool(this.opts.toolCtx, name, args);
          // fileChanges 只收**agent 产物**(calcs / stages / report.md)。
          // ⚠️ 不要把工具内部簿记(.vibe/calc-owners.json)算进来 —— validator 会把它判成
          //    "改写了受保护的编排产物",于是每次计算都变成违规。
          for (const abs of writtenPathsOf(this.opts.toolCtx.runDir, name, args, value)) if (!fileChanges.includes(abs)) fileChanges.push(abs);
          this.log(stage, "direct.tool_ok", { attempt, round, tool: name });
          messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText(value) });
        } catch (e) {
          // ② 工具失败回喂结构化错误,不中断循环 —— 让模型换个招继续(第一版 tools.py 的做法,值得继承)
          const code = e instanceof RunToolsError ? e.code : "internal";
          const message = e instanceof Error ? e.message : String(e);
          this.log(stage, "direct.tool_error", { attempt, round, tool: name, code });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: code, message }) });
        }
      }
    }

    // ── 收尾:要一份规定格式的汇报 ──
    // 两种情况需要单独再要一轮:
    //  ① 服务端 schema 模式 —— 干活那几轮刻意没带 response_format,汇报格式还没约束过;
    //  ② 撞了轮数上限 —— 模型还想继续调工具,得叫停并让它用现有材料收尾,否则整个 turn 颗粒无收。
    // (提示词模式下若模型已自然收尾,它的回复本身就该是那个 JSON,不必多花一次调用。)
    const needFinalize = !failed && (responseFormat ? true : !settled);
    if (needFinalize) {
      if (!settled) this.log(stage, "direct.tool_rounds_exhausted", { attempt, rounds: maxRounds });
      messages.push({
        role: "user",
        content: settled
          ? "现在请**不要再调用工具**，只用规定的 JSON 格式汇报本轮结果。"
          : "工具调用轮数已达上限。请**不要再调用工具**，用现在已有的材料，按规定的 JSON 格式汇报本轮结果。",
      });
      try {
        const reply = await chatCompletion({
          baseURL: capability.baseURL ?? "", apiKey, model, messages,
          responseFormat,   // 此时没有 tools,强制结构化才不会挤掉工具调用
          timeoutMs: this.opts.requestTimeoutMs,
          signal,
        });
        itemCount += 1;
        usage = mergeUsage(usage, reply.usage);
        finalResponse = reply.message.content ?? "";
        this.log(stage, "direct.finalized", { attempt, finish_reason: reply.finishReason, duration_ms: reply.durationMs, after_tool_rounds: settled ? "settled" : "exhausted" });
      } catch (e) {
        const err = e instanceof DirectTransportError ? e : null;
        failed = err ? `${err.code}: ${err.message}` : (e instanceof Error ? e.message : String(e));
        this.log(stage, "direct.finalize_failed", { attempt, code: err?.code ?? "unknown", message: failed });
      }
    }
    if (!failed && !finalResponse.trim()) failed = "模型给出了空回复";

    const durationMs = Date.now() - t0;
    this.log(stage, "direct.turn_end", { attempt, item_count: itemCount, file_changes: fileChanges.length, duration_ms: durationMs, failed });
    return { finalResponse, usage, commands, fileChanges, itemCount, durationMs, failed, threadId: null };
  }
}

/**
 * 从工具调用推出**它写了哪些 agent 产物**,返回**绝对路径**。
 * 只认 registry 里那几个写类工具;读类工具不产生变更。
 *
 * 🔴 **必须是绝对路径**。validator 用 `path.resolve(f)` 判越界,而 `path.resolve` 是相对
 *    **当前工作目录**解析的 —— 给它相对路径 `stages/profile.json`,会被解析成 `<cwd>/stages/profile.json`,
 *    于是**合法产物被判成"写入了运行目录之外的文件"**,阶段直接失败。
 *    (2026-09-04 真踩:单元测试全绿,只有真跑一次才暴露 —— 单测只断言了本函数的返回值,
 *     没测它与 validator 之间的接口契约。)
 */
export function writtenPathsOf(runDir: string, name: string, args: unknown, value: unknown): string[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const v = (value ?? {}) as Record<string, unknown>;
  const abs = (rel: string) => path.resolve(runDir, ...rel.split("/"));
  if (name === "calculate") return typeof a.output_file === "string" ? [abs(`calcs/${a.output_file}`)] : [];
  if (name === "write_stage") return typeof v.written === "string" ? [abs(v.written)] : [];
  if (name === "write_report") {
    return Array.isArray(v.written) ? (v.written as unknown[]).filter((x): x is string => typeof x === "string").map(abs) : [];
  }
  return [];
}

/** registry 里有几个写类工具,writtenPathsOf 就得认几个 —— 新增写类工具而忘了在这里认领,变更会静默漏记 */
export const WRITE_TOOL_NAMES: readonly string[] = RUN_TOOLS.filter((t) => t.name === "calculate" || t.name.startsWith("write_")).map((t) => t.name);
