import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { LcHoverTag, LcLegend, LcWell, lcTone, type LcLegendItem } from "@/components/ui/LcFrame";
import type { UsKlineBar } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CandlestickSeries, HistogramSeries, applyTimeLabels, candleOpts, candleValues,
  seriesAlive, setLogScale, setPaneWatermark, setRefPriceLine, showLatest, styleLastTag,
  styleVolOverlay, useLcChart, useLcHoverTag, volOpts, volValues, wipeLc,
  type IPriceLine, type ISeriesApi, type ITextWatermarkPluginApi, type Time,
} from "@/lib/lcChart";

const VIEW_DAYS = 120;

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtVol(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

export function UsKlineChart({
  selected,
  bars,
  name,
  adjust,
  quotePrice,
  loading,
  error,
}: {
  selected: string;
  bars: UsKlineBar[];
  name?: string;
  adjust?: string;
  quotePrice?: number | null;
  loading: boolean;
  error: string | null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const { ref: chartRef, chartRef: lcRef, labelsRef, onHoverRef } = useLcChart();
  const bag = useRef<{
    candle: ISeriesApi<"Candlestick"> | null;
    vol: ISeriesApi<"Histogram"> | null;
  }>({ candle: null, vol: null });
  const refLine = useRef<IPriceLine | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  onHoverRef.current = setHoverIdx;

  useEffect(() => {
    setHoverIdx(null);
  }, [selected, bars]);

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

  const activeIdx = hoverIdx != null && bars[hoverIdx] ? hoverIdx : (bars.length ? bars.length - 1 : -1);
  const bar = activeIdx >= 0 ? bars[activeIdx] : null;
  const prevBar = activeIdx > 0 ? bars[activeIdx - 1] : null;
  const chg = bar && prevBar ? bar.close - prevBar.close : null;
  const chgPct = chg != null && prevBar && prevBar.close ? (chg / prevBar.close) * 100 : null;
  const hovering = hoverIdx != null && bars[hoverIdx] != null;
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current.candle,
    hovering ? bar?.close ?? null : null,
    prevBar?.close ?? null,
    fmtPrice,
    hoverIdx,
  );

  const usLegend: LcLegendItem[] = bar ? [
    { k: "O", v: fmtPrice(bar.open) },
    { k: "H", v: fmtPrice(bar.high) },
    { k: "L", v: fmtPrice(bar.low) },
    { k: "C", v: fmtPrice(bar.close), tone: lcTone(chg) },
    { k: "V", v: fmtVol(bar.volume), tone: "muted" },
  ] : [];

  return (
    <GlassCard className="p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-lg font-semibold tracking-tight">{selected || "—"}</span>
            <span className="truncate text-xs text-slate-500">{name || ""}</span>
            <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              {adjust === "qfq" ? "qfq" : "D"}
            </span>
            {hovering ? (
              <span className="font-mono text-[10px] tracking-wide text-primary/80">CROSSHAIR</span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className={cn(
              "font-mono text-2xl font-semibold tabular-nums",
              chgPct != null && chgPct > 0 ? "text-[#ff2d2d]"
                : chgPct != null && chgPct < 0 ? "text-[#00d26a]"
                  : "text-slate-200",
            )}>
              {fmtPrice(bar?.close ?? quotePrice)}
            </span>
            <span className={cn(
              "font-mono text-sm tabular-nums",
              chgPct != null && chgPct > 0 ? "text-[#ff2d2d]"
                : chgPct != null && chgPct < 0 ? "text-[#00d26a]"
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
        {error ? (
          <div className="absolute inset-0 z-20 flex items-center gap-2 bg-black/88 px-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        ) : null}
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
          </div>
        )}
        <LcLegend items={usLegend} />
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={chartRef} className="h-full w-full" />
      </LcWell>
    </GlassCard>
  );
}
