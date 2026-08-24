// Trend chart math: stacked mainop / quality lines / leverage dual-axis.
import type { FinMain, FinMainOpHist, FinReportRow } from "@/lib/api";

export const SERIES = ["#ffcc00", "#ff4d4f", "#00d26a", "#f0b90b", "#fbbf24", "#a78bfa", "#f5c542", "#94a3b8"] as const;
export const SEG_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#64748b"] as const;
export const GRID = "#1e293b";
export const AXIS = "#475569";
export const ZERO = "#334155";
export const CROSSHAIR = "#64748b";
export const CHART_BG = "#0b1120";
export const TOOLTIP_BG = "#0b1120";

export type ChartTab = "perf" | "quality" | "leverage";

export interface PerfSeg {
  name: string;
  income: number;
  profit: number;
}

export interface PerfRow {
  date: string;
  segs: PerfSeg[];
  other: { income: number; profit: number };
  totalNet: number | null;
  revYoy: number | null;
  netYoy: number | null;
  yoy: (number | null)[];
  fallback: boolean;
  fullRev: number;
  fullNet: number;
}

export interface QualitySeries {
  key: "roe" | "gross_margin" | "net_margin";
  name: string;
  color: string;
  dash?: string;
  pts: string;
  lastY: number;
  lastV: number;
}

function alignZero(aMin: number, aMax: number, bMin: number, bMax: number) {
  const frac = (min: number, max: number) => (max > min && min < 0 ? -min / (max - min) : 0);
  const f = Math.min(Math.max(frac(aMin, aMax), frac(bMin, bMax)), 0.9);
  const adj = (min: number, max: number): [number, number] => {
    if (max <= min) return [min, min + 1];
    if (f <= 0) return [Math.min(min, 0), max];
    if (min >= 0) return [(-f * max) / (1 - f), max];
    const cur = -min / (max - min);
    if (cur < f) return [(-f * max) / (1 - f), max];
    if (cur > f) return [min, (-min * (1 - f)) / f];
    return [min, max];
  };
  return [adj(aMin, aMax), adj(bMin, bMax)] as const;
}

export type ChartLayout =
  | {
      mode: "perf";
      W: number; H: number; L: number; R: number; T: number; B: number;
      n: number; slot: number;
      cx: (i: number) => number;
      Ym: (v: number) => number; Yp: (v: number) => number;
      zeroY: number;
      ticks: { y: number; m: number }[];
      pctTicks: { y: number; label: string }[];
      rows: PerfRow[];
      segNames: string[];
      hasFallback: boolean;
      line: (key: "revYoy" | "netYoy") => string;
    }
  | {
      mode: "quality";
      W: number; H: number; L: number; R: number; T: number; B: number;
      n: number; slot: number;
      cx: (i: number) => number;
      ticks: { y: number; v: number }[];
      rows: FinReportRow[];
      series: QualitySeries[];
      labels: { s: QualitySeries; labelY: number }[];
    }
  | {
      mode: "leverage";
      W: number; H: number; L: number; R: number; T: number; B: number;
      n: number; slot: number;
      cx: (i: number) => number;
      ticks: { y: number; l: number; r: number }[];
      rows: FinReportRow[];
      debtBars: { x: number; w: number; v: number; y: number }[];
      roicLine: string;
      ocfLine: string;
      zeroL: number;
      Yl: (v: number) => number;
    };

function normRow(r: FinReportRow): FinReportRow {
  return {
    ...r,
    debt_ratio: r.debt_ratio ?? 0,
    roic: r.roic ?? 0,
    eps: r.eps ?? 0,
    ocf_ps: r.ocf_ps ?? 0,
  };
}

