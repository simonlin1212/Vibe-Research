import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, Newspaper, Plus, Search, X } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { Chip, ChipGroup } from "@/components/ui/SectionHeader";
import { PageFallback } from "@/components/ui/PageFallback";
import { WatchlistFeed } from "@/components/WatchlistFeed";
import { ApiError, type AShareLightBar } from "@/lib/api";
import { isFuturesCode, useQuotes, type HubQuote } from "@/lib/quoteHub";
import { loadLightKline, overlayQuoteBar } from "@/lib/lightKline";
import { MINUTE_POLL_MS } from "@/lib/minuteHub";
import { createSeriesGate } from "@/lib/seriesGate";
import { getAShareSession, HUB_POLL_FUTURES_MS, hubPollMs } from "@/lib/ashareSession";
import { storageGet, storageSet } from "@/lib/storage";
import { SuggestHits, useSuggestSearch } from "@/hooks/useSuggestSearch";
import { peekChartCode } from "@/components/cockpit/QuoteLine";
import { addCodes, loadWatch, saveWatch, useWatchCodes, watchDigits } from "@/lib/watchlist";
import { nextSort, type SortState } from "@/components/ovlab/shared";
import { cmpVal, SortableHd } from "@/components/deriv/derivShared";
import { cn } from "@/lib/utils";

const StockData = lazy(() =>
  import("@/pages/StockData").then((m) => ({ default: m.StockData })),
);
const AShareLcPaneLazy = lazy(() =>
  import("@/components/ashare/AShareLcPane").then((m) => ({ default: m.AShareLcPane })),
);

function AShareLcPane(props: ComponentProps<typeof AShareLcPaneLazy>) {
  return (
    <Suspense fallback={<PageFallback />}>
      <AShareLcPaneLazy {...props} />
    </Suspense>
  );
}

export type AShareChartSeg = "kline" | "detail" | "feed";
const CHART_SEGS: AShareChartSeg[] = ["kline", "detail", "feed"];

const KLINE_NUM = 365;

function quoteChg(q: HubQuote | undefined) {
  if (!q) return null;
  if (q.change != null && Number.isFinite(q.change)) return q.change;
  if (q.prev && Number.isFinite(q.prev)) return q.price - q.prev;
  return null;
}

type ColKey =
  | "code" | "name" | "price" | "pct" | "change"
  | "bid" | "ask" | "bid_vol" | "ask_vol" | "volume" | "amount"
  | "turnover" | "vol_ratio" | "amplitude"
  | "open" | "high" | "low" | "prev" | "limit_up" | "limit_down"
  | "mcap_yi" | "float_mcap_yi" | "pe_ttm" | "pe_static" | "pb";

const COLS: { key: ColKey; label: string; num?: boolean }[] = [
  { key: "code", label: "代码" },
  { key: "name", label: "名称" },
  { key: "price", label: "现价", num: true },
  { key: "pct", label: "涨幅", num: true },
  { key: "change", label: "涨跌", num: true },
  { key: "bid", label: "买价", num: true },
  { key: "ask", label: "卖价", num: true },
  { key: "bid_vol", label: "买量", num: true },
  { key: "ask_vol", label: "卖量", num: true },
  { key: "volume", label: "成交量", num: true },
  { key: "amount", label: "成交额", num: true },
  { key: "turnover", label: "换手%", num: true },
  { key: "vol_ratio", label: "量比", num: true },
  { key: "amplitude", label: "振幅", num: true },
  { key: "open", label: "开盘", num: true },
  { key: "high", label: "最高", num: true },
  { key: "low", label: "最低", num: true },
  { key: "prev", label: "昨收", num: true },
  { key: "limit_up", label: "涨停", num: true },
  { key: "limit_down", label: "跌停", num: true },
  { key: "mcap_yi", label: "市值(亿)", num: true },
  { key: "float_mcap_yi", label: "流通(亿)", num: true },
  { key: "pe_ttm", label: "PE(TTM)", num: true },
  { key: "pe_static", label: "静PE", num: true },
  { key: "pb", label: "PB", num: true },
];

