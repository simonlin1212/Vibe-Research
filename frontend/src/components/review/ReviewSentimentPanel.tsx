import { type ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { FearGreedPanel } from "@/components/cockpit/FearGreedPanel";
import { HsgtStrip } from "@/components/review/HsgtStrip";
import { pctColor } from "@/components/review/format";
import type { HsgtLive, MarketBreadth, MarketSentiment } from "@/lib/api";
import { cn } from "@/lib/utils";

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function CountChip({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone: "up" | "flat" | "down";
}) {
  const dot = tone === "up" ? "bg-danger" : tone === "down" ? "bg-success" : "bg-slate-400";
  const num = tone === "up" ? "text-danger" : tone === "down" ? "text-success" : "text-slate-400";
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="text-slate-100">{label}</span>
      <span className={cn("font-mono tabular-nums", num)}>{n}</span>
    </span>
  );
}

interface Props {
  sentiment: MarketSentiment | undefined;
  ovDone: boolean;
  pending: ReactNode;
  breadth?: MarketBreadth | null;
  hsgt?: HsgtLive | null;
}

/** TickFlow-style up/down distribution + market breadth. */
export function ReviewSentimentPanel({
  sentiment,
  ovDone,
  pending,
  breadth,
  hsgt,
}: Props) {
  const up = breadth?.up ?? sentiment?.up ?? 0;
  const down = breadth?.down ?? sentiment?.down ?? 0;
  const flat = breadth?.flat ?? sentiment?.flat ?? 0;
  const total = Math.max(1, up + down + flat);
  const upShare = up / total;
  const downShare = down / total;
  const flatShare = flat / total;
  const hasCounts = (up + down + flat) > 0;
  const hasHist = !!(breadth && breadth.n > 0 && breadth.histogram?.length);
  const ready = hasCounts || hasHist;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-2 py-1">
      {!ready && !ovDone ? (
        pending
      ) : !ready ? (
        <EmptyState
          title="涨跌分布暂不可用"
          description="可点刷新重试；非交易时段或数据源限流时属正常。"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="flex shrink-0 items-start justify-between gap-2 text-[11px]">
            {hasCounts && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <CountChip label="涨" n={up} tone="up" />
                <CountChip label="平" n={flat} tone="flat" />
                <CountChip label="跌" n={down} tone="down" />
              </div>
            )}
            {hasHist && (
              <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                <span className="text-[10px] text-slate-500">
                  平均 <span className={cn("font-mono tabular-nums", pctColor(breadth!.avg ?? 0))}>{fmtPct(breadth!.avg)}</span>
                </span>
                <span className="text-[10px] text-slate-500">
                  中位 <span className={cn("font-mono tabular-nums", pctColor(breadth!.p50 ?? 0))}>{fmtPct(breadth!.p50)}</span>
                </span>
              </div>
            )}
          </div>

          {hasCounts && (
            <div
              className="flex h-2 shrink-0 overflow-hidden rounded-full bg-slate-800"
              title={`上涨 ${up} · 平盘 ${flat} · 下跌 ${down}`}
            >
              <div className="bg-danger/85 transition-[width] duration-500 ease-out" style={{ width: `${upShare * 100}%` }} />
              <div className="bg-slate-500/45 transition-[width] duration-500 ease-out" style={{ width: `${flatShare * 100}%` }} />
              <div className="bg-success/85 transition-[width] duration-500 ease-out" style={{ width: `${downShare * 100}%` }} />
            </div>
          )}

          {hasHist && (
            <div className="grid min-h-0 flex-1 grid-cols-8 items-end gap-1">
              {breadth!.histogram!.map((h, i) => {
                const max = Math.max(...breadth!.histogram!.map((x) => x.count), 1);
                const upSide = i >= 4;
                return (
                  <div key={h.label} className="flex h-full min-w-0 flex-col items-center justify-end gap-0.5">
                    <div className="font-mono text-[9px] tabular-nums text-slate-500">
                      {h.count || ""}
                    </div>
                    <div
                      className={cn(
                        "w-2.5 rounded-full",
                        upSide
                          ? "bg-gradient-to-t from-danger/45 to-danger/90"
                          : "bg-gradient-to-t from-success/45 to-success/90",
                      )}
                      style={{ height: `${Math.max(6, (h.count / max) * 86)}%` }}
                      title={`${h.label}: ${h.count} 只`}
                    />
                    <span className="truncate text-[9px] text-slate-600">{h.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          <FearGreedPanel compact className="shrink-0" />
        </div>
      )}
      <HsgtStrip data={hsgt ?? null} />
    </div>
  );
}
