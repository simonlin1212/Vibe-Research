import { useState, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { derivSessionIdx, derivSessionSpan, kindOfUnd } from "@/lib/derivMinuteAxis";
import type { OvlabMarketRow, OvlabPriceVolSeriesItem } from "@/lib/api";

export function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

/** Remaining calendar days until expiry_date (YYYYMMDD or YYYY-MM-DD). Today = 0. */
export function daysToExpiry(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  if (/^\d{8}$/.test(s)) {
    y = Number(s.slice(0, 4)); m = Number(s.slice(4, 6)); d = Number(s.slice(6, 8));
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    y = Number(s.slice(0, 4)); m = Number(s.slice(5, 7)); d = Number(s.slice(8, 10));
  } else {
    return null;
  }
  if (!y || !m || !d) return null;
  const exp = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp.getTime() - today.getTime()) / 86400000);
}

// —— 通用排序: 数值优先, 否则字符串. null/缺失排末尾 ——
export type SortState<T> = { key: keyof T | null; dir: "asc" | "desc" };

export function nextSort<T>(cur: SortState<T>, key: keyof T): SortState<T> {
  if (cur.key !== key) return { key, dir: "desc" };
  if (cur.dir === "desc") return { key, dir: "asc" };
  return { key: null, dir: "desc" };
}

// —— 走势配色: 驾驶舱迷你走势 ——

const TREND_IV = "#a78bfa";

// A股 MinuteSpark 柔和配色: 分时 spark 与 /a-share 视觉对齐
const SPARK_UP = "#fda4af";
const SPARK_DOWN = "#6ee7b7";
const SPARK_FLAT = "#cbd5e1";
const SPARK_BASE = "#94a3b8";

/** Derive prev close/settle from price & ctn (涨跌幅%). Null when either missing. */
export function prevCloseOf(r: Pick<OvlabMarketRow, "price" | "ctn">): number | null {
  const p = num(r.price);
  const c = num(r.ctn);
  if (p === null || c === null || c <= -100) return null;
  const base = p / (1 + c / 100);
  return Number.isFinite(base) && base > 0 ? base : null;
}

// —— 走势预览: 驾驶舱行情观察 / 自选 / 指数 tab 共用 ——

/** Build OpenVlab preview code: prodUnd:exp (e.g. MA:202609) */
export function previewCode(r: Pick<OvlabMarketRow, "prodUnd" | "exp">): string {
  const und = String(r.prodUnd ?? "").trim();
  const exp = String(r.exp ?? "").trim();
  return und && exp ? `${und}:${exp}` : "";
}

export type PreviewSeries = { prices: Array<[string, number]>; volatilities: Array<[string, number]> };

/** Key price-volatility-series response items by preview code (symbol). */
export function toSparkMap(items: OvlabPriceVolSeriesItem[] | null | undefined): Record<string, PreviewSeries> {
  const out: Record<string, PreviewSeries> = {};
  for (const it of items ?? []) {
    const sym = String(it.symbol ?? "").trim();
    if (!sym) continue;
    out[sym] = {
      prices: Array.isArray(it.prices) ? it.prices : [],
      volatilities: Array.isArray(it.volatilities) ? it.volatilities : [],
    };
  }
  return out;
}

