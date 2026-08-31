import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CTX = new URL("../src/lib/reviewContext.ts", import.meta.url);
const REVIEW = new URL("../src/pages/DailyReview.tsx", import.meta.url);
const ASK = new URL("../src/components/ui/AskAiButton.tsx", import.meta.url);
const HOOK = new URL("../src/hooks/useReviewData.ts", import.meta.url);
const API = new URL("../src/lib/api.ts", import.meta.url);
const COCKPIT = new URL("../src/config/cockpit.ts", import.meta.url);
const CATALOG = new URL("../../backend/index_catalog.py", import.meta.url);

const src = await readFile(CTX, "utf8");
const reviewSrc = await readFile(REVIEW, "utf8");
const askSrc = await readFile(ASK, "utf8");
const hookSrc = await readFile(HOOK, "utf8");
const apiSrc = await readFile(API, "utf8");
const cockpitSrc = await readFile(COCKPIT, "utf8");
const catalogSrc = await readFile(CATALOG, "utf8");

test("reviewContext is a thin client of the backend packer", () => {
  assert.match(src, /api\.reviewContext/);
  assert.match(src, /watch_codes/);
  assert.doesNotMatch(src, /const EXPECTED/);
  assert.doesNotMatch(src, /assembleReviewContext/);
  assert.doesNotMatch(src, /fetchCockpitLive/);
  assert.doesNotMatch(src, /fmtSignedPct/);
  assert.match(apiSrc, /\/market\/review-context/);
});

test("ETF 份额日线走 LC, 国债曲线挂宏观页 ECharts", async () => {
  const money = await readFile(new URL("../src/components/review/ReviewMoneySeg.tsx", import.meta.url), "utf8");
  const bond = await readFile(new URL("../src/components/macro/BondPanel.tsx", import.meta.url), "utf8");
  assert.match(money, /function EtfShareChart/);
  assert.match(money, /useLcChart\("glance"\)/);
  assert.match(money, /LineSeries/);
  assert.match(money, /alignEtfShareDays/);
  assert.match(money, /setPaneWatermark/);
  assert.match(money, /function EtfShareTip/);
  assert.match(money, /LcHoverTag/);
  assert.match(money, /useLcHoverTag/);
  assert.doesNotMatch(money, /LcLegend/);
  assert.match(money, /<EtfShareChart /);
  const etfBlock = money.slice(money.indexOf("function EtfShareChart"));
  assert.doesNotMatch(etfBlock, /echarts\.init/);
  assert.doesNotMatch(money, /bondEchartRef/);
  assert.doesNotMatch(money, /api\.lpr/);
  assert.doesNotMatch(money, /利率 · LPR/);
  assert.match(bond, /echarts\.init/);
});

function alignEtfShareDays(dates, daily) {
  const byDate = new Map(daily.map((d) => [d.date, d.shares_yi]));
  return dates.map((d) => {
    const v = byDate.get(d);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

test("alignEtfShareDays 对齐日期, 缺口留空", () => {
  const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];
  assert.deepEqual(
    alignEtfShareDays(dates, [{ date: "2026-01-01", shares_yi: 10 }, { date: "2026-01-03", shares_yi: 12 }]),
    [10, null, 12],
  );
  assert.deepEqual(alignEtfShareDays(dates, []), [null, null, null]);
});

test("phone review stock names do not jump to kline", async () => {
  const ql = await readFile(new URL("../src/components/cockpit/QuoteLine.tsx", import.meta.url), "utf8");
  const ladder = await readFile(new URL("../src/components/review/LimitLadderView.tsx", import.meta.url), "utf8");
  const money = await readFile(new URL("../src/components/review/ReviewMoneySeg.tsx", import.meta.url), "utf8");
  assert.match(ql, /min-width: 1024px/);
  assert.match(ql, /function KlineLink/);
  assert.match(ladder, /KlineLink/);
  assert.doesNotMatch(ladder, /tab=kline/);
  assert.match(money, /KlineLink/);
  assert.doesNotMatch(money, /tab=kline/);
});

test("limit-up card polls review snapshot top while A-share is open", () => {
  assert.match(hookSrc, /TOP_POLL_MS = 90_000/);
  assert.match(hookSrc, /getAShareSession\(\)\.kind !== "open"/);
  assert.match(hookSrc, /reviewSnapshot\(\{ scope: "top" \}\)/);
  assert.match(reviewSrc, /盘中 90s/);
});

test("breadth panel clock is last fetch, not legu session close", () => {
  assert.match(reviewSrc, /breadthLabel/);
  assert.match(reviewSrc, /家数 \{d\.breadth\.n\}/);
  assert.doesNotMatch(reviewSrc, /sentiment\?\.date/);
  assert.match(hookSrc, /breadth\?\.updated/);
});

test("breadth strip is not three cells", async () => {
  const src = await readFile(new URL("../src/components/review/ReviewSentimentPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /CountChip label="平"/);
  assert.match(src, /flatShare/);
  assert.match(src, /平均 /);
  assert.match(src, /中位 /);
  assert.doesNotMatch(src, /家数/);
  assert.doesNotMatch(src, /grid-cols-3 gap-1.5/);
});

test("Daily Review and Ask AI send the packed snapshot", () => {
  assert.match(reviewSrc, /collectReviewContext/);
  assert.match(reviewSrc, /api\.reviewContext/);
  assert.match(reviewSrc, /prompt_task/);
  assert.match(reviewSrc, /sectorKind/);
  assert.match(reviewSrc, /newsSource: "cls"/);
  assert.doesNotMatch(reviewSrc, /NewsCockpitPanel/);
  assert.ok(reviewSrc.indexOf('id: "flow"') < reviewSrc.indexOf('id: "watch"'), "板块资金在首行, 自选在左下");
  assert.ok(reviewSrc.indexOf('id: "sectors"') < reviewSrc.indexOf('id: "flow"'), "热点左、板块资金右");
  assert.match(reviewSrc, /\["inflow", "主力"\]/);
  assert.match(hookSrc, /ashare\.review\.v2/);
  assert.match(hookSrc, /"inflow"/);
  assert.doesNotMatch(reviewSrc, /今日大盘数据：\$\{d\.dataSummary\}/);
  assert.match(askSrc, /getContext\?:/);
  assert.match(askSrc, /await getContext\(\)/);
  assert.doesNotMatch(hookSrc, /buildReviewContext/);
});

test("frontend WORLD_INDEX_DEFS matches backend index_catalog", () => {
  const be = [...catalogSrc.matchAll(/\("([A-Za-z0-9]+)",\s*"[^"]+",\s*"(?:CN|HK|US|JP|KR|FX)"\)/g)].map((m) => m[1]);
  const fe = [...cockpitSrc.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]).slice(0, be.length);
  assert.deepEqual(fe, be);
  assert.ok(fe.includes("sh000905"));
  assert.ok(fe.includes("sh000852"));
});