/** Three-mode chart layout from reports + mainop history + box size. */
export function computeChart(
  reports: FinReportRow[],
  tab: ChartTab,
  mainopHistory: FinMain["mainop_history"] | FinMainOpHist[] | undefined,
  size: { w: number; h: number },
): ChartLayout | null {
  const rows = reports.slice(0, 12).reverse().map(normRow);
  if (!rows.length) return null;
  const n = rows.length;
  const { w: W, h: H } = size;
  const L = 32;
  const R = tab === "quality" ? 56 : tab === "leverage" ? 50 : 34;
  const T = 8;
  const B = 14;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const slot = plotW / n;
  const cx = (i: number) => L + i * slot + slot / 2;

  if (tab === "perf") {
    const hist = mainopHistory || [];
    const byDate = new Map(hist.map((h) => [h.date, h]));
    const latestSegs = (() => {
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i].segments.length) return hist[i].segments;
      return [];
    })();
    const topNames = latestSegs.slice(0, 5).map((s) => s.name);
    const topSet = new Set(topNames);
    const per = rows.map((r) => {
      const m = byDate.get(r.date);
      const segs = topNames.map((name) => {
        const s = m?.segments.find((x) => x.name === name);
        return { name, income: s?.income ?? 0, profit: s?.profit ?? 0 };
      });
      const other = (m?.segments ?? []).filter((s) => !topSet.has(s.name)).reduce(
        (a, s) => ({ income: a.income + s.income, profit: a.profit + s.profit }),
        { income: 0, profit: 0 },
      );
      const fallback = !m || m.segments.length === 0;
      return {
        date: r.date,
        segs,
        other,
        totalNet: r.net_profit ?? null,
        revYoy: r.revenue_yoy ?? null,
        netYoy: r.profit_yoy ?? null,
        yoy: segs.map(() => null as number | null),
        fallback,
        fullRev: fallback ? r.revenue ?? 0 : 0,
        fullNet: fallback ? r.net_profit ?? 0 : 0,
      };
    });
    for (let i = 4; i < per.length; i++) {
      per[i].segs.forEach((s, si) => {
        const prev = per[i - 4].segs[si].income;
        if (prev > 0) per[i].yoy[si] = (s.income / prev - 1) * 100;
      });
    }
    const ext = per.map((r) => {
      const sum = (arr: { income: number; profit: number }[], pick: (s: { income: number; profit: number }) => number) =>
        arr.reduce((a, s) => a + pick(s), 0);
      const pos = Math.max(
        sum(r.segs, (s) => Math.max(s.income, 0)) + Math.max(r.other.income, 0) + Math.max(r.fullRev, 0),
        sum(r.segs, (s) => Math.max(s.profit, 0)) + Math.max(r.other.profit, 0) + Math.max(r.fullNet, 0),
      );
      const neg = Math.min(
        sum(r.segs, (s) => Math.min(s.income, 0)) + Math.min(r.other.income, 0) + Math.min(r.fullRev, 0),
        sum(r.segs, (s) => Math.min(s.profit, 0)) + Math.min(r.other.profit, 0) + Math.min(r.fullNet, 0),
      );
      return { pos, neg };
    });
    const mMax = Math.max(...ext.map((e) => e.pos), 1);
    const mMin = Math.min(...ext.map((e) => e.neg), 0);
    const pn = per.length;
    const pSlot = plotW / pn;
    const pcx = (i: number) => L + i * pSlot + pSlot / 2;
    const ly = (pct: number) => Math.log(1 + pct / 100);
    const pcts = per.flatMap((r) => [r.revYoy, r.netYoy]).filter((v): v is number => v != null && v > -100);
    const lyMin = Math.min(...pcts.map(ly), 0);
    const lyMax = Math.max(...pcts.map(ly), 0) || 1;
    const Ym = (v: number) => T + (1 - (v - mMin) / (mMax - mMin)) * plotH;
    const Yp = (v: number) => T + (1 - (ly(v) - lyMin) / (lyMax - lyMin)) * plotH;
    const ticks = [0.2, 0.4, 0.6, 0.8].map((f) => ({ y: T + f * plotH, m: mMax - f * (mMax - mMin) }));
    const pctTicks: { y: number; label: string }[] = [];
    for (let k = -2; k <= 6; k++) {
      const pct = (2 ** k - 1) * 100;
      const y = Yp(pct);
      if (y < T - 2 || y > T + plotH + 2) continue;
      pctTicks.push({ y, label: `${pct > 0 ? "+" : ""}${pct}%` });
    }
    const line = (key: "revYoy" | "netYoy") => {
      let d = "";
      let started = false;
      per.forEach((r, i) => {
        const v = r[key];
        if (v == null || v <= -100) { started = false; return; }
        d += `${started ? "L" : "M"}${pcx(i).toFixed(1)},${Yp(v).toFixed(1)}`;
        started = true;
      });
      return d;
    };
    return {
      mode: "perf", W, H, L, R, T, B, n: pn, slot: pSlot, cx: pcx, Ym, Yp, zeroY: Ym(0),
      ticks, pctTicks, rows: per,
      segNames: per.some((r) => !r.fallback) ? [...topNames, "其他"] : [...topNames],
      hasFallback: per.some((r) => r.fallback),
      line,
    };
  }

  if (tab === "quality") {
    const vals = rows.flatMap((r) => [r.roe, r.gross_margin, r.net_margin]);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const pad = (max - min) * 0.06 || 1;
    min -= pad;
    max += pad;
    const Y = (v: number) => T + (1 - (v - min) / (max - min)) * plotH;
    const ticks = [0.2, 0.4, 0.6, 0.8].map((f) => ({ y: T + f * plotH, v: max - f * (max - min) }));
    const series = (
      [
        { key: "roe" as const, name: "ROE", color: SERIES[0], dash: undefined as string | undefined },
        { key: "gross_margin" as const, name: "毛利", color: SERIES[4], dash: undefined as string | undefined },
        { key: "net_margin" as const, name: "净利", color: SERIES[1], dash: "3 2" },
      ]
    ).map((s) => ({
      ...s,
      pts: rows.map((r, i) => `${cx(i).toFixed(1)},${Y(r[s.key]).toFixed(1)}`).join(" "),
      lastY: Y(rows[n - 1][s.key]),
      lastV: rows[n - 1][s.key],
    }));
    const labels = [...series].sort((a, b) => a.lastY - b.lastY).map((s) => ({ s, labelY: s.lastY }));
    const TOP = T + 2;
    const BOTTOM = T + plotH - 4;
    const gap = labels.length > 1 ? Math.min(11, (BOTTOM - TOP) / (labels.length - 1)) : 11;
    let sy = Math.max(labels[0]?.labelY ?? TOP, TOP);
    sy = Math.min(sy, BOTTOM - gap * (labels.length - 1));
    sy = Math.max(sy, TOP);
    for (const l of labels) {
      l.labelY = sy;
      sy += gap;
    }
    return { mode: "quality", W, H, L, R, T, B, n, slot, cx, ticks, rows, series, labels };
  }

  const debtVals = rows.map((r) => r.debt_ratio ?? 0);
  const roicVals = rows.map((r) => r.roic ?? 0);
  const ocfVals = rows.map((r) => r.ocf_ps ?? 0);
  const [[lMin, lMax], [rMin, rMax]] = alignZero(
    Math.min(...debtVals, ...roicVals, 0),
    Math.max(...debtVals, ...roicVals, 1),
    Math.min(...ocfVals, 0),
    Math.max(...ocfVals, 0) || 1,
  );
  const Yl = (v: number) => T + (1 - (v - lMin) / (lMax - lMin)) * plotH;
  const Yr = (v: number) => T + (1 - (v - rMin) / (rMax - rMin)) * plotH;
  const levTicks = [0.2, 0.4, 0.6, 0.8].map((f) => ({
    y: T + f * plotH,
    l: lMax - f * (lMax - lMin),
    r: rMax - f * (rMax - rMin),
  }));
  const debtBars = rows.map((r, i) => ({
    x: cx(i) - slot * 0.2,
    w: slot * 0.4,
    v: r.debt_ratio ?? 0,
    y: Yl(r.debt_ratio ?? 0),
  }));
  const roicLine = rows.map((r, i) => `${cx(i).toFixed(1)},${Yl(r.roic ?? 0).toFixed(1)}`).join(" ");
  const ocfLine = rows.map((r, i) => `${cx(i).toFixed(1)},${Yr(r.ocf_ps ?? 0).toFixed(1)}`).join(" ");
  return {
    mode: "leverage", W, H, L, R, T, B, n, slot, cx, ticks: levTicks, rows,
    debtBars, roicLine, ocfLine, zeroL: Yl(0), Yl,
  };
}
