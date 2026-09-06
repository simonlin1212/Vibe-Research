import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileText, Trash2, Download, Loader2, FolderOpen, Bot, Search, Play, Route } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, ApiError, downloadReport, type MyReport } from "@/lib/api";
import {
  backend, friendlyAgentError, type ResearchTaskRequest, type TaskRouteDecision,
} from "@/lib/backend";
import { cn } from "@/lib/utils";
import { newAnalysisSession } from "@/lib/analysisSession";

const fmtSize = (b: number) =>
  b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`;
const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
const TARGET_LABELS: Record<TaskRouteDecision["target"], string> = {
  deterministic: "确定性处理", quick: "轻量材料处理", deep: "完整 Agent 研究",
};
const DEEP_REPORT_LIMIT = 16;
const waitFor = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const onAbort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
  const timer = window.setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

// 读文件为 dataURL（含 base64）；后端会剥掉 data: 前缀。
const fileToB64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export function MyReports() {
  const runtime = useAiRuntime();
  const agentEnabled = runtime.config?.executionMode !== "direct";
  const [reports, setReports] = useState<MyReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [objective, setObjective] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [routeDecision, setRouteDecision] = useState<TaskRouteDecision | null>(null);
  const [taskAnswer, setTaskAnswer] = useState("");
  const [taskNotice, setTaskNotice] = useState("");
  const [deepRunId, setDeepRunId] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const taskAbortRef = useRef<AbortController | null>(null);

  const load = async () => {
    try {
      setReports(await api.myReports());
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载研报列表失败");
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => () => taskAbortRef.current?.abort(), []);

  const upload = async (files: FileList | File[]) => {
    if (taskBusy || deleting) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        const b64 = await fileToB64(f);
        await api.uploadReport(f.name, b64);
      }
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: MyReport) => {
    if (taskBusy || busy || deleting) return;
    if (!confirm(`删除「${r.name}」？（同时从本地归档目录移除）`)) return;
    setDeleting(true);
    try {
      await api.deleteReport(r.id);
      setSelected((ids) => ids.filter((id) => id !== r.id));
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "删除失败");
    } finally { setDeleting(false); }
  };

  const download = async (r: MyReport) => {
    try {
      await downloadReport(r.id, r.name);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "下载失败");
    }
  };

  const grouped = useMemo(() => {
    const g: Record<string, MyReport[]> = {};
    for (const r of reports) {
      const group = r.symbols.length ? r.symbols.slice(0, 3).join(" / ") : "未识别标的";
      (g[group] ||= []).push(r);
    }
    // 「未识别标的」排最后，其余按条数多→少
    return Object.entries(g).sort((a, b) =>
      a[0] === "未识别标的" ? 1 : b[0] === "未识别标的" ? -1 : b[1].length - a[1].length,
    );
  }, [reports]);

  const toggleReport = (id: string) => {
    setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  };

  const submitTask = async () => {
    const goal = objective.trim();
    if (!goal || !selected.length || taskBusy || busy || deleting) return;
    const controller = new AbortController();
    taskAbortRef.current?.abort();
    taskAbortRef.current = controller;
    const selectedReports = reports.filter((report) => selected.includes(report.id));
    const selectedSymbols = [...new Set(selectedReports.flatMap((report) => report.symbols))];
    // 界面只交“材料 + 目标”；是有界定位还是完整深研，由服务端路由器判定。
    const task: ResearchTaskRequest = {
      schemaVersion: 1,
      id: newAnalysisSession("report"),
      kind: "locate_passages",
      requestedMode: "auto",
      objective: goal,
      evidenceScope: "existing",
      workflow: "single_step",
      inputRefs: selected.map((id) => ({ kind: "report" as const, id })),
      outputFormat: "text",
      operation: null,
    };
    setTaskBusy(true);
    setTaskError("");
    setTaskAnswer("");
    setTaskNotice("");
    setDeepRunId(null); setCancelPending(false);
    setRouteDecision(null);
    try {
      // 先只路由，让系统选择理由可见；AI 来源随请求发送，只用于绑定不可逆路由指纹，
      // 不写入运行产物、配置或日志。执行阶段换来源会被拒绝。
      const routed = await backend.routeTask(task, controller.signal);
      if (controller.signal.aborted) return;
      setRouteDecision(routed.route);
      // 系统也可能因材料规模转入完整研究；在启动前把上下文上限明确告诉用户，
      // 不让合法的界面操作走到后端才以通用配置错误失败。
      if (routed.route.target === "deep" && selected.length > DEEP_REPORT_LIMIT) {
        setTaskError(`系统判断需要完整研究，但一次最多使用 ${DEEP_REPORT_LIMIT} 份资料；请缩小勾选范围后重试。`);
        return;
      }
      if (routed.route.target === "deep" && (selectedSymbols.length !== 1 || !/^(?:0|3|4|6|8|9)\d{5}$/.test(selectedSymbols[0] ?? ""))) {
        setTaskError(selectedSymbols.length > 1
          ? "系统判断需要完整研究；请只选择同一个 A 股代码的资料。"
          : "系统判断需要完整研究，但所选资料中没有可确认的 A 股代码。");
        return;
      }
      if (!routed.executionAvailable) {
        setTaskError("这项任务需要 Agent 的多步研究能力。请到「接入 AI」开启 Vibe Research Agent 后重试。");
        return;
      }
      const result = await backend.runTask(task, routed.route.routeFingerprint, controller.signal);
      if (controller.signal.aborted) return;
      setRouteDecision(result.route);
      let taskStatus = result.status;
      let taskEvents = result.events;
      const started = result.events.find((event) => event.type === "started");
      if (result.status === "running" && routed.route.target === "deep" && started) {
        setDeepRunId(started.runId);
        setTaskNotice("完整六阶段研究已启动。当前页面会持续更新；即使离开页面，研究仍会在本机继续运行，并进入「个股研究」的历史记录。");
        while (!controller.signal.aborted && taskStatus === "running") {
          await waitFor(2_000, controller.signal);
          const snapshot = await backend.resumeTask(started.runId, routed.route.routeFingerprint, controller.signal);
          taskStatus = snapshot.status;
          taskEvents = snapshot.events;
        }
      }
      const artifact = taskEvents.find((event) => event.type === "artifact");
      const failed = taskEvents.find((event) => event.type === "failed");
      if (taskStatus === "completed" && typeof artifact?.payload?.answer === "string") {
        setTaskAnswer(artifact.payload.answer);
      } else if (taskStatus === "completed" && typeof artifact?.payload?.report === "string") {
        setTaskAnswer(artifact.payload.report);
        setTaskNotice("六阶段研究已完成，正式报告已写入本机研究历史。");
      } else {
        setTaskError(typeof failed?.payload?.message === "string"
          ? failed.payload.message : "这次任务没有生成可交付结果，请检查模型配置后重试。");
      }
    } catch (e) {
      if (!controller.signal.aborted) setTaskError(friendlyAgentError(e));
    } finally {
      if (taskAbortRef.current === controller) {
        taskAbortRef.current = null;
        setTaskBusy(false);
        setDeepRunId(null); setCancelPending(false);
      }
    }
  };

  const cancelDeep = async () => {
    if (!deepRunId || cancelPending) return;
    const controller = taskAbortRef.current;
    setCancelPending(true);
    try {
      const status = await backend.cancelResearch(deepRunId);
      if (taskAbortRef.current !== controller) return;
      setTaskNotice(status.finished_at ? "研究已结束，正在读取最终状态。" : status.status === "finalizing"
        ? "研究已进入归档收尾，不能再取消，正在等待最终状态。"
        : "已请求取消，等待后台确认停止；已经取到的数据会保留。");
    } catch (e) {
      if (taskAbortRef.current === controller) { setCancelPending(false); setTaskError(friendlyAgentError(e)); }
    }
  };

  useAiPage({
    key: "my-reports",
    title: "我的研报",
    context: reports.length
      ? `我的研报（本地归档，共 ${reports.length} 份）：\n` +
        reports.slice(0, 60).map((r) => `- ${r.name}｜标的 ${r.symbols.join("/") || "未识别"}｜已提取 ${r.chars} 字`).join("\n")
      : "我的研报：还没有归档任何文件。",
    suggestions: ["我归档的研报覆盖了哪些标的", "从我的研报里找核心观点", "帮我给这些资料排个阅读顺序"],
  });

  return (
    <div>
      <PageHeader
        title="我的研报"
        subtitle={`上传后自动提取正文并进入本地资料库；${agentEnabled ? "Agent 对话会检索引用，A 股研报还能进入个股研究" : "模型直连可做轻量材料定位，完整研究需重新开启 Agent"}。原文件只保存在本机。`}
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/80">
          <Search className="h-4 w-4 text-primary" /> 正文已建立本地检索索引
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/80">
          <Bot className="h-4 w-4 text-primary" /> {agentEnabled ? "Agent" : "模型"}回答会标注研报 id 与页码
        </div>
      </div>
      <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
        隐私说明：原文件不会上传。材料任务只读取勾选文件；系统会根据目标自动选择处理方式，完整六阶段研究仅在 Agent 开启时执行。
        模型只会收到本轮需要的已提取正文或命中片段，正式报告保存在本机。
        未识别出代码的文件仍可在对话中检索。A 股代码会用于个股研究自动召回；港股与美股代码用于归档分组和对话检索，当前六阶段个股研究底座仍只支持 A 股。
      </p>

      <GlassCard className="mb-4 border-primary/25">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4 text-primary" /> 材料任务</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">勾选下方资料，直接描述目标。系统会自动选择合适的处理方式，并说明原因。</p>
          </div>
          <button type="button" disabled={!reports.length || taskBusy || busy || deleting}
            onClick={() => setSelected(selected.length === reports.length ? [] : reports.map((report) => report.id))}
            className="rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            {selected.length === reports.length && reports.length ? "取消全选" : "选择全部"}
          </button>
        </div>

        <textarea value={objective} onChange={(e) => setObjective(e.target.value)} disabled={taskBusy || busy || deleting} rows={3}
          maxLength={8000} placeholder="例如：找出这些研报中关于收入变化、原因和风险提示的原文段落"
          className="w-full resize-y rounded-xl border border-border/70 bg-background/45 px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/65 focus:border-primary/60 disabled:opacity-50" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">已选 {selected.length} 份 · 由系统自动判断</p>
          <button type="button" onClick={() => void submitTask()} disabled={!selected.length || !objective.trim() || taskBusy || busy || deleting}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-35">
            {taskBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {taskBusy ? "正在判断并处理…" : "开始任务"}
          </button>
          {taskBusy && deepRunId && <button type="button" onClick={() => void cancelDeep()} disabled={cancelPending}
            className="rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-50">
            {cancelPending ? "正在取消…" : "取消研究"}
          </button>}
        </div>

        {routeDecision && <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><Route className="h-4 w-4 text-primary" />
            系统选择：{TARGET_LABELS[routeDecision.target]}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{routeDecision.reason}</p>
        </div>}
        {taskNotice && <div className="mt-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-3 text-sm text-foreground/80">{taskNotice}</div>}
        {taskError && <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{taskError}</div>}
        {taskAnswer && <div className="research-paper mt-4 rounded border border-border">
          <p className="mb-3 text-xs font-semibold text-muted-foreground">任务结果</p>
          <div className="prose prose-sm dark:prose-invert max-w-none prose-blockquote:border-primary/40 prose-blockquote:text-foreground/85">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{taskAnswer}</ReactMarkdown>
          </div>
        </div>}
      </GlassCard>

      {/* 上传区 */}
      <GlassCard className="mb-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!taskBusy && !deleting && e.dataTransfer.files.length) upload(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-xl border-2 border-dashed text-center transition-colors",
            drag ? "border-primary bg-primary/10" : "border-border hover:border-primary/50 hover:bg-primary/5",
          )}
        >
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy || deleting || taskBusy}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-[inherit] py-10 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? (
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            ) : (
              <Upload className="h-7 w-7 text-primary" />
            )}
            <span className="text-sm font-medium">
              {busy ? "上传中…" : taskBusy ? "材料任务进行中，暂不能更换资料" : "把研报拖到这里，或点击选择文件"}
            </span>
            <span className="text-xs text-muted-foreground/70">
              支持 PDF / DOCX / TXT / MD / CSV，单个 ≤ 25MB，可一次多选
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.markdown,.csv"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </GlassCard>

      {err && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {err}
        </div>
      )}

      {/* 列表（按正文里识别到的标的代码分组） */}
      {reports.length === 0 ? (
        <GlassCard>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <FolderOpen className="h-8 w-8 text-muted-foreground/40" />
          还没有归档的研报。把研报拖进上面的框，正文提取成功后就会进入本地资料库。
          </div>
        </GlassCard>
      ) : (
        <div className="space-y-4">
          {grouped.map(([group, items]) => (
            <GlassCard key={group}>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <span className="rounded bg-primary/15 px-2 py-0.5 text-xs text-primary">{group}</span>
                <span className="text-xs font-normal text-muted-foreground">{items.length} 份</span>
              </h3>
              <div className="divide-y divide-border/30">
                {items.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 py-2.5">
                    <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggleReport(r.id)}
                      aria-label={`选择 ${r.name}`} disabled={taskBusy || busy || deleting}
                      className="h-4 w-4 shrink-0 accent-primary" />
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      <p className="text-[11px] text-muted-foreground/60">
                        {r.ext} · {fmtSize(r.size)} · {r.pages ? `${r.pages} 页 · ` : ""}{r.chars.toLocaleString()} 字 · {fmtDate(r.ts)}
                        {r.truncated ? " · 正文超长，已截取前 100 万字" : " · 已接入 Agent"}
                      </p>
                    </div>
                    <button
                      onClick={() => download(r)}
                      className="shrink-0 text-muted-foreground/60 hover:text-primary"
                      title="下载"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      disabled={taskBusy || busy || deleting}
                      className="shrink-0 text-muted-foreground/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-35"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      <Disclaimer />
    </div>
  );
}
