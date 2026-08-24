import { useMemo } from "react";
import { KlineLink } from "@/components/cockpit/QuoteLine";
import { reviewPending } from "@/components/review/reviewPending";
import type { LianbanStock, ShortTermEmotion } from "@/lib/api";
import { cn } from "@/lib/utils";

type Side = "up" | "down";

function tierLabel(n: number, plus: boolean, side: Side): string {
  if (side === "down") {
    if (n <= 1) return "首跌";
    return plus ? `${n}跌+` : `${n}跌`;
  }
  if (n <= 1) return "首板";
  return plus ? `${n}板+` : `${n}板`;
}

function tierText(n: number, side: Side): string {
  if (side === "down") {
    if (n >= 5) return "text-emerald-300";
    if (n >= 3) return "text-emerald-400";
    if (n >= 2) return "text-emerald-500/90";
    return "text-slate-400";
  }
  if (n >= 5) return "text-rose-300";
  if (n >= 3) return "text-orange-400";
  if (n >= 2) return "text-amber-400";
  return "text-slate-400";
}

function boardTag(code: string): { label: string; cls: string } | null {
  if (/^(300|301)/.test(code)) return { label: "创", cls: "text-orange-400" };
  if (/^688/.test(code)) return { label: "科", cls: "text-primary" };
  if (/^(8|4)\d{5}$/.test(code)) return { label: "北", cls: "text-violet-400" };
  return null;
}

interface Tier {
  boards: number;
  plus: boolean;
  stocks: LianbanStock[];
}

function groupTiers(stocks: LianbanStock[]): Tier[] {
  const map = new Map<number, LianbanStock[]>();
  for (const s of stocks) {
    const b = Math.min(Math.max(s.boards || 1, 1), 5);
    const list = map.get(b) ?? [];
    list.push(s);
    map.set(b, list);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([boards, rows]) => ({ boards, plus: boards >= 5, stocks: rows }));
}

/** Narrow-column 天梯: high boards on top, first board at the bottom. */
export function LimitLadderView({
  emotion,
  emoDone,
  side = "up",
  onSide,
}: {
  emotion: ShortTermEmotion | null;
  emoDone: boolean;
  side?: Side;
  onSide?: (s: Side) => void;
}) {
  const stocks = side === "down"
    ? (emotion?.dt_stocks ?? [])
    : (emotion?.zt_stocks?.length ? emotion.zt_stocks : (emotion?.lianban_stocks ?? []));
  const tiers = useMemo(() => groupTiers(stocks), [stocks]);
  const countReady = side === "down" ? emotion?.dt_count : emotion?.zt_count;
  const zt = emotion?.zt_count;
  const dt = emotion?.dt_count;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-1.5 py-1">
        {([
          ["up", "涨停", zt],
          ["down", "跌停", dt],
        ] as const).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => onSide?.(k)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              side === k
                ? k === "up"
                  ? "bg-rose-500/15 font-semibold text-rose-300"
                  : "bg-emerald-500/15 font-semibold text-emerald-300"
                : "text-slate-500 hover:text-slate-300",
            )}
          >
            {label}
            <span className="ml-1 font-mono tabular-nums">{n ?? "—"}</span>
          </button>
        ))}
        {side === "up" && emotion?.seal_rate != null && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-500">
            封 {(emotion.seal_rate * 100).toFixed(0)}%
            {emotion.break_rate != null ? ` · 炸 ${(emotion.break_rate * 100).toFixed(0)}%` : ""}
          </span>
        )}
        {side === "down" && emotion?.seals && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-500">
            真 {emotion.seals.sealed_down} · 假 {emotion.seals.fake_down}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5">
        {!emotion || countReady === undefined ? (
          <div className="p-5">{reviewPending(emoDone)}</div>
        ) : !tiers.length ? (
          <p className="px-2 py-6 text-center text-[11px] text-slate-600">
            {side === "down" ? "今日暂无跌停" : "今日暂无涨停"}
          </p>
        ) : (
          <div className="space-y-1">
            {tiers.map((t) => (
              <div key={t.boards} className="flex gap-1.5">
                <div className={cn("w-8 shrink-0 pt-0.5 text-right", tierText(t.boards, side))}>
                  <p className="text-[10px] font-bold leading-4">{tierLabel(t.boards, t.plus, side)}</p>
                  <p className="font-mono text-[9px] tabular-nums text-slate-600">{t.stocks.length}</p>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap content-start gap-x-1 gap-y-0.5">
                  {t.stocks.map((s) => {
                    const tag = boardTag(s.code);
                    return (
                      <KlineLink
                        key={s.code || s.name}
                        code={s.code}
                        title={s.industry || s.code}
                        className="inline-flex max-w-[5.5rem] items-baseline gap-0.5 rounded px-0.5 py-px text-[11px] text-slate-200 hover:bg-slate-800/70 hover:text-primary"
                      >
                        <span className="truncate">{s.name}</span>
                        {tag && <span className={cn("shrink-0 text-[9px]", tag.cls)}>{tag.label}</span>}
                      </KlineLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
