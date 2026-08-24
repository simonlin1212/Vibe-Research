import { usePolling } from "@/hooks/usePolling";
import { api, type FearGreedBoard, type FearGreedItem } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_MS = 300_000;
const CX = 100;
const CY = 102;
const R = 72;
const SW = 14;
const GAP = 0.028;

const SEG_COLORS = ["#0f766e", "#84cc16", "#eab308", "#f97316", "#ef4444"] as const;

const BANDS = [
  { max: 25, ink: "#2dd4bf" },
  { max: 45, ink: "#a3e635" },
  { max: 54, ink: "#facc15" },
  { max: 74, ink: "#fb923c" },
  { max: 100, ink: "#fb7185" },
] as const;

function labelLines(raw: string | null | undefined): string[] {
  const s = raw?.trim() || "未取到";
  if (s.startsWith("极度") && s.length === 4) return ["极度", s.slice(2)];
  return [s];
}

function bandOf(score: number | null | undefined) {
  if (score == null) return null;
  return BANDS.find((b) => score <= b.max) ?? BANDS[BANDS.length - 1];
}

/** t=0 left (fear), t=1 right (greed). Semicircle opens downward. */
function pt(t: number, r = R): [number, number] {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, t)));
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

function arc(t0: number, t1: number, r = R): string {
  const [x0, y0] = pt(t0, r);
  const [x1, y1] = pt(t1, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function segs() {
  const n = SEG_COLORS.length;
  const w = (1 - (n - 1) * GAP) / n;
  return SEG_COLORS.map((color, i) => {
    const t0 = i * (w + GAP);
    return { color, t0, t1: t0 + w };
  });
}

function Gauge({ it, compact }: { it: FearGreedItem; compact?: boolean }) {
  const score = it.score == null ? null : Math.max(0, Math.min(100, it.score));
  const t = score == null ? null : score / 100;
  const band = bandOf(score);
  const [dx, dy] = pt(t ?? 0);
  const lines = labelLines(it.label);
  const two = lines.length > 1;
  return (
    <div
      className={cn("flex min-w-0 flex-col items-center", compact ? "px-0 py-0" : "px-0.5 py-0.5")}
      title={it.label ? `${it.title} ${score ?? "—"} ${it.label}` : it.title}
    >
      <p className={cn("truncate font-medium text-slate-100", compact ? "text-[10px] leading-3" : "text-[11px]")}>{it.title}</p>
      <svg viewBox="0 0 200 124" className={cn("w-full", compact ? "max-h-12" : "mt-0.5 max-w-[132px]")} role="img" aria-label={`${it.title} ${it.label || "未取到"}`}>
        {segs().map((s) => (
          <path
            key={s.color}
            d={arc(s.t0, s.t1)}
            fill="none"
            stroke={s.color}
            strokeWidth={SW}
            strokeLinecap="round"
          />
        ))}
        {t != null && (
          <circle
            cx={dx}
            cy={dy}
            r={compact ? 5.5 : 6.5}
            fill="#0f172a"
            stroke="#f8fafc"
            strokeWidth="2.2"
          />
        )}
        {lines.map((line, i) => (
          <text
            key={line}
            x={CX}
            y={two ? CY - 20 + i * 20 : CY - 8}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={band?.ink ?? "#94a3b8"}
            style={{ fontSize: two ? 20 : 24, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: 700 }}
          >
            {line}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function FearGreedPanel({ className, compact }: { className?: string; compact?: boolean }) {
  const { data, error } = usePolling<FearGreedBoard>(() => api.fearGreed(), POLL_MS, []);
  const items = data?.items ?? [];
  return (
    <div className={cn("min-h-0", className)}>
      {!data && (
        <p className={cn("text-center text-[11px] text-slate-600", compact ? "py-1" : "py-4")}>
          {error ? "全球情绪未接通, 自动重试中" : "加载中…"}
        </p>
      )}
      {items.length > 0 && (
        <div className={cn("grid", compact ? "grid-cols-6 gap-0.5" : "grid-cols-2 gap-1.5 p-1.5 sm:grid-cols-4 xl:grid-cols-8")}>
          {items.map((it) => <Gauge key={it.key} it={it} compact={compact} />)}
        </div>
      )}
    </div>
  );
}
