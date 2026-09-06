/**
 * 与**我们自己的底座**(Node 编排器)通话的一层。
 *
 * 界面整套来自开源版 Vibe-Research;它原来打的是开源版的 Python 后端(`/api/valuation`
 * 这种一问一答的语义接口)。我们的底座只有一个通用取数入口 `/fetch`(端点 id + 证据信封),
 * 外加台账 / 对话 / 辩论 / 运行。**差异全部收在这一层与 `api.ts` 的映射里**,
 * 上游的页面代码一行不用改。
 *
 * 🔴 **后端鉴权不在这里**:访问底座用的 Bearer token 由 Vite 代理注入,浏览器侧不持有
 *    (见 vite.config.ts)。⚠️ 别把它跟**模型 key** 混为一谈 —— 那是两件事:
 *    底座 token 浏览器永远拿不到;模型 key 是**用户自己的**,存在他自己的 localStorage 里,
 *    随请求发给本机后端、用完即弃(见 llmStore.ts 与「接入 AI」页)。
 */
import { readAiRuntime, type ExecutionMode } from "./llmStore.ts";
import type { ImportResult } from "./importPositions.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    message: string,
    status: number,
    code = "",
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const AGENT_AUTH_ERROR = /401|unauthorized|missing bearer|authentication|not[_ -]?authenticated|token[_ -]?revoked|(?:proxy-)?authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{4,}/i;
const AGENT_TRANSPORT_DETAIL = /reconnecting|unexpected status|https?:\/\/|wss?:\/\/|cf-ray|x-(?:request|trace)-id|<\s*!?doctype|<\s*html\b/i;
/** 只有这些由产品自己定义、文案受控的错误码可以把 message 原样展示。其余 Agent 错误默认收口。 */
const SAFE_AGENT_MESSAGE_CODES = new Set([
  "llm_broken", "llm_unavailable",
  "bad_provider", "unknown_provider", "missing_base_url", "missing_key", "needs_base_url", "bad_base_url",
  "unsupported_cli", "bad_session", "empty_message", "message_too_long", "bad_message",
  "bad_translation_items", "bad_translation_output", "report_citation_invalid",
  // 探针「有响应但没回填令牌」是可行动的产品文案(换个守结构化输出的模型),不能吞成「连接失败」(Codex r1 P2)
  "probe_bad_output", "bad_probe_request",
  "chat_engine_unsupported", "chat_engine_missing", "chat_capacity", "chat_busy", "chat_cancelled", "timeout",
  "agent_quota", "agent_not_installed", "agent_busy", "agent_timeout", "agent_output_too_large",
  "agent_bad_output", "agent_failed", "agent_empty_output", "agent_cancelled", "agent_start_failed",
  "tool_context_too_large", "bad_agent_output", "guided_output_blocked", "bad_tool_args", "bad_tool",
  "bad_agent_state", "not_found", "tool_failed", "debate_source_changed", "debate_exists", "debate_busy",
  "invalid_task_request", "invalid_task", "invalid_material_resolution", "material_resolution_failed",
  "operation_not_available", "quick_not_eligible", "quick_provider_unsupported", "route_changed", "cancelled",
  "ai_not_configured", "agent_required", "agent_runtime_unsupported", "direct_provider_unsupported", "bad_execution_mode",
  "network_error", "http_error", "bad_json", "upstream_error", "empty_choice",
]);

/**
 * Agent 错误给用户看的唯一出口。引擎原文仍由后端负责诊断，界面只显示可行动提示。
 * 这层也保护旧后端或代理缓存：即使服务端暂时还返回原始 SDK 文本，也不会把地址 / cf-ray 暴露到页面。
 */
export function friendlyAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = error instanceof ApiError ? error.code : "";
  if (code === "agent_not_ready" || code === "agent_not_authenticated" || AGENT_AUTH_ERROR.test(raw)) {
    return "当前 AI 登录已失效或尚未完成。请先到「接入 AI」重新连接。";
  }
  if (AGENT_TRANSPORT_DETAIL.test(raw)) {
    return "本地 Agent 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。";
  }
  if (SAFE_AGENT_MESSAGE_CODES.has(code)) return raw;
  if (code === "bad_llm" || code === "bad_template") {
    return "当前 AI 配置无法使用。请到「接入 AI」检查模型与连接配置后重试。";
  }
  return "本地 Agent 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。";
}

const isAgentPath = (path: string): boolean =>
  path === "/chat" || path.startsWith("/tasks") || path === "/research" || path.startsWith("/debate") ||
  path === "/import" || path === "/llm-probe" || path === "/translate-headlines" ||
  path === "/local-agents/codex/login" || path.startsWith("/guided-tool/");

export type TaskMode = "auto" | "quick" | "deep";
export type TaskRouteTarget = "deterministic" | "quick" | "deep";

