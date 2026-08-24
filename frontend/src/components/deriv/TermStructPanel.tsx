import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as echarts from "echarts";
import { api, type OvlabFutureTs, type OvlabTermPoint, type OvlabWarehouseReceipt } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import type { DerivData } from "@/hooks/useDerivData";
import { num } from "@/components/ovlab/shared";
import { cn } from "@/lib/utils";
import { CellEmpty, ProdSearchSelect } from "./derivShared";

const AXIS = "#475569";
const SPLIT = "rgba(51,65,85,0.5)";
const BAR = "rgba(245,158,11,0.32)";

type CurvePt = {
  exp: string;
  dte: number;
  fwd: number;
  fwdYd: number | null;
  oi: number | null;
};

/** 曲线有效点: 排除当日到期 (dte<1 的 forward 易失真). */
function validSurf(curve: OvlabTermPoint[] | undefined): CurvePt[] {
  return (curve ?? [])
    .filter((p) => p.dte >= 1)
    .map((p) => ({ exp: p.exp, dte: p.dte, fwd: p.fwd, fwdYd: p.fwdYd ?? null, oi: p.oi ?? null }));
}

/** OpenVlab future-ts/{prodUnd}: 按到期月的期货价 + 持仓. 对齐 /future/term-structure. */
function parseFutTs(raw: OvlabFutureTs | null): CurvePt[] {
  if (!raw) return [];
  const out: CurvePt[] = [];
  for (const [exp, blk] of Object.entries(raw)) {
    if (!blk || typeof blk !== "object") continue;
    const fwd = num(blk.future_tday);
    const dte = num(blk.days_to_expiry);
    if (fwd === null || dte === null || dte < 1) continue;
    out.push({
      exp,
      dte,
      fwd,
      fwdYd: num(blk.future_yday),
      oi: num(blk.oi_tday),
    });
  }
  return out.sort((a, b) => a.dte - b.dte);
}

function fmtOi(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(Math.round(v));
}

function isEtf(prod: string): boolean {
  return /^\d+$/.test(prod);
}

/** Index futures: OpenVlab warehouse/history is empty (no receipts). */
const INDEX_UND = new Set(["IF", "IH", "IM"]);

function noReceipt(und: string): boolean {
  const u = und.trim().toUpperCase();
  return !u || isEtf(u) || INDEX_UND.has(u);
}

function pickDefaultUnd(withCurve: string[]): string | null {
  return withCurve.find((u) => !noReceipt(u)) ?? withCurve[0] ?? null;
}

function fmtPx(v: number): string {
  if (Math.abs(v) >= 1000) return String(Math.round(v));
  if (Math.abs(v) >= 100) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2);
}

