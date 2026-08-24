import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymdOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toClockMin(t) {
  const colon = (t || "").match(/(\d{1,2}):(\d{2})/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  return NaN;
}
function hmOf(t) {
  const m = toClockMin(t);
  if (!Number.isFinite(m)) return "";
  return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
}
function minuteKey(t) {
  const s = (t || "").replace("T", " ").trim();
  if (s.length >= 16 && /^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 16);
  return hmOf(t);
}
function isNightTime(t) {
  const h = Math.floor(toClockMin(t) / 60);
  return Number.isFinite(h) && (h >= 20 || h < 6);
}
function nightDateOf(td) {
  const dt = new Date(`${td}T12:00:00`);
  dt.setDate(dt.getDate() - 1);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() - 1);
  return ymdOf(dt);
}
function expandIncl(date, start, endIncl) {
  const out = [];
  for (let t = start; t <= endIncl; t++) {
    out.push(`${date} ${pad2(Math.floor(t / 60) % 24)}:${pad2(t % 60)}:00`);
  }
  return out;
}
function derivMinuteSlots(td, kind) {
  if (kind === "etf") {
    return [...expandIncl(td, 9 * 60 + 30, 11 * 60 + 30), ...expandIncl(td, 13 * 60, 15 * 60)];
  }
  if (kind === "cmdDay") {
    return [
      ...expandIncl(td, 9 * 60, 10 * 60 + 15),
      ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
      ...expandIncl(td, 13 * 60 + 30, 15 * 60),
    ];
  }
  const night = nightDateOf(td);
  if (kind === "cmd23") {
    return [
      ...expandIncl(night, 21 * 60, 23 * 60),
      ...expandIncl(td, 9 * 60, 10 * 60 + 15),
      ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
      ...expandIncl(td, 13 * 60 + 30, 15 * 60),
    ];
  }
  return [
    ...expandIncl(night, 21 * 60, 23 * 60 + 59),
    ...expandIncl(td, 0, 2 * 60 + 30),
    ...expandIncl(td, 9 * 60, 10 * 60 + 15),
    ...expandIncl(td, 10 * 60 + 30, 11 * 60 + 30),
    ...expandIncl(td, 13 * 60 + 30, 15 * 60),
  ];
}
function padToSlots(items, slots, timeOf) {
  const byKey = new Map();
  const byHm = new Map();
  for (const it of items) {
    const t = timeOf(it);
    byKey.set(minuteKey(t), it);
    const hm = hmOf(t);
    if (hm) byHm.set(hm, it);
  }
  return slots.map((s) => byKey.get(minuteKey(s)) ?? byHm.get(hmOf(s)) ?? null);
}
function hasOvernightPrint(times) {
  return times.some((t) => {
    const m = toClockMin(t);
    return Number.isFinite(m) && m < 6 * 60;
  });
}
function cmdNightKind(times) {
  return hasOvernightPrint(times) ? "cmd" : "cmd23";
}
function kindOfUnd(und, times) {
  const u = String(und || "").trim().toUpperCase();
  const root = /^\d{6}/.test(u) ? u.slice(0, 6) : (u.match(/^([A-Z]+)/) || ["", ""])[1];
  if (/^85[01]\d{3}$/.test(root)) return times.some(isNightTime) ? cmdNightKind(times) : "cmdDay";
  if (/^\d{6}$/.test(root)) return "etf";
  if (["IF", "IH", "IM", "IO", "HO", "MO"].includes(root)) return "etf";
  return cmdNightKind(times);
}
function derivSessionIdx(t, kind) {
  const m = toClockMin(t);
  if (kind === "etf") {
    let e = m - (9 * 60 + 30);
    if (m >= 13 * 60) e -= 90;
    return Math.max(0, Math.min(e, 240));
  }
  if (kind === "cmdDay") {
    if (m < 9 * 60) return 0;
    if (m <= 10 * 60 + 15) return m - 9 * 60;
    if (m < 10 * 60 + 30) return 75;
    if (m <= 11 * 60 + 30) return 75 + (m - 10 * 60 - 30);
    if (m < 13 * 60 + 30) return 135;
    return Math.min(135 + (m - 13 * 60 - 30), 225);
  }
  return NaN;
}

test("ETF 开盘几分钟停在轴左侧, 不铺满", () => {
  const slots = derivMinuteSlots("2026-08-18", "etf");
  const padded = padToSlots(
    [{ t: "2026-08-18 09:31:00", close: 1 }, { t: "2026-08-18 09:32:00", close: 2 }],
    slots,
    (b) => b.t,
  );
  let last = -1;
  padded.forEach((b, i) => { if (b) last = i; });
  assert.ok(slots.length >= 240);
  assert.ok(last >= 0 && last / slots.length < 0.03);
  assert.equal(padded.filter(Boolean).length, 2);
});