const BASIC_KEYS: ColKey[] = [
  "code", "name", "price", "pct", "change", "amount", "turnover", "open", "high", "low",
];
const BASIC_COLS = COLS.filter((c) => BASIC_KEYS.includes(c.key));

function colVal(key: ColKey, c: string, q: HubQuote | undefined): unknown {
  if (key === "code") return c;
  if (key === "name") return q?.name || c;
  if (key === "change") return quoteChg(q);
  return q?.[key];
}

export function sortWatchCodes(
  codes: string[],
  quotes: Record<string, HubQuote>,
  sort: { key: ColKey | null; dir: "asc" | "desc" },
): string[] {
  if (!sort.key) return codes;
  const key = sort.key;
  return [...codes].sort((a, b) => cmpVal(colVal(key, a, quotes[a]), colVal(key, b, quotes[b]), sort.dir));
}

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null | undefined, d = 2) {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  return Number(v.toFixed(d)).toLocaleString("zh-CN", { maximumFractionDigits: d });
}

function fmtChg(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function fmtVol(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1) + "万";
  return String(Math.round(v));
}

function fmtRate(v: number | null | undefined, d = 2) {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  return v.toFixed(d);
}

function vsPrev(v: number | null | undefined, prev: number | null | undefined) {
  if (v == null || prev == null || !Number.isFinite(v) || !Number.isFinite(prev) || prev === 0) {
    return undefined;
  }
  return v - prev;
}

function chgTone(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || v === 0) return "text-muted-foreground";
  return v > 0 ? "text-[#ff2d2d]" : "text-[#00d26a]";
}

function basicTd(key: ColKey, c: string, q: HubQuote | undefined) {
  const pct = q?.pct;
  const chg = quoteChg(q);
  if (key === "code") return <td className="code">{c}</td>;
  if (key === "name") return <td className="name font-semibold">{q?.name || c}</td>;
  if (key === "price") return <td className={cn("num", chgTone(pct))}>{fmtPrice(q?.price)}</td>;
  if (key === "pct") return <td className={cn("num", chgTone(pct))}>{fmtPct(pct)}</td>;
  if (key === "change") return <td className={cn("num", chgTone(chg))}>{fmtChg(chg)}</td>;
  if (key === "amount") return <td className="num">{fmtVol(q?.amount)}</td>;
  if (key === "turnover") return <td className="num">{fmtRate(q?.turnover)}</td>;
  if (key === "open") return <td className={cn("num", chgTone(vsPrev(q?.open, q?.prev)))}>{fmtPrice(q?.open)}</td>;
  if (key === "high") return <td className={cn("num", chgTone(vsPrev(q?.high, q?.prev)))}>{fmtPrice(q?.high)}</td>;
  if (key === "low") return <td className={cn("num", chgTone(vsPrev(q?.low, q?.prev)))}>{fmtPrice(q?.low)}</td>;
  return <td className="num">—</td>;
}

const MINUTE_DAYS_KEY = "ashare.minute.days";

