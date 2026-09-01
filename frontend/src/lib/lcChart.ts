/** TradingView-style Lightweight Charts for K/minute cards. ECharts stays on non-time-series. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createChart,
  createOptionsChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  BaselineSeries,
  createSeriesMarkers,
  createTextWatermark,
  createUpDownMarkers,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type ISeriesUpDownMarkerPluginApi,
  type ITextWatermarkPluginApi,
  type MouseEventParams,
  type UTCTimestamp,
  type LineData,
  type WhitespaceData,
  type HistogramData,
  type CandlestickData,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type ISeriesPrimitive,
  type ISeriesPrimitiveAxisView,
  type SeriesAttachedParameter,
} from "lightweight-charts";

export {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  BaselineSeries,
  createSeriesMarkers,
  LineStyle,
  PriceScaleMode,
};
export type {
  IChartApi, ISeriesApi, IPriceLine, ISeriesMarkersPluginApi,
  ISeriesUpDownMarkerPluginApi, ITextWatermarkPluginApi, MouseEventParams,
  SeriesMarker, SeriesType, Time, LineData, WhitespaceData, HistogramData, CandlestickData,
};

/** THS desk: hard red/green, not Binance pink/teal. */
export const UP = "#ff2d2d";
export const DN = "#00d26a";
export const UP_VOL = "rgba(255,45,45,0.50)";
export const DN_VOL = "rgba(0,210,106,0.50)";
export const IV_COLOR = "#8b7cff";
export const OI_COLOR = "#f0b90b";
export const PX_LINE = "#ffffff";
export const MA_PERIODS = [5, 10, 20, 60] as const;
export const MA_COLORS: Record<(typeof MA_PERIODS)[number], string> = {
  5: "#ffffff",
  10: "#ffcc00",
  20: "#e040fb",
  60: "#00d26a",
};

const INK = "#c8cdd6";
const GRID = "rgba(255,255,255,0.10)";
const HAIR = "rgba(255,204,0,0.55)";
const TAG = "#1a1400";
/** Axis is canvas. Mono fonts slash the zero; YaHei does not. */
const FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';

/** Logical unix seconds so lunch/night gaps stay one bar, not hours of empty axis. */
export const LC_ORIGIN = 1_700_000_000;

export type LcPreset = "desk" | "glance";

export function lcTime(i: number): UTCTimestamp {
  return (LC_ORIGIN + i) as UTCTimestamp;
}

export type TimeLabelMode = "hm" | "md" | "mdhm" | "raw";

export function labelAt(time: unknown, labels: string[]): string {
  if (typeof time === "number") return labels[Math.round(time - LC_ORIGIN)] ?? "";
  if (typeof time === "string") return time;
  return "";
}

export function formatLabel(lab: string, mode: TimeLabelMode): string {
  if (!lab) return "";
  if (mode === "hm") return lab.slice(11, 16) || lab;
  if (mode === "md") return lab.length >= 10 ? lab.slice(5, 10) : lab;
  if (mode === "mdhm") {
    const m = lab.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/);
    return m ? `${m[2]}-${m[3]} ${m[4]}` : lab;
  }
  return lab;
}

/** Resize/fitContent fires a move with no point. That is not mouse leave. */
export function skipResizeCrosshair(raw: unknown): boolean {
  const p = raw as { currTrigger?: string; point?: unknown };
  if (!p) return true;
  if (p.currTrigger === "leave") return false;
  return "point" in p && p.point == null;
}

/** Keep last hover when LC emits a resize blank; leave still clears. */
export function nextHoverIdx(prev: number | null, raw: unknown, n: number): number | null {
  if (skipResizeCrosshair(raw)) return prev;
  return hoverIdxFromParam(raw, n);
}

/** Crosshair / leftover echarts axis-pointer -> category index. */
export function hoverIdxFromParam(raw: unknown, n: number): number | null {
  const p = raw as MouseEventParams & {
    currTrigger?: string;
    axesInfo?: Array<{ axisDim?: string; value?: unknown; seriesDataIndices?: Array<{ dataIndex?: number }> }>;
  };
  if (!p) return null;
  if (p.currTrigger === "leave") return null;
  if ("point" in p && p.point == null) return null;
  if (typeof p.logical === "number" && Number.isFinite(p.logical)) {
    const i = Math.round(p.logical);
    return i >= 0 && i < n ? i : null;
  }
  if (typeof p.time === "number") {
    const i = Math.round(p.time - LC_ORIGIN);
    return i >= 0 && i < n ? i : null;
  }
  return null;
}

export function sparseLine(vals: Array<number | null | undefined>): Array<LineData | WhitespaceData> {
  return vals.map((v, i) => {
    const time = lcTime(i);
    if (v == null || !Number.isFinite(v)) return { time };
    return { time, value: v };
  });
}

/** Drop empty slots so the line connects (echarts connectNulls). */
export function finiteLine(vals: Array<number | null | undefined>): LineData[] {
  const out: LineData[] = [];
  vals.forEach((v, i) => {
    if (v != null && Number.isFinite(v) && v > 0) out.push({ time: lcTime(i), value: v });
  });
  return out;
}

