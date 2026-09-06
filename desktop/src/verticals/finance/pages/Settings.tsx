import { Check, Cpu, Database, KeyRound, LoaderCircle, ShieldCheck, Sparkles, Terminal, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { backend, friendlyAgentError, type LocalAgentStatus, type ProductInfo } from "@/lib/backend";
import { API_MODELS, PROVIDER_BASE, SUBSCRIPTION_MODELS, isCliProvider, providerOfModel, type ProviderId } from "@/lib/ai-models";
import { clearLlm, loadUserLlm, saveLlm } from "@/lib/llm";
import { saveExecutionMode } from "@/lib/llmStore";
import { useAiRuntime } from "@/hooks/useAiRuntime";

/**
 * 「接入 AI」—— Agent 运行时是产品的一部分；用户只在这里选择模型、填自己的 key。
 *
 * 🔴 口径与开源版 Vibe-Research 对齐（那一份经过真实用户验证）：
 *    配置**只存本地 localStorage**，随请求发给**本机**后端，后端拼进临时 env 交给引擎。
 *    **配置文件 / 日志 / 账本一个字节都碰不到。**
 *
 * ⚠️ 上一版这页是**只读**的，理由是"密钥只从环境变量读"。那在终端里启动没问题，
 *    但浏览器 UI 里没有可操作的接入入口。现在浏览器产品只认用户明确保存的配置，
 *    不会在未选择时回落到后端默认模型。
 *
 * 🔴 **订阅档免 key**：用产品自带引擎的登录态，一个字都不用填 —— 浏览器端的首选。
 */

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/40 py-2 text-sm last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
      <span className={mono ? "min-w-0 flex-1 break-all font-mono text-xs" : "min-w-0 flex-1 break-all"}>{v}</span>
    </div>
  );
}

const INPUT = "w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm";

function localRuntimeLabel(provider?: string): string {
  if (provider === "cli-claude") return "Claude Code Agent";
  if (provider === "cli-codebuddy") return "WorkBuddy / CodeBuddy Agent";
  return "Codex Harness";
}

/** 保存 / 清除 / 提示 —— 两档共用，分开写迟早只改一边 */
function ActionRow(
  { onSave, configured, onForget, msg, msgErr, busy }:
  { onSave: () => void | Promise<void>; configured: boolean; onForget: () => void; msg: string; msgErr: string; busy: boolean },
) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button onClick={onSave} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:cursor-wait disabled:opacity-60">
        {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
        {busy ? "正在实测连接…" : "测试并保存"}
      </button>
      {configured && (
        <button onClick={onForget}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-destructive">
          <Trash2 className="h-4 w-4" /> 清除
        </button>
      )}
      {msg && <span className="text-xs text-primary">{msg}</span>}
      {msgErr && <span className="text-xs text-destructive">{msgErr}</span>}
    </div>
  );
}