function useAShareSeries(code: string, res: "1" | "5" | "1D", num: number, poll = false) {
  const [bars, setBars] = useState<AShareLightBar[]>([]);
  const [meta, setMeta] = useState<{
    code: string; name?: string; adjust?: string; prev_close?: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const gate = useRef(createSeriesGate());

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    const mine = gate.current.begin();
    if (!code) {
      if (!gate.current.take(mine, true)) return;
      setBars([]);
      setMeta(null);
      setErr(null);
      setLoading(false);
      return;
    }
    if (!opts?.quiet) setLoading(true);
    if (!opts?.quiet) setErr(null);
    try {
      const data = await loadLightKline(code, res, num, { bypassCache: !opts?.quiet });
      const snap = gate.current.take(mine, {
        bars: data.bars ?? [],
        meta: {
          code: data.code,
          name: data.name,
          adjust: data.adjust,
          prev_close: data.prev_close,
        },
      });
      if (!snap) return;
      setBars(snap.bars);
      setMeta(snap.meta);
      setErr(null);
    } catch (e) {
      if (!gate.current.take(mine, true)) return;
      // Quiet refresh keeps last-good. Do not banner over a chart that already painted.
      if (opts?.quiet) return;
      setBars([]);
      setMeta(null);
      setErr(e instanceof ApiError ? e.message : "K 线加载失败");
    } finally {
      if (gate.current.isCurrent(mine)) setLoading(false);
    }
  }, [code, res, num]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!code || !poll) return;
    let id = 0;
    const arm = () => {
      id = window.setTimeout(() => {
        if (!document.hidden) void load({ quiet: true });
        arm();
      }, hubPollMs(
        isFuturesCode(code) ? HUB_POLL_FUTURES_MS : MINUTE_POLL_MS,
        new Date(),
        isFuturesCode(code),
      ));
    };
    arm();
    const onVis = () => { if (!document.hidden) void load({ quiet: true }); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [code, load, poll]);
  return { bars, meta, loading, err, reload: load };
}

export type AShareChartPane = "table" | "minute" | "daily" | "charts";

