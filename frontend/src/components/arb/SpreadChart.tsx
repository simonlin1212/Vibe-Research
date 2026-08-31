import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { num } from "@/components/ovlab/shared";
import { loadLightKline } from "@/lib/lightKline";
import {
  concatDaySlots, hmOf, kindOfUnd, lastFiniteIdx, tradingDayOf, tradingDaysOf,
} from "@/lib/derivMinuteAxis";
import {
  CandlestickSeries, applyTimeLabels, candleOpts, lcTime, seriesAlive,
  setPaneWatermark, setRefPriceLine, styleLastTag,
  useLcChart, useLcHoverTag, wipeLc,
  type CandlestickData, type IPriceLine, type ISeriesApi, type ITextWatermarkPluginApi,
  type Time, type WhitespaceData,
} from "@/lib/lcChart";
import { LcHoverTag, LcLegend, LcWell, lcTone } from "@/components/ui/LcFrame";
import { chgClass, fmtPx, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";

export type SpreadMode = "minute" | "daily";

type Pt = { t: string; o: number; h: number; l: number; c: number };
type Ohlc = { open: number; high: number; low: number; close: number };

function barOf(
  t: string,
  o: number | null,
  h: number | null,
  l: number | null,
  c: number | null,
): Pt | null {
  if (!t || c == null || !Number.isFinite(c)) return null;
  const open = o != null && Number.isFinite(o) ? o : c;
  const high = h != null && Number.isFinite(h) ? Math.max(h, open, c) : Math.max(open, c);
  const low = l != null && Number.isFinite(l) ? Math.min(l, open, c) : Math.min(open, c);
  return { t, o: open, h: high, l: low, c };
}

/** Left minus right. High/low use the max/min spread of the two ranges. */
export function spreadOHLC(L: Pt, R: Pt, m = 1): Ohlc {
  const open = L.o - R.o * m;
  const close = L.c - R.c * m;
  const high = L.h - R.l * m;
  const low = L.l - R.h * m;
  return {
    open,
    close,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
  };
}

/** Flip L-R into R-L so high/low stay the range extrema. */
export function flipOHLC(s: Ohlc): Ohlc {
  return { open: -s.open, close: -s.close, high: -s.low, low: -s.high };
}

function candlePts(bars: Array<Ohlc | null>): Array<CandlestickData | WhitespaceData> {
  return bars.map((b, i) => (b ? { time: lcTime(i), ...b } : { time: lcTime(i) }));
}

/** OpenVlab 近 2 日窗口周一早盘不含周五, 也不回周日夜盘. 5 日才能对齐上一交易日. */
const MINUTE_LOOKBACK = 5 * 86400;

/** Latest bar per HH:MM so Sunday night wins over the previous Friday night. */
function clockLast(pts: Pt[]): Map<string, Pt> {
  const best = new Map<string, Pt>();
  for (const p of pts) {
    const hm = hmOf(p.t);
    if (!hm) continue;
    const prev = best.get(hm);
    if (!prev || p.t > prev.t) best.set(hm, p);
  }
  return best;
}

/** Last trading day that both legs printed. Empty -> no overlap. */
export function lastOverlapDay(left: Pt[], right: Pt[]): string | null {
  const L = new Set(tradingDaysOf(left.map((p) => p.t)));
  const R = new Set(tradingDaysOf(right.map((p) => p.t)));
  const both = [...L].filter((td) => R.has(td)).sort();
  return both.length ? both[both.length - 1] : null;
}

/** Align two minute legs onto one session axis. Clock match, latest print wins. */
export function joinSpreadMinute(
  left: Pt[],
  right: Pt[],
  und: string,
  mult = 1,
  invert = false,
): { cats: string[]; candles: Array<Ohlc | null> } {
  const td = lastOverlapDay(left, right);
  if (!td) return { cats: [], candles: [] };
  const leftD = left.filter((p) => tradingDayOf(p.t) === td);
  const rightD = right.filter((p) => tradingDayOf(p.t) === td);
  const times = [...leftD, ...rightD].map((p) => p.t);
  const kind = kindOfUnd(und, times);
  const { cats } = concatDaySlots([td], kind);
  const byL = clockLast(leftD);
  const byR = clockLast(rightD);
  const candles = cats.map((slot) => {
    const hm = hmOf(slot);
    const a = byL.get(hm);
    const r = byR.get(hm);
    if (!a || !r) return null;
    const s = spreadOHLC(a, r, mult);
    return invert ? flipOHLC(s) : s;
  });
  return { cats, candles };
}

/** Unwrap ovlab history: {data: bars} or a bare bar array. */
export function klineBars(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: unknown[] }).data;
  }
  return [];
}

