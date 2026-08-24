import { useMemo, useState } from "react";
import type { ArbCalendarRow } from "@/lib/api";
import { nextSort, type SortState } from "@/components/ovlab/shared";
import { CellEmpty, SortableHd } from "@/components/deriv/derivShared";
import { chgClass, fmtOi, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";

type Col = "label" | "spread" | "spreadChg" | "oi";

export function CalendarPanel({
  rows, error, pick, onPick,
}: {
  rows: ArbCalendarRow[];
  error: string | null;
  pick: ArbPick | null;
  onPick: (p: ArbPick) => void;
}) {
  const [sort, setSort] = useState<SortState<Record<Col, unknown>>>({ key: "spreadChg", dir: "desc" });
  const list = useMemo(() => {
    const arr = [...rows];
    const key = sort.key;
    if (!key) {
      arr.sort((a, b) => Math.abs(b.spreadChg ?? 0) - Math.abs(a.spreadChg ?? 0));
      return arr;
    }
    const mul = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (key === "label") return a.label.localeCompare(b.label, "zh") * mul;
      const av = key === "oi" ? (a.near.oi ?? 0) : (a[key] ?? 0);
      const bv = key === "oi" ? (b.near.oi ?? 0) : (b[key] ?? 0);
      return (Number(av) - Number(bv)) * mul;
    });
    return arr;
  }, [rows, sort]);

  if (!rows.length) return <CellEmpty text={error ? "未取到" : "更新中…"} />;

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-card/95 px-2 pb-0.5 pt-1 text-[10px] text-slate-300">
        <SortableHd k="label" label="品种" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="min-w-0 flex-1 justify-start" />
        <span className="w-[4.2rem] shrink-0 text-right">近/次</span>
        <SortableHd k="spread" label="价差" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="w-[3.4rem] justify-end" title="近月 - 次月" />
        <SortableHd k="spreadChg" label="较昨" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="w-[3.2rem] justify-end" />
        <SortableHd k="oi" label="近仓" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="w-[2.8rem] justify-end" />
      </div>
      {list.map((r) => {
        const key = `cal:${r.und}`;
        const active = pick?.key === key;
        return (
          <button
            key={r.und}
            type="button"
            onClick={() => onPick({
              kind: "cal",
              key,
              label: `${r.label} 跨期`,
              left: r.near.code,
              right: r.next.code,
              leftUnd: r.und,
              rightUnd: r.und,
            })}
            className={cn(
              "flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[11px] hover:bg-white/[0.04]",
              active && "bg-primary/10",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-slate-200">{r.label}</span>
            <span className="w-[4.2rem] shrink-0 truncate text-right font-mono text-[10px] text-slate-500">
              {r.near.code.slice(-4)}/{r.next.code.slice(-4)}
            </span>
            <span className={cn("w-[3.4rem] shrink-0 text-right font-mono tabular-nums", chgClass(r.spread))}>
              {signed(r.spread)}
            </span>
            <span className={cn("w-[3.2rem] shrink-0 text-right font-mono tabular-nums", chgClass(r.spreadChg))}>
              {signed(r.spreadChg)}
            </span>
            <span className="w-[2.8rem] shrink-0 text-right font-mono text-[10px] text-slate-500">
              {fmtOi(r.near.oi)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
