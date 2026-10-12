/**
 * **模型 API 传输层**:OpenAI 兼容的 Chat Completions 客户端。
 *
 * 为什么是 Chat Completions:绝大多数模型厂商、第三方网关与本地模型(Ollama / vLLM / LM Studio)
 * 都提供这一条线;产品对「模型 API」这类大脑只说这一种协议。
 *
 * 🔴 **本层只管"把一轮对话发出去、把回复解析回来"**,不含工具循环、不含阶段语义 ——
 *    那些在调用方(研究阶段 / 页面对话 / 资料导入)里。这样传输层可以被单独用假服务器测。
 *
 * ⚠️ **不做流式**。研究阶段的产出是结构化 JSON,不需要逐字显示;进度显示走阶段级
 *    (ProgressReporter 已有)。流式会带来 SSE 分帧、断流重试、tool_calls 跨 delta 拼接三类复杂度,
 *    而它们只有在"要让用户看到字一个个出来"时才值得。
 */
import { maskKnownSecret } from "../agent_runner.ts";
import { NON_PUBLIC_CODE, publicOnlyPost } from "../net_guard.ts";
import { remotePageBaseUrlError } from "../runtime_provider.ts";

/** 一条对话消息。`tool` 角色用于把工具执行结果喂回模型。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  /**
   * 思考模式下模型返回的思考内容(DeepSeek、小米 MiMo 等)。
   * 🔴 带 tools 的请求里,之前每一轮 assistant 消息的这一段都要**原样回传**,漏了接口直接 400
   *    (DeepSeek「Thinking Mode · Tool Calls」与 MiMo「Deep Thinking」官方文档,2026-10-07 核实;
   *     两家思考模式都是默认开启)。
   *    ⇒ 工具循环一律把 `reply.message` 整条推回 messages,**不要按 role/content/tool_calls 重新拼一条**。
   */
  reasoning_content?: string | null;
}

/** 多模态消息里的一段(OpenAI 兼容格式):文本,或 data: URL 形式的图片 */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** 带图片的用户消息。只出现在请求里;模型的回复永远按纯文本 ChatMessage 解析 */
export interface ChatMultimodalMessage { role: "user"; content: ChatContentPart[] }

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** function calling 的工具声明(由 run_tools.ts 的 registry 生成,不在这里另写一份) */
export interface ChatFunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: (ChatMessage | ChatMultimodalMessage)[];
  tools?: ChatFunctionSpec[];
  /** 服务端结构化输出约束;provider 不支持时由调用方改走提示词,**不要在这里静默丢掉** */
  responseFormat?: Record<string, unknown>;
  timeoutMs: number;
  /** 外部取消(编排器的 turn 超时 / 用户中止) */
  signal?: AbortSignal;
  /**
   * 只连公网地址(连接时检查解析结果)。不传 = 远程访问模式(VRA_REMOTE=1)下、地址是 https 公网域名写法时自动打开 ——
   * 页面能填的地址只有这一种写法;模板 / 后台默认里的 localhost、IP 地址不受影响。
   * ⚠️ 部署者自己的模板若用公网写法的域名指向内网(分域 DNS),远程模式下也会被拒。
   */
  publicOnly?: boolean;
}

export interface ChatReply {
  message: ChatMessage;
  finishReason: string | null;
  usage: Record<string, number> | null;
  /** 本次请求耗时,进事件流 */
  durationMs: number;
}

