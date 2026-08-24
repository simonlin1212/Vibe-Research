import { useMemo } from "react";
import { useFin } from "@/components/fin/FinContext";
import { fmtYiYuan, TNUM } from "@/components/fin/utils";
import { pctColor } from "@/components/review/format";
import { cn } from "@/lib/utils";

export function FinStockRankPanel() {
  const { select, company, board: data, boardError: error, stockTab: tab } = useFin();

  const rows = useMemo(() => {
    const stocks = data?.stocks ?? [];
    if (tab === "profit") return stocks.slice(0, 20);
    const profit = stocks.filter((s) => s.net_profit > 0).sort((a, b) => b.profit_yoy - a.profit_yoy);
    const loss = stocks.filter((s) => s.net_profit <= 0);
    return [...profit, ...loss].slice(0, 20);
  }, [data, tab]);

  const maxV = Math.max(...rows.map((s) => (tab === "profit" ? s.net_profit : Math.max(s.profit_yoy, 0))), 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
        {!data && <p className="py-6 text-center text-[11px] text-slate-600">{error ? "盈利榜未接通" : "加载中…"}</p>}
        {data && rows.length === 0 && <p className="py-8 text-center text-[11px] text-slate-600">当前非财报密集披露期</p>}
        {rows.map((s, i) => {
          const barV = tab === "profit" ? Math.max(s.net_profit, 0) : Math.max(s.profit_yoy, 0);
          return (
            <button
              key={s.code}
              type="button"
              onClick={() => select(s.code, s.name)}
              className={cn(
                "relative grid w-full grid-cols-[18px_1fr_56px_48px_40px] items-center gap-1 rounded px-1 py-0.5 text-left",
                company.code === s.code ? "ring-1 ring-primary/40" : "hover:bg-slate-800/40",
              )}
            >
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-rose-400/10"
                style={{ width: `${(barV / maxV) * 100}%` }}
              />
              <span className="relative font-mono text-[10px] text-slate-600">{i + 1}</span>
              <span className="relative truncate text-[12px] text-slate-200">{s.name}</span>
              <span className="relative text-right font-mono text-[11px] text-slate-300" style={TNUM}>
                {fmtYiYuan(s.net_profit)}
              </span>
              <span className={cn("relative text-right font-mono text-[10px]", pctColor(s.profit_yoy))} style={TNUM}>
                {s.profit_yoy > 0 ? "+" : ""}{s.profit_yoy.toFixed(1)}%
              </span>
              <span className="relative text-right font-mono text-[10px] text-slate-500" style={TNUM}>
                {s.roe.toFixed(1)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
