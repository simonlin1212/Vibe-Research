/**
 * 用户模型配置的**唯一存放处**（当前浏览器配置的 localStorage）。
 * 它会随浏览器配置持久保存在本机磁盘，**不是系统钥匙串，也不承诺加密**；但不会写入
 * 产品仓库、后端配置、日志、事件账本或研究产物。共享电脑上使用后应主动清除。
 *
 * 🔴 单独成一个模块，是为了让**传输层 `backend.chat` 自己**就能读到它 ——
 *    放在 `llm.ts` 里会与 `backend.ts` 形成循环依赖，于是只能由调用方逐个记得传，
 *    而**记不住就是默认行为**：实测里 Agent 面板（`FinanceAiDock`）与 `agents.ts`
 *    两条最常用的路都没传，用户在界面上选的模型根本没生效 —— 对话照常成功、
 *    照常有答案，只是出自另一家，**界面上一个字都看不出来**。
 *    ⇒ 防线只守住三个入口里的一个，就等于没有防线。
 */

/** 用户自己那一份存在这儿 */
export const LLM_KEY = "vr-llm";

export interface LlmConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export type ExecutionMode = "agent" | "direct";

export interface AiRuntimeConfig {
  schemaVersion: 2;
  source: LlmConfig;
  executionMode: ExecutionMode;
  /** M24 distinguishes an explicit choice from the previous automatic Agent default. */
  modePreferenceVersion?: 1;
  directSupported: boolean;
  directReason: string;
}

export interface AiRuntimeRead {
  status: LlmStatus;
  config: AiRuntimeConfig | null;
}

/** CLI 订阅档：用本机已登录的引擎，免 API key */
const isCli = (p: string): boolean => p.startsWith("cli-");

/**
 * 这份配置**后端收不收**。
 *
 * 🔴 口径必须与 `orchestrator/src/runtime_provider.ts` 一致。两边各判一半的后果是分岔的：
 *    前端严一点 ⇒ 明明能用的配置被判「坏了」（`cli-codex` 不填 model、模板只填 provider+key
 *    都属此列，后端接受得好好的）；前端松一点 ⇒ 用户看到"已配置"、一提问才报错。
 *    （Codex 复审 r3 指出，实跑两端确认过。）
 * ⚠️ 只判**形状**，不判 provider 认不认识 —— 那是后端的事，它给的错误码更可行动。
 */
function isUsable(c: LlmConfig): boolean {
  if (!c.provider) return false;
  if (isCli(c.provider)) return true;                                   // 订阅档：免 key，模型由登录态定
  if (c.provider === "openai-compatible" || c.provider === "custom") {
    return Boolean(c.baseURL && c.apiKey);                              // 自填端点：端点 + key 必给，model 可空
  }
  return Boolean(c.apiKey);                                             // 产品模板：key 必给，baseURL / model 可从模板取
}

/**
 * 本地这份配置的状态。
 *
 * 🔴 **三种情况必须分开**，不能都返回 null：
 *    - `none`（真没配）要回到“接入 AI”，不能让后端默认替用户做选择；
 *    - `broken`（存着但读不懂 / 字段不全）当没配 = **静默换一家去打**，
 *      对话照常有答案，用户完全看不出自己选的模型没生效；
 *    - `unavailable`（隐私模式、存储被策略拒绝）同理，而且每次打开都会重演。
 *    （Codex 审计 r2 P2，核实属实。）
 */
export type LlmStatus = "none" | "ok" | "broken" | "unavailable";

export interface LlmRead {
  status: LlmStatus;
  config: LlmConfig | null;
}

