import type { MacroBoard, MacroBoardItem } from "@/lib/api";

function fmtCell(it: MacroBoardItem): string {
  if (it.value == null || !Number.isFinite(it.value)) return "—";
  if (it.unit === "亿") {
    return `${it.value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 亿`;
  }
  if (it.unit === "%") {
    const sign = it.kind === "yoy" && it.value > 0 ? "+" : "";
    return `${sign}${it.value.toFixed(1)}%`;
  }
  return it.value.toFixed(1);
}

export function MonthPanel({ data, err }: { data: MacroBoard | null; err: string | null }) {
  const items = data?.month?.items ?? [];
  if (err && !items.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!items.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-500">
            <th className="pb-1.5 font-medium">指标</th>
            <th className="pb-1.5 font-medium">期</th>
            <th className="pb-1.5 text-right font-medium">值</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.key} className="border-t border-slate-800/80">
              <td className="py-1.5 text-slate-300">{it.name}</td>
              <td className="py-1.5 text-slate-500">{it.period || it.date || "—"}</td>
              <td className="py-1.5 text-right font-mono tabular-nums text-slate-200">{fmtCell(it)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-slate-600">CPI/PPI/PMI/M2 东财 · 社融商务部 · 同比或当月增量 · 只呈现</p>
    </div>
  );
}