export function Settings() {
  const runtime = useAiRuntime();
  const [info, setInfo] = useState<ProductInfo | null>(null);
  const [agents, setAgents] = useState<LocalAgentStatus[]>([]);
  const [err, setErr] = useState("");
  const [agentErr, setAgentErr] = useState("");
  const existing = loadUserLlm();
  const existingIsCli = existing ? isCliProvider(existing.provider) : false;

  const [mode, setMode] = useState<"subscription" | "api">(existing && !existingIsCli ? "api" : "subscription");
  const existingCliId = existing && existingIsCli && SUBSCRIPTION_MODELS.some((x) => x.id === existing.model)
    ? existing.model : (SUBSCRIPTION_MODELS[0]?.id ?? "");
  const [cliId, setCliId] = useState(existingCliId);
  const first = API_MODELS[0]!;   // 清单是编译期常量,非空
  const [apiId, setApiId] = useState(existing && !existingIsCli ? existing.model : first.id);
  const [baseURL, setBaseURL] = useState(existing && !existingIsCli ? existing.baseURL : (PROVIDER_BASE[first.provider] ?? ""));
  const [modelName, setModelName] = useState(existing && !existingIsCli ? existing.model : first.id);
  const [apiKey, setApiKey] = useState(existing && !existingIsCli ? existing.apiKey : "");
  const [configured, setConfigured] = useState(Boolean(existing));
  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [startingLogin, setStartingLogin] = useState(false);
  const refreshTail = useRef<Promise<void>>(Promise.resolve());

  const refreshAgents = useCallback((): Promise<void> => {
    // 初次检测、点击登录后的刷新、自动轮询全部排进同一条队列；任何旧请求都不能晚回来覆盖新状态。
    const run = refreshTail.current.catch(() => { /* 上一轮失败不阻塞下一轮 */ }).then(async () => {
      try {
        setAgents(await backend.localAgents());
        setAgentErr("");
      } catch (e) {
        setAgentErr(e instanceof Error ? e.message : String(e));
      }
    });
    refreshTail.current = run;
    return run;
  }, []);

  useEffect(() => {
    backend.product()
      .then(setInfo)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (!agents.some((x) => x.status === "login_pending")) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      // 串行等待本轮探针结束再排下一轮；探针最慢数秒，setInterval 会并发堆积 CLI 子进程。
      await refreshAgents();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [agents, refreshAgents]);

  const agentOf = (provider: ProviderId) => agents.find((x) => x.provider === provider);

  /**
   * 这一家的**兼容矩阵状态**（由后端下发，前端不写死一份）。
   * 🔴 "目录里有这份模板" ≠ "跑过矩阵"：6 份模板里只有 2 份真跑过，
   *    按文件存在来标会在界面上造出 4 条**假的「已实测」**。
   */
  const RAN = new Set(["baseline", "pass", "partial"]);
  const matrixOf = (pv: ProviderId): string => info?.provider_templates?.[pv] ?? "";
  const tag = (pv: ProviderId): string => {
    const st = matrixOf(pv);
    if (!st) return "";
    if (st === "partial") return "（已实测·部分项不支持）";
    return RAN.has(st) ? "（已实测）" : "（有模板·未实测）";
  };
  const pickApi = (id: string) => {
    const m = API_MODELS.find((x) => x.id === id);
    if (!m) return;
    setApiId(id); setModelName(id); setBaseURL(PROVIDER_BASE[m.provider] ?? "");
    setMsg(""); setMsgErr("");
  };

  const say = (ok: string) => { setMsg(ok); setMsgErr(""); };
  const oops = (bad: string) => { setMsg(""); setMsgErr(bad); };

  const apiConfig = () => {
    if (!modelName.trim()) return oops("Model 不能空");
    if (!apiKey.trim()) return oops("API Key 不能空");
    const pv = providerOfModel(apiId);
    if (!baseURL.trim() && pv === "openai-compatible") return oops("自填端点必须给出 Base URL");
    if (/[{<][A-Za-z_]/.test(baseURL)) return oops("Base URL 里还有占位符没替换（把 {…} 换成你自己的值）");
    return { provider: pv, baseURL: baseURL.trim(), apiKey: apiKey.trim(), model: modelName.trim() };
  };

  const testAndSaveApi = async () => {
    const cfg = apiConfig();
    if (!cfg) return;
    setTesting(true); setMsg(""); setMsgErr("");
    try {
      const probe = await backend.llmProbe(cfg);
      saveLlm(cfg, { directSupported: probe.direct_supported, directReason: probe.direct_reason });
      setConfigured(true); say("连接成功。Vibe Research Agent 已默认开启，可以直接使用。");
    } catch (e) {
      oops(friendlyAgentError(e));
    } finally { setTesting(false); }
  };

  const testAndSaveCli = async () => {
    const m = SUBSCRIPTION_MODELS.find((x) => x.id === cliId);
    const detected = m ? agentOf(m.provider) : undefined;
    if (!m || !detected?.available) return oops(detected?.detail ?? (agentErr || "这台机器还没有检测到可用的本地 Agent"));
    const cfg = { provider: m.provider, baseURL: "", apiKey: "", model: m.id };
    setTesting(true); setMsg(""); setMsgErr("");
    try {
      const probe = await backend.llmProbe(cfg);
      saveLlm(cfg, { directSupported: probe.direct_supported, directReason: probe.direct_reason });
      setConfigured(true); say(`「${m.name}」连接成功。Vibe Research Agent 已默认开启。`);
    } catch (e) { oops(friendlyAgentError(e)); }
    finally { setTesting(false); }
  };

  const loginCodex = async () => {
    setStartingLogin(true); setMsg(""); setMsgErr("");
    try {
      const result = await backend.startCodexLogin();
      setCliId("codex");
      say(result.state === "pending" ? "登录窗口已经打开，请在浏览器完成授权" : "已打开 Codex 官方登录页，请在浏览器完成授权");
      await refreshAgents();
    } catch (e) { oops(friendlyAgentError(e)); }
    finally { setStartingLogin(false); }
  };

  const forget = () => {
    // 🔴 清不掉要说出来：吞掉异常的话界面写"已清除"、旧 key 还在，下一次提问照样发出去
    try {
      clearLlm();
      setApiKey(""); setConfigured(false); say("已清除。再次使用 AI 功能前需要重新连接。");
    } catch (e) { oops(e instanceof Error ? e.message : String(e)); }
  };

  useAiPage({
    key: "settings",
    title: "接入 AI",
    // 🔴 **只放模型的名字，绝不放 key**。这段 context 会随提问发出去 ——
    //    把密钥拼进来等于用户在这一页填的东西被原样送进对话历史。
    context:
      (configured
        ? `用户自己配的模型：${mode === "subscription" ? cliId : modelName}（provider ${mode === "subscription" ? providerOfModel(cliId) : providerOfModel(apiId)}）。`
        : "用户还没连接 AI。") +
      (info
        ? `后端默认：provider ${info.provider.name}｜模板 ${info.provider.profile ?? "—"}｜` +
          `协议 ${info.provider.wire_api}｜鉴权 ${info.provider.auth}｜密钥变量 ${info.provider.env_key} ` +
          `${info.provider.key_present ? "已设置" : "未设置"}｜默认模型 ${String(info.defaults.model ?? "—")}｜产品版本 ${info.version}`
        : "还没读到后端配置。"),
    suggestions: ["Agent 运行时和模型有什么区别", "我现在用的是哪个模型", "我的 key 会被发到哪里"],
  });

  const runtimeState = info
    ? { label: "本地 API 已连接", cls: "border-success/25 bg-success/[0.08] text-success" }
    : err
      ? { label: "本地 API 未连接", cls: "border-destructive/25 bg-destructive/[0.08] text-destructive" }
      : { label: "正在检测", cls: "border-border bg-muted/40 text-muted-foreground" };
  const selectedRuntime = !configured
    ? "等待连接 AI"
    : localRuntimeLabel(runtime.config?.source.provider);
  const localSubscriptionRuntime = configured && ["cli-claude", "cli-codebuddy"].includes(runtime.config?.source.provider ?? "");
  const localRuntimeName = runtime.config?.source.provider === "cli-codebuddy" ? "WorkBuddy / CodeBuddy" : "Claude Code";
  const runtimeFeatures = localSubscriptionRuntime
    ? [
        { icon: Terminal, title: "本地对话", text: `使用 ${localRuntimeName} 登录账号` },
        { icon: Wrench, title: "受控工具", text: "六阶段只开放产品 MCP" },
        { icon: Database, title: "完整研究", text: "支持 A 股六阶段流程" },
        { icon: ShieldCheck, title: "证据纪律", text: "产物经过校验与红线" },
      ]
    : [
        { icon: Terminal, title: "本地任务", text: "任务状态留在本机" },
        { icon: Wrench, title: "工具调用", text: "自动调用数据与计算" },
        { icon: Database, title: "长期上下文", text: "可以继续追问和迭代" },
        { icon: ShieldCheck, title: "证据纪律", text: "结果经过校验与红线" },
      ];
  const changeExecutionMode = (next: "agent" | "direct") => {
    try {
      saveExecutionMode(next);
      say(next === "agent" ? "Vibe Research Agent 已开启" : "已切换为模型直连。深度研究和工具任务会提示重新开启 Agent。");
    } catch (e) { oops(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div>
      <PageHeader
        title="接入 AI"
        subtitle="第一步只需连接订阅或 API。连接后默认使用 Agent，不必再做技术选择。"
      />

      {!configured && <GlassCard glow className="mb-5 border-primary/35 bg-primary/[0.06]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">首次使用</p>
        <h2 className="mt-1 text-xl font-extrabold">先连接 AI</h2>
        <p className="mt-1 text-sm text-muted-foreground">有 Codex、Claude Code 或 WorkBuddy / CodeBuddy 就选订阅接入；只有模型 API 就选 API 接入。连接一次，以后直接使用。</p>
      </GlassCard>}

      {err && (
        <GlassCard className="border-destructive/40">
          <p className="text-sm text-destructive">读不到后端配置:{err}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            先把编排器 API 起起来:<span className="font-mono">node orchestrator/src/api.ts --port 8765</span>
          </p>
        </GlassCard>
      )}

      {/* 第一张卡只解决“AI 从哪里来”。 */}
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">AI Source</p>
          <h2 className="mt-1 text-lg font-bold">一、连接 AI</h2>
        </div>
        <span className="text-xs text-muted-foreground">订阅登录或自带 API key</span>
      </div>
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>
          API key <b className="text-foreground">只保存在这台机器的浏览器里</b>，提问时经<b className="text-foreground">本机</b>后端转给你选定的模型服务商，
          用完即弃 —— 不进入本产品的配置文件、日志、台账或仓库。
        </span>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <button type="button" onClick={() => setMode("subscription")} aria-pressed={mode === "subscription"}
          className={`glass p-5 text-left ${mode === "subscription" ? "ring-1 ring-primary/60" : "hover:border-primary/40"}`}>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">订阅接入</h3>
            {mode === "subscription" && <Check className="ml-auto h-4 w-4 text-primary" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            自动检测本机已经安装并登录的 Agent，走对应订阅额度，<b className="text-foreground">免 API key</b>。
          </p>
        </button>

        <button type="button" onClick={() => setMode("api")} aria-pressed={mode === "api"}
          className={`glass p-5 text-left ${mode === "api" ? "ring-1 ring-primary/60" : "hover:border-primary/40"}`}>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">API 接入</h3>
            {mode === "api" && <Check className="ml-auto h-4 w-4 text-primary" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            填自己的 key：DeepSeek / MiMo / 智谱 / Kimi / 通义 / OpenAI / 任意兼容端点。
          </p>
        </button>
      </div>

      <GlassCard className="mb-4">
        {mode === "subscription" ? (
          <div className="space-y-3 text-sm">
            <p className="text-xs leading-relaxed text-muted-foreground">
              状态来自本机实时检测，不再写死“已登录”。Codex、Claude Code 与 WorkBuddy / CodeBuddy 都会由各自的真实 CLI 作答，
              <b className="text-foreground">不会悄悄换成别家</b>。Qwen Code 当前需 API key / Coding Plan，DeepSeek CLI 也需 API key，放在右侧 API 接入。
            </p>
            <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              已安装并登录 WorkBuddy 桌面版时会直接识别，不需要重复安装或登录 CLI；独立使用 CodeBuddy Code 的用户也可沿用现有 CLI 登录。
            </p>
            <p className="rounded-lg border border-warning/25 bg-warning/[0.05] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Claude Code 与 WorkBuddy / CodeBuddy 可运行对话、有界材料任务和 A 股六阶段研究；研究阶段只开放产品受控 MCP。选择后不会暗中换成 Codex。
            </p>
            {agentErr && <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">本机 Agent 状态检测失败：{agentErr}</p>}
            <div className="grid gap-2 sm:grid-cols-3">
              {SUBSCRIPTION_MODELS.map((m) => {
                const on = cliId === m.id;
                const detected = agentOf(m.provider);
                const disabled = !detected?.available;
                const badge = detected?.status === "ready" ? "可用"
                  : detected?.status === "login_pending" ? "等待授权"
                    : detected?.status === "login_failed" ? "登录未完成"
                  : detected?.status === "not_authenticated" ? "未登录"
                    : detected?.status === "not_installed" ? "未安装"
                      : detected?.status === "probe_failed" || agentErr ? "检测失败" : "检测中";
                return (
                  <button key={m.id} disabled={disabled} onClick={() => { setCliId(m.id); setMsg(""); setMsgErr(""); }}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      disabled ? "cursor-not-allowed border-border/50 opacity-55"
                        : on ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted/40"}`}>
                    <Terminal className={`h-4 w-4 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium">
                        {m.name}
                        <span className={`rounded px-1 py-0.5 text-[9px] ${detected?.available ? "bg-success/15 text-success" : "bg-muted/60 text-muted-foreground"}`}>{badge}</span>
                        {on && <Check className="h-3.5 w-3.5 text-primary" />}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{m.description}</div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={detected?.detail}>
                        {detected?.version ?? detected?.detail ?? "正在读取本机状态"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {(() => {
              const codex = agentOf("cli-codex");
              if (codex?.status === "ready") return null;
              const pending = codex?.status === "login_pending";
              return (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.05] p-3">
                  <button onClick={loginCodex} disabled={startingLogin || pending || codex?.status === "not_installed"}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60">
                    {(startingLogin || pending) && <LoaderCircle className="h-4 w-4 animate-spin" />}
                    {pending ? "等待浏览器授权…" : "登录 Codex"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {pending ? "授权完成后本页会自动检测，无需刷新。" : "将打开 Codex 官方登录页，使用 ChatGPT 订阅授权；不需要 API key。"}
                  </span>
                </div>
              );
            })()}
            {(() => {
              const codebuddy = agentOf("cli-codebuddy");
              if (codebuddy?.status === "ready") return null;
              const help = codebuddy?.status === "not_authenticated"
                ? <>已检测到 CodeBuddy，但没有可用登录态：WorkBuddy 用户请打开应用完成登录；独立 CLI 用户请运行 <span className="font-mono">codebuddy</span> 登录。</>
                : codebuddy?.status === "not_installed"
                  ? <>尚未检测到 WorkBuddy 或 CodeBuddy Code：安装并登录 WorkBuddy 桌面版即可；也可运行 <span className="font-mono">npm install -g @tencent-ai/codebuddy-code</span> 安装腾讯官方 CLI。</>
                  : codebuddy?.status === "probe_failed"
                    ? <>已检测到 WorkBuddy / CodeBuddy，但当前版本无法建立受限连接：请先更新 WorkBuddy 或官方 CLI。</>
                    : <>正在检测本机 CodeBuddy 状态…</>;
              return (
                <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {help}
                </p>
              );
            })()}
            <ActionRow onSave={testAndSaveCli} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} busy={testing} />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">选择模型</label>
              <select value={apiId} onChange={(e) => pickApi(e.target.value)} className={INPUT}>
                {API_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{tag(m.provider)} —— {m.description}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {(() => {
                  const st = matrixOf(providerOfModel(apiId));
                  if (RAN.has(st)) return "产品跑过这一家的兼容矩阵：协议 / 结构化产出 / 已知不兼容项都记在 providers/ 模板里。";
                  if (st) return "⚠️ 产品写好了这一家的模板，但**没有真跑过**兼容矩阵 —— 能不能用得你自己试。";
                  return "⚠️ 产品没有这一家的模板，按通用 OpenAI 兼容端点走 —— 端点必须支持 Responses API（引擎已不再支持 Chat Completions）。";
                })()}
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Base URL</label>
              <input value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="https://api.deepseek.com" className={`${INPUT} font-mono text-xs`} />
              {/* 百炼系模板留了占位让用户替换 —— 没替换后端会拒，这里先说清楚 */}
              {/[{<][A-Za-z_]/.test(baseURL) && (
                <p className="mt-1 text-[11px] text-destructive">把 {"{…}"} 换成你自己的值（百炼控制台里的 WorkspaceId）</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Model</label>
              <input value={modelName} onChange={(e) => { setModelName(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="模型名称" className={`${INPUT} font-mono text-xs`} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">API Key</label>
              <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="sk-…" className={`${INPUT} font-mono text-xs`} />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                为避免每次重填，key 会保存在当前浏览器的本机配置中；它不是系统钥匙串，也不承诺加密。
                只建议在可信的个人电脑使用，共享电脑用完请点击“忘记配置”。key 不进入仓库、后端配置、日志或研究产物。
              </p>
            </div>
            <ActionRow onSave={testAndSaveApi} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} busy={testing} />
          </div>
        )}
      </GlassCard>

      {/* 第二张卡只解决“是否使用 Agent”。默认开启，普通用户无需修改。 */}
      <div data-testid="agent-runtime-card">
        <GlassCard glow className="relative mb-5 overflow-hidden border-primary/25">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">Execution</p>
              <div className="mt-1.5 flex items-center gap-2">
                <Cpu className="h-5 w-5 text-primary" />
                <h2 className="text-xl font-extrabold tracking-tight">二、Vibe Research Agent</h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {localSubscriptionRuntime
                  ? `默认开启。${localRuntimeName} Agent 可承载本地对话、有界材料任务和 A 股六阶段研究；研究阶段只开放产品受控 MCP。`
                  : "默认开启。Agent 会维持上下文、调用本地数据和计算工具、完成多步研究，并保留可继续迭代的任务记录。"}
                当前运行时：<b className="text-foreground">{selectedRuntime}</b>。
              </p>
            </div>
            <button type="button" role="switch" aria-checked={runtime.config?.executionMode !== "direct"}
              disabled={!configured}
              onClick={() => changeExecutionMode(runtime.config?.executionMode === "direct" ? "agent" : "direct")}
              className={`relative h-8 w-14 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${runtime.config?.executionMode === "direct" ? "bg-muted" : "bg-primary"}`}>
              <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${runtime.config?.executionMode === "direct" ? "translate-x-1" : "translate-x-7"}`} />
              <span className="sr-only">切换 Agent</span>
            </button>
          </div>
          <div className="mt-4 rounded-xl border border-border/60 bg-background/30 p-3 text-xs leading-5 text-muted-foreground">
            {!configured ? (
              <><b className="text-foreground">等待连接 AI。</b> 连接成功后 Agent 会自动开启，不需要再做一次选择。</>
            ) : runtime.config?.executionMode === "direct" ? (
              <><b className="text-foreground">当前：模型直连。</b> 适合轻量对话和材料定位；六阶段研究、多空辩论、Agent 回测与需要工具的任务会要求重新开启 Agent。</>
            ) : localSubscriptionRuntime ? (
              <><b className="text-foreground">当前：{localRuntimeName} Agent 已开启。</b> 可进行对话、有界材料任务和 A 股六阶段研究；不会暗中换成 Codex。</>
            ) : (
              <><b className="text-foreground">当前：Agent 已开启（推荐）。</b> 所有能力都走完整工作流；模型只是提供推理能力。</>
            )}
            {configured && !runtime.config?.directSupported && <p className="mt-1 text-warning">当前 AI 来源不能关闭 Agent：{runtime.config?.directReason}</p>}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {runtimeFeatures.map(({ icon: Icon, title, text }) => <div key={title} className="rounded-xl border border-border/60 bg-background/25 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" />{title}</div>
              <p className="mt-1 text-[11px] text-muted-foreground">{text}</p>
            </div>)}
          </div>
          <div className="mt-3 flex justify-end"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${runtimeState.cls}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{runtimeState.label}</span></div>
        </GlassCard>
      </div>

      {info && (
        <details className="mb-4 rounded-xl border border-border/60 bg-card/20 p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">高级运行信息</summary>
          <div className="mt-3 space-y-4">
          <GlassCard>
            <div className="mb-3 flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">后端默认模型</h3>
              <span
                className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                  info.provider.key_present ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                }`}
              >
                {info.provider.key_present ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                {info.provider.key_present ? "凭据就绪" : "缺凭据"}
              </span>
            </div>
            <Row k="provider" v={info.provider.name} />
            <Row k="模板" v={info.provider.profile ?? "(未用模板)"} />
            <Row k="协议" v={info.provider.wire_api} />
            <Row k="端点" v={info.provider.base_url ?? "(官方默认)"} mono />
            <Row k="鉴权" v={info.provider.auth === "api_key" ? "API key(从环境变量读)" : "订阅登录态"} />
            <Row
              k="密钥来自"
              v={
                <span className="inline-flex items-center gap-1.5">
                  {/* 🔴 只说"设没设",不说"是什么" */}
                  <span className="font-mono text-xs">${info.provider.env_key}</span>
                  <span className="text-muted-foreground">{info.provider.key_present ? "· 已设置" : "· 未设置"}</span>
                </span>
              }
            />
            <Row k="默认模型" v={String(info.defaults.model ?? "(未指定)")} />
            {info.auth_error && <p className="mt-2 text-xs text-destructive">{info.auth_error}</p>}
          </GlassCard>

          <GlassCard>
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">要换成别的模型?</h3>
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>
                改 <span className="font-mono text-xs">.local/config.json</span> 里的{" "}
                <span className="font-mono text-xs">provider.profile</span>(可选模板在{" "}
                <span className="font-mono text-xs">providers/</span> 目录)
              </li>
              <li>在启动服务的那个 shell 里 <span className="font-mono text-xs">export</span> 该模板要求的环境变量</li>
              <li>重启服务;回到这一页看「凭据就绪」</li>
            </ol>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground/80">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              密钥不要写进配置文件 —— 配置文件会被读进产品,也可能被一起拷走。
            </p>
          </GlassCard>

          <GlassCard>
            <h3 className="mb-2 font-semibold">数据与路径</h3>
            <Row k="产品版本" v={info.version} />
            <Row k="数据根" v={info.paths.data_root} mono />
            <Row k="引擎 home" v={info.paths.codex_home} mono />
            <Row k="Python" v={info.paths.python} mono />
            <Row k="配置来源" v={info.sources.join("  ←  ")} mono />
          </GlassCard>
          </div>
        </details>
      )}

      <Disclaimer />
    </div>
  );
}