export function candleValues(
  bars: Array<{ open: number; high: number; low: number; close: number }>,
): CandlestickData[] {
  return bars.map((b, i) => ({
    time: lcTime(i),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

/** Simple MA. Nulls do not enter the window. */
export function sma(values: Array<number | null | undefined>, n: number): Array<number | null> {
  const out: Array<number | null> = [];
  const q: number[] = [];
  let sum = 0;
  for (const raw of values) {
    if (raw == null || !Number.isFinite(raw)) {
      out.push(null);
      continue;
    }
    q.push(raw);
    sum += raw;
    if (q.length > n) {
      const left = q.shift();
      if (left != null) sum -= left;
    }
    out.push(q.length === n ? sum / n : null);
  }
  return out;
}

/** Volume bar: this bar close >= open (missing open -> prev close). OpenVlab light chart same rule. */
export function volUp(
  close: number | null | undefined,
  open: number | null | undefined,
  prev: number | null | undefined,
): boolean {
  if (close == null || !Number.isFinite(close)) return false;
  const ref = open != null && Number.isFinite(open) ? open : prev;
  if (ref == null || !Number.isFinite(ref)) return true;
  return close >= ref;
}

/** Tencent minute prints the last price into O/H/L/C. Ignore that fake open. */
export function barOpenForVol(
  open: number | null | undefined,
  close: number | null | undefined,
): number | null {
  if (open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close)) return null;
  if (open === close) return null;
  return open;
}

export function volValues(
  pts: Array<{ value: number | null | undefined; up: boolean }>,
  translucent = true,
): Array<HistogramData | WhitespaceData> {
  const upC = translucent ? UP_VOL : UP;
  const dnC = translucent ? DN_VOL : DN;
  return pts.map((p, i) => {
    const time = lcTime(i);
    if (p.value == null || !Number.isFinite(p.value)) return { time };
    return { time, value: p.value, color: p.up ? upC : dnC };
  });
}

const AXIS_BORDER = "rgba(255,255,255,0.14)";

export type PxPrec = { precision: number; minMove: number };

/** AG 1dp, AU 2dp; else sample (>=10000 -> 1, <1 -> 4, else 2). */
export function pxPrec(codeOrUnd?: string | null, sample?: number | null): PxPrec {
  const s = (codeOrUnd ?? "").toUpperCase();
  if (s === "AG" || s.startsWith("AG_") || /^AG\d/.test(s)) return { precision: 1, minMove: 0.1 };
  if (s === "AU" || s.startsWith("AU_") || /^AU\d/.test(s)) return { precision: 2, minMove: 0.01 };
  if (sample != null && Number.isFinite(sample)) {
    const a = Math.abs(sample);
    if (a >= 10_000) return { precision: 1, minMove: 0.1 };
    if (a > 0 && a < 1) return { precision: 4, minMove: 0.0001 };
  }
  return { precision: 2, minMove: 0.01 };
}

export function priceFormatOf(codeOrUnd?: string | null, sample?: number | null) {
  const { precision, minMove } = pxPrec(codeOrUnd, sample);
  return { type: "price" as const, precision, minMove };
}

export function fmtPx(v: number, codeOrUnd?: string | null): string {
  return v.toFixed(pxPrec(codeOrUnd, v).precision);
}

function fmtHoverPct(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtHoverPx(v: number) {
  return Number(v.toFixed(2)).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** (price - ref) / ref. Minute vs 昨收/昨结; daily vs prev bar. */
export function vsRefPct(price: number | null | undefined, ref: number | null | undefined): number | null {
  if (price == null || ref == null || !Number.isFinite(price) || !Number.isFinite(ref) || ref === 0) return null;
  return ((price - ref) / ref) * 100;
}

/** Y-axis / corner text: +0% and up red, below 0 green. */
export function chgToneCls(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "text-slate-400";
  return pct >= 0 ? "text-[#ff2d2d]" : "text-[#00d26a]";
}

export function chgToneHex(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return INK;
  return pct >= 0 ? UP : DN;
}

/** Nice 1/2/5 * 10^n ticks so the right scale reads 4660 / 4680, not 4663. */
export function nicePriceTicks(lo: number, hi: number, maxN = 7): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const span = hi - lo;
  const raw = span / Math.max(2, maxN - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = (err >= 5 ? 5 : err >= 2 ? 2 : 1) * mag;
  const start = Math.ceil((lo - step * 1e-9) / step) * step;
  const out: number[] = [];
  for (let p = start; p <= hi + step * 1e-9; p += step) {
    out.push(Number(p.toPrecision(12)));
  }
  return out;
}

export function formatAxisPx(p: number, precision = 2): string {
  if (Math.abs(p - Math.round(p)) < 1e-6 && Math.abs(p) >= 10) return String(Math.round(p));
  return p.toFixed(precision);
}

/** Right-scale tick on 分时: +1.20% / 0.00% / -0.50%. */
export function formatAxisPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  if (Math.abs(pct) < 5e-13) return "0.00%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export type ChgAxisKind = "price" | "pct";

function priceFromPct(ref: number, pct: number): number {
  return ref * (1 + pct / 100);
}

class ChgTickView implements ISeriesPrimitiveAxisView {
  constructor(private y: number, private label: string, private color: string) {}
  /** Negative so LC auto-layout does not reserve a blank slot next to the fixed label. */
  coordinate() { return -10000; }
  fixedCoordinate() { return this.y; }
  text() { return this.label; }
  textColor() { return this.color; }
  backColor() { return "rgba(0,0,0,0)"; }
  tickVisible() { return false; }
}

/** Last-price plate on the right scale. Last in the view list so ticks cannot cover it. */
class ChgLastView implements ISeriesPrimitiveAxisView {
  constructor(private y: number, private label: string, private up: boolean) {}
  coordinate() { return this.y; }
  fixedCoordinate() { return this.y; }
  text() { return this.label; }
  textColor() { return "#fff"; }
  backColor() { return this.up ? UP : DN; }
  tickVisible() { return false; }
}

export const LAST_TAG_GAP = 14;

/** False when a tick would sit on the last-price plate. */
export function tickClearsLast(y: number, lastY: number | null | undefined, gap = LAST_TAG_GAP): boolean {
  if (lastY == null || !Number.isFinite(lastY)) return true;
  return Math.abs(y - lastY) >= gap;
}

/** Recolor the right price scale vs 昨收/昨结. Native labels stay transparent. */
export class ChgPriceAxisPrimitive implements ISeriesPrimitive {
  private _ref: number | null = null;
  private _last: number | null = null;
  private _kind: ChgAxisKind = "price";
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _request: (() => void) | null = null;
  private _views: ISeriesPrimitiveAxisView[] = [];

  setRef(ref: number | null | undefined) {
    this._ref = ref != null && Number.isFinite(ref) && ref > 0 ? ref : null;
    this.updateAllViews();
    this._request?.();
  }

  setLast(last: number | null | undefined) {
    this._last = last != null && Number.isFinite(last) ? last : null;
    this.updateAllViews();
    this._request?.();
  }

  setKind(kind: ChgAxisKind) {
    this._kind = kind === "pct" ? "pct" : "price";
    this.updateAllViews();
    this._request?.();
  }

  attached(param: SeriesAttachedParameter) {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<SeriesType>;
    this._request = param.requestUpdate;
    this.updateAllViews();
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._request = null;
    this._views = [];
  }

  updateAllViews() {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) {
      this._views = [];
      return;
    }
    let rng: { from: number; to: number } | null = null;
    try {
      rng = chart.priceScale("right").getVisibleRange();
    } catch {
      rng = null;
    }
    if (!rng || !Number.isFinite(rng.from) || !Number.isFinite(rng.to)) {
      this._views = [];
      return;
    }
    let precision = 2;
    try {
      const fmt = series.options().priceFormat as { precision?: number };
      if (typeof fmt.precision === "number") precision = fmt.precision;
    } catch {
      /* series gone */
    }
    let lastY: number | null = null;
    if (this._last != null) {
      try {
        lastY = series.priceToCoordinate(this._last);
      } catch {
        lastY = null;
      }
      if (lastY != null && !Number.isFinite(lastY)) lastY = null;
    }
    const next: ISeriesPrimitiveAxisView[] = [];
    const usePct = this._kind === "pct" && this._ref != null;
    const loPct = usePct ? vsRefPct(rng.from, this._ref) : null;
    const hiPct = usePct ? vsRefPct(rng.to, this._ref) : null;
    const tickVals = usePct && loPct != null && hiPct != null
      ? nicePriceTicks(loPct, hiPct)
      : nicePriceTicks(rng.from, rng.to);
    for (const t of tickVals) {
      const p = usePct && this._ref != null ? priceFromPct(this._ref, t) : t;
      let y: number | null = null;
      try {
        y = series.priceToCoordinate(p);
      } catch {
        y = null;
      }
      if (y == null || !Number.isFinite(y)) continue;
      if (!tickClearsLast(y, lastY)) continue;
      const label = usePct ? formatAxisPct(t) : formatAxisPx(t, precision);
      next.push(new ChgTickView(y, label, chgToneHex(vsRefPct(p, this._ref))));
    }
    if (lastY != null && this._last != null) {
      const lastPct = vsRefPct(this._last, this._ref);
      const up = this._ref == null || this._last >= this._ref;
      const lastLabel = usePct && lastPct != null
        ? formatAxisPct(lastPct)
        : formatAxisPx(this._last, precision);
      next.push(new ChgLastView(lastY, lastLabel, up));
    }
    this._views = next;
  }

  priceAxisViews() {
    return this._views;
  }
}

export function hideNativePriceLabels(chart: IChartApi): void {
  try {
    chart.priceScale("right").applyOptions({
      textColor: "rgba(0,0,0,0)",
      ticksVisible: false,
    });
  } catch {
    /* scale gone */
  }
}

export function bindChgPriceAxis(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  slot: { prim: ChgPriceAxisPrimitive | null },
  ref: number | null | undefined,
  last?: number | null,
  kind: ChgAxisKind = "price",
): void {
  if (!slot.prim) {
    slot.prim = new ChgPriceAxisPrimitive();
    series.attachPrimitive(slot.prim);
    hideNativePriceLabels(chart);
  }
  slot.prim.setKind(kind);
  slot.prim.setRef(ref);
  slot.prim.setLast(last);
  try {
    series.applyOptions({ lastValueVisible: false });
  } catch {
    /* series gone */
  }
}

/** Session high / low vs 昨收. Corner labels use this, not the padded scale ends. */
export function minuteHiLo(
  prices: Array<number | null | undefined>,
  prev: number | null | undefined,
): { hi: number; lo: number; hiPct: number | null; loPct: number | null } | null {
  const finite = prices.filter((p): p is number => p != null && Number.isFinite(p));
  if (!finite.length) return null;
  const hi = Math.max(...finite);
  const lo = Math.min(...finite);
  return { hi, lo, hiPct: vsRefPct(hi, prev), loPct: vsRefPct(lo, prev) };
}

/** Symmetric 分时 scale around prev close. Span is the larger of session high / low vs 昨收. */
export function minuteScaleRange(
  prices: Array<number | null | undefined>,
  prev: number | null | undefined,
  minPct = 0.002,
): { min: number; max: number; prev: number } | null {
  const finite = prices.filter((p): p is number => p != null && Number.isFinite(p));
  if (!finite.length) return null;
  const hi = Math.max(...finite);
  const lo = Math.min(...finite);
  const base = prev != null && Number.isFinite(prev) && prev > 0 ? prev : null;
  if (base == null) {
    const pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * minPct, 1e-6);
    return { min: lo - pad, max: hi + pad, prev: (hi + lo) / 2 };
  }
  const dataSpan = Math.max(hi - base, base - lo, 0);
  const span = dataSpan > 0 ? dataSpan : Math.max(base * minPct, 1e-6);
  return { min: base - span, max: base + span, prev: base };
}

/** Right-edge crosshair tag. Price dark on white; pct is the bar's own move vs ref. */
export function hoverPxPct(
  price: number | null | undefined,
  ref: number | null | undefined,
  formatPx: (v: number) => string = fmtHoverPx,
): { px: string; pct: string | null; chg: number | null } | null {
  if (price == null || !Number.isFinite(price)) return null;
  const chg = vsRefPct(price, ref);
  const show = chg != null && Math.abs(chg) >= 1e-12;
  return { px: formatPx(price), pct: show ? fmtHoverPct(chg) : null, chg: show ? chg : null };
}

/** Right-edge HTML tag Y. Native horz label stays off (dark plate is unreadable). */
export function useLcHoverTag(
  getSeries: () => { priceToCoordinate: (price: number) => number | null } | null,
  price: number | null | undefined,
  ref: number | null | undefined,
  formatPx?: (v: number) => string,
  paintKey?: unknown,
): { tag: ReturnType<typeof hoverPxPct>; y: number | null } {
  const tag = hoverPxPct(price, ref, formatPx);
  const [y, setY] = useState<number | null>(null);
  useLayoutEffect(() => {
    const series = getSeries();
    let next: number | null = null;
    if (series && price != null && Number.isFinite(price)) {
      try {
        const cy = series.priceToCoordinate(price);
        next = cy == null || !Number.isFinite(cy) ? null : cy;
      } catch {
        next = null;
      }
    }
    setY((prev) => (prev === next ? prev : next));
  }, [price, paintKey]);
  return { tag, y };
}

/** Magnet price from the series that still shows a last tag (skip helper stems). */
export function hoverPxFromParam(
  param: Pick<MouseEventParams<Time> | MouseEventParams<number>, "seriesData">,
): number | null {
  let v: number | null = null;
  param.seriesData.forEach((d, s) => {
    try {
      const opts = s && typeof s === "object" && "options" in s
        ? (s as { options: () => { lastValueVisible?: boolean } }).options()
        : null;
      if (opts?.lastValueVisible === false) return;
    } catch { /* series already gone */ }
    if (!d || typeof d !== "object") return;
    const row = d as { close?: unknown; value?: unknown };
    if (typeof row.close === "number" && Number.isFinite(row.close)) v = row.close;
    else if (typeof row.value === "number" && Number.isFinite(row.value)) v = row.value;
  });
  return v;
}

export function candleOpts(_glance = false, fmt?: ReturnType<typeof priceFormatOf>) {
  return {
    upColor: "#000",
    downColor: DN,
    borderVisible: true,
    borderUpColor: UP,
    borderDownColor: DN,
    wickUpColor: UP,
    wickDownColor: DN,
    priceScaleId: "right",
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.SparseDotted,
    priceLineColor: UP,
    priceFormat: fmt ?? { type: "price" as const, precision: 2, minMove: 0.01 },
  };
}

/** Volume histogram must start at 0. LC default min=visible-low makes 半量日子看起来像没量. */
export function pinVolFromZero<T extends { priceRange?: { minValue: number; maxValue: number } } | null>(
  original: () => T,
): T {
  const info = original();
  if (!info?.priceRange) return info;
  return {
    ...info,
    priceRange: { minValue: 0, maxValue: Math.max(0, info.priceRange.maxValue) },
  };
}

export function volOpts() {
  return {
    lastValueVisible: false,
    priceLineVisible: false,
    priceScaleId: "vol",
    priceFormat: { type: "volume" as const },
    autoscaleInfoProvider: pinVolFromZero,
  };
}

/** Own pane: use the pane right scale, not the overlay `vol` id. */
export function volPaneOpts() {
  return {
    lastValueVisible: false,
    priceLineVisible: false,
    priceScaleId: "right",
    priceFormat: { type: "volume" as const },
    autoscaleInfoProvider: pinVolFromZero,
  };
}

export function baselineOpts(base: number, glance = false, fmt?: ReturnType<typeof priceFormatOf>) {
  return {
    priceScaleId: "right",
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.SparseDotted,
    priceLineColor: UP,
    priceFormat: fmt ?? { type: "price" as const, precision: 2, minMove: 0.01 },
    baseValue: { type: "price" as const, price: base },
    relativeGradient: true,
    topLineColor: UP,
    topFillColor1: "rgba(255,45,45,0.22)",
    topFillColor2: "rgba(255,45,45,0.01)",
    bottomLineColor: DN,
    bottomFillColor1: "rgba(0,210,106,0.22)",
    bottomFillColor2: "rgba(0,210,106,0.01)",
    lineWidth: (glance ? 1 : 2) as 1 | 2,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: glance ? 3 : 4,
    crosshairMarkerBorderWidth: 1,
    crosshairMarkerBorderColor: "#000",
  };
}

/** Arb spread: a line, no red/green baseline fill (spread is not around 0). */
export function spreadLineOpts() {
  return {
    priceScaleId: "right",
    color: "#ffcc00",
    lineWidth: 2 as const,
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineColor: "#ffcc00",
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.SparseDotted,
    priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBorderWidth: 1,
    crosshairMarkerBorderColor: "#000",
  };
}

export function overlayLineOpts(color: string, scaleId: string) {
  return {
    color,
    lineWidth: 1 as const,
    priceScaleId: scaleId,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  };
}

/** Minute last: white line. No avg overlay. */
export function minuteLineOpts(fmt?: ReturnType<typeof priceFormatOf>) {
  return {
    priceScaleId: "right",
    color: PX_LINE,
    lineWidth: 1 as const,
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.SparseDotted,
    priceLineColor: UP,
    priceFormat: fmt ?? { type: "price" as const, precision: 2, minMove: 0.01 },
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBorderWidth: 1,
    crosshairMarkerBorderColor: "#000",
  };
}

export function createLcChart(el: HTMLElement, preset: LcPreset = "desk"): IChartApi {
  const glance = preset === "glance";
  return createChart(el, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: INK,
      fontSize: glance ? 10 : 11,
      fontFamily: FONT,
      attributionLogo: false,
      panes: { enableResize: false, separatorColor: "rgba(255,255,255,0.06)" },
    },
    grid: {
      vertLines: { visible: true, color: GRID, style: LineStyle.Solid },
      horzLines: { color: GRID, style: LineStyle.Solid },
    },
    rightPriceScale: {
      visible: true,
      borderVisible: true,
      borderColor: AXIS_BORDER,
      ticksVisible: true,
      alignLabels: true,
      ensureEdgeTickMarksVisible: true,
      scaleMargins: { top: 0.06, bottom: 0.18 },
      textColor: INK,
      minimumWidth: glance ? 52 : 64,
    },
    leftPriceScale: { visible: false },
    timeScale: {
      borderVisible: true,
      borderColor: AXIS_BORDER,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: glance ? 2 : 6,
      rightOffsetPixels: glance ? 8 : 24,
      ticksVisible: true,
      barSpacing: glance ? 5 : 7,
      minBarSpacing: 3,
    },
    crosshair: {
      mode: glance ? CrosshairMode.Magnet : CrosshairMode.MagnetOHLC,
      doNotSnapToHiddenSeriesIndices: true,
      vertLine: {
        color: HAIR,
        style: LineStyle.Dashed,
        width: 1,
        labelVisible: true,
        labelBackgroundColor: TAG,
      },
      horzLine: {
        color: HAIR,
        style: LineStyle.Dashed,
        width: 1,
        labelVisible: false,
        labelBackgroundColor: TAG,
      },
    },
    handleScale: { axisPressedMouseMove: { time: true, price: true } },
    handleScroll: { vertTouchDrag: false },
    kineticScroll: { mouse: true, touch: true },
  });
}

/** LC throws "Value is null" when wipe / resize / axis length race. Keep the pane. */
export function guardLc(fn: () => void): void {
  try {
    fn();
  } catch {
    /* Value is null / mid-resize */
  }
}

export function wipeLc(chart: IChartApi): void {
  try {
    for (const pane of chart.panes()) {
      for (const s of [...pane.getSeries()]) chart.removeSeries(s);
    }
    while (chart.panes().length > 1) {
      chart.removePane(chart.panes().length - 1);
    }
  } catch {
    /* mid-resize / already removed */
  }
}

/** Last-price box on the right scale, TV red/green. */
export function styleLastTag(
  series: ISeriesApi<SeriesType> | null,
  last: number | null | undefined,
  ref: number | null | undefined,
): void {
  if (!series) return;
  const up = last == null || ref == null || !Number.isFinite(last) || !Number.isFinite(ref)
    ? true
    : last >= ref;
  series.applyOptions({
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineColor: up ? UP : DN,
  });
}

/** 分时: equal pad so +pct and -pct sit the same distance from 昨收. */
export function styleMinuteSymScale(chart: IChartApi): void {
  try {
    chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.02, bottom: 0.02 },
      ensureEdgeTickMarksVisible: true,
      alignLabels: true,
      ticksVisible: false,
      textColor: "rgba(0,0,0,0)",
      minimumWidth: 54,
    });
  } catch {
    /* scale already gone */
  }
}