export class DirectTransportError extends Error {
  readonly code: string;
  /** HTTP 状态码;网络层失败时为 null */
  readonly status: number | null;
  /** 是否值得重试:网络抖动、429、5xx 值得;4xx 参数错不值得 */
  readonly retryable: boolean;
  constructor(code: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "DirectTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 模型 API 失败 → 给用户看的固定措辞({code, message})。日志只记错误码与 HTTP 状态,
 * 不记上游原文(它可能回显 key 或用户资料)。取消 / 超时由调用方先处理。
 * ⚠️ 措辞刻意不出现 "401" / "authentication" 之类字样:桌面端按这些字样把报错改写成
 *    「去本机登录」,而模型 API 来源跟本机登录无关。
 */
export function publicApiFailure(error: DirectTransportError, rejectedHint: string, tag = "api"): { code: string; message: string } {
  console.error(`[${tag}] 模型 API 请求失败:${error.code}${error.status !== null ? ` HTTP ${error.status}` : ""}`);
  // 跳转是地址填错了,不是"稍后再试"能好的事:单独一句,告诉用户去改地址
  if (error.code === "redirect") {
    return { code: "api_redirect", message: "模型 API 地址返回了跳转，产品不会跟随。请到「接入 AI」把 Base URL 改成服务商文档里给出的最终地址。" };
  }
  if (error.code === "forbidden_address") {
    return { code: "api_address_forbidden", message: "模型 API 地址解析到了本机或内网地址，远程访问模式下不允许连接。请到「接入 AI」改用服务商的公网地址。" };
  }
  if (error.status === 401 || error.status === 403) {
    return { code: "api_key_rejected", message: "模型 API 拒绝了当前的 API key（可能填错、已过期，或没有这个模型的权限）。请到「接入 AI」检查后重试。" };
  }
  if (error.status === 429) return { code: "api_rate_limited", message: "模型 API 的调用频率或额度受限，请稍后再试。" };
  if (error.status === 404) {
    // 404 几乎只有一个原因:地址路径拼错(常见是 Base URL 里多带了 chat/completions 这类端点后缀,产品会再拼一次)。
    // 这跟"模型名 / 上下文"没关系,别用那句笼统文案把用户引偏;文案里也不放 URL,否则桌面端会把它吞成"连接失败"。
    return { code: "api_request_rejected", message: "模型 API 说这个地址不存在（HTTP 404）：请到「接入 AI」检查 Base URL —— 多数服务商只填到根地址（到 /v1 为止），不要带「chat/completions」这段路径。" };
  }
  if (error.status !== null && error.status >= 400 && error.status < 500) {
    return { code: "api_request_rejected", message: `模型 API 拒绝了这次请求（常见原因：${rejectedHint}）。请到「接入 AI」检查模型与 Base URL 后重试。` };
  }
  if (error.code === "network_error") return { code: "turn_failed", message: "连不上模型 API。请检查网络与 Base URL 后重试。" };
  return { code: "turn_failed", message: "模型 API 暂时没有给出可用结果，请稍后重试或换一个模型。" };
}

/** 上游返回体只取有限长度进错误消息:整包塞进去会把日志和事件流冲垮,也更容易把敏感内容带出去 */
const ERROR_BODY_CAP = 600;

/**
 * 把可能含密钥的文本抹掉。
 * 🔴 错误消息会进事件流、日志和界面 —— key 只要出现一次就等于落盘了。
 * 这里同时抹**已知的那一个**(精确值)和**通用形态**:只抹形态会漏掉不长这样的密钥,
 * 只抹已知值会漏掉上游回显的其它凭据。已知值不设长度门槛(短的只抹独立出现的整段,见 maskKnownSecret)。
 * 🔴 调用方必须**先脱敏再截断**:截断若落在密钥中间,剩下的半截既对不上已知值、也可能短到不像通用形态。
 */
export function scrubSecrets(text: string, apiKey?: string): string {
  let out = text;
  // 这里只处理上游诊断,宁可多抹:原样与 JSON 转义两种形态都抹,短密钥也不讲整词边界
  // (上游会把它拼进 invalid_<key> 这类标识)。正文类文本仍走 maskKnownSecret 的整词规则。
  if (apiKey) for (const form of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])) out = out.split(form).join("***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1***");
  return out;
}

/** 上游错误体:能解析就先逐个字符串值抹密钥再序列化;先抹后截断,截断切不出密钥前缀。 */
function scrubBody(raw: string, apiKey: string): string {
  try { return scrubValue(JSON.parse(raw), apiKey); } catch { return scrubSecrets(raw, apiKey); }
}

function scrubValue(value: unknown, apiKey: string): string {
  return scrubSecrets(JSON.stringify(value, (_k, v: unknown) => typeof v === "string" ? scrubSecrets(v, apiKey) : v) ?? "", apiKey);
}