export function AShareLightChart({
  seg = "kline",
  onSegChange,
  embedded = false,
  pane = "table",
}: {
  seg?: AShareChartSeg;
  onSegChange?: (seg: AShareChartSeg) => void;
  embedded?: boolean;
  pane?: AShareChartPane;
} = {}) {
  const [params, setParams] = useSearchParams();
  const urlCode = peekChartCode(params.get("code") || "");
  const codes = useWatchCodes();
  const [selected, setSelected] = useState<string>(() => urlCode || loadWatch()[0] || "");
  const [hint, setHint] = useState<string | null>(null);
  const search = useSuggestSearch({ skipCode: true });
  const [feedKind, setFeedKind] = useState<"filings" | "news">("filings");
  const [session, setSession] = useState(() => getAShareSession());
  const [minuteDays, setMinuteDays] = useState<1 | 2>(() => (storageGet(MINUTE_DAYS_KEY) === "2" ? 2 : 1));
  const listRef = useRef<HTMLDivElement>(null);
  const setSeg = (next: AShareChartSeg) => {
    if (onSegChange) {
      onSegChange(next);
      return;
    }
    const p = new URLSearchParams(params);
    if (next === "kline") p.delete("tab");
    else p.set("tab", next);
    if (selected) p.set("code", selected);
    setParams(p, { replace: true });
  };
  const pickStock = (c: string) => {
    setSelected(c);
    setSeg("kline");
  };

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setSession(getAShareSession());
    };
    tick();
    const t = window.setInterval(tick, 60_000);
    const onVis = () => { if (!document.hidden) setSession(getAShareSession()); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const persist = (next: string[]) => {
    saveWatch(next);
    const inWatch = Boolean(watchDigits(selected) && next.includes(selected));
    if (selected && watchDigits(selected) && !inWatch) setSelected(next[0] ?? "");
    if (!selected && next[0]) setSelected(next[0]);
  };

  const addOne = (code: string) => {
    const d = watchDigits(code);
    if (!d) return;
    if (codes.includes(d)) {
      setHint("已在列表里");
      search.clear();
      setSelected(d);
      return;
    }
    persist([...codes, d]);
    search.clear();
    setHint("已添加 1 只");
    setSelected(d);
  };

  const add = () => {
    const { next, added } = addCodes(codes, search.q);
    if (added > 0) {
      persist(next);
      search.clear();
      setHint(`已添加 ${added} 只`);
      setSelected(next[next.length - added] ?? next[0]);
      return;
    }
    const hit = search.hi >= 0 ? search.hits[search.hi] : search.hits[0];
    if (hit) {
      addOne(hit.code);
      return;
    }
    setHint(search.q.trim() ? "没识别到新的 6 位代码（或已在列表里）" : null);
    search.clear();
  };

  const remove = (c: string, e?: MouseEvent) => {
    e?.stopPropagation();
    persist(codes.filter((x) => x !== c));
  };

  const quotes = useQuotes(
    selected && !codes.includes(selected) ? [...codes, selected] : codes,
  );
  const [sort, setSort] = useState<SortState<Record<ColKey, unknown>>>({ key: null, dir: "desc" });
  const rows = useMemo(() => sortWatchCodes(codes, quotes, sort), [codes, quotes, sort]);
  const wantMin = !embedded || pane === "minute" || pane === "charts";
  const wantDay = !embedded || pane === "daily" || pane === "charts";
  const minute = useAShareSeries(wantMin ? selected : "", minuteDays === 2 ? "5" : "1", minuteDays === 2 ? 1000 : 240, true);
  const daily = useAShareSeries(wantDay ? selected : "", "1D", KLINE_NUM);
  const liveQuote = Boolean(selected && (isFuturesCode(selected) || session.kind === "open"));
  const qSel = selected ? quotes[selected] : undefined;
  const quoteTime = qSel && !qSel.fromStore ? qSel.time : undefined;
  const minBars = useMemo(
    () => overlayQuoteBar(minute.bars, qSel, "minute", liveQuote),
    [minute.bars, qSel, liveQuote],
  );
  const dayBars = useMemo(
    () => overlayQuoteBar(daily.bars, qSel, "daily", liveQuote),
    [daily.bars, qSel, liveQuote],
  );
  const wmName = minute.meta?.name || daily.meta?.name || (selected ? quotes[selected]?.name : "") || "";

  useEffect(() => {
    if (!urlCode) return;
    if (urlCode !== selected) setSelected(urlCode);
  }, [urlCode]); // eslint-disable-line react-hooks/exhaustive-deps -- only react to URL

  useEffect(() => {
    if (!selected) return;
    const cur = peekChartCode(params.get("code") || "");
    if (embedded) {
      if (cur === selected) return;
      const p = new URLSearchParams(params);
      p.set("code", selected);
      setParams(p, { replace: true });
      return;
    }
    const tab = CHART_SEGS.includes(seg) ? seg : "kline";
    if (cur === selected && params.get("tab") === tab) return;
    const p = new URLSearchParams(params);
    p.set("tab", tab);
    p.set("code", selected);
    setParams(p, { replace: true });
  }, [selected, seg, embedded]); // eslint-disable-line react-hooks/exhaustive-deps

  const showKline = seg === "kline";
  useEffect(() => {
    if (!selected || !listRef.current || !showKline) return;
    const el = listRef.current.querySelector(`[data-code="${selected}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, codes.length, showKline]);

  const sessionTone =
    session.kind === "open" ? "border-primary/40 bg-primary/10 text-primary"
      : session.kind === "closed" ? "border-border/50 bg-muted/30 text-muted-foreground"
        : "border-border/40 bg-muted/20 text-muted-foreground/80";

  const minuteExtra = (
    <div className="flex items-center gap-0.5">
      <span className="flex gap-0.5 rounded bg-white/[0.03] p-0.5 ring-1 ring-white/[0.06]">
        {([[1, "分时"], [2, "两日"]] as const).map(([n, lab]) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setMinuteDays(n);
              storageSet(MINUTE_DAYS_KEY, String(n));
            }}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              minuteDays === n ? "bg-primary/15 text-primary" : "text-slate-500 hover:text-slate-300",
            )}
          >
            {lab}
          </button>
        ))}
      </span>
      {selected && !isFuturesCode(selected) ? (
        <>
          <button
            type="button"
            onClick={() => setSeg("detail")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
          >
            <Search className="h-3 w-3" /> 详情
          </button>
          <button
            type="button"
            onClick={() => setSeg("feed")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
          >
            <Newspaper className="h-3 w-3" /> 公告
          </button>
        </>
      ) : null}
    </div>
  );

  if (embedded) {
    if (pane === "charts") {
      return (
        <div className="grid h-full min-h-0 min-w-0 grid-rows-2 gap-px bg-[#2a2a2a]">
          <AShareLcPane
            title={wmName || "分时"}
            kind="minute"
            code={selected}
            name={wmName}
            bars={minBars}
            prevClose={minute.meta?.prev_close}
            loading={minute.loading}
            err={minute.err}
            emptyHint="点自选或榜单一只"
            visible
            days={minuteDays}
            bare
            extra={minuteExtra}
            quoteTime={quoteTime}
            onRefresh={() => { void minute.reload(); }}
          />
          <AShareLcPane
            title={wmName || "日K"}
            kind="daily"
            code={selected}
            name={wmName}
            bars={dayBars}
            prevClose={daily.meta?.prev_close}
            loading={daily.loading}
            err={daily.err}
            emptyHint="点自选或榜单一只"
            visible
            bare
            quoteTime={quoteTime}
            onRefresh={() => { void daily.reload(); }}
          />
        </div>
      );
    }
    if (pane === "minute") {
      return (
        <AShareLcPane
          title={wmName || "分时"}
          kind="minute"
          code={selected}
          name={wmName}
          bars={minBars}
          prevClose={minute.meta?.prev_close}
          loading={minute.loading}
          err={minute.err}
          emptyHint="点自选或榜单一只"
          visible
          days={minuteDays}
          bare
          extra={minuteExtra}
          quoteTime={quoteTime}
          onRefresh={() => { void minute.reload(); }}
        />
      );
    }
    if (pane === "daily") {
      return (
        <AShareLcPane
          title={wmName || "日K"}
          kind="daily"
          code={selected}
          name={wmName}
          bars={dayBars}
          prevClose={daily.meta?.prev_close}
          loading={daily.loading}
          err={daily.err}
          emptyHint="点自选或榜单一只"
          visible
          bare
          quoteTime={quoteTime}
          onRefresh={() => { void daily.reload(); }}
        />
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-1.5 py-1">
          <div ref={search.boxRef} className="relative min-w-0 flex-1">
            <input
              value={search.q}
              onChange={(e) => search.type(e.target.value)}
              onFocus={() => search.hits.length && search.setOpen(true)}
              onKeyDown={(e) => search.onKeyDown(e, (h) => addOne(h.code), addOne)}
              placeholder="搜名称 / 拼音 / 代码"
              className="h-6 w-full rounded bg-slate-800/60 px-2 text-[11px] text-slate-200 placeholder:text-[9px] placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {search.open && (
              <SuggestHits
                hits={search.hits}
                hi={search.hi}
                onPick={(h) => addOne(h.code)}
                className="absolute left-0 top-7 z-20 w-56 overflow-hidden rounded border border-border bg-card shadow-lg"
              />
            )}
          </div>
          <button
            type="button"
            onClick={add}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/25"
          >
            <Plus className="h-3 w-3" /> 加
          </button>
        </div>
        {hint ? <p className="px-1.5 text-[10px] text-slate-500">{hint}</p> : null}
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
          {codes.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-slate-500">搜名称或代码加入自选</p>
          ) : (
            <table className="data-table dense">
              <thead>
                <tr>
                  {BASIC_COLS.map((h) => (
                    <th key={h.key} className={h.num ? "num" : undefined}>
                      <SortableHd
                        k={h.key}
                        label={h.label}
                        sort={sort}
                        onSort={(k) => setSort((s) => nextSort(s, k))}
                        className={h.num ? "justify-end" : "justify-start"}
                      />
                    </th>
                  ))}
                  <th className="act" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const q = quotes[c];
                  return (
                    <tr
                      key={c}
                      data-code={c}
                      onClick={() => pickStock(c)}
                      className={cn("cursor-pointer", c === selected && "!bg-primary/12")}
                    >
                      {BASIC_COLS.map((h) => (
                        <Fragment key={h.key}>{basicTd(h.key, c, q)}</Fragment>
                      ))}
                      <td className="act">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => remove(c, e)}
                          onKeyDown={(e) => { if (e.key === "Enter") remove(c); }}
                          className="inline-flex rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          title="移除"
                        >
                          <X className="h-3.5 w-3.5" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium",
            sessionTone,
          )}
          title={session.hint}
        >
          <span className={cn(
            "h-1.5 w-1.5 rounded-full",
            session.kind === "open" ? "bg-primary animate-pulse" : "bg-muted-foreground/45",
          )} />
          {session.label}
        </span>
        <span className="text-[11px] text-muted-foreground/65">{session.hint}</span>
        {session.kind !== "open" && (
          <span className="text-[11px] text-muted-foreground/50">· 加载中 / 非交易时段或源暂不可用时属正常</span>
        )}
      </div>

      <div className={cn(!showKline && "hidden")}>
        <div className="grid gap-4 xl:grid-cols-2">
          <GlassCard className="flex min-h-[520px] flex-col overflow-hidden !p-0">
            <div className="market-toolbar !justify-start !gap-2 !py-2">
              <span className="shrink-0 text-xs font-medium text-foreground">自选</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/55">{codes.length} 只</span>
              <div ref={search.boxRef} className="relative shrink-0">
                <input
                  value={search.q}
                  onChange={(e) => search.type(e.target.value)}
                  onFocus={() => search.hits.length && search.setOpen(true)}
                  onKeyDown={(e) => search.onKeyDown(e, (h) => addOne(h.code), addOne)}
                  placeholder="搜名称 / 拼音"
                  className="w-36 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
                />
                {search.open && (
                  <SuggestHits
                    hits={search.hits}
                    hi={search.hi}
                    onPick={(h) => addOne(h.code)}
                    className="absolute left-0 top-9 z-20 w-56 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
                  />
                )}
              </div>
              <button
                type="button"
                onClick={add}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary btn-press ring-1 ring-primary/20 hover:bg-primary/25"
              >
                <Plus className="h-3.5 w-3.5" /> 添加
              </button>
            </div>
            {hint ? <p className="px-3 py-1.5 text-[11px] text-muted-foreground">{hint}</p> : null}
            <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
              {codes.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <p className="text-xs text-muted-foreground">还没有自选</p>
                  <p className="text-[11px] text-muted-foreground/60">
                    上方搜名称 / 拼音 / 6 位代码添加, 或从「每日复盘」榜单点代码跳转过来。
                  </p>
                </div>
              ) : (
                <table className="data-table dense min-w-[1480px]">
                  <thead>
                    <tr>
                      {COLS.map((h) => (
                        <th key={h.key} className={h.num ? "num" : undefined}>
                          <SortableHd
                            k={h.key}
                            label={h.label}
                            sort={sort}
                            onSort={(k) => setSort((s) => nextSort(s, k))}
                            className={h.num ? "justify-end" : "justify-start"}
                          />
                        </th>
                      ))}
                      <th className="act" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => {
                      const q = quotes[c];
                      const pct = q?.pct;
                      const chg = quoteChg(q);
                      const active = c === selected;
                      return (
                        <tr
                          key={c}
                          data-code={c}
                          onClick={() => pickStock(c)}
                          className={cn("cursor-pointer", active && "!bg-primary/12")}
                        >
                          <td className="code">{c}</td>
                          <td className="name font-semibold">{q?.name || c}</td>
                          <td className={cn("num", chgTone(pct))}>{fmtPrice(q?.price)}</td>
                          <td className={cn("num", chgTone(pct))}>{fmtPct(pct)}</td>
                          <td className={cn("num", chgTone(chg))}>{fmtChg(chg)}</td>
                          <td className="num">{fmtPrice(q?.bid)}</td>
                          <td className="num">{fmtPrice(q?.ask)}</td>
                          <td className="num">{fmtVol(q?.bid_vol)}</td>
                          <td className="num">{fmtVol(q?.ask_vol)}</td>
                          <td className="num">{fmtVol(q?.volume)}</td>
                          <td className="num">{fmtVol(q?.amount)}</td>
                          <td className="num">{fmtRate(q?.turnover)}</td>
                          <td className="num">{fmtRate(q?.vol_ratio)}</td>
                          <td className="num">{fmtRate(q?.amplitude)}</td>
                          <td className={cn("num", chgTone(vsPrev(q?.open, q?.prev)))}>{fmtPrice(q?.open)}</td>
                          <td className={cn("num", chgTone(vsPrev(q?.high, q?.prev)))}>{fmtPrice(q?.high)}</td>
                          <td className={cn("num", chgTone(vsPrev(q?.low, q?.prev)))}>{fmtPrice(q?.low)}</td>
                          <td className="num">{fmtPrice(q?.prev)}</td>
                          <td className="num">{fmtPrice(q?.limit_up)}</td>
                          <td className="num">{fmtPrice(q?.limit_down)}</td>
                          <td className="num">{fmtPrice(q?.mcap_yi, 1)}</td>
                          <td className="num">{fmtPrice(q?.float_mcap_yi, 1)}</td>
                          <td className="num">{fmtPrice(q?.pe_ttm)}</td>
                          <td className="num">{fmtPrice(q?.pe_static)}</td>
                          <td className="num">{fmtPrice(q?.pb)}</td>
                          <td className="act">
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => remove(c, e)}
                              onKeyDown={(e) => { if (e.key === "Enter") remove(c); }}
                              className="inline-flex rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                              title="移除"
                            >
                              <X className="h-3.5 w-3.5" />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </GlassCard>

          <div className="grid min-h-[520px] min-w-0 grid-rows-2 gap-3">
            <AShareLcPane
              title="分时"
              kind="minute"
              code={selected}
              name={wmName}
              bars={minBars}
              prevClose={minute.meta?.prev_close}
              loading={minute.loading}
              err={minute.err}
              emptyHint="先从左侧表格点一只"
              visible={showKline}
              days={minuteDays}
              extra={minuteExtra}
              quoteTime={quoteTime}
              onRefresh={() => { void minute.reload(); }}
            />
            <AShareLcPane
              title="日K"
              kind="daily"
              code={selected}
              name={wmName}
              bars={dayBars}
              prevClose={daily.meta?.prev_close}
              loading={daily.loading}
              err={daily.err}
              emptyHint="先从左侧表格点一只"
              visible={showKline}
              quoteTime={quoteTime}
              onRefresh={() => { void daily.reload(); }}
            />
          </div>
        </div>
      </div>

      {seg === "detail" && (
        selected ? (
          <Suspense fallback={<PageFallback />}>
            <StockData embedded hideSearch externalCode={selected} />
          </Suspense>
        ) : (
          <GlassCard>
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-muted-foreground/70">还没有选中股票</p>
              <p className="text-[11px] text-muted-foreground/55">
                先到「K线」选一只自选股，再看估值 / 研报 / 资金等详情。
              </p>
              <button
                type="button"
                onClick={() => setSeg("kline")}
                className="mt-1 rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25"
              >
                去 K 线选股
              </button>
            </div>
          </GlassCard>
        )
      )}

      {seg === "feed" && (
        <GlassCard>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">自选公告 / 新闻</h3>
              <p className="text-[11px] text-muted-foreground/65">汇总本地自选近期公开披露与新闻 · 非推荐</p>
            </div>
            <ChipGroup>
              <Chip active={feedKind === "filings"} onClick={() => setFeedKind("filings")}>
                <span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" /> A股公告</span>
              </Chip>
              <Chip active={feedKind === "news"} onClick={() => setFeedKind("news")}>
                <span className="inline-flex items-center gap-1"><Newspaper className="h-3 w-3" /> 公开新闻</span>
              </Chip>
            </ChipGroup>
          </div>
          <WatchlistFeed kind={feedKind} storageKeyPrefix="ashare.chart.feed" />
        </GlassCard>
      )}
    </div>
  );
}