test("商品日盘 09:01 停在左侧", () => {
  const slots = derivMinuteSlots("2026-08-18", "cmdDay");
  const padded = padToSlots([{ t: "2026-08-18 09:01:00", close: 1 }], slots, (b) => b.t);
  const i = padded.findIndex((b) => b);
  assert.ok(i >= 0 && i / slots.length < 0.02);
});

test("夜盘 21:01 停在左侧, 周五夜归周一槽", () => {
  assert.equal(nightDateOf("2026-08-17"), "2026-08-14");
  const slots = derivMinuteSlots("2026-08-17", "cmd");
  const padded = padToSlots([{ t: "2026-08-14 21:01:00", close: 1 }], slots, (b) => b.t);
  const i = padded.findIndex((b) => b);
  assert.ok(i >= 0 && i / slots.length < 0.02);
});

test("kindOfUnd: ETF / 股指日盘 / 商品夜盘", () => {
  assert.equal(kindOfUnd("510050", ["09:31"]), "etf");
  assert.equal(kindOfUnd("IF", ["09:31"]), "etf");
  assert.equal(kindOfUnd("IF", ["21:05", "09:31"]), "etf");
  assert.equal(kindOfUnd("IM", ["21:05"]), "etf");
  assert.equal(kindOfUnd("MO2609C7200", ["21:05"]), "etf");
  assert.equal(kindOfUnd("AU", ["09:01"]), "cmd23");
  assert.equal(kindOfUnd("AU2609C952", ["21:05"]), "cmd23");
  assert.equal(kindOfUnd("AU2609", ["21:05", "01:10"]), "cmd");
  assert.equal(kindOfUnd("EG2610", ["09:01", "15:00"]), "cmd23");
  assert.equal(kindOfUnd("EG2610", ["21:05", "22:59", "09:01"]), "cmd23");
  assert.equal(kindOfUnd("850001", ["09:01"]), "cmdDay");
  assert.equal(kindOfUnd("850001", ["21:05"]), "cmd23");
});

test("spark idx: 早盘远小于收盘", () => {
  assert.ok(derivSessionIdx("09:31", "etf") < 15);
  assert.equal(derivSessionIdx("15:00", "etf"), 240);
  assert.ok(derivSessionIdx("09:01", "cmdDay") < 10);
  assert.equal(derivSessionIdx("15:00", "cmdDay"), 225);
});

test("悬停空槽不回落最后一笔", () => {
  function lastFiniteIdx(vals, hover) {
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
  const vals = [1, 2, null, null];
  assert.equal(lastFiniteIdx(vals, null), 1);
  assert.equal(lastFiniteIdx(vals, 1), 1);
  assert.equal(lastFiniteIdx(vals, 3), null);
});

test("分时图走交易时段轴, 不按点序均分", async () => {
  const card = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  const spark = await readFile(new URL("../src/components/ovlab/shared.tsx", import.meta.url), "utf8");
  const axis = await readFile(new URL("../src/lib/derivMinuteAxis.ts", import.meta.url), "utf8");
  assert.match(card, /concatDaySlots/);
  assert.match(card, /padToSlots/);
  assert.match(spark, /derivSessionIdx/);
  assert.match(axis, /export function derivMinuteSlots/);
  assert.match(axis, /export function concatDaySlots/);
  assert.match(axis, /export function liveAxisKind/);
  assert.match(axis, /export function isDaySessionUnd/);
  assert.match(axis, /export function frameTradingDays/);
  assert.match(axis, /周一 history 常缺周五夜/);
  assert.match(axis, /85\[01\]/, "850 商品指数走商品时段不是 ETF");
  assert.match(axis, /empty hover stays null/);
  assert.match(card, /hover != null && i == null/);
  assert.doesNotMatch(spark, /i \/ \(n - 1\)\) \* innerW/);
});

test("concatDaySlots 两日中间空档, 一日无空档", () => {
  function concatDaySlots(tds, kind) {
    if (tds.length === 0) return { cats: [], splitAt: null };
    if (tds.length === 1) return { cats: derivMinuteSlots(tds[0], kind), splitAt: null };
    const cats = [];
    let splitAt = null;
    tds.forEach((td, i) => {
      if (i > 0) {
        splitAt = cats.length;
        cats.push("");
      }
      cats.push(...derivMinuteSlots(td, kind));
    });
    return { cats, splitAt };
  }
  const one = concatDaySlots(["2026-08-18"], "etf");
  assert.equal(one.splitAt, null);
  assert.ok(one.cats.length > 200);
  assert.ok(one.cats.every((c) => c));
  const two = concatDaySlots(["2026-08-17", "2026-08-18"], "etf");
  assert.equal(two.cats[two.splitAt], "");
  assert.equal(two.cats.filter((c) => c === "").length, 1);
  assert.ok(two.cats[0].startsWith("2026-08-17"));
  assert.ok(two.cats[two.splitAt + 1].startsWith("2026-08-18"));
});

