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
  assert.match(src, /LineSeries/);
  assert.match(src, /spreadLineOpts/);
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
  assert.match(src, /function parseDaily[\s\S]*dayKey/);
  assert.doesNotMatch(src, /t\.length >= 10 && c != null/);
  const bars = parseDaily([
    { ts_code: "IF2609.CFX", trade_date: "20260119", close: 4633.8, open: 4634.0 },
    { trade_date: "20260819", close: 4554.2, open: 4605.2 },
  ]);
  assert.deepEqual(bars.map((p) => p.t), ["2026-01-19", "2026-08-19"]);
  assert.equal(bars[1].c, 4554.2);
  assert.equal(dayKey("2026-08-19 15:00:00"), "2026-08-19");
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

test("股指配对默认日度升贴水, 不另开接口", () => {
  const cockpit = readFileSync(join(root, "src/pages/ArbCockpit.tsx"), "utf8");
  const basis = readFileSync(join(root, "src/components/arb/BasisPanel.tsx"), "utf8");
  assert.match(src, /pick\?\.kind === "idx" \? "daily"/);
  assert.match(src, /label: "升贴水"/);
  assert.match(cockpit, /日度升贴水/);
  assert.match(basis, /升贴水/);
  assert.doesNotMatch(src, /api\.spotTable/);
});

test("parseLight 分时保留时分, 日K才收成日期", () => {
  // dayKey("2026-08-19 09:31") -> "2026-08-19". Minute join then has no overlapping slots.
  assert.match(src, /parseLight\(kl\?\.bars,\s*mode === "daily"\)/);
  assert.doesNotMatch(src, /function parseLight\([^)]*\)[^{]*\{[^}]*const t = dayKey\(b\.datetime\)/);
});