export function readAiRuntime(): AiRuntimeRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LLM_KEY);
  } catch {
    return { status: "unavailable", config: null };
  }
  if (!raw) return { status: "none", config: null };
  try {
    const parsed = JSON.parse(raw) as Partial<LlmConfig> & Partial<AiRuntimeConfig>;
    // 旧配置默认普通对话；只有 M24 后明确开启才使用 Agent。
    // 只在用户下次保存时才写回 v2，避免打开页面就修改密钥存储。
    const c = parsed.schemaVersion === 2 && parsed.source && typeof parsed.source === "object"
      ? parsed.source as Partial<LlmConfig>
      : parsed;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const cfg: LlmConfig = {
      provider: str(c.provider), baseURL: str(c.baseURL), apiKey: str(c.apiKey), model: str(c.model),
    };
    const directSupported = parsed.schemaVersion === 2 && parsed.directSupported === true;
    const directReason = parsed.schemaVersion === 2 && typeof parsed.directReason === "string"
      ? parsed.directReason : "请重新测试连接后查看直连能力";
    const executionMode: ExecutionMode = parsed.schemaVersion === 2 && parsed.modePreferenceVersion === 1 && parsed.executionMode === "agent"
      ? "agent"
      : "direct";
    return isUsable(cfg)
      ? { status: "ok", config: { schemaVersion: 2, modePreferenceVersion: 1, source: cfg, executionMode, directSupported, directReason } }
      : { status: "broken", config: null };
  } catch {
    return { status: "broken", config: null };
  }
}

export function readUserLlm(): LlmRead {
  const runtime = readAiRuntime();
  return { status: runtime.status, config: runtime.config?.source ?? null };
}

/** 用户自己配的那一份（没配 / 坏了都返回 null）。**要分清哪种，用 `readUserLlm`。** */
export function loadUserLlm(): LlmConfig | null {
  return readUserLlm().config;
}

/** 存不下时抛错 —— 静默失败会让用户以为配好了，下次打开又是空的 */
export function saveUserLlm(cfg: LlmConfig, capability?: { directSupported: boolean; directReason: string }): void {
  const previous = readAiRuntime().config;
  const sameSource = previous && (["provider", "baseURL", "apiKey", "model"] as const)
    .every(key => (previous.source[key] ?? "") === (cfg[key] ?? ""));
  const directSupported = capability?.directSupported ?? false;
  const directReason = capability?.directReason ?? "请重新测试连接后查看直连能力";
  const serialized = JSON.stringify({
    schemaVersion: 2, source: cfg,
    // 新连接默认普通对话，不继承上一来源的 Agent 开关。能力标记仍仅代表 API 直连验证。
    executionMode: sameSource ? previous.executionMode : "direct", modePreferenceVersion: 1,
    directSupported, directReason,
  } satisfies AiRuntimeConfig);
  localStorage.setItem(LLM_KEY, serialized);
  if (localStorage.getItem(LLM_KEY) !== serialized) throw new Error("AI 配置未能保存在当前浏览器，请检查存储权限后重试");
  notifyRuntimeChanged();
}

/** 切换执行方式只改同一份配置，不复制 API key。 */
export function saveExecutionMode(executionMode: ExecutionMode): void {
  const current = readAiRuntime();
  if (current.status !== "ok" || !current.config) throw new Error("请先连接 AI");
  if (executionMode !== "agent" && executionMode !== "direct") throw new Error("无效的 Agent 开关值");
  localStorage.setItem(LLM_KEY, JSON.stringify({ ...current.config, executionMode } satisfies AiRuntimeConfig));
  notifyRuntimeChanged();
}

/**
 * 清除。**失败要抛**，并且**回读确认**真的没了。
 * 🔴 吞掉异常的话，界面会说"已清除"，而旧 key 还躺在 localStorage 里、
 *    下一次提问照样被发出去 —— 界面说的和事实相反，这比报错难查得多。
 */
export function clearUserLlm(): void {
  localStorage.removeItem(LLM_KEY);
  if (localStorage.getItem(LLM_KEY) !== null) throw new Error("本地存储没能删掉这条配置");
  notifyRuntimeChanged();
}

export const AI_RUNTIME_CHANGED = "vibe-research:ai-runtime-changed";

function notifyRuntimeChanged(): void {
  if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
    globalThis.dispatchEvent(new CustomEvent(AI_RUNTIME_CHANGED));
  }
}
