import { useMemo, useState } from "react";
import type { ArbIndexRow, ChemSpot, SpotTable } from "@/lib/api";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes } from "@/lib/quoteHub";
import { INDEX_CASH_CODES } from "@/config/arb";
import { CellEmpty } from "@/components/deriv/derivShared";
import { chgClass, fmtPx, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";

const SPOT_MS = 8 * 3600_000;

export function BasisPanel({
  rows, error, pick, onPick,
}: {
  rows: ArbIndexRow[];
  error: string | null;
  pick: ArbPick | null;
  onPick: (p: ArbPick) => void;
}) {
  const [tab, setTab] = useState<"idx" | "spot">("idx");
  const quotes = useQuotes(INDEX_CASH_CODES);
  const spot = usePolling(() => api.spotTable(), SPOT_MS, [], tab === "spot");
  const chem = usePolling(() => api.chemSpot("7250", "碳酸亚乙烯酯"), SPOT_MS, [], tab === "spot");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-0.5 border-b border-slate-800/60 px-2 py-1">
        {([["idx", "股指"], ["spot", "现期"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded px-2 py-0.5 text-[11px]",
              tab === id ? "bg-slate-800 text-slate-200" : "text-slate-500 hover:text-slate-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "idx" ? (
          <IndexBasisTable rows={rows} error={error} quotes={quotes} pick={pick} onPick={onPick} />
        ) : (
          <SpotTableView data={spot.data} error={spot.error} chem={chem.data} />
        )}
      </div>
    </div>
  );
}

function IndexBasisTable({
  rows, error, quotes, pick, onPick,
}: {
  rows: ArbIndexRow[];
  error: string | null;
  quotes: ReturnType<typeof useQuotes>;
  pick: ArbPick | null;
  onPick: (p: ArbPick) => void;
}) {
  const list = useMemo(() => rows, [rows]);
  if (!rows.length) return <CellEmpty text={error ? "未取到" : "更新中…"} />;

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-1.5 pb-0.5 pt-1 text-[11px] text-slate-300">
        <span className="w-[7.25rem] shrink-0">配对</span>
        <span className="w-12 text-right">期货</span>
        <span className="w-12 text-right">现货</span>
        <span className="w-12 text-right">基差</span>
        <span className="w-[3.25rem] text-right">基差率</span>
      </div>
      {list.map((r) => {
        const q = quotes[r.cashCode];
        const cash = q?.price != null ? q.price * r.cashMult : null;
        const basis = cash != null && cash !== 0 ? cash - r.near.px : null;
        const rate = cash != null && cash !== 0 && basis != null ? (basis / cash) * 100 : null;
        const key = `idx:${r.id}`;
        const active = pick?.key === key;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick({
              kind: "idx",
              key,
              label: r.label,
              left: r.near.code,
              right: r.cashCode,
              leftUnd: r.und,
              cashCode: r.cashCode,
              cashMult: r.cashMult,
            })}
            className={cn(
              "flex w-full items-center gap-2 px-1.5 py-0.5 text-left text-[12px] hover:bg-white/[0.04]",
              active && "bg-primary/10",
            )}
          >
            <span className="w-[7.25rem] shrink-0 truncate text-slate-200">{r.label}</span>
            <span className="w-12 shrink-0 text-right font-mono tabular-nums text-slate-200">
              {fmtPx(r.near.px)}
            </span>
            <span className="w-12 shrink-0 text-right font-mono tabular-nums text-slate-300">
              {fmtPx(cash)}
            </span>
            <span className={cn("w-12 shrink-0 text-right font-mono tabular-nums", chgClass(basis))}>
              {signed(basis)}
            </span>
            <span className={cn("w-[3.25rem] shrink-0 text-right font-mono tabular-nums", chgClass(rate))}>
              {rate == null ? "-" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SpotTableView({
  data, error, chem,
}: {
  data: SpotTable | null;
  error: string | null;
  chem: ChemSpot | null;
}) {
  if (!data) return <CellEmpty text={error ? "未取到" : "更新中…"} />;
  return (
    <div className="p-1">
      {chem && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 px-1 py-0.5 text-[11px]">
          <span className="text-slate-200">{chem.name}</span>
          <span className="font-mono tabular-nums text-slate-300">{chem.price}</span>
          <span className="text-[9px] text-slate-600">{chem.date}</span>
          <span className="text-[9px] text-slate-600">{chem.quotes} 报价</span>
          {chem.history?.length > 0 && (
            <span className="text-[9px] text-slate-600">
              {chem.history.slice(-5).map((h) => h.p).join(" / ")}
            </span>
          )}
        </div>
      )}
      <p className="px-1 pb-1 text-[9px] text-slate-600">
        生意社 {data.date} · 现货/期货/基差 · 只客观呈现
      </p>
      <div className="grid grid-cols-[5.5rem_3.25rem_3.25rem_3rem] gap-x-2 px-1.5 text-[11px] text-slate-600">
        <span>品种</span>
        <span className="text-right">现货</span>
        <span className="text-right">期货</span>
        <span className="text-right">基差</span>
      </div>
      {data.rows.map((r) => (
        <div
          key={`${r.exchange}-${r.name}-${r.contract}`}
          className="grid grid-cols-[5.5rem_3.25rem_3.25rem_3rem] gap-x-2 px-1.5 py-0.5 text-[12px]"
        >
          <span className="truncate text-slate-200" title={r.exchange}>{r.name}</span>
          <span className="text-right font-mono tabular-nums text-slate-300">{fmtPx(r.spot)}</span>
          <span className="text-right font-mono tabular-nums text-slate-300">{fmtPx(r.futures)}</span>
          <span className={cn("text-right font-mono tabular-nums", chgClass(r.basis))}>{signed(r.basis)}</span>
        </div>
      ))}
    </div>
  );
}
