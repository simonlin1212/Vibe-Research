import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { KlineLink } from "@/components/cockpit/QuoteLine";
import { Activity, ShieldAlert, TrendingUp } from "lucide-react";
import { SectionHeader, ChipGroup, Chip } from "@/components/ui/SectionHeader";
import { PctChip } from "@/components/review/PctChip";
import { fmt, pctColor } from "@/components/review/format";
import { reviewPending } from "@/components/review/reviewPending";
import { ETF_SHARE_WATCH, type CnBondYield, type EtfFlow, type EtfShares, type LprData, type ShareholderChanges } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LcHoverTag, LcWell } from "@/components/ui/LcFrame";
import {
  LineSeries, applyTimeLabels, lcTime, seriesAlive, setPaneWatermark, useLcChart, useLcHoverTag, wipeLc,
  type ISeriesApi, type ITextWatermarkPluginApi, type Time,
} from "@/lib/lcChart";

const box = "overflow-hidden border border-[#2a2a2a] bg-black";

interface Props {
  etfShares: EtfShares | null;
  etfSharesList?: EtfShares[];
  etfFlow: EtfFlow | null;
  etfSort: "net_inflow" | "change_pct";
  onEtfSort: (v: "net_inflow" | "change_pct") => void;
  lpr: LprData | null;
  bondY: CnBondYield | null;
  shChg: ShareholderChanges | null;
  shType: "all" | "增持" | "减持";
  onShType: (v: "all" | "增持" | "减持") => void;
  moneyDone: boolean;
}

