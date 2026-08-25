import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("同花顺商品指数名单是 850xxx, 不进指数目录/衍生目录", async () => {
  const cat = await readFile(new URL("../src/config/thsCmdIndex.ts", import.meta.url), "utf8");
  const codes = [...cat.matchAll(/code: "(\d+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8, "短名单够画分时");
  assert.ok(codes.every((c) => /^850\d{3}$/.test(c)), "全是 850 商品指数");
  assert.equal(new Set(codes).size, codes.length, "码不重复");
  assert.ok(codes.includes("850001"), "含综合 850001");
  const indexCat = await readFile(new URL("../../backend/index_catalog.py", import.meta.url), "utf8");
  const derivCat = await readFile(new URL("../../backend/deriv_catalog.py", import.meta.url), "utf8");
  assert.ok(!codes.some((c) => indexCat.includes(c)), "850 不进指数目录");
  assert.ok(!codes.some((c) => derivCat.includes(c)), "850 不进衍生目录");
});

test("行情观察 tab 自选右侧是指数, 切到才挂载, 走 /api/ths", async () => {
  const page = await readFile(new URL("../src/pages/DerivCockpit.tsx", import.meta.url), "utf8");
  const tabs = page.slice(page.indexOf("股指·商品"), page.indexOf("boardTab === \"watch\""));
  const watchAt = tabs.indexOf('["watch", "自选"]');
  const indexAt = tabs.indexOf('["index", "指数"]');
  assert.ok(watchAt >= 0 && indexAt > watchAt, "自选右边是指数");
  assert.ok(!tabs.includes("沉淀"), "沉淀不是独立 tab");
  assert.ok(page.includes("boardTab === \"index\""));
  assert.ok(page.includes("<ThsCmdIndexPanel"));
  assert.ok(!page.includes("<ThsCmdIndexPanel") || page.includes('boardTab === "index"'), "指数面板条件挂载");
  assert.ok(!page.includes("<CapitalPanel"), "沉淀不再单独成板");

  const panel = await readFile(new URL("../src/components/deriv/ThsCmdIndexPanel.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes("api.thsSnapshot"));
  assert.ok(panel.includes('thsKline(c, "min_1"'));
  assert.doesNotMatch(panel, /ovlabMarket|useQuotes|quoteHub|commodity-minutes/);
  assert.ok(panel.includes("thsSessionPrices"), "分钟线按交易日切开");
  assert.ok(panel.includes("tradingDayOf"), "夜盘归次交易日");

  const board = await readFile(new URL("../src/components/deriv/IndexFutPanel.tsx", import.meta.url), "utf8");
  assert.ok(board.includes("api.ovlabParked"));
  assert.ok(board.includes("etfSharesBatch"));
  assert.ok(board.includes("ETF_SHARE_WATCH"));
  assert.ok(board.includes("etfParkedYuan"));
  assert.ok(board.includes('"parked"'));
  assert.ok(board.includes("九期网"));
  assert.doesNotMatch(board, /useQuotes|quoteHub|commodity-minutes|杠杆/);

  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.ok(api.includes("/ths/snapshot?codes="));
  assert.ok(api.includes("/ths/kline?code="));
  assert.ok(api.includes("/ovlab/parked"));
});
