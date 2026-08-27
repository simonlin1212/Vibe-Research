import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function toMinute(t) {
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

function sparkXs(times, n, width, session = "ashare") {
  const even = () => Array.from({ length: n }, (_, i) => (n <= 1 ? 1 : 1 + (i / (n - 1)) * (width - 2)));
  if (n < 2) return even();
  if (session === "daily" || !times || times.length !== n) return even();
  let xs;
  if (session === "jp") {
    const open = 8 * 60;
    const lunchS = 10 * 60 + 30;
    const lunchE = 11 * 60 + 30;
    const sessionMin = 330;
    xs = times.map((t) => {
      const m = toMinute(t || "");
      let e = m - open;
      if (lunchE > lunchS && m >= lunchE) e -= lunchE - lunchS;
      return (Math.max(0, Math.min(e, sessionMin)) / sessionMin) * (width - 2) + 1;
    });
  } else if (session === "kr") {
    const open = 8 * 60;
    const sessionMin = 390;
    xs = times.map((t) => {
      const m = toMinute(t || "");
      const e = m - open;
      return (Math.max(0, Math.min(e, sessionMin)) / sessionMin) * (width - 2) + 1;
    });
  } else if (session === "hk") {
    const open = 9 * 60 + 30;
    const lunchS = 12 * 60;
    const lunchE = 13 * 60;
    const sessionMin = 330;
    xs = times.map((t) => {
      const m = toMinute(t || "");
      let e = m - open;
      if (m >= lunchE) e -= lunchE - lunchS;
      return (Math.max(0, Math.min(e, sessionMin)) / sessionMin) * (width - 2) + 1;
    });
  } else if (session === "h24") {
    const gapMin = 5;
    const tl = [0];
    for (let i = 1; i < n; i++) {
      let d = toMinute(times[i] || "") - toMinute(times[i - 1] || "");
      if (d < -720) d += 1440;
      if (d < 0 || d > gapMin) d = 1;
      tl.push(tl[i - 1] + d);
    }
    const span = Math.max(tl[tl.length - 1], 1);
    xs = tl.map((v) => (v / span) * (width - 2) + 1);
  } else {
    const open = 9 * 60 + 30;
    const lunchS = 11 * 60 + 30;
    const lunchE = 13 * 60;
    const sessionMin = 240;
    xs = times.map((t) => {
      const m = toMinute(t || "");
      let e = m - open;
      if (m >= lunchE) e -= lunchE - lunchS;
      return (Math.max(0, Math.min(e, sessionMin)) / sessionMin) * (width - 2) + 1;
    });
  }
  if (xs.some((x) => !Number.isFinite(x))) return even();
  return xs;
}

test("ashare morning stays left of the close", () => {
  const xs = sparkXs(["09:31", "09:32", "09:44"], 3, 242, "ashare");
  assert.ok(xs[2] < 30);
  assert.ok(xs[0] < xs[2]);
});

test("ashare lunch maps 11:30 and 13:00 to the same x", () => {
  const xs = sparkXs(["09:30", "11:30", "13:00", "15:00"], 4, 242, "ashare");
  assert.equal(xs[0], 1);
  assert.equal(xs[1], xs[2]);
  assert.equal(xs[3], 241);
});

test("hk morning stays left of the close", () => {
  const xs = sparkXs(["09:31", "09:32", "10:32"], 3, 331, "hk");
  assert.ok(xs[2] < 80);
  assert.ok(xs[0] < xs[2]);
});

test("hk lunch maps 12:00 and 13:00 to the same x", () => {
  const xs = sparkXs(["09:30", "12:00", "13:00", "16:00"], 4, 331, "hk");
  assert.equal(xs[0], 1);
  assert.equal(xs[1], xs[2]);
  assert.equal(xs[3], 330);
});

test("jp morning stays left of the close", () => {
  const xs = sparkXs(["08:01", "08:02", "10:30"], 3, 331, "jp");
  assert.ok(xs[2] < 170);
  assert.ok(xs[0] < xs[2]);
});

test("jp lunch maps 10:30 and 11:30 to the same x", () => {
  const xs = sparkXs(["08:00", "10:30", "11:30", "14:30"], 4, 331, "jp");
  assert.equal(xs[0], 1);
  assert.equal(xs[1], xs[2]);
  assert.equal(xs[3], 330);
});

test("kr morning stays left of the close", () => {
  const xs = sparkXs(["08:01", "08:02", "10:35"], 3, 391, "kr");
  assert.ok(xs[2] < 170);
  assert.ok(xs[0] < xs[2]);
});

test("kr has no lunch gap", () => {
  const xs = sparkXs(["08:00", "11:00", "14:30"], 3, 391, "kr");
  assert.equal(xs[0], 1);
  assert.ok(xs[1] > 150);
  assert.equal(xs[2], 390);
});

test("h24 compresses a multi-hour gap", () => {
  const xs = sparkXs(["21:00", "21:01", "09:00", "09:01"], 4, 242, "h24");
  const stepOpen = xs[1] - xs[0];
  const stepGap = xs[2] - xs[1];
  assert.ok(stepGap <= stepOpen + 1e-6);
});

test("toMinute reads datetime and compact hhmm", () => {
  assert.equal(toMinute("2026-08-15 09:31"), 9 * 60 + 31);
  assert.equal(toMinute("0931"), 9 * 60 + 31);
});

test("fear-greed hangs on breadth panel and US page, not quote hub", async () => {
  const goods = await readFile(new URL("../src/components/cockpit/CommodityPanel.tsx", import.meta.url), "utf8");
  const breadth = await readFile(new URL("../src/components/review/ReviewSentimentPanel.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/components/cockpit/FearGreedPanel.tsx", import.meta.url), "utf8");
  const us = await readFile(new URL("../src/pages/UsMarket.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(breadth, /<FearGreedPanel compact/);
  assert.match(panel, /compact \? "grid-cols-6/);
  assert.doesNotMatch(goods, /FearGreedPanel/);
  assert.doesNotMatch(goods, /\["fg", "情绪"\]/);
  assert.match(us, /<FearGreedPanel/);
  assert.match(panel, /api\.fearGreed/);
  assert.match(panel, /usePolling/);
  assert.match(panel, /viewBox="0 0 200 124"/);
  assert.match(panel, /role="img"/);
  assert.doesNotMatch(panel, /useQuotes/);
  assert.match(api, /\/market\/fear-greed/);
  assert.doesNotMatch(api, /greedyfear\.com/);
});

test("macro 标的 draws HK JP KR under NQ", async () => {
  const goods = await readFile(new URL("../src/components/cockpit/CommodityPanel.tsx", import.meta.url), "utf8");
  const world = await readFile(new URL("../src/components/cockpit/WorldIndexPanel.tsx", import.meta.url), "utf8");
  const cfg = await readFile(new URL("../src/config/cockpit.ts", import.meta.url), "utf8");
  assert.match(goods, /MACRO_INDEX_DEFS/);
  assert.match(goods, /sparkSessionForRegion/);
  assert.doesNotMatch(goods, /setTab/);
  assert.doesNotMatch(goods, /\["fut", "标的"\]/);
  assert.doesNotMatch(goods, /api\.ctfi/);
  assert.match(world, /region === "CN" \|\| d\.region === "US" \|\| d\.region === "FX"/);
  assert.match(cfg, /MACRO_INDEX_DEFS/);
  const axis = await readFile(new URL("../src/lib/sparkAxis.ts", import.meta.url), "utf8");
  assert.match(axis, /sparkSessionForRegion/);
  assert.match(axis, /HK_SESSION_MIN = 330/);
  assert.match(axis, /JP_SESSION_MIN = 330/);
  assert.match(axis, /KR_SESSION_MIN = 390/);
});

test("board flow chart plots by session time, not point index", async () => {
  const src = await readFile(new URL("../src/components/cockpit/BoardFlowChart.tsx", import.meta.url), "utf8");
  assert.match(src, /ashareSessionIdx/);
  assert.doesNotMatch(src, /i \/ Math\.max\(n - 1/);
  assert.doesNotMatch(src, /<line[^>]*lastY/);
});