/** 20260819 / 2026-08-19 15:00:00 -> 2026-08-19. OpenVlab 1D uses compact trade_date. */
export function dayKey(t: unknown): string {
  const s = String(t || "").trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

function parseHist(raw: unknown, daily: boolean): Pt[] {
  if (!Array.isArray(raw)) return [];
  const out: Pt[] = [];
  for (const b of raw) {
    if (Array.isArray(b) && b.length >= 2) {
      const t = daily ? dayKey(b[0]) : String(b[0] ?? "");
      const bar = barOf(t, num(b[4]), num(b[5]), num(b[6]), num(b[1]));
      if (bar) out.push(bar);
      continue;
    }
    if (b && typeof b === "object") {
      const o = b as Record<string, unknown>;
      const rawT = o.trade_date ?? o.datetime ?? o.date;
      const t = daily ? dayKey(rawT) : String(rawT ?? "");
      const bar = barOf(t, num(o.open), num(o.high), num(o.low), num(o.close));
      if (bar) out.push(bar);
    }
  }
  return out;
}

function parseLight(
  bars: Array<{ datetime?: string; open?: number; high?: number; low?: number; close?: number }> | undefined,
  daily: boolean,
): Pt[] {
  const out: Pt[] = [];
  for (const b of bars ?? []) {
    const raw = String(b.datetime ?? "");
    const t = daily ? dayKey(raw) : raw;
    const bar = barOf(t, num(b.open), num(b.high), num(b.low), num(b.close));
    if (bar) out.push(bar);
  }
  return out;
}

async function loadFut(code: string, mode: SpreadMode): Promise<Pt[]> {
  const now = Math.floor(Date.now() / 1000);
  if (mode === "daily") {
    const kl = await api.ovlabKlineHistory(code, "1D", now - 180 * 86400, now);
    return parseHist(klineBars(kl?.data ?? kl), true);
  }
  const kl = await api.ovlabKlineHistory(code, "1", now - MINUTE_LOOKBACK, now);
  return parseHist(klineBars(kl?.data ?? kl), false);
}

async function loadCash(code: string, mode: SpreadMode): Promise<Pt[]> {
  const kl = await loadLightKline(code, mode === "daily" ? "1D" : "1", mode === "daily" ? 120 : 240);
  return parseLight(kl?.bars, mode === "daily");
}

export function SpreadChart({ pick, mode }: { pick: ArbPick | null; mode: SpreadMode }) {
  const { ref, chartRef, labelsRef, onHoverRef } = useLcChart();
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const refLine = useRef<IPriceLine | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  onHoverRef.current = (idx) => {
    setHover((p) => (p === idx ? p : idx));
  };

  const poll = usePolling(
    async () => {
      if (!pick) return null;
      const left = await loadFut(pick.left, mode);
      const right = pick.kind === "idx"
        ? await loadCash(pick.cashCode, mode)
        : await loadFut(pick.right, mode);
      return { key: pick.key, left, right, mult: pick.kind === "idx" ? pick.cashMult : 1 };
    },
    60_000,
    [pick?.key, pick?.left, pick?.right, pick?.kind, mode],
    Boolean(pick),
  );

  const frame = useMemo(() => {
    const d = poll.data;
    if (!d || !pick || d.key !== pick.key) return null;
    const mult = d.mult;
    if (mode === "daily") {
      const byR = new Map<string, Pt>();
      for (const p of d.right) {
        const k = dayKey(p.t);
        if (k) byR.set(k, p);
      }
      const cats: string[] = [];
      const candles: Array<Ohlc | null> = [];
      for (const p of d.left) {
        const day = dayKey(p.t);
        if (!day) continue;
        const r = byR.get(day);
        cats.push(day);
        const s = r ? spreadOHLC(p, r, mult) : null;
        candles.push(s && pick.kind === "idx" ? flipOHLC(s) : s);
      }
      return { cats, candles };
    }
    return joinSpreadMinute(d.left, d.right, pick.leftUnd, mult, pick.kind === "idx");
  }, [poll.data, pick, mode]);

  const closes = useMemo(
    () => frame?.candles.map((b) => (b && Number.isFinite(b.close) ? b.close : null)) ?? [],
    [frame],
  );
  const lastIdx = useMemo(() => lastFiniteIdx(closes, null), [closes]);
  const lastBar = lastIdx != null && frame ? frame.candles[lastIdx] : null;
  const last = lastBar?.close ?? null;

  useEffect(() => { setHover(null); }, [pick?.key, mode]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!frame || frame.cats.length === 0) {
      setPaneWatermark(chart, wmRef, "");
      wipeLc(chart);
      seriesRef.current = null;
      refLine.current = null;
      labelsRef.current = [];
      return;
    }
    labelsRef.current = frame.cats;
    applyTimeLabels(chart, labelsRef, mode === "daily" ? "md" : "hm");
    if (!seriesAlive(chart, seriesRef.current) || seriesRef.current?.seriesType() !== "Candlestick") {
      if (seriesAlive(chart, seriesRef.current) && seriesRef.current) {
        try { chart.removeSeries(seriesRef.current); } catch { /* already gone */ }
      }
      seriesRef.current = chart.addSeries(CandlestickSeries, candleOpts());
    } else {
      seriesRef.current!.applyOptions(candleOpts());
    }
    const pxPts = candlePts(frame.candles);
    seriesRef.current!.setData(pxPts);
    const lastI = lastFiniteIdx(frame.candles.map((b) => b?.close ?? null), null);
    const lastC = lastI != null ? frame.candles[lastI] : null;
    let prevClose: number | null = null;
    if (lastI != null) {
      for (let j = lastI - 1; j >= 0; j--) {
        const c = frame.candles[j]?.close;
        if (c != null && Number.isFinite(c)) { prevClose = c; break; }
      }
    }
    styleLastTag(seriesRef.current, lastC?.close, lastC?.open);
    setRefPriceLine(seriesRef.current, refLine, prevClose);
    setPaneWatermark(chart, wmRef, pick?.label ?? "", 72);
    chart.timeScale().fitContent();
  }, [frame, mode, pick?.label, chartRef, labelsRef]);

  const loading = Boolean(pick) && !frame && !poll.error;
  const empty = Boolean(pick && frame && frame.candles.every((v) => v == null));
  const hoverIdx = lastFiniteIdx(closes, hover);
  const hoverBar = hoverIdx != null && frame ? frame.candles[hoverIdx] : lastBar;
  const hoverT = hoverIdx == null || !frame ? "" : frame.cats[hoverIdx];
  const hoverPx = hover != null && hoverIdx != null ? (hoverBar?.close ?? null) : null;
  let hoverRef: number | null = null;
  if (hoverIdx != null) {
    for (let j = hoverIdx - 1; j >= 0; j--) {
      const c = closes[j];
      if (c != null && Number.isFinite(c)) { hoverRef = c; break; }
    }
  }
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => seriesRef.current,
    hoverPx,
    hoverRef,
    (v) => signed(v),
    hover,
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
        <div className="min-w-0 truncate font-mono text-[11px] text-slate-300">
          {pick ? pick.label : "点上排一对"}
          {pick ? (
            <span className="ml-1.5 text-[10px] text-slate-500">
              {pick.kind === "idx" ? `${pick.cashCode} − ${pick.left}` : `${pick.left} − ${pick.right}`}
            </span>
          ) : null}
        </div>
        <span className={cn("font-mono text-[13px] tabular-nums", chgClass(last))}>{signed(last)}</span>
      </div>
      <LcWell className="min-h-0 flex-1 rounded-none">
        {!pick ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">点上排一对</div>
        ) : null}
        {pick && poll.error ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">未取到</div>
        ) : null}
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">更新中…</div>
        ) : null}
        {empty && !loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">无重叠点</div>
        ) : null}
        <LcLegend
          items={hoverBar ? [
            { k: "O", v: fmtPx(hoverBar.open) },
            { k: "H", v: fmtPx(hoverBar.high) },
            { k: "L", v: fmtPx(hoverBar.low) },
            { k: "C", v: signed(hoverBar.close), tone: lcTone(hoverBar.close - (hoverRef ?? hoverBar.open)) },
            ...(hoverT ? [{ k: "T", v: mode === "daily" ? hoverT : (hoverT.slice(11, 16) || hoverT), tone: "muted" as const }] : []),
          ] : []}
        />
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={ref} className="h-full w-full" />
      </LcWell>
    </div>
  );
}
