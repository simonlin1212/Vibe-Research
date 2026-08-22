import { useEffect, useMemo, useRef, useState } from "react";
import type { OvlabTQuoteStrike } from "@/lib/api";
import { LcWell } from "@/components/ui/LcFrame";
import {
  LineSeries, LineStyle, useLcPriceChart, resizeLcHost, setPaneWatermark,
  type ITextWatermarkPluginApi, type LcPriceHover, type Time,
} from "@/lib/lcChart";
import { IvHtmlTip } from "./IvHtmlTip";
import {
  OV_FUTURE, OV_PURPLE, OV_YDAY,
  nearestXy, nearSmileStem, smileSeries, smileStemBox, smileStemX, smileTipHtml, smileXRange, smileYRange,
  synthSpotTipHtml, toLcPts, volAt,
} from "./iv-chart-math";

const IV_FMT = { type: "price" as const, precision: 1, minMove: 0.1 };

type Chart = NonNullable<ReturnType<typeof useLcPriceChart>["chartRef"]["current"]>;
type Line = ReturnType<Chart["addSeries"]>;

/** Fitted IV smile. LC options chart + official hover HTML. */
export function IvSmileChart({
  smileTd,
  smileYd,
  strikes,
  displayLo,
  displayHi,
  spot,
}: {
  smileTd?: Array<[number, number]> | null;
  smileYd?: Array<[number, number]> | null;
  strikes: OvlabTQuoteStrike[];
  displayLo: number | null;
  displayHi: number | null;
  /** Synthetic underlying (surface forward_td). */
  spot: number | null;
}) {
  const { ref, chartRef, rev, onHoverRef } = useLcPriceChart();
  const [hover, setHover] = useState<LcPriceHover>(null);
  const [stem, setStem] = useState<{ x: number; top: number; h: number } | null>(null);
  onHoverRef.current = setHover;
  const bag = useRef<{
    rev: number;
    today: Line | null;
    yday: Line | null;
  }>({ rev: -1, today: null, yday: null });
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const { today, yday } = useMemo(
    () => smileSeries(smileTd, smileYd, strikes),
    [smileTd, smileYd, strikes],
  );
  const empty = today.length === 0 && yday.length === 0;
  const xRange = useMemo(() => smileXRange(today, yday, displayLo, displayHi), [today, yday, displayLo, displayHi]);
  const yRange = useMemo(() => smileYRange(today, yday, displayLo, displayHi), [today, yday, displayLo, displayHi]);
  const tipHtml = useMemo(() => {
    if (!hover || empty) return null;
    if (nearSmileStem(hover.px, stem?.x) && spot != null && Number.isFinite(spot)) {
      return synthSpotTipHtml(spot);
    }
    const hit = nearestXy([...today, ...yday], hover.x);
    const k = hit?.[0] ?? hover.x;
    return smileTipHtml(k, volAt(today, k), volAt(yday, k));
  }, [hover, empty, stem, spot, today, yday]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (bag.current.rev !== rev) {
      bag.current = { rev, today: null, yday: null };
      wmRef.current = null;
    }
    const applyStem = (next: { x: number; top: number; h: number } | null) => {
      setStem((prev) => {
        if (prev === next) return prev;
        if (!prev || !next) return next;
        if (prev.x === next.x && prev.top === next.top && prev.h === next.h) return prev;
        return next;
      });
    };
    const pinStem = () => {
      if (empty || spot == null || !Number.isFinite(spot) || !xRange) {
        applyStem(null);
        return;
      }
      const ts = chart.timeScale();
      const vr = ts.getVisibleRange();
      const host = ref.current;
      const x = smileStemX(spot, vr?.from ?? xRange[0], vr?.to ?? xRange[1], ts.width());
      const s = bag.current.today;
      const box = yRange
        ? smileStemBox(x, s?.priceToCoordinate(yRange[0]) ?? null, s?.priceToCoordinate(yRange[1]) ?? null)
        : null;
      applyStem(box ?? (x != null && host
        ? { x, top: 8, h: Math.max(1, host.clientHeight - 16) }
        : null));
    };
    if (empty || !xRange || !yRange) {
      bag.current.today?.setData([]);
      bag.current.yday?.setData([]);
      applyStem(null);
      setPaneWatermark(chart, wmRef, "IV微笑", 36);
      return;
    }
    if (!bag.current.today || !bag.current.yday) {
      bag.current.today = chart.addSeries(LineSeries, {
        color: OV_PURPLE,
        lineWidth: 2,
        pointMarkersVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
        priceFormat: IV_FMT,
      });
      bag.current.yday = chart.addSeries(LineSeries, {
        color: OV_YDAY,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: IV_FMT,
      });
    }
    const yOpts = {
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: yRange[0], maxValue: yRange[1] },
      }),
    };
    bag.current.today.applyOptions(yOpts);
    bag.current.today.setData(toLcPts(today));
    bag.current.yday.setData(toLcPts(yday));
    resizeLcHost(chart, ref.current);
    try {
      chart.timeScale().setVisibleRange({ from: xRange[0], to: xRange[1] });
    } catch {
      chart.timeScale().fitContent();
    }
    setPaneWatermark(chart, wmRef, "IV微笑", 36);
    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(pinStem);
    const host = ref.current;
    const ro = host ? new ResizeObserver(pinStem) : null;
    ro?.observe(host!);
    requestAnimationFrame(() => requestAnimationFrame(pinStem));
    return () => {
      ro?.disconnect();
      try { ts.unsubscribeVisibleTimeRangeChange(pinStem); } catch { /* chart gone */ }
    };
  }, [today, yday, empty, xRange, yRange, spot, chartRef, ref, rev]);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-1">
      <div className="flex h-5 shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-500">
        <span style={{ color: OV_PURPLE }}>今</span>
        <span>昨</span>
        <span style={{ color: OV_FUTURE }}>合成标的</span>
      </div>
      <LcWell className="min-h-0 flex-1 rounded-md">
        {empty && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">无IV</div>
        )}
        <div ref={ref} className="h-full w-full" />
        {stem && (
          <div className="pointer-events-none absolute inset-0 z-10">
            <div
              className="absolute w-[2px]"
              style={{ left: stem.x, top: stem.top, height: stem.h, transform: "translateX(-50%)", background: OV_FUTURE }}
            />
          </div>
        )}
        <IvHtmlTip html={tipHtml} hostRef={ref} pt={hover ? { x: hover.px, y: hover.py } : null} />
      </LcWell>
    </div>
  );
}
