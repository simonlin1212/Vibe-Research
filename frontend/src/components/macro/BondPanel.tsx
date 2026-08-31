import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { CnBondYield } from "@/lib/api";

export function BondPanel({ data, err }: { data: CnBondYield | null; err: string | null }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const echartRef = useRef<echarts.ECharts | null>(null);
  const pts = data?.curve_points ?? [];

  useEffect(() => {
    const el = chartRef.current;
    if (!el || pts.length < 2) {
      echartRef.current?.dispose();
      echartRef.current = null;
      return;
    }
    let chart = echartRef.current;
    if (!chart || chart.getDom() !== el) {
      chart?.dispose();
      chart = echarts.init(el, undefined, { renderer: "canvas" });
      echartRef.current = chart;
    }
    const cssHsl = (name: string, fallback: string) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return raw ? `hsl(${raw})` : fallback;
    };
    const cText = cssHsl("--chart-text", "#94a3b8");
    const cAxis = cssHsl("--chart-axis", "#475569");
    const cGrid = cssHsl("--chart-grid", "#334155");
    const cPrimary = cssHsl("--primary", "#ffcc00");
    const step = Math.max(1, Math.floor(pts.length / 40));
    const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    chart.setOption({
      animation: false,
      grid: { left: 36, right: 8, top: 12, bottom: 22 },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const p = arr[0] as { data?: [number, number] } | undefined;
          const d = p?.data;
          if (!d) return "";
          return `${d[0]}Y: ${Number(d[1]).toFixed(2)}%`;
        },
      },
      xAxis: {
        type: "value",
        name: "年",
        nameTextStyle: { color: cText, fontSize: 10 },
        axisLabel: { color: cText, fontSize: 9, formatter: (v: number) => `${v}` },
        axisLine: { lineStyle: { color: cAxis } },
        splitLine: { show: false },
        min: 0,
        max: 30,
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: cText, fontSize: 9, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: cGrid, opacity: 0.25 } },
      },
      series: [{
        type: "line",
        data: sampled,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: { color: cPrimary, width: 2 },
        areaStyle: { color: "rgba(255,204,0,0.10)" },
      }],
    }, { notMerge: true });
    requestAnimationFrame(() => chart?.resize());
    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart?.dispose();
      if (echartRef.current === chart) echartRef.current = null;
    };
  }, [data]);

  if (err && !data?.terms) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!data?.terms || Object.keys(data.terms).length === 0) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <div className="flex flex-wrap gap-1.5">
        {(["1Y", "2Y", "5Y", "10Y", "30Y"] as const).map((k) => (
          <div key={k} className="min-w-[4rem] rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5 text-center">
            <p className="text-[10px] text-slate-500">{k}</p>
            <p className="font-mono text-sm font-semibold tabular-nums">
              {data.terms[k] != null ? `${data.terms[k].toFixed(2)}%` : "—"}
            </p>
          </div>
        ))}
      </div>
      {pts.length >= 2 ? (
        <div ref={chartRef} className="mt-2 min-h-[140px] w-full min-w-0 flex-1" />
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3 border-t border-slate-700/40 pt-2 text-[11px] text-slate-500">
        <span>
          10Y-2Y{" "}
          <span className="font-mono text-slate-200">
            {data.spread_10_2 == null ? "—" : `${data.spread_10_2 > 0 ? "+" : ""}${data.spread_10_2.toFixed(2)}`}
          </span>
        </span>
        <span>
          30Y-10Y{" "}
          <span className="font-mono text-slate-200">
            {data.spread_30_10 == null ? "—" : `${data.spread_30_10 > 0 ? "+" : ""}${data.spread_30_10.toFixed(2)}`}
          </span>
        </span>
        {data.date ? <span className="ml-auto">{data.date}</span> : null}
      </div>
      <p className="mt-1 text-[10px] text-slate-600">中债登公开曲线 · 只呈现</p>
    </div>
  );
}
