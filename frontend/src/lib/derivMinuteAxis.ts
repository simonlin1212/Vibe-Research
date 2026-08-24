/** Futures/option minute axis: X spans the full session, prints stay left at open. */

export type DerivAxisKind = "etf" | "cmd" | "cmd23" | "cmdDay";

const INDEX_ROOTS = new Set(["IF", "IH", "IM", "IO", "HO", "MO"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Clock minutes from a datetime / HH:MM / compact hhmm stamp. */
export function toClockMin(t: string): number {
  const s = (t || "").trim();
  const colon = s.match(/(\d{1,2}):(\d{2})/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const compact = s.match(/(?:^|[\sT])(\d{4})(?:\D|$)/);
  if (compact) {
    const hhmm = compact[1];
    return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  }
  return NaN;
}

export function hmOf(t: string): string {
  const m = toClockMin(t);
  if (!Number.isFinite(m)) return "";
  return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
}

/** YYYY-MM-DD HH:MM, used to join bars onto session slots. */
export function minuteKey(t: string): string {
  const s = (t || "").replace("T", " ").trim();
  if (s.length >= 16 && /^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 16);
  return hmOf(t);
}

export function isNightTime(t: string): boolean {
  const h = Math.floor(toClockMin(t) / 60);
  return Number.isFinite(h) && (h >= 20 || h < 6);
}

/** Same calendar as backend _trading_day / OptionChartCard: night rolls to next session. */
export function tradingDayOf(t: string): string {
  const d = t.slice(0, 10);
  const hh = Number(t.slice(11, 13));
  if (hh >= 6 && hh < 20) return d;
  const dt = new Date(`${d}T00:00:00`);
  if (hh < 6) dt.setDate(dt.getDate() - 1);
  do {
    dt.setDate(dt.getDate() + 1);
  } while (dt.getDay() === 0 || dt.getDay() === 6);
  return ymdOf(dt);
}

/** Night session calendar date that belongs to trading day td (Fri night -> Monday). */
export function nightDateOf(td: string): string {
  const dt = new Date(`${td}T12:00:00`);
  dt.setDate(dt.getDate() - 1);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() - 1);
  return ymdOf(dt);
}

/** Underlying root from a contract / option code (AU2609C952 -> AU, 510050 -> 510050). */
export function undRootOf(sym: string): string {
  const s = (sym || "").trim().toUpperCase();
  if (/^\d{6}/.test(s)) return s.slice(0, 6);
  const m = s.match(/^([A-Z]+)/);
  return m ? m[1] : s;
}

/** 00:00-05:59 prints mean the night session runs past 23:00 (AU), not EG-style 23:00 close. */
export function hasOvernightPrint(times: string[]): boolean {
  return times.some((t) => {
    const m = toClockMin(t);
    return Number.isFinite(m) && m < 6 * 60;
  });
}

function cmdNightKind(times: string[]): DerivAxisKind {
  return hasOvernightPrint(times) ? "cmd" : "cmd23";
}

/** CFFEX equity index / ETF options: day auction only, no 21:00 night. */
export function isDaySessionUnd(und?: string): boolean {
  const u = undRootOf(und || "");
  if (/^85[01]\d{3}$/.test(u)) return false;
  return /^\d{6}$/.test(u) || INDEX_ROOTS.has(u);
}

export function kindOfUnd(und: string | undefined, times: string[]): DerivAxisKind {
  const u = undRootOf(und || "");
  // 同花顺商品指数 850xxx/851xxx: 6 位数字但走商品时段, 不是 ETF
  if (/^85[01]\d{3}$/.test(u)) return times.some(isNightTime) ? cmdNightKind(times) : "cmdDay";
  if (isDaySessionUnd(und)) return "etf";
  // EG/AU 等商品有夜盘. 周一 history 常缺周五夜, 不能因此改走 09:00 日盘轴.
  return cmdNightKind(times);
}

/** Same clock windows as derivShared.derivSession (local, no holiday). */
export function derivLiveNow(now = new Date()): boolean {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 150) return day >= 2 && day <= 6;
  if (day === 0 || day === 6) return false;
  return (mins >= 540 && mins < 690) || (mins >= 810 && mins < 900) || mins >= 1260;
}

function clockStamp(now: Date): string {
  return `${ymdOf(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:00`;
}

/** Night window: commodities use the overnight axis even if history has no print yet. */
export function liveAxisKind(
  und: string | undefined,
  times: string[],
  now = new Date(),
): DerivAxisKind {
  const base = kindOfUnd(und, times);
  // Index/ETF stay 09:30-15:00. Commodity with night keeps last night 21:00 on the left.
  if (isDaySessionUnd(und) || !isNightTime(clockStamp(now))) return base;
  return cmdNightKind(times);
}

/** History days plus the live trading day, so tonight is on the axis before the first print. */
export function frameTradingDays(
  times: string[],
  days: 1 | 2,
  now = new Date(),
  und?: string,
): string[] {
  let tds = tradingDaysOf(times).slice(-(days === 2 ? 2 : 1));
  if (isDaySessionUnd(und) && isNightTime(clockStamp(now))) return tds;
  const nowTd = tradingDayOf(clockStamp(now));
  if (derivLiveNow(now) && nowTd && tds[tds.length - 1] !== nowTd) {
    tds = days === 2 && tds.length ? [...tds.slice(-1), nowTd] : [nowTd];
  }
  return tds;
}

/** start inclusive, end exclusive, minutes from midnight. */
function expand(date: string, start: number, end: number): string[] {
  const out: string[] = [];
  for (let t = start; t < end; t++) {
    out.push(`${date} ${pad2(Math.floor(t / 60) % 24)}:${pad2(t % 60)}:00`);
  }
  return out;
}

function expandIncl(date: string, start: number, endIncl: number): string[] {
  return expand(date, start, endIncl + 1);
}

/** Full-session minute stamps for one trading day. Unprinted slots stay in the axis. */
export function derivMinuteSlots(td: string, kind: DerivAxisKind): string[] {
  if (kind === "etf") {
    return [
      ...expandIncl(td, 9 * 60 + 30, 11 * 60 + 30),
      ...expandIncl(td, 13 * 60, 15 * 60),
    ];
  }
  if (kind === "cmdDay") {
    return [
      ...expandIncl(td, 9 * 60, 10 * 60 + 15),
      ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
      ...expandIncl(td, 13 * 60 + 30, 15 * 60),
    ];
  }
  const night = nightDateOf(td);
  // EG / plastics: 21:00-23:00 then 09:00, no 23:00-02:30 vacuum.
  if (kind === "cmd23") {
    return [
      ...expandIncl(night, 21 * 60, 23 * 60),
      ...expandIncl(td, 9 * 60, 10 * 60 + 15),
      ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
      ...expandIncl(td, 13 * 60 + 30, 15 * 60),
    ];
  }
  return [
    ...expand(night, 21 * 60, 24 * 60),
    ...expandIncl(td, 0, 2 * 60 + 30),
    ...expandIncl(td, 9 * 60, 10 * 60 + 15),
    ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
    ...expandIncl(td, 13 * 60 + 30, 15 * 60),
  ];
}

export function padToSlots<T>(
  items: T[],
  slots: string[],
  timeOf: (x: T) => string,
): Array<T | null> {
  const byKey = new Map<string, T>();
  const byHm = new Map<string, T>();
  for (const it of items) {
    const t = timeOf(it);
    byKey.set(minuteKey(t), it);
    const hm = hmOf(t);
    if (hm) byHm.set(hm, it);
  }
  const tds = new Set(slots.filter(Boolean).map(tradingDayOf));
  const clockOk = tds.size <= 1;
  return slots.map((s) => {
    if (!s) return null;
    return byKey.get(minuteKey(s)) ?? (clockOk ? byHm.get(hmOf(s)) : undefined) ?? null;
  });
}

/** Distinct trading days in time order. */
export function tradingDaysOf(times: string[]): string[] {
  return [...new Set(times.map(tradingDayOf).filter(Boolean))].sort();
}

/** Concatenate session slots for N days. Empty gap so the line does not jump overnight. */
export function concatDaySlots(
  tds: string[],
  kind: DerivAxisKind,
): { cats: string[]; splitAt: number | null } {
  if (tds.length === 0) return { cats: [], splitAt: null };
  if (tds.length === 1) return { cats: derivMinuteSlots(tds[0], kind), splitAt: null };
  const cats: string[] = [];
  let splitAt: number | null = null;
  tds.forEach((td, i) => {
    if (i > 0) {
      splitAt = cats.length;
      cats.push("");
    }
    cats.push(...derivMinuteSlots(td, kind));
  });
  return { cats, splitAt };
}

/** Spark X index. ETF matches A-share 240; commodity skips 10:15-10:30. */
export function derivSessionSpan(kind: DerivAxisKind): number {
  if (kind === "etf") return 240;
  if (kind === "cmdDay") return 225;
  if (kind === "cmd23") return 346;
  return 555;
}

export function derivSessionIdx(t: string, kind: DerivAxisKind): number {
  const m = toClockMin(t);
  if (!Number.isFinite(m)) return NaN;
  if (kind === "etf") {
    const open = 9 * 60 + 30;
    let e = m - open;
    if (m >= 13 * 60) e -= 90;
    return Math.max(0, Math.min(e, 240));
  }
  const day = (clock: number): number => {
    if (clock < 9 * 60) return 0;
    if (clock <= 10 * 60 + 15) return clock - 9 * 60;
    if (clock < 10 * 60 + 30) return 75;
    if (clock <= 11 * 60 + 30) return 75 + (clock - 10 * 60 - 30);
    if (clock < 13 * 60 + 30) return 135;
    if (clock <= 15 * 60) return 135 + (clock - 13 * 60 - 30);
    return 225;
  };
  if (kind === "cmdDay") return Math.max(0, Math.min(day(m), 225));
  if (kind === "cmd23") {
    if (m >= 21 * 60) return Math.max(0, Math.min(m - 21 * 60, 120));
    if (m < 6 * 60) return 120;
    return 121 + day(m);
  }
  if (m >= 21 * 60) return Math.min(m - 21 * 60, 180);
  if (m < 6 * 60) return Math.min(180 + m, 330);
  return 330 + day(m);
}

/** Hovered slot if it has a print; empty hover stays null (do not snap to last print). */
export function lastFiniteIdx(vals: Array<number | null | undefined>, hover: number | null): number | null {
  if (hover != null && hover >= 0 && hover < vals.length) {
    const v = vals[hover];
    return v != null && Number.isFinite(v) ? hover : null;
  }
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v != null && Number.isFinite(v)) return i;
  }
  return null;
}
