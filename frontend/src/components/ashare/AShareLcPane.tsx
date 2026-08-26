import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { LcHoverTag, LcLegend, LcWell, lcTone, type LcLegendItem } from "@/components/ui/LcFrame";
import type { AShareLightBar } from "@/lib/api";
import {
  concatDaySlots, lastFiniteIdx, padToSlots, tradingDayOf, tradingDaysOf,
} from "@/lib/derivMinuteAxis";
import { laterQuoteClock } from "@/lib/freshness";
import { isFuturesCode } from "@/lib/quoteHub";
import { cn } from "@/lib/utils";
import {
  CandlestickSeries, HistogramSeries, LineSeries, MA_COLORS, MA_PERIODS, applyTimeLabels,
  barOpenForVol, bindChgPriceAxis, candleOpts, candleValues, chgToneCls, type ChgPriceAxisPrimitive, ensureUpDown, lineValues,
  minuteHiLo, minuteLineOpts, minuteScaleRange, overlayLineOpts, paintCandles, paintHist, paintLine, paintUpDown, resizeLc,
  seriesAlive, setLogScale, setPaneWatermark, setRefPriceLine, showLatest,
  showSession, sma, sparseLine, styleLastTag, styleMinuteSymScale, styleVolPane, useLcChart,
  useLcHoverTag, volPaneOpts, volUp, volValues, wipeLc,
  type CandlestickData, type HistogramData, type IPriceLine, type ISeriesApi,
  type ISeriesUpDownMarkerPluginApi, type ITextWatermarkPluginApi,
  type LineData, type Time, type WhitespaceData,
} from "@/lib/lcChart";

const VIEW_DAYS = 120;

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null | undefined, d = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v.toFixed(d)).toLocaleString("zh-CN", { maximumFractionDigits: d });
}

function fmtVol(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1) + "万";
  return String(Math.round(v));
}

/** True if minute bars carry turnover or volume. Offshore hf_ often has neither. */
export function minuteHasFlow(bars: AShareLightBar[]): boolean {
  return bars.some((b) => Number(b.amount) > 0 || Number(b.volume) > 0);
}

export function ashareMinuteFrame(bars: AShareLightBar[], days: 1 | 2 = 1) {
  const tds = tradingDaysOf(bars.map((b) => b.datetime).filter(Boolean)).slice(-(days === 2 ? 2 : 1));
  if (!tds.length) return null;
  const want = new Set(tds);
  const kept = bars.filter((b) => want.has(tradingDayOf(b.datetime)));
  const { cats } = concatDaySlots(tds, "etf");
  return { cats, padded: padToSlots(kept, cats, (b) => b.datetime), days };
}