/** 远程访问模式下、地址是 https 公网域名写法(页面只能填这一种)→ 连接时只连公网地址 */
export function publicOnlyByDefault(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VRA_REMOTE === "1" && remotePageBaseUrlError(url) === null;
}

/** 和页面对话那边同一句替换文字 */
const KEY_MASK = "[已移除:你的 API key]";

/**
 * 成功回复里回显的本次 key 一律抹掉(Codex 审计 2026-10-09 A3)。
 * 回复会显示在页面、写进研究产物与资料草稿,也能被「存入沉淀」写进台账 —— 所有模型 API 调用都经过这里,在这里守一次。
 * 短 key 只抹独立出现的整段(maskKnownSecret 的整词规则),不在正常文字里误伤。
 */
function scrubReply(message: ChatMessage, apiKey: string): ChatMessage {
  if (!apiKey) return message;
  // 原样和 JSON 转义两种形态都抹:key 里有引号 / 反斜杠时,回显在 JSON 里的是转义后的样子
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  const m = (s: string) => {
    const out = maskKnownSecret(s, apiKey, KEY_MASK);
    return escaped === apiKey ? out : maskKnownSecret(out, escaped, KEY_MASK);
  };
  return {
    ...message,
    ...(typeof message.content === "string" ? { content: m(message.content) } : {}),
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: m(message.reasoning_content) } : {}),
    ...(Array.isArray(message.tool_calls) ? {
      tool_calls: message.tool_calls.map((tc) => (tc?.function && typeof tc.function.arguments === "string"
        ? { ...tc, function: { ...tc.function, arguments: scrubArgs(tc.function.arguments, m) } } : tc)),
    } : {}),
  };
}

/**
 * 工具参数:**先解码再抹**,再编码回去。
 * 🔴 参数是 JSON 文本,key 里有引号时回显的是转义形态(`audit\"secret…`),按原文替换找不到;
 *    下游 JSON.parse 一解开就是完整 key,被写进报告(Codex 审计第三轮 A3)。没有要抹的就原样返回,不改写参数文本。
 */
function scrubArgs(raw: string, m: (s: string) => string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return m(raw); }   // 不是合法 JSON:下游也解不开,按文本抹
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") { const s = m(v); if (s !== v) changed = true; return s; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => { const k2 = m(k); if (k2 !== k) changed = true; return [k2, walk(x)]; }));
    }
    return v;
  };
  const out = walk(parsed);
  return changed ? JSON.stringify(out) : raw;
}

/**
 * 把 Base URL 与端点路径拼成完整请求地址。
 * 🔴 Base URL 按约定只填**根地址**(如 https://api.minimaxi.com/v1),`chat/completions` 由这里补 ——
 *    但用户常把服务商文档里的**完整端点**整条贴进来;再拼一次就成了 …/chat/completions/chat/completions,
 *    服务端只会回 404,界面上却显示"模型名不对 / 上下文过长"那种误导文案(MiniMax-M3 实测)。
 *    Base URL 已经以这段路径结尾就不再重复拼接。
 */
function joinUrl(baseURL: string, pathname: string): string {
  const base = baseURL.replace(/\/+$/, "");
  const path = pathname.replace(/^\/+/, "");
  // 大小写不敏感:有些网关回显 /Chat/Completions 这类写法
  return base.toLowerCase().endsWith(`/${path.toLowerCase()}`) ? base : `${base}/${path}`;
}

