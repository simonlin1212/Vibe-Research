import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("macro page hangs CTFI, not quote hub", () => {
  const header = readFileSync(join(root, "src/components/cockpit/CockpitHeader.tsx"), "utf8");
  const nav = header.slice(header.indexOf("export const PAGE_NAV"), header.indexOf("export function parseAShareTab"));
  const eventIdx = nav.indexOf('to: "/event"');
  const macroIdx = nav.indexOf('to: "/macro"');
  const dxxIdx = nav.indexOf('to: "/dxx"');
  assert.ok(eventIdx >= 0 && macroIdx > eventIdx && dxxIdx > macroIdx, "宏观在事件后、短线侠前");
  const page = readFileSync(join(root, "src/pages/MacroCockpit.tsx"), "utf8");
  const goods = readFileSync(join(root, "src/components/cockpit/CommodityPanel.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  const fx = readFileSync(join(root, "src/components/macro/FxPanel.tsx"), "utf8");
  const catalog = readFileSync(join(root, "src/config/cockpit.ts"), "utf8");
  assert.match(page, /api\.ctfi/);
  assert.match(page, /api\.ctfiImg/);
  assert.match(page, /880 \/ 278/);
  assert.match(page, /object-contain/);
  assert.match(page, /max-h-\[180px\]/);
  assert.match(page, /max-w-\[560px\]/);
  assert.doesNotMatch(page, /className="block h-auto w-full/);
  assert.match(page, /packMacroContext/);
  assert.match(page, /进口原油运价 CTFI/);
  assert.match(page, /api\.lpr\(730\)/);
  assert.match(page, /api\.cnBondYield\("treasury"\)/);
  assert.match(page, /api\.cnBondYield\("policy"\)/);
  assert.match(page, /api\.macroBoard/);
  assert.match(page, /id: "lpr"/);
  assert.match(page, /id: "bond"/);
  assert.match(page, /id: "policy-bond"/);
  assert.match(page, /id: "money"/);
  assert.match(page, /id: "month"/);
  assert.match(page, /id: "pboc"/);
  assert.match(page, /id: "nbs-pmi"/);
  assert.match(page, /id: "fx"/);
  assert.match(page, /api\.pbocSfin/);
  assert.match(page, /api\.nbsPmi/);
  assert.match(page, /packOfficial/);
  assert.match(api, /\/market\/ctfi/);
  assert.match(api, /\/market\/ctfi-img/);
  assert.match(api, /\/market\/macro-board/);
  assert.match(api, /\/astock\/pboc-sfin/);
  assert.match(api, /\/astock\/nbs-pmi/);
  const official = readFileSync(join(root, "src/components/macro/OfficialPrints.tsx"), "utf8");
  assert.match(official, /人民银行社会融资规模增量统计表/);
  assert.match(official, /国家统计局公开稿/);
  assert.match(official, /50 荣枯/);
  assert.doesNotMatch(official, /useQuotes|quoteHub|macroBoard/);
  assert.doesNotMatch(page, /useQuotes/);
  assert.doesNotMatch(page, /quoteHub/);
  assert.match(fx, /useQuotes\(\[FX_CODE\]\)/);
  assert.match(fx, /whUSDCNY/);
  assert.doesNotMatch(fx, /usTNX|hf_DINIW|WORLD_INDEX/);
  assert.match(catalog, /whUSDCNY/);
  assert.doesNotMatch(catalog, /usTNX|DINIW|US10Y/);
  assert.doesNotMatch(page, /ovlabMarket/);
  assert.doesNotMatch(goods, /api\.ctfi/);
  assert.match(page, /lazy\(\(\) =>/);
  assert.doesNotMatch(page, /import \{ BondPanel/);
  assert.match(page, /firstReady/);
  assert.match(page, /CtfiChart tick=\{tick\} ready=\{ready\}/);
});

test("LPR 月度折线走 LC, 不另开 ECharts", () => {
  const panel = readFileSync(join(root, "src/components/macro/LprPanel.tsx"), "utf8");
  const chart = readFileSync(join(root, "src/components/macro/LprChart.tsx"), "utf8");
  assert.match(panel, /lazy\(\(\) =>/);
  assert.doesNotMatch(panel, /from "@\/lib\/lcChart"/);
  assert.match(chart, /export function lprChartPoints/);
  assert.match(chart, /useLcChart\("glance"\)/);
  assert.match(chart, /LineSeries/);
  assert.match(chart, /LcWell/);
  assert.match(chart, /LcHoverTag/);
  assert.match(chart, /useLcHoverTag/);
  assert.match(chart, /setPaneWatermark/);
  assert.match(chart, /export function LprChart/);
  assert.match(chart, /function LprTip/);
  assert.match(chart, /one_year/);
  assert.match(chart, /five_year/);
  assert.doesNotMatch(chart, /echarts\.init/);
  assert.doesNotMatch(chart, /from "echarts"/);
  assert.doesNotMatch(panel, /echarts\.init/);
});

function lprChartPoints(rows) {
  const chrono = [...rows].filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const keys = ["one_year", "five_year"];
  return {
    dates: chrono.map((r) => r.date),
    series: keys.map((key) => ({
      values: chrono.map((r) => {
        const v = r[key];
        return v != null && Number.isFinite(v) ? v : null;
      }),
    })),
  };
}

test("lprChartPoints 升序对齐 1Y/5Y, 缺口留空", () => {
  const got = lprChartPoints([
    { date: "2026-02-20", one_year: 3.1, five_year: 3.6 },
    { date: "2026-01-20", one_year: 3.0, five_year: null },
  ]);
  assert.deepEqual(got.dates, ["2026-01-20", "2026-02-20"]);
  assert.deepEqual(got.series[0].values, [3.0, 3.1]);
  assert.deepEqual(got.series[1].values, [null, 3.6]);
});

test("A股资金页不再画 LPR/国债", () => {
  const hook = readFileSync(join(root, "src/hooks/useReviewData.ts"), "utf8");
  const money = readFileSync(join(root, "src/components/review/ReviewMoneySeg.tsx"), "utf8");
  assert.doesNotMatch(hook, /api\.lpr/);
  assert.doesNotMatch(hook, /api\.cnBondYield/);
  assert.doesNotMatch(money, /LPR/);
  assert.doesNotMatch(money, /国债/);
});
