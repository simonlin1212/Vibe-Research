import { useState, useEffect } from "react";
import { backend, type PageResult } from "@/lib/backend";
import { Link } from "react-router-dom";
import { Sparkles, Loader2, AlertCircle, RefreshCw, Gauge, ArrowDownUp, TrendingUp, TrendingDown, Plus, X, Flame, BarChart3, Globe } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, ApiError, type IndexQuote, type Quote, type MarketOverview, type ShortTermEmotion, type TurnoverTop, type GlobalIndex } from "@/lib/api";
import { hasLlm, chatStream } from "@/lib/llm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { loadWatch, saveWatch, addCodes } from "@/lib/watchlist";
import { cn } from "@/lib/utils";

// A股红涨绿跌。全球市场（美股/港股指数）**也沿用红涨**——与整个看板及东财等中国平台一致，
// 对中国用户最不易看错（Simon 2026-07-05 确认；非国际绿涨惯例，是有意选择，勿改）。
// 容 null:同上,行情缺项时显示灰色的「—」,不套涨跌色
const pctColor = (p: number | null | undefined) =>
  p == null ? "text-muted-foreground/40" : p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground";
const fmt = (v: number | null) => v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const yi = (v: number | null) => (v == null ? "—" : `${fmt(v / 1e8)} 亿`); // 元 → 亿

