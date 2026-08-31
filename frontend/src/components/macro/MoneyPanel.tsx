import type { MacroBoard } from "@/lib/api";

function fmtRate(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function MoneyPanel({ data, err }: { data: MacroBoard | null; err: string | null }) {
  const items = data?.money?.items ?? [];
  if (err && !items.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!items.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((it) => (
          <div key={it.key} className="rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5">
            <p className="text-[10px] text-slate-500">{it.name}</p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{fmtRate(it.value)}</p>
            {it.label ? <p className="mt-0.5 text-[10px] leading-tight text-slate-600">{it.label}</p> : null}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-600">
        {data?.money?.date || "—"} · 中国货币网公开报价 · DR007 取银银间 7 天定盘 FDR007 · 只呈现
      </p>
    </div>
  );
}