/** Dual-line SVG spark: price vs base (prev close, fallback first print), A股 MinuteSpark palette; IV in violet. */
export function TrendSparkSvg({
  prices, volatilities, base, width = 88, height = 36, className, fill = false, und, hasNight,
}: {
  prices: Array<[string, number]>;
  volatilities: Array<[string, number]>;
  /** Prev close/settle as baseline; falls back to first print. */
  base?: number | null;
  width?: number;
  height?: number;
  className?: string;
  /** Stretch to container width (MinuteSpark style): CSS controls size, strokes stay 1:1. */
  fill?: boolean;
  /** Underlying root (IF / AU / 510050). Picks session template. */
  und?: string;
  hasNight?: boolean | null;
}) {
  const pad = 2;
  const uid = useId().replace(/:/g, "");

  const pricePtsRaw = prices
    .map((p) => ({ t: String(p[0] ?? ""), v: Number(p[1]) }))
    .filter((p) => Number.isFinite(p.v));
  const volPtsRaw = volatilities
    .map((p) => ({ t: String(p[0] ?? ""), v: Number(p[1]) }))
    .filter((p) => Number.isFinite(p.v));
  const priceVals = pricePtsRaw.map((p) => p.v);
  const volVals = volPtsRaw.map((p) => p.v);

  const boxProps = fill
    ? { preserveAspectRatio: "none" as const, className: cn("block w-full", className) }
    : { width, height, className };

  if (priceVals.length < 2 && volVals.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} {...boxProps} aria-hidden>
        <line x1={pad} y1={height / 2} x2={width - pad} y2={height / 2} stroke="currentColor" strokeDasharray="3 3" className="text-muted-foreground/40" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }

  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const kind = kindOfUnd(und, [...pricePtsRaw.map((p) => p.t), ...volPtsRaw.map((p) => p.t)], hasNight);
  const span = derivSessionSpan(kind);
  const xAtT = (t: string) => {
    const idx = derivSessionIdx(t, kind);
    if (!Number.isFinite(idx) || span <= 0) return pad;
    return pad + (idx / span) * innerW;
  };

  // Baseline = prev close when given, else first print; scale includes it so the line stays visible
  const zero = base != null && Number.isFinite(base) && base > 0 ? base : (priceVals[0] ?? 0);
  const pMin = priceVals.length ? Math.min(...priceVals, zero) : 0;
  const pMax = priceVals.length ? Math.max(...priceVals, zero) : 1;
  const pSpan = pMax - pMin || 1;
  const yPrice = (v: number) => pad + (1 - (v - pMin) / pSpan) * innerH;
  const zeroY = yPrice(zero);

  // Single tone by last vs baseline, same as MinuteSpark
  const lastP = priceVals.length ? priceVals[priceVals.length - 1] : null;
  const tone = lastP === null || zero <= 0 ? SPARK_FLAT : lastP > zero ? SPARK_UP : lastP < zero ? SPARK_DOWN : SPARK_FLAT;

  const pricePts = pricePtsRaw.map((p) => ({ x: xAtT(p.t), y: yPrice(p.v) }));
  const priceLine = pricePts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  // Area closes down to the bottom edge, gradient fades out (MinuteSpark style)
  const priceArea = pricePts.length >= 2
    ? `${priceLine} L${pricePts[pricePts.length - 1].x.toFixed(1)},${(height - pad).toFixed(1)} L${pricePts[0].x.toFixed(1)},${(height - pad).toFixed(1)} Z`
    : "";

  // IV: independent normalize
  let volLine = "";
  if (volVals.length >= 2) {
    const vMin = Math.min(...volVals);
    const vMax = Math.max(...volVals);
    const vSpan = vMax - vMin || 1;
    volLine = volPtsRaw.map((p, i) => {
      const x = xAtT(p.t);
      const y = pad + (1 - (p.v - vMin) / vSpan) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  const grad = `${uid}-g`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} {...boxProps} aria-hidden>
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.38" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Baseline (prev close) */}
      {pricePts.length >= 2 && (
        <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke={SPARK_BASE} strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      )}

      {/* Price area + line, single tone */}
      {priceArea && (
        <>
          <path d={priceArea} fill={`url(#${grad})`} />
          <path d={priceLine} fill="none" stroke={tone} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      )}

      {/* IV violet overlay */}
      {volLine ? (
        <path d={volLine} fill="none" stroke={TREND_IV} strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" opacity={0.9} vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
}

/** Inline spark + hover enlarged overlay (price + IV), like openvlab.cn/market TrendPreviewCell. */
export function TrendPreviewCell({ series, loading, base, und, hasNight }: {
  series?: PreviewSeries; loading?: boolean; base?: number | null; und?: string;
  hasNight?: boolean | null;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) { setHover(true); return; }
    const popW = 280;
    const popH = 180;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (left < 8) left = 8;
    if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
    setPos({ top, left });
    setHover(true);
  };

  if (loading && !series) {
    return (
      <div className="flex h-9 w-[5.5rem] items-center justify-center text-muted-foreground/50">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }
  const prices = series?.prices ?? [];
  const vols = series?.volatilities ?? [];
  const empty = prices.length < 2 && vols.length < 2;
  const lastP = prices.length ? num(prices[prices.length - 1][1]) : null;
  const firstP = prices.length ? num(prices[0][1]) : null;
  const lastV = vols.length ? num(vols[vols.length - 1][1]) : null;
  const firstV = vols.length ? num(vols[0][1]) : null;
  const refP = base != null && Number.isFinite(base) && base > 0 ? base : firstP;
  const pChg = lastP != null && refP != null && refP !== 0 ? ((lastP - refP) / refP) * 100 : null;
  const vChg = lastV != null && firstV != null ? lastV - firstV : null;

  return (
    <div
      ref={anchorRef}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={cn(
        "flex h-9 w-[5.5rem] items-center justify-center rounded-md border border-transparent transition-colors",
        !empty && "hover:border-border/60 hover:bg-muted/30",
      )}>
        {empty
          ? <span className="text-xs text-muted-foreground/40">-</span>
          : <TrendSparkSvg prices={prices} volatilities={vols} base={base} und={und} hasNight={hasNight} />}
      </div>
      {hover && !empty && pos && createPortal(
        <div
          className="pointer-events-none fixed z-[100] w-[280px] border border-[#2a2a2a] bg-black p-2"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
            <span className="font-medium text-foreground">走势预览</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-2 rounded-full bg-red-500" />
                <span className="h-1.5 w-2 rounded-full bg-emerald-500" />
                价格
              </span>
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-violet-400" />隐波</span>
            </span>
          </div>
          <TrendSparkSvg prices={prices} volatilities={vols} base={base} width={256} height={96} und={und} hasNight={hasNight} />
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] tabular-nums">
            <div>
              <div className="text-muted-foreground">价格</div>
              <div className="font-medium">
                {lastP != null ? lastP.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-"}
                {pChg != null && (
                  <span className={cn("ml-1", pChg > 0 ? "text-red-500" : pChg < 0 ? "text-emerald-500" : "text-muted-foreground")}>
                    {pChg > 0 ? "+" : ""}{pChg.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">隐波</div>
              <div className="font-medium">
                {lastV != null ? lastV.toFixed(2) : "-"}
                {vChg != null && (
                  <span className={cn("ml-1", vChg > 0 ? "text-red-500" : vChg < 0 ? "text-emerald-500" : "text-muted-foreground")}>
                    {vChg > 0 ? "+" : ""}{vChg.toFixed(2)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
