import { normalizeMarketSymbol } from "./marketSymbol.ts";

export interface ImportDraft {
  source_file: string;
  fields: Record<string, unknown>;
  uncertain: string[];
  missing_required: string[];
}
export interface ImportResult { batch: string; kind: string; drafts: ImportDraft[]; warnings: string[] }
export interface PositionValues { symbol: string; shares: string; cost: string }

/** Fill only explicitly reviewed values; missing values never become zero. */
export function positionValues(fields: Record<string, unknown>): PositionValues {
  const symbol = normalizeMarketSymbol(fields.symbol);
  if (!symbol || typeof fields.shares !== "number" || !Number.isFinite(fields.shares) || fields.shares <= 0
      || typeof fields.cost !== "number" || !Number.isFinite(fields.cost)) {
    throw new Error("代码、数量或成本缺失／无效，请核对原文件后手动填写。");
  }
  return { symbol, shares: String(fields.shares), cost: String(fields.cost) };
}

export async function encodeImportFiles(files: readonly File[], signal: AbortSignal) {
  if (!files.length || files.length > 10) throw new Error("每次请选择 1–10 个文件。");
  if (files.some(f => !/\.(png|jpe?g|webp|gif|txt|md|csv|tsv|json)$/i.test(f.name))) {
    throw new Error("支持截图、CSV、TSV、TXT、Markdown、JSON；请先把 Excel 导出为 CSV。");
  }
  if (files.some(f => f.size === 0 || f.size > 8 * 1024 * 1024) || files.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024) {
    throw new Error("文件不能为空，单份最多 8 MB，整批最多 20 MB。");
  }
  const result: { name: string; content_base64: string }[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    result.push({ name: file.name, content_base64: btoa(binary) });
  }
  return result;
}