function fmtChg(pct: number): string {
  if (Math.abs(pct) < 0.005) return "0%";
  const s = pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${pct > 0 ? "+" : ""}${s}%`;
}

function chgPct(p: CurvePt): number | null {
  if (p.fwdYd == null || p.fwdYd === 0) return null;
  return ((p.fwd - p.fwdYd) / p.fwdYd) * 100;
}

function chgTone(chg: number | null): "up" | "dn" | "flat" {
  if (chg == null || Math.abs(chg) < 0.005) return "flat";
  return chg > 0 ? "up" : "dn";
}

/** Point label on the today curve: 现值 + 涨幅. */
function ptLabel(p: CurvePt): string {
  const chg = chgPct(p);
  return `{px|${fmtPx(p.fwd)}}\n{${chgTone(chg)}|${chg == null ? "-" : fmtChg(chg)}}`;
}

const LABEL_RICH = {
  px: { fontSize: 10, color: "#e2e8f0", fontWeight: 600, lineHeight: 13 },
  up: { fontSize: 9, color: "#f87171", lineHeight: 12 },
  dn: { fontSize: 9, color: "#34d399", lineHeight: 12 },
  flat: { fontSize: 9, color: "#94a3b8", lineHeight: 12 },
};

function ReceiptSpark({ pts }: { pts: Array<[string, number]> }) {
  if (pts.length < 2) return null;
  const ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const w = 88;
  const h = 22;
  const pad = 1;
  const d = pts
    .map((pt, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((pt[1] - lo) / span) * (h - 2 * pad);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = pts[pts.length - 1][1] >= pts[0][1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={up ? "#f87171" : "#34d399"} strokeWidth="1.2" />
    </svg>
  );
}

function ReceiptStrip({
  sel, wr, loading, err,
}: {
  sel: string | null;
  wr: OvlabWarehouseReceipt | null;
  loading: boolean;
  err: string | null;
}) {
  const chg = wr ? num(wr.chg) : null;
  let body: ReactNode;
  if (!sel) {
    body = <span className="text-slate-500">-</span>;
  } else if (noReceipt(sel)) {
    body = <span className="text-slate-400">股指/ETF 无</span>;
  } else if (loading) {
    body = <span className="text-slate-500">…</span>;
  } else if (err) {
    body = <span className="text-slate-500">{err}</span>;
  } else if (!wr) {
    body = <span className="text-slate-500">未取到</span>;
  } else if (wr.last == null) {
    body = <span className="text-slate-500">无</span>;
  } else {
    body = (
      <>
        <span className="font-medium text-slate-100">{fmtOi(wr.last)}</span>
        <span className={cn(
          "tabular-nums",
          chg == null || chg === 0 ? "text-slate-500" : chg > 0 ? "text-red-400" : "text-emerald-400",
        )}>
          {chg == null ? "-" : `${chg > 0 ? "+" : ""}${fmtOi(chg)}`}
        </span>
        {wr.asOf && <span className="text-slate-500">{wr.asOf.slice(5)}</span>}
        <span className="ml-auto">
          <ReceiptSpark pts={wr.spark ?? []} />
        </span>
      </>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-y border-primary/25 bg-primary/[0.06] px-2 py-1 text-[12px] tabular-nums">
      <span className="shrink-0 font-semibold text-primary">仓单</span>
      {body}
    </div>
  );
}

/**
 * 期限结构: 选中品种远期曲线 (今实线/昨虚线) 与同月持仓柱叠同一图, 左轴价右轴仓.
 * 期货持仓走 future-ts oi_tday (同 openvlab.cn/future/term-structure);
 * ETF 无此接口, 退回 surface Call+Put.
 * 品种选择只在本格内, 不跟 T 型报价联动.
 * 仓单叠在同卡: warehouse/history 瘦身 (最新/日变/近90日折线).
 */
export function TermStructPanel({ d }: { d: DerivData }) {
  const unds = useMemo(
    // 全市场 domestic 品种 (ctamap-all), 无期权的品种上游 surface 返回空, 自动不进曲线
    () => [...new Set((d.rows ?? []).map((r) => String(r.prodUnd ?? "").trim()).filter(Boolean))],
    [d.rows],
  );
  const undsKey = unds.join(",");
  const { data } = usePolling(
    () => api.ovlabTermStructure(undsKey.split(",")),
    60_000,
    [undsKey],
  );

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of d.catalogRows) m.set(c.def.und, c.def.label);
    for (const r of d.rows ?? []) {
      const und = String(r.prodUnd ?? "");
      if (und && !m.has(und)) m.set(und, String(r.product_alias ?? und));
    }
    return (und: string) => m.get(und) ?? und;
  }, [d.catalogRows, d.rows]);

  const withCurve = useMemo(
    () => unds.filter((u) => (data?.curves?.[u]?.length ?? 0) > 0),
    [unds, data],
  );
  const [inner, setInner] = useState<string | null>(null);
  const fallback = pickDefaultUnd(withCurve);
  const sel = inner && withCurve.includes(inner) ? inner : fallback;
  const surfCurve = useMemo(() => validSurf(sel ? data?.curves?.[sel] : undefined), [data, sel]);

  const tsPoll = usePolling(
    () => api.ovlabFutureTs(sel ?? "").then((months) => ({ prod: sel, months })),
    60_000,
    [sel],
    Boolean(sel) && !isEtf(sel ?? ""),
  );
  const futCurve = useMemo(() => {
    if (!sel || tsPoll.data?.prod !== sel) return [];
    return parseFutTs(tsPoll.data.months);
  }, [sel, tsPoll.data]);

  const selCurve = futCurve.length > 0 ? futCurve : surfCurve;
  const oiVals = useMemo(() => selCurve.map((p) => p.oi), [selCurve]);

  const wrPoll = usePolling(
    () => api.ovlabWarehouseReceipt(sel ?? ""),
    300_000,
    [sel],
    Boolean(sel) && !noReceipt(sel ?? ""),
  );
  const wr = String(wrPoll.data?.product ?? "").toUpperCase() === String(sel ?? "").toUpperCase()
    ? wrPoll.data
    : null;
  const wrLoading = Boolean(sel) && !noReceipt(sel ?? "") && !wr && !wrPoll.error;

  const chartRef = useRef<HTMLDivElement | null>(null);
  const ecRef = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const ec = echarts.init(el);
    ecRef.current = ec;
    const ro = new ResizeObserver(() => ec.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      ec.dispose();
      ecRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ec = ecRef.current;
    if (!ec) return;
    if (!sel || selCurve.length === 0) {
      ec.clear();
      return;
    }
    const xs = selCurve.map((p) => p.exp.slice(2));
    ec.setOption(
      {
        animation: false,
        grid: { left: 40, right: 36, top: 36, bottom: 22 },
        tooltip: {
          trigger: "axis",
          backgroundColor: "rgba(15,23,42,0.95)",
          borderColor: "#334155",
          textStyle: { color: "#e2e8f0", fontSize: 11 },
          formatter: (ps: unknown) => {
            const arr = ps as Array<{ dataIndex: number; seriesName: string; value: number | null }>;
            const idx = arr[0]?.dataIndex ?? 0;
            const p = selCurve[idx];
            if (!p) return "";
            const chg = chgPct(p);
            const tone = chgTone(chg);
            const chgColor = tone === "up" ? "#f87171" : tone === "dn" ? "#34d399" : "#94a3b8";
            const rows = arr
              .filter((a) => a.value != null)
              .map((a) => `${a.seriesName} ${a.seriesName === "持仓" ? fmtOi(a.value) : a.value}`)
              .join("<br/>");
            return `${p.exp} (${p.dte}天)<br/>现值 ${fmtPx(p.fwd)} <span style="color:${chgColor}">${chg == null ? "-" : fmtChg(chg)}</span><br/>${rows}`;
          },
        },
        xAxis: {
          type: "category",
          data: xs,
          axisLine: { lineStyle: { color: SPLIT } },
          axisLabel: { color: AXIS, fontSize: 10 },
          axisTick: { show: false },
        },
        yAxis: [
          {
            type: "value",
            scale: true,
            axisLine: { show: false },
            axisLabel: { color: AXIS, fontSize: 10 },
            splitLine: { lineStyle: { color: SPLIT } },
          },
          {
            type: "value",
            min: 0,
            axisLine: { show: false },
            axisLabel: {
              color: "#f59e0b",
              fontSize: 10,
              formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(Math.round(v))),
            },
            splitLine: { show: false },
            splitNumber: 3,
          },
        ],
        series: [
          {
            name: "持仓",
            type: "bar",
            yAxisIndex: 1,
            data: oiVals,
            itemStyle: { color: BAR },
            barMaxWidth: 18,
            z: 1,
          },
          {
            name: "昨日",
            type: "line",
            yAxisIndex: 0,
            data: selCurve.map((p) => p.fwdYd),
            symbol: "circle",
            symbolSize: 3,
            lineStyle: { color: "#64748b", width: 1, type: "dashed" },
            itemStyle: { color: "#64748b" },
            connectNulls: true,
            z: 2,
          },
          {
            name: "今日",
            type: "line",
            yAxisIndex: 0,
            data: selCurve.map((p) => p.fwd),
            symbol: "circle",
            symbolSize: 4,
            lineStyle: { color: "#ffcc00", width: 1.6 },
            itemStyle: { color: "#ffcc00" },
            label: {
              show: true,
              position: "top",
              distance: 4,
              formatter: (arg: { dataIndex: number }) => {
                const p = selCurve[arg.dataIndex];
                return p ? ptLabel(p) : "";
              },
              rich: LABEL_RICH,
            },
            z: 3,
          },
        ],
      },
      { notMerge: true },
    );
  }, [sel, selCurve, oiVals]);

  const loading = !data;
  const empty = !!data && withCurve.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="relative z-20 flex shrink-0 items-center gap-2 px-2 pt-1 text-[12px]">
        <ProdSearchSelect
          value={sel ?? ""}
          options={withCurve.map((u) => ({ value: u, label: `${labelOf(u)} ${u}` }))}
          onChange={setInner}
        />
        <span className="ml-auto text-[11px] text-slate-600">左价 右仓 · 实=今 虚=昨</span>
      </div>
      <ReceiptStrip sel={sel} wr={wr} loading={wrLoading} err={wrPoll.error} />
      <div className="relative min-h-0 flex-1">
        <div ref={chartRef} className="absolute inset-0" />
        {(loading || empty || selCurve.length === 0) && (
          <div className="absolute inset-0">
            <CellEmpty text={loading ? "更新中…" : "未取到"} />
          </div>
        )}
      </div>
    </div>
  );
}