export function DailyReview() {
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [idxErr, setIdxErr] = useState(false);
  const [review, setReview] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [emotion, setEmotion] = useState<ShortTermEmotion | null>(null);
  const [turnover, setTurnover] = useState<TurnoverTop | null>(null);
  const [globalIdx, setGlobalIdx] = useState<GlobalIndex[]>([]);
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [globalDone, setGlobalDone] = useState(false);
  // 关注股票（自选，存本地）
  const [watchCodes, setWatchCodes] = useState<string[]>(loadWatch);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, Quote>>({});
  const [watchInput, setWatchInput] = useState("");
  const [watchLoading, setWatchLoading] = useState(false);

  // 各数据块请求是否已结束：区分「加载中」与「数据源暂不可用」（非交易时段/被限流时后端返回空）
  const [ovDone, setOvDone] = useState(false);
  const [emoDone, setEmoDone] = useState(false);
  const [toDone, setToDone] = useState(false);

  const loadIndices = () => {
    api.indices().then(setIndices).catch(() => setIdxErr(true));
    setGlobalDone(false);
    setGlobalErr(null);
    setGlobalIdx([]);
    api.globalIndices().then(setGlobalIdx)
      .catch((e) => setGlobalErr(e instanceof Error ? e.message : "全球指数获取失败"))
      .finally(() => setGlobalDone(true));
    api.emotion().then(setEmotion).catch(() => {}).finally(() => setEmoDone(true));
    api.turnoverTop().then(setTurnover).catch(() => {}).finally(() => setToDone(true));

    /**
     * 🔴 情绪 / 板块资金 / 涨停梯队 **只取一次**:向 Core 要一屏(`/page/review`),
     *    再把取回的信封喂给解析。此前页面和 BFF 各取一遍 —— 上游被打两遍,
     *    而且 **BFF 注入了业务日、页面这边没有**,同一屏的状态与数字可能是不同两天的。
     */
    setPageErr(null);
    backend
      .page("review")
      .then((meta) => {
        setPageMeta(meta);
        const env = (id: string) => meta.blocks.find((b) => b.id === id)?.envelope as never;
        return api.marketOverview({ sentiment: env("sentiment"), board_flow: env("board_flow"), zt_pool: env("zt_pool") });
      })
      .then(setOverview)
      // 🔴 不吞:取不到这一屏 = 业务日与缺口保护都没了,必须让用户看见,
      //    否则页面会拿着旧数据继续显示得像正常一样
      .catch((e) => { setPageMeta(null); setPageErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setOvDone(true));
  };

  // 数据块占位：请求没回来 = 加载中；回来了但为空 = 数据源暂不可用（别让用户干等）
  const pending = (done: boolean) => (
    <p className="py-4 text-center text-sm text-muted-foreground/60">
      {done ? "暂无数据：可能是非交易时段或数据源暂时不可用，可点「大盘指数」旁的刷新重试" : "加载中…"}
    </p>
  );

  const refreshWatch = (codes: string[]) => {
    if (!codes.length) { setWatchQuotes({}); return; }
    setWatchLoading(true);
    api.quote(codes.join(",")).then(setWatchQuotes).catch(() => {}).finally(() => setWatchLoading(false));
  };

  useEffect(() => {
    loadIndices();
    refreshWatch(loadWatch());
  }, []);

  const addWatch = () => {
    // 支持一次粘贴多只（逗号 / 空格分隔）；全部无效或重复则清空输入、无副作用。
    const { next, added } = addCodes(watchCodes, watchInput);
    setWatchInput("");
    if (!added) return;
    setWatchCodes(next); refreshWatch(next);
    void saveWatch(next).catch(() => { setWatchCodes(loadWatch()); refreshWatch(loadWatch()); });
  };

  const removeWatch = (c: string) => {
    const next = watchCodes.filter((x) => x !== c);
    setWatchCodes(next); refreshWatch(next);
    void saveWatch(next).catch(() => { setWatchCodes(loadWatch()); refreshWatch(loadWatch()); });
  };


  /**
   * 🔴 业务日与各块状态**由 Core 一次算好**（`/page/review`），不再让每块自己判。
   *    页面各自拼旧端点时实测出现过：标题与"市场情绪"是 08-27，"短线情绪"却是 08-26 ——
   *    同一屏跨了两天，而**页面上看不出任何异常**。
   */
  const [pageMeta, setPageMeta] = useState<PageResult | null>(null);
  const [pageErr, setPageErr] = useState<string | null>(null);
  /** 这一屏在看哪一天 —— **只认 Core 给的业务日**（拿不到就是 null，不拿本地日期顶上） */
  const bizDay = pageMeta ? pageMeta.context.review_date ?? pageMeta.context.last_trading_day : null;



  const runReview = async () => {
    setReviewErr(null);
    setNeedConfig(false);
    if (!hasLlm()) { setNeedConfig(true); return; }
    setReviewLoading(true);
    setReview("");
    const prompt =
      "请根据这一屏的客观数据（含业务日与各块读法护栏）进行分析。\n" +
      "请用中文做当天复盘：整体涨跌、指数表现、情绪与资金面值得注意的点。\n" +
      "🔴 硬要求：① 标了【缺口】的块**不要就它下任何结论**，如实说这块没取到；" +
      "② 引用数字时带上它的读法护栏（【读法·xx】那几行），不要把口径丢掉；" +
      "③ 只做客观陈述与多视角分析，不预测涨跌、不推荐任何标的、不构成投资建议。";
    try {
      await chatStream([{ role: "user", content: prompt }], `今日大盘数据：${dataSummary}`, {
        onDelta: (t) => setReview((r) => r + t),
      });
    } catch (e) {
      setReviewErr(e instanceof ApiError ? e.message : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  const sentiment = overview?.sentiment;
  const sectors = overview?.sectors || [];
  // 🔴 取不到的那一格**不显示**,而不是显示 0 或 "-"。
  //    取数层给不出"真实涨停"这个口径(剔除一字新股 / ST),空着比编一个数诚实。
  const sentCells = (sentiment ? [
    { k: "上涨家数", v: sentiment.up, up: true },
    { k: "下跌家数", v: sentiment.down, up: false },
    { k: "平盘", v: sentiment.flat, up: null },
    { k: "涨停", v: sentiment.zt, up: true },
    { k: "真实涨停", v: sentiment.zt_real, up: true },
    { k: "跌停", v: sentiment.dt, up: false },
    { k: "真实跌停", v: sentiment.dt_real, up: false },
    { k: "活跃度", v: sentiment.active, up: null },
  ] : []).filter((c) => c.v !== null && c.v !== "" && c.v !== undefined);

  /**
   * 喂给 AI 的那份数据。
   *
   * 🔴 上一版这里**只拼了指数**（名/点位/涨跌幅），而页面下方的市场情绪、连板、成交额、
   *    板块资金一条都没进提示词 —— 界面上却写着"把当天客观数据打包给 AI"，那句话是不准确的。
   *    现在把整屏结构化数据都带上，**并且带上每块的读法护栏与状态**：
   *    只给数字不给读法，等于让模型替上游打包票。
   */
  const dataSummary = (() => {
    const lines: string[] = [];
    const ctx = pageMeta?.context;
    if (ctx?.review_date) lines.push(`【业务日】${ctx.review_date}（${ctx.review_reason ?? ctx.session_phase}）`);
    if (pageMeta?.mixed_ages) {
      // 🔴 只说"跨了业务日"是**不可操作**的 —— 模型不知道该怀疑哪一块。
      //    把各块的取数时刻一并给出，它才能在引用时限定"这条是几点的"。
      const stamps = pageMeta.blocks
        .filter((b) => b.fetched_at)
        .map((b) => `${b.title} ${b.fetched_at!.slice(0, 16).replace("T", " ")}`)
        .join("；");
      lines.push(`⚠️ 这一屏的数据来自不同业务日，跨日比较要当心。各块取数时刻：${stamps || "未记录"}`);
    }

    const validIndices = indices.filter((i) => i.price !== null && i.change_pct !== null);
    lines.push(validIndices.length
      ? `【A股指数】${validIndices.map((i) => `${i.name} ${i.price}（${i.change_pct! > 0 ? "+" : ""}${i.change_pct}%）`).join("；")}`
      : "【A股指数】未取到");
    // 拿不到价的那条**不写进去** —— 让模型看到 null 比不给还糟
    const gi = globalIdx.filter((i) => i.price !== null && i.change_pct !== null);
    lines.push(gi.length
      ? `【海外指数】${gi.map((i) => `${i.name} ${i.price}（${i.change_pct! > 0 ? "+" : ""}${i.change_pct}%）`).join("；")}`
      : `【海外指数】${globalErr ?? (globalDone ? "未取得可用数据" : "仍在加载")}；没有可引用的数据，不就此下结论。`);
    if (sentCells.length) lines.push(`【市场情绪】${sentCells.map((c) => `${c.k} ${c.v}`).join("；")}`);
    if (emotion) lines.push(`【短线情绪】${JSON.stringify(emotion).slice(0, 400)}`);
    const validSectors = sectors.filter((x) => x.net !== null);
    if (validSectors.length) lines.push(`【板块资金】${validSectors.slice(0, 12).map((x) => `${x.name} ${x.net}`).join("；")}`);
    if (turnover?.stocks?.length) lines.push(`【成交额居前】${turnover.stocks.slice(0, 10).map((r) => r.name).join("、")}`);

    // 取数层写的读法护栏 + 哪些块没取到 —— 两样都要让模型知道
    for (const b of pageMeta?.blocks ?? []) {
      if (b.note) lines.push(`【读法·${b.title}】${b.note}`);
      if (b.status === "failed") lines.push(`【缺口】${b.title} 这次没取到，不要就它下结论`);
      else if (b.status === "partial") lines.push(`【不完整】${b.title} 只取到一部分`);
    }
    return lines.join("\n");
  })();

  // 右上角那个 AI 按钮聊的就是这一页（登记处见 core/ai/pageContext）
  useAiPage({
    key: "daily-review",
    title: "每日复盘",
    context: `今日大盘数据：${dataSummary}`,
    suggestions: ["今天大盘怎么走", "哪些指数领涨领跌", "盘面有什么值得注意"],
  });

  return (
    <div>
      {/* 🔴 标题里的日期用 **Core 算出的业务日**,不用浏览器本地"今天" ——
          周末 / 休市 / 盘前回退上一个交易日时,两者会差一天,而同屏出现两个日期口径
          比没有日期更容易误读。业务日还没拿到就先不写日期,别先写一个再改。 */}
      <PageHeader
        title="每日复盘"
        subtitle={`${bizDay ? `${bizDay} · ` : ""}大盘 / 情绪 / 板块资金一屏看全，交给本地 Agent 做复盘`}
      />

      {pageErr && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          这一屏没取到：{pageErr}
          <span className="ml-1 text-destructive/80">—— 业务日与缺口提示都不可用，下面的数字不要当今天的看。</span>
        </div>
      )}

      {/*
        🔴 **这一屏在看哪一天，要写在屏上**。
           Core 会算「盘中看进行时 / 收盘后看今天 / 非交易日回退上一个交易日」，
           但页面此前没显示，用户默认以为都是"今天" —— 实测出现过同一屏里
           标题是 08-27、某一块却是 08-26，而**界面上看不出任何异常**。
        🔴 缺了哪块也要说：没取到就说没取到，别让空白被读成"今天没有"。
      */}
      {pageMeta && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            业务日 <span className="font-medium text-foreground">{pageMeta.context.review_date ?? pageMeta.context.last_trading_day}</span>
            {pageMeta.context.review_reason && <span className="ml-1 text-muted-foreground/70">（{pageMeta.context.review_reason}）</span>}
          </span>
          {pageMeta.mixed_ages && (
            <span className="text-destructive">⚠️ 这一屏的数据来自不同业务日，跨日比较要当心</span>
          )}
          {pageMeta.blocks.filter((b) => b.status === "failed").map((b) => (
            <span key={b.id} className="text-muted-foreground">
              <span className="text-destructive">缺</span> {b.title}（这次没取到）
            </span>
          ))}
          {pageMeta.blocks.filter((b) => b.status === "partial").map((b) => (
            <span key={b.id} className="text-muted-foreground">{b.title} 只取到一部分</span>
          ))}
        </div>
      )}

      {/* 1. 大盘指数（实时） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">大盘指数</h3>
        <button onClick={loadIndices} className="text-muted-foreground hover:text-primary" title="刷新"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {indices.length === 0
          ? [1, 2, 3, 4].map((i) => (
              <GlassCard key={i} className="p-3">
                <p className="text-xs text-muted-foreground">{idxErr ? "行情未接通" : "加载中…"}</p>
                <p className="mt-1 font-mono text-lg font-bold text-muted-foreground/40">—</p>
              </GlassCard>
            ))
          : indices.map((i) => (
              <GlassCard key={i.name} className="p-3">
                <p className="truncate text-xs text-muted-foreground">{i.name}</p>
                <p className={cn("mt-1 font-mono text-lg font-bold", pctColor(i.change_pct))}>{i.price ?? "—"}</p>
                <p className={cn("text-xs", pctColor(i.change_pct))}>{i.change_pct == null ? "—" : `${i.change_pct > 0 ? "+" : ""}${i.change_pct}%`}</p>
              </GlassCard>
            ))}
      </div>

      {/* 1b. 全球市场（隔夜外围脸色：A 股常看美股 / 港股） */}
      {(
        <>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Globe className="h-4 w-4" /> 全球市场</h3>
            <span className="text-[11px] text-muted-foreground/50">隔夜外围 · A 股常看美股 / 港股脸色</span>
          </div>
          {globalIdx.length === 0 && <p role="status" className="mb-4 text-sm text-muted-foreground">
            {globalErr ?? (globalDone ? "全球指数未取得可用数据，不代表市场没有变化。" : "全球指数加载中…")}
          </p>}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {globalIdx.map((g) => (
              <GlassCard key={g.key} className="p-3">
                <p className="truncate text-xs text-muted-foreground">{g.name} <span className="text-muted-foreground/40">{g.region}</span></p>
                <p className={cn("mt-1 font-mono text-lg font-bold", g.change_pct == null ? "text-foreground" : pctColor(g.change_pct))}>{g.price ?? "—"}</p>
                <p className={cn("text-xs", g.change_pct == null ? "text-muted-foreground" : pctColor(g.change_pct))}>
                  {g.change_pct == null ? "—" : `${g.change_pct > 0 ? "+" : ""}${g.change_pct}%`}
                </p>
              </GlassCard>
            ))}
          </div>
        </>
      )}

      {/* 2. 关注股票（自选） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">关注股票</h3>
        {watchCodes.length > 0 && (
          <button onClick={() => refreshWatch(watchCodes)} className="text-muted-foreground hover:text-primary" title="刷新价格">
            {watchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <GlassCard className="mb-6">
        <div className="mb-3 flex gap-2">
          <input
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value.slice(0, 80))}
            onKeyDown={(e) => e.key === "Enter" && addWatch()}
            placeholder="加自选：600519 AAPL 00700.HK"
            className="w-60 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <button onClick={addWatch}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25">
            <Plus className="h-4 w-4" /> 增加
          </button>
        </div>
        {watchCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground/60">加上你关注的股票，随时看它们的实时价格与涨跌。数据存本地，不上传。</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {watchCodes.map((c) => {
              const q = watchQuotes[c];
              return (
                <div key={c} className="group relative rounded-lg bg-muted/25 p-3">
                  <button onClick={() => removeWatch(c)} title="移除"
                    className="absolute right-1.5 top-1.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <p className="truncate text-xs text-muted-foreground">
                    {q?.name || c}
                    {q && <span className="ml-1.5 rounded border border-border px-1 py-0.5 font-mono text-[9px]">{q.currency}</span>}
                  </p>
                  <p className={cn("mt-1 font-mono text-lg font-bold", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>{q?.price ?? "—"}</p>
                  <p className={cn("text-xs", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>
                    {q?.change_pct == null ? c : `${q.change_pct > 0 ? "+" : ""}${q.change_pct}%`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>

      {/* 3. Agent 当日复盘 */}
      <GlassCard glow className="mb-6">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-semibold"><Sparkles className="h-4 w-4 text-primary" /> Agent 当日复盘</h3>
          <button onClick={runReview} disabled={reviewLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {reviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {review ? "重新复盘" : "让 Agent 复盘今天"}
          </button>
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            Agent 还没有可用模型。<Link to="/settings" className="text-primary">先为 Agent 选择模型</Link>，之后一键出复盘。
          </div>
        )}
        {reviewErr && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {reviewErr}
          </div>
        )}
        {review ? (
          <>
            <div className="prose prose-sm dark:prose-invert mt-4 max-w-none text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]}>{review}</ReactMarkdown></div>
            {!reviewLoading && <div className="mt-3"><SaveNoteButton kind="复盘" title={`每日复盘 ${bizDay ?? "（业务日未知）"}`} content={review} /></div>}
          </>
        ) : !needConfig && !reviewErr && !reviewLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">
            快速复盘会把这一屏已经取到的客观数据、缺口与读法护栏交给所选模型整理；它不会启动完整研究工具链。
            需要完整的多阶段流程，请进入<Link to="/research" className="text-primary hover:underline">个股研究</Link>。
          </p>
        ) : null}
      </GlassCard>

      {/* 4. 市场情绪 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Gauge className="h-4 w-4" /> 市场情绪</h3>
        {sentiment?.date && <span className="text-[11px] text-muted-foreground/50">{sentiment.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!sentiment?.breadth ? (
          pending(ovDone)
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { k: "大盘宽度", v: sentiment.breadth, hint: "冰点 / 偏弱 / 中性 / 偏强 / 普涨" },
                { k: "题材投机", v: sentiment.speculation, hint: "冰点 / 普通 / 活跃 / 亢奋" },
              ].map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/25 p-4">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{m.v}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/60">{m.hint}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {sentCells.map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2 text-center">
                  <p className="truncate text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.up === null ? "text-foreground" : c.up ? "text-danger" : "text-success")}>{c.v}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4b. 短线情绪（连板梯队 / 打板情绪，聚合口径零个股名） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Flame className="h-4 w-4" /> 短线情绪</h3>
        <span className="text-[11px] text-muted-foreground/50">连板股 · 打板情绪 · 客观公开榜单</span>
        {emotion?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{emotion.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!emotion || emotion.zt_count === undefined ? (
          pending(emoDone)
        ) : (
          <>
            {/* 关键计数 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { k: "涨停", v: `${emotion.zt_count}`, cls: "text-danger" },
                { k: "跌停", v: `${emotion.dt_count}`, cls: "text-success" },
                { k: "最高连板", v: `${emotion.max_boards} 板`, cls: "text-primary" },
                { k: "连板（2板+）", v: `${emotion.lianban_count} 家`, cls: "text-primary" },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/25 p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-xl font-bold", c.cls)}>{c.v}</p>
                </div>
              ))}
            </div>
            {/* 打板情绪比率 */}
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                { k: "封板率", v: emotion.seal_rate, hint: "封住 / 尝试涨停", strong: true },
                { k: "炸板率", v: emotion.break_rate, hint: "炸板 / 尝试涨停", strong: false },
                { k: "晋级率", v: emotion.promotion_rate, hint: "昨涨停今又停", strong: true },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.strong ? "text-danger" : "text-success")}>
                    {c.v == null ? "—" : `${(c.v * 100).toFixed(1)}%`}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">{c.hint}</p>
                </div>
              ))}
            </div>
            {/* 连板股清单（2 板以上，客观公开榜单） */}
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] text-muted-foreground">连板股（2 板以上连续涨停）· 客观公开榜单，非推荐 / 非预测</p>
              {emotion.lianban_stocks.length === 0 ? (
                <p className="text-xs text-muted-foreground/50">今日无 2 板以上个股</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                        {["名称", "连板", "现价", "涨停%", "成交额", "流通市值", "概念"].map((h) => (
                          <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {emotion.lianban_stocks.map((s) => (
                        <tr key={s.code} className="border-b border-border/30">
                          <td className="px-2 py-2"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono font-bold text-primary">{s.boards} 板</td>
                          <td className="px-2 py-2 font-mono">{s.price}</td>
                          <td className="px-2 py-2 font-mono text-danger">+{s.pct}%</td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.amount)}</td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.float_cap)}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4c. 全市场成交额 TOP20（客观公开榜单） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><BarChart3 className="h-4 w-4" /> 全市场成交额 TOP20</h3>
        <span className="text-[11px] text-muted-foreground/50">客观公开榜单，非推荐 / 非预测 / 不构成投资建议</span>
        {turnover?.updated && <span className="ml-auto text-[11px] text-muted-foreground/50">{turnover.updated}</span>}
      </div>
      <GlassCard className="mb-6">
        {!turnover || turnover.stocks.length === 0 ? (
          pending(toDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["#", "名称", "现价", "涨跌%", "成交额", "总市值", "行业"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {turnover.stocks.map((s, i) => (
                  <tr key={s.code} className="border-b border-border/30">
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground/50">{i + 1}</td>
                    <td className="px-2 py-2"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                    <td className="px-2 py-2 font-mono">{s.price ?? "—"}</td>
                    <td className={cn("px-2 py-2 font-mono", s.pct == null ? "text-muted-foreground" : pctColor(s.pct))}>
                      {s.pct == null ? "—" : `${s.pct > 0 ? "+" : ""}${s.pct}%`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono">{yi(s.amount)}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.mcap)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 5. 板块资金趋势榜（行业） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><TrendingUp className="h-4 w-4" /> 板块资金趋势榜</h3>
        <span className="text-[11px] text-muted-foreground/50">行业 · 按今日净流入排序</span>
      </div>
      <GlassCard className="mb-6">
        {sectors.length === 0 ? (
          pending(ovDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {/* 🔴 上游只给净额，拆不出「流入 / 流出 / 家数」——**那三列已经删掉**。
                      留着表头而每行都是横杠，比没有这几列更糟：它让人以为数据坏了。 */}
                  {["行业", "涨跌%", "今日净流入"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sectors.slice(0, 15).map((s) => (
                  <tr key={s.name} className="border-b border-border/30">
                    <td className="px-2 py-2 font-medium">{s.name}</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.pct))}>{s.pct == null ? "—" : `${s.pct > 0 ? "+" : ""}${s.pct}%`}</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.net))}>{s.net == null ? "—" : `${s.net > 0 ? "+" : ""}${fmt(s.net)} 亿`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 6. 资金轮动 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><ArrowDownUp className="h-4 w-4" /> 资金轮动</h3>
        <span className="text-[11px] text-muted-foreground/50">板块级净流入 / 流出</span>
      </div>
      <div className="mb-2 grid gap-4 md:grid-cols-2">
        {[
          // 🔴 判据是**净额的正负**，不是"在列表的哪一头"。
          //    旧写法 `slice(-6)` 把列表末尾当流出 —— 取回来的板块若全是净流入，
          //    末尾那几个照样是正数，于是「流出 Top」第一名显示 **+8.04 亿**（实测）。
          //    一个正数排在流出榜里，而**页面上看不出这是错的**。
          { title: "流入 Top", icon: TrendingUp, color: "text-danger", rows: sectors.filter((s) => s.net != null && s.net > 0).slice(0, 6) },
          { title: "流出 Top", icon: TrendingDown, color: "text-success", rows: sectors.filter((s) => s.net != null && s.net < 0).sort((a, b) => a.net! - b.net!).slice(0, 6) },
        ].map((col) => (
          <GlassCard key={col.title}>
            <h4 className={cn("mb-3 flex items-center gap-1.5 text-sm font-semibold", col.color)}><col.icon className="h-4 w-4" /> {col.title}</h4>
            {col.rows.length === 0 ? (
              pending(ovDone)
            ) : (
              <div className="space-y-1.5">
                {col.rows.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-3 border-b border-border/30 pb-1.5 text-sm last:border-0">
                    <span className="w-5 text-xs text-muted-foreground/50">{i + 1}</span>
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className={cn("font-mono text-xs", pctColor(s.pct))}>{s.pct == null ? "—" : `${s.pct > 0 ? "+" : ""}${s.pct}%`}</span>
                    <span className={cn("w-20 text-right font-mono text-xs", pctColor(s.net))}>{s.net == null ? "—" : `${s.net > 0 ? "+" : ""}${fmt(s.net)} 亿`}</span>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        ))}
      </div>

      <Disclaimer />
    </div>
  );
}
