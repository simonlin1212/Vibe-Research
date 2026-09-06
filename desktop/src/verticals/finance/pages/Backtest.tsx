import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Plus, Send, UserRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { ReportHistory } from "@/components/ui/ReportHistory";
import { backend, friendlyAgentError } from "@/lib/backend";
import { addNote, loadNotes, type Note } from "@/lib/notes";
import { useAiPage } from "../../../core/ai/pageContext";

interface Message { id: string; role: "user" | "agent"; content: string }
// #34：明文局域网页面不提供 crypto.randomUUID；这里只生成 UI 标识，不作为鉴权凭据。
const id = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const session = () => `bt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 24);

export function Backtest() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [notes, setNotes] = useState<Note[]>(loadNotes);
  const [archiveError, setArchiveError] = useState("");
  const [lastReport, setLastReport] = useState("");
  const sessionRef = useRef(session());
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, running]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useAiPage({
    key: "backtest-agent", title: "回测 Agent",
    context: lastReport || "回测 Agent：先通过对话厘清假设与规则，再调用真实回测工具，完成后自动生成并归档报告。",
    suggestions: ["这份回测最关键的限制是什么", "结果相对基准说明什么", "这个假设还缺哪种验证"],
  });

  const reset = () => {
    abortRef.current?.abort();
    sessionRef.current = session();
    setMessages([]); setDraft(""); setRunning(false); setArchiveError(""); setLastReport("");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft(""); setArchiveError(""); setRunning(true);
    setMessages((m) => [...m, { id: id(), role: "user", content: text }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const out = await backend.guidedTool("backtest", sessionRef.current, text, ac.signal);
      if (ac.signal.aborted) return;
      if (out.status === "needs_input") {
        setMessages((m) => [...m, { id: id(), role: "agent", content: out.message }]);
      } else {
        const archive = [
          `# ${out.title}`, "", "## 回测问题", "", out.question,
          "", "## 回测假设", "", out.hypothesis,
          "", "## 回测逻辑", "", ...out.logic.map((x) => `- ${x}`),
          "", "## 回测结果", "", out.report,
        ].join("\n");
        setLastReport(archive);
        setMessages((m) => [...m, { id: id(), role: "agent", content: `${out.message}\n\n${archive}` }]);
        try { setNotes(await addNote("回测", out.title, archive)); }
        catch (e) { setArchiveError(`报告已经生成，但自动归档失败：${e instanceof Error ? e.message : String(e)}`); }
      }
    } catch (e) {
      if (!ac.signal.aborted) setMessages((m) => [...m, {
        id: id(), role: "agent", content: `这轮没有跑起来：${friendlyAgentError(e)}`,
      }]);
    } finally {
      if (abortRef.current === ac) { abortRef.current = null; setRunning(false); }
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="回测" subtitle="把想验证的假设直接告诉 Agent。它会补齐必要条件、选择工具、执行回测，并自动保存完整报告。"
        actions={messages.length > 0 && <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Plus className="h-3.5 w-3.5" /> 新建会话
        </button>} />

      <GlassCard className="!p-0 overflow-hidden border-primary/25">
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary"><Bot className="h-5 w-5" /></div>
          <p className="text-sm font-semibold">回测 Agent</p>
        </div>

        <div className="min-h-[360px] max-h-[620px] space-y-5 overflow-y-auto px-5 py-5">
          {messages.length === 0 && <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
            <Bot className="mb-4 h-9 w-9 text-primary/60" />
            <p className="text-base font-medium">想验证什么，直接说。</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">可以从一句不完整的想法开始。Agent 会判断还缺哪些标的、时间范围、规则或对照，再继续追问。</p>
          </div>}
          {messages.map((m) => <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "agent" && <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"><Bot className="h-4 w-4" /></div>}
            <div className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 ${m.role === "user" ? "bg-primary text-primary-foreground" : "border border-border/70 bg-background/55"}`}>
              {m.role === "agent" ? <div className="prose prose-sm dark:prose-invert max-w-none prose-table:text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div> : <div className="whitespace-pre-wrap">{m.content}</div>}
            </div>
            {m.role === "user" && <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><UserRound className="h-4 w-4" /></div>}
          </div>)}
          {running && <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 text-primary"><Loader2 className="h-4 w-4 animate-spin" /></div>
            Agent 正在判断信息是否齐全；条件齐了以后会自动取数和逐条回测…
          </div>}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-border/60 p-4">
          <div className="flex items-end gap-3 rounded-2xl border border-warning/35 bg-warning/[0.045] p-2 focus-within:border-warning/60">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }} disabled={running} rows={2}
              placeholder="例如：验证过去五年，某个均线策略在贵州茅台上是否跑赢买入持有…（Shift+Enter 换行）"
              className="max-h-36 min-h-[52px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50" />
            <button onClick={() => void send()} disabled={!draft.trim() || running}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground transition-opacity disabled:opacity-35" aria-label="发送">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/65">报告只依据真实工具返回生成；数据不足或口径不成立时会继续追问，不会硬算。</p>
          {archiveError && <p className="mt-2 text-center text-xs text-destructive">{archiveError}</p>}
        </div>
      </GlassCard>

      <ReportHistory kind="回测" notes={notes} onChange={setNotes} />
      <Disclaimer />
    </div>
  );
}
