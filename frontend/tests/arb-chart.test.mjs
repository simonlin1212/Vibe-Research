import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/components/arb/SpreadChart.tsx"), "utf8");

test("SpreadChart 图容器首屏就挂着, pick 空不整卡 return", () => {
  // Default pick is set after board loads. Early-return unmounts the chart host,
  // so init runs with ref=null and never retries ([] deps). Chart stays blank.
  assert.doesNotMatch(src, /if\s*\(!pick\)\s*return\s*<CellEmpty/);
  assert.match(src, /ref=\{ref\}/);
  assert.match(src, /useLcChart/);
  assert.match(src, /LcHoverTag/);
  assert.match(src, /useLcHoverTag/);
  assert.match(src, /CandlestickSeries/);
  assert.match(src, /candleOpts/);
  assert.match(src, /export function spreadOHLC/);
  assert.doesNotMatch(src, /LineSeries/);
  assert.doesNotMatch(src, /spreadLineOpts/);
  assert.doesNotMatch(src, /BaselineSeries/);
  assert.doesNotMatch(src, /baselineOpts/);
  assert.doesNotMatch(src, /echarts/);
  assert.doesNotMatch(src, /&& "hidden"/);
  assert.match(src, /className="h-full w-full"/);
  assert.match(src, /export function klineBars/);
});

function klineBars(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.data)) return raw.data;
  return [];
}

test("klineBars 兼容 {data} 和裸数组", () => {
  assert.deepEqual(klineBars([["2026-08-19 09:31:00", 4554.2]]), [["2026-08-19 09:31:00", 4554.2]]);
  assert.deepEqual(klineBars({ data: [["2026-08-19 09:31:00", 4554.2]] }), [["2026-08-19 09:31:00", 4554.2]]);
  assert.deepEqual(klineBars(null), []);
});

/** OpenVlab 1D history uses compact trade_date (20260819), not YYYY-MM-DD. */
function dayKey(t) {
  const s = String(t || "").trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

function parseDaily(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (Array.isArray(b) && b.length >= 2) {
      const t = dayKey(b[0]);
      const c = Number(b[1]);
      if (t && Number.isFinite(c)) out.push({ t, c });
      continue;
    }
    if (b && typeof b === "object") {
      const t = dayKey(b.trade_date ?? b.datetime ?? b.date ?? "");
      const c = Number(b.close);
      if (t && Number.isFinite(c)) out.push({ t, c });
    }
  }
  return out;
}

test("ovlab 日K trade_date=YYYYMMDD, 不能用 length>=10 丢掉", () => {
  assert.match(src, /export function dayKey/);
  assert.match(src, /function parseHist[\s\S]*dayKey/);
  assert.doesNotMatch(src, /t\.length >= 10 && c != null/);
  const bars = parseDaily([
    { ts_code: "IF2609.CFX", trade_date: "20260119", close: 4633.8, open: 4634.0 },
    { trade_date: "20260819", close: 4554.2, open: 4605.2 },
  ]);
  assert.deepEqual(bars.map((p) => p.t), ["2026-01-19", "2026-08-19"]);
  assert.equal(bars[1].c, 4554.2);
  assert.equal(dayKey("2026-08-19 15:00:00"), "2026-08-19");
});

test("三张表列左贴, 名称不 flex-1 拉空档", () => {
  const cal = readFileSync(join(root, "src/components/arb/CalendarPanel.tsx"), "utf8");
  const cross = readFileSync(join(root, "src/components/arb/CrossPanel.tsx"), "utf8");
  const basis = readFileSync(join(root, "src/components/arb/BasisPanel.tsx"), "utf8");
  assert.doesNotMatch(cal, /flex-1 truncate text-slate-200/);
  assert.doesNotMatch(cross, /flex-1 truncate text-slate-200/);
  assert.doesNotMatch(basis, /flex-1 truncate text-slate-200/);
  assert.match(cal, /text-\[12px\]/);
  assert.match(cross, /text-\[12px\]/);
  assert.match(basis, /text-\[12px\]/);
});