function tradingDayOf(t) {
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
function tradingDaysOf(times) {
  return [...new Set(times.map(tradingDayOf).filter(Boolean))].sort();
}
function undRootOf(sym) {
  const s = (sym || "").trim().toUpperCase();
  if (/^\d{6}/.test(s)) return s.slice(0, 6);
  const m = s.match(/^([A-Z]+)/);
  return m ? m[1] : s;
}
function isDaySessionUnd(und) {
  const u = undRootOf(und);
  if (/^85[01]\d{3}$/.test(u)) return false;
  return /^\d{6}$/.test(u) || ["IF", "IH", "IM", "IO", "HO", "MO"].includes(u);
}
function liveAxisKind(und, times, now) {
  const base = kindOfUnd(und, times);
  const stamp = `${ymdOf(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:00`;
  if (isDaySessionUnd(und) || !isNightTime(stamp)) return base;
  return cmdNightKind(times);
}
function derivLiveNow(now) {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 150) return day >= 2 && day <= 6;
  if (day === 0 || day === 6) return false;
  return (mins >= 540 && mins < 690) || (mins >= 810 && mins < 900) || mins >= 1260;
}
function frameTradingDays(times, days, now, und) {
  let tds = tradingDaysOf(times).slice(-(days === 2 ? 2 : 1));
  const stamp = `${ymdOf(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:00`;
  if (isDaySessionUnd(und) && isNightTime(stamp)) return tds;
  const nowTd = tradingDayOf(stamp);
  if (derivLiveNow(now) && nowTd && tds[tds.length - 1] !== nowTd) {
    tds = days === 2 && tds.length ? [...tds.slice(-1), nowTd] : [nowTd];
  }
  return tds;
}

test("日盘股指从 09:30 贴左, 商品有夜盘从 21:00 贴左", () => {
  const now = new Date(2026, 7, 20, 11, 10, 0);
  assert.equal(liveAxisKind("IF2608", ["2026-08-19 21:05:00", "2026-08-20 09:31:00"], now), "etf");
  assert.equal(liveAxisKind("AG2609", ["2026-08-19 21:05:00", "2026-08-20 01:10:00"], now), "cmd");
  assert.equal(liveAxisKind("EG2610", ["2026-08-19 21:05:00", "2026-08-20 09:01:00"], now), "cmd23");
  const ifSlots = derivMinuteSlots("2026-08-20", "etf");
  assert.equal(ifSlots[0].slice(11, 16), "09:30");
  const agSlots = derivMinuteSlots("2026-08-20", "cmd");
  assert.equal(agSlots[0].slice(11, 16), "21:00");
});

test("EG 23:00 收盘接到 09:00, 不铺 23:00-02:30 真空", () => {
  const slots = derivMinuteSlots("2026-08-20", "cmd23");
  const hms = slots.map((s) => s.slice(11, 16));
  assert.equal(hms[0], "21:00");
  const i23 = hms.lastIndexOf("23:00");
  assert.ok(i23 >= 0);
  assert.equal(hms[i23 + 1], "09:00");
  assert.ok(!hms.includes("00:00"));
  assert.ok(!hms.includes("02:30"));
});

test("EG 周一只有日盘点也从 21:00 贴左", () => {
  const now = new Date(2026, 7, 24, 16, 10, 0);
  assert.equal(liveAxisKind("EG2610", ["2026-08-24 09:01:00", "2026-08-24 15:00:00"], now), "cmd23");
  assert.equal(derivMinuteSlots("2026-08-24", liveAxisKind("EG2610", ["2026-08-24 09:01:00"], now)).at(0)?.slice(11, 16), "21:00");
});

test("夜盘无分钟点也切到当夜交易日轴", () => {
  const now = new Date(2026, 7, 19, 23, 58, 0);
  assert.equal(liveAxisKind("AG2609", ["2026-08-19 09:01:00"], now), "cmd23");
  assert.equal(liveAxisKind("IF2609", ["2026-08-19 09:31:00"], now), "etf");
  assert.equal(liveAxisKind("IM2609", ["2026-08-19 09:31:00"], now), "etf");
  assert.equal(liveAxisKind("510050", ["2026-08-19 09:31:00"], now), "etf");
  assert.deepEqual(
    frameTradingDays(["2026-08-19 09:01:00", "2026-08-19 15:00:00"], 1, now),
    ["2026-08-20"],
  );
  assert.deepEqual(
    frameTradingDays(["2026-08-19 09:31:00", "2026-08-19 15:00:00"], 1, now, "IM2609"),
    ["2026-08-19"],
  );
});
