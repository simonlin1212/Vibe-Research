import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search, FileText, Newspaper, Loader2, AlertCircle, LineChart, BarChart3, Megaphone,
  Wallet, Trophy, CalendarClock, Boxes, MessageSquare,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { EarningsSnapshot } from "@/components/ui/EarningsSnapshot";
import {
  api, ApiError, type Valuation, type Report, type NewsItem, type ValPercentile, type ValMetric,
  type Financials, type Announcement, type MarginRow, type BlockTradeRow, type HolderRow,
  type DividendRow, type FundFlowRow, type FundFlowMinute, type DragonTiger, type Lockup, type Blocks, type HotConcept, type QaRow,
  type ShareholderChangeRow,
  type GlobalStock, type HkCashflow, type GlobalFundamentals, type GlobalStatements,
  type GlobalSecFilings, type GlobalOptions,
  type UsKline, type GlobalStockNews, type StockBasicInfo, type ThsProfile,
  fundamentalsSourceLabel,
} from "@/lib/api";
import { boardLineParts } from "@/lib/stockBoardsHub";
import { cn } from "@/lib/utils";

// 金额格式化（后端资金单位：元 / 万元）
const yi = (v: number) => `${(v / 1e8).toFixed(2)} 亿`;

const fmt = (v: number | null | undefined, suffix = "") =>
  v === null || v === undefined ? "—" : `${v}${suffix}`;

// A股红涨绿跌（中国平台看美港股也用此惯例）
const pctColor = (p: number | null | undefined) =>
  p != null && p > 0 ? "text-danger" : p != null && p < 0 ? "text-success" : "text-muted-foreground";
const pctStr = (p: number | null | undefined) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p}%`);
// 美/港股金额（原生币种）
const curOf = (market: string) => (market === "HK" ? "港元" : market === "KR" ? "韩元" : "美元");
const mktName = (m: string) => (m === "HK" ? "港股" : m === "KR" ? "韩股" : "美股");
const bigMoney = (v: number | null, market: string) =>
  v == null ? "—" : v >= 1e12 ? `${(v / 1e12).toFixed(2)} 万亿${curOf(market)}` : `${(v / 1e8).toFixed(0)} 亿${curOf(market)}`;
const round2 = (v: number | null | undefined, suffix = "") =>
  v == null ? "—" : `${Math.round(v * 100) / 100}${suffix}`;

// 百分比：后端偶发给 null/缺字段时显示 —，不出现 "NaN%" / 误导性 "0.00%"
const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toFixed(2)}%`;

// 小指标块（复用于资金面/筹码卡）
function Metric({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="mt-0.5 font-mono text-base font-bold">{v}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// 估值历史分位带（理杏仁式）：绿=低估区 / 灰=合理区 / 红=高估区；只给位置，不划买卖。
function ValBand({ label, m }: { label: string; m: ValMetric }) {
  const span = Math.max(m.max - m.min, 1e-6);
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - m.min) / span) * 100));
  const p20 = pos(m.p20), p80 = pos(m.p80), cur = pos(m.current);
  const zoneColor = m.percentile < 20 ? "text-success" : m.percentile > 80 ? "text-danger" : "text-muted-foreground";
  const zoneLabel = m.percentile < 20 ? "低估区" : m.percentile > 80 ? "高估区" : "合理区";
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-1 text-sm">
        <span className="font-medium">{label} <span className="text-xs text-muted-foreground/60">{m.n} 点</span></span>
        <span className="text-muted-foreground">当前 <b className="font-mono text-foreground">{m.current}</b> · 近5年 <b className={cn("font-mono", zoneColor)}>{m.percentile}%</b> 分位（<span className={zoneColor}>{zoneLabel}</span>）</span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full">
        <div className="absolute inset-0 flex">
          <div className="bg-success/35" style={{ width: `${p20}%` }} />
          <div className="bg-muted" style={{ width: `${p80 - p20}%` }} />
          <div className="flex-1 bg-danger/35" />
        </div>
        <div className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-foreground shadow" style={{ left: `${cur}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/60">
        <span>低 {m.min}</span><span>20% {m.p20}</span><span>中 {m.p50}</span><span>80% {m.p80}</span><span>高 {m.max}</span>
      </div>
    </div>
  );
}

