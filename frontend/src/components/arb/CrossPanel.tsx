import { useMemo, useState } from "react";
import type { ArbCrossRow } from "@/lib/api";
import { nextSort, type SortState } from "@/components/ovlab/shared";
import { CellEmpty, SortableHd } from "@/components/deriv/derivShared";
import { chgClass, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";

type Col = "label" | "spread" | "spreadChg";

export function CrossPanel({
  rows, error, pick, onPick,
}: {
  rows: ArbCrossRow[];
  error: string | null;
  pick: ArbPick | null;
  onPick: (p: ArbPick) => void;
}) {
  const [sort, setSort] = useState<SortState<Record<Col, unknown>>>({ key: "spreadChg", dir: "desc" });
  const list = useMemo(() => {
    const arr = [...rows];
    const key = sort.key;
    if (!key) return arr;
    const mul = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (key === "label") return a.label.localeCompare(b.label, "zh") * mul;
      const av = a[key] ?? 0;
      const bv = b[key] ?? 0;
      return (Number(av) - Number(bv)) * mul;
    });
    return arr;
  }, [rows, sort]);

  if (!rows.length) return <CellEmpty text={error ? "未取到" : "更新中…"} />;

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-card/95 px-2 pb-0.5 pt-1 text-[10px] text-slate-300">
        <SortableHd k="label" label="配对" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="min-w-0 flex-1 justify-start" />
        <span className="w-[2.4rem] shrink-0 text-slate-500">板块</span>
        <SortableHd k="spread" label="价差" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="w-[3.6rem] justify-end" title="A近月 - B近月" />
        <SortableHd k="spreadChg" label="较昨" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="w-[3.2rem] justify-end" />
      </div>
      {list.map((r) => {
        const key = `cross:${r.id}`;
        const active = pick?.key === key;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick({
              kind: "cross",
              key,
              label: r.label,
              left: r.a.code,
              right: r.b.code,
              leftUnd: r.aUnd,
              rightUnd: r.bUnd,
            })}
            className={cn(
              "flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[11px] hover:bg-white/[0.04]",
              active && "bg-primary/10",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-slate-200">{r.label}</span>
            <span className="w-[2.4rem] shrink-0 truncate text-[10px] text-slate-500">{r.sector}</span>
            <span className={cn("w-[3.6rem] shrink-0 text-right font-mono tabular-nums", chgClass(r.spread))}>
              {signed(r.spread)}
            </span>
            <span className={cn("w-[3.2rem] shrink-0 text-right font-mono tabular-nums", chgClass(r.spreadChg))}>
              {signed(r.spreadChg)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