/** Separate volume pane under price. share is vol height / total (0.16-0.36). */
export function styleVolPane(chart: IChartApi, share = 0.22): void {
  const s = Math.max(0.16, Math.min(0.36, share));
  try {
    chart.applyOptions({
      layout: { panes: { enableResize: true, separatorColor: "rgba(255,255,255,0.08)" } },
    });
  } catch {
    /* chart already gone */
  }
  const panes = chart.panes();
  const main = panes[0];
  const vol = panes[1];
  if (!main || !vol) return;
  try {
    main.setStretchFactor(1 - s);
    vol.setStretchFactor(s);
  } catch {
    /* pane API */
  }
  try {
    main.priceScale("right").applyOptions({
      visible: true,
      borderVisible: true,
      ticksVisible: true,
      scaleMargins: { top: 0.06, bottom: 0.08 },
    });
  } catch {
    /* main scale */
  }
  try {
    vol.priceScale("right").applyOptions({
      visible: true,
      borderVisible: true,
      ticksVisible: true,
      mode: PriceScaleMode.Normal,
      scaleMargins: { top: 0.06, bottom: 0.02 },
    });
  } catch {
    /* pane scale */
  }
}

/** Volume sits in the bottom of the main pane, TV overlay, not a second chart. */
export function styleVolOverlay(chart: IChartApi, band = 0.2): void {
  const bottom = Math.min(0.28, Math.max(0.16, band));
  try {
    chart.priceScale("right").applyOptions({
      visible: true,
      borderVisible: true,
      ticksVisible: true,
      scaleMargins: { top: 0.06, bottom },
    });
  } catch {
    /* right scale always exists */
  }
  try {
    chart.priceScale("vol").applyOptions({
      visible: false,
      borderVisible: false,
      scaleMargins: { top: 1 - band, bottom: 0 },
    });
  } catch {
    /* scale created with the series */
  }
}

