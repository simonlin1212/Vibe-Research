import { useEffect, useMemo, useRef, useState } from "react";
import type { OvlabTQuoteExpiry } from "@/lib/api";
import { LcWell } from "@/components/ui/LcFrame";
import {
  LineSeries, LineStyle, useLcPriceChart, resizeLcHost, setPaneWatermark,
  type ITextWatermarkPluginApi, type LcPriceHover, type Time,
} from "@/lib/lcChart";
import { IvHtmlTip } from "./IvHtmlTip";
import {
  OV_PURPLE, OV_YDAY,
  atmTermPoints, nearestTermExp, termTipByExp, termTipHtml, termXRange, toLcPts,
} from "./iv-chart-math";

const IV_FMT = { type: "price" as const, precision: 1, minMove: 0.1 };

type Chart = NonNullable<ReturnType<typeof useLcPriceChart>["chartRef"]["current"]>;
type Line = ReturnType<Chart["addSeries"]>;

/** T-quote ATM IV term. LC options chart + official vol-ts hover HTML. Same tquote. */
export function IvTermChart({
  expiries,
  onPickExp,
}: {
  expiries: OvlabTQuoteExpiry[];
  onPickExp?: (exp: string) => void;
}) {
  const { ref, chartRef, rev, onHoverRef } = useLcPriceChart();
  const [hover, setHover] = useState<LcPriceHover>(null);
  onHoverRef.current = setHover;
  const bag = useRef<{ today: Line | null; yday: Line | null }>({ today: null, yday: null });
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const { today, yday } = useMemo(() => atmTermPoints(expiries), [expiries]);
  const tips = useMemo(() => termTipByExp(expiries), [expiries]);
  const empty = today.length === 0 && yday.length === 0;
  const xRange = useMemo(() => termXRange(today, yday), [today, yday]);
  const tipHtml = useMemo(() => {
    if (!hover || empty) return null;
    const exp = nearestTermExp([...today, ...yday], hover.x);
    if (!exp) return null;
    const tip = tips[exp];
    return tip ? termTipHtml(tip) : null;
  }, [hover, empty, today, yday, tips]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || rev < 1) return;
    if (empty || !xRange) {
      bag.current.today?.setData([]);
      bag.current.yday?.setData([]);
      setPaneWatermark(chart, wmRef, "IV期限", 36);
      return;
    }
    if (!bag.current.today || !bag.current.yday) {
      bag.current.today = chart.addSeries(LineSeries, {
        color: OV_PURPLE,
        lineWidth: 2,
        pointMarkersVisible: true,
        lastValueVisible: false,
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
    bag.current.today.setData(toLcPts(today.map((p) => [p.x, p.y])));
    bag.current.yday.setData(toLcPts(yday.map((p) => [p.x, p.y])));
    setPaneWatermark(chart, wmRef, "IV期限", 36);
    resizeLcHost(chart, ref.current);
    try {
      chart.timeScale().setVisibleRange({ from: xRange[0], to: xRange[1] });
    } catch {
      chart.timeScale().fitContent();
    }
  }, [today, yday, empty, xRange, chartRef, ref, rev]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onPickExp) return;
    const onClick = (param: { time?: unknown }) => {
      const exp = nearestTermExp([...today, ...yday], Number(param.time));
      if (exp) onPickExp(exp);
    };
    chart.subscribeClick(onClick);
    return () => {
      chart.unsubscribeClick(onClick);
    };
  }, [chartRef, rev, today, yday, onPickExp]);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-1">
      <div className="flex h-5 shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-500">
        <span style={{ color: OV_PURPLE }}>今</span>
        <span style={{ color: OV_YDAY }}>昨</span>
      </div>
      <LcWell className="min-h-0 flex-1 rounded-md">
        {empty && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-slate-500">无IV</div>
        )}
        <div ref={ref} className="h-full w-full" />
        <IvHtmlTip html={tipHtml} hostRef={ref} pt={hover ? { x: hover.px, y: hover.py } : null} />
      </LcWell>
    </div>
  );
}
