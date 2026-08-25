import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type LcTone = "up" | "down" | "flat" | "muted" | "iv" | "oi" | "px";

export type LcLegendItem = { k: string; v: string; tone?: LcTone };

export function lcTone(n: number | null | undefined): LcTone {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < 1e-12) return "flat";
  return n > 0 ? "up" : "down";
}

const TONE: Record<LcTone, string> = {
  up: "text-[#ff2d2d]",
  down: "text-[#00d26a]",
  flat: "text-slate-300",
  muted: "text-slate-500",
  iv: "text-[#8b7cff]",
  oi: "text-[#f0b90b]",
  px: "text-[#ffcc00]",
};

/** Inset well so the canvas reads like a TV pane, not a flat card. */
export function LcWell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-black shadow-[inset_0_0_0_1px_#2a2a2a]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Floating OHLCV strip, TV legend. */
export function LcLegend({
  items,
  className,
}: {
  items: LcLegendItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-96px)] flex-wrap gap-x-2.5 gap-y-0.5 font-sans text-[11px] tabular-nums tracking-tight",
        className,
      )}
    >
      {items.map((it) => (
        <span key={it.k} className="text-slate-500">
          {it.k}{" "}
          <span className={cn("font-medium", TONE[it.tone ?? "flat"])}>{it.v}</span>
        </span>
      ))}
    </div>
  );
}

/** Right-edge crosshair: white plate, dark price, red/green % vs latest. */
export function LcHoverTag({
  tag,
  y,
}: {
  tag: { px: string; pct: string | null; chg: number | null } | null;
  y: number | null;
}) {
  if (!tag || y == null) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-y-1/2 rounded-sm px-1 py-px font-sans text-[11px] font-medium tabular-nums text-slate-900 shadow-sm"
      style={{ top: y, right: 0, background: "#fff" }}
    >
      {tag.px}
      {tag.pct != null && tag.chg != null ? (
        <span className={tag.chg > 0 ? "text-[#ff2d2d]" : "text-[#00d26a]"}>
          {" "}({tag.pct})
        </span>
      ) : null}
    </div>
  );
}

/** Interval / mode pills, TV toolbar. */
export function LcSeg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ v: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-white/[0.03] p-0.5 ring-1 ring-white/[0.06]">
      {options.map((r) => (
        <button
          key={r.v}
          type="button"
          onClick={() => onChange(r.v)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[11px] tracking-wide",
            value === r.v ? "bg-primary/15 text-primary" : "text-slate-500 hover:text-slate-300",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
