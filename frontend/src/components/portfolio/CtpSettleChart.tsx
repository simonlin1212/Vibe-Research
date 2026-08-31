import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { CtpPortfolioData, CtpSettlementRangeData } from "@/lib/api";
import { ymdInput } from "@/components/portfolio/format";
import { SETTLE_CHARTS, liveSettlePreview, type SettleChartKey } from "@/components/portfolio/ctpUtils";

function previewLive(data: CtpPortfolioData | null, range: CtpSettlementRangeData | null) {
  return liveSettlePreview({
    equity: data?.account?.market_equity ?? data?.account?.client_equity ?? data?.account?.balance,
    tradingDay: data?.trading_day,
    deposit: data?.account?.deposit,
    withdraw: data?.account?.withdraw,
    commission: data?.account?.commission,
    perf: range?.analytics?.perf,
    fallbackDate: ymdInput(new Date()),
  });
}

export function CtpSettleChart({
  visible,
  rangeData,
  data,
  settleChart,
}: {
  visible: boolean;
  rangeData: CtpSettlementRangeData | null;
  data: CtpPortfolioData | null;
  settleChart: SettleChartKey;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!visible) return;
    const el = elRef.current;
    if (!el) return;
    const meta = SETTLE_CHARTS.find((c) => c.key === settleChart)!;
    let raw = (rangeData?.analytics?.charts?.[settleChart]
      || (settleChart === "equity"
        ? (rangeData?.chart || []).map((p) => ({ date: p.date, value: p.equity }))
        : [])
    ).map((p) => ({ date: p.date, value: p.value, live: false as boolean }));

    let liveAppended = false;
    {
      const live = previewLive(data, rangeData);
      if (live) {
        const liveValue =
          settleChart === "equity" ? live.equity
          : settleChart === "nav" ? live.nav
          : settleChart === "cum_return" ? (live.nav - 1) * 100
          : settleChart === "cum_pnl_wan" ? live.cumIncome / 10000
          : null;
        if (liveValue != null && Number.isFinite(liveValue)) {
          raw = [...raw, { date: live.date, value: liveValue, live: true }];
          liveAppended = true;
        }
      } else if (settleChart === "equity") {
        const liveEq = data?.account?.market_equity ?? data?.account?.client_equity ?? data?.account?.balance;
        const td = (data?.trading_day || "").replace(/-/g, "");
        const liveDate = /^\d{8}$/.test(td)
          ? `${td.slice(0, 4)}-${td.slice(4, 6)}-${td.slice(6, 8)}`
          : ymdInput(new Date());
        const hasLive = liveEq != null && Number.isFinite(Number(liveEq));
        const hasSettleDay = raw.some((p) => p.date === liveDate);
        if (hasLive && !hasSettleDay && !(rangeData?.analytics?.perf || []).length) {
          raw = [{ date: liveDate, value: Number(liveEq), live: true }];
          liveAppended = true;
        }
      }
    }

    if (!instRef.current) instRef.current = echarts.init(el);
    const inst = instRef.current;
    const css = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const cText = `hsl(${css("--muted-foreground", "215 16% 57%")})`;
    const cAxis = `hsl(${css("--border", "217 20% 22%")})`;
    const cGrid = `hsl(${css("--border", "217 20% 22%")})`;
    const cLine = "#ffcc00";
    if (!raw.length) {
      inst.clear();
      inst.setOption({
        title: {
          text: "暂无足够结算数据",
          left: "center",
          top: "center",
          textStyle: { color: cText, fontSize: 13, fontWeight: 400 },
        },
      });
      return;
    }
    const dates = raw.map((p) => p.date);
    const vals = raw.map((p) => p.value);
    const axisFmt = (v: number) => {
      if (settleChart === "equity") return `${Math.round(v / 10000)}万`;
      if (settleChart === "cum_pnl_wan") return `${Math.round(v)}万`;
      if (settleChart === "cum_return") return `${Math.round(v)}%`;
      if (settleChart === "nav") return Number(v).toFixed(4);
      return String(v);
    };
    const tipFmt = (v: number) => {
      if (settleChart === "equity") {
        return `${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
      }
      if (settleChart === "cum_pnl_wan") {
        const yuan = v * 10000;
        return `${yuan.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
      }
      if (settleChart === "cum_return") return `${v.toFixed(2)}%`;
      if (settleChart === "nav") return Number(v).toFixed(4);
      return String(v);
    };
    const cornerText = (idx: number) => {
      const i = Math.max(0, Math.min(idx, raw.length - 1));
      const p = raw[i];
      const tag = p.live ? " · 实时" : "";
      return `${p.date}${tag}\n${meta.label} ${tipFmt(p.value)}`;
    };
    const lastIdx = raw.length - 1;
    const seriesData = vals.map((v, i) => {
      if (liveAppended && i === lastIdx) {
        return {
          value: v,
          symbol: "circle",
          symbolSize: 8,
          itemStyle: { color: cLine, borderColor: "#fff", borderWidth: 1 },
        };
      }
      return v;
    });

    inst.setOption({
      animation: false,
      title: {
        show: true,
        left: 56,
        top: 6,
        text: cornerText(lastIdx),
        textStyle: {
          color: cText,
          fontSize: 12,
          fontWeight: 400,
          lineHeight: 18,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        },
      },
      tooltip: {
        trigger: "axis",
        showContent: false,
        axisPointer: { type: "line", lineStyle: { color: cAxis, type: "dashed" } },
      },
      grid: { left: 52, right: 20, top: 44, bottom: 40, containLabel: false },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: cAxis } },
        axisLabel: { color: cText, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: meta.unit,
        nameTextStyle: { color: cText, fontSize: 10 },
        splitLine: { lineStyle: { color: cGrid, opacity: 0.35 } },
        axisLabel: { color: cText, fontSize: 10, formatter: (v: number) => axisFmt(v) },
      },
      series: [
        {
          name: meta.label,
          type: "line",
          data: seriesData,
          showSymbol: false,
          symbol: "circle",
          symbolSize: 6,
          connectNulls: true,
          lineStyle: { width: 2, color: cLine },
          itemStyle: { color: cLine },
          emphasis: { focus: "none", scale: true, lineStyle: { width: 2.5, color: cLine }, itemStyle: { color: cLine } },
          blur: { lineStyle: { opacity: 1, color: cLine }, itemStyle: { opacity: 1 } },
        },
      ],
    }, { notMerge: true });

    const bumpResize = () => {
      try {
        inst.resize({ width: "auto", height: "auto" });
      } catch {
        inst.resize();
      }
    };
    requestAnimationFrame(() => {
      bumpResize();
      requestAnimationFrame(bumpResize);
    });
    const resizeTimers = [50, 200, 400].map((ms) => window.setTimeout(bumpResize, ms));

    const setCorner = (idx: number) => {
      inst.setOption({ title: { text: cornerText(idx) } }, { lazyUpdate: true });
    };

    const resolveIdx = (ev: unknown): number | null => {
      const e = ev as {
        currTrigger?: string;
        axesInfo?: Array<{
          axisDim?: string;
          value?: number | string;
          seriesDataIndices?: Array<{ dataIndex?: number }>;
        }>;
      };
      if (e?.currTrigger === "leave") return null;
      const xAxis = (e.axesInfo ?? []).find((a) => a.axisDim === "x") ?? e.axesInfo?.[0];
      const fromSeries = xAxis?.seriesDataIndices?.find((s) => Number.isInteger(s?.dataIndex));
      if (fromSeries && Number.isInteger(fromSeries.dataIndex)) {
        return fromSeries.dataIndex as number;
      }
      const val = xAxis?.value;
      if (typeof val === "number" && Number.isFinite(val)) {
        const i = Math.round(val);
        if (i >= 0 && i < dates.length) return i;
      }
      if (val != null) {
        const i = dates.indexOf(String(val));
        if (i >= 0) return i;
      }
      return null;
    };

    const onPointer = (ev: unknown) => {
      const idx = resolveIdx(ev);
      if (idx == null) {
        setCorner(lastIdx);
        return;
      }
      setCorner(idx);
    };

    const zr = inst.getZr();
    const onMove = (e: { offsetX: number; offsetY: number }) => {
      const point: [number, number] = [e.offsetX, e.offsetY];
      try {
        if (!inst.containPixel({ gridIndex: 0 }, point)) return;
        const px = inst.convertFromPixel({ xAxisIndex: 0 }, point);
        const xVal = Array.isArray(px) ? px[0] : px;
        const di = Math.round(Number(xVal));
        if (Number.isFinite(di) && di >= 0 && di < dates.length) setCorner(di);
      } catch {
        /* ignore during dispose */
      }
    };
    const onGlobalOut = () => setCorner(lastIdx);

    inst.off("updateAxisPointer");
    inst.on("updateAxisPointer", onPointer);
    zr.off("mousemove", onMove);
    zr.off("globalout", onGlobalOut);
    zr.on("mousemove", onMove);
    zr.on("globalout", onGlobalOut);

    const onWinResize = () => bumpResize();
    window.addEventListener("resize", onWinResize);
    return () => {
      resizeTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("resize", onWinResize);
      inst.off("updateAxisPointer", onPointer);
      zr.off("mousemove", onMove);
      zr.off("globalout", onGlobalOut);
    };
  }, [
    visible, rangeData, settleChart,
    data?.account?.market_equity, data?.account?.client_equity, data?.account?.balance,
    data?.account?.deposit, data?.account?.withdraw, data?.account?.commission, data?.trading_day,
  ]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!visible) return;
      const inst = instRef.current;
      if (!inst) return;
      requestAnimationFrame(() => {
        try {
          inst.resize({ width: "auto", height: "auto" });
        } catch {
          inst.resize();
        }
      });
    });
    ro.observe(el);
    const parent = el.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [visible, !!data?.account, rangeData?.analytics?.summary?.days]);

  useEffect(() => () => {
    instRef.current?.dispose();
    instRef.current = null;
  }, []);

  return <div ref={elRef} className="h-56 w-full min-w-0 overflow-hidden rounded-lg border border-border/40 bg-muted/10" />;
}