/** OI shares the volume band so the yellow line rides the histograms. */
export function styleOiOverlay(chart: IChartApi, band = 0.18): void {
  try {
    chart.priceScale("oi").applyOptions({
      visible: false,
      borderVisible: false,
      scaleMargins: { top: 1 - band, bottom: 0 },
    });
  } catch {
    /* scale created with the series */
  }
}

/** OI on the volume pane: own scale, full pane height, does not share vol axis. */
export function styleOiPane(chart: IChartApi, paneIndex = 1): void {
  try {
    chart.priceScale("oi", paneIndex).applyOptions({
      visible: false,
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0.08 },
    });
  } catch {
    /* scale created with the series */
  }
}

/** IV wiggles in the price area, leaving the volume band alone. */
export function styleIvOverlay(chart: IChartApi, bottom = 0.28): void {
  try {
    chart.priceScale("iv").applyOptions({
      visible: false,
      borderVisible: false,
      scaleMargins: { top: 0.08, bottom },
    });
  } catch {
    /* scale created with the series */
  }
}

export function hideOverlayScale(chart: IChartApi, scaleId: string, paneIndex = 0): void {
  try {
    chart.priceScale(scaleId, paneIndex).applyOptions({ visible: false, borderVisible: false });
  } catch {
    /* scale created with the series */
  }
}

