import { Check, Cpu, Database, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { ApiError, backend, friendlyAgentError, type LocalAgentStatus, type ProductInfo } from "@/lib/backend";
import { API_MODELS, PROVIDER_BASE, SUBSCRIPTION_MODELS, apiPresetForSaved, isCliProvider, modelNameForPreset, providerOfModel, type ProviderId } from "@/lib/ai-models";
import { clearLlm, loadUserLlm, saveLlm } from "@/lib/llm";
import { LLM_KEY } from "@/lib/llmStore";
import { testAndSaveAi } from "@/lib/aiConnection";
import { EMPTY_MODEL_LIST, ModelListSession, type ModelListState } from "@/lib/modelList";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { UpdateSettingsCard } from "@/components/UpdateSettingsCard";
import { SecContactCard } from "@/components/SecContactCard";

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
 * 🔴 **订阅档免 key**：用这台机器上用户自己装好、登录好的 Codex / Claude Code / WorkBuddy，一个字都不用填；
 *    登录发生在各自的 CLI 里，本页不代办登录、不读取也不保存它们的凭据。
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

function runtimeLabel(provider?: string): string {
  if (provider === "cli-codex") return "Codex Agent";
  if (provider === "cli-claude") return "Claude Code Agent";
  if (provider === "cli-codebuddy") return "WorkBuddy / CodeBuddy Agent";
  return "模型 API · 产品内置工具循环";
}

const VERIFICATION_TEXT: Record<string, string> = {
  verified: "已用真实 key 实测可用", unsupported: "实测不可用", untested: "有模板，还没用真实 key 实测",
};

/**
 * #50:WorkBuddy 装在自动检测找不到的盘或文件夹时,在这里填安装位置。
 * 保存在本机后台(数据目录里),对话、六阶段研究与体检都按它找;只认 WorkBuddy / CodeBuddy 的程序。
 */
function WorkBuddyLocation({ status, onSave }: { status: LocalAgentStatus | undefined; onSave: (path: string | null) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const custom = status?.custom_path === true;
  // 存着位置但程序已被移走 / 卸载:custom 为 false,也要能清除,否则这条失效记录永远清不掉
  const saved = status?.saved_path === true;
  if (!status || (status.status !== "not_installed" && status.status !== "probe_failed" && !custom && !saved)) return null;
  const submit = async (path: string | null) => {
    setBusy(true); setError("");
    try {
      await onSave(path);
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
      {custom || saved ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{custom ? "正在使用你指定的 WorkBuddy 位置。" : "你之前指定的 WorkBuddy 位置现在找不到程序了（可能已移动或卸载）。"}</span>
          <button onClick={() => void submit(null)} disabled={busy}
            className="rounded-md px-2 py-1 text-xs text-primary ring-1 ring-primary/30 hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60">
            恢复自动检测
          </button>
        </div>
      ) : (
        <p>
          WorkBuddy 装在别的盘或文件夹？把它的<b className="text-foreground">安装文件夹</b>填在这里。
          不知道在哪：右键桌面上的 WorkBuddy 图标，选「打开文件所在的位置」，复制地址栏里的路径。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input value={value} onChange={(e) => { setValue(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim() && !busy) void submit(value); }}
          placeholder={"例如 D:\\Program Files\\WorkBuddy"} aria-label="WorkBuddy 安装位置"
          className={`${INPUT} min-w-0 flex-1 font-mono text-xs`} />
        <button onClick={() => void submit(value)} disabled={busy || !value.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-xs font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-60">
          {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "正在检测…" : custom || saved ? "换成这个位置" : "保存并检测"}
        </button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

/** 获取到的模型列表:可搜索,点一行填进 Model */
function ModelPicker({ models, current, onPick }: { models: { id: string; name: string }[]; current: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? models.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)) : models;
  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-2">
      {models.length > 8 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`在 ${models.length} 个模型里搜索`}
          aria-label="搜索模型" className={`${INPUT} mb-2 py-1.5 text-xs`} />
      )}
      <div className="max-h-52 space-y-0.5 overflow-auto" role="listbox" aria-label="可用模型">
        {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">没有匹配的模型</p>}
        {shown.map((m) => {
          const on = m.id === current.trim();
          return (
            <button key={m.id} type="button" role="option" aria-selected={on} onClick={() => onPick(m.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs ${on ? "bg-primary/15 text-primary" : "hover:bg-muted/50"}`}>
              <span className="min-w-0 flex-1 truncate">{m.id}</span>
              {m.name !== m.id && <span className="truncate text-[10px] text-muted-foreground">{m.name}</span>}
              {on && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 保存 / 清除 / 提示 —— 两档共用，分开写迟早只改一边 */
function ActionRow(
  { onSave, configured, onForget, msg, msgErr, busy, detail }:
  { onSave: () => void | Promise<void>; configured: boolean; onForget: () => void; msg: string; msgErr: string; busy: boolean; detail?: string },
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
      {msgErr && detail && (
        <details open className="w-full rounded-lg border border-destructive/30 bg-destructive/[0.05] p-2.5 text-xs">
          <summary className="cursor-pointer font-medium text-destructive">错误详情（排查用）</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{detail}</pre>
          <p className="mt-1.5 text-[11px] text-muted-foreground">详情里的 API key 已被抹掉，可以放心截图或复制给别人看。</p>
        </details>
      )}
    </div>
  );
}

/** 报错的页面文案 + 排查明细。明细由后端给(已抹 key),拿不到时退回异常原文 */
function failureOf(e: unknown): { text: string; detail: string } {
  return { text: friendlyAgentError(e), detail: e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e) };
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
  const [apiId, setApiId] = useState(apiPresetForSaved(existing));
  const [baseURL, setBaseURL] = useState(existing && !existingIsCli ? existing.baseURL : (PROVIDER_BASE[first.provider] ?? ""));
  const [modelName, setModelName] = useState(existing && !existingIsCli ? existing.model : first.id);
  const [apiKey, setApiKey] = useState(existing && !existingIsCli ? existing.apiKey : "");
  const [configured, setConfigured] = useState(Boolean(existing));
  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState("");
  const [errDetail, setErrDetail] = useState("");
  // 获取模型列表的状态由 ModelListSession 管:清除配置 / 换地址时作废在途请求,旧结果回来也不再显示
  const [modelList, setModelList] = useState<ModelListState>(EMPTY_MODEL_LIST);
  const modelsSession = useRef<ModelListSession | null>(null);
  modelsSession.current ??= new ModelListSession(setModelList);
  useEffect(() => () => modelsSession.current?.reset(), []);
  const { loading: fetchingModels, models: fetchedModels, msg: modelsMsg, err: modelsErr, detail: modelsErrDetail } = modelList;
  const [testing, setTesting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const refreshTail = useRef<Promise<void>>(Promise.resolve());

  const refreshAgents = useCallback((): Promise<void> => {
    // 初次检测、「重新检测」、保存 WorkBuddy 位置全部排进同一条队列；任何旧请求都不能晚回来覆盖新状态。
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

  const agentOf = (provider: ProviderId) => agents.find((x) => x.provider === provider);

  const saveCodeBuddyPath = (path: string | null): Promise<void> => {
    // 排进检测队列:先发出的检测不能晚回来,把刚保存的结果盖掉
    const run = refreshTail.current.catch(() => { /* 上一轮失败不阻塞这一轮 */ }).then(async () => {
      const st = await backend.setCodeBuddyPath(path);
      setAgents((xs) => xs.some((x) => x.provider === st.provider) ? xs.map((x) => x.provider === st.provider ? st : x) : [...xs, st]);
      setAgentErr("");
    });
    refreshTail.current = run;
    return run;
  };

  /**
   * 这一家模板的**实测状态**（由后端下发，前端不写死一份）。
   * 🔴 "目录里有这份模板" ≠ "实测过"：按文件存在来标会在界面上造出**假的「已实测」**。
   */
  const verificationOf = (pv: ProviderId): string => info?.provider_templates?.[pv] ?? "";
  const tag = (pv: ProviderId): string => {
    const st = verificationOf(pv);
    if (!st) return "";
    if (st === "verified") return "（已实测）";
    if (st === "unsupported") return "（实测不可用）";
    if (st === "untested") return "（有模板·未实测）";
    return "（模板读不了）";
  };
  const pickApi = (id: string) => {
    const m = API_MODELS.find((x) => x.id === id);
    if (!m) return;
    setApiId(id); setModelName(modelNameForPreset(id)); setBaseURL(PROVIDER_BASE[m.provider] ?? "");
    setMsg(""); setMsgErr(""); setErrDetail(""); resetModels();
  };

  /** 换了来源 / 地址 / key、或清除了配置:取消在途请求,清空上一份模型列表与提示 */
  const resetModels = () => modelsSession.current?.reset();

  const say = (ok: string) => { setMsg(ok); setMsgErr(""); setErrDetail(""); };
  const oops = (bad: string, detail = "") => { setMsg(""); setMsgErr(bad); setErrDetail(detail); };

  const apiConfig = () => {
    if (!modelName.trim()) return oops("Model 不能空");
    if (!apiKey.trim()) return oops("API Key 不能空");
    const pv = providerOfModel(apiId);
    if (!baseURL.trim() && pv === "openai-compatible") return oops("自填端点必须给出 Base URL");
    if (/[{<][A-Za-z_]/.test(baseURL)) return oops("Base URL 里还有占位符没替换（把 {…} 换成你自己的值）");
    return { provider: pv, baseURL: baseURL.trim(), apiKey: apiKey.trim(), model: modelName.trim() };
  };

  /** 「获取可用模型」:按当前填的来源 / 地址 / key 问端点有哪些模型;只读,不保存任何配置 */
  const fetchModelList = async () => {
    const session = modelsSession.current!;
    const pv = providerOfModel(apiId);
    if (!apiKey.trim()) return session.fail("先填 API Key，才能向服务商获取模型列表");
    if (!baseURL.trim() && pv === "openai-compatible") return session.fail("自填端点必须先给出 Base URL");
    if (/[{<][A-Za-z_]/.test(baseURL)) return session.fail("Base URL 里还有占位符没替换（把 {…} 换成你自己的值）");
    const llm = { provider: pv, baseURL: baseURL.trim(), apiKey: apiKey.trim() };
    await session.start(llm.apiKey, (signal) => backend.llmModels(llm, signal), (e) => {
      const detail = e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e);
      // 旧版后端没有 /llm-models,回的是 404 "not found":别被收口成笼统的"没连接成功"
      if (e instanceof ApiError && e.code === "not found") {
        return { text: "本机后端还是旧版本，没有「获取模型」接口。请停掉 scripts/start 后重新启动，再刷新本页。", detail };
      }
      return { text: friendlyAgentError(e), detail };
    });
  };

  const testAndSaveApi = async () => {
    const cfg = apiConfig();
    if (!cfg) return;
    setTesting(true); setMsg(""); setMsgErr(""); setErrDetail("");
    try {
      await testAndSaveAi(cfg, { read: () => localStorage.getItem(LLM_KEY), probe: backend.llmProbe, save: saveLlm });
      setConfigured(true); say("连接成功。AI 会按问题需要联网搜索、取数和计算。");
    } catch (e) {
      const f = failureOf(e);
      oops(f.text, f.detail);
    } finally { setTesting(false); }
  };

  const testAndSaveCli = async () => {
    const m = SUBSCRIPTION_MODELS.find((x) => x.id === cliId);
    const detected = m ? agentOf(m.provider) : undefined;
    if (!m || !detected?.available) return oops(detected?.detail ?? (agentErr || "这台机器还没有检测到可用的本地 Agent"));
    const cfg = { provider: m.provider, baseURL: "", apiKey: "", model: m.id };
    setTesting(true); setMsg(""); setMsgErr(""); setErrDetail("");
    try {
      await testAndSaveAi(cfg, { read: () => localStorage.getItem(LLM_KEY), probe: backend.llmProbe, save: saveLlm });
      setConfigured(true); say(`「${m.name}」连接成功。AI 会按问题需要联网搜索、取数和计算。`);
    } catch (e) { const f = failureOf(e); oops(f.text, f.detail); }
    finally { setTesting(false); }
  };

  /** 用户在终端里装好 / 登录好 CLI 之后回到这页:重新检测,不用刷新页面 */
  const recheck = async () => {
    setRechecking(true);
    try { await refreshAgents(); } finally { setRechecking(false); }
  };

  const forget = () => {
    // 🔴 清不掉要说出来：吞掉异常的话界面写"已清除"、旧 key 还在，下一次提问照样发出去
    // 在途的模型列表请求一并作废、列表与提示清空:不然它晚回来,会把用旧 key 取到的列表重新显示出来。
    // 放在 try 之前:就算清除存储失败,也不该继续显示用这个 key 取到的东西。
    resetModels();
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
        ? (info.provider.profile
          ? `后台默认 AI 来源：${info.provider.label ?? info.provider.profile}（${info.provider.kind === "local_agent" ? "本机订阅 Agent" : "模型 API"}）` +
            (info.provider.kind === "api" ? `｜密钥变量 ${info.provider.env_key ?? "—"} ${info.provider.key_present ? "已设置" : "未设置"}` : "")
          : "后台没有配置默认 AI 来源") +
          `｜默认模型 ${String(info.defaults.model ?? "—")}｜产品版本 ${info.version}`
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
    : runtimeLabel(runtime.config?.source.provider);
  const selectedProvider = runtime.config?.source.provider ?? "";
  const localSubscriptionRuntime = configured && ["cli-codex", "cli-claude", "cli-codebuddy"].includes(selectedProvider);
  const localRuntimeName = selectedProvider === "cli-codebuddy" ? "WorkBuddy / CodeBuddy" : selectedProvider === "cli-codex" ? "Codex" : "Claude Code";
  const runtimeFeatures = localSubscriptionRuntime
    ? [
        { icon: Terminal, title: "本地对话", text: `使用 ${localRuntimeName} 登录账号` },
        { icon: Wrench, title: "受控工具", text: "六阶段只开放产品 MCP" },
        { icon: Database, title: "完整研究", text: "A 股、港股、美股六阶段流程" },
        { icon: ShieldCheck, title: "证据纪律", text: "产物经过校验与红线" },
      ]
    : [
        { icon: Terminal, title: "本地任务", text: "任务状态留在本机" },
        { icon: Wrench, title: "工具调用", text: "自动调用数据与计算" },
        { icon: Database, title: "长期上下文", text: "可以继续追问和迭代" },
        { icon: ShieldCheck, title: "证据纪律", text: "结果经过校验与红线" },
      ];

  return (
    <div>
      <PageHeader
        title="接入 AI"
        subtitle="连接订阅或 API 后就能用：AI 会按问题需要联网搜索、取数和计算，也能跑六阶段研究、多空辩论和回测。"
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
          <span className="mt-2 block">AI 联网时，搜索词会发送给搜索服务；网页读取可能经 Jina Reader 转发网址及查询参数。请勿提交含私密令牌或签名凭据的链接。</span>
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
              状态来自这台机器的实时检测。Codex、Claude Code 与 WorkBuddy / CodeBuddy 都用你自己已经登录好的 CLI 作答，
              <b className="text-foreground">不会悄悄换成别家</b>；登录凭据留在各自的 CLI 里，本产品不读取也不保存。
              Qwen Code 当前需 API key / Coding Plan，DeepSeek CLI 也需 API key，放在右侧 API 接入。
            </p>
            <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              推荐用腾讯官方独立命令行 CodeBuddy Code：安装后在终端运行 <span className="font-mono">codebuddy</span> 登录一次（跟 WorkBuddy 桌面版的登录分开）。
              新版 WorkBuddy 桌面版把登录加密保存、只给它自己启动的程序用，本产品借不到；能借到登录的旧版仍会直接识别。
            </p>
            <p className="rounded-lg border border-warning/25 bg-warning/[0.05] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              三家都可运行对话、有界材料任务和六阶段个股研究；研究阶段只开放产品受控的数据工具（MCP）。
            </p>
            {agentErr && <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">本机 Agent 状态检测失败：{agentErr}</p>}
            <div className="grid gap-2 sm:grid-cols-3">
              {SUBSCRIPTION_MODELS.map((m) => {
                const on = cliId === m.id;
                const detected = agentOf(m.provider);
                const disabled = !detected?.available;
                const badge = detected?.status === "ready" ? "可用"
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
              // 登录发生在用户自己的终端里(codex login);本页只指路,不代办
              const help = codex?.status === "not_authenticated"
                ? <>{codex.detail}。</>
                : codex?.status === "not_installed"
                  ? <>尚未检测到 Codex CLI：运行 <span className="font-mono">npm install -g @openai/codex</span> 安装 OpenAI 官方 CLI，再在终端运行 <span className="font-mono">codex login</span> 用 ChatGPT 账号登录。</>
                  : codex?.status === "probe_failed"
                    ? <>已检测到 Codex CLI，但状态检测没有通过：{codex.detail}。</>
                    : <>正在检测本机 Codex 状态…</>;
              return (
                <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {help}
                </p>
              );
            })()}
            {(() => {
              const codebuddy = agentOf("cli-codebuddy");
              if (codebuddy?.status === "ready") return null;
              // 未登录的原因分两种（独立命令行没登录 / 借不到 WorkBuddy 的登录，#56），文案由后台按实际找到的程序给
              const help = codebuddy?.status === "not_authenticated"
                ? <>{codebuddy.detail}。腾讯官方独立命令行的安装命令：<span className="font-mono">npm install -g @tencent-ai/codebuddy-code</span>。</>
                : codebuddy?.status === "not_installed"
                  ? <>尚未检测到 CodeBuddy：运行 <span className="font-mono">npm install -g @tencent-ai/codebuddy-code</span> 安装腾讯官方命令行，再在终端运行 <span className="font-mono">codebuddy</span> 登录。</>
                  : codebuddy?.status === "probe_failed"
                    ? <>已检测到 WorkBuddy / CodeBuddy，但当前版本无法建立受限连接：请先更新 WorkBuddy 或官方 CLI。</>
                    : <>正在检测本机 CodeBuddy 状态…</>;
              return (
                <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {help}
                </p>
              );
            })()}
            <WorkBuddyLocation status={agentOf("cli-codebuddy")} onSave={saveCodeBuddyPath} />
            {SUBSCRIPTION_MODELS.some((m) => agentOf(m.provider)?.status !== "ready") && (
              <button type="button" onClick={() => void recheck()} disabled={rechecking}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline disabled:cursor-wait disabled:opacity-60">
                <RefreshCw className={`h-3.5 w-3.5 ${rechecking ? "animate-spin" : ""}`} />
                {rechecking ? "正在重新检测…" : "已在终端装好或登录？重新检测"}
              </button>
            )}
            <ActionRow onSave={testAndSaveCli} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} busy={testing} detail={errDetail} />
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
                  const st = verificationOf(providerOfModel(apiId));
                  if (st === "verified") return "产品用真实 key 实测过这一家（对话、工具调用、结构化产出），记录在 providers/ 模板里。";
                  if (st === "unsupported") return "⚠️ 产品实测过这一家的接口，不可用；原因记在 providers/ 模板里。";
                  if (st === "untested") return "⚠️ 产品写好了这一家的模板（官方地址与模型名已核实），但还没用真实 key 跑过 —— 能不能用得你自己试。";
                  if (st) return "⚠️ 这一家的模板文件读不了，请检查 providers/ 里的模板。";
                  return "⚠️ 产品没有这一家的模板，按通用 OpenAI 兼容端点走 —— 端点要支持 Chat Completions 和工具调用（function calling）。";
                })()}
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Base URL</label>
              <input value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setMsg(""); setMsgErr(""); setErrDetail(""); resetModels(); }}
                placeholder="https://api.deepseek.com" className={`${INPUT} font-mono text-xs`} />
              {/* 百炼系模板留了占位让用户替换 —— 没替换后端会拒，这里先说清楚 */}
              {/[{<][A-Za-z_]/.test(baseURL) && (
                <p className="mt-1 text-[11px] text-destructive">把 {"{…}"} 换成你自己的值（百炼控制台里的 WorkspaceId）</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">API Key</label>
              <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setMsg(""); setMsgErr(""); setErrDetail(""); resetModels(); }}
                placeholder="sk-…" className={`${INPUT} font-mono text-xs`} />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                为避免每次重填，key 会保存在当前浏览器的本机配置中；它不是系统钥匙串，也不承诺加密。
                只建议在可信的个人电脑使用，共享电脑用完请点击“忘记配置”。key 不进入仓库、后端配置、日志或研究产物。
              </p>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-muted-foreground">Model</label>
                <button type="button" onClick={() => void fetchModelList()} disabled={fetchingModels}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:cursor-wait disabled:opacity-60">
                  <RefreshCw className={`h-3 w-3 ${fetchingModels ? "animate-spin" : ""}`} />
                  {fetchingModels ? "正在获取…" : "获取可用模型"}
                </button>
              </div>
              <input value={modelName} onChange={(e) => { setModelName(e.target.value); setMsg(""); setMsgErr(""); setErrDetail(""); }}
                placeholder="模型名称（填好 Base URL 和 API Key 后可点右上角获取）" className={`${INPUT} font-mono text-xs`} />
              {modelsMsg && <p className="mt-1.5 text-[11px] text-primary">{modelsMsg}</p>}
              {modelsErr && (
                <div className="mt-1.5 space-y-1.5">
                  <p className="text-[11px] text-destructive">{modelsErr}</p>
                  {modelsErrDetail && (
                    <details open className="rounded-lg border border-destructive/30 bg-destructive/[0.05] p-2.5 text-xs">
                      <summary className="cursor-pointer font-medium text-destructive">错误详情（排查用）</summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{modelsErrDetail}</pre>
                    </details>
                  )}
                </div>
              )}
              {fetchedModels && (
                <ModelPicker models={fetchedModels} current={modelName}
                  onPick={(id) => { setModelName(id); setMsg(""); setMsgErr(""); setErrDetail(""); }} />
              )}
            </div>
            <ActionRow onSave={testAndSaveApi} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} busy={testing} detail={errDetail} />
          </div>
        )}
      </GlassCard>

      {/* 接入后 AI 能做什么。没有开关：页面上的请求一律可以联网、取数、计算 */}
      <div data-testid="agent-runtime-card">
        <GlassCard glow className="relative mb-5 overflow-hidden border-primary/25">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">Execution</p>
              <div className="mt-1.5 flex items-center gap-2">
                <Cpu className="h-5 w-5 text-primary" />
                <h2 className="text-xl font-extrabold tracking-tight">二、接入后能做什么</h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {localSubscriptionRuntime
                  ? `用你的 ${localRuntimeName} 订阅回答，按问题需要联网搜索、取数和计算；研究时只开放产品提供的工具。`
                  : "按问题需要联网搜索、取数和计算（工具调用由产品在本机执行），也能跑多步研究并保留研究任务记录。"}
                当前运行时：<b className="text-foreground">{selectedRuntime}</b>。
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-border/60 bg-background/30 p-3 text-xs leading-5 text-muted-foreground">
            {!configured ? (
              <><b className="text-foreground">等待连接 AI。</b> 连接成功后，对话、研究、辩论和回测都用这一个来源。</>
            ) : localSubscriptionRuntime ? (
              <><b className="text-foreground">当前：{localRuntimeName}。</b> 对话、材料任务、六阶段研究、多空辩论和回测都用它；不会暗中换成别家。</>
            ) : (
              <><b className="text-foreground">当前：模型 API。</b> 按问题需要使用联网和工具，复杂研究可能耗时较长。</>
            )}
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
              <h3 className="font-semibold">后台默认 AI 来源</h3>
              {info.provider.kind === "api" && (
                <span
                  className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                    info.provider.key_present ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {info.provider.key_present ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {info.provider.key_present ? "凭据就绪" : "缺凭据"}
                </span>
              )}
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              页面始终用你在上面选的来源；后台默认只给命令行研究和直接调用本机接口的 Agent 用。
            </p>
            {info.provider.profile ? (
              <>
                <Row k="来源" v={info.provider.label ?? info.provider.profile} />
                <Row k="模板" v={info.provider.profile} mono />
                <Row k="类型" v={info.provider.kind === "local_agent" ? "本机订阅 Agent（用它自己的登录）" : "模型 API（Chat Completions）"} />
                {info.provider.kind === "api" && (
                  <>
                    <Row k="端点" v={info.provider.base_url ?? "—"} mono />
                    <Row k="实测" v={VERIFICATION_TEXT[info.provider.verification ?? ""] ?? "—"} />
                    <Row
                      k="密钥来自"
                      v={
                        <span className="inline-flex items-center gap-1.5">
                          {/* 🔴 只说"设没设",不说"是什么" */}
                          <span className="font-mono text-xs">${info.provider.env_key ?? "—"}</span>
                          <span className="text-muted-foreground">{info.provider.key_present ? "· 已设置" : "· 未设置"}</span>
                        </span>
                      }
                    />
                  </>
                )}
                <Row k="默认模型" v={String(info.defaults.model ?? "(未指定)")} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">没有配置。</p>
            )}
            {info.config_error && <p className="mt-2 text-xs text-destructive">{info.config_error}</p>}
            {info.ignored_legacy.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                这些是 v1 的旧配置，v2 已不再使用，可以删掉：<span className="font-mono">{info.ignored_legacy.join("、")}</span>
              </p>
            )}
          </GlassCard>

          <GlassCard>
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">要改后台默认?</h3>
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>
                改数据根(见下方)里 <span className="font-mono text-xs">config.json</span> 的{" "}
                <span className="font-mono text-xs">provider.profile</span>,或设环境变量{" "}
                <span className="font-mono text-xs">VRA_PROVIDER</span>:模型 API 填模板名(见{" "}
                <span className="font-mono text-xs">providers/</span> 目录),本机订阅填{" "}
                <span className="font-mono text-xs">cli-claude</span> / <span className="font-mono text-xs">cli-codex</span> /{" "}
                <span className="font-mono text-xs">cli-codebuddy</span>
              </li>
              <li>用模型 API 时,在启动服务的那个终端里 <span className="font-mono text-xs">export</span> 该模板要求的密钥变量</li>
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
            <Row k="Python" v={info.paths.python} mono />
            <Row k="配置来源" v={info.sources.join("  ←  ")} mono />
          </GlassCard>
          </div>
        </details>
      )}

      <div className="mb-4"><SecContactCard /></div>
      <div className="mb-4"><UpdateSettingsCard /></div>

      <Disclaimer />
    </div>
  );
}
