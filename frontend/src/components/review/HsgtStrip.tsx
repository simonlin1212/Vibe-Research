import { useMemo } from "react";
import type { HsgtLive } from "@/lib/api";
import { cn } from "@/lib/utils";

function Spark({ values }: { values: number[] }) {
  const path = useMemo(() => {
    if (values.length < 2) return "";
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const span = max - min || 1;
    const w = 120;
    const h = 28;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 2) - 1;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values]);
  const last = values[values.length - 1] ?? 0;
  const color = last >= 0 ? "#f87171" : "#34d399";
  return (
    <svg viewBox="0 0 120 28" className="h-7 w-[120px] shrink-0" preserveAspectRatio="none">
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

/** Compact northbound (HSGT) pulse: latest + minute spark. */
export function HsgtStrip({ data }: { data: HsgtLive | null }) {
  const pts = data?.points ?? [];
  const hgt = pts.map((p) => p.hgt_yi).filter((v): v is number => typeof v === "number");
  const latest = data?.latest;
  const h = latest?.hgt_yi;
  const s = latest?.sgt_yi;

  return (
    <div className="flex items-center gap-2 border-t border-slate-700/40 py-1">
      <span className="shrink-0 text-[10px] text-slate-500">北向</span>
      {hgt.length > 1 ? <Spark values={hgt} /> : <span className="text-[10px] text-slate-600">暂无</span>}
      <div className="ml-auto flex items-center gap-2 font-mono text-[10px] tabular-nums">
        <span>
          沪股通{" "}
          <span className={cn(h == null ? "text-slate-500" : h >= 0 ? "text-red-400" : "text-emerald-400")}>
            {h == null ? "—" : `${h > 0 ? "+" : ""}${h.toFixed(1)}亿`}
          </span>
        </span>
        <span className="text-slate-600">
          深股通{" "}
          <span className={cn(s == null ? "text-slate-600" : s >= 0 ? "text-red-400/80" : "text-emerald-400/80")}>
            {s == null ? "参考" : `${s > 0 ? "+" : ""}${s.toFixed(1)}亿`}
          </span>
        </span>
        {latest?.time && <span className="text-slate-600">{latest.time}</span>}
      </div>
    </div>
  );
}