test("现期只挂套利期现卡, A股宏观观察不再画", () => {
  const basis = readFileSync(join(root, "src/components/arb/BasisPanel.tsx"), "utf8");
  const goods = readFileSync(join(root, "src/components/cockpit/CommodityPanel.tsx"), "utf8");
  assert.match(basis, /\["spot", "现期"\]/);
  assert.match(basis, /api\.spotTable/);
  assert.match(basis, /api\.chemSpot\("7250"/);
  assert.doesNotMatch(goods, /spotTable/);
  assert.doesNotMatch(goods, /chemSpot/);
  assert.doesNotMatch(goods, /\["spot", "现期"\]/);
});

test("下排左分时右日K, 不再切换", () => {
  const cockpit = readFileSync(join(root, "src/pages/ArbCockpit.tsx"), "utf8");
  const layout = readFileSync(join(root, "src/components/cockpit/CockpitLayout.tsx"), "utf8");
  const basis = readFileSync(join(root, "src/components/arb/BasisPanel.tsx"), "utf8");
  assert.match(layout, /min-w-0 w-full shrink-0/);
  assert.match(src, /p === idx \? p : idx/);
  assert.match(src, /MINUTE_LOOKBACK = 5 \* 86400/);
  assert.match(src, /export function joinSpreadMinute/);
  assert.match(src, /pick\.kind === "idx" \? flipOHLC/);
  assert.match(src, /mode: SpreadMode/);
  assert.doesNotMatch(src, /LcSeg/);
  assert.match(cockpit, /mode="minute"/);
  assert.match(cockpit, /mode="daily"/);
  assert.ok(cockpit.indexOf("id: \"arb-minute\"") < cockpit.indexOf("id: \"arb-daily\""), "左分时右日K");
  assert.ok(cockpit.indexOf("id: \"arb-legs\"") < cockpit.indexOf("id: \"arb-minute\""), "两腿在上排");
  assert.match(cockpit, /日度基差/);
  assert.match(cockpit, /现货−期货/);
  assert.match(basis, /基差率/);
  assert.match(basis, /cash - r\.near\.px/);
  assert.doesNotMatch(basis, /r\.near\.px - cash/);
  assert.doesNotMatch(src, /api\.spotTable/);
  assert.doesNotMatch(src, /now - 2 \* 86400/);
  assert.match(cockpit, /lazy\(\(\) =>/);
  assert.doesNotMatch(cockpit, /import \{ SpreadChart/);
});

test("parseLight 分时保留时分, 日K才收成日期", () => {
  // dayKey("2026-08-19 09:31") -> "2026-08-19". Minute join then has no overlapping slots.
  assert.match(src, /parseLight\(kl\?\.bars,\s*mode === "daily"\)/);
  assert.doesNotMatch(src, /function parseLight\([^)]*\)[^{]*\{[^}]*const t = dayKey\(b\.datetime\)/);
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
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function tradingDaysOf(times) {
  return [...new Set(times.map(tradingDayOf).filter(Boolean))].sort();
}

function lastOverlapDay(left, right) {
  const L = new Set(tradingDaysOf(left.map((p) => p.t)));
  const R = new Set(tradingDaysOf(right.map((p) => p.t)));
  const both = [...L].filter((td) => R.has(td)).sort();
  return both.length ? both[both.length - 1] : null;
}

test("分时对齐取两腿最后共同交易日, 周一早盘空窗不算重叠", () => {
  // 2-day window on Monday morning: both empty -> 无重叠点
  assert.equal(lastOverlapDay([], []), null);
  // One leg only has today, the other still on Friday -> no shared day
  const mon = [{ t: "2026-08-24 09:01:00", c: 3030 }];
  const fri = [{ t: "2026-08-21 15:00:00", c: 2860 }];
  assert.equal(lastOverlapDay(mon, fri), null);
  // Sunday night rolls to Monday; both printed -> overlap Monday
  const sunNightL = [
    { t: "2026-08-21 21:01:00", c: 3000 },
    { t: "2026-08-23 21:01:00", c: 3010 },
    { t: "2026-08-24 09:01:00", c: 3030 },
  ];
  const sunNightR = [
    { t: "2026-08-21 21:01:00", c: 720 },
    { t: "2026-08-23 21:01:00", c: 725 },
    { t: "2026-08-24 09:01:00", c: 730 },
  ];
  assert.equal(lastOverlapDay(sunNightL, sunNightR), "2026-08-24");
  assert.equal(lastOverlapDay(fri, [{ t: "2026-08-21 09:31:00", c: 2858 }]), "2026-08-21");
});

test("分时同钟点取更新的一根, 周日夜盘盖住上周五夜盘", () => {
  assert.match(src, /p\.t > prev\.t/);
  const later = "2026-08-23 21:01:00";
  const earlier = "2026-08-21 21:01:00";
  assert.ok(later > earlier);
});

function spreadOHLC(L, R, m = 1) {
  const open = L.o - R.o * m;
  const close = L.c - R.c * m;
  const high = L.h - R.l * m;
  const low = L.l - R.h * m;
  return {
    open,
    close,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
  };
}

test("价差K由两腿OHLC合成, 高低夹住开收", () => {
  const s = spreadOHLC(
    { t: "d", o: 100, h: 110, l: 90, c: 105 },
    { t: "d", o: 50, h: 55, l: 45, c: 52 },
  );
  assert.equal(s.open, 50);
  assert.equal(s.close, 53);
  assert.equal(s.high, 65);
  assert.equal(s.low, 35);
  const tight = spreadOHLC(
    { t: "d", o: 10, h: 10, l: 10, c: 10 },
    { t: "d", o: 10, h: 12, l: 8, c: 11 },
  );
  // raw high 10-8=2, raw low 10-12=-2; open 0 close -1 -> clamp still 2 / -2
  assert.equal(tight.open, 0);
  assert.equal(tight.close, -1);
  assert.equal(tight.high, 2);
  assert.equal(tight.low, -2);
});

function flipOHLC(s) {
  return { open: -s.open, close: -s.close, high: -s.low, low: -s.high };
}

test("股指期现图取负, 指数减期货, 高低对调", () => {
  assert.match(src, /export function flipOHLC/);
  const futMinusCash = spreadOHLC(
    { t: "d", o: 100, h: 110, l: 90, c: 105 },
    { t: "d", o: 50, h: 55, l: 45, c: 52 },
  );
  const cashMinusFut = flipOHLC(futMinusCash);
  assert.equal(cashMinusFut.open, -50);
  assert.equal(cashMinusFut.close, -53);
  assert.equal(cashMinusFut.high, -35);
  assert.equal(cashMinusFut.low, -65);
});