export interface ResearchTaskRequest {
  schemaVersion: 1;
  id: string;
  kind: "locate_passages" | "deep_research";
  requestedMode: TaskMode;
  objective: string;
  evidenceScope: "existing" | "open_discovery";
  workflow: "single_step" | "multi_step";
  inputRefs: { kind: "report" | "entity"; id: string }[];
  outputFormat: "text" | "document";
  operation: null;
}

export interface TaskRouteDecision {
  target: TaskRouteTarget;
  requestedMode: TaskMode;
  executionMode: ExecutionMode;
  runtimeFingerprint: string;
  reasonCode: string;
  reason: string;
  routeFingerprint: string;
  materialState: "not_needed" | "ready" | "partial" | "missing";
}

export interface UnifiedTaskEvent {
  runId: string;
  taskId: string;
  sequence: number;
  type: "started" | "progress" | "artifact" | "completed" | "failed";
  payload?: Record<string, unknown>;
}

export interface UnifiedTaskResult {
  status: "routed" | "running" | "completed" | "failed";
  executionAvailable: boolean;
  route: TaskRouteDecision;
  events: UnifiedTaskEvent[];
}

/** 一条证据。所有端点的 evidence 元素都是这个形状,所以一套读法能服务全部端点。 */
export interface Evidence {
  id: string;
  symbol: string;
  market: string;
  field: string;
  value: number | string | null;
  unit: string;
  currency: string;
  period: string;
  as_of: string;
  source: string;
  endpoint: string;
  fetched_at: string;
  adjustment: string;
  raw_ref: string | null;
  note?: string;
  record_key?: string;
}

export interface Envelope {
  script: string;
  symbol: string;
  market: string;
  /** ok / partial / failed —— **partial 不是失败**,是"拿到一部分",要照实用而不是当空 */
  status: string;
  fetched_at: string;
  primary_source: string | null;
  used_sources: string[];
  evidence: Evidence[];
  extra?: Record<string, unknown>;
  errors: unknown[];
  missing: unknown[];
}

export interface FetchResult {
  envelope: Envelope;
  duration_ms: number;
  cached: boolean;
  fetched_at: string;
}

export type GuidedToolReply =
  | { status: "needs_input"; message: string }
  | {
      status: "complete"; message: string; title: string; question: string;
      hypothesis: string; logic: string[]; report: string; tool_result: unknown;
    };

function requestRuntime(llm?: unknown, executionMode?: ExecutionMode): { llm: unknown; executionMode: ExecutionMode } {
  const r = readAiRuntime();
  if (llm !== undefined) return {
    llm,
    executionMode: executionMode ?? (r.status === "ok" && r.config ? r.config.executionMode : "agent"),
  };
  if (r.status === "broken") {
    throw new ApiError("本机存的模型配置读不懂了 —— 请到「接入 AI」重新选一次", 400, "llm_broken");
  }
  if (r.status === "unavailable") {
    throw new ApiError("浏览器不让读本地存储（隐私模式？）—— 「接入 AI」的配置这一轮用不了", 400, "llm_unavailable");
  }
  if (r.status === "none" || !r.config) {
    throw new ApiError("请先到「接入 AI」选择订阅或 API，连接成功后再使用 AI 功能", 409, "ai_not_configured");
  }
  return { llm: r.config.source, executionMode: r.config.executionMode };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const agentPath = isAgentPath(path);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    // fetch 只在网络层失败时抛。这里不能静默成空数据,否则页面把"连不上"渲染成"没有数据"
    if (agentPath) {
      throw new ApiError("本地 Agent 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。", 0, "network");
    }
    throw new ApiError(`连接不到编排器 API:${e instanceof Error ? e.message : String(e)}`, 0, "network");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 代理错误页是 HTML,直接 res.json() 会炸在 "Unexpected token <",把真正原因埋掉
    if (agentPath) {
      throw new ApiError("本地 Agent 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。", res.status, "bad_response");
    }
    throw new ApiError(`返回不是 JSON:${text.slice(0, 120)}`, res.status, "bad_response");
  }
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    const code = b?.error ?? String(res.status);
    const raw = b?.message ?? b?.error ?? `HTTP ${res.status}`;
    const message = agentPath ? friendlyAgentError(new ApiError(raw, res.status, code)) : raw;
    throw new ApiError(message, res.status, code === "turn_failed" && message !== raw ? "agent_not_ready" : code);
  }
  return body as T;
}

