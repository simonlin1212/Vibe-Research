import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { AlertCircle, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { LcHoverTag, LcLegend, LcWell, lcTone, type LcLegendItem } from "@/components/ui/LcFrame";
import { EmptyState } from "@/components/ui/EmptyState";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { FearGreedPanel } from "@/components/cockpit/FearGreedPanel";
import { GlanceStrip, type GlanceMetric } from "@/components/ui/GlanceStrip";
import {
  api, ApiError, fundamentalsSourceLabel, type GlobalStock, type UsKlineBar,
  type GlobalEarningsCalendar, type GlobalSecDaily, type GlobalFundamentals,
  type GlobalEdgarScreener, type GlobalMovers,
  type GlobalOptions, type GlobalStockNews,
} from "@/lib/api";
import { addUsTickers, loadUsWatch, saveUsWatch } from "@/lib/usWatchlist";
import { useExpandAll } from "@/hooks/useExpandAll";
import { cn } from "@/lib/utils";
import {
  CandlestickSeries, HistogramSeries, applyTimeLabels, candleOpts, candleValues,
  seriesAlive, setLogScale, setPaneWatermark, setRefPriceLine, showLatest, styleLastTag,
  styleVolOverlay, useLcChart, useLcHoverTag, volOpts, volValues, wipeLc,
  type IPriceLine, type ISeriesApi, type ITextWatermarkPluginApi, type Time,
} from "@/lib/lcChart";

/** Pull 365 bars; default viewport shows latest ~120; wheel zooms out to full. */
const KLINE_NUM = 365;
const VIEW_DAYS = 120;

const US_SECTION_KEYS = [
  "us.fundamentals", "us.movers",
  "us.options", "us.news",
  "us.edgar", "us.earnings", "us.sec",
] as const;

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString();
}

function pctRatio(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-[#2a2a2a] bg-black p-1.5">
      <p className="text-[11px] text-muted-foreground">{k}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{v}</p>
    </div>
  );
}

