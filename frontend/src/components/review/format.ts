/** Shared A-share review formatting (red up / green down). */

export const pctColor = (p: number) =>
  p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground";

export const bgChg = (p: number) =>
  p > 0 ? "bg-[#ff4d4f]/20 text-[#ff4d4f]" : p < 0 ? "bg-[#00d26a]/20 text-[#00d26a]" : "bg-[#333] text-[#888]";

export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 10000) return v.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  if (v >= 100) return v.toFixed(2);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export const pctTone = (p: number) =>
  (p > 0 ? "up" : p < 0 ? "down" : "flat") as "up" | "down" | "flat";

export const fmt = (v: number) =>
  v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

/** Yuan -> yi (亿). */
export const yi = (v: number | null) =>
  v == null ? "—" : `${fmt(v / 1e8)} 亿`;

/** Yuan compact: 亿 / 万 / raw. */
export function fmtAmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}万`;
  return `${sign}${abs.toFixed(0)}`;
}

/** Yuan -> integer 亿/万 (index turnover, e.g. 9904亿). */
export function fmtAmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(0)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}万`;
  return `${sign}${abs.toFixed(0)}`;
}
