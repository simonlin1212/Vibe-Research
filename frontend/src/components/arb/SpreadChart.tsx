import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { num } from "@/components/ovlab/shared";
import { parseMinute } from "@/components/deriv/OptionChartCard";
import { loadLightKline } from "@/lib/lightKline";
import {
  concatDaySlots, hmOf, kindOfUnd, lastFiniteIdx, tradingDayOf, tradingDaysOf,
} from "@/lib/derivMinuteAxis";
import {
  LineSeries, applyTimeLabels, ensureUpDown, lineValues, paintUpDown, seriesAlive,
  setPaneWatermark, setRefPriceLine, sparseLine, spreadLineOpts,
  useLcChart, useLcHoverTag, wipeLc,
  type IPriceLine, type ISeriesApi, type ISeriesUpDownMarkerPluginApi, type ITextWatermarkPluginApi,
  type LineData, type Time,
} from "@/lib/lcChart";
import { LcHoverTag, LcLegend, LcSeg, LcWell, lcTone } from "@/components/ui/LcFrame";
import { chgClass, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";

type Mode = "minute" | "daily";

type Pt = { t: string; c: number };

/** OpenVlab 近 2 日窗口周一早盘不含周五, 也不回周日夜盘. 5 日才能对齐上一交易日. */
const MINUTE_LOOKBACK = 5 * 86400;

function defaultMode(kind: ArbPick["kind"] | undefined): Mode {
  return kind === "cal" ? "minute" : "daily";
}

/** Latest close per HH:MM so Sunday night wins over the previous Friday night. */
function clockLast(pts: Pt[]): Map<string, number> {
  const best = new Map<string, Pt>();
  for (const p of pts) {
    const hm = hmOf(p.t);
    if (!hm) continue;
    const prev = best.get(hm);
    if (!prev || p.t > prev.t) best.set(hm, p);
  }
  const out = new Map<string, number>();
  for (const [hm, p] of best) out.set(hm, p.c);
  return out;
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
): { cats: string[]; vals: Array<number | null> } {
  const td = lastOverlapDay(left, right);
  if (!td) return { cats: [], vals: [] };
  const leftD = left.filter((p) => tradingDayOf(p.t) === td);
  const rightD = right.filter((p) => tradingDayOf(p.t) === td);
  const times = [...leftD, ...rightD].map((p) => p.t);
  const kind = kindOfUnd(und, times);
  const { cats } = concatDaySlots([td], kind);
  const byL = clockLast(leftD);
  const byR = clockLast(rightD);
  const vals = cats.map((slot) => {
    const hm = hmOf(slot);
    const a = byL.get(hm);
    const r = byR.get(hm);
    if (a == null || r == null) return null;
    return a - r * mult;
  });
  return { cats, vals };
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

function parseDaily(raw: unknown): Pt[] {
  if (!Array.isArray(raw)) return [];
  const out: Pt[] = [];
  for (const b of raw) {
    if (Array.isArray(b) && b.length >= 2) {
      const t = dayKey(b[0]);
      const c = num(b[1]);
      if (t && c != null) out.push({ t, c });
      continue;
    }
    if (b && typeof b === "object") {
      const o = b as Record<string, unknown>;
      const t = dayKey(o.trade_date ?? o.datetime ?? o.date);
      const c = num(o.close);
      if (t && c != null) out.push({ t, c });
    }
  }
  return out;
}

function parseLight(
  bars: Array<{ datetime?: string; close?: number }> | undefined,
  daily: boolean,
): Pt[] {
  const out: Pt[] = [];
  for (const b of bars ?? []) {
    const raw = String(b.datetime ?? "");
    const t = daily ? dayKey(raw) : raw;
    const c = num(b.close);
    if (!t || c == null) continue;
    out.push({ t, c });
  }
  return out;
}

async function loadFut(code: string, mode: Mode): Promise<Pt[]> {
  const now = Math.floor(Date.now() / 1000);
  if (mode === "daily") {
    const kl = await api.ovlabKlineHistory(code, "1D", now - 180 * 86400, now);
    return parseDaily(klineBars(kl?.data ?? kl));
  }
  const kl = await api.ovlabKlineHistory(code, "1", now - MINUTE_LOOKBACK, now);
  return parseMinute(klineBars(kl?.data ?? kl)).map((b) => ({ t: b.t, c: b.close }));
}

async function loadCash(code: string, mode: Mode): Promise<Pt[]> {
  const kl = await loadLightKline(code, mode === "daily" ? "1D" : "1", mode === "daily" ? 120 : 240);
  return parseLight(kl?.bars, mode === "daily");
}

export function SpreadChart({ pick }: { pick: ArbPick | null }) {
  const [mode, setMode] = useState<Mode>(defaultMode(pick?.kind));
  useEffect(() => {
    setMode(defaultMode(pick?.kind));
  }, [pick?.kind, pick?.key]);
  const { ref, chartRef, labelsRef, onHoverRef } = useLcChart();
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const refLine = useRef<IPriceLine | null>(null);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const tickRef = useRef<ISeriesApi<"Line"> | null>(null);
  const udRef = useRef<ISeriesUpDownMarkerPluginApi<Time> | null>(null);
  const paintedTick = useRef<LineData[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  onHoverRef.current = setHover;

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
      const byR = new Map<string, number>();
      for (const p of d.right) {
        const k = dayKey(p.t);
        if (k) byR.set(k, p.c);
      }
      const cats: string[] = [];
      const vals: Array<number | null> = [];
      for (const p of d.left) {
        const day = dayKey(p.t);
        if (!day) continue;
        const r = byR.get(day);
        cats.push(day);
        vals.push(r == null ? null : p.c - r * mult);
      }
      return { cats, vals };
    }
    return joinSpreadMinute(d.left, d.right, pick.leftUnd, mult);
  }, [poll.data, pick, mode]);

  const last = useMemo(() => {
    if (!frame) return null;
    const i = lastFiniteIdx(frame.vals, null);
    return i == null ? null : frame.vals[i] ?? null;
  }, [frame]);

  useEffect(() => { setHover(null); }, [pick?.key, mode]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!frame || frame.cats.length === 0) {
      setPaneWatermark(chart, wmRef, "");
      wipeLc(chart);
      seriesRef.current = null;
      refLine.current = null;
      tickRef.current = null;
      udRef.current = null;
      paintedTick.current = null;
      labelsRef.current = [];
      return;
    }
    labelsRef.current = frame.cats;
    applyTimeLabels(chart, labelsRef, mode === "daily" ? "md" : "hm");
    if (!seriesAlive(chart, seriesRef.current) || seriesRef.current?.seriesType() !== "Line") {
      if (seriesAlive(chart, seriesRef.current) && seriesRef.current) {
        try { chart.removeSeries(seriesRef.current); } catch { /* already gone */ }
      }
      seriesRef.current = chart.addSeries(LineSeries, spreadLineOpts());
      tickRef.current = null;
      udRef.current = null;
    } else {
      seriesRef.current!.applyOptions(spreadLineOpts());
    }
    const pxPts = sparseLine(frame.vals);
    seriesRef.current!.setData(pxPts);
    const tickPts = lineValues(pxPts);
    paintUpDown(ensureUpDown(chart, tickRef, udRef), tickPts, paintedTick.current);
    paintedTick.current = tickPts;
    setRefPriceLine(seriesRef.current, refLine, null);
    setPaneWatermark(chart, wmRef, pick?.label ?? "", 72);
    chart.timeScale().fitContent();
  }, [frame, mode, pick?.label, chartRef, labelsRef]);

  const loading = Boolean(pick) && !frame && !poll.error;
  const empty = Boolean(pick && frame && frame.vals.every((v) => v == null));
  const hoverIdx = frame ? lastFiniteIdx(frame.vals, hover) : null;
  const hoverVal = hoverIdx == null || !frame ? last : (frame.vals[hoverIdx] ?? last);
  const hoverT = hoverIdx == null || !frame ? "" : frame.cats[hoverIdx];
  const hoverPx = hover != null && hoverIdx != null && frame ? (frame.vals[hoverIdx] ?? null) : null;
  const { tag: hoverTag, y: tagY } = useLcHoverTag(
    () => seriesRef.current,
    hoverPx,
    last,
    (v) => signed(v),
    hover,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
        <div className="min-w-0 truncate font-mono text-[11px] text-slate-300">
          {pick ? pick.label : "点上排一对"}
          {pick ? (
            <span className="ml-1.5 text-[10px] text-slate-500">
              {pick.left} − {pick.kind === "idx" ? pick.cashCode : pick.right}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("font-mono text-[13px] tabular-nums", chgClass(last))}>{signed(last)}</span>
          <LcSeg
            value={mode}
            options={pick?.kind === "idx"
              ? [{ v: "minute" as const, label: "分时" }, { v: "daily" as const, label: "升贴水" }]
              : [{ v: "minute" as const, label: "分时" }, { v: "daily" as const, label: "日K" }]}
            onChange={setMode}
          />
        </div>
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
          items={hoverVal != null ? [
            { k: "Δ", v: signed(hoverVal), tone: lcTone(hoverVal) },
            ...(hoverT ? [{ k: "T", v: mode === "daily" ? hoverT : (hoverT.slice(11, 16) || hoverT), tone: "muted" as const }] : []),
          ] : []}
        />
        <LcHoverTag tag={hoverTag} y={tagY} />
        <div ref={ref} className="h-full w-full" />
      </LcWell>
    </div>
  );
}