export function applyTimeLabels(
  chart: IChartApi,
  labelsRef: { current: string[] },
  mode: TimeLabelMode,
): void {
  const lock = mode === "hm" || mode === "mdhm";
  chart.applyOptions({
    localization: {
      timeFormatter: (t: Time) => formatLabel(labelAt(t, labelsRef.current), mode),
      locale: "zh-CN",
    },
    timeScale: {
      tickMarkFormatter: (t: Time) => formatLabel(labelAt(t, labelsRef.current), mode) || null,
      fixLeftEdge: lock,
      // hm: leftover space stays on the right so 09:30 sits on the left.
      fixRightEdge: mode === "mdhm",
      lockVisibleTimeRangeOnResize: lock,
    },
  });
}

/** Session axis: open flush left. Do not pin the right edge (that parks slack on the left). */
const sessionRaf = new WeakMap<object, number>();

export function showSession(chart: IChartApi, n: number): void {
  if (n <= 0) return;
  const prev = sessionRaf.get(chart);
  if (prev != null) cancelAnimationFrame(prev);
  const last = Math.max(-0.5, n - 0.5);
  const apply = () => {
    try {
      chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: last });
    } catch {
      /* chart already removed */
    }
  };
  guardLc(() => {
    chart.applyOptions({
      timeScale: {
        rightOffset: 0,
        rightOffsetPixels: 0,
        minBarSpacing: 0.2,
        barSpacing: 1,
        fixLeftEdge: true,
        fixRightEdge: false,
        shiftVisibleRangeOnNewBar: false,
        lockVisibleTimeRangeOnResize: true,
      },
    });
  });
  apply();
  sessionRaf.set(chart, requestAnimationFrame(() => {
    sessionRaf.delete(chart);
    apply();
  }));
}