export function ReviewMoneySeg({
  etfShares,
  etfSharesList = [],
  etfFlow,
  etfSort,
  onEtfSort,
  lpr,
  bondY,
  shChg,
  shType,
  onShType,
  moneyDone,
}: Props) {
  const bondChartRef = useRef<HTMLDivElement>(null);
  const bondEchartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = bondChartRef.current;
    const pts = bondY?.curve_points ?? [];
    if (!el || pts.length < 2) {
      bondEchartRef.current?.dispose();
      bondEchartRef.current = null;
      return;
    }

    let chart = bondEchartRef.current;
    if (!chart || chart.getDom() !== el) {
      chart?.dispose();
      chart = echarts.init(el, undefined, { renderer: "canvas" });
      bondEchartRef.current = chart;
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
      if (bondEchartRef.current === chart) bondEchartRef.current = null;
    };
  }, [bondY]);

  return (
    <div className="space-y-3 p-1">
      <EtfShareBlock items={etfSharesList} fallback={etfShares} />
      <div>
        <SectionHeader
          icon={<TrendingUp className="h-3.5 w-3.5 text-primary" />}
          title="ETF 资金流"
          hint="东财 · 主力净流入(亿)"
          meta={etfFlow?.rows?.length ? `${etfFlow.rows.length} 只` : (moneyDone ? "暂无" : "加载中…")}
          actions={(
            <ChipGroup>
              {([["net_inflow", "净流入"], ["change_pct", "涨跌幅"]] as const).map(([k, label]) => (
                <Chip key={k} active={etfSort === k} onClick={() => onEtfSort(k)}>{label}</Chip>
              ))}
            </ChipGroup>
          )}
        />
        <div className={box}>
          {!etfFlow?.rows?.length ? (
            <div className="p-5">{reviewPending(moneyDone)}</div>
          ) : (
            <div className="overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {["#", "代码", "名称", "涨跌%", "主力净流入", "超大单", "大单"].map((h) => (
                      <th key={h} className={h === "名称" || h === "代码" ? "" : "num"}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {etfFlow.rows.map((r, i) => (
                    <tr key={r.code}>
                      <td className="num text-muted-foreground/50">{i + 1}</td>
                      <td className="font-mono text-xs">
                        <KlineLink code={r.code} className="hover:text-primary">{r.code}</KlineLink>
                      </td>
                      <td className="font-medium">{r.name}</td>
                      <td className="num"><PctChip pct={r.change_pct} /></td>
                      <td className={cn("num font-mono", pctColor(r.main_net_inflow))}>
                        {r.main_net_inflow > 0 ? "+" : ""}{fmt(r.main_net_inflow)} 亿
                      </td>
                      <td className={cn("num font-mono text-xs", pctColor(r.super_large_net))}>
                        {r.super_large_net > 0 ? "+" : ""}{fmt(r.super_large_net)}
                      </td>
                      <td className={cn("num font-mono text-xs", pctColor(r.large_net))}>
                        {r.large_net > 0 ? "+" : ""}{fmt(r.large_net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mt-1 text-[10px] text-slate-500">客观公开榜单，只呈现事实，不构成买卖建议。</p>
      </div>

      <div>
        <SectionHeader
          icon={<Activity className="h-3.5 w-3.5 text-primary" />}
          title="利率 · LPR / 国债"
          hint="中国货币网 · 中债登"
          meta={
            lpr?.latest?.date || bondY?.date
              ? `LPR ${lpr?.latest?.date ?? "—"} · 曲线 ${bondY?.date || "—"}`
              : (moneyDone ? "暂无" : "加载中…")
          }
        />
        <div className="grid gap-2 md:grid-cols-2">
          <div className={cn(box, "p-3")}>
            <h4 className="mb-2 text-xs font-semibold">LPR 报价</h4>
            {!lpr?.latest ? (
              reviewPending(moneyDone)
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border border-slate-700/40 bg-slate-900/40 p-2 text-center">
                    <p className="text-[10px] text-slate-500">1 年期</p>
                    <p className="mt-0.5 font-mono text-lg font-bold">{lpr.latest.one_year.toFixed(2)}%</p>
                  </div>
                  <div className="rounded border border-slate-700/40 bg-slate-900/40 p-2 text-center">
                    <p className="text-[10px] text-slate-500">5 年期以上</p>
                    <p className="mt-0.5 font-mono text-lg font-bold">{lpr.latest.five_year.toFixed(2)}%</p>
                  </div>
                </div>
                {lpr.rows.length > 1 && (
                  <div className="mt-2 max-h-36 space-y-1 overflow-y-auto border-t border-slate-700/40 pt-2">
                    {lpr.rows.slice(0, 8).map((r) => (
                      <div key={r.date} className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
                        <span className="w-24 shrink-0">{r.date}</span>
                        <span className="flex-1">1Y {r.one_year.toFixed(2)}%</span>
                        <span>5Y {r.five_year.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className={cn(box, "p-3")}>
            <h4 className="mb-2 text-xs font-semibold">中债国债收益率</h4>
            {!bondY?.terms || Object.keys(bondY.terms).length === 0 ? (
              reviewPending(moneyDone)
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {(["1Y", "2Y", "5Y", "10Y", "30Y"] as const).map((k) => (
                    <div key={k} className="min-w-[4rem] rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5 text-center">
                      <p className="text-[10px] text-slate-500">{k}</p>
                      <p className="font-mono text-sm font-semibold">
                        {bondY.terms[k] != null ? `${bondY.terms[k].toFixed(2)}%` : "—"}
                      </p>
                    </div>
                  ))}
                </div>
                {(bondY.curve_points?.length ?? 0) >= 2 && (
                  <div ref={bondChartRef} className="mt-2 h-[140px] w-full min-w-0" />
                )}
                <div className="mt-2 flex flex-wrap gap-3 border-t border-slate-700/40 pt-2 text-[11px] text-slate-500">
                  <span>
                    10Y-2Y{" "}
                    <span className="font-mono text-slate-200">
                      {bondY.spread_10_2 == null ? "—" : `${bondY.spread_10_2 > 0 ? "+" : ""}${bondY.spread_10_2.toFixed(2)}`}
                    </span>
                  </span>
                  <span>
                    30Y-10Y{" "}
                    <span className="font-mono text-slate-200">
                      {bondY.spread_30_10 == null ? "—" : `${bondY.spread_30_10 > 0 ? "+" : ""}${bondY.spread_30_10.toFixed(2)}`}
                    </span>
                  </span>
                  {bondY.date && <span className="ml-auto">{bondY.date}</span>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div>
        <SectionHeader
          icon={<ShieldAlert className="h-3.5 w-3.5 text-primary" />}
          title="股东 / 高管增减持"
          hint="东财披露 · 客观呈现"
          meta={shChg?.rows?.length ? `${shChg.rows.length} 条` : (moneyDone ? "暂无" : "加载中…")}
          actions={(
            <ChipGroup>
              {([["all", "全部"], ["增持", "增持"], ["减持", "减持"]] as const).map(([k, label]) => (
                <Chip key={k} active={shType === k} onClick={() => onShType(k)}>{label}</Chip>
              ))}
            </ChipGroup>
          )}
        />
        <div className={box}>
          {!shChg?.rows?.length ? (
            <div className="p-5">{reviewPending(moneyDone)}</div>
          ) : (
            <div className="overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {["日期", "代码", "名称", "变动人", "方向", "股数", "均价", "职务"].map((h) => (
                      <th key={h} className={h === "股数" || h === "均价" ? "num" : ""}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shChg.rows.map((r, i) => (
                    <tr key={`${r.code}-${r.date}-${r.person}-${i}`}>
                      <td className="font-mono text-xs text-muted-foreground">{r.date}</td>
                      <td className="font-mono text-xs">
                        <KlineLink code={r.code} className="hover:text-primary">{r.code}</KlineLink>
                      </td>
                      <td className="font-medium">{r.name}</td>
                      <td className="max-w-[6rem] truncate">{r.person || "—"}</td>
                      <td className={cn("text-xs font-medium", r.change_type === "增持" ? "text-danger" : "text-success")}>
                        {r.change_type}
                      </td>
                      <td className="num font-mono text-xs">
                        {r.change_shares ? `${(r.change_shares / 1e4).toFixed(1)} 万` : "—"}
                      </td>
                      <td className="num font-mono text-xs">{r.avg_price ? fmt(r.avg_price) : "—"}</td>
                      <td className="max-w-[5rem] truncate text-xs text-muted-foreground">{r.position || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mt-1 text-[10px] text-slate-500">公开披露数据，仅供了解变动事实，不构成买卖建议。</p>
      </div>
    </div>
  );
}

const ETF_SHARE_COLORS = ["#ffcc00", "#f0b90b", "#f59e0b", "#a78bfa", "#00d26a", "#ff4d4f"] as const;

const ETF_LINE = {
  lineWidth: 2 as const,
  lastValueVisible: false,
  priceLineVisible: false,
  crosshairMarkerVisible: true,
  priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
};

/** Union dates, keep gaps (no connectNulls). */
export function alignEtfShareDays(
  dates: string[],
  daily: Array<{ date: string; shares_yi?: number | null }>,
): Array<number | null> {
  const byDate = new Map(daily.map((d) => [d.date, d.shares_yi]));
  return dates.map((d) => {
    const v = byDate.get(d);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

function EtfShareChart({
  dates,
  series,
}: {
  dates: string[];
  series: Array<{ label: string; color: string; values: Array<number | null> }>;
}) {
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
    if (!chart) return;
    labelsRef.current = dates;
    applyTimeLabels(chart, labelsRef, "md");
    chart.applyOptions({
      timeScale: { minBarSpacing: 0.4, barSpacing: 2, rightOffset: 2, rightOffsetPixels: 8 },
    });
    if (bag.current.length !== series.length || bag.current.some((s) => !seriesAlive(chart, s))) {
      wipeLc(chart);
      bag.current = series.map((s) => chart.addSeries(LineSeries, { ...ETF_LINE, color: s.color }));
    }
    series.forEach((s, i) => {
      bag.current[i].applyOptions({ color: s.color });
      bag.current[i].setData(s.values.map((v, j) => {
        const time = lcTime(j);
        return v != null ? { time, value: v } : { time };
      }));
    });
    setPaneWatermark(chart, wmRef, "份额", 80);
    chart.timeScale().fitContent();
  }, [dates, series, chartRef, labelsRef]);

  const i = hover != null && dates[hover] ? hover : -1;
  const tipRows = i < 0 ? [] : series.map((s) => ({
    label: s.label,
    color: s.color,
    value: s.values[i] != null ? s.values[i]!.toFixed(2) : "—",
  }));
  const hitI = i < 0 ? -1 : series.findIndex((s) => s.values[i] != null && Number.isFinite(s.values[i]));
  const hit = hitI >= 0 ? series[hitI] : null;
  const hoverPx = hit && i >= 0 ? hit.values[i] : null;
  const prevPx = hit && i > 0 ? hit.values[i - 1] : null;
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current[hitI] ?? null,
    hoverPx,
    prevPx,
    (v) => v.toFixed(2),
    hover,
  );

  return (
    <div
      className="relative h-[200px]"
      onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        setPos({ x: e.clientX - box.left, y: e.clientY - box.top, w: box.width });
      }}
      onMouseLeave={() => { setHover(null); setPos(null); }}
    >
      <LcWell className="h-full rounded-md">
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={ref} className="h-full w-full" />
      </LcWell>
      {i >= 0 && pos && (
        <EtfShareTip date={dates[i]} rows={tipRows} x={pos.x} y={pos.y} boxW={pos.w} />
      )}
    </div>
  );
}

function EtfShareTip({
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
  const w = 148;
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

function EtfShareBlock({ items, fallback }: { items: EtfShares[]; fallback: EtfShares | null }) {
  const list = items.length ? items : (fallback ? [fallback] : []);
  const rows = ETF_SHARE_WATCH.map((w, i) => ({
    ...w,
    color: ETF_SHARE_COLORS[i] ?? ETF_SHARE_COLORS[0],
    item: list.find((x) => x.code === w.code) ?? null,
  }));
  const dailyKey = rows.map((r) => {
    const d = r.item?.daily ?? [];
    const last = d[d.length - 1];
    return `${r.code}:${d.length}:${last?.date ?? ""}:${last?.shares_yi ?? ""}`;
  }).join("|");
  const dates = useMemo(
    () => [...new Set(rows.flatMap((r) => (r.item?.daily ?? []).map((d) => d.date)))].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dailyKey],
  );
  const ready = dates.length >= 2 && rows.some((r) => (r.item?.daily?.length ?? 0) >= 2);
  const asOf = rows.map((r) => r.item?.latest?.date).find(Boolean);
  const series = useMemo(
    () => rows.filter((r) => r.item).map((r) => ({
      label: r.label,
      color: r.color,
      values: alignEtfShareDays(dates, r.item?.daily ?? []),
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dailyKey, dates],
  );

  return (
    <div>
      <SectionHeader
        icon={<Activity className="h-3.5 w-3.5 text-primary" />}
        title="ETF 份额"
        hint="上交所/深交所日频 · 亿份"
        meta={asOf ? `${asOf} · ${dates.length} 日` : "加载中…"}
      />
      <div className={cn(box, "grid gap-3 p-3 md:grid-cols-2 md:items-stretch")}>
        {!ready ? (
          <p className="flex items-center justify-center py-6 text-center text-[11px] text-slate-600">份额日线加载中, 首次会回补交易所缓存</p>
        ) : (
          <EtfShareChart dates={dates} series={series} />
        )}
        <div className="overflow-auto">
          <table className="data-table">
            <thead>
              <tr>
                {["代码", "名称", "最新份额", "日增", "日增%"].map((h) => (
                  <th key={h} className={h === "代码" || h === "名称" ? "" : "num"}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td className="font-mono text-xs">
                    <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: r.color }} />
                    {r.code}
                  </td>
                  <td className="font-medium">{r.item?.name || r.label}</td>
                  <td className="num font-mono text-xs">
                    {r.item?.latest?.shares_yi != null ? r.item.latest.shares_yi.toFixed(2) : "—"}
                  </td>
                  <td className={cn("num font-mono text-xs", pctColor(r.item?.chg_yi ?? 0))}>
                    {r.item?.chg_yi == null ? "—" : `${r.item.chg_yi > 0 ? "+" : ""}${r.item.chg_yi.toFixed(2)}`}
                  </td>
                  <td className={cn("num font-mono text-xs", pctColor(r.item?.chg_pct ?? 0))}>
                    {r.item?.chg_pct == null ? "—" : `${r.item.chg_pct > 0 ? "+" : ""}${r.item.chg_pct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">沪市日线来自上交所 ETF 规模披露, 深市来自深交所基金规模。只呈现事实, 不构成买卖建议。</p>
    </div>
  );
}
