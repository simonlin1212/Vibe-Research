/** PE percentile provenance is a financial disclosure, not a Core numeric rule. */
import { loadCalcs, loadFetch, mergeEvidence, type CalcRecord, type EvidenceItem } from "../merge.ts";

function sourceLabel(items: EvidenceItem[]): string {
  if (!items.length) return "未核实";
  return [...new Set(items.map(e => /^[a-zA-Z0-9._-]{1,64}$/.test(e.source) ? e.source : "未核实"))].sort().join(" / ");
}

export function peDisclosureLines(evidence: Iterable<EvidenceItem>, calcs: Iterable<CalcRecord>): string[] {
  const byId = new Map([...evidence].map(e => [e.id, e]));
  const lines: string[] = [];
  for (const c of calcs) {
    // Disk records are not schema-validated yet. The production validator owns
    // their errors; this additional disclosure must not interrupt that repair path.
    if (c?.function !== "percentile_rank" || c.output?.status !== "ok" || !/^calc-[a-f0-9]{16}$/.test(c.calculation_id ?? "")) continue;
    const refs = (Array.isArray(c.inputs_refs) ? c.inputs_refs : []).filter(r => r?.ref_type === "evidence").flatMap(r => byId.get(r.ref_id) ? [byId.get(r.ref_id)!] : []);
    const spec = c.inputs?.history as { history_csv?: { column?: unknown; raw_ref?: unknown } } | undefined;
    if (!refs.some(e => ["pe_ttm", "pe_ttm_latest", "pe_ttm_traded_history_points"].includes(e.field)) && spec?.history_csv?.column !== "peTTM") continue;
    const current = refs.filter(e => (e.field === "pe_ttm" || e.field === "pe_ttm_latest") && e.value === c.inputs?.current);
    const history = refs.filter(e => e.field === "pe_ttm_traded_history_points" && e.raw_ref === spec?.history_csv?.raw_ref);
    lines.push(`> PE 分位口径：当前值来源 ${sourceLabel(current)}；历史序列来源 ${sourceLabel(history)}；跨来源或不同财务口径的分位仅供对照，不代表同源精确比较。[${c.calculation_id}]`);
  }
  return [...new Set(lines)].sort();
}

/** Fixed prelude immediately after the H1, before model-written body can hide it in Markdown/HTML. */
export function peDisclosureErrors(report: string, required: readonly string[]): string[] {
  if (!required.length) return [];
  const lines = report.replace(/\r\n/g, "\n").split("\n");
  if (/^# [^<>]+$/.test(lines[0] ?? "") && lines[1] === "" && required.every((line, i) => lines[i + 2] === line)
      && lines[required.length + 2] === "") return [];
  return [`PE 分位来源披露缺失或不在报告开头：首行标题之后空一行，逐字放入下列可见引用块，再空一行写正文。\n${required.join("\n")}`];
}

export function peDisclosurePrompt(runDir: string): string {
  const lines = peDisclosureLines(mergeEvidence(loadFetch(runDir)).evidence, loadCalcs(runDir).flatMap(c => c.record ? [c.record] : []));
  return lines.length ? `【强制 PE 分位口径披露】报告首行标题之后空一行，逐字放入以下引用块，再空一行继续正文。所引 calc id 也列入阶段 calculation_ids。不得藏到注释、代码块或末尾。\n${lines.join("\n")}` : "";
}
