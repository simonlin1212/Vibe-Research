import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { num } from "@/components/ovlab/shared";
import { cn } from "@/lib/utils";
import { storageGet, storageSet } from "@/lib/storage";
import {
  concatDaySlots, frameTradingDays, hmOf, lastFiniteIdx, liveAxisKind, minuteKey, padToSlots, tradingDayOf, ymdOf,
} from "@/lib/derivMinuteAxis";
import type { OptionPick } from "./TQuotePanel";
import type { OvlabDataviewTick, OvlabFlowAlert, OvlabOptionDailyBar } from "@/lib/api";
import { derivSession } from "./derivShared";
import {
  CandlestickSeries, HistogramSeries, LineSeries, UP, DN, applyTimeLabels,
  candleOpts, candleValues, finiteLine, fmtPx, hoverIdxFromParam, lcTime,
  ensureUpDown, lineValues, minuteLineOpts, minuteScaleRange, overlayLineOpts, paintCandles, paintHist, paintLine, paintUpDown,
  priceFormatOf, seriesAlive, setPaneWatermark, setRefPriceLine, setSeriesMarks, showLatest,
  showSession, sparseLine, styleIvOverlay, styleLastTag, styleMinuteSymScale, styleOiPane,
  styleVolPane, useLcChart, useLcHoverTag, volPaneOpts, volUp, volValues, wipeLc, guardLc, IV_COLOR, OI_COLOR,
  type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type ISeriesUpDownMarkerPluginApi,
  type ITextWatermarkPluginApi, type SeriesMarker, type Time,
  type CandlestickData, type HistogramData, type LineData, type WhitespaceData,
} from "@/lib/lcChart";
import { LcHoverTag, LcLegend, LcWell, lcTone, type LcLegendItem } from "@/components/ui/LcFrame";

interface MinBar { t: string; close: number; open: number | null; vol: number; oi: number | null }

/** Compact OI for glance header. */
function fmtOi(v: number): string {
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(Math.round(v));
}

function fmtAxisPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export { volUp } from "@/lib/lcChart";

/** 分钟 bar 数组 -> {t, close, open, vol, oi}; bar: [time, close, pct, oi, open, high, low, vol]. */
export function parseMinute(raw: unknown): MinBar[] {
  if (!Array.isArray(raw)) return [];
  const out: MinBar[] = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 2) continue;
    const close = num(b[1]);
    if (close === null) continue;
    const oi = num(b[3]);
    out.push({
      t: String(b[0]),
      close,
      open: num(b[4]),
      vol: num(b[7]) ?? 0,
      oi: oi != null && oi > 0 ? oi : null,
    });
  }
  return out;
}

/** 分钟 pct 字段反推昨结: 取该交易日第一根 bar, close / (1 + pct/100). */
function preCloseOf(raw: unknown, td: string): number | null {
  if (!Array.isArray(raw)) return null;
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 3) continue;
    if (tradingDayOf(String(b[0])) !== td) continue;
    const close = num(b[1]);
    const pct = typeof b[2] === "string" ? parseFloat(b[2].replace("%", "")) : num(b[2]);
    if (close !== null && pct !== null && Number.isFinite(pct) && 1 + pct / 100 !== 0) {
      return close / (1 + pct / 100);
    }
    return null;
  }
  return null;
}

export type MinuteDays = 1 | 2;

const DAYS_KEY = "deriv.minute.days";

function loadDays(): MinuteDays {
  return storageGet(DAYS_KEY) === "2" ? 2 : 1;
}

const EMPTY_MIN = {
  bars: [] as MinBar[],
  cats: [] as string[],
  prices: [] as Array<number | null>,
  vols: [] as Array<number | null>,
  opens: [] as Array<number | null>,
  oi: [] as Array<number | null>,
  iv: [] as Array<number | null>,
  pre: null as number | null,
  preByTd: {} as Record<string, number | null>,
  splitAt: null as number | null,
  days: 1 as MinuteDays,
};

