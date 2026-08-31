import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { BacktestResult } from "@/lib/api";

export function EquityChart({ result, compare }: { result: BacktestResult; compare?: BacktestResult | null }) {
  const elRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const inst = echarts.init(el, undefined, { renderer: "canvas" });
    instRef.current = inst;
    const onResize = () => inst.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      inst.dispose();
      instRef.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    const dates = result.equity_curve.map((p) => p.date);
    const eq = result.equity_curve.map((p) => p.equity);
    const dd = result.drawdown_curve.map((p) => p.drawdown * 100);
    const benchMap = new Map((result.benchmark?.curve || []).map((p) => [p.date, p.equity]));
    const bench = dates.map((d) => benchMap.get(d) ?? null);
    const cmpMap = new Map((compare?.equity_curve || []).map((p) => [p.date, p.equity]));
    const cmp = dates.map((d) => cmpMap.get(d) ?? null);
    const cmpName = compare
      ? `对照 ${compare.strategy?.name || compare.run_id?.slice(0, 8) || "run"}`
      : "";
    inst.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: {
        trigger: "axis",
        backgroundColor: "#0f172a",
        borderColor: "#334155",
        textStyle: { color: "#e2e8f0", fontSize: 11 },
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [
        { left: 56, right: 16, top: 28, height: "54%" },
        { left: 56, right: 16, top: "78%", height: "16%" },
      ],
      xAxis: [
        { type: "category", data: dates, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: "#334155" } } },
        { type: "category", data: dates, gridIndex: 1, axisLabel: { color: "#64748b", fontSize: 10 }, axisLine: { lineStyle: { color: "#334155" } } },
      ],
      yAxis: [
        {
          type: "value",
          gridIndex: 0,
          splitLine: { lineStyle: { color: "#1e293b" } },
          axisLabel: {
            color: "#64748b",
            fontSize: 10,
            formatter: (v: number) => `${Math.round(v / 10000)}万`,
          },
        },
        {
          type: "value",
          gridIndex: 1,
          splitLine: { lineStyle: { color: "#1e293b" } },
          axisLabel: { color: "#64748b", fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}%` },
        },
      ],
      legend: { top: 0, textStyle: { color: "#94a3b8", fontSize: 10 } },
      series: [
        {
          name: "净值",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: eq,
          showSymbol: false,
          lineStyle: { color: "#ffcc00", width: 1.6 },
          areaStyle: { color: "rgba(255,204,0,0.12)" },
          markLine: result.oos?.split
            ? {
                symbol: "none",
                label: { color: "#fbbf24", fontSize: 10, formatter: "样本外" },
                lineStyle: { color: "#fbbf24", type: "dashed" },
                data: [{ xAxis: result.oos.split }],
              }
            : undefined,
        },
        {
          name: result.benchmark?.name || "沪深300",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: bench,
          showSymbol: false,
          lineStyle: { color: "#f59e0b", width: 1.2, type: "dashed" },
        },
        ...(compare
          ? [{
              name: cmpName,
              type: "line" as const,
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: cmp,
              showSymbol: false,
              lineStyle: { color: "#a78bfa", width: 1.3, type: "dotted" as const },
            }]
          : []),
        {
          name: "回撤",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: dd,
          showSymbol: false,
          lineStyle: { color: "#34d399", width: 1 },
          areaStyle: { color: "rgba(52,211,153,0.12)" },
        },
      ],
    }, { replaceMerge: ["series"] });
    inst.resize();
  }, [result, compare]);

  return <div ref={elRef} className="h-[320px] w-full" />;
}
