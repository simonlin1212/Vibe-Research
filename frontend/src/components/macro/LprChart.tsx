import { useEffect, useMemo, useRef, useState } from "react";
import { LcHoverTag, LcWell } from "@/components/ui/LcFrame";
import type { LprRow } from "@/lib/api";
import {
  LineSeries, applyTimeLabels, lcTime, seriesAlive, setPaneWatermark, useLcChart, useLcHoverTag, wipeLc,
  type ISeriesApi, type ITextWatermarkPluginApi, type Time,
} from "@/lib/lcChart";

const LPR_LINE = {
  lineWidth: 2 as const,
  lastValueVisible: false,
  priceLineVisible: false,
  crosshairMarkerVisible: true,
  pointMarkersVisible: true,
  pointMarkersRadius: 3,
  priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
};

export const LPR_SERIES = [
  { key: "one_year" as const, label: "1Y", color: "#ffcc00" },
  { key: "five_year" as const, label: "5Y", color: "#38bdf8" },
] as const;

/** Oldest first so the LC axis walks left to right. */
export function lprChartPoints(rows: LprRow[]): {
  dates: string[];
  series: Array<{ label: string; color: string; values: Array<number | null> }>;
} {
  const chrono = [...rows]
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    dates: chrono.map((r) => r.date),
    series: LPR_SERIES.map((s) => ({
      label: s.label,
      color: s.color,
      values: chrono.map((r) => {
        const v = r[s.key];
        return v != null && Number.isFinite(v) ? v : null;
      }),
    })),
  };
}

function LprTip({
  date,
  rows,
  x,
  y,
  boxW,
}: {
  date: string;
  rows: Array<{ label: string; color: string; value: string }>;
  x: number;
  y: number;
  boxW: number;
}) {
  const w = 128;
  const h = 22 + rows.length * 18;
  const left = x + 14 + w > boxW ? Math.max(8, x - w - 10) : x + 12;
  const top = Math.max(8, Math.min(y - 10, 200 - h - 8));
  return (
    <div
      className="pointer-events-none absolute z-20 border border-[#2a2a2a] bg-black px-2 py-1.5 font-mono text-[10px]"
      style={{ left, top, width: w }}
    >
      <div className="mb-1 text-[10px] text-slate-400">{date}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-2 leading-[18px]">
          <span className="flex min-w-0 items-center gap-1.5 text-slate-300">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="truncate">{r.label}</span>
          </span>
          <span className="tabular-nums text-slate-100">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function LprChart({ rows }: { rows: LprRow[] }) {
  const { dates, series } = useMemo(() => lprChartPoints(rows), [rows]);
  const { ref, chartRef, labelsRef, onHoverRef } = useLcChart("glance");
  const bag = useRef<ISeriesApi<"Line">[]>([]);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  onHoverRef.current = (idx) => {
    setHover(idx);
    if (idx == null) setPos(null);
  };

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || dates.length < 2) return;
    labelsRef.current = dates.map((d) => (d.length >= 7 ? d.slice(0, 7) : d));
    applyTimeLabels(chart, labelsRef, "raw");
    chart.applyOptions({
      timeScale: { minBarSpacing: 2, barSpacing: 6, rightOffset: 2, rightOffsetPixels: 8 },
    });
    try {
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.10, bottom: 0.10 } });
    } catch {
      /* scale already gone */
    }
    if (bag.current.length !== series.length || bag.current.some((s) => !seriesAlive(chart, s))) {
      wipeLc(chart);
      bag.current = series.map((s) => chart.addSeries(LineSeries, { ...LPR_LINE, color: s.color }));
    }
    series.forEach((s, i) => {
      bag.current[i].applyOptions({ color: s.color });
      bag.current[i].setData(s.values.map((v, j) => {
        const time = lcTime(j);
        return v != null ? { time, value: v } : { time };
      }));
    });
    setPaneWatermark(chart, wmRef, "LPR", 56);
    chart.timeScale().fitContent();
  }, [dates, series, chartRef, labelsRef]);

  const i = hover != null && dates[hover] ? hover : -1;
  const tipRows = i < 0 ? [] : series.map((s) => ({
    label: s.label,
    color: s.color,
    value: s.values[i] != null ? `${s.values[i]!.toFixed(2)}%` : "—",
  }));
  const hitI = i < 0 ? -1 : series.findIndex((s) => s.values[i] != null && Number.isFinite(s.values[i]));
  const hit = hitI >= 0 ? series[hitI] : null;
  const hoverPx = hit && i >= 0 ? hit.values[i] : null;
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current[hitI] ?? null,
    hoverPx,
    hoverPx,
    (v) => `${v.toFixed(2)}%`,
    hover,
  );

  return (
    <div
      className="relative mt-2 min-h-[140px] w-full min-w-0 flex-1"
      onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        setPos({ x: e.clientX - box.left, y: e.clientY - box.top, w: box.width });
      }}
      onMouseLeave={() => { setHover(null); setPos(null); }}
    >
      <LcWell className="h-full min-h-[140px] rounded-md">
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={ref} className="h-full w-full" />
      </LcWell>
      {i >= 0 && pos ? (
        <LprTip date={dates[i]} rows={tipRows} x={pos.x} y={pos.y} boxW={pos.w} />
      ) : null}
    </div>
  );
}
