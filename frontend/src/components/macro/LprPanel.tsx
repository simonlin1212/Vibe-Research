import { lazy, Suspense } from "react";
import type { LprData } from "@/lib/api";

const LPR_SERIES = [
  { key: "one_year" as const, label: "1Y", color: "#ffcc00" },
  { key: "five_year" as const, label: "5Y", color: "#38bdf8" },
] as const;

const LprChart = lazy(() =>
  import("@/components/macro/LprChart").then((m) => ({ default: m.LprChart })),
);

export function LprPanel({ data, err }: { data: LprData | null; err: string | null }) {
  if (err && !data?.latest) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!data?.latest) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }
  const ready = data.rows.length >= 2;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <div className="grid grid-cols-2 gap-2">
        {LPR_SERIES.map((s) => (
          <div key={s.key} className="rounded border border-slate-700/40 bg-slate-900/40 p-2 text-center">
            <p className="flex items-center justify-center gap-1 text-[10px] text-slate-500">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
              {s.key === "one_year" ? "1 年期" : "5 年期以上"}
            </p>
            <p className="mt-0.5 font-mono text-lg font-bold tabular-nums">{data.latest![s.key].toFixed(2)}%</p>
          </div>
        ))}
      </div>
      {ready ? (
        <Suspense fallback={<div className="mt-2 min-h-[140px] flex-1" />}>
          <LprChart rows={data.rows} />
        </Suspense>
      ) : null}
      <p className="mt-2 text-[10px] text-slate-600">全国银行间同业拆借中心公开报价 · 只呈现</p>
    </div>
  );
}
