import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Sparkles, X, Settings, Send, Loader2, Wrench, AlertCircle, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { hasLlm, chatStream, type ChatMsg } from "@/lib/llm";
import { ApiError } from "@/lib/api";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { storageGet, storageSet, storageRemove } from "@/lib/storage";

// 对话持久化（#19）。此前 msgs 只是组件内的 useState：切页面卸载、刷新、
// 关标签页，问过的东西全没了——用户反馈「关闭 AI 就找不回之前的对话」，
// 而每轮对话是花了自己 API 额度换来的，丢掉的是真金白银。
//
// 按路由分开存：不同页面的「问 AI」上下文不同（个股页 vs 板块页），
// 混在一起会把上一页的对话带到下一页，比不存更让人困惑。
const CHAT_KEY_PREFIX = "vr-askai-chat:";
// 单页对话上限。localStorage 总配额约 5MB，而一轮研报级回答可能上万字；
// 不设上限迟早写爆，届时 storageSet 静默失败、用户以为存上了。
const MAX_PERSISTED_MSGS = 40;

type StoredMsg = ChatMsg & {
  tools?: ToolUse[];
  // 流式中途被中止、只收到半截的回答。**不落盘、也不进下一轮 history**：
  // 否则刷新后它会以「完整回答」的身份被喂回模型，后续推理建立在残句上。
  // UI 仍然显示，用户能看到已经拿到的部分。
  partial?: boolean;
};

function loadChat(key: string): StoredMsg[] {
  const raw = storageGet(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // 存量数据可能来自旧版本或被手工改坏，形状不对就当没有，别让页面崩。
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is StoredMsg =>
        m && typeof m === "object" && typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant"),
    );
  } catch {
    return [];
  }
}