export function showLatest(chart: IChartApi, n: number, view: number): void {
  const ts = chart.timeScale();
  if (n <= 0) return;
  if (n <= view) {
    ts.fitContent();
    return;
  }
  ts.setVisibleLogicalRange({ from: n - view, to: n - 1 + 3 });
}

/** Horizontal ref line (昨收 / 零轴). Recreate only when missing. */
export function setRefPriceLine(
  series: ISeriesApi<SeriesType> | null,
  lineRef: { current: IPriceLine | null },
  price: number | null | undefined,
  title = "",
  color = "rgba(200,205,214,0.55)",
): void {
  if (!series || price == null || !Number.isFinite(price)) {
    if (lineRef.current && series) {
      try { series.removePriceLine(lineRef.current); } catch { /* already gone */ }
    }
    lineRef.current = null;
    return;
  }
  const next = {
    price,
    color,
    lineWidth: 1 as const,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: false,
    title,
  };
  if (lineRef.current) {
    try {
      lineRef.current.applyOptions(next);
      return;
    } catch {
      lineRef.current = null;
    }
  }
  try {
    lineRef.current = series.createPriceLine(next);
  } catch {
    lineRef.current = null;
  }
}

export function setSeriesMarks(
  series: ISeriesApi<SeriesType> | null,
  apiRef: { current: ISeriesMarkersPluginApi<Time> | null },
  marks: SeriesMarker<Time>[],
): void {
  if (!series) return;
  guardLc(() => {
    if (!apiRef.current) {
      apiRef.current = createSeriesMarkers(series, marks);
      return;
    }
    apiRef.current.setMarkers(marks);
  });
}