/** Pad 1 or 2 trading days onto session slots. Day gap is an empty category. */
export function minuteFrame(
  all: MinBar[],
  ivPairs: Array<[string, number | null]> | undefined,
  und: string | undefined,
  days: MinuteDays,
  rawKl: unknown,
  now = new Date(),
): typeof EMPTY_MIN {
  const stamp = `${ymdOf(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  const tds = frameTradingDays(all.map((b) => b.t), days, now, und);
  if (tds.length === 0) return { ...EMPTY_MIN, days };
  const want = new Set(tds);
  const bars = all.filter((b) => want.has(tradingDayOf(b.t)));
  const kind = liveAxisKind(und, [...all.map((b) => b.t), stamp], now);
  const { cats, splitAt } = concatDaySlots(tds, kind);
  const padded = padToSlots(bars, cats, (b) => b.t);
  const prices = padded.map((b) => b?.close ?? null);
  const vols = padded.map((b) => b?.vol ?? null);
  const opens = padded.map((b) => b?.open ?? null);
  const oi = padded.map((b) => b?.oi ?? null);
  const iv = alignSeries(
    (ivPairs ?? []).filter(([t]) => want.has(tradingDayOf(t))),
    cats,
    true,
  );
  const preByTd: Record<string, number | null> = {};
  for (const td of tds) preByTd[td] = preCloseOf(rawKl, td);
  const lastTd = tds[tds.length - 1];
  return { bars, cats, prices, vols, opens, oi, iv, pre: preByTd[lastTd] ?? null, preByTd, splitAt, days };
}

/** Patch the current minute slot (or last print) with a dataview last/oi. */
export function applyMinuteTick(
  frame: typeof EMPTY_MIN,
  tick: Pick<OvlabDataviewTick, "last" | "oi"> | null | undefined,
  now = new Date(),
): typeof EMPTY_MIN {
  const last = num(tick?.last);
  if (last == null || frame.cats.length === 0) return frame;
  const stamp = `${ymdOf(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  const td = tradingDayOf(stamp);
  const hm = hmOf(stamp);
  // Slot dates follow tradingDayOf (Fri night / Sat 00:xx use Monday stamps).
  let i = frame.cats.findIndex((c) => c && tradingDayOf(c) === td && hmOf(c) === hm);
  if (i < 0) {
    i = -1;
    for (let k = frame.prices.length - 1; k >= 0; k--) {
      const v = frame.prices[k];
      if (v != null && Number.isFinite(v)) { i = k; break; }
    }
  }
  if (i < 0) return frame;
  const prices = frame.prices.slice();
  const oi = frame.oi.slice();
  prices[i] = last;
  const oiv = num(tick?.oi);
  if (oiv != null && oiv > 0) oi[i] = oiv;
  return { ...frame, prices, oi };
}

/** Patch today's last daily candle with a dataview last. Live session may open a new day. */
export function applyDailyTick(
  bars: OvlabOptionDailyBar[],
  tick: Pick<OvlabDataviewTick, "last"> | null | undefined,
  now = new Date(),
): OvlabOptionDailyBar[] {
  const last = num(tick?.last);
  if (last == null || bars.length === 0) return bars;
  const stamp = `${ymdOf(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  const td = tradingDayOf(stamp);
  const i = bars.length - 1;
  const b = bars[i];
  if (b.t === td) {
    if (b.close === last && last <= b.high && last >= b.low) return bars;
    return [
      ...bars.slice(0, i),
      {
        ...b,
        close: last,
        high: Math.max(b.high, last),
        low: Math.min(b.low, last),
      },
    ];
  }
  if (derivSession(now).live && td > b.t) {
    return [...bars, { t: td, open: last, high: last, low: last, close: last, vol: 0 }];
  }
  return bars;
}

/** Align [[time, v], ...] onto categories. Dated stamps stay on their day; bare HH:MM only on a 1-day axis. */
export function alignSeries(
  pairs: Array<[string, number | null]> | undefined,
  cats: string[],
  loose = false,
): Array<number | null> {
  const exact = new Map<string, number | null>();
  const keys = new Map<string, number | null>();
  const clock = new Map<string, number | null>();
  for (const [t, v] of pairs ?? []) {
    exact.set(t, v);
    if (!loose) continue;
    const mk = minuteKey(t);
    keys.set(mk, v);
    const hm = hmOf(t);
    // Do not key dated stamps by clock: yesterday 15:00 must not fill today's empty 15:00.
    if (hm && mk === hm) clock.set(hm, v);
  }
  const clockOk = loose && new Set(cats.filter(Boolean).map(tradingDayOf)).size <= 1;
  return cats.map((c) => {
    if (!c) return null;
    return exact.get(c)
      ?? (loose ? keys.get(minuteKey(c)) : undefined)
      ?? (clockOk ? clock.get(hmOf(c)) : undefined)
      ?? null;
  });
}

/** Overlay axis: keep a quiet series from filling the pane (IV wiggle ~occupy of height). */
export function overlayAxis(
  vals: Array<number | null | undefined>,
  occupy = 0.32,
): { min: number; max: number } | null {
  const xs: number[] = [];
  for (const v of vals) {
    if (v != null && Number.isFinite(v) && v > 0) xs.push(v);
  }
  if (xs.length === 0) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const mid = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2, Math.abs(mid) * 0.015, 0.4);
  const frac = Math.min(0.85, Math.max(0.1, occupy));
  const pad = half / frac - half;
  return { min: mid - half - pad, max: mid + half + pad };
}

/** Crosshair -> category index. LC uses logical/time; leftover echarts axis-pointer keeps unit tests. */
export function hoverIdxOf(raw: unknown, cats: string[]): number | null {
  const fromLc = hoverIdxFromParam(raw, cats.length);
  if (fromLc != null) return fromLc;
  const p = raw as {
    currTrigger?: string;
    axesInfo?: Array<{ axisDim?: string; value?: unknown; seriesDataIndices?: Array<{ dataIndex?: number }> }>;
  };
  if (p?.currTrigger === "leave") return null;
  const xAxis = (p.axesInfo ?? []).find((a) => a.axisDim === "x") ?? p.axesInfo?.[0];
  const fromSeries = xAxis?.seriesDataIndices?.find((s) => Number.isInteger(s?.dataIndex));
  if (fromSeries && Number.isInteger(fromSeries.dataIndex)) return fromSeries.dataIndex as number;
  const val = xAxis?.value;
  if (typeof val === "number" && val >= 0 && val < cats.length) return Math.round(val);
  if (val != null) {
    const s = String(val);
    const i = cats.findIndex((c) => c === s || c.slice(11, 16) === s || c.slice(5) === s);
    if (i >= 0) return i;
  }
  return null;
}

/** T-table code is {prod}{exp[2:]}{C/P}{strike}. Flow may send that, an exchange id, or OPT_ long form. */
export function alertMatchesCode(
  a: Pick<OvlabFlowAlert, "instrument" | "contract_code">,
  code: string,
): boolean {
  const want = code.toUpperCase();
  if (!want) return false;
  const cc = String(a.contract_code ?? "").toUpperCase();
  const inst = String(a.instrument ?? "").toUpperCase();
  if (cc && cc === want) return true;
  if (inst && inst === want) return true;
  const m = inst.match(/^OPT_[A-Z]+_([A-Z0-9]+):(\d{6}):([CP]):(.+)$/);
  if (!m) return false;
  return `${m[1]}${m[2].slice(2)}${m[3]}${m[4]}` === want;
}

export function alertMarkIdxs(
  cats: string[],
  alerts: Array<Pick<OvlabFlowAlert, "time" | "instrument" | "contract_code" | "side">>,
  code: string,
): Array<{ i: number; up: boolean }> {
  const out: Array<{ i: number; up: boolean }> = [];
  const seen = new Set<number>();
  const dated = cats.some((c) => c && c.length > 10);
  for (const a of alerts) {
    if (!alertMatchesCode(a, code)) continue;
    const t = String(a.time ?? "");
    if (!t) continue;
    let i = -1;
    if (dated) {
      i = cats.findIndex((c) => c && c.slice(0, 16) === t.slice(0, 16));
      if (i < 0) {
        const hm = hmOf(t);
        const td = tradingDayOf(t);
        i = cats.findIndex((c) => c && tradingDayOf(c) === td && hmOf(c) === hm);
      }
    } else {
      const td = tradingDayOf(t);
      i = cats.findIndex((c) => c && c.slice(0, 10) === td);
    }
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    const side = String(a.side ?? "").toLowerCase();
    out.push({ i, up: side !== "bid" && side !== "sell" });
  }
  return out;
}

function toMarks(parts: Array<{ i: number; up: boolean }>): SeriesMarker<Time>[] {
  return parts.map((p) => ({
    time: lcTime(p.i),
    position: "belowBar" as const,
    shape: (p.up ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown",
    color: p.up ? UP : DN,
  }));
}

export { tradingDayOf } from "@/lib/derivMinuteAxis";

/** 期权联动图卡: mode=daily 日K(分钟聚合+量+标的IV日线) / minute 分时(价线+量+仓+合约IV分钟). */
const NO_ALERTS: OvlabFlowAlert[] = [];

export function OptionChartCard({ pick, mode, tick, alerts = NO_ALERTS }: {
  pick: OptionPick | null;
  mode: "daily" | "minute";
  tick?: OvlabDataviewTick | null;
  alerts?: OvlabFlowAlert[];
}) {
  const { ref, chartRef, labelsRef, onHoverRef } = useLcChart("glance");
  const [hover, setHover] = useState<number | null>(null);
  const [days, setDays] = useState<MinuteDays>(loadDays);
  const [, pulse] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => pulse((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const live = derivSession().live;
  const bag = useRef<{
    kind: "daily" | "minute" | null;
    px: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null;
    iv: ISeriesApi<"Line"> | null;
    vol: ISeriesApi<"Histogram"> | null;
    oi: ISeriesApi<"Line"> | null;
    paintedPx: CandlestickData[] | Array<LineData | WhitespaceData> | null;
    paintedIv: Array<LineData | WhitespaceData> | null;
    paintedVol: Array<HistogramData | WhitespaceData> | null;
    paintedOi: Array<LineData | WhitespaceData> | null;
    paintedTick: LineData[] | null;
  }>({
    kind: null, px: null, iv: null, vol: null, oi: null,
    paintedPx: null, paintedIv: null, paintedVol: null, paintedOi: null, paintedTick: null,
  });
  const refLine = useRef<IPriceLine | null>(null);
  const marksRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const tickRef = useRef<ISeriesApi<"Line"> | null>(null);
  const udRef = useRef<ISeriesUpDownMarkerPluginApi<Time> | null>(null);
  onHoverRef.current = setHover;
  const setAndSaveDays = (n: MinuteDays) => {
    setDays(n);
    storageSet(DAYS_KEY, String(n));
  };
  const daily = usePolling(
    () => (pick && mode === "daily" ? api.ovlabOptionDaily(pick.code, pick.und) : Promise.resolve(null)),
    live ? 60_000 : 300_000,
    [pick?.code, pick?.und, mode],
    Boolean(pick && mode === "daily"),
  );
  const minute = usePolling(
    () => {
      if (!pick || mode !== "minute") return Promise.resolve(null);
      const code = pick.code;
      const now = Math.floor(Date.now() / 1000);
      const from = now - 5 * 24 * 3600;
      return Promise.all([
        api.ovlabKlineHistory(code, "1", from, now),
        api.ovlabAtmvolHistory(code, "1", from, now).catch(() => null),
      ]).then(([kl, av]) => ({ code, kl, av }));
    },
    live ? 15_000 : 60_000,
    [pick?.code, mode, days],
    Boolean(pick && mode === "minute"),
  );

  const lastBar = usePolling(
    () => (pick?.kind === "und" && pick.code
      ? api.ovlabLastBar(pick.code).catch(() => null)
      : Promise.resolve(null)),
    live ? 60_000 : 300_000,
    [pick?.code, pick?.kind],
    Boolean(pick?.kind === "und" && pick.code),
  );
  const liveTick = useMemo(() => {
    if (num(tick?.last) != null) return tick;
    if (pick?.kind !== "und") return tick;
    const close = num(lastBar.data?.close);
    if (close == null) return tick;
    const oi = num(lastBar.data?.oi);
    return { instr: pick.code, last: close, oi: oi != null && oi >= 0 ? oi : undefined };
  }, [tick, lastBar.data, pick?.kind, pick?.code]);

  const minData = useMemo(() => {
    if (mode !== "minute" || !minute.data || minute.data.code !== pick?.code) return null;
    const { kl, av } = minute.data;
    const frame = minuteFrame(
      parseMinute(kl?.data),
      (av?.data ?? []) as Array<[string, number | null]>,
      pick?.und,
      days,
      kl?.data,
    );
    return applyMinuteTick(frame, liveTick);
  }, [minute.data, mode, pick?.code, pick?.und, days, liveTick]);

  const dailyStale = Boolean(daily.data?.code && daily.data.code !== pick?.code);
  const dailyMatch = mode === "daily" && daily.data && daily.data.code === pick?.code ? daily.data : null;
  const dailyBars = useMemo(
    () => applyDailyTick(dailyMatch?.bars ?? [], liveTick),
    [dailyMatch, liveTick],
  );
  const dailyIv = useMemo(
    () => alignSeries(dailyMatch?.iv, dailyBars.map((b) => b.t)),
    [dailyMatch, dailyBars],
  );

  const minStale = Boolean(minute.data && minute.data.code !== pick?.code);
  const loading = mode === "daily"
    ? (!dailyMatch && !daily.error && (daily.data === null || dailyStale))
    : (minData === null && !minute.error && (minute.data === null || minStale));
  const err = mode === "daily" ? daily.error : minute.error;
  const empty = Boolean(pick && !loading && !err && (
    mode === "daily" ? dailyBars.length === 0 : (minData?.bars.length ?? 0) === 0
  ));

  useEffect(() => { setHover(null); }, [pick?.code, mode, days]);

  labelsRef.current = mode === "daily" ? dailyBars.map((b) => b.t) : (minData?.cats ?? []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    guardLc(() => paintChart(chart));
  }, [pick, mode, dailyBars, dailyIv, minData, alerts, chartRef, labelsRef]);

  const paintChart = (chart: NonNullable<typeof chartRef.current>) => {
    const emptyBag = () => ({
      kind: null as "daily" | "minute" | null,
      px: null, iv: null, vol: null, oi: null,
      paintedPx: null, paintedIv: null, paintedVol: null, paintedOi: null, paintedTick: null,
    });
    const reset = () => {
      wipeLc(chart);
      bag.current = emptyBag();
      refLine.current = null;
      marksRef.current = null;
      tickRef.current = null;
      udRef.current = null;
    };
    if (!pick) {
      setPaneWatermark(chart, wmRef, "");
      reset();
      return;
    }
    setPaneWatermark(chart, wmRef, pick.name || pick.code, 56);
    const lastMinI = lastFiniteIdx(minData?.prices ?? [], null);
    const lastPx = mode === "daily"
      ? dailyBars[dailyBars.length - 1]?.close
      : (lastMinI != null ? minData?.prices[lastMinI] : undefined);
    const fmt = priceFormatOf(pick.und || pick.code, lastPx);

    if (mode === "daily") {
      if (dailyBars.length === 0) { reset(); labelsRef.current = []; return; }
      labelsRef.current = dailyBars.map((b) => b.t);
      applyTimeLabels(chart, labelsRef, "md");
      if (bag.current.kind !== "daily" || !seriesAlive(chart, bag.current.px)) {
        reset();
        bag.current.px = chart.addSeries(CandlestickSeries, candleOpts(true, fmt));
        bag.current.iv = chart.addSeries(LineSeries, overlayLineOpts(IV_COLOR, "iv"));
        bag.current.vol = chart.addSeries(HistogramSeries, volPaneOpts(), 1);
        bag.current.kind = "daily";
        styleVolPane(chart, 0.22);
        styleIvOverlay(chart, 0.08);
      } else {
        bag.current.px?.applyOptions({ priceFormat: fmt });
      }
      const candles = candleValues(dailyBars);
      const dailyPx = bag.current.px as ISeriesApi<"Candlestick"> | null;
      if (!dailyPx) return;
      const lastOnly = paintCandles(dailyPx, candles, bag.current.paintedPx as CandlestickData[] | null);
      bag.current.paintedPx = candles;
      const last = dailyBars[dailyBars.length - 1];
      styleLastTag(bag.current.px, last?.close, last?.open);
      const prevClose = dailyBars.length > 1 ? dailyBars[dailyBars.length - 2].close : null;
      setRefPriceLine(bag.current.px, refLine, prevClose);
      bag.current.iv?.applyOptions({
        autoscaleInfoProvider: () => {
          const r = overlayAxis(dailyIv);
          return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : null;
        },
      });
      const ivPts = finiteLine(dailyIv);
      if (bag.current.iv) {
        paintLine(bag.current.iv, ivPts, bag.current.paintedIv);
        bag.current.paintedIv = ivPts;
      }
      const volPts = volValues(dailyBars.map((b) => ({
        value: b.vol,
        up: b.close >= b.open,
      })), true);
      if (bag.current.vol) {
        paintHist(bag.current.vol, volPts, bag.current.paintedVol);
        bag.current.paintedVol = volPts;
      }
      const days = dailyBars.map((b) => b.t);
      setSeriesMarks(bag.current.px, marksRef, toMarks(alertMarkIdxs(days, alerts, pick.code)));
      if (!lastOnly) showLatest(chart, dailyBars.length, 80);
      return;
    }

    const cats = minData?.cats ?? [];
    const prices = minData?.prices ?? [];
    const finite = prices.filter((p): p is number => p != null && Number.isFinite(p));
    if (cats.length === 0 || finite.length === 0) { reset(); labelsRef.current = []; return; }
    labelsRef.current = cats;
    applyTimeLabels(chart, labelsRef, "hm");
    const pre = minData?.pre ?? null;
    const baseline = pre !== null && pre > 0 ? pre : finite[0];
    if (bag.current.kind !== "minute" || !seriesAlive(chart, bag.current.px)) {
      reset();
      bag.current.px = chart.addSeries(LineSeries, minuteLineOpts(fmt));
      bag.current.iv = chart.addSeries(LineSeries, overlayLineOpts(IV_COLOR, "iv"));
      bag.current.vol = chart.addSeries(HistogramSeries, volPaneOpts(), 1);
      bag.current.oi = chart.addSeries(LineSeries, overlayLineOpts(OI_COLOR, "oi"), 1);
      bag.current.kind = "minute";
      styleVolPane(chart, 0.24);
      styleOiPane(chart);
      styleIvOverlay(chart, 0.08);
    } else {
      bag.current.px?.applyOptions({ ...minuteLineOpts(fmt) });
    }
    const pxPts = sparseLine(prices);
    const lastOnly = paintLine(
      bag.current.px as ISeriesApi<"Line">,
      pxPts,
      bag.current.paintedPx as Array<LineData | WhitespaceData> | null,
    );
    bag.current.paintedPx = pxPts;
    const tickPts = lineValues(pxPts);
    paintUpDown(ensureUpDown(chart, tickRef, udRef), tickPts, bag.current.paintedTick);
    bag.current.paintedTick = tickPts;
    styleLastTag(bag.current.px, finite[finite.length - 1], baseline);
    setRefPriceLine(bag.current.px, refLine, pre !== null && pre > 0 ? pre : null);
    const rng = minuteScaleRange(prices, pre !== null && pre > 0 ? pre : null);
    bag.current.px?.applyOptions({
      autoscaleInfoProvider: () => (
        rng ? { priceRange: { minValue: rng.min, maxValue: rng.max } } : null
      ),
    });
    styleMinuteSymScale(chart);
    bag.current.iv?.applyOptions({
      autoscaleInfoProvider: () => {
        const r = overlayAxis(minData?.iv ?? []);
        return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : null;
      },
    });
    const ivPts = finiteLine(minData?.iv ?? []);
    if (bag.current.iv) {
      paintLine(bag.current.iv, ivPts, bag.current.paintedIv);
      bag.current.paintedIv = ivPts;
    }
    let prevPx: number | null = null;
    const volPts = volValues((minData?.vols ?? []).map((v, i) => {
      const px = prices[i];
      const up = volUp(px, minData?.opens[i] ?? null, prevPx);
      if (px != null) prevPx = px;
      return { value: v, up };
    }), false);
    if (bag.current.vol) {
      paintHist(bag.current.vol, volPts, bag.current.paintedVol);
      bag.current.paintedVol = volPts;
    }
    bag.current.oi?.applyOptions({
      autoscaleInfoProvider: () => {
        const r = overlayAxis(minData?.oi ?? [], 0.72);
        return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : null;
      },
    });
    const oiPts = finiteLine(minData?.oi ?? []);
    if (bag.current.oi) {
      paintLine(bag.current.oi, oiPts, bag.current.paintedOi);
      bag.current.paintedOi = oiPts;
    }
    setSeriesMarks(bag.current.px, marksRef, toMarks(alertMarkIdxs(cats, alerts, pick.code)));
    if (!lastOnly) showSession(chart, cats.length);
  };

  const hoverPx = hover == null ? null : (
    mode === "daily"
      ? (dailyBars[hover]?.close ?? null)
      : (() => {
          const i = lastFiniteIdx(minData?.prices ?? [], hover);
          return i != null ? (minData?.prices[i] ?? null) : null;
        })()
  );
  const hoverRef = hover == null ? null : (
    mode === "daily"
      ? (hover > 0 ? dailyBars[hover - 1]?.close ?? null : null)
      : (() => {
          const i = lastFiniteIdx(minData?.prices ?? [], hover);
          if (i == null) return null;
          const t = minData?.cats[i] ?? "";
          const td = t ? tradingDayOf(t) : "";
          const pre = (td && minData?.preByTd[td]) || minData?.pre;
          return pre != null && Number.isFinite(pre) ? pre : null;
        })()
  );
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => bag.current.px,
    hover != null ? hoverPx : null,
    hoverRef,
    (v) => fmtPx(v, pick?.und),
    hover,
  );
  const axis = useMemo(() => {
    if (mode !== "minute" || !minData) return null;
    const rng = minuteScaleRange(minData.prices, minData.pre);
    if (!rng || rng.prev === 0) return null;
    return {
      maxPx: fmtPx(rng.max, pick?.und),
      minPx: fmtPx(rng.min, pick?.und),
      maxPct: fmtAxisPct(((rng.max - rng.prev) / rng.prev) * 100),
      minPct: fmtAxisPct(((rng.min - rng.prev) / rng.prev) * 100),
    };
  }, [mode, minData, pick?.und]);

  let head: { label: string; toneCls: string } | null = null;
  const glanceLegend: LcLegendItem[] = [];
  if (pick) {
    if (mode === "daily" && dailyBars.length > 0) {
      const i = hover != null && dailyBars[hover] ? hover : dailyBars.length - 1;
      const b = dailyBars[i];
      const pct = i > 0 ? ((b.close - dailyBars[i - 1].close) / dailyBars[i - 1].close) * 100 : null;
      const iv = dailyIv[i];
      head = {
        label: [
          `${b.t.slice(5)} ${fmtPx(b.close, pick.und)}`,
          pct !== null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "",
          iv != null ? `IV ${iv.toFixed(0)}` : "",
        ].filter(Boolean).join("  "),
        toneCls: pct === null ? "text-slate-400" : pct >= 0 ? "text-[#ff2d2d]" : "text-[#00d26a]",
      };
      glanceLegend.push(
        { k: "O", v: fmtPx(b.open, pick.und) },
        { k: "H", v: fmtPx(b.high, pick.und) },
        { k: "L", v: fmtPx(b.low, pick.und) },
        { k: "C", v: fmtPx(b.close, pick.und), tone: lcTone(pct) },
        { k: "V", v: fmtOi(b.vol), tone: "muted" },
      );
      if (iv != null) glanceLegend.push({ k: "IV", v: iv.toFixed(0), tone: "iv" });
    } else if (mode === "minute" && (minData?.bars.length ?? 0) > 0) {
      const prices = minData!.prices;
      const i = lastFiniteIdx(prices, hover);
      if (hover != null && i == null) {
        const t = minData!.cats[hover] ?? "";
        head = { label: (minData!.days === 2 ? t.slice(5, 16) : t.slice(11, 16)) || t, toneCls: "text-slate-600" };
      } else if (i != null) {
        const px = prices[i];
        if (px != null) {
          const t = minData!.cats[i] ?? "";
          const td = t ? tradingDayOf(t) : "";
          const pre = (td && minData!.preByTd[td]) || minData!.pre;
          const pct = pre ? ((px - pre) / pre) * 100 : null;
          const iv = minData!.iv[i];
          const vol = minData!.vols[i];
          const oi = minData!.oi[i];
          glanceLegend.push(
            { k: "T", v: minData!.days === 2 ? (t.slice(5, 16) || t) : (t.slice(11, 16) || t), tone: "muted" },
            { k: "P", v: fmtPx(px, pick.und), tone: lcTone(pct) },
          );
          if (vol != null) glanceLegend.push({ k: "V", v: fmtOi(vol), tone: "muted" });
          if (iv != null) glanceLegend.push({ k: "IV", v: iv.toFixed(0), tone: "iv" });
          if (oi != null) glanceLegend.push({ k: "OI", v: fmtOi(oi), tone: "oi" });
        }
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 px-2 font-mono text-[11px]">
        {mode === "daily" ? (
          <span className="shrink-0 font-medium text-slate-400">日K</span>
        ) : (
          <span className="flex shrink-0 gap-0.5 rounded bg-white/[0.03] p-0.5 ring-1 ring-white/[0.06]">
            {([[1, "分时"], [2, "两日"]] as const).map(([n, lab]) => (
              <button
                key={n}
                type="button"
                onClick={() => setAndSaveDays(n)}
                className={cn(
                  "rounded px-1.5 py-0.5",
                  days === n ? "bg-primary/15 text-primary" : "text-slate-600 hover:text-slate-400",
                )}
              >
                {lab}
              </button>
            ))}
          </span>
        )}
        {mode === "minute" && glanceLegend.length > 0 ? (
          <LcLegend items={glanceLegend} className="!static !left-auto !top-auto !max-w-none min-w-0 flex-1" />
        ) : pick && head ? (
          <span className={cn("min-w-0 truncate tabular-nums", head.toneCls)}>{head.label}</span>
        ) : null}
        {!pick && mode === "daily" && (
          <span className="text-slate-600">点行情观察或 T 表</span>
        )}
      </div>
      <LcWell className="min-h-0 flex-1 rounded-none">
        {pick && loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">更新中…</div>
        )}
        {pick && !loading && (err || empty) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">未取到</div>
        )}
        {mode === "daily" ? <LcLegend items={glanceLegend} className="left-1 top-0.5 text-[10px]" /> : null}
        {axis ? (
          <>
            <span className="pointer-events-none absolute left-1.5 top-0.5 z-10 font-mono text-[11px] tabular-nums text-[#ff2d2d]">{axis.maxPx}</span>
            <span className="pointer-events-none absolute right-10 top-0.5 z-10 font-mono text-[11px] tabular-nums text-[#ff2d2d]">{axis.maxPct}</span>
            <span className="pointer-events-none absolute bottom-[24%] left-1.5 z-10 font-mono text-[11px] tabular-nums text-[#00d26a]">{axis.minPx}</span>
            <span className="pointer-events-none absolute bottom-[24%] right-10 z-10 font-mono text-[11px] tabular-nums text-[#00d26a]">{axis.minPct}</span>
          </>
        ) : null}
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={ref} className="h-full w-full" />
      </LcWell>
    </div>
  );
}