export function StockData({
  embedded = false,
  externalCode,
  hideSearch = false,
}: {
  embedded?: boolean;
  /** Controlled code from parent (e.g. light-chart selection); auto-queries on change */
  externalCode?: string | null;
  hideSearch?: boolean;
} = {}) {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => (externalCode || searchParams.get("code") || "").toUpperCase());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [val, setVal] = useState<Valuation | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [pctl, setPctl] = useState<ValPercentile | null>(null);
  const [fin, setFin] = useState<Financials | null>(null);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [depNote, setDepNote] = useState<string | null>(null);
  // 资金面 / 筹码 / 信号（v3.3 并入）
  const [margin, setMargin] = useState<MarginRow[]>([]);
  const [blockT, setBlockT] = useState<BlockTradeRow[]>([]);
  const [holders, setHolders] = useState<HolderRow[]>([]);
  const [shChanges, setShChanges] = useState<ShareholderChangeRow[]>([]);
  const [dividend, setDividend] = useState<DividendRow[]>([]);
  const [fundFlow, setFundFlow] = useState<FundFlowRow[]>([]);
  const [fundMin, setFundMin] = useState<FundFlowMinute | null>(null);
  const [dt, setDt] = useState<DragonTiger | null>(null);
  const [lockup, setLockup] = useState<Lockup | null>(null);
  const [blocks, setBlocks] = useState<Blocks | null>(null);
  const [hotCon, setHotCon] = useState<HotConcept[]>([]);
  const [qa, setQa] = useState<QaRow[] | null>(null);
  const [basic, setBasic] = useState<StockBasicInfo | null>(null);
  const [ths, setThs] = useState<ThsProfile | null>(null);
  const [gstock, setGStock] = useState<GlobalStock | null>(null);  // 美股 / 港股
  const [cashflow, setCashflow] = useState<HkCashflow | null>(null);  // 港股现金流量表（仅港股）
  const [gFund, setGFund] = useState<GlobalFundamentals | null>(null);
  const [gStmt, setGStmt] = useState<GlobalStatements | null>(null);
  const [gStmtTab, setGStmtTab] = useState<"income" | "balance" | "cashflow">("income");
  const [gSec, setGSec] = useState<GlobalSecFilings | null>(null);
  const [gSecNote, setGSecNote] = useState<string | null>(null);
  const [gOpt, setGOpt] = useState<GlobalOptions | null>(null);
  const [gOptTab, setGOptTab] = useState<"0dte" | "7d">("0dte");
  const [gKline, setGKline] = useState<UsKline | null>(null);
  const [gNews, setGNews] = useState<GlobalStockNews | null>(null);
  const runIdRef = useRef(0);

  const run = async (override?: string) => {
    const c = (override ?? code).trim().toUpperCase();
    if (override) setCode(c);
    if (!c) { setErr("请输入代码"); return; }
    const rid = ++runIdRef.current;
    setLoading(true); setErr(null); setDepNote(null); setVal(null); setReports([]); setNews([]); setPctl(null); setFin(null); setAnns([]);
    setMargin([]); setBlockT([]); setHolders([]); setShChanges([]); setDividend([]); setFundFlow([]); setFundMin(null); setDt(null); setLockup(null); setBlocks(null); setHotCon([]); setQa(null); setBasic(null); setThs(null);
    setGStock(null); setCashflow(null);
    setGFund(null); setGStmt(null); setGStmtTab("income"); setGSec(null); setGSecNote(null);
    setGOpt(null); setGOptTab("0dte"); setGKline(null); setGNews(null);

    // 6 位纯数字 = A 股；否则（字母 / 港股短代码）走美股 / 港股（global-stock-data）
    if (!/^\d{6}$/.test(c)) {
      const gOk = <T,>(set: (v: T) => void) => (v: T) => { if (rid === runIdRef.current) set(v); };
      // 港股现金流独立回填（美股返回 404 → 静默留空，卡片不渲染）
      api.hkCashflow(c).then(gOk(setCashflow)).catch(() => { if (rid === runIdRef.current) setCashflow(null); });
      api.globalFundamentals(c).then(gOk(setGFund)).catch(() => { if (rid === runIdRef.current) setGFund(null); });
      api.globalStatements(c, "income").then(gOk(setGStmt)).catch(() => { if (rid === runIdRef.current) setGStmt(null); });
      api.globalOptions(c).then(gOk(setGOpt)).catch(() => { if (rid === runIdRef.current) setGOpt(null); });
      api.globalStockNews(c, 12).then(gOk(setGNews)).catch(() => { if (rid === runIdRef.current) setGNews(null); });
      api.globalSecFilings(c).then(gOk(setGSec)).catch((e) => {
        if (rid !== runIdRef.current) return;
        setGSec(null);
        if (e instanceof ApiError && (e.status === 503 || e.status === 502)) setGSecNote(e.message);
      });
      try {
        const g = await api.globalStock(c);
        if (rid === runIdRef.current) setGStock(g);
        // US daily K only. KR / HK skipped.
        if (g.market !== "KR" && g.market !== "HK") {
          api.usKline(g.code, 60).then(gOk(setGKline)).catch(() => { if (rid === runIdRef.current) setGKline(null); });
        }
      } catch (e) {
        if (rid === runIdRef.current) setErr(e instanceof ApiError ? e.message : "查询失败");
      } finally {
        if (rid === runIdRef.current) setLoading(false);
      }
      return;
    }

    // A 股：竞态守卫（快速换代码时只让最新一次回填）+ 资金面/筹码独立回填、不阻塞主数据
    const ok = <T,>(set: (v: T) => void) => (v: T) => { if (rid === runIdRef.current) set(v); };
    api.margin(c).then(ok(setMargin)).catch(() => {});
    api.blockTrade(c).then(ok(setBlockT)).catch(() => {});
    api.holders(c).then(ok(setHolders)).catch(() => {});
    api.shareholderChanges({ code: c, limit: 20 }).then((d) => ok(setShChanges)(d.rows || [])).catch(() => {
      if (rid === runIdRef.current) setShChanges([]);
    });
    api.dividend(c).then(ok(setDividend)).catch(() => {});
    api.fundFlow(c).then(ok(setFundFlow)).catch(() => {});
    api.fundFlowMinute(c).then(ok(setFundMin)).catch(() => { if (rid === runIdRef.current) setFundMin(null); });
    api.dragonTiger(c).then(ok(setDt)).catch(() => {});
    api.lockup(c).then(ok(setLockup)).catch(() => {});
    api.blocks(c).then(ok(setBlocks)).catch(() => {});
    api.hotConcepts(c).then(ok(setHotCon)).catch(() => {});
    api.investorQa(c).then(ok(setQa)).catch(() => { if (rid === runIdRef.current) setQa([]); });
    api.stockBasic(c).then(ok(setBasic)).catch(() => { if (rid === runIdRef.current) setBasic(null); });
    api.thsProfile(c).then(ok(setThs)).catch(() => { if (rid === runIdRef.current) setThs(null); });
    try {
      // 行情+估值+研报+历史分位+财务+公告（新闻单独降级）
      const [v, r, p, f, a] = await Promise.all([
        api.valuation(c),
        api.reports(c).catch(() => []),
        api.percentile(c).catch(() => null),
        api.financials(c).catch(() => null),
        api.announcements(c).catch(() => []),
      ]);
      if (rid !== runIdRef.current) return;
      setVal(v);
      setReports(r);
      setPctl(p);
      setFin(f);
      setAnns(a);
      try {
        const n = await api.news(c);
        if (rid === runIdRef.current) setNews(n);
      } catch (e) {
        if (rid === runIdRef.current && e instanceof ApiError && e.status === 501) setDepNote(e.message);
      }
    } catch (e) {
      if (rid !== runIdRef.current) return;
      setErr(e instanceof ApiError ? e.message : "查询失败");
    } finally {
      if (rid === runIdRef.current) setLoading(false);
    }
  };

  // Parent-driven code (light chart) takes priority over URL deep-link
  const lastExtRef = useRef<string>("");
  useEffect(() => {
    if (externalCode === undefined) return;
    const q = (externalCode || "").trim().toUpperCase();
    if (!q || q === lastExtRef.current) return;
    lastExtRef.current = q;
    void run(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to external selection
  }, [externalCode]);

  // Deep-link: /a-share?tab=kline&code=600519
  const autoQueryRef = useRef(false);
  useEffect(() => {
    if (externalCode !== undefined) return; // parent owns the code
    const q = (searchParams.get("code") || "").trim().toUpperCase();
    if (!q) return;
    if (autoQueryRef.current && q === code.trim().toUpperCase()) return;
    autoQueryRef.current = true;
    void run(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to code query changes
  }, [searchParams, externalCode]);

  const metrics = val ? [
    { k: "现价", v: fmt(val.price) },
    { k: "PE(TTM)", v: fmt(val.pe_ttm) },
    { k: "PB", v: fmt(val.pb) },
    { k: "总市值", v: fmt(val.mcap_yi, " 亿") },
    { k: "26E EPS", v: fmt(val.eps_26e) },
    { k: "前向PE", v: fmt(val.pe_26e) },
    { k: "PEG", v: fmt(val.peg) },
    { k: "消化年数", v: fmt(val.digest_years, " 年") },
  ] : [];

  const conceptTags = [...new Set([
    ...(blocks?.concept_tags ?? []),
    ...(basic?.concepts ?? []),
    ...(ths?.concepts ?? []),
  ])].slice(0, 24);
  const headerBoard = boardLineParts({
    industry: basic?.industry || ths?.industry || "",
    concepts: conceptTags,
  });

  const aiContext = val
    ? `个股：${val.name}（${val.code}）\n现价 ${val.price} · PE(TTM) ${val.pe_ttm} · PB ${val.pb} · 市值 ${val.mcap_yi}亿\n` +
      `26E EPS ${val.eps_26e ?? "—"} · 前向PE ${val.pe_26e ?? "—"} · PEG ${val.peg ?? "—"} · 消化 ${val.digest_years ?? "—"}年 · 机构覆盖 ${val.analyst_count} 家\n` +
      (pctl?.metrics.pe_ttm ? `估值历史分位(近5年)：PE-TTM 处于 ${pctl.metrics.pe_ttm.percentile}% 分位、PB 处于 ${pctl.metrics.pb?.percentile ?? "—"}% 分位\n` : "") +
      (fin?.revenue ? `财务(${fin.period ?? "—"})：营收 ${fin.revenue}(同比${fin.revenue_yoy ?? "—"})、净利 ${fin.net_profit ?? "—"}(同比${fin.net_profit_yoy ?? "—"})、ROE ${fin.roe ?? "—"}、毛利率 ${fin.gross_margin ?? "—"}\n` : "") +
      (anns.length ? `近期公告：${anns.slice(0, 5).map((a) => a.title.replace(/^[^:：]*[:：]/, "")).join("；")}\n` : "") +
      `近期研报：${reports.slice(0, 5).map((r) => r.title).join("；") || "无"}`
    : "还没查询个股。输入 6 位代码后可让 AI 基于客观数据帮你分析。";

  const loadGStmt = async (tab: "income" | "balance" | "cashflow") => {
    if (!gstock) return;
    const code = gstock.code;
    setGStmtTab(tab);
    try {
      const s = await api.globalStatements(code, tab);
      setGStmt(s);
    } catch {
      setGStmt(null);
    }
  };

  const pctRatio = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(2)}%`;

  const gAiContext = gstock
    ? `个股（${mktName(gstock.market)}）：${gstock.name}（${gstock.code}）\n` +
      `现价 ${gstock.quote.price ?? "—"} · 涨跌 ${pctStr(gstock.quote.change_pct)} · 总市值 ${bigMoney(gstock.quote.mcap, gstock.market)}\n` +
      (gFund?.valuation
        ? `估值：PE(TTM) ${gFund.valuation.trailing_pe ?? "—"} · 前向PE ${gFund.valuation.forward_pe ?? "—"} · PEG ${gFund.valuation.peg_ratio ?? "—"} · PB ${gFund.valuation.price_to_book ?? "—"} · 目标价 ${gFund.valuation.target_mean ?? "—"} · 评级 ${gFund.valuation.recommendation ?? "—"}\n`
        : "") +
      (gOpt?.summary_0dte
        ? `期权0DTE：P/C量比 ${gOpt.summary_0dte.put_call_volume_ratio ?? "—"} · 量加权IV ${gOpt.summary_0dte.volume_weighted_iv != null ? (gOpt.summary_0dte.volume_weighted_iv * 100).toFixed(1) + "%" : "—"} · 净delta敞口(股) ${gOpt.summary_0dte.net_delta_exposure_shares}\n`
        : "") +
      (gstock.metrics
        ? `财务(${gstock.metrics.report_date})：营收 ${bigMoney(gstock.metrics.revenue, gstock.market)}(同比${round2(gstock.metrics.revenue_yoy, "%")})、归母净利 ${bigMoney(gstock.metrics.net_profit, gstock.market)}、EPS ${gstock.metrics.eps ?? "—"}、ROE ${round2(gstock.metrics.roe, "%")}、毛利率 ${round2(gstock.metrics.gross_margin, "%")}、净利率 ${round2(gstock.metrics.net_margin, "%")}、资产负债率 ${round2(gstock.metrics.debt_ratio, "%")}`
        : "")
    : "";

  return (
    <div>
      {!embedded && (
        <PageHeader
          title="个股查询"
          subtitle="行情 · 估值 · 研报 · 新闻 —— 客观数据配齐，判断交给你的 AI"
          actions={(val || gstock) && (
            <AskAiButton
              context={gstock ? gAiContext : aiContext}
              scopeKey={gstock ? `g:${gstock.code}` : val?.code}
              label="让 AI 读这些数据"
              suggestions={gstock
                ? ["这家公司基本面怎么样", "盈利能力如何", "有什么风险"]
                : ["这个估值贵不贵", "机构一致预期怎么看", "近期研报的分歧点", "有什么风险"]}
            />
          )}
        />
      )}

      {/* 查询框（轻量图表内嵌时由左侧自选驱动, 可隐藏搜索） */}
      {!hideSearch ? (
        <div className={cn(
          "mb-5 flex flex-wrap items-center gap-2",
          embedded && "border border-[#2a2a2a] bg-black px-2 py-1.5",
        )}>
          {embedded && (
            <div className="mr-1 hidden min-w-0 sm:block">
              <p className="text-sm font-medium text-foreground">个股查询</p>
              <p className="text-[11px] text-muted-foreground/65">行情 · 估值 · 研报 · 资金</p>
            </div>
          )}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9.]/g, "").toUpperCase().slice(0, 12))}
            onKeyDown={(e) => e.key === "Enter" && void run()}
            placeholder="A 股 6 位代码，或美股/港股/韩股（AAPL / 00700 / 005930.KS）"
            className="field-input w-72 sm:w-80"
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary btn-press ring-1 ring-primary/20 hover:bg-primary/25 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            查询
          </button>
          {embedded && (val || gstock) && (
            <div className="ml-auto">
              <AskAiButton
                context={gstock ? gAiContext : aiContext}
                scopeKey={gstock ? `g:${gstock.code}` : val?.code}
                label="让 AI 读这些数据"
                suggestions={gstock
                  ? ["这家公司基本面怎么样", "盈利能力如何", "有什么风险"]
                  : ["这个估值贵不贵", "机构一致预期怎么看", "近期研报的分歧点", "有什么风险"]}
              />
            </div>
          )}
        </div>
      ) : (
        (val || gstock) && (
          <div className="mb-4 flex justify-end">
            <AskAiButton
              context={gstock ? gAiContext : aiContext}
              scopeKey={gstock ? `g:${gstock.code}` : val?.code}
              label="让 AI 读这些数据"
              suggestions={gstock
                ? ["这家公司基本面怎么样", "盈利能力如何", "有什么风险"]
                : ["这个估值贵不贵", "机构一致预期怎么看", "近期研报的分歧点", "有什么风险"]}
            />
          </div>
        )
      )}

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {/* 美股 / 港股视图（global-stock-data，东财域内源） */}
      {gstock && (
        <>
          <GlassCard glow className="mb-4">
            <div className="mb-4 flex items-baseline gap-2">
              <h2 className="text-xl font-bold">{gstock.name}</h2>
              <span className="font-mono text-sm text-muted-foreground">{gstock.code}</span>
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{gstock.market}</span>
              <span className="ml-auto text-xs text-muted-foreground">{mktName(gstock.market)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { k: "现价", v: fmt(gstock.quote.price), cls: pctColor(gstock.quote.change_pct) },
                { k: "涨跌幅", v: pctStr(gstock.quote.change_pct), cls: pctColor(gstock.quote.change_pct) },
                { k: "总市值", v: bigMoney(gstock.quote.mcap, gstock.market), cls: "" },
                { k: "成交额", v: bigMoney(gstock.quote.amount, gstock.market), cls: "" },
                { k: "开盘", v: fmt(gstock.quote.open), cls: "" },
                { k: "最高", v: fmt(gstock.quote.high), cls: "" },
                { k: "最低", v: fmt(gstock.quote.low), cls: "" },
                { k: "昨收", v: fmt(gstock.quote.prev_close), cls: "" },
              ].map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className={cn("mt-0.5 font-mono text-base font-bold", m.cls)}>{m.v}</p>
                </div>
              ))}
            </div>
          </GlassCard>

          {gKline && gKline.bars.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <LineChart className="h-4 w-4 text-primary" /> 日 K
                <span className="text-xs font-normal text-muted-foreground/60">
                  · {gKline.adjust === "qfq" ? "前复权" : "不复权"} · {gKline.source} · 近 {Math.min(15, gKline.bars.length)} 日
                </span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 text-left font-normal">日期</th>
                      <th className="px-2 py-1 text-right font-normal">开</th>
                      <th className="px-2 py-1 text-right font-normal">高</th>
                      <th className="px-2 py-1 text-right font-normal">低</th>
                      <th className="px-2 py-1 text-right font-normal">收</th>
                      <th className="px-2 py-1 text-right font-normal">量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...gKline.bars].slice(-15).reverse().map((b) => (
                      <tr key={b.date} className="border-t border-border/40">
                        <td className="py-1.5 text-muted-foreground">{b.date}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{round2(b.open)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{round2(b.high)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{round2(b.low)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{round2(b.close)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-xs">{b.volume.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          {gFund?.valuation && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <LineChart className="h-4 w-4 text-primary" /> 估值与盈利能力
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">
                {fundamentalsSourceLabel(gFund.source ?? gFund.valuation.source)} · 仅客观指标，不含买卖建议。
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "PE(TTM)", v: round2(gFund.valuation.trailing_pe) },
                  { k: "前向 PE", v: round2(gFund.valuation.forward_pe) },
                  { k: "PEG", v: round2(gFund.valuation.peg_ratio) },
                  { k: "PB", v: round2(gFund.valuation.price_to_book) },
                  { k: "目标均价", v: round2(gFund.valuation.target_mean) },
                  { k: "共识评级", v: gFund.valuation.recommendation ?? "—" },
                  { k: "Beta", v: round2(gFund.valuation.beta) },
                  { k: "股息率", v: pctRatio(gFund.valuation.dividend_yield) },
                  { k: "毛利率", v: pctRatio(gFund.valuation.gross_margin) },
                  { k: "净利率", v: pctRatio(gFund.valuation.profit_margin) },
                  { k: "ROE", v: pctRatio(gFund.valuation.return_on_equity) },
                  { k: "营收增长", v: pctRatio(gFund.valuation.revenue_growth) },
                ].map((m) => (
                  <Metric key={m.k} k={m.k} v={String(m.v)} />
                ))}
              </div>
            </GlassCard>
          )}

          {gstock.metrics && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <BarChart3 className="h-4 w-4 text-primary" /> 关键财务指标
                <span className="text-xs font-normal text-muted-foreground/60">· {gstock.metrics.report_date}</span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">东财 GMAININDICATOR，最新报告期。金额为原生币种。</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "营业收入", v: bigMoney(gstock.metrics.revenue, gstock.market), yoy: gstock.metrics.revenue_yoy != null ? round2(gstock.metrics.revenue_yoy, "%") : "" },
                  { k: "归母净利", v: bigMoney(gstock.metrics.net_profit, gstock.market), yoy: "" },
                  { k: "每股收益 EPS", v: round2(gstock.metrics.eps), yoy: "" },
                  { k: "ROE", v: round2(gstock.metrics.roe, "%"), yoy: "" },
                  { k: "毛利率", v: round2(gstock.metrics.gross_margin, "%"), yoy: "" },
                  { k: "净利率", v: round2(gstock.metrics.net_margin, "%"), yoy: "" },
                  { k: "资产负债率", v: round2(gstock.metrics.debt_ratio, "%"), yoy: "" },
                ].map((m) => (
                  <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{m.k}</p>
                    <p className="mt-0.5 font-mono text-base font-bold">{m.v}</p>
                    {m.yoy && <p className="text-[11px] text-muted-foreground">同比 {m.yoy}</p>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {(gStmt || gstock.market !== "KR") && (
            <GlassCard className="mb-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <BarChart3 className="h-4 w-4 text-primary" /> 财务报表
                  {gStmt?.currency && (
                    <span className="text-xs font-normal text-muted-foreground/60">· 单位：亿{gStmt.currency}</span>
                  )}
                </h3>
                <div className="flex gap-1">
                  {([
                    ["income", "利润表"],
                    ["balance", "资产负债表"],
                    ["cashflow", "现金流量表"],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => void loadGStmt(k)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs",
                        gStmtTab === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-[11px] text-muted-foreground/60">东财 F10/SK 关键科目 · 负数标绿。</p>
              {gStmt && gStmt.periods.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="py-1 pr-3 text-left font-normal">科目</th>
                        {gStmt.periods.slice(0, 5).map((p) => (
                          <th key={p.report_date} className="px-2 py-1 text-right font-normal">{p.report_date.slice(0, 7)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gStmt.item_order.map((it) => (
                        <tr key={it} className="border-t border-border/40">
                          <td className="py-1.5 pr-3 text-muted-foreground">{it}</td>
                          {gStmt.periods.slice(0, 5).map((p) => {
                            const amt = p.items[it]?.amount ?? null;
                            return (
                              <td key={p.report_date} className={cn("px-2 py-1.5 text-right font-mono", amt != null && amt < 0 ? "text-success" : "")}>
                                {amt == null ? "—" : Math.abs(amt) >= 1e6 ? (amt / 1e8).toFixed(1) : amt.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="py-3 text-center text-xs text-muted-foreground/60">暂无该报表关键科目</p>
              )}
            </GlassCard>
          )}

          {cashflow && cashflow.periods.length > 0 && gstock.market === "HK" && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <BarChart3 className="h-4 w-4 text-primary" /> 港股现金流明细
                <span className="text-xs font-normal text-muted-foreground/60">· 单位：亿{cashflow.currency ?? ""}</span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">东财 RPT_HKSK_FN_CASHFLOW · 季度为年初至今累计。</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 pr-3 text-left font-normal">科目</th>
                      {cashflow.periods.slice(0, 5).map((p) => (
                        <th key={p.report_date} className="px-2 py-1 text-right font-normal">{p.report_date.slice(0, 7)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cashflow.item_order.map((it) => (
                      <tr key={it} className="border-t border-border/40">
                        <td className="py-1.5 pr-3 text-muted-foreground">{it}</td>
                        {cashflow.periods.slice(0, 5).map((p) => {
                          const amt = p.items[it]?.amount ?? null;
                          return (
                            <td key={p.report_date} className={cn("px-2 py-1.5 text-right font-mono", amt != null && amt < 0 ? "text-success" : "")}>
                              {amt == null ? "—" : (amt / 1e8).toFixed(1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          {gFund?.analyst && (gFund.analyst.rating_trend.length > 0 || gFund.analyst.eps_trend.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Megaphone className="h-4 w-4 text-primary" /> 分析师预期
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">Yahoo · EPS 预期与评级分布，非投资建议。</p>
              {gFund.analyst.rating_trend[0] && (
                <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {[
                    { k: "强买", v: gFund.analyst.rating_trend[0].strong_buy },
                    { k: "买入", v: gFund.analyst.rating_trend[0].buy },
                    { k: "持有", v: gFund.analyst.rating_trend[0].hold },
                    { k: "卖出", v: gFund.analyst.rating_trend[0].sell },
                    { k: "强卖", v: gFund.analyst.rating_trend[0].strong_sell },
                  ].map((m) => (
                    <Metric key={m.k} k={`${m.k} · ${gFund.analyst!.rating_trend[0].period ?? ""}`} v={String(m.v ?? "—")} />
                  ))}
                </div>
              )}
              {gFund.analyst.eps_trend.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="py-1 text-left font-normal">期间</th>
                        <th className="px-2 py-1 text-right font-normal">EPS 预期</th>
                        <th className="px-2 py-1 text-right font-normal">高/低</th>
                        <th className="px-2 py-1 text-right font-normal">分析师数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gFund.analyst.eps_trend.slice(0, 6).map((t) => (
                        <tr key={`${t.period}-${t.end_date}`} className="border-t border-border/40">
                          <td className="py-1.5 text-muted-foreground">{t.period ?? "—"}{t.end_date ? ` · ${t.end_date}` : ""}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{round2(t.eps_estimate)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">{round2(t.eps_high)} / {round2(t.eps_low)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{t.num_analysts ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GlassCard>
          )}

          {gFund?.holders && (gFund.holders.top_holders.length > 0 || gFund.holders.overview.institutions_pct != null) && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Boxes className="h-4 w-4 text-primary" /> 机构持仓
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">Yahoo · 前十大机构与持股结构概览。</p>
              <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric k="机构持股" v={pctRatio(gFund.holders.overview.institutions_pct)} />
                <Metric k="内部人" v={pctRatio(gFund.holders.overview.insiders_pct)} />
                <Metric k="机构数" v={fmt(gFund.holders.overview.institutions_count)} />
                <Metric k="机构占流通" v={pctRatio(gFund.holders.overview.institutions_float_pct)} />
              </div>
              {gFund.holders.top_holders.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="py-1 text-left font-normal">机构</th>
                        <th className="px-2 py-1 text-right font-normal">持股占比</th>
                        <th className="px-2 py-1 text-right font-normal">股数</th>
                        <th className="px-2 py-1 text-right font-normal">报告日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gFund.holders.top_holders.map((h) => (
                        <tr key={h.name} className="border-t border-border/40">
                          <td className="py-1.5 pr-2">{h.name ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{pctRatio(h.pct_held)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-xs">{h.shares != null ? h.shares.toLocaleString() : "—"}</td>
                          <td className="px-2 py-1.5 text-right text-xs text-muted-foreground">{h.report_date ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GlassCard>
          )}

          {gOpt && (
            <GlassCard className="mb-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <CalendarClock className="h-4 w-4 text-primary" /> 期权 · CBOE
                  <span className="text-xs font-normal text-muted-foreground/60">
                    · spot {round2(gOpt.spot)} · 美东 {gOpt.et_today}
                  </span>
                </h3>
                <div className="flex gap-1">
                  {([
                    ["0dte", "0DTE 异动"],
                    ["7d", "近 7 日异动"],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setGOptTab(k)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs",
                        gOptTab === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-[11px] text-muted-foreground/60">
                延时数据 · 个人研究用途（合规 C 级）· vol/OI≥1 视为新建仓倾向 · 不构成交易建议
              </p>
              {(() => {
                const sum = gOptTab === "0dte" ? gOpt.summary_0dte : gOpt.summary_7d;
                const flow = gOptTab === "0dte" ? gOpt.unusual_0dte : gOpt.unusual_7d;
                return (
                  <>
                    {sum ? (
                      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Metric k="P/C 量比" v={round2(sum.put_call_volume_ratio)} />
                        <Metric
                          k="量加权 IV"
                          v={sum.volume_weighted_iv == null ? "—" : `${(sum.volume_weighted_iv * 100).toFixed(1)}%`}
                        />
                        <Metric k="净 delta 敞口(股)" v={sum.net_delta_exposure_shares.toLocaleString()} />
                        <Metric k="成交合约数" v={`${sum.contracts_traded} / ${sum.contracts_total}`} />
                      </div>
                    ) : (
                      <p className="mb-3 text-xs text-muted-foreground/60">
                        {gOptTab === "0dte" ? "今日无 0DTE 合约（周末/无到期日）" : "近 7 日暂无汇总"}
                      </p>
                    )}
                    {gOptTab === "0dte" && gOpt.atm_0dte.length > 0 && (
                      <div className="mb-3">
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">0DTE ATM 附近</p>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[560px] text-sm">
                            <thead>
                              <tr className="text-xs text-muted-foreground">
                                <th className="py-1 text-left font-normal">类型</th>
                                <th className="px-2 py-1 text-right font-normal">行权价</th>
                                <th className="px-2 py-1 text-right font-normal">成交量</th>
                                <th className="px-2 py-1 text-right font-normal">OI</th>
                                <th className="px-2 py-1 text-right font-normal">IV</th>
                                <th className="px-2 py-1 text-right font-normal">Delta</th>
                              </tr>
                            </thead>
                            <tbody>
                              {gOpt.atm_0dte.map((c) => (
                                <tr key={c.symbol} className="border-t border-border/40">
                                  <td className={cn("py-1.5", c.type === "call" ? "text-danger" : "text-success")}>
                                    {c.type === "call" ? "Call" : "Put"}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono">{round2(c.strike)}</td>
                                  <td className="px-2 py-1.5 text-right font-mono">{c.volume?.toLocaleString() ?? "—"}</td>
                                  <td className="px-2 py-1.5 text-right font-mono">{c.open_interest?.toLocaleString() ?? "—"}</td>
                                  <td className="px-2 py-1.5 text-right font-mono">
                                    {c.iv == null ? "—" : `${(c.iv * 100).toFixed(1)}%`}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono">{round2(c.delta)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {flow.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm">
                          <thead>
                            <tr className="text-xs text-muted-foreground">
                              <th className="py-1 text-left font-normal">合约</th>
                              <th className="px-2 py-1 text-right font-normal">行权价</th>
                              <th className="px-2 py-1 text-right font-normal">成交量</th>
                              <th className="px-2 py-1 text-right font-normal">vol/OI</th>
                              <th className="px-2 py-1 text-right font-normal">IV</th>
                              <th className="px-2 py-1 text-right font-normal">Delta</th>
                            </tr>
                          </thead>
                          <tbody>
                            {flow.map((c) => (
                              <tr key={c.symbol} className="border-t border-border/40">
                                <td className="py-1.5 pr-2">
                                  <span className={cn("mr-1.5 text-xs", c.type === "call" ? "text-danger" : "text-success")}>
                                    {c.type === "call" ? "C" : "P"}
                                  </span>
                                  <span className="font-mono text-xs text-muted-foreground">{c.expiry}</span>
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">{round2(c.strike)}</td>
                                <td className="px-2 py-1.5 text-right font-mono">{c.volume?.toLocaleString() ?? "—"}</td>
                                <td className="px-2 py-1.5 text-right font-mono">{c.vol_oi_ratio ?? "∞"}</td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {c.iv == null ? "—" : `${(c.iv * 100).toFixed(1)}%`}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">{round2(c.delta)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="py-2 text-center text-xs text-muted-foreground/60">暂无符合阈值的异动合约</p>
                    )}
                  </>
                );
              })()}
            </GlassCard>
          )}

          {gNews && gNews.items.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Newspaper className="h-4 w-4 text-primary" /> 个股新闻
                <span className="text-xs font-normal text-muted-foreground/60">
                  · Yahoo · C 级 · {gNews.yahoo_symbol ?? gNews.code}
                </span>
              </h3>
              <div className="mt-3 space-y-2">
                {gNews.items.slice(0, 12).map((n, i) => (
                  <div key={`${n.link ?? n.title}-${i}`} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                      {(n.publish_time || "").slice(0, 16) || "—"}
                    </span>
                    {n.link ? (
                      <a href={n.link} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-primary">
                        {n.title}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{n.title}</span>
                    )}
                    {n.publisher && (
                      <span className="hidden w-24 shrink-0 truncate text-right text-[11px] text-muted-foreground sm:block">
                        {n.publisher}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {(gSec || gSecNote) && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <FileText className="h-4 w-4 text-primary" /> SEC 申报
              </h3>
              {gSecNote && !gSec ? (
                <p className="py-2 text-xs text-muted-foreground">{gSecNote}</p>
              ) : gSec ? (
                <>
                  <p className="mb-3 text-[11px] text-muted-foreground/60">
                    EDGAR · {gSec.company_name ?? gSec.name} · CIK {gSec.cik}
                  </p>
                  <div className="max-h-72 space-y-1.5 overflow-y-auto">
                    {gSec.filings.slice(0, 25).map((f) => (
                      <a
                        key={`${f.form}-${f.date}-${f.url}`}
                        href={f.url || undefined}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(
                          "flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40",
                          !f.url && "pointer-events-none",
                        )}
                      >
                        <span className="w-14 shrink-0 font-mono text-xs text-primary">{f.form}</span>
                        <span className="w-24 shrink-0 text-xs text-muted-foreground">{f.date}</span>
                        <span className="min-w-0 truncate text-muted-foreground">{f.form_label || f.description || "—"}</span>
                      </a>
                    ))}
                  </div>
                </>
              ) : null}
            </GlassCard>
          )}

          <p className="text-xs text-muted-foreground/60">
            美股 / 港股数据来自 <a href="https://github.com/simonlin1212/global-stock-data" target="_blank" rel="noreferrer" className="hover:text-primary">global-stock-data</a>
            （东财 / Yahoo / SEC / CBOE）· 金额为原生币种 · 仅客观数据，不含买卖建议。
          </p>
        </>
      )}

      {val && (
        <>
          <GlassCard glow className="mb-4">
            <div className="mb-4 flex items-baseline gap-2">
              <h2 className="text-xl font-bold">{val.name}</h2>
              <span className="font-mono text-sm text-muted-foreground">{val.code}</span>
              {basic?.industry && (
                <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">{basic.industry}</span>
              )}
              {basic?.area && (
                <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">{basic.area}</span>
              )}
              {ths?.industry && (
                <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground" title="同花顺行业">
                  THS {ths.industry}
                </span>
              )}
              {val.analyst_count > 0 && (
                <span className="ml-auto text-xs text-muted-foreground">机构覆盖 {val.analyst_count} 家</span>
              )}
            </div>
            {headerBoard && (
              <p className="mb-2 truncate text-[11px] leading-none" title={`${headerBoard.industry}${headerBoard.concepts ? ` · ${headerBoard.concepts}` : ""}`}>
                {headerBoard.industry && <span className="text-primary/80">{headerBoard.industry}</span>}
                {headerBoard.concepts && (
                  <span className="text-muted-foreground">
                    {headerBoard.industry ? " · " : ""}
                    {headerBoard.concepts}
                  </span>
                )}
              </p>
            )}
            {basic && (
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/70">
                {basic.list_date && <span>上市 {basic.list_date}</span>}
                {basic.total_shares != null && <span>总股本 {(basic.total_shares / 1e8).toFixed(2)} 亿股</span>}
                {basic.float_shares != null && <span>流通 {(basic.float_shares / 1e8).toFixed(2)} 亿股</span>}
                {basic.roe != null && <span>ROE {basic.roe}%</span>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {metrics.map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className="mt-0.5 font-mono text-lg font-bold">{m.v}</p>
                </div>
              ))}
            </div>
            {val.forecast_note && (
              <p className="mt-3 text-xs text-warning">{val.forecast_note}</p>
            )}
          </GlassCard>

          {/* 财报速览（结论先行摘要，借鉴 equity-research 的结构纪律，剔除评级/目标价） */}
          <EarningsSnapshot val={val} fin={fin} pctl={pctl} />

          {pctl && (pctl.metrics.pe_ttm || pctl.metrics.pb) && (
            <GlassCard glow className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><LineChart className="h-4 w-4 text-primary" /> 估值历史分位 · {pctl.period}</h3>
              <p className="mb-4 text-[11px] text-muted-foreground/60">绿=低估区 / 灰=合理区 / 红=高估区。只显示当前处于历史什么位置，不构成买卖建议。</p>
              <div className="space-y-4">
                {pctl.metrics.pe_ttm && <ValBand label="PE-TTM" m={pctl.metrics.pe_ttm} />}
                {pctl.metrics.pb && <ValBand label="市净率 PB" m={pctl.metrics.pb} />}
              </div>
            </GlassCard>
          )}

          {fin && (fin.revenue || fin.roe) && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><BarChart3 className="h-4 w-4 text-primary" /> 财务关键指标{fin.period && <span className="text-xs font-normal text-muted-foreground/60">· {fin.period}</span>}</h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">同花顺财务摘要,最新报告期。</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "营业总收入", v: fin.revenue, yoy: fin.revenue_yoy },
                  { k: "归母净利润", v: fin.net_profit, yoy: fin.net_profit_yoy },
                  { k: "每股收益", v: fin.eps },
                  { k: "ROE", v: fin.roe },
                  { k: "销售毛利率", v: fin.gross_margin },
                  { k: "销售净利率", v: fin.net_margin },
                  { k: "每股净资产", v: fin.bvps },
                  { k: "每股经营现金流", v: fin.op_cf_ps },
                ].map((m) => (
                  <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{m.k}</p>
                    <p className="mt-0.5 font-mono text-base font-bold">{m.v ?? "—"}</p>
                    {m.yoy && <p className="text-[11px] text-muted-foreground">同比 {m.yoy}</p>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {reports.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><FileText className="h-4 w-4 text-primary" /> 近期研报（{reports.length}）</h3>
              <div className="space-y-2">
                {reports.slice(0, 12).map((r, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{(r.publishDate || "").slice(0, 10)}</span>
                    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{r.orgSName}</span>
                    {r.pdfUrl ? (
                      <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{r.title}</a>
                    ) : (
                      <span className="flex-1 truncate">{r.title}</span>
                    )}
                    {r.emRatingName && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{r.emRatingName}</span>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {anns.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Megaphone className="h-4 w-4 text-primary" /> 近期公告（{anns.length}）</h3>
              <div className="space-y-2">
                {anns.slice(0, 12).map((a, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{a.date}</span>
                    {a.type && <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{a.type}</span>}
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{a.title.replace(/^[^:：]*[:：]/, "")}</a>
                    ) : (
                      <span className="flex-1 truncate">{a.title}</span>
                    )}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          <GlassCard>
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Newspaper className="h-4 w-4 text-primary" /> 个股新闻</h3>
            {depNote ? (
              <p className="text-xs text-warning">{depNote}（安装后新闻/公告即可用）</p>
            ) : news.length === 0 ? (
              <p className="text-xs text-muted-foreground/60">暂无新闻</p>
            ) : (
              <div className="space-y-2">
                {news.slice(0, 10).map((n, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{(n.发布时间 || "").slice(0, 16)}</span>
                    {n.新闻链接 ? (
                      <a href={n.新闻链接} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{n.新闻标题}</a>
                    ) : (
                      <span className="flex-1 truncate">{n.新闻标题}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </GlassCard>

          {/* 资金面 · 筹码（融资融券 / 股东户数 / 增减持 / 主力资金流 / 分红 / 大宗交易） */}
          {(margin.length > 0 || holders.length > 0 || shChanges.length > 0 || fundFlow.length > 0 || fundMin || dividend.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Wallet className="h-4 w-4 text-primary" /> 资金面 · 筹码</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {margin[0] && <Metric k="融资余额" v={yi(margin[0].rzye)} sub={margin[0].date} />}
                {margin[0] && <Metric k="融券余额" v={yi(margin[0].rqye)} />}
                {holders[0] && <Metric k="股东户数" v={Number(holders[0].holder_num).toLocaleString()} sub={`环比 ${pct(holders[0].change_ratio)}`} />}
                {fundFlow.length > 0 && <Metric k="近20日主力净流入" v={yi(fundFlow.slice(-20).reduce((s, r) => s + r.main_net, 0))} />}
                {fundMin && fundMin.count > 0 && (
                  <Metric
                    k="今日主力累计"
                    v={yi(fundMin.day_main_net)}
                    sub={fundMin.latest?.time ? `截至 ${fundMin.latest.time}` : "分钟级"}
                  />
                )}
                {dividend[0] && <Metric k="最近派息(每10股)" v={`${dividend[0].bonus_rmb} 元`} sub={dividend[0].date} />}
              </div>
              {fundMin && fundMin.rows.length > 0 && (
                <div className="mt-3 border-t border-border/40 pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    当日分钟资金（主力 / 超大 / 大 / 中 / 小 · 最近 {Math.min(8, fundMin.rows.length)} 档）
                  </p>
                  <div className="space-y-1">
                    {fundMin.rows.slice(-8).reverse().map((r) => (
                      <div key={r.time} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
                        <span className="w-12 shrink-0 text-muted-foreground">{(r.time || "").slice(-5)}</span>
                        <span className={cn(r.main_net >= 0 ? "text-danger" : "text-success")}>主 {yi(r.main_net)}</span>
                        <span className="text-muted-foreground">超 {yi(r.super_net)}</span>
                        <span className="text-muted-foreground">大 {yi(r.large_net)}</span>
                        <span className="text-muted-foreground">中 {yi(r.mid_net)}</span>
                        <span className="text-muted-foreground">小 {yi(r.small_net)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {shChanges.length > 0 && (
                <div className="mt-3 border-t border-border/40 pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">股东 / 高管增减持（{shChanges.length}）</p>
                  <div className="space-y-1.5">
                    {shChanges.slice(0, 8).map((r, i) => (
                      <div key={`${r.date}-${r.person}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                        <span className="w-20 shrink-0 font-mono text-muted-foreground">{r.date}</span>
                        <span className={cn("w-10 shrink-0 font-medium", r.change_type === "增持" ? "text-danger" : "text-success")}>
                          {r.change_type}
                        </span>
                        <span className="max-w-[5rem] truncate">{r.person || "—"}</span>
                        <span className="w-16 shrink-0 font-mono">
                          {r.change_shares ? `${(r.change_shares / 1e4).toFixed(1)}万` : "—"}
                        </span>
                        <span className="w-14 shrink-0 font-mono text-muted-foreground">
                          {r.avg_price ? `${r.avg_price}` : "—"}
                        </span>
                        <span className="flex-1 truncate text-muted-foreground">{r.position || r.reason || ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {blockT.length > 0 && (
                <div className="mt-3 border-t border-border/40 pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">近期大宗交易（{blockT.length}）</p>
                  <div className="space-y-1.5">
                    {blockT.slice(0, 5).map((b, i) => (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <span className="w-20 shrink-0 font-mono text-muted-foreground">{b.date}</span>
                        <span className="w-14 shrink-0">{b.price} 元</span>
                        <span className={cn("w-20 shrink-0", b.premium_pct >= 0 ? "text-danger" : "text-success")}>折溢 {b.premium_pct}%</span>
                        <span className="flex-1 truncate text-muted-foreground">买 {b.buyer} · 卖 {b.seller}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground/60">资金/筹码为公开客观数据，仅供了解该股当前状态，不构成任何买卖建议。</p>
            </GlassCard>
          )}

          {/* 龙虎榜（有数据才展示明细；无上榜也给空态，避免误以为没接） */}
          {dt && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Trophy className="h-4 w-4 text-primary" /> 龙虎榜
                <span className="text-xs font-normal text-muted-foreground/60">
                  · 近30日 {dt.records.length} 次
                  {dt.institution?.net_amt
                    ? ` · 机构席位净买 ${dt.institution.net_amt} 万`
                    : ""}
                </span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">公开席位数据，仅客观呈现，不构成买卖建议</p>
              {dt.records.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground/60">近 30 日未上榜</p>
              ) : (
                <>
                  <div className="space-y-2">
                    {dt.records.slice(0, 6).map((r, i) => (
                      <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                        <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{r.date}</span>
                        <span className="flex-1 truncate">{r.reason}</span>
                        <span className={cn("shrink-0 font-mono text-xs", r.net_buy >= 0 ? "text-danger" : "text-success")}>
                          净买 {r.net_buy} 万
                        </span>
                      </div>
                    ))}
                  </div>
                  {(dt.seats.buy.length > 0 || dt.seats.sell.length > 0) && (
                    <div className="mt-3 grid gap-4 border-t border-border/40 pt-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-danger">买入席位 TOP</p>
                        {dt.seats.buy.map((s, i) => (
                          <div key={i} className="flex justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{s.name}</span>
                            <span className="shrink-0 font-mono">净{s.net}万</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-success">卖出席位 TOP</p>
                        {dt.seats.sell.map((s, i) => (
                          <div key={i} className="flex justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{s.name}</span>
                            <span className="shrink-0 font-mono">净{s.net}万</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </GlassCard>
          )}

          {/* 投资者互动（互动易）— 已回复优先；未回复也展示 */}
          {qa !== null && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquare className="h-4 w-4 text-primary" /> 互动易
                <span className="text-xs font-normal text-muted-foreground/60">
                  · 巨潮 · {qa.filter((q) => q.answer).length}/{qa.length} 已回复
                </span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">
                投资者提问与公司官方回复 · 客观呈现，不构成投资建议
              </p>
              {qa.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground/60">暂无互动易记录</p>
              ) : (
                <div className="max-h-96 space-y-3 overflow-y-auto">
                  {qa.slice(0, 12).map((q, i) => (
                    <div key={`${q.ask_time}-${i}`} className="border-b border-border/40 pb-3 text-sm last:border-0">
                      <p className="text-muted-foreground">
                        <span className="mr-1.5 rounded bg-muted/50 px-1.5 py-0.5 text-[10px]">问</span>
                        {q.question}
                      </p>
                      {q.answer ? (
                        <p className="mt-1.5">
                          <span className="mr-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">答</span>
                          {q.answer}
                          {q.answerer && (
                            <span className="ml-1.5 text-[11px] text-muted-foreground/60">— {q.answerer}</span>
                          )}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-xs text-muted-foreground/50">
                          <span className="mr-1.5 rounded bg-muted/40 px-1.5 py-0.5 text-[10px]">待回复</span>
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground/60">{q.ask_time}</p>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
          )}

          {/* 限售解禁 */}
          {lockup && (lockup.upcoming.length > 0 || lockup.history.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-primary" /> 限售解禁</h3>
              {lockup.upcoming.length > 0 ? (
                <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <p className="mb-1.5 text-xs font-medium text-warning">未来 90 天待解禁（{lockup.upcoming.length}）</p>
                  {lockup.upcoming.slice(0, 4).map((h, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0 font-mono text-muted-foreground">{h.date}</span><span className="flex-1 truncate">{h.type}</span><span className="shrink-0 text-muted-foreground">占比 {pct(h.ratio)}</span></div>
                  ))}
                </div>
              ) : (
                <p className="mb-2 text-xs text-muted-foreground/70">未来 90 天无待解禁。</p>
              )}
              {lockup.history.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-muted-foreground">历史解禁（近 {Math.min(lockup.history.length, 5)}）</p>
                  {lockup.history.slice(0, 5).map((h, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0 font-mono text-muted-foreground">{h.date}</span><span className="flex-1 truncate text-muted-foreground">{h.type}</span></div>
                  ))}
                </div>
              )}
            </GlassCard>
          )}

          {/* 板块归属 · 概念 */}
          {((blocks && blocks.concept_tags.length > 0) || hotCon.length > 0 || basic?.area || basic?.industry || (ths && (ths.concepts?.length || ths.industry))) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Boxes className="h-4 w-4 text-primary" /> 板块归属 · 概念</h3>
              {basic && (basic.area || basic.industry) && (
                <p className="mb-1.5 text-xs text-muted-foreground">
                  行业/地域
                  {basic.industry ? ` · ${basic.industry}` : ""}
                  {basic.area ? ` · ${basic.area}` : ""}
                </p>
              )}
              {ths?.industry && (
                <p className="mb-1.5 text-xs text-muted-foreground">同花顺行业 · {ths.industry}</p>
              )}
              {conceptTags.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {conceptTags.map((t, i) => (
                    <span key={i} className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground">{t}</span>
                  ))}
                </div>
              )}
              {hotCon.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-muted-foreground">当下热门概念命中</p>
                  <div className="flex flex-wrap gap-1.5">
                    {hotCon.slice(0, 12).map((h, i) => (
                      <span key={i} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{h.concept}</span>
                    ))}
                  </div>
                </div>
              )}
            </GlassCard>
          )}
        </>
      )}

      {!val && !gstock && !err && !loading && (
        <GlassCard>
          <EmptyState
            title="输入股票代码开始查询"
            description="支持 A 股 6 位，以及美股/港股（如 AAPL / 00700）。数据来自公开源；不预置标的、不做推荐。"
          />
        </GlassCard>
      )}
    </div>
  );
}
