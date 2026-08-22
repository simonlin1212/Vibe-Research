import type { OvlabTQuoteExpiry, OvlabTQuoteStrike } from "@/lib/api";
import { num } from "@/components/ovlab/shared";

/** OpenVlab BASE_COLORS.purple / --vlab-purple. */
export const OV_PURPLE = "#a21caf";
/** OpenVlab --vlab-future: 合成标的现价竖线. */
export const OV_FUTURE = "#3861FB";
export const OV_YDAY = "#9e9e9e";
export const OV_MUTED = "#94a3b8";
export const OV_INK = "#e2e8f0";
export const OV_HAIR = "rgba(255,255,255,0.12)";
export const OV_CALL = "#ef4444";
export const OV_PUT = "#22c55e";

export type Xy = [number, number];
export type TermPt = { x: number; y: number; exp: string };

/** OpenVlab isValidVol: drop empty / 100 placeholder / non-positive. */
export function isValidVol(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0 && v !== 100;
}

export function xyPairs(raw: Array<[number, number]> | null | undefined): Xy[] {
  if (!raw?.length) return [];
  const out: Xy[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const x = Number(row[0]);
    const y = Number(row[1]);
    if (!Number.isFinite(x) || !isValidVol(y)) continue;
    out.push([x, y]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Fallback when tquote has no theoSmile (old cache): fitted IV on the ladder. */
export function smileFromStrikes(strikes: OvlabTQuoteStrike[]): { today: Xy[]; yday: Xy[] } {
  const today: Xy[] = [];
  const yday: Xy[] = [];
  for (const s of strikes) {
    const td = num(s.call.theoIv) ?? num(s.put.theoIv);
    const yd = num(s.call.theoIvYd) ?? num(s.put.theoIvYd);
    if (isValidVol(td)) today.push([s.strike, td]);
    if (isValidVol(yd)) yday.push([s.strike, yd]);
  }
  today.sort((a, b) => a[0] - b[0]);
  yday.sort((a, b) => a[0] - b[0]);
  return { today, yday };
}

export function smileSeries(
  smileTd: Array<[number, number]> | null | undefined,
  smileYd: Array<[number, number]> | null | undefined,
  strikes: OvlabTQuoteStrike[] | null | undefined,
): { today: Xy[]; yday: Xy[] } {
  const today = xyPairs(smileTd);
  const yday = xyPairs(smileYd);
  if (today.length || yday.length) return { today, yday };
  return smileFromStrikes(strikes ?? []);
}

/** Y window: vols inside display_strike, pad +-1 (OpenVlab analysis). */
export function smileYRange(today: Xy[], yday: Xy[], lo: number | null, hi: number | null): [number, number] | null {
  const ys: number[] = [];
  for (const [x, y] of [...today, ...yday]) {
    if (lo != null && x < lo) continue;
    if (hi != null && x > hi) continue;
    ys.push(y);
  }
  if (!ys.length) return null;
  return [Math.min(...ys) - 1, Math.max(...ys) + 1];
}

/** X window: display_strike, else data min/max. */
export function smileXRange(today: Xy[], yday: Xy[], lo: number | null, hi: number | null): [number, number] | null {
  if (lo != null && hi != null && hi > lo) return [lo, hi];
  const xs = [...today, ...yday].map((p) => p[0]);
  if (!xs.length) return null;
  return [Math.min(...xs), Math.max(...xs)];
}

export function toLcPts(pts: Xy[]): Array<{ time: number; value: number }> {
  return pts.map(([time, value]) => ({ time, value }));
}

/**
 * Pixel X for synthetic spot.
 * LC timeToCoordinate is null unless that time is already a series point;
 * forward sits between strikes, so map the visible window linearly.
 */
export function smileStemX(
  spot: number | null | undefined,
  from: number | null | undefined,
  to: number | null | undefined,
  width: number,
): number | null {
  if (spot == null || from == null || to == null) return null;
  if (![spot, from, to, width].every(Number.isFinite) || !(to > from) || width < 2) return null;
  const x = ((spot - from) / (to - from)) * width;
  if (x < 0 || x > width) return null;
  return x;
}

/** Crosshair close enough to the synthetic-spot stem (px). */
export function nearSmileStem(
  px: number | null | undefined,
  stemX: number | null | undefined,
  hit = 7,
): boolean {
  return px != null && stemX != null && Number.isFinite(px) && Number.isFinite(stemX)
    && Math.abs(px - stemX) <= hit;
}

/** Pixel box for a true vertical. LC two-point stems slant (two times). */
export function smileStemBox(
  x: number | null | undefined,
  y0: number | null | undefined,
  y1: number | null | undefined,
): { x: number; top: number; h: number } | null {
  if (x == null || y0 == null || y1 == null) return null;
  if (![x, y0, y1].every(Number.isFinite)) return null;
  const h = Math.abs(y1 - y0);
  if (h < 1) return null;
  return { x, top: Math.min(y0, y1), h };
}

export function nearestXy(pts: Xy[], x: number): Xy | null {
  if (!pts.length || !Number.isFinite(x)) return null;
  let best = pts[0];
  let dist = Math.abs(pts[0][0] - x);
  for (const p of pts) {
    const d = Math.abs(p[0] - x);
    if (d < dist) {
      dist = d;
      best = p;
    }
  }
  return best;
}

export function volAt(pts: Xy[], x: number): number | null {
  const hit = pts.find((p) => p[0] === x);
  return hit ? hit[1] : null;
}

export function atmTermPoints(
  expiries: Array<Pick<OvlabTQuoteExpiry, "exp" | "dte" | "atmIv" | "atmIvYd">>,
): { today: TermPt[]; yday: TermPt[] } {
  const today: TermPt[] = [];
  const yday: TermPt[] = [];
  for (const e of expiries) {
    const x = num(e.dte);
    if (x === null) continue;
    const iv = num(e.atmIv);
    if (isValidVol(iv)) today.push({ x, y: iv, exp: e.exp });
    const yd = num(e.atmIvYd);
    if (isValidVol(yd)) yday.push({ x, y: yd, exp: e.exp });
  }
  today.sort((a, b) => a.x - b.x);
  yday.sort((a, b) => a.x - b.x);
  return { today, yday };
}

/** OpenVlab vol-ts: X pad 5% of (max-min) days. */
export function termXRange(today: TermPt[], yday: TermPt[]): [number, number] | null {
  const xs = [...today, ...yday].map((p) => p.x);
  if (!xs.length) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.05, hi === lo ? 1 : 0);
  return [lo - pad, hi + pad];
}

export function nearestTermExp(pts: TermPt[], t: number): string | null {
  if (!pts.length || !Number.isFinite(t)) return null;
  let best = pts[0];
  let dist = Math.abs(pts[0].x - t);
  for (const p of pts) {
    const d = Math.abs(p.x - t);
    if (d < dist) {
      dist = d;
      best = p;
    }
  }
  return best.exp;
}

function fmtStrike(v: number): string {
  if (!Number.isFinite(v)) return "--";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtVol(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "--" : v.toFixed(2);
}

function fmtYyMm(exp: string): string {
  const s = String(exp ?? "");
  return s.length === 6 ? s.slice(2) : s.slice(-4);
}

function fmtDec(v: number | null | undefined, digits: number): string {
  return v == null || !Number.isFinite(v) ? "--" : v.toFixed(digits);
}

function fmtInt(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "--" : String(Math.round(v));
}

/** Trim trailing zeros so 0 -> +0 (OpenVlab formatNumber). */
function fmtIvChg(v: number): string {
  const body = v.toFixed(2).replace(/\.?0+$/, "") || "0";
  return `${v >= 0 ? "+" : ""}${body}`;
}

function chgTone(v: number | null): string {
  if (v == null) return "inherit";
  if (v > 0) return OV_CALL;
  if (v < 0) return OV_PUT;
  return "inherit";
}

function dot(color: string): string {
  return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:3px;"></span>`;
}

function tipWrap(inner: string): string {
  return `<div style="font-size:11px;line-height:1.5">${inner}</div>`;
}

/** OpenVlab analysis tooltip: strike + today/yday theo. Synth spot is its own tip. */
export function smileTipHtml(strike: number, td: number | null, yd: number | null): string {
  return tipWrap(
    `<div style="font-weight:700;border-bottom:1px solid ${OV_HAIR};margin-bottom:4px;padding-bottom:2px;color:${OV_INK}">`
    + `行权价: ${fmtStrike(strike)}</div>`
    + `<div>今日波动率: <span style="color:${OV_PURPLE}">${fmtVol(td)}</span></div>`
    + `<div>昨日波动率: <span style="color:${OV_MUTED}">${fmtVol(yd)}</span></div>`,
  );
}

/** Hover on the synthetic-spot stem only. */
export function synthSpotTipHtml(spot: number): string {
  const px = Number.isFinite(spot) ? spot.toFixed(2) : "--";
  return tipWrap(
    `<div style="color:${OV_INK}">合成标的现价: <span style="color:${OV_FUTURE};font-weight:700">${px}</span></div>`,
  );
}

export type TermTip = {
  exp: string;
  dte: number | null;
  td: number | null;
  yd: number | null;
  callTd: number | null;
  callYd: number | null;
  putTd: number | null;
  putYd: number | null;
};

export function termTipByExp(exps: OvlabTQuoteExpiry[]): Record<string, TermTip> {
  const out: Record<string, TermTip> = {};
  for (const e of exps) {
    out[e.exp] = {
      exp: e.exp,
      dte: num(e.dte),
      td: num(e.atmIv),
      yd: num(e.atmIvYd),
      callTd: num(e.sumOiCall),
      callYd: num(e.sumOiCallYd),
      putTd: num(e.sumOiPut),
      putYd: num(e.sumOiPutYd),
    };
  }
  return out;
}

/** OpenVlab vol-ts ATM tooltip (平值隐波 + 月总持仓). */
export function termTipHtml(tip: TermTip): string {
  const days = tip.dte != null && Number.isFinite(tip.dte)
    ? `<span style="color:${OV_MUTED};font-weight:400;"> · ${Math.round(tip.dte)}天</span>`
    : "";
  const ivChg = tip.td != null && tip.yd != null ? tip.td - tip.yd : null;
  const hasOi = tip.callTd != null && tip.callYd != null && tip.putTd != null && tip.putYd != null;
  const callChg = hasOi ? tip.callTd! - tip.callYd! : null;
  const putChg = hasOi ? tip.putTd! - tip.putYd! : null;
  const pcrTd = hasOi && tip.callTd !== 0 ? tip.putTd! / tip.callTd! : null;
  const pcrYd = hasOi && tip.callYd !== 0 ? tip.putYd! / tip.callYd! : null;
  const pcrChg = pcrTd != null && pcrYd != null ? pcrTd - pcrYd : null;
  const oiRows = hasOi
    ? `<tr>`
      + `<td style="padding-top:5px;padding-bottom:2px;font-weight:600;border-top:1px solid ${OV_HAIR};">月总持仓量</td>`
      + `<td style="text-align:right;padding-right:6px;color:${OV_MUTED};font-size:10px;">今</td>`
      + `<td style="text-align:right;padding-right:6px;color:${OV_MUTED};font-size:10px;">昨</td>`
      + `<td style="text-align:right;color:${OV_MUTED};font-size:10px;">增</td>`
      + `</tr>`
      + `<tr>`
      + `<td>${dot(OV_CALL)}<span style="color:${OV_CALL}">Call</span></td>`
      + `<td style="text-align:right;padding-right:6px;font-weight:600;">${fmtInt(tip.callTd)}</td>`
      + `<td style="text-align:right;padding-right:6px;">${fmtInt(tip.callYd)}</td>`
      + `<td style="text-align:right;color:${chgTone(callChg)}">${callChg != null && callChg >= 0 ? "+" : ""}${fmtInt(callChg)}</td>`
      + `</tr>`
      + `<tr>`
      + `<td>${dot(OV_PUT)}<span style="color:${OV_PUT}">Put</span></td>`
      + `<td style="text-align:right;padding-right:6px;font-weight:600;">${fmtInt(tip.putTd)}</td>`
      + `<td style="text-align:right;padding-right:6px;">${fmtInt(tip.putYd)}</td>`
      + `<td style="text-align:right;color:${chgTone(putChg)}">${putChg != null && putChg >= 0 ? "+" : ""}${fmtInt(putChg)}</td>`
      + `</tr>`
      + `<tr>`
      + `<td style="color:${OV_MUTED}">PCR值</td>`
      + `<td style="text-align:right;padding-right:6px;font-weight:600;">${fmtDec(pcrTd, 2)}</td>`
      + `<td style="text-align:right;padding-right:6px;">${fmtDec(pcrYd, 2)}</td>`
      + `<td style="text-align:right;color:${chgTone(pcrChg)}">${pcrChg == null ? "--" : `${pcrChg >= 0 ? "+" : ""}${pcrChg.toFixed(2)}`}</td>`
      + `</tr>`
    : "";
  return `<div style="min-width:180px;font-size:11px;padding:2px;color:${OV_INK}">`
    + `<div style="font-weight:700;margin-bottom:5px;">${fmtYyMm(tip.exp)} 平值隐波${days}</div>`
    + `<table style="width:100%;border-collapse:collapse;line-height:1.7;">`
    + `<tr><td style="color:${OV_MUTED}">今日波动率</td><td colspan="3" style="text-align:right;font-weight:600">${fmtVol(tip.td)}</td></tr>`
    + `<tr><td style="color:${OV_MUTED}">昨日波动率</td><td colspan="3" style="text-align:right">${fmtVol(tip.yd)}</td></tr>`
    + `<tr><td style="color:${OV_MUTED}">波动率变化</td><td colspan="3" style="text-align:right;font-weight:600;color:${chgTone(ivChg)}">${ivChg == null ? "--" : fmtIvChg(ivChg)}</td></tr>`
    + oiRows
    + `</table></div>`;
}
