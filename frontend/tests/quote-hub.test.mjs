import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHART = new URL("../src/pages/AShareLightChart.tsx", import.meta.url);
const FEED = new URL("../src/components/WatchlistFeed.tsx", import.meta.url);
const QUOTE = new URL("../src/lib/quoteHub.ts", import.meta.url);
const MINUTE = new URL("../src/lib/minuteHub.ts", import.meta.url);
const WORLD = new URL("../src/components/cockpit/WorldIndexPanel.tsx", import.meta.url);
const SESSION = new URL("../src/lib/ashareSession.ts", import.meta.url);
const FRESH = new URL("../src/lib/freshness.ts", import.meta.url);
const DIRECT = new URL("../src/lib/tencentDirect.ts", import.meta.url);
const TAPE = new URL("../src/hooks/useTapeQuotes.ts", import.meta.url);
const LAYOUT = new URL("../src/components/layout/Layout.tsx", import.meta.url);

const chartSrc = await readFile(CHART, "utf8");
const feedSrc = await readFile(FEED, "utf8");
const quoteSrc = await readFile(QUOTE, "utf8");
const minuteSrc = await readFile(MINUTE, "utf8");
const worldSrc = await readFile(WORLD, "utf8");
const sessionSrc = await readFile(SESSION, "utf8");
const directSrc = await readFile(DIRECT, "utf8");
const freshSrc = await readFile(FRESH, "utf8");
const tapeSrc = await readFile(TAPE, "utf8");
const layoutSrc = await readFile(LAYOUT, "utf8");

function tapeLivePath(pathname) {
  const p = pathname || "";
  return !["/settings", "/backtest", "/data", "/research"].some(
    (root) => p === root || p.startsWith(`${root}/`),
  );
}

test("tape unsubscribes the quote hub on settings/backtest/data/research", () => {
  assert.match(tapeSrc, /export function tapeLivePath/);
  assert.match(tapeSrc, /peekQuotes/);
  assert.match(tapeSrc, /useQuotes\(live \? TAPE_CODES : \[\]\)/);
  assert.match(tapeSrc, /"\/settings", "\/backtest", "\/data", "\/research"/);
  assert.match(layoutSrc, /useTapeQuotes\(tapeLivePath\(pathname\)\)/);
  assert.equal(tapeLivePath("/a-share"), true);
  assert.equal(tapeLivePath("/macro"), true);
  assert.equal(tapeLivePath("/us-market"), true);
  assert.equal(tapeLivePath("/portfolio"), true);
  assert.equal(tapeLivePath("/settings"), false);
  assert.equal(tapeLivePath("/backtest"), false);
  assert.equal(tapeLivePath("/data"), false);
  assert.equal(tapeLivePath("/research"), false);
  assert.equal(tapeLivePath("/research/foo"), false);
});