/**
 * 发一轮 Chat Completions。
 *
 * 失败一律抛 `DirectTransportError`,并带上**能不能重试**的判断 ——
 * 让调用方决定退避策略,而不是在这里偷偷重试(偷偷重试会让一次超时变成三次计费,
 * 而且工具调用可能已经在服务端执行过了)。
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatReply> {
  const url = joinUrl(req.baseURL, "chat/completions");
  const body: Record<string, unknown> = { model: req.model, messages: req.messages };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: t }));
    body.tool_choice = "auto";
  }
  if (req.responseFormat) body.response_format = req.responseFormat;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(1_000, req.timeoutMs));
  // 外部取消与超时取消合并:任一触发都要停
  const onExternalAbort = () => timeout.abort();
  req.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (req.signal?.aborted) timeout.abort();

  const startedAt = Date.now();
  const headers = { "content-type": "application/json", authorization: `Bearer ${req.apiKey}` };
  const publicOnly = req.publicOnly ?? publicOnlyByDefault(url);
  let res: Response;
  let raw: string;
  try {
    res = publicOnly
      // 远程模式:写法检查管不到解析结果(公网域名可以解析到内网),在连接时逐个地址查(Codex 审计 2026-10-09 A1)
      ? await publicOnlyPost(url, { headers, body: JSON.stringify(body), signal: timeout.signal })
      : await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
        // 不跟随跳转:地址校验(远程分享页只收公网 HTTPS)只看填写的那一跳,跟随会把请求带到回环 / 内网。
        redirect: "manual",
      });
    // 跳转一拿到响应头就判定,不等响应体:跳转的响应体挂住或中途断开时,先读体会把它报成"可重试的超时 / 网络错误",
    // 用户拿不到"填最终地址"的提示,研究编排还会照着补跑(Codex 复审 R3-3)。
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      res.body?.cancel().catch(() => { /* 响应体不要了;取消失败不影响报错 */ });
      throw new DirectTransportError("redirect",
        `模型端点返回了跳转(${res.status}),未跟随;请填写最终的 Chat Completions 地址`, res.status, false);
    }
    // Headers alone are not completion: keep timeout and cancellation attached
    // until the entire response body has been consumed.
    raw = await res.text();
  } catch (e) {
    if (e instanceof DirectTransportError) throw e;
    if ((e as { code?: unknown } | null)?.code === NON_PUBLIC_CODE) {
      throw new DirectTransportError("forbidden_address",
        `模型地址不是公网地址,远程访问模式下不允许连接:${scrubSecrets(e instanceof Error ? e.message : String(e), req.apiKey)}`, null, false);
    }
    const aborted = timeout.signal.aborted;
    const detail = scrubSecrets(e instanceof Error ? e.message : String(e), req.apiKey);
    throw new DirectTransportError(
      aborted ? (req.signal?.aborted ? "cancelled" : "timeout") : "network_error",
      aborted
        ? (req.signal?.aborted ? "请求已被取消" : `请求超时(${req.timeoutMs} 毫秒):${detail}`)
        : `无法连接模型端点:${detail}`,
      null,
      !req.signal?.aborted,   // 用户主动取消不重试;超时与网络错误可以
    );
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onExternalAbort);
  }

  const durationMs = Date.now() - startedAt;
  if (!res.ok) {
    // 429 与 5xx 值得退避重试;4xx 多是参数 / 密钥问题,重试只会重复烧钱
    const retryable = res.status === 429 || res.status >= 500;
    throw new DirectTransportError("http_error",
      `模型端点返回 ${res.status}:${scrubBody(raw, req.apiKey).slice(0, ERROR_BODY_CAP)}`,
      res.status, retryable);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new DirectTransportError("bad_json",
      `模型端点返回的不是合法 JSON:${scrubBody(raw, req.apiKey).slice(0, ERROR_BODY_CAP)}`, res.status, true);
  }

  const doc = parsed as { choices?: { message?: ChatMessage; finish_reason?: string }[]; usage?: Record<string, number>; error?: unknown };
  // 有些兼容端点用 200 + error 体表示失败 —— 不认这一层就会把错误当成空回复
  if (doc.error) {
    throw new DirectTransportError("upstream_error",
      `模型端点报错:${scrubValue(doc.error, req.apiKey).slice(0, ERROR_BODY_CAP)}`, res.status, false);
  }
  const choice = doc.choices?.[0];
  if (!choice?.message) {
    throw new DirectTransportError("empty_choice",
      `模型端点没有返回任何回复(choices 为空):${scrubBody(raw, req.apiKey).slice(0, 200)}`, res.status, true);
  }
  return {
    message: scrubReply(choice.message, req.apiKey),
    finishReason: choice.finish_reason ?? null,
    usage: doc.usage ?? null,
    durationMs,
  };
}