function samePoint(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  if (x.time !== y.time) return false;
  if ("value" in x || "value" in y) return x.value === y.value && x.color === y.color;
  return x.open === y.open && x.high === y.high && x.low === y.low && x.close === y.close;
}

/** Last bar only: LC update() cannot rewrite a mid-session slot. */
export function canUpdateLast<T>(prev: T[] | null | undefined, next: T[]): boolean {
  if (!prev || prev.length === 0 || prev.length !== next.length) return false;
  for (let i = 0; i < next.length - 1; i++) {
    if (!samePoint(prev[i], next[i])) return false;
  }
  return true;
}

function paintLast<T extends CandlestickData | LineData | WhitespaceData | HistogramData>(
  update: (pt: T) => void,
  setAll: (pts: T[]) => void,
  next: T[],
  prev: T[] | null | undefined,
): boolean {
  if (next.length === 0) {
    guardLc(() => setAll(next));
    return false;
  }
  if (canUpdateLast(prev, next)) {
    try {
      update(next[next.length - 1]);
      return true;
    } catch {
      /* LC update rejects some whitespace / time jumps */
    }
  }
  guardLc(() => setAll(next));
  return false;
}

export function paintCandles(
  series: ISeriesApi<"Candlestick">,
  next: CandlestickData[],
  prev: CandlestickData[] | null | undefined,
): boolean {
  return paintLast((p) => series.update(p), (p) => series.setData(p), next, prev);
}

export function paintLine(
  series: ISeriesApi<"Line"> | ISeriesApi<"Baseline">,
  next: Array<LineData | WhitespaceData>,
  prev: Array<LineData | WhitespaceData> | null | undefined,
): boolean {
  return paintLast((p) => series.update(p), (p) => series.setData(p), next, prev);
}

export function paintHist(
  series: ISeriesApi<"Histogram">,
  next: Array<HistogramData | WhitespaceData>,
  prev: Array<HistogramData | WhitespaceData> | null | undefined,
): boolean {
  return paintLast((p) => series.update(p), (p) => series.setData(p), next, prev);
}

const WM_INK = "rgba(200,205,214,0.22)";

/** Pane watermark. Keep faint so the HUD / crosshair stay readable. */
export function setPaneWatermark(
  chart: { panes: () => unknown[] },
  apiRef: { current: ITextWatermarkPluginApi<Time> | null },
  text: string | readonly string[],
  fontSize = 80,
): void {
  const pane = chart.panes()[0] as Parameters<typeof createTextWatermark>[0] | undefined;
  if (!pane) return;
  const parts = (typeof text === "string" ? [text] : [...text])
    .map((t) => t.trim())
    .filter(Boolean);
  const opts = {
    visible: parts.length > 0,
    horzAlign: "center" as const,
    vertAlign: "center" as const,
    lines: parts.map((t, i) => ({
      text: t,
      color: WM_INK,
      fontSize: i === 0 ? fontSize : Math.round(fontSize * 0.42),
      fontFamily: FONT,
      fontStyle: i === 0 ? "bold" : "",
    })),
  };
  if (apiRef.current) {
    try {
      apiRef.current.applyOptions(opts);
      return;
    } catch {
      apiRef.current = null;
    }
  }
  if (!parts.length) return;
  try {
    apiRef.current = createTextWatermark(pane, opts) as ITextWatermarkPluginApi<Time>;
  } catch {
    apiRef.current = null;
  }
}

