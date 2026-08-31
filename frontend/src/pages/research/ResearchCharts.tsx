import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ResearchCorrelation, ResearchKline } from "@/lib/api";

export function CorrHeat({ data }: { data: ResearchCorrelation }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !data.matrix?.length) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    const labels = data.codes;
    const heat = data.matrix.flatMap((row, i) =>
      row.map((v, j) => [j, i, v == null ? "-" : v]),
    );
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        formatter: (p: { data?: [number, number, number | string] }) => {
          const d = p.data;
          if (!d) return "";
          return `${labels[d[1]]} × ${labels[d[0]]}<br/>r = ${d[2]}`;
        },
      },
      grid: { left: 72, right: 24, top: 16, bottom: 48 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: "#94a3b8", fontSize: 10, rotate: 30 },
        axisLine: { lineStyle: { color: "#334155" } },
      },
      yAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: "#94a3b8", fontSize: 10 },
        axisLine: { lineStyle: { color: "#334155" } },
      },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        textStyle: { color: "#94a3b8", fontSize: 10 },
        inRange: { color: ["#fb7185", "#1e293b", "#ffcc00"] },
      },
      series: [
        {
          type: "heatmap",
          data: heat,
          label: {
            show: labels.length <= 8,
            color: "#e2e8f0",
            fontSize: 10,
            formatter: (p: { data?: [number, number, number | string] }) =>
              p.data && p.data[2] !== "-" ? Number(p.data[2]).toFixed(2) : "",
          },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [data]);

  return <div ref={elRef} className="h-[420px] w-full" />;
}

export function ResearchKlineChart({ data }: { data: ResearchKline }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !data.bars?.length) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    const bars = data.bars;
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 12, bottom: 28 },
      xAxis: {
        type: "category",
        data: bars.map((b) => b.date),
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#334155" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: "#1e293b" } },
        axisLabel: { color: "#64748b", fontSize: 10 },
      },
      series: [
        {
          type: "candlestick",
          data: bars.map((b) => [b.open, b.close, b.low, b.high]),
          itemStyle: {
            color: "#f43f5e",
            color0: "#10b981",
            borderColor: "#f43f5e",
            borderColor0: "#10b981",
          },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [data]);

  return <div ref={elRef} className="h-[380px] w-full" />;
}