async function ensureSelectedLocalAgentReady(llm: unknown): Promise<void> {
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) return;
  const provider = String((llm as { provider?: unknown }).provider ?? "");
  // 只预检**已经有真实适配器**的三种订阅。未知 cli-* 必须交给后端返回 unsupported_cli，
  // 不能在这里误报成“没登录”，否则坏配置会被掩盖。
  if (provider !== "cli-codex" && provider !== "cli-claude" && provider !== "cli-codebuddy") return;
  const status = (await call<LocalAgentStatus[]>("/local-agents")).find((x) => x.provider === provider);
  if (status?.available) return;
  const name = status?.name ?? (provider === "cli-codex" ? "Codex" : "本地 Agent");
  const message = status?.status === "not_installed"
    ? `当前选择的 ${name} 尚未安装。请先到「接入 AI」完成连接。`
    : "当前 AI 登录已失效或尚未完成。请先到「接入 AI」重新连接。";
  throw new ApiError(message, 409, "agent_not_ready");
}

export const backend = {
  importPositions: (files: { name: string; content_base64: string }[], signal?: AbortSignal) => {
    const runtime = requestRuntime();
    return call<ImportResult>("/import", { method: "POST", signal,
      body: JSON.stringify({ kind: "position", files, llm: runtime.llm, executionMode: runtime.executionMode }) });
  },
  health: () => call<{ ok: boolean; version: string }>("/health"),
  product: () => call<ProductInfo>("/product"),
  localAgents: () => call<LocalAgentStatus[]>("/local-agents"),
  startCodexLogin: () => call<{ state: "started" | "pending" }>("/local-agents/codex/login", {
    method: "POST", body: "{}",
  }),
  reports: () => call<{
    id: string; name: string; size: number; ext: string; ts: number; uploaded_at: string;
    chars: number; pages: number | null; truncated: boolean; symbols: string[];
  }[]>("/reports"),
  reportUpload: (name: string, content: string) => call<{
    id: string; name: string; size: number; ext: string; ts: number; uploaded_at: string;
    chars: number; pages: number | null; truncated: boolean; symbols: string[];
  }>("/reports", { method: "POST", body: JSON.stringify({ name, content }) }),
  reportDelete: (id: string) => call<{ removed: boolean }>(`/reports/${encodeURIComponent(id)}/delete`, {
    method: "POST", body: JSON.stringify({ id }),
  }),

  /** 只做内部路由；后端把 AI 来源做成不可逆指纹，执行时换源必须重新路由。 */
  routeTask: (task: ResearchTaskRequest, signal?: AbortSignal) => {
    const runtime = requestRuntime();
    return call<UnifiedTaskResult>("/tasks", {
      method: "POST", body: JSON.stringify({ task, execute: false, executionMode: runtime.executionMode, llm: runtime.llm }), signal,
    });
  },

  /** 执行已由同一高层任务描述过的任务；内部 Quick / Deep 都服从全局 Agent 开关。 */
  runTask: (task: ResearchTaskRequest, expectedRouteFingerprint: string, signal?: AbortSignal, llm?: unknown) => {
    const runtime = requestRuntime(llm);
    return call<UnifiedTaskResult>("/tasks", {
      method: "POST",
      body: JSON.stringify({ task, execute: true, expectedRouteFingerprint, executionMode: runtime.executionMode, llm: runtime.llm }),
      signal,
    });
  },

  resumeTask: (runId: string, routeFingerprint: string, signal?: AbortSignal) =>
    call<{ status: "running" | "completed" | "failed"; events: UnifiedTaskEvent[] }>("/tasks/resume", {
      method: "POST", body: JSON.stringify({ runId, routeFingerprint }), signal,
    }),

  /**
   * 取一个端点。**默认读上次的快照**(见 service.fetchEndpoint):
   * 打开页面不重跑上游,真取数只发生在用户点刷新时。
   */
  fetch: (endpoint: string, opts: { symbol?: string; args?: Record<string, unknown>; refresh?: boolean } = {}) =>
    call<FetchResult>("/fetch", {
      method: "POST",
      body: JSON.stringify({
        endpoint,
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.args ? { args: opts.args } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
      }),
    }),

  ledger: () =>
    call<{
      kinds: Record<string, { label: string; properties: Record<string, unknown>; required: string[] }>;
      labels: { fields: Record<string, string>; enums: Record<string, string> };
      records: Record<string, LedgerRecord[]>;
      issues: Record<string, { id: string; why: string }[]>;
    }>("/ledger"),
  ledgerSave: (kind: string, record: Record<string, unknown>) =>
    call<LedgerRecord>(`/ledger/${encodeURIComponent(kind)}`, { method: "POST", body: JSON.stringify(record) }),
  ledgerDelete: (kind: string, id: string) =>
    call<{ removed: boolean }>(`/ledger/${encodeURIComponent(kind)}/delete`, { method: "POST", body: JSON.stringify({ id }) }),

  /**
   * 一轮对话。
   * ⚠️ `session` **必须按页面分开传**：后端按 session 维护线程，而前端只发最后一句 ——
   *    全站共用 "default" 的话，后端那条线程会把所有页面的对话串成一段，
   *    而界面上每页各自干净，这种不一致从界面上完全看不出来。
   */
  /**
   * 一轮对话。`llm` = 用户自己在「接入 AI」里配的那一份；不给则读取全局 AI 来源。
   * 🔴 key 随请求发给**本机**后端，用完即弃：不写配置文件、不进日志、不入账本。
   */
  chat: async (message: string, session = "default", signal?: AbortSignal, llm?: unknown) => {
    // 🔴 **默认就带上用户那份**，不靠调用方记得传。
    //    上一版要求每个入口自己传 —— 结果三个入口里有两个（Agent 面板、agents.ts）漏了，
    //    表现是"用户在界面上选的模型没生效"，而对话照常成功、界面上看不出任何异常。
    const runtime = requestRuntime(llm);
    if (runtime.executionMode === "agent") await ensureSelectedLocalAgentReady(runtime.llm);
    return await call<{ session: string; reply: string; redacted: number; duration_ms: number }>("/chat", {
      method: "POST",
      // requestRuntime 已按 `!== undefined` 处理调用方覆盖，显式 null 会继续传给后端形状校验，
      // 不会被真值判断吃掉。AI 来源与 Agent 开关必须在同一请求体里一起发送。
      body: JSON.stringify({ session, message, executionMode: runtime.executionMode, llm: runtime.llm }),
      signal,
    });
  },

  /**
   * 连接探针：后端固定一次性令牌，不召回资料库、不进聊天会话。设置页「测试并保存」专用。
   * 🔴 别再用 chat() 做连接检测 —— 那会把资料库片段发给正在测试的 provider（#40）。
   */
  llmProbe: async (llm: unknown, signal?: AbortSignal) => {
    const runtime = requestRuntime(llm);
    await ensureSelectedLocalAgentReady(runtime.llm);
    return await call<{ ok: true; duration_ms: number; direct_supported: boolean; direct_reason: string }>("/llm-probe", {
      method: "POST",
      body: JSON.stringify({ llm: runtime.llm }),
      signal,
    });
  },

  /** RSS 标题走专用受限转换入口，不借用会记上下文的自由对话。 */
  translateHeadlines: async (items: { id: string; title: string }[], signal?: AbortSignal, llm?: unknown) => {
    const runtime = requestRuntime(llm);
    if (runtime.executionMode === "agent") await ensureSelectedLocalAgentReady(runtime.llm);
    return await call<{ items: { id: string; zh: string }[]; redacted: number; duration_ms: number }>("/translate-headlines", {
      method: "POST",
      body: JSON.stringify({ items, executionMode: runtime.executionMode, llm: runtime.llm }),
      signal,
    });
  },

  /** 垂类工具:清单由后端下发,前端**不写死一份**(写死的那份迟早与真实实现对不上) */
  tools: () => call<{ tools: { name: string; label: string }[] }>("/tools"),
  /**
   * 跑一个垂类工具。
   * ⚠️ 这类工具要先取数再算,**几十秒**很正常 —— 调用方要自己给足耐心与进度反馈。
   * 🔴 返回的 JSON 由工具自己定形状(比如"被拦住"与"出错了"分开),这里原样透传。
   */
  runTool: async <T>(name: string, body: unknown, signal?: AbortSignal) => {
    const runtime = requestRuntime();
    return await call<T>(`/tool/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ input: body, executionMode: runtime.executionMode, llm: runtime.llm }),
      signal,
    });
  },
  /** Agent 先补问，条件齐备后由后端调用同一个真实工具，并返回可归档报告。 */
  guidedTool: async (name: string, session: string, message: string, signal?: AbortSignal, llm?: unknown) => {
    const runtime = requestRuntime(llm);
    if (runtime.executionMode === "direct") {
      throw new ApiError("这个功能需要 Agent 调用工具并维持任务状态，请先开启 Vibe Research Agent", 409, "agent_required");
    }
    await ensureSelectedLocalAgentReady(runtime.llm);
    return await call<GuidedToolReply>(`/guided-tool/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ session, message, executionMode: runtime.executionMode, llm: runtime.llm }),
      signal,
    });
  },
  debateStart: (symbol: string, depth?: string, signal?: AbortSignal) => {
    const runtime = requestRuntime();
    if (runtime.executionMode === "direct") throw new ApiError("多空辩论需要 Agent，请先开启 Vibe Research Agent", 409, "agent_required");
    return call<DebateState>("/debate", { method: "POST", body: JSON.stringify({ symbol, ...(depth ? { depth } : {}), executionMode: runtime.executionMode, llm: runtime.llm }), signal });
  },
  debateAdvance: (id: string, signal?: AbortSignal) => {
    const runtime = requestRuntime();
    if (runtime.executionMode === "direct") throw new ApiError("多空辩论需要 Agent，请先开启 Vibe Research Agent", 409, "agent_required");
    return call<DebateState>(`/debate/${encodeURIComponent(id)}/advance`, { method: "POST", body: JSON.stringify({ executionMode: runtime.executionMode, llm: runtime.llm }), signal });
  },

  /** 端点观测序列(跨运行累积)。⚠️ 只在**完整研究运行**时追加,手动点看板不写 —— 稀疏是正常的 */
  series: (endpoint: string) =>
    call<{ endpoint: string; observations: ThermoObservation[]; exists: boolean; unreadable: boolean; dropped: number }>(
      `/series/${encodeURIComponent(endpoint)}`,
    ),

  /**
   * 一屏数据（BFF 查询）。页面**只说要哪个屏**，不认识物理端点。
   *
   * 🔴 为什么必须走它：页面各自拼旧端点时，每块的业务日**互相独立** ——
   *    实测出现过「标题与市场情绪是 08-27，短线情绪却是 08-26」这种跨日混合，
   *    以及「流出 Top 六项全是正净流入」（旧路径只取了前 N 个板块，
   *    而 Core 的页面查询取的是全市场约 500 个）。这两样**页面上都看不出异常**。
   *    ⇒ 业务日、每块状态、跨日标记由 Core 一次算好随信封下发。
   */
  page: (query: string, opts: { symbol?: string; refresh?: boolean; blockArgs?: Record<string, Record<string, unknown>> } = {}) =>
    call<PageResult>(`/page/${encodeURIComponent(query)}`, {
      method: "POST",
      body: JSON.stringify({
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
        ...(opts.blockArgs ? { blockArgs: opts.blockArgs } : {}),
      }),
    }),

  /**
   * 发起一次**六阶段个股研究**（公司画像 → 财务 → 一致预期 → 估值 → 风险 → 成稿）。
   *
   * 🔴 这条链路后端一直都有，界面却**没有任何入口** —— 用户完全不知道产品能生成
   *    带证据链、确定性计算、数据缺口与裁决点的正式研究；「我的研报」只是上传外部文件的归档柜。
   * ⚠️ 它会真的花模型额度、跑十几分钟，所以必须由用户显式点，不能页面一打开就跑。
   */
  startResearch: (body: { symbol: string; company_name?: string; market?: string; endpoints?: "core" | "full"; knowledge?: "on" | "off"; stages?: string[] }) => {
    const runtime = requestRuntime();
    if (runtime.executionMode === "direct") throw new ApiError("六阶段深度研究需要 Agent，请先开启 Vibe Research Agent", 409, "agent_required");
    return call<{ run_id: string; log: string; pid?: number }>("/research", {
      method: "POST", body: JSON.stringify({ ...body, executionMode: runtime.executionMode, llm: runtime.llm }),
    });
  },

  researchStatus: (id: string) => call<ResearchStatus>(`/runs/${encodeURIComponent(id)}/status`),
  cancelResearch: (id: string) => call<ResearchStatus>("/research/cancel", { method: "POST", body: JSON.stringify({ run_id: id }) }),

  /**
   * 「昨天以来变了什么」：对齐同一标的最近两次研究。
   * ⚠️ 只有一次研究时后端报 **need_two_runs** —— 调用方要把它显示成"还没有可比较的第二次"，
   *    **不能显示成"没有变化"**。这两件事完全不同。
   */
  alerts: (symbol: string, market?: string) =>
    call<{ symbol: string; base: string; next: string; diffs: AlertDiff[] }>(
      `/alerts?symbol=${encodeURIComponent(symbol)}${market ? `&market=${encodeURIComponent(market)}` : ""}`,
    ),

  runs: (limit = 50) => call<RunListItem[]>(`/runs?limit=${limit}`),
  report: (id: string) =>
    call<{ run_id: string; report: string | null; appendix: string | null; availability: "ready" | "unvalidated" | "missing"; run_status: string | null }>(`/runs/${encodeURIComponent(id)}/report`),
};