export function setLogScale(chart: IChartApi, on: boolean): void {
  try {
    const main = chart.panes()[0] ?? chart;
    main.priceScale("right").applyOptions({
      mode: on ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  } catch {
    /* scale not ready */
  }
}

export function ghostLineOpts() {
  return {
    color: "rgba(0,0,0,0)",
    lineVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
    pointMarkersVisible: false,
  };
}

export function lineValues(pts: Array<LineData | WhitespaceData>): LineData[] {
  return pts.filter((p): p is LineData => "value" in p && Number.isFinite((p as LineData).value));
}

/** UpDownMarkers only attach to Line / Area. Baseline cards host a ghost Line. */
export function ensureUpDown(
  chart: IChartApi,
  lineRef: { current: ISeriesApi<"Line"> | null },
  apiRef: { current: ISeriesUpDownMarkerPluginApi<Time> | null },
): ISeriesUpDownMarkerPluginApi<Time> {
  if (!lineRef.current || !seriesAlive(chart, lineRef.current)) {
    lineRef.current = chart.addSeries(LineSeries, ghostLineOpts());
    apiRef.current = null;
  }
  if (!apiRef.current) {
    apiRef.current = createUpDownMarkers(lineRef.current, {
      positiveColor: UP,
      negativeColor: DN,
      updateVisibilityDuration: 1600,
    });
  }
  return apiRef.current;
}

export function paintUpDown(
  api: ISeriesUpDownMarkerPluginApi<Time> | null,
  next: LineData[],
  prev: LineData[] | null | undefined,
): boolean {
  if (!api) return false;
  if (next.length === 0) {
    guardLc(() => { api.setData([]); });
    return false;
  }
  if (canUpdateLast(prev, next)) {
    try {
      api.update(next[next.length - 1]);
      return true;
    } catch {
      /* same as paintLast */
    }
  }
  guardLc(() => { api.setData(next); });
  return false;
}

/** Strike / IV smile: X is price, not time. Do not reuse createLcChart. */
export function createLcPriceChart(el: HTMLElement) {
  return createOptionsChart(el, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: INK,
      fontSize: 10,
      fontFamily: FONT,
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: true, color: GRID, style: LineStyle.Solid },
      horzLines: { color: GRID, style: LineStyle.Solid },
    },
    rightPriceScale: {
      visible: true,
      borderVisible: true,
      borderColor: AXIS_BORDER,
      ticksVisible: true,
      textColor: INK,
      minimumWidth: 40,
      scaleMargins: { top: 0.14, bottom: 0.12 },
    },
    leftPriceScale: { visible: false },
    timeScale: {
      borderVisible: true,
      borderColor: AXIS_BORDER,
      ticksVisible: true,
      fixLeftEdge: true,
      fixRightEdge: true,
      rightOffset: 0,
      rightOffsetPixels: 0,
    },
    handleScroll: false,
    handleScale: false,
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: { color: HAIR, style: LineStyle.Dashed, width: 1, labelVisible: true, labelBackgroundColor: TAG },
      horzLine: { color: HAIR, style: LineStyle.Dashed, width: 1, labelVisible: false, labelBackgroundColor: TAG },
    },
    localization: { locale: "zh-CN", precision: 0 },
  });
}

type LcSizable = {
  resize: (w: number, h: number, force?: boolean) => void;
  applyOptions: (o: { autoSize?: boolean }) => void;
};

/** autoSize can boot at 0x0 in a flex pane; kick an explicit size then restore autoSize. */
export function resizeLcHost(chart: LcSizable, el: HTMLElement | null): void {
  if (!el) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (w < 2 || h < 2) return;
  chart.applyOptions({ autoSize: false });
  chart.resize(w, h, true);
  chart.applyOptions({ autoSize: true });
}

export type LcPriceHover = {
  x: number;
  y: number | null;
  px: number;
  py: number;
} | null;

export function useLcPriceChart() {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createLcPriceChart> | null>(null);
  const onHoverRef = useRef<(h: LcPriceHover) => void>(() => {});
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let chart: ReturnType<typeof createLcPriceChart> | null = null;
    const onMove = (param: MouseEventParams<number>) => {
      if (skipResizeCrosshair(param)) return;
      if (param.time == null || !param.point) {
        onHoverRef.current(null);
        return;
      }
      const x = Number(param.time);
      if (!Number.isFinite(x)) {
        onHoverRef.current(null);
        return;
      }
      onHoverRef.current({
        x,
        y: hoverPxFromParam(param),
        px: param.point.x,
        py: param.point.y,
      });
    };
    const boot = () => {
      if (chart) {
        resizeLcHost(chart, el);
        return;
      }
      if (el.clientWidth < 2 || el.clientHeight < 2) return;
      chart = createLcPriceChart(el);
      chart.subscribeCrosshairMove(onMove);
      chartRef.current = chart;
      setRev((n) => n + 1);
    };
    boot();
    const onLeave = () => onHoverRef.current(null);
    el.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(boot);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("mouseleave", onLeave);
      if (chart) chart.unsubscribeCrosshairMove(onMove);
      chart?.remove();
      chartRef.current = null;
    };
  }, []);

  return { ref, chartRef, rev, onHoverRef };
}

export function resizeLc(chart: IChartApi, el: HTMLElement | null): void {
  resizeLcHost(chart, el);
}

export function seriesAlive(chart: IChartApi, s: ISeriesApi<SeriesType> | null): boolean {
  if (!s) return false;
  return chart.panes().some((p) => p.getSeries().some((x) => x === s));
}

/** Chart instance lives as long as the host div; empty pick must not unmount it. */
export function useLcChart(preset: LcPreset = "desk") {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const labelsRef = useRef<string[]>([]);
  const onHoverRef = useRef<(idx: number | null) => void>(() => {});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createLcChart(el, preset);
    chartRef.current = chart;
    const onMove = (param: MouseEventParams) => {
      if (skipResizeCrosshair(param)) return;
      onHoverRef.current(hoverIdxFromParam(param, labelsRef.current.length));
    };
    chart.subscribeCrosshairMove(onMove);
    const onLeave = () => onHoverRef.current(null);
    el.addEventListener("mouseleave", onLeave);
    const fit = () => resizeLc(chart, el);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("mouseleave", onLeave);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
    };
  }, [preset]);

  return { ref, chartRef, labelsRef, onHoverRef };
}