test("K-line page and watchlist feed subscribe to the quote hub", () => {
  assert.match(chartSrc, /useQuotes\(/);
  assert.match(chartSrc, /codes\.includes\(selected\)/);
  assert.doesNotMatch(chartSrc, /api\.quote\(/);
  assert.match(feedSrc, /useQuotes\(codes\)/);
  assert.doesNotMatch(feedSrc, /api\.quote\(/);
});

test("chart last bar overlays quote hub and minutes keep polling", async () => {
  const klineSrc = await readFile(new URL("../src/lib/lightKline.ts", import.meta.url), "utf8");
  assert.match(klineSrc, /export function overlayQuoteBar/);
  assert.match(klineSrc, /newHm > lastHm/);
  assert.match(klineSrc, /hmOf\(last\.datetime\)/);
  assert.match(klineSrc, /nowMs: number = Date\.now\(\)/);
  assert.match(klineSrc, /Never move T backwards/);
  assert.match(klineSrc, /q\.fromStore/);
  assert.match(quoteSrc, /fromStore: true/);
  assert.match(quoteSrc, /old\.fromStore/);
  assert.match(chartSrc, /bypassCache: !opts\?\.quiet/);
  assert.match(klineSrc, /FUTURE_TTL_MS = 4_000/);
  assert.doesNotMatch(klineSrc, /quoteStamp\(q\.updated/);
  assert.match(chartSrc, /overlayQuoteBar\(minute\.bars/);
  assert.match(chartSrc, /overlayQuoteBar\(daily\.bars/);
  assert.match(chartSrc, /isFuturesCode\(code\) \? HUB_POLL_FUTURES_MS : MINUTE_POLL_MS/);
  assert.match(chartSrc, /quiet: true/);
  assert.match(chartSrc, /isFuturesCode\(selected\)/);
  assert.doesNotMatch(chartSrc, /api\.quote\(/);
});

test("quote clock formats upstream stamps", () => {
  assert.match(freshSrc, /export function formatQuoteClock/);
  assert.match(freshSrc, /export function laterQuoteClock/);
  assert.match(freshSrc, /YYYYMMDDHHMMSS/);
  assert.match(freshSrc, /00:00:00/);
});

test("quote hub keeps last price/pct across refresh", () => {
  assert.match(quoteSrc, /localStorage/);
  assert.match(quoteSrc, /vr\.quoteHub\.v1/);
  assert.match(quoteSrc, /function loadStore/);
  assert.match(quoteSrc, /pagehide/);
  assert.doesNotMatch(quoteSrc, /entries\.delete\(c\)/);
  assert.match(quoteSrc, /lastFlush === 0 \? 0/);
});

test("minute hub keeps last bars across refresh", () => {
  assert.match(minuteSrc, /localStorage/);
  assert.match(minuteSrc, /vr\.minuteHub\.v1/);
  assert.match(minuteSrc, /function loadStore/);
  assert.match(minuteSrc, /pagehide/);
  assert.doesNotMatch(minuteSrc, /entries\.delete\(c\)/);
  assert.match(minuteSrc, /lastFlush === 0 \? 0/);
});

test("browser-direct Tencent is not used when the server is still in flight", () => {
  assert.match(directSrc, /export function isTimeoutError/);
  assert.match(directSrc, /timeoutMs = 12_000/);
  assert.match(directSrc, /directFn && !isTimeoutError\(e\)/);
  assert.doesNotMatch(directSrc, /on fail\/timeout/);
});

test("quote and minute hubs stretch the interval when A-share is not open", () => {
  assert.match(sessionSrc, /export const HUB_POLL_CLOSED_MS = 60_000/);
  assert.match(sessionSrc, /export const HUB_POLL_FUTURES_MS = 5_000/);
  assert.match(sessionSrc, /offshore \? HUB_POLL_FUTURES_MS/);
  assert.match(sessionSrc, /export function hubPollMs/);
  assert.match(sessionSrc, /primeTradingDay/);
  assert.match(sessionSrc, /reviewWarmup/);
  assert.match(quoteSrc, /hubPollMs\(QUOTE_POLL_MS, new Date\(\)/);
  assert.match(minuteSrc, /HUB_POLL_FUTURES_MS : MINUTE_POLL_MS/);
  assert.match(minuteSrc, /isOffshoreCode/);
  assert.match(quoteSrc, /isOffshoreCode/);
  assert.match(quoteSrc, /primeTradingDay/);
  assert.match(minuteSrc, /primeTradingDay/);
  assert.doesNotMatch(quoteSrc, /setInterval/);
  assert.doesNotMatch(minuteSrc, /setInterval/);
});

test("browser-direct Tencent fallback keeps PE/PB/total mcap", () => {
  assert.match(directSrc, /pe_ttm/);
  assert.match(directSrc, /mcap_yi/);
  assert.match(directSrc, /f\[39\]/);
  assert.match(directSrc, /f\[45\]/);
  assert.match(directSrc, /f\[46\]/);
  assert.match(directSrc, /is_stale/);
  assert.match(directSrc, /bid_vol/);
  assert.match(directSrc, /vol_ratio/);
  assert.match(quoteSrc, /time: q\.time/);
  assert.match(quoteSrc, /bid_vol/);
  assert.match(quoteSrc, /float_mcap_yi/);
  assert.match(chartSrc, /q\?\.bid/);
  assert.match(chartSrc, /换手%/);
  assert.match(chartSrc, /q\?\.pe_ttm/);
});

test("world index minutes subscribe to the minute hub", () => {
  assert.match(worldSrc, /useMinutes\(KLINE_SYMS\)/);
  assert.doesNotMatch(worldSrc, /loadLightKlineBatch/);
  assert.doesNotMatch(worldSrc, /usePolling/);
});

function chunkCodes(codes, size = 40) {
  const out = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
}

test("quoteFlow splits stock-flows at 40 codes so the query stays under 400", async () => {
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /export function chunkCodes/);
  assert.match(api, /chunkCodes\(codes, 40\)/);
  assert.doesNotMatch(api, /stockFlows:/);
  assert.doesNotMatch(api, /stockFlowBatch:/);
  const lots = Array.from({ length: 41 }, (_, i) => String(600000 + i));
  assert.equal(chunkCodes(lots, 40).length, 2);
  assert.equal(chunkCodes(lots, 40)[0].length, 40);
  assert.equal(chunkCodes(lots, 40)[1].length, 1);
});
