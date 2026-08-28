import { api, type ArbLeg, type OvlabWarehouseReceipt } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { NO_RECEIPT } from "@/config/arb";
import { CellEmpty } from "@/components/deriv/derivShared";
import { chgClass, fmtOi, fmtPx, signed, type ArbPick } from "./arbShared";
import { cn } from "@/lib/utils";
import { useQuotes } from "@/lib/quoteHub";

function noWh(und: string): boolean {
  return NO_RECEIPT.has(und.toUpperCase()) || /^\d+$/.test(und);
}

function LegBlock({ title, leg }: { title: string; leg: ArbLeg | null }) {
  if (!leg) return null;
  const chg = leg.pxYd && leg.pxYd !== 0 ? ((leg.px - leg.pxYd) / leg.pxYd) * 100 : null;
  return (
    <div className="rounded border border-slate-800/80 px-2 py-1.5">
      <div className="text-[10px] text-slate-500">{title}</div>
      <div className="truncate font-mono text-[12px] text-slate-200">{leg.code}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[13px] tabular-nums text-slate-100">{fmtPx(leg.px)}</span>
        <span className={cn("font-mono text-[11px] tabular-nums", chgClass(chg))}>
          {chg == null ? "-" : `${chg > 0 ? "+" : ""}${chg.toFixed(2)}%`}
        </span>
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
        <span>仓 {fmtOi(leg.oi)}</span>
        <span>剩 {Math.round(leg.dte)}d</span>
      </div>
    </div>
  );
}

function ReceiptLine({ und }: { und: string }) {
  const skip = noWh(und);
  const poll = usePolling(
    () => api.ovlabWarehouseReceipt(und),
    300_000,
    [und],
    Boolean(und) && !skip,
  );
  if (skip) {
    return <div className="px-2 text-[10px] text-slate-600">{und} 无仓单</div>;
  }
  const wr = String(poll.data?.product ?? "").toUpperCase() === und.toUpperCase()
    ? poll.data
    : null;
  if (!wr && !poll.error) return <div className="px-2 text-[10px] text-slate-600">{und} 仓单更新中…</div>;
  return <ReceiptBody und={und} wr={wr} />;
}

function ReceiptBody({ und, wr }: { und: string; wr: OvlabWarehouseReceipt | null }) {
  if (!wr || wr.last == null) {
    return <div className="px-2 text-[10px] text-slate-600">{und} 无仓单</div>;
  }
  return (
    <div className="px-2 py-1 text-[11px]">
      <div className="flex items-baseline justify-between">
        <span className="text-slate-400">{und} 仓单</span>
        <span className="font-mono tabular-nums text-slate-200">{fmtPx(wr.last, 0)}</span>
      </div>
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>{wr.asOf ?? ""}</span>
        <span className={cn("font-mono", chgClass(wr.chg ?? null))}>{signed(wr.chg ?? null, 0)}</span>
      </div>
    </div>
  );
}

export function LegCard({
  pick, near, next, a, b,
}: {
  pick: ArbPick | null;
  near?: ArbLeg;
  next?: ArbLeg;
  a?: ArbLeg;
  b?: ArbLeg;
}) {
  const cashCodes = pick?.kind === "idx" ? [pick.cashCode] : [];
  const quotes = useQuotes(cashCodes);
  if (!pick) return <CellEmpty text="点上排一对" />;

  if (pick.kind === "cal") {
    return (
      <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1">
        <LegBlock title="近月" leg={near ?? null} />
        <LegBlock title="次月" leg={next ?? null} />
        <div className="font-mono text-center text-[12px] text-slate-300">
          价差 {near && next ? signed(near.px - next.px) : "-"}
        </div>
        <ReceiptLine und={pick.leftUnd} />
      </div>
    );
  }
  if (pick.kind === "cross") {
    return (
      <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1">
        <LegBlock title={pick.label.split("-")[0] || "A"} leg={a ?? null} />
        <LegBlock title="B" leg={b ?? null} />
        <div className="font-mono text-center text-[12px] text-slate-300">
          价差 {a && b ? signed(a.px - b.px) : "-"}
        </div>
        <ReceiptLine und={pick.leftUnd} />
        {pick.rightUnd !== pick.leftUnd ? <ReceiptLine und={pick.rightUnd} /> : null}
      </div>
    );
  }
  const q = quotes[pick.cashCode];
  const cash = q?.price != null ? q.price * pick.cashMult : null;
  const basis = cash != null ? cash - (near?.px ?? 0) : null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1">
      <LegBlock title="期货近月" leg={near ?? null} />
      <div className="rounded border border-slate-800/80 px-2 py-1.5">
        <div className="text-[10px] text-slate-500">现货 · {pick.cashCode}</div>
        <div className="font-mono text-[13px] tabular-nums text-slate-100">{fmtPx(cash)}</div>
        <div className={cn("mt-0.5 font-mono text-[11px]", chgClass(q?.pct ?? null))}>
          {q?.pct == null ? "-" : `${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%`}
        </div>
      </div>
      <div className="font-mono text-center text-[12px] text-slate-300">
        基差 {signed(basis)}
      </div>
      <div className="px-2 text-[10px] text-slate-600">股指/ETF 无仓单</div>
    </div>
  );
}