// 只保留「完整的轮次」。partial 的 assistant 要连同它前面那条 user 一起丢：
// 只丢 assistant 会留下一个孤立的提问，模型在 history 里看到连续两条 user 发言，
// 会把那个被放弃的问题当成还在等回答，去答错的题。
function completeTurns(msgs: StoredMsg[]): StoredMsg[] {
  const out: StoredMsg[] = [];
  for (const m of msgs) {
    if (m.partial) {
      if (out.length && out[out.length - 1].role === "user") out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

function saveChat(key: string, msgs: StoredMsg[]): void {
  if (!msgs.length) {
    storageRemove(key);
    return;
  }
  const keep = completeTurns(msgs);
  if (!keep.length) {
    storageRemove(key);
    return;
  }
  storageSet(key, JSON.stringify(keep.slice(-MAX_PERSISTED_MSGS)));
}

interface Props {
  // 本分栏/本页要喂给用户 AI 的上下文，作为对话的系统上下文。
  context: string;
  suggestions?: string[];
  label?: string;
  // 用来在**同一路由内**再切分对话。不传则只按路由区分——目前每个页面都只挂
  // 一个 AskAiButton、且一个路由对应一个对象，够用。
  // ⚠️ 两种情况必须传，否则对话会串台（A 的历史被当成 history 发给问 B 的模型）：
  //   ① 不换路由就能换标的的页面（如个股页，已按股票代码传入）
  //   ② 同一路由里渲染**多个** AskAiButton 实例（目前没有；将来加了务必带上）
  scopeKey?: string;
}

const TOOL_LABEL: Record<string, string> = {
  query_quote: "查行情",
  query_valuation: "查估值",
  query_reports: "查研报",
  query_news: "查新闻",
};

// 数据溯源：把工具调用的关键参数压成一小段（查了哪只/哪些代码）。
const argStr = (a: Record<string, unknown>): string => {
  if (Array.isArray(a.codes)) return (a.codes as unknown[]).join(",");
  if (typeof a.code === "string") return a.code;
  return "";
};

interface ToolUse { name: string; arg: string }

// 「问 AI」入口 —— 把当前分栏内容作为上下文，调用户自己配置的模型；
// AI 可自行调 A股数据工具作答。结论由用户模型给出，本产品不校准、不负责。
export function AskAiButton({ context, suggestions = [], label = "问 AI", scopeKey }: Props) {
  const { pathname } = useLocation();
  const chatKey = CHAT_KEY_PREFIX + pathname + (scopeKey ? `#${scopeKey}` : "");

  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  // key 与消息放在**同一个 state 里原子更新**——这是正确性的关键，不是风格问题。
  // 若分成 msgs + 一个记录归属的 ref，key 变化那一帧 ref 已指向新 key 而 msgs 仍是旧的
  // （setState 下一帧才生效），落盘守卫会误放行，把来源页对话写进目标 key、
  // 覆盖掉目标页已存的对话。捆在一起后，转场帧里 chat.key 天然还是旧值，守卫必然拦住。
  // 惰性初始化：首帧就带上已存的对话，避免先渲染空列表再闪一下补上。
  const [chat, setChat] = useState<{ key: string; msgs: StoredMsg[] }>(
    () => ({ key: chatKey, msgs: loadChat(chatKey) }),
  );
  const msgs = chat.msgs;
  const setMsgs = (
    updater: StoredMsg[] | ((prev: StoredMsg[]) => StoredMsg[]),
  ) =>
    setChat((c) => ({
      key: c.key,
      msgs: typeof updater === "function" ? updater(c.msgs) : updater,
    }));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 在跑的流式请求：关面板/换问题时中止，省用户的订阅/API 额度，也防迟到 chunk 写进新气泡
  const abortRef = useRef<AbortController | null>(null);
  // 始终镜像当前 chatKey，供异步回调判断「对话是否已经被换掉」。
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;

  useEffect(() => {
    if (open) setConfigured(hasLlm());
  }, [open]);

  // 换页面/换标的 = 换一份对话（key 变了），把目标 key 已存的读进来。
  // 同时**中止在跑的流式请求**：否则它的 alive() 仍然成立，迟到的 chunk 会被
  // 追加到目标页的最后一条助手消息上，并把「用来源页上下文生成的回答」存进目标 key。
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setChat({ key: chatKey, msgs: loadChat(chatKey) });
  }, [chatKey]);

  // 每次消息变动落盘。守卫见上方 chat state 的注释：转场帧里 chat.key 仍是旧值，
  // 与 chatKey 不等，于是不会把旧对话写进新 key。
  useEffect(() => {
    if (chat.key !== chatKey) return;
    saveChat(chatKey, chat.msgs);
  }, [chatKey, chat]);

  useEffect(() => () => abortRef.current?.abort(), []); // 组件卸载兜底

  const clearChat = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setErr(null);
    setMsgs([]);          // saveChat 见空数组会 storageRemove，不留空壳
  };

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setOpen(false);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setInput("");
    setErr(null);
    // 未完成的轮次整轮不进 history（半截回答 + 它的提问）：
    // 模型会把残句当成自己上一轮的完整发言继续推理，孤立的提问则会被当成待答问题。
    const history: ChatMsg[] = [
      ...completeTurns(msgs).map(({ role, content }) => ({ role, content })),
      { role: "user", content: q },
    ];
    // 先放用户气泡 + 一个空的 assistant 气泡，流式往里填。
    // assistant 气泡**从创建就是 partial**，只有流式正常结束才摘掉这个标记。
    // 这样「流到一半用户换页/换标的」时，落盘的那份天然就不含这条残句——
    // 靠中止时再补标记是来不及的：每个 delta 都会触发落盘。
    setMsgs((m) => [
      ...m,
      { role: "user", content: q },
      { role: "assistant", content: "", tools: [], partial: true },
    ]);
    setLoading(true);
    // 更新「最后一条 assistant 气泡」（不可变）。
    const patchLast = (fn: (msg: StoredMsg) => StoredMsg) =>
      setMsgs((m) => m.map((msg, i) => (i === m.length - 1 && msg.role === "assistant" ? fn(msg) : msg)));
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const startedKey = chatKeyRef.current;   // 这次请求属于哪份对话
    // 只有仍是「当前这次请求」才允许写 UI——旧请求的迟到 chunk 直接丢弃
    const alive = () => abortRef.current === ac && !ac.signal.aborted;
    try {
      await chatStream(history, context, {
        onTool: (tool, args) => { if (alive()) patchLast((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: tool, arg: argStr(args) }] })); },
        onDelta: (t) => { if (alive()) patchLast((msg) => ({ ...msg, content: msg.content + t })); },
      }, ac.signal);
      // 正常收完：摘掉 partial，这条回答才开始落盘、才进下一轮 history。
      if (alive()) patchLast((msg) => {
        const { partial: _drop, ...rest } = msg;
        return rest;
      });
    } catch (e) {
      // 出错/中止：去掉尾部空 assistant 气泡；主动中止不算错误，不提示。
      // 三种「不该清理」的情况要分开判，不能简单用 abortRef.current === ac：
      //   · 有更新的请求接管了（abortRef 指向别人）→ 别删人家的气泡
      //   · 对话已经被换掉（key 变了）→ 别动新对话
      //   · 面板被关闭（close 把 abortRef 置 null，但对话没变）→ **仍要清理**，
      //     否则空气泡会被持久化，重开/刷新看到一条空回复还进后续 history。
      const superseded = abortRef.current !== null && abortRef.current !== ac;
      if (!superseded && chatKeyRef.current === startedKey) {
        // 有内容的半截回答本来就带着 partial（创建时就标了），completeTurns
        // 会把它连同提问一起挡在落盘与 history 之外，界面上仍显示给用户看。
        // 这里只处理「一个字都没收到」：把空气泡**连同它的提问**一起从界面移除——
        // 只删空气泡会在界面和存储里留下一个孤立的提问，下一轮就是连续两条 user。
        setMsgs((m) => {
          const last = m[m.length - 1];
          if (!last || last.role !== "assistant" || last.content) return m;
          const dropUser = m[m.length - 2]?.role === "user";
          return m.slice(0, dropUser ? -2 : -1);
        });
        if (!ac.signal.aborted) setErr(e instanceof ApiError ? e.message : "对话失败");
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary shadow-glow transition-colors hover:bg-primary/25"
      >
        <Sparkles className="h-4 w-4" />
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={close} />
          <aside className="glass relative m-3 flex w-full max-w-md flex-col rounded-2xl">
            <div className="flex items-center justify-between border-b border-border/60 p-4">
              <span className="flex items-center gap-2 font-semibold text-glow">
                <Sparkles className="h-4 w-4 text-primary" /> 问 AI · 本页上下文
              </span>
              <div className="flex items-center gap-1">
                {msgs.length > 0 && (
                  // 存了就得能删：对话留在本机 localStorage，用户得有办法清掉。
                  <button
                    onClick={clearChat}
                    title="清空本页对话"
                    aria-label="清空本页对话"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button onClick={close} className="text-muted-foreground hover:text-foreground" aria-label="关闭">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {!configured ? (
              // 未接入 AI：引导去设置
              <div className="flex-1 space-y-4 overflow-auto p-4 text-sm">
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  分析结论由你自己配置的 AI 给出，本产品只负责把本页数据打包成上下文、并让 AI 能调数据工具，
                  <b className="text-foreground">不校准、不背书、不对结果负责</b>。
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">将随提问发给 AI 的本页上下文：</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
{context}
                  </pre>
                </div>
                <Link to="/settings" className="flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25">
                  <Settings className="h-4 w-4" /> 先接入你的 AI（订阅 / API）
                </Link>
              </div>
            ) : (
              // 已接入：真对话
              <>
                <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4 text-sm">
                  {msgs.length === 0 && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                      AI 可基于本页上下文、并自行调取 A股行情/估值/研报数据作答。结论由你的模型给出，
                      <b className="text-foreground">不构成投资建议</b>。
                    </div>
                  )}
                  {msgs.map((m, i) => (
                    <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                      <div className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 leading-relaxed",
                        m.role === "user" ? "bg-primary/20 text-foreground" : "bg-muted/40 text-foreground",
                      )}>
                        {m.tools && m.tools.length > 0 && (
                          <div className="mb-1.5 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-muted-foreground/70">数据来源</span>
                            {m.tools.map((t, j) => (
                              <span key={j} className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                                <Wrench className="h-2.5 w-2.5" /> {TOOL_LABEL[t.name] || t.name}{t.arg ? ` ${t.arg}` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                        {m.role === "assistant" ? (
                          <div className="prose prose-sm dark:prose-invert max-w-none break-words text-foreground">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        )}
                        {m.role === "assistant" && m.content && !(loading && i === msgs.length - 1) && (
                          <div className="mt-1.5"><SaveNoteButton kind="问AI" title={`问 AI · ${msgs[i - 1]?.content?.slice(0, 24) || "对话"}`} content={m.content} /></div>
                        )}
                      </div>
                    </div>
                  ))}
                  {loading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在思考 / 调取数据…
                    </div>
                  )}
                  {err && (
                    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {err}
                    </div>
                  )}
                  {msgs.length === 0 && suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {suggestions.map((s) => (
                        <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs hover:border-primary/40 hover:text-primary">
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-border/60 p-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
                      rows={1}
                      placeholder="就本页内容提问…"
                      className="flex-1 resize-none rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                    />
                    <button onClick={() => send(input)} disabled={loading || !input.trim()}
                      className="rounded-lg bg-primary/15 p-2 text-primary hover:bg-primary/25 disabled:opacity-40">
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