export interface LedgerRecord {
  id: string;
  kind: string;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

/** `/product` 的脱敏投影。🔴 只有环境变量**名**与一个布尔,**没有密钥值** */
export interface ProductInfo {
  version: string;
  provider: {
    name: string;
    profile: string | null;
    wire_api: string;
    base_url: string | null;
    auth: string;
    env_key: string;
    key_present: boolean;
  };
  defaults: Record<string, unknown>;
  paths: { data_root: string; codex_home: string; python: string };
  sources: string[];
  auth_error: string | null;
  /**
   * provider 模板 id → 它自己声明的兼容矩阵状态（`baseline/pass/partial` = 真跑过；`untested` = 只有模板）。
   * 前端只用它给某一家打「已实测」标 —— **不写死一份**，
   * 写死的那份迟早与 providers/ 目录对不上，而对不上的表现是
   * 「明明实测过却没标」或更糟的「没测过却标了已实测」。
   */
  provider_templates?: Record<string, string>;
}

export interface LocalAgentStatus {
  provider: "cli-codex" | "cli-claude" | "cli-codebuddy";
  name: "Codex" | "Claude Code" | "WorkBuddy / CodeBuddy";
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  version: string | null;
  status: "ready" | "not_installed" | "not_authenticated" | "login_pending" | "login_failed" | "probe_failed";
  detail: string;
}

/** 一段产出里数字的着落。三档分开报 —— 混成一个数等于什么都没说 */
export interface DebateNumberAudit {
  total: number;
  /** 对得上资料包里的值 */
  bound: number;
  /** 没有对应的值,但写了算式且重算通过 */
  derived: number;
  /** 两样都不是。不等于错,但这一档没人在看 */
  loose: number;
  /** 🔴 算式是它自己写的、结果对不上 —— 唯一能断言「这里错了」的一类 */
  badMath: { raw: string; stated: number; recomputed: number; percent: boolean }[];
}
export interface DebateStage {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  text: string;
  error?: string;
  audit?: DebateNumberAudit;
}
export interface DebateState {
  id: string;
  symbol: string;
  evidence_count: number;
  gaps: string[];
  stages: DebateStage[];
  /** 跑完了。**不代表跑成了** —— 看 outcome */
  done: boolean;
  outcome: "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
}
export interface ThermoObservation {
  run_id: string; run_date: string; as_of: string; fetched_at: string;
  record_key: string; field: string; value: number | string | null;
  unit: string; period: string; raw_ref: string | null; source: string;
}
/** 一屏里的一块。**status 与 note 要跟数字一起渲染** —— 只给数字不给读法等于替上游打包票 */
export interface PageBlock {
  id: string;
  title: string;
  /** 取数层写的读法护栏（"此源只给当日""是市场叙事不是核验过的因果"…），照抄不改写 */
  note: string | null;
  /**
   * 🔴 **精确联合,不许再混进 `| string`** —— 混了以后整个联合塌成 `string`,
   *    编译器一点检查都做不了:曾因此写出 `b.status === "failed"` 这种
   *    **永远不匹配**的缺口保护(那时后端只产出 "ok" | "missing"),
   *    看着在保护用户,其实一条都没拦住,而 tsc 全绿。
   */
  status: "ok" | "partial" | "failed" | "missing";
  fetched_at: string | null;
  cached?: boolean;
  envelope: { status?: string; evidence?: unknown[]; extra?: Record<string, unknown>; degraded?: string } & Record<string, unknown>;
}

/**
 * 这一屏该看哪一天，以及为什么。
 * 🔴 由 Core 统一算：盘中看进行时、收盘后看今天、非交易日回退到上一个交易日。
 *    页面各自判断的话，同一屏里不同块会落在不同日期上（实测发生过）。
 */
export interface PageContext {
  last_trading_day: string;
  previous_trading_day: string;
  is_today_trading_day: boolean;
  session_phase: string;
  review_date?: string;
  review_reason?: string;
  intraday?: boolean;
}

export interface PageResult {
  query: string;
  title: string;
  intent: string;
  context: PageContext;
  blocks: PageBlock[];
  oldest_fetched_at: string | null;
  /** 这一屏里的数据来自不同业务日 —— 要在界面上说出来，不能让用户以为是同一天的 */
  mixed_ages: boolean;
}

/** 一次研究运行的状态。**阶段是逐个推进的**，界面据此显示进度而不是一个转圈 */
export interface ResearchStatus {
  run_id: string;
  exists: boolean;
  status: string;
  exit_code: number | null;
  stages: { stage: string; status: string; attempts?: number }[];
  evidence_count: number | null;
  calculation_count: number | null;
  finished_at: string | null;
  last_events?: unknown[];
  failure?: { code: string; message: string; action: string; retryable: boolean } | null;
  report?: boolean;
  viewer?: boolean;
}

/** 两次研究之间的一条差异。`kind` 分变了 / 新增 / 消失 —— 三者要分开显示，别糊成"有变化" */
export interface AlertDiff {
  key: string; field: string; period: string; unit: string;
  kind: "changed" | "added" | "removed";
  /** 🔴 `id` 是证据 id —— **必须带出来**:界面上的每个数字都要能点回它出自哪条证据。
   *  后端一直在给,是界面此前把它丢了。 */
  base?: { id?: string; value: unknown; period: string; source: string; as_of?: string };
  next?: { id?: string; value: unknown; period: string; source: string; as_of?: string };
}

export interface RunListItem {
  run_id: string;
  status: string | null;
  symbol: string | null;
  /** 名称来自这次研究已落盘的证据，不在前端猜；归档另展示状态与开始时间。 */
  name: string | null;
  /** 同代码不同市场不算时间序列 —— 比较两次运行要带上它 */
  market: string | null;
  started_at: string | null;
  finished_at: string | null;
  stages_done: number | null;
  stages_total: number | null;
  test_scenario: boolean;
}

/* ---------- 信封读法 ---------- */

/**
 * 资料期的可比形式:把每一段数字**补齐到 8 位**再比。
 *
 * 🔴 直接用字符串比 period 是错的:`"2026-10-31" < "2026-9-30"` 为**真**(字符 `1` < `9`),
 *    月份没补零时"取最新"会取到旧的那条 —— 而两个值都是真数,看不出取错了。
 *    补齐之后 `2026-00000010-...` > `2026-00000009-...`,顺序才对。
 *    也顺带让 `FY2026 / FY2027`、纯日期这些形状都能比。
 */
export function periodKey(period: string | undefined): string {
  return (period ?? "").replace(/\d+/g, (d) => d.padStart(8, "0"));
}

export interface Row {
  key: string;
  note: string;
  fields: Record<string, Evidence | undefined>;
}

/**
 * 取数层是**长表**:同一个信封里 N 个 record_key × M 个 field 平铺成一串证据。
 * 页面要的是"一行一个对象",所以统一透视一次 —— 每处各写一遍分组逻辑,迟早写出不一样的口径。
 */
export function rows(env: Envelope | undefined): Row[] {
  const byKey = new Map<string, Row>();
  for (const e of env?.evidence ?? []) {
    if (!e.record_key) continue; // 没有 record_key 的是整体指标,单独取
    let r = byKey.get(e.record_key);
    if (!r) {
      r = { key: e.record_key, note: e.note ?? "", fields: {} };
      byKey.set(e.record_key, r);
    }
    /**
     * 同一个 key+field 出现多条(多个报告期 / 修订版)时:**取资料期最新的那条**。
     * 🔴 原来是"保留第一条",等于把口径押在后端的返回顺序上 ——
     *    上游哪天改了排序,页面就会从最新一期悄悄切到旧一期,数字全变但不报错。
     *    "最新" 是个确定性规则,不依赖顺序。
     */
    const prev = r.fields[e.field];
    if (!prev || periodKey(e.period) > periodKey(prev.period)) r.fields[e.field] = e;
    if (!r.note && e.note) r.note = e.note;
  }
  return [...byKey.values()];
}

/**
 * 整体指标。优先取"没有 record_key 的那一条";
 *
 * 🔴 **单标的端点会把代码写进 record_key**(`tx_quote` 的每条都是 `record_key: "300308"`),
 *    只认"没有 record_key"会一条都找不到 —— 而 `num()` 把找不到读成 null、页面再兜底成 0,
 *    表现是**现价 / PE / 市值全是 0**,不报错、不空白,看着像"这只股票就是 0"。
 *    ⇒ 整份信封只有一个 record_key 时(即它本来就只讲一个标的),取那一条。
 *    多个 record_key 时**不猜**,返回 undefined —— 那种信封本来就该用 rows() 读。
 */
export function scalar(env: Envelope | undefined, field: string): Evidence | undefined {
  const hit = env?.evidence.find((e) => e.field === field && !e.record_key);
  if (hit) return hit;
  const keys = new Set((env?.evidence ?? []).map((e) => e.record_key).filter(Boolean));
  if (keys.size !== 1) return undefined;
  return env?.evidence.find((e) => e.field === field);
}

/**
 * 取数值。**取不到给 null 不给 0** —— 0 会被读成"确实是零",而真相是"没有"。
 *
 * 🔴 空字符串必须先挡掉:`Number("")` 与 `Number("   ")` 都等于 **0**,
 *    且 `Number.isFinite(0)` 为真 ⇒ 上游用 "" 表达"这个字段没有"时,
 *    这里会一路放行成 0,现价 / 市值 / PE 全变成 0,**而这个函数的注释还写着给 null**。
 *    (这正是本层反复出现的那一类:不报错、不空白、值是错的。)
 */
export function num(e: Evidence | undefined): number | null {
  if (!e || e.value === null) return null;
  if (typeof e.value === "string" && e.value.trim() === "") return null;
  const n = typeof e.value === "number" ? e.value : Number(e.value);
  return Number.isFinite(n) ? n : null;
}

export function str(e: Evidence | undefined): string {
  return e && e.value !== null ? String(e.value) : "";
}

/** 保留两位,给不出就 null */
export function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

/**
 * note 里的 `键=值;键=值` 片段(新闻 / 研报类端点一致采用)。
 * 🔴 只按白名单精确取,不做通用 split —— 正文里本身就含分号,通用切分会切出一堆垃圾键且不报错。
 */
const KV_KEYS = [
  "source", "url", "link", "published", "domain", "topic", "name", "kind", "author",
  "orgSName", "emRatingName", "indvInduName", "pdfUrl", "reason", "type", "进度", "报告期",
  // ⚠️ 白名单漏一个键,前一个键的值就会把它连同后面的内容一起吞掉
  //    (漏 industry 时 source 取出来是 "MIT Tech Review AI;industry=ai")
  "industry", "n_offers", "gpu", "depreciation_line_usd",
  // 🔴 新加的键**必须登记在这儿**：白名单外的键会被安静地丢掉，界面上表现为
  //    "那一行就是不显示"，而代码里明明取了 —— 这次现货卡的"可租 X / 共 Y 张"
  //    与观测时间就是这么消失的。
  "asof_ts", "available_gpus", "total_gpus",
  // 🔴 **同一个坑的第三次**(前两次:研报的 industry、GPU 现货卡的可租张数)。
  //    个股研究页的板块名 / 龙头 / 涨跌、大宗交易的买卖方全在 note 里,
  //    没登记 → noteKV 取到 undefined → 上层回退成"把整条 note 当文本显示",
  //    界面上出现 `板块代码=BK0438;当日涨跌=-0.38%;龙头=五芳斋` 这种内部字符串。
  "买方", "卖方", "当日涨跌", "龙头", "板块代码", "概念",
] as const;
/**
 * 🔴 **取哪些键靠白名单,但"值到哪结束"不能靠白名单。**
 *    终止符只认白名单时,只要 note 里出现一个没登记的键(`predictThisYearEps=` / `industry=`),
 *    上一个键的值就会把它连同后面的内容一起吞掉 —— 界面上表现为
 *    「评级 = 买入; predictThisYearEps=32.41; ...」这种一眼假但不报错的值。
 *    ⇒ 终止符改成**任何"标识符="形状**(ASCII 标识符,或白名单里那几个中文键),
 *      再加一个键就不用回来改这里。
 */
// ASCII 标识符 **或** 2-8 字的中文键(`资料期=` 这种)。前者覆盖 predictThisYearEps 一类,
// 后者覆盖取数层里的中文字段名 —— 只写白名单里那几个中文键,等于对没登记的中文键继续失效。
// ⚠️ 中文键要从**一个字**起算(`年=2026`)。写 {2,8} 的话单字键仍会被上一个字段吞掉,
//    而注释宣称的是"任何标识符形状" —— 又是一次代码没做到注释承诺的事。
const KV_TERM = "(?:[A-Za-z_][A-Za-z0-9_]*|[\\u4e00-\\u9fa5]{1,8})=";
// ⚠️ 第三个终止符 `;<末尾一段不含等号的文字>$`:note 常以一句**没有键的尾注**收尾
//    (`;单位按东财数据中心口径`、护栏句)。不挡的话最后一个键的值会把它一起吞掉 ——
//    界面上就是「卖方 = 广发证券…营业部;单位按东财数据中心口径」这种一眼假但不报错的值。
//    只在**字符串末尾**且**那一段不含 `=`** 时匹配,所以不会误伤正常的 `k=v;k=v`。
const KV = new RegExp(
  `(?:^|;)\\s*(${KV_KEYS.join("|")})=([\\s\\S]*?)(?=;\\s*${KV_TERM}|;\\s*读法:|;\\s*[^;=]+$|$)`,
  "g",
);

export function noteKV(note: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (note ?? "").matchAll(KV)) {
    const k = m[1];
    const v = m[2];
    if (k && v !== undefined && !(k in out)) out[k] = v.trim();
  }
  return out;
}

const notWiredError = (what: string) =>
  new ApiError(`「${what}」还没接到底座上(不是没有数据,是这条链路还没做)`, 501, "not_wired");

/**
 * 这一块底座还没接 —— **返回一个被拒绝的 Promise**。
 *
 * 🔴 不返回空数组:返回空会让页面显示"这里没有数据",而真相是"这条链路还没做",
 *    两件事的处置完全不同。
 * 🔴🔴 **必须是异步拒绝,不能同步 throw**。签名写着 `(): Promise<T>` 的函数如果
 *    同步抛,调用方的 `.catch()` **根本挂不上** —— 异常在 Promise 存在之前就冲出去了,
 *    直接掀掉整个页面(实测:落地页因此白屏,错误是"全球指数还没接")。
 *    ⇒ 页面里那些 `api.xxx().catch(() => {})` 的降级,只有异步拒绝才接得住。
 */
export function notWired<T = never>(what: string): Promise<T> {
  return Promise.reject(notWiredError(what));
}

/** 同步语境用的版本(函数体本身是 async 时,里面 throw 会自动变成拒绝) */
export function throwNotWired(what: string): never {
  throw notWiredError(what);
}