export function AShareLcPane({
  title,
  kind,
  code,
  name,
  bars,
  prevClose,
  loading,
  err,
  emptyHint,
  visible = true,
  extra,
  quoteTime,
  onRefresh,
  days = 1,
  bare = false,
  className,
}: {
  title: string;
  kind: "minute" | "daily";
  code: string;
  name: string;
  bars: AShareLightBar[];
  prevClose?: number | null;
  loading: boolean;
  err: string | null;
  emptyHint: string;
  visible?: boolean;
  extra?: ReactNode;
  quoteTime?: string;
  onRefresh: () => void;
  days?: 1 | 2;
  bare?: boolean;
  className?: string;
}) {
  const { ref: chartRef, chartRef: lcRef, labelsRef, onHoverRef } = useLcChart();
  const bag = useRef<{
    kind: "candle" | "line" | null;
    main: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null;
    vol: ISeriesApi<"Histogram"> | null;
    mas: Array<ISeriesApi<"Line">> | null;
    paintedTick: LineData[] | null;
    paintedPx: Array<LineData | WhitespaceData> | CandlestickData[] | null;
    paintedVol: Array<HistogramData | WhitespaceData> | null;
    paintedMa: Array<Array<LineData | WhitespaceData>> | null;
    chgAxis: { prim: ChgPriceAxisPrimitive | null };
  }>({
    kind: null, main: null, vol: null, mas: null,
    paintedTick: null, paintedPx: null, paintedVol: null, paintedMa: null,
    chgAxis: { prim: null },
  });
  const refLine = useRef<IPriceLine | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const tickRef = useRef<ISeriesApi<"Line"> | null>(null);
  const udRef = useRef<ISeriesUpDownMarkerPluginApi<Time> | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  onHoverRef.current = setHoverIdx;

  const isDaily = kind === "daily";
  const showVol = isDaily || minuteHasFlow(bars);
  const wmName = name.trim();
  const minute = useMemo(
    () => (isDaily || isFuturesCode(code) ? null : ashareMinuteFrame(bars, days)),
    [isDaily, bars, days, code],
  );

  useEffect(() => {
    const chart = lcRef.current;
    if (!chart) return;
    const wipeBag = () => {
      wipeLc(chart);
      bag.current = {
        kind: null, main: null, vol: null, mas: null,
        paintedTick: null, paintedPx: null, paintedVol: null, paintedMa: null,
        chgAxis: { prim: null },
      };
      refLine.current = null;
      wmRef.current = null;
      tickRef.current = null;
      udRef.current = null;
    };
    if (bars.length === 0) {
      if (loading) return;
      try {
        setPaneWatermark(chart, wmRef, "");
        wipeBag();
        labelsRef.current = [];
      } catch {
        wmRef.current = null;
      }
      return;
    }
    try {
      const seriesKind = isDaily ? "candle" as const : "line" as const;
      const finitePx = bars.map((b) => b.close).filter((v) => Number.isFinite(v));
      const baseline = (!isDaily && prevClose != null && Number.isFinite(prevClose))
        ? Number(prevClose)
        : (finitePx[0] ?? 0);
      const needWipe = bag.current.kind !== seriesKind
        || !seriesAlive(chart, bag.current.main)
        || (showVol ? !seriesAlive(chart, bag.current.vol) : bag.current.vol != null)
        || (isDaily && !bag.current.mas?.[0]);
      if (needWipe) {
        wipeBag();
        if (isDaily) {
          bag.current.main = chart.addSeries(CandlestickSeries, candleOpts());
          bag.current.mas = MA_PERIODS.map((n) => chart.addSeries(LineSeries, overlayLineOpts(MA_COLORS[n], "right")));
        } else {
          bag.current.main = chart.addSeries(LineSeries, minuteLineOpts());
        }
        if (showVol) {
          bag.current.vol = chart.addSeries(HistogramSeries, volPaneOpts(), 1);
          styleVolPane(chart, isDaily ? 0.22 : 0.24);
        }
        bag.current.kind = seriesKind;
      }
      setPaneWatermark(chart, wmRef, wmName ? [wmName, code] : code, 72);

      if (isDaily) {
        labelsRef.current = bars.map((b) => b.datetime);
        applyTimeLabels(chart, labelsRef, "md");
        const candles = candleValues(bars);
        const lastOnly = paintCandles(
          bag.current.main as ISeriesApi<"Candlestick">,
          candles,
          bag.current.paintedPx as CandlestickData[] | null,
        );
        bag.current.paintedPx = candles;
        const last = bars[bars.length - 1];
        styleLastTag(bag.current.main, last?.close, last?.open);
        setRefPriceLine(bag.current.main, refLine, bars.length > 1 ? bars[bars.length - 2].close : null);
        setLogScale(chart, finitePx.every((v) => v > 0));
        const volPts = volValues(bars.map((b) => ({
          value: b.volume,
          up: volUp(b.close, b.open, null),
        })), true);
        if (bag.current.vol) {
          paintHist(bag.current.vol, volPts, bag.current.paintedVol);
          bag.current.paintedVol = volPts;
        }
        const closes = bars.map((b) => b.close);
        const paintedMa: Array<Array<LineData | WhitespaceData>> = [];
        bag.current.mas?.forEach((s, i) => {
          const n = MA_PERIODS[i];
          const pts = sparseLine(sma(closes, n));
          paintLine(s, pts, bag.current.paintedMa?.[i] ?? null);
          paintedMa.push(pts);
        });
        bag.current.paintedMa = paintedMa;
        if (bag.current.main) {
          bindChgPriceAxis(
            chart,
            bag.current.main,
            bag.current.chgAxis,
            bars.length > 1 ? bars[bars.length - 2].close : null,
          );
        }
        if (!lastOnly) showLatest(chart, bars.length, VIEW_DAYS);
        return;
      }

      const cats = minute?.cats ?? bars.map((b) => b.datetime);
      const padded = minute?.padded ?? bars;
      const prices = padded.map((b) => (b && Number.isFinite(b.close) ? b.close : null));
      labelsRef.current = cats;
      applyTimeLabels(chart, labelsRef, days === 2 ? "mdhm" : "hm");
      const ln = bag.current.main as ISeriesApi<"Line">;
      const pxPts = sparseLine(prices);
      const lastOnly = paintLine(ln, pxPts, bag.current.paintedPx as Array<LineData | WhitespaceData> | null);
      bag.current.paintedPx = pxPts;
      const tickPts = lineValues(pxPts);
      paintUpDown(ensureUpDown(chart, tickRef, udRef), tickPts, bag.current.paintedTick);
      bag.current.paintedTick = tickPts;
      const lastI = lastFiniteIdx(prices, null);
      styleLastTag(ln, lastI != null ? prices[lastI] : null, baseline);
      setRefPriceLine(ln, refLine, baseline > 0 ? baseline : null);
      const rng = minuteScaleRange(prices, baseline > 0 ? baseline : null);
      ln.applyOptions({
        autoscaleInfoProvider: () => (
          rng ? { priceRange: { minValue: rng.min, maxValue: rng.max } } : null
        ),
      });
      styleMinuteSymScale(chart);
      setLogScale(chart, false);
      if (showVol) {
        let prevPx: number | null = baseline > 0 ? baseline : null;
        const volPts = volValues(padded.map((b) => {
          const px = b && Number.isFinite(b.close) ? b.close : null;
          const up = volUp(px, barOpenForVol(b?.open, px), prevPx);
          if (px != null) prevPx = px;
          return { value: b?.amount ?? null, up };
        }), false);
        if (bag.current.vol) {
          paintHist(bag.current.vol, volPts, bag.current.paintedVol);
          bag.current.paintedVol = volPts;
        }
      }
      if (bag.current.main) {
        bindChgPriceAxis(chart, bag.current.main, bag.current.chgAxis, baseline > 0 ? baseline : prevClose);
      }
      if (!lastOnly) showSession(chart, cats.length);
    } catch {
      /* LC throws Value is null if wipe/resize races; keep the pane */
    }
  }, [bars, prevClose, wmName, code, isDaily, showVol, days, loading, minute, lcRef, labelsRef]);

  useEffect(() => {
    if (!visible) return;
    const t = window.setTimeout(() => {
      const chart = lcRef.current;
      if (chart) resizeLc(chart, chartRef.current);
    }, 50);
    return () => window.clearTimeout(t);
  }, [visible, bars.length, minute?.cats.length, lcRef, chartRef]);

  let bar: AShareLightBar | null = null;
  let emptySlot = "";
  if (isDaily) {
    const activeIdx = hoverIdx != null && bars[hoverIdx] ? hoverIdx : (bars.length ? bars.length - 1 : -1);
    bar = activeIdx >= 0 ? bars[activeIdx] : null;
  } else {
    const prices = (minute?.padded ?? bars).map((b) => (b && Number.isFinite(b.close) ? b.close : null));
    const i = lastFiniteIdx(prices, hoverIdx);
    if (hoverIdx != null && i == null) {
      emptySlot = minute?.cats[hoverIdx] ?? "";
    } else if (i != null) {
      bar = (minute?.padded ?? bars)[i] ?? null;
    }
  }
  const prevBar = isDaily && bar ? bars[bars.indexOf(bar) - 1] ?? null : null;
  const barTd = bar?.datetime.slice(0, 10) ?? "";
  const lastTd = (bars[bars.length - 1]?.datetime || "").slice(0, 10);
  let dayPrev: number | null = null;
  if (!isDaily && days === 2 && barTd && barTd !== lastTd) {
    const prior = bars.filter((b) => b.datetime.slice(0, 10) < barTd);
    const lastPrior = prior[prior.length - 1]?.close;
    dayPrev = lastPrior != null && Number.isFinite(lastPrior) ? lastPrior : null;
  }
  const base = isDaily ? (prevBar?.close ?? null) : (dayPrev ?? prevClose ?? null);
  const chg = bar && base != null ? bar.close - base : null;
  const axis = useMemo(() => {
    if (isDaily) return null;
    const px = (minute?.padded ?? bars).map((b) => (b && Number.isFinite(b.close) ? b.close : null));
    const ext = minuteHiLo(px, prevClose);
    if (!ext) return null;
    return {
      maxPx: fmtPrice(ext.hi),
      minPx: fmtPrice(ext.lo),
      maxPct: fmtPct(ext.hiPct),
      minPct: fmtPct(ext.loPct),
      maxTone: chgToneCls(ext.hiPct),
      minTone: chgToneCls(ext.loPct),
    };
  }, [isDaily, minute, bars, prevClose]);
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current.main,
    hoverIdx != null ? (bar?.close ?? null) : null,
    base,
    undefined,
    hoverIdx,
  );

  const maTone: Record<(typeof MA_PERIODS)[number], LcLegendItem["tone"]> = {
    5: "flat",
    10: "px",
    20: "iv",
    60: "down",
  };
  const legend: LcLegendItem[] = [];
  if (bar) {
    if (isDaily) {
      const idx = bars.indexOf(bar);
      const closes = bars.map((b) => b.close);
      legend.push(
        { k: "O", v: fmtPrice(bar.open) },
        { k: "H", v: fmtPrice(bar.high) },
        { k: "L", v: fmtPrice(bar.low) },
        { k: "C", v: fmtPrice(bar.close), tone: lcTone(chg) },
        { k: "量", v: fmtVol(bar.volume), tone: "muted" },
      );
      for (const n of MA_PERIODS) {
        const v = sma(closes, n)[idx];
        if (v != null) legend.push({ k: `MA${n}`, v: fmtPrice(v), tone: maTone[n] });
      }
    } else {
      legend.push(
        { k: "T", v: days === 2 ? (bar.datetime.slice(5, 16) || bar.datetime) : (bar.datetime.slice(11, 16) || bar.datetime), tone: "muted" },
        { k: "P", v: fmtPrice(bar.close), tone: lcTone(chg) },
      );
      if (showVol) legend.push({ k: "额", v: fmtVol(bar.amount), tone: "muted" });
    }
  } else if (emptySlot) {
    legend.push({
      k: "T",
      v: days === 2 ? (emptySlot.slice(5, 16) || emptySlot) : (emptySlot.slice(11, 16) || emptySlot),
      tone: "muted",
    });
  }

  const quoteClock = laterQuoteClock(quoteTime, isDaily ? undefined : bars[bars.length - 1]?.datetime);

  const head = (
    <div className={cn("flex items-center justify-between gap-2", bare ? "px-1.5 py-0.5" : "mb-1.5")}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <p className={cn("shrink-0 truncate font-medium text-slate-200", bare ? "text-[10px]" : "text-xs")}>{title}</p>
        {!isDaily && legend.length > 0 ? (
          <LcLegend items={legend} className="!static !left-auto !top-auto !max-w-none min-w-0 flex-1" />
        ) : null}
        {!bare && bar && chg != null ? (
          <p className={cn(
            "font-sans text-[11px] tabular-nums",
            chg > 0 ? "text-[#ff2d2d]" : chg < 0 ? "text-[#00d26a]" : "text-slate-500",
          )}>
            {fmtPrice(bar.close)}
            <span className="ml-1.5">{chg > 0 ? "+" : ""}{chg.toFixed(2)}</span>
            <span className="ml-1">({fmtPct(base ? (chg / base) * 100 : null)})</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {quoteClock ? (
          <span
            className="shrink-0 font-sans text-[10px] tabular-nums text-slate-500"
            title={quoteTime || bars[bars.length - 1]?.datetime}
          >
            更新 {quoteClock}
          </span>
        ) : null}
        {extra}
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 ring-1 ring-white/[0.06] hover:text-slate-200"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
  const well = (
      <LcWell className={cn("flex-1", bare ? "min-h-0" : "min-h-[220px]")}>
        {!code && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/88 px-6 text-center">
            <p className="text-sm text-slate-400">{emptyHint}</p>
          </div>
        )}
        {err && code && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-black/88 px-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {err}
          </div>
        )}
        {loading && code && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
          </div>
        )}
        {isDaily ? <LcLegend items={legend} /> : null}
        {axis ? (
          <>
            <span className={cn("pointer-events-none absolute left-1.5 top-0.5 z-10 font-sans text-[11px] tabular-nums", axis.maxTone)}>{axis.maxPx}</span>
            <span className={cn("pointer-events-none absolute right-10 top-0.5 z-10 font-sans text-[11px] tabular-nums", axis.maxTone)}>{axis.maxPct}</span>
            <span className={cn("pointer-events-none absolute left-1.5 z-10 font-sans text-[11px] tabular-nums", axis.minTone, showVol ? "bottom-[24%]" : "bottom-1")}>{axis.minPx}</span>
            <span className={cn("pointer-events-none absolute right-10 z-10 font-sans text-[11px] tabular-nums", axis.minTone, showVol ? "bottom-[24%]" : "bottom-1")}>{axis.minPct}</span>
          </>
        ) : null}
        <LcHoverTag tag={hoverTag} y={tagY} />
        {code && bars.length > 0 && showVol && (
          <div className="pointer-events-none absolute bottom-[6%] left-2 z-10 text-[10px] text-slate-400">
            {isDaily ? "成交量" : "成交额"}
          </div>
        )}
        <div ref={chartRef} className="h-full w-full" />
      </LcWell>
  );
  if (bare) {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-col bg-black", className)}>
        {head}
        {well}
      </div>
    );
  }
  return (
    <GlassCard className={cn("flex min-h-0 min-w-0 flex-col p-3", className)}>
      {head}
      {well}
    </GlassCard>
  );
}
