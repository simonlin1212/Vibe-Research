import type { NbsPmi, PbocSfinRow } from "@/lib/api";

function yi(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function pmi(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

const SFIN_COLS: { key: keyof PbocSfinRow; label: string }[] = [
  { key: "afre_total", label: "社融" },
  { key: "rmb_loans", label: "人民币贷款" },
  { key: "government_bonds", label: "政府债" },
  { key: "corporate_bonds", label: "企业债" },
  { key: "equity_financing", label: "股票融资" },
];

export function PbocSfinPanel({ data, err }: { data: PbocSfinRow[] | null; err: string | null }) {
  const rows = data ?? [];
  if (err && !rows.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!rows.length) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-500">
            <th className="pb-1.5 font-medium">月</th>
            {SFIN_COLS.map((c) => (
              <th key={c.key} className="pb-1.5 text-right font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-t border-slate-800/80">
              <td className="py-1.5 font-mono text-slate-400">{r.month}</td>
              {SFIN_COLS.map((c) => (
                <td key={c.key} className="py-1.5 text-right font-mono tabular-nums text-slate-200">
                  {yi(r[c.key] as number | null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-slate-600">亿元 · 人民银行社会融资规模增量统计表 · 2021 年起 · 只呈现</p>
    </div>
  );
}

const PMI_CORE: { key: keyof NbsPmi; name: string }[] = [
  { key: "manufacturing_pmi", name: "制造业" },
  { key: "non_manufacturing_pmi", name: "非制造业" },
  { key: "composite_pmi", name: "综合产出" },
];
const PMI_SIZE: { key: keyof NbsPmi; name: string }[] = [
  { key: "pmi_large", name: "大型" },
  { key: "pmi_medium", name: "中型" },
  { key: "pmi_small", name: "小型" },
];

export function NbsPmiPanel({ data, err }: { data: NbsPmi | null; err: string | null }) {
  if (err && !data) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!data) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">更新中…</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <p className="text-[10px] text-slate-500">{data.period || "—"} · 采购经理指数 · 50 荣枯</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {PMI_CORE.map((it) => (
          <div key={it.key} className="rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5">
            <p className="text-[10px] text-slate-500">{it.name}</p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{pmi(data[it.key] as number | null)}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {PMI_SIZE.map((it) => (
          <div key={it.key} className="rounded border border-slate-700/30 px-2 py-1">
            <p className="text-[10px] text-slate-600">{it.name}</p>
            <p className="font-mono text-[12px] tabular-nums text-slate-300">{pmi(data[it.key] as number | null)}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-600">
        国家统计局公开稿
        {data.source_url ? (
          <a href={data.source_url} target="_blank" rel="noreferrer" className="mx-1 text-slate-400 hover:text-primary">原文</a>
        ) : null}
        · 只呈现、不评分
      </p>
    </div>
  );
}