export function UsMarket() {
  const [codes, setCodes] = useState<string[]>(loadUsWatch);
  const [selected, setSelected] = useState<string>(() => loadUsWatch()[0] ?? "");
  const [input, setInput] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, GlobalStock | null>>({});
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesUpdatedAt, setQuotesUpdatedAt] = useState<Date | null>(null);
  const [bars, setBars] = useState<UsKlineBar[]>([]);
  const [chartMeta, setChartMeta] = useState<{ code: string; name?: string; adjust?: string } | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [earnCal, setEarnCal] = useState<GlobalEarningsCalendar | null>(null);
  const [earnDays, setEarnDays] = useState<7 | 5 | 10>(7);
  const [secDaily, setSecDaily] = useState<GlobalSecDaily | null>(null);
  const [secNote, setSecNote] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [fund, setFund] = useState<GlobalFundamentals | null>(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundTab, setFundTab] = useState<"val" | "analyst" | "holders">("val");
  const [movers, setMovers] = useState<GlobalMovers | null>(null);
  const [moverBoard, setMoverBoard] = useState<
    "us_gainers" | "us_losers" | "us_amount" | "hk_gainers" | "hk_losers" | "hk_amount"
  >("us_gainers");
  const [edgar, setEdgar] = useState<GlobalEdgarScreener | null>(null);
  const [edgarTag, setEdgarTag] = useState("净利润");
  const [edgarLoading, setEdgarLoading] = useState(false);
  const [gOpt, setGOpt] = useState<GlobalOptions | null>(null);
  const [gNews, setGNews] = useState<GlobalStockNews | null>(null);
  const [gOptTab, setGOptTab] = useState<"0dte" | "7d">("0dte");

  const { allOpen, toggleAll } = useExpandAll(US_SECTION_KEYS);

  const { ref: chartRef, chartRef: lcRef, labelsRef, onHoverRef } = useLcChart();
  const bag = useRef<{
    candle: ISeriesApi<"Candlestick"> | null;
    vol: ISeriesApi<"Histogram"> | null;
  }>({ candle: null, vol: null });
  const refLine = useRef<IPriceLine | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  onHoverRef.current = setHoverIdx;

  const persist = (next: string[]) => {
    setCodes(next);
    saveUsWatch(next);
    if (selected && !next.includes(selected)) {
      setSelected(next[0] ?? "");
    }
    if (!selected && next[0]) setSelected(next[0]);
  };

  const add = () => {
    const { next, added } = addUsTickers(codes, input);
    if (added === 0) {
      setHint(input.trim() ? "没识别到新的美股代码（或已在列表里）" : null);
      setInput("");
      return;
    }
    persist(next);
    setInput("");
    setHint(`已添加 ${added} 只`);
    if (!selected) setSelected(next[next.length - added] ?? next[0]);
  };

  const remove = (c: string, e?: MouseEvent) => {
    e?.stopPropagation();
    persist(codes.filter((x) => x !== c));
  };

  const loadQuotes = useCallback(async () => {
    if (codes.length === 0) {
      setQuotes({});
      setQuotesUpdatedAt(new Date());
      return;
    }
    setQuotesLoading(true);
    try {
      const entries = await Promise.all(
        codes.map(async (c) => {
          try {
            return [c, await api.globalStock(c, { withMetrics: false })] as const;
          } catch {
            return [c, null] as const;
          }
        }),
      );
      setQuotes(Object.fromEntries(entries));
      setQuotesUpdatedAt(new Date());
    } finally {
      setQuotesLoading(false);
    }
  }, [codes]);

  const loadChart = useCallback(async (sym: string, num: number) => {
    if (!sym) {
      setBars([]);
      setChartMeta(null);
      setChartErr(null);
      return;
    }
    setChartLoading(true);
    setChartErr(null);
    try {
      const data = await api.usKline(sym, num);
      setBars(data.bars ?? []);
      setChartMeta({ code: data.code, name: data.name, adjust: data.adjust });
      setHoverIdx(null);
    } catch (e) {
      setBars([]);
      setChartMeta(null);
      setHoverIdx(null);
      setChartErr(e instanceof ApiError ? e.message : "K 线加载失败");
    } finally {
      setChartLoading(false);
    }
  }, []);

  const loadPanels = useCallback(async () => {
    setPanelLoading(true);
    setSecNote(null);
    try {
      const [cal, sec, mv] = await Promise.all([
        api.globalEarningsCalendar({ days: earnDays }).catch(() => null),
        api.globalSecDaily({ limit: 60 }).catch((e) => {
          if (e instanceof ApiError) setSecNote(e.message);
          return null;
        }),
        api.globalMovers(moverBoard, 20).catch(() => null),
      ]);
      setEarnCal(cal);
      setSecDaily(sec);
      setMovers(mv);
    } finally {
      setPanelLoading(false);
    }
  }, [earnDays, moverBoard]);

  const loadEdgar = useCallback(async (tag: string) => {
    setEdgarLoading(true);
    try {
      setEdgar(await api.globalEdgarScreener({ tag, top: 20 }));
    } catch {
      setEdgar(null);
    } finally {
      setEdgarLoading(false);
    }
  }, []);

  const loadFund = useCallback(async (sym: string) => {
    if (!sym) {
      setFund(null);
      return;
    }
    setFundLoading(true);
    try {
      setFund(await api.globalFundamentals(sym));
      setFundTab("val");
    } catch {
      setFund(null);
    } finally {
      setFundLoading(false);
    }
  }, []);

  const loadOptFlow = useCallback(async (sym: string) => {
    if (!sym) {
      setGOpt(null);
      setGNews(null);
      return;
    }
    const [opt, news] = await Promise.all([
      api.globalOptions(sym).catch(() => null),
      api.globalStockNews(sym, 8).catch(() => null),
    ]);
    setGOpt(opt);
    setGNews(news);
    setGOptTab("0dte");
  }, []);

  useEffect(() => { void loadQuotes(); }, [loadQuotes]);
  useEffect(() => { void loadChart(selected, KLINE_NUM); }, [selected, loadChart]);
  useEffect(() => { void loadPanels(); }, [loadPanels]);
  useEffect(() => { void loadEdgar(edgarTag); }, [edgarTag, loadEdgar]);
  useEffect(() => { void loadFund(selected); }, [selected, loadFund]);
  useEffect(() => { void loadOptFlow(selected); }, [selected, loadOptFlow]);

  useEffect(() => {
    const chart = lcRef.current;
    if (!chart) return;
    if (bars.length === 0) {
      setPaneWatermark(chart, wmRef, "");
      wipeLc(chart);
      bag.current = { candle: null, vol: null };
      refLine.current = null;
      labelsRef.current = [];
      return;
    }
    labelsRef.current = bars.map((b) => b.date);
    applyTimeLabels(chart, labelsRef, "md");
    if (!seriesAlive(chart, bag.current.candle) || !seriesAlive(chart, bag.current.vol)) {
      wipeLc(chart);
      refLine.current = null;
      bag.current.candle = chart.addSeries(CandlestickSeries, candleOpts());
      bag.current.vol = chart.addSeries(HistogramSeries, volOpts());
      styleVolOverlay(chart);
    }
    bag.current.candle!.setData(candleValues(bars));
    const last = bars[bars.length - 1];
    styleLastTag(bag.current.candle, last?.close, last?.open);
    setRefPriceLine(bag.current.candle, refLine, bars.length > 1 ? bars[bars.length - 2].close : null);
    setPaneWatermark(chart, wmRef, selected, 110);
    setLogScale(chart, bars.every((b) => !Number.isFinite(b.close) || b.close > 0));
    bag.current.vol!.setData(volValues(bars.map((b) => ({
      value: b.volume,
      up: b.close >= b.open,
    }))));
    showLatest(chart, bars.length, VIEW_DAYS);
  }, [bars, selected, lcRef, labelsRef]);

  const selQuote = selected ? quotes[selected] : null;
  const activeIdx = hoverIdx != null && bars[hoverIdx] ? hoverIdx : (bars.length ? bars.length - 1 : -1);
  const bar = activeIdx >= 0 ? bars[activeIdx] : null;
  const prevBar = activeIdx > 0 ? bars[activeIdx - 1] : null;
  const chg = bar && prevBar ? bar.close - prevBar.close : null;
  const chgPct = chg != null && prevBar && prevBar.close ? (chg / prevBar.close) * 100 : null;
  const hovering = hoverIdx != null && bars[hoverIdx] != null;
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current.candle,
    hovering ? bar?.close ?? null : null,
    bars[bars.length - 1]?.close ?? null,
    fmtPrice,
    hoverIdx,
  );

  const fmtVol = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  };

  const usLegend: LcLegendItem[] = bar ? [
    { k: "O", v: fmtPrice(bar.open) },
    { k: "H", v: fmtPrice(bar.high) },
    { k: "L", v: fmtPrice(bar.low) },
    { k: "C", v: fmtPrice(bar.close), tone: lcTone(chg) },
    { k: "V", v: fmtVol(bar.volume), tone: "muted" },
  ] : [];

  const glanceMetrics: GlanceMetric[] = [];
  if (selQuote?.quote) {
    const pct = selQuote.quote.change_pct;
    const tone: GlanceMetric["tone"] =
      pct != null && pct > 0 ? "up" : pct != null && pct < 0 ? "down" : "flat";
    glanceMetrics.push(
      { label: "现价", value: fmtPrice(selQuote.quote.price), tone },
      { label: "涨跌幅", value: fmtPct(pct), tone },
      { label: "名称", value: selQuote.name || selected, tone: "muted" },
    );
  }
  glanceMetrics.push({ label: "观察数", value: String(codes.length), tone: "primary" });

  return (
    <div>
      <PageHeader
        title="美股"
        subtitle="观察列表 · K线 · 基本面 · 期权 · 榜单 · EDGAR Screener。只客观呈现。"
        actions={
          <button
            type="button"
            onClick={() => {
              void loadQuotes();
              if (selected) {
                void loadChart(selected, KLINE_NUM);
                void loadFund(selected);
                void loadOptFlow(selected);
              }
              void loadPanels();
              void loadEdgar(edgarTag);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (quotesLoading || chartLoading || panelLoading || fundLoading) && "animate-spin")} />
            刷新
          </button>
        }
      />

      <FearGreedPanel className="border border-[#2a2a2a] bg-black" />

      <GlanceStrip
        title="美股一眼"
        subtitle={selected ? `${selected} · 主图常开, 明细按需展开` : "主图常开 · 明细按需展开"}
        metrics={glanceMetrics}
        allOpen={allOpen}
        onToggleAll={toggleAll}
        onRefresh={() => {
          void loadQuotes();
          if (selected) {
            void loadChart(selected, KLINE_NUM);
            void loadFund(selected);
            void loadOptFlow(selected);
          }
          void loadPanels();
          void loadEdgar(edgarTag);
        }}
        refreshing={quotesLoading || chartLoading || panelLoading || fundLoading}
        updatedAt={quotesUpdatedAt}
      />

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Watchlist */}
        <GlassCard className="flex flex-col p-3">
          <div className="mb-2 flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              placeholder="加代码: AAPL TSLA"
              className="field-input min-w-0 flex-1 !px-2.5 !py-1.5"
            />
            <button
              type="button"
              onClick={add}
              className="btn-press inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> 添加
            </button>
          </div>
          {hint ? <p className="mb-2 text-[11px] text-muted-foreground">{hint}</p> : null}

          <div className="min-h-[320px] flex-1 space-y-0.5 overflow-auto">
            {codes.length === 0 ? (
              <EmptyState
                className="py-8"
                title="还没有观察标的"
                description="在上方输入 ticker 添加，例如 AAPL、NVDA、MSFT。"
              />
            ) : codes.map((c) => {
              const q = quotes[c];
              const pct = q?.quote?.change_pct;
              const active = c === selected;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setSelected(c)}
                    className={cn(
                    "group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-white/[0.04] text-foreground shadow-[inset_2px_0_0_#ffcc00]"
                      : "hover:bg-white/[0.03]",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-semibold tabular-nums">{c}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{q?.name ?? ""}</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-2 tabular-nums text-xs">
                      <span>{fmtPrice(q?.quote?.price)}</span>
                      <span className={cn(
                        pct != null && pct > 0 ? "text-[#f6465d]" : pct != null && pct < 0 ? "text-[#0ecb81]" : "text-muted-foreground",
                      )}>
                        {fmtPct(pct)}
                      </span>
                    </div>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => remove(c, e)}
                    onKeyDown={(e) => { if (e.key === "Enter") remove(c); }}
                    className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted/60 hover:text-foreground group-hover:opacity-100"
                    title="移除"
                  >
                    <X className="h-3.5 w-3.5" />
                  </span>
                </button>
              );
            })}
          </div>
        </GlassCard>

        {/* Chart */}
        <GlassCard className="p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-lg font-semibold tracking-tight">{selected || "—"}</span>
                <span className="truncate text-xs text-slate-500">
                  {chartMeta?.name || selQuote?.name || ""}
                </span>
                <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {chartMeta?.adjust === "qfq" ? "qfq" : "D"}
                </span>
                {hovering ? (
                  <span className="font-mono text-[10px] tracking-wide text-primary/80">CROSSHAIR</span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-3">
                <span className={cn(
                  "font-mono text-2xl font-semibold tabular-nums",
                  chgPct != null && chgPct > 0 ? "text-[#f6465d]"
                    : chgPct != null && chgPct < 0 ? "text-[#0ecb81]"
                      : "text-slate-200",
                )}>
                  {fmtPrice(bar?.close ?? selQuote?.quote?.price)}
                </span>
                <span className={cn(
                  "font-mono text-sm tabular-nums",
                  chgPct != null && chgPct > 0 ? "text-[#f6465d]"
                    : chgPct != null && chgPct < 0 ? "text-[#0ecb81]"
                      : "text-slate-500",
                )}>
                  {chg != null ? `${chg > 0 ? "+" : ""}${chg.toFixed(2)}` : "—"}
                  <span className="ml-1">({fmtPct(chgPct)})</span>
                </span>
                {bar?.date ? (
                  <span className="font-mono text-[11px] text-slate-600">{bar.date}</span>
                ) : null}
              </div>
            </div>
          </div>

          <LcWell className="h-[480px]">
            {chartErr ? (
              <div className="absolute inset-0 z-20 flex items-center gap-2 bg-black/88 px-4 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" /> {chartErr}
              </div>
            ) : null}
            {chartLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
                <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
              </div>
            )}
            <LcLegend items={usLegend} />
            <LcHoverTag tag={hoverTag} y={tagY} />
            <div ref={chartRef} className="h-full w-full" />
          </LcWell>
        </GlassCard>
      </div>

      {selected && (
        <CollapsibleSection
          storageKey="us.fundamentals"
          title={`基本面 · ${selected}`}
          summary={fund ? fundamentalsSourceLabel(fund.source ?? fund.valuation?.source) : "无数据"}
          className="mt-4"
        >
          <GlassCard className="p-3 sm:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                基本面 · {selected}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground/60">
                  {fundamentalsSourceLabel(fund?.source ?? fund?.valuation?.source)} · 客观数据
                </span>
              </h3>
              <div className="flex gap-1">
                {([
                  ["val", "估值"],
                  ["analyst", "分析师"],
                  ["holders", "机构持仓"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFundTab(k)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px]",
                      fundTab === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {fundLoading && !fund ? (
              <p className="py-6 text-center text-xs text-muted-foreground/60">加载中…</p>
            ) : !fund || (!fund.valuation && !fund.analyst && !fund.holders) ? (
              <EmptyState
                className="py-6"
                title="暂无基本面数据"
                description="Yahoo 不可达或该标的无覆盖时属正常，可稍后刷新。"
              />
            ) : fundTab === "val" && fund.valuation ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {[
                  { k: "PE(TTM)", v: fmtNum(fund.valuation.trailing_pe) },
                  { k: "前向 PE", v: fmtNum(fund.valuation.forward_pe) },
                  { k: "PEG", v: fmtNum(fund.valuation.peg_ratio) },
                  { k: "PB", v: fmtNum(fund.valuation.price_to_book) },
                  { k: "目标均价", v: fmtNum(fund.valuation.target_mean) },
                  { k: "共识评级", v: fund.valuation.recommendation ?? "—" },
                  { k: "Beta", v: fmtNum(fund.valuation.beta) },
                  { k: "股息率", v: pctRatio(fund.valuation.dividend_yield) },
                  { k: "毛利率", v: pctRatio(fund.valuation.gross_margin) },
                  { k: "净利率", v: pctRatio(fund.valuation.profit_margin) },
                  { k: "ROE", v: pctRatio(fund.valuation.return_on_equity) },
                  { k: "营收增长", v: pctRatio(fund.valuation.revenue_growth) },
                ].map((m) => (
                  <Metric key={m.k} k={m.k} v={m.v} />
                ))}
              </div>
            ) : fundTab === "analyst" && fund.analyst ? (
              <div className="space-y-3">
                {fund.analyst.rating_trend[0] && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {[
                      { k: "强买", v: fund.analyst.rating_trend[0].strong_buy },
                      { k: "买入", v: fund.analyst.rating_trend[0].buy },
                      { k: "持有", v: fund.analyst.rating_trend[0].hold },
                      { k: "卖出", v: fund.analyst.rating_trend[0].sell },
                      { k: "强卖", v: fund.analyst.rating_trend[0].strong_sell },
                    ].map((m) => (
                      <Metric
                        key={m.k}
                        k={`${m.k} · ${fund.analyst!.rating_trend[0].period ?? ""}`}
                        v={String(m.v ?? "—")}
                      />
                    ))}
                  </div>
                )}
                {fund.analyst.eps_trend.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="data-table min-w-[480px]">
                      <thead>
                        <tr>
                          <th>期间</th>
                          <th className="num">EPS 预期</th>
                          <th className="num">高 / 低</th>
                          <th className="num">分析师数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fund.analyst.eps_trend.slice(0, 6).map((t) => (
                          <tr key={`${t.period}-${t.end_date}`}>
                            <td className="text-muted-foreground">
                              {t.period ?? "—"}{t.end_date ? ` · ${t.end_date}` : ""}
                            </td>
                            <td className="num font-mono">{fmtNum(t.eps_estimate)}</td>
                            <td className="num font-mono text-xs text-muted-foreground">
                              {fmtNum(t.eps_high)} / {fmtNum(t.eps_low)}
                            </td>
                            <td className="num font-mono">{t.num_analysts ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState className="py-4" title="暂无 EPS 预期" description="该标的暂无分析师预期序列。" />
                )}
              </div>
            ) : fundTab === "holders" && fund.holders ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric k="机构持股" v={pctRatio(fund.holders.overview.institutions_pct)} />
                  <Metric k="内部人" v={pctRatio(fund.holders.overview.insiders_pct)} />
                  <Metric k="机构数" v={fmtNum(fund.holders.overview.institutions_count, 0)} />
                  <Metric k="机构占流通" v={pctRatio(fund.holders.overview.institutions_float_pct)} />
                </div>
                {fund.holders.top_holders.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="data-table min-w-[480px]">
                      <thead>
                        <tr>
                          <th>机构</th>
                          <th className="num">持股占比</th>
                          <th className="num">股数</th>
                          <th className="num">报告日</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fund.holders.top_holders.map((h) => (
                          <tr key={h.name}>
                            <td className="name">{h.name ?? "—"}</td>
                            <td className="num font-mono">{pctRatio(h.pct_held)}</td>
                            <td className="num font-mono text-xs">
                              {h.shares != null ? h.shares.toLocaleString() : "—"}
                            </td>
                            <td className="num text-xs text-muted-foreground">{h.report_date ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState className="py-4" title="暂无前十大机构明细" description="持仓汇总有值但明细未返回时属正常。" />
                )}
              </div>
            ) : (
              <EmptyState className="py-6" title="该分类暂无数据" description="可切换估值 / 分析师 / 股东查看其他维度。" />
            )}
          </GlassCard>
        </CollapsibleSection>
      )}

      <CollapsibleSection
        storageKey="us.movers"
        title="市场榜单"
        summary={movers?.stocks?.length ? `${movers.stocks.length} 只` : undefined}
      >
          <GlassCard className="p-3 sm:p-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">市场榜单</h3>
              <div className="flex flex-wrap gap-1">
                {([
                  ["us_gainers", "纳指涨幅"],
                  ["us_losers", "纳指跌幅"],
                  ["us_amount", "纳指成交额"],
                  ["hk_gainers", "港股涨幅"],
                  ["hk_losers", "港股跌幅"],
                  ["hk_amount", "港股成交额"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMoverBoard(k)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px]",
                      moverBoard === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground/60">东财 clist · 点行加入/切换观察标的</p>
            {!movers?.stocks?.length ? (
              panelLoading ? (
                <EmptyState loading title="加载榜单" skeleton="table" />
              ) : (
                <EmptyState title="暂无榜单" description="可切换涨跌榜或稍后重试。" />
              )
            ) : (
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {movers.stocks.map((s) => (
                  <button
                    key={`${s.code}-${s.name}`}
                    type="button"
                    onClick={() => {
                      if (!s.code) return;
                      const c = s.code.toUpperCase();
                      // US watchlist + K-line only accept US tickers; HK digits -> hint
                      if (/^\d+$/.test(c) || moverBoard.startsWith("hk_")) {
                        setHint(`港股 ${c} 请到「A股 → K线/详情」查看`);
                        return;
                      }
                      if (!codes.includes(c)) persist([...codes, c]);
                      setSelected(c);
                    }}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40"
                  >
                    <span className="w-16 shrink-0 font-semibold tabular-nums">{s.code}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{s.name}</span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs">{fmtPrice(s.price)}</span>
                    <span className={cn(
                      "w-16 shrink-0 text-right font-mono text-xs",
                      (s.change_pct ?? 0) > 0 ? "text-red-500" : (s.change_pct ?? 0) < 0 ? "text-emerald-500" : "text-muted-foreground",
                    )}>
                      {fmtPct(s.change_pct)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </GlassCard>
        </CollapsibleSection>

      <CollapsibleSection
        storageKey="us.edgar"
        title="EDGAR Screener"
        summary={edgar?.rows?.length ? `${edgar.rows.length} 家` : edgarTag}
      >
        <GlassCard className="p-3 sm:p-4">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              EDGAR Screener
              <span className="ml-2 text-[11px] font-normal text-muted-foreground/60">
                S 级 · {edgar?.period ?? "—"} · 覆盖 {edgar?.universe ?? "—"} 家
              </span>
            </h3>
            <select
              value={edgarTag}
              onChange={(e) => setEdgarTag(e.target.value)}
              className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs outline-none"
            >
              {(edgar?.tags?.length
                ? edgar.tags.map((t) => t.label)
                : ["净利润", "研发费用", "营业收入", "经营现金流", "稀释EPS"]
              ).map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </select>
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground/60">
            SEC frames 全市场横截面 · {edgar?.tag_label ?? edgarTag} · 金额单位 {edgar?.unit ?? "USD"}
          </p>
          {edgarLoading && !edgar ? (
            <p className="py-6 text-center text-xs text-muted-foreground/60">加载中…</p>
          ) : !edgar?.rows?.length ? (
            <EmptyState
              className="py-6"
              title="暂无 screener 数据"
              description="需配置 VR_SEC_CONTACT；未配置或源限流时属正常。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[520px]">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>公司</th>
                    <th className="num">数值</th>
                    <th className="num">期末</th>
                  </tr>
                </thead>
                <tbody>
                  {edgar.rows.map((r, i) => (
                    <tr key={`${r.cik}-${r.entity}`}>
                      <td className="text-muted-foreground">{i + 1}</td>
                      <td>
                        <div className="name max-w-[280px]">{r.entity ?? "—"}</div>
                        <div className="code">CIK {r.cik}</div>
                      </td>
                      <td className="num font-mono">
                        {r.value == null
                          ? "—"
                          : Math.abs(r.value) >= 1e9
                            ? `${(r.value / 1e9).toFixed(2)}B`
                            : Math.abs(r.value) >= 1e6
                              ? `${(r.value / 1e6).toFixed(1)}M`
                              : r.value.toLocaleString()}
                      </td>
                      <td className="num text-xs text-muted-foreground">{r.end ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      </CollapsibleSection>

      {selected && gOpt && (
        <CollapsibleSection
          storageKey="us.options"
          title="期权"
          summary={`CBOE · ${selected}`}
        >
          <GlassCard className="p-3 sm:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                期权 · CBOE · {selected}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground/60">
                  spot {fmtNum(gOpt.spot)} · {gOpt.et_today}
                </span>
              </h3>
              <div className="flex gap-1">
                {([["0dte", "0DTE"], ["7d", "近7日"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setGOptTab(k)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px]",
                      gOptTab === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {(() => {
              const sum = gOptTab === "0dte" ? gOpt.summary_0dte : gOpt.summary_7d;
              const flow = gOptTab === "0dte" ? gOpt.unusual_0dte : gOpt.unusual_7d;
              if (!sum) {
                return <p className="py-4 text-center text-xs text-muted-foreground/60">该区间暂无汇总</p>;
              }
              return (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric k="P/C 量比" v={fmtNum(sum.put_call_volume_ratio)} />
                    <Metric
                      k="量加权 IV"
                      v={sum.volume_weighted_iv == null ? "—" : `${(sum.volume_weighted_iv * 100).toFixed(1)}%`}
                    />
                    <Metric k="净 delta(股)" v={sum.net_delta_exposure_shares.toLocaleString()} />
                    <Metric k="成交合约" v={`${sum.contracts_traded}/${sum.contracts_total}`} />
                  </div>
                  {flow.length > 0 ? (
                    <div className="max-h-48 overflow-y-auto">
                      <table className="data-table min-w-[480px]">
                        <thead>
                          <tr>
                            <th>类型</th>
                            <th className="num">行权价</th>
                            <th className="num">量</th>
                            <th className="num">vol/OI</th>
                            <th className="num">IV</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flow.slice(0, 12).map((c) => (
                            <tr key={c.symbol}>
                              <td className={c.type === "call" ? "text-danger" : "text-success"}>
                                {c.type === "call" ? "C" : "P"} <span className="text-muted-foreground text-xs">{c.expiry}</span>
                              </td>
                              <td className="num font-mono">{fmtNum(c.strike)}</td>
                              <td className="num font-mono">{c.volume?.toLocaleString() ?? "—"}</td>
                              <td className="num font-mono">{c.vol_oi_ratio ?? "∞"}</td>
                              <td className="num font-mono">
                                {c.iv == null ? "—" : `${(c.iv * 100).toFixed(1)}%`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="py-2 text-center text-xs text-muted-foreground/60">暂无异动合约</p>
                  )}
                </>
              );
            })()}
          </GlassCard>
        </CollapsibleSection>
      )}

      {selected && gNews && gNews.items.length > 0 && (
        <CollapsibleSection
          storageKey="us.news"
          title="新闻"
          summary={`${gNews.items.length} 条`}
        >
          <GlassCard className="p-3 sm:p-4">
            <h3 className="mb-1 text-sm font-semibold">
              个股新闻 · {selected}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground/60">Yahoo · C 级</span>
            </h3>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
              {gNews.items.map((n, i) => (
                <div key={`${n.link ?? n.title}-${i}`} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-sm last:border-0">
                  <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">
                    {(n.publish_time || "").slice(0, 16) || "—"}
                  </span>
                  {n.link ? (
                    <a href={n.link} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-primary">
                      {n.title}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  )}
                </div>
              ))}
            </div>
          </GlassCard>
        </CollapsibleSection>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CollapsibleSection
          storageKey="us.earnings"
          title="财报日历"
          summary={
            earnCal
              ? `${earnCal.total ?? 0} 家`
              : undefined
          }
          className="mb-0"
        >
          <GlassCard className="p-3 sm:p-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">财报日历</h3>
              <div className="flex gap-1">
                {([5, 7, 10] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setEarnDays(d)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px]",
                      earnDays === d ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    {d} 日
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground/60">
              Nasdaq · {earnCal?.start && earnCal?.end ? `${earnCal.start} → ${earnCal.end}` : "—"}
              {" · "}共 {earnCal?.total ?? 0} 家
              {" · "}跳过周末 · 仅客观日程与 EPS 预期
            </p>
            {!earnCal || earnCal.total === 0 ? (
              panelLoading ? (
                <p className="py-6 text-center text-xs text-muted-foreground/60">加载中…</p>
              ) : (
                <EmptyState
                  className="py-6"
                  title="区间内暂无财报安排"
                  description="所选天数内无财报，或数据源暂不可用。"
                />
              )
            ) : (
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {earnCal.by_day
                  .filter((d) => d.count > 0)
                  .map((day) => (
                    <div key={day.date}>
                      <div className="sticky top-0 z-[1] mb-1 flex items-baseline gap-2 bg-card/95 py-0.5 text-xs backdrop-blur">
                        <span className="font-medium tabular-nums text-foreground">{day.date}</span>
                        <span className="text-muted-foreground/60">{day.count} 家</span>
                      </div>
                      <div className="space-y-0.5">
                        {day.rows.slice(0, 30).map((r) => (
                          <button
                            key={`${day.date}-${r.symbol}-${r.name}`}
                            type="button"
                            onClick={() => { if (r.symbol) setSelected(r.symbol); }}
                            className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40"
                          >
                            <span className="w-16 shrink-0 font-semibold tabular-nums">{r.symbol}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.name}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{r.time || "—"}</span>
                            <span className="w-16 shrink-0 text-right font-mono text-xs">{r.eps_forecast || "—"}</span>
                          </button>
                        ))}
                        {day.rows.length > 30 && (
                          <p className="px-2 text-[11px] text-muted-foreground/60">…另有 {day.rows.length - 30} 家</p>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </GlassCard>
        </CollapsibleSection>

        <CollapsibleSection
          storageKey="us.sec"
          title="SEC 申报流"
          summary={secDaily ? `${secDaily.total} 份` : undefined}
          className="mb-0"
        >
          <GlassCard className="p-3 sm:p-4">
            <h3 className="mb-1 text-sm font-semibold">SEC 申报流</h3>
            <p className="mb-3 text-[11px] text-muted-foreground/60">
              EDGAR 每日索引 · Form 4 / 8-K / 13F · {secDaily ? `日期 ${secDaily.date.slice(0, 4)}-${secDaily.date.slice(4, 6)}-${secDaily.date.slice(6)} · 全市场 ${secDaily.total} 份` : "需配置 VR_SEC_CONTACT"}
            </p>
            {secNote && !secDaily ? (
              <p className="py-4 text-xs text-muted-foreground">{secNote}</p>
            ) : !secDaily || secDaily.filings.length === 0 ? (
              panelLoading ? (
                <p className="py-6 text-center text-xs text-muted-foreground/60">加载中…</p>
              ) : (
                <EmptyState
                  className="py-6"
                  title="暂无申报流"
                  description="需配置 VR_SEC_CONTACT；当日无 Form 4/8-K/13F 时也可能为空。"
                />
              )
            ) : (
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {secDaily.filings.map((f, i) => (
                  <a
                    key={`${f.form}-${f.cik}-${f.date}-${i}`}
                    href={f.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      "flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40",
                      !f.url && "pointer-events-none",
                    )}
                  >
                    <span className="w-12 shrink-0 font-mono text-xs text-primary">{f.form}</span>
                    <span className="min-w-0 flex-1 truncate">{f.company}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{f.form_label || ""}</span>
                  </a>
                ))}
              </div>
            )}
          </GlassCard>
        </CollapsibleSection>
      </div>
    </div>
  );
}
