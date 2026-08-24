import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function tradingDayOf(t) {
  const d = t.slice(0, 10);
  const hh = Number(t.slice(11, 13));
  if (hh >= 6 && hh < 20) return d;
  const dt = new Date(`${d}T00:00:00`);
  if (hh < 6) dt.setDate(dt.getDate() - 1);
  do {
    dt.setDate(dt.getDate() + 1);
  } while (dt.getDay() === 0 || dt.getDay() === 6);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hoverIdxOf(raw, cats) {
  const p = raw;
  if (p?.currTrigger === "leave") return null;
  const xAxis = (p.axesInfo ?? []).find((a) => a.axisDim === "x") ?? p.axesInfo?.[0];
  const fromSeries = xAxis?.seriesDataIndices?.find((s) => Number.isInteger(s?.dataIndex));
  if (fromSeries && Number.isInteger(fromSeries.dataIndex)) return fromSeries.dataIndex;
  const val = xAxis?.value;
  if (typeof val === "number" && val >= 0 && val < cats.length) return Math.round(val);
  if (val != null) {
    const s = String(val);
    const i = cats.findIndex((c) => c === s || c.slice(11, 16) === s || c.slice(5) === s);
    if (i >= 0) return i;
  }
  return null;
}

test("tradingDayOf 夜盘归次交易日, 周末顺延", () => {
  assert.equal(tradingDayOf("2026-08-18 10:30:00"), "2026-08-18");
  assert.equal(tradingDayOf("2026-08-17 21:05:00"), "2026-08-18");
  assert.equal(tradingDayOf("2026-08-18 01:30:00"), "2026-08-18");
  assert.equal(tradingDayOf("2026-08-14 21:05:00"), "2026-08-17");
  assert.equal(tradingDayOf("2026-08-15 01:30:00"), "2026-08-17");
});

test("hoverIdxOf 类目轴用 dataIndex / 时间字符串, leave 清空", () => {
  const cats = ["2026-08-18 09:30:00", "2026-08-18 09:31:00", "2026-08-18 09:32:00"];
  assert.equal(hoverIdxOf({ currTrigger: "leave" }, cats), null);
  assert.equal(hoverIdxOf({
    axesInfo: [{ axisDim: "x", seriesDataIndices: [{ dataIndex: 2 }] }],
  }, cats), 2);
  assert.equal(hoverIdxOf({
    axesInfo: [{ axisDim: "x", value: "2026-08-18 09:31:00" }],
  }, cats), 1);
  assert.equal(hoverIdxOf({
    axesInfo: [{ axisDim: "x", value: "09:32" }],
  }, cats), 2);
  assert.equal(hoverIdxOf({
    axesInfo: [{ axisDim: "x", value: "not-a-bar" }],
  }, cats), null);
});

function overlayAxis(vals, occupy = 0.32) {
  const xs = [];
  for (const v of vals) {
    if (v != null && Number.isFinite(v) && v > 0) xs.push(v);
  }
  if (xs.length === 0) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const mid = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2, Math.abs(mid) * 0.015, 0.4);
  const frac = Math.min(0.85, Math.max(0.1, occupy));
  const pad = half / frac - half;
  return { min: mid - half - pad, max: mid + half + pad };
}

test("overlayAxis 窄幅隐波只占约三成高度, 空值忽略", () => {
  const r = overlayAxis([18, 22, 19, 21]);
  assert.ok(r);
  const data = 22 - 18;
  const span = r.max - r.min;
  assert.ok(Math.abs(data / span - 0.32) < 0.02, "默认约占 32% 高度");
  assert.ok(r.min < 18 && r.max > 22);
  const quiet = overlayAxis([20.1, 20.2, 20.15, 20.18, null, 0]);
  assert.ok(quiet);
  assert.ok((20.2 - 20.1) / (quiet.max - quiet.min) < 0.2, "几乎走平也不拉满");
  assert.equal(overlayAxis([]), null);
  assert.equal(overlayAxis([null, 0, -1]), null);
});

test("OptionChartCard 用 hoverIdxOf, 分时白线无均价", async () => {
  const src = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  const lc = await readFile(new URL("../src/lib/lcChart.ts", import.meta.url), "utf8");
  assert.ok(src.includes("export function hoverIdxOf"), "十字光标走 hoverIdxOf");
  assert.ok(src.includes("seriesDataIndices"), "类目轴读 dataIndex");
  assert.ok(src.includes("minuteLineOpts"), "分时白线");
  assert.ok(!src.includes("minuteAvg"), "不分时均价");
  assert.ok(!src.includes("BaselineSeries"), "不再画红绿零轴区");
  assert.ok(lc.includes("export function minuteLineOpts"), "白线挂 lcChart");
  assert.ok(!lc.includes("export function minuteAvg"), "均价函数删掉");
  assert.ok(src.includes("export function overlayAxis"), "隐波右轴走 overlayAxis");
  assert.ok(src.includes("overlayAxis(minData?.iv"), "分时隐波不拉满");
  assert.ok(src.includes("overlayAxis(dailyIv)"), "日K隐波同一比例");
  assert.ok(src.includes("LcHoverTag"), "十字右侧价签同 A 股");
  assert.ok(src.includes("useLcHoverTag"), "价签涨跌相对昨结");
  assert.ok(src.includes("guardLc"), "快切分时/两日吞 LC Value is null");
});

function parseMinute(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 2) continue;
    const close = Number(b[1]);
    if (!Number.isFinite(close)) continue;
    const oi = Number(b[3]);
    const open = Number(b[4]);
    const vol = Number(b[7]);
    out.push({
      t: String(b[0]),
      close,
      open: Number.isFinite(open) ? open : null,
      vol: Number.isFinite(vol) ? vol : 0,
      oi: Number.isFinite(oi) && oi > 0 ? oi : null,
    });
  }
  return out;
}

function volUp(close, open, prev) {
  if (close == null || !Number.isFinite(close)) return false;
  const ref = open != null && Number.isFinite(open) ? open : prev;
  if (ref == null || !Number.isFinite(ref)) return true;
  return close >= ref;
}

test("parseMinute 第4列是仓、第8列是量, 缺列当空", () => {
  const rows = parseMinute([
    ["2026-08-18 23:08:00", 950.98, "-0.57%", 199971, 951.92, 951.92, 950.76, 768],
    ["2026-08-18 09:32:00", 12.4, "1.3%", 80, 12.3, 12.5, 12.2],
    ["2026-08-18 09:33:00", 12.1, "-1.2%", 0, 12.4, 12.4, 12.0, 10],
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].oi, 199971);
  assert.equal(rows[0].vol, 768);
  assert.equal(rows[0].open, 951.92);
  assert.equal(rows[1].oi, 80);
  assert.equal(rows[1].vol, 0);
  assert.equal(rows[2].oi, null);
  assert.equal(rows[2].vol, 10);
});

test("volUp 当根收>=开为红, 缺开盘用上一根收", () => {
  assert.equal(volUp(12.2, 12.0, 11.9), true);
  assert.equal(volUp(11.8, 12.0, 12.1), false);
  assert.equal(volUp(12.0, 12.0, 11.0), true);
  assert.equal(volUp(12.2, null, 12.0), true);
  assert.equal(volUp(11.8, null, 12.0), false);
  assert.equal(volUp(null, 12.0, 12.0), false);
});

test("分时量窗叠持仓黄线, 独立轴不压成交量", async () => {
  const src = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  const lc = await readFile(new URL("../src/lib/lcChart.ts", import.meta.url), "utf8");
  assert.ok(src.includes("[time, close, pct, oi, open, high, low, vol]"), "分钟 bar 第4列仓第8列量");
  assert.ok(src.includes('overlayLineOpts(OI_COLOR, "oi")'), "分时画持仓线");
  assert.ok(src.includes("volPaneOpts(), 1"), "分时量在独立窗");
  assert.equal((src.match(/volPaneOpts\(\), 1/g) || []).length, 2, "日K和分时都拆量窗");
  assert.ok(src.includes('overlayLineOpts(OI_COLOR, "oi"), 1'), "持仓线叠在量窗");
  assert.ok(src.includes("styleOiPane"), "仓走量窗独立轴");
  assert.ok(src.includes('"oi"'), "仓走独立轴");
  assert.ok(src.includes("overlayAxis(minData?.oi"), "仓不跟成交量抢同一标尺");
  assert.ok(src.includes("仓 ${fmtOi(oi)}"), "十字光标读仓");
  assert.ok(src.includes("量 ${fmtOi(vol)}"), "十字光标读量");
  assert.ok(src.includes("volUp(px, minData?.opens[i]"), "量柱按当根开收");
  assert.ok(lc.includes("export function styleOiPane"), "量窗持仓轴");
  assert.ok(lc.includes("UP_VOL"), "量柱半透明红绿, 不挡持仓黄线");
  assert.ok(!src.includes("px >= baseline"), "量柱不按相对昨结整日同色");
});

test("驾驶舱日K分时叠在同一张卡", async () => {
  const src = await readFile(new URL("../src/pages/DerivCockpit.tsx", import.meta.url), "utf8");
  assert.ok(src.includes('id: "opt-charts"'), "一张图卡");
  assert.ok(!src.includes('id: "opt-daily"') && !src.includes('id: "opt-minute"'), "不再并排两卡");
  assert.ok(/mode="minute"[\s\S]*mode="daily"/.test(src), "上分时下日K");
  assert.ok(src.includes("defaultW: 0.36") && src.includes("defaultW: 0.20"), "行情观察/日历宽度");
  assert.ok(src.includes("defaultW: 0.68") && src.includes("defaultW: 0.32"), "T 表主宽, 图卡约占三分之一");
  assert.ok(src.includes("defaultH: 0.29") && src.includes("defaultH: 0.71"), "首行回原高, T 区加高");
  assert.ok(src.includes('kind: "und"'), "点行情观察出标的日K/分时");
  assert.ok(src.includes("undChart"), "行情观察行带标的码给图卡");
  assert.ok(src.includes("findRowByUnd"), "T 表换品种从行情观察行出主力码");
  assert.ok(src.includes("undChart?.code"), "有标的码时空 prodUnd 也出图");
});

test("IndexFutPanel 行点击出标的图, 不再跳独立 K线页", async () => {
  const src = await readFile(new URL("../src/components/deriv/IndexFutPanel.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("undChart?: { code: string; name: string }"), "行点击第二参是标的图");
  assert.ok(src.includes("contractCode(row)"), "标的码用主力合约");
  assert.ok(src.includes("undOfRow(row)"), "空 prodUnd 用目录 und 调 T 表");
  assert.ok(!src.includes("onPickSymbol"), "不再跳独立 K线页");
});

test("分时卡可切两日, 按交易日拼轴", async () => {
  const src = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  assert.ok(src.includes('[2, "两日"]'), "两日开关");
  assert.ok(src.includes("minuteFrame"), "两日拼轴走 minuteFrame");
  assert.ok(src.includes("concatDaySlots"), "交易日槽位拼接");
  assert.ok(src.includes("deriv.minute.days"), "本机记住一日/两日");
  assert.ok(src.includes("applyMinuteTick"), "dataview 叠分时最后一笔");
  assert.ok(src.includes("tradingDayOf(c) === td && hmOf(c) === hm"), "夜盘槽按交易日对齐");
});

test("驾驶舱日K分时吃 dataview tick", async () => {
  const src = await readFile(new URL("../src/pages/DerivCockpit.tsx", import.meta.url), "utf8");
  const card = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("undSpotLast"), "期货图叠行情观察主力价");
  assert.ok(src.includes('optPick.kind !== "und"'), "期权图只叠 dataview");
  assert.ok((src.match(/tick=\{chartTick\}/g) || []).length >= 2, "日K和分时都叠 chartTick");
  assert.ok(src.includes("useDerivData(optPick ? [optPick.code, optPick.und] : [])"), "钉住当前图合约");
  assert.ok(card.includes("export function applyDailyTick"), "日K叠当日最后一根");
  assert.ok(card.includes("live ? 15_000 : 60_000"), "盘中分时加快拉 history");
  assert.ok(card.includes("num(tick?.last)"), "驾驶舱已拼好的主力价直接叠");
  assert.ok(card.includes("fmtPx(b.close, pick.und)"), "轴/HUD 精度跟品种走");
  assert.ok(card.includes("paintCandles"), "日K 最后一根优先 update");
  assert.ok(card.includes("paintLine"), "分时最后一根优先 update");
  assert.ok(card.includes("setRefPriceLine"), "昨收/昨结价线");
  assert.ok(card.includes("setSeriesMarks"), "到期/夜盘/异动 markers");
  assert.ok(card.includes("setPaneWatermark"), "合约淡字水印");
  assert.ok(card.includes("ensureUpDown"), "分时最新一跳红绿闪");
  assert.ok(card.includes("paintUpDown"), "MQTT 最后一根才闪");
  assert.ok(card.includes("sessionMarkIdxs"), "夜盘开盘钉点");
  assert.ok(src.includes("alerts={d.alerts ?? undefined}"), "异动分钟叠当前合约, 空列表不每帧新建");
  assert.ok(card.includes("export function expiryYmd"), "到期日兼容 20260825");
  assert.ok(card.includes("export function alertMatchesCode"), "异动对 T 表短码 / OPT_ 长码");
  assert.ok(card.includes('pick?.kind === "und"') && card.includes("ovlabLastBar"), "期货标的 last-bar 做底");
  assert.ok(card.includes("liveAxisKind"), "夜盘无分钟点也铺当夜轴");
  assert.ok(card.includes("showSession"), "分时开盘贴左, 不 fitContent 挤到右侧");
});

test("自选最新叠 dataview", async () => {
  const src = await readFile(new URL("../src/components/deriv/WatchPanel.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("d.ticks[code.toUpperCase()]"), "自选最新叠 dataview");
  assert.ok(src.includes("tickFresh"), "陈旧 dataview 回落 last-bar");
  assert.ok(src.includes("api.ovlabLastBar"), "last-bar 仍做底");
});

function minuteKey(t) {
  const s = (t || "").replace("T", " ").trim();
  if (s.length >= 16 && /^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 16);
  return "";
}

function applyMinuteTick(frame, tick, now) {
  const last = Number(tick?.last);
  if (!Number.isFinite(last) || frame.cats.length === 0) return frame;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
  const td = tradingDayOf(stamp);
  const hm = stamp.slice(11, 16);
  let i = frame.cats.findIndex((c) => c && tradingDayOf(c) === td && c.slice(11, 16) === hm);
  if (i < 0) {
    i = -1;
    for (let k = frame.prices.length - 1; k >= 0; k--) {
      if (frame.prices[k] != null && Number.isFinite(frame.prices[k])) { i = k; break; }
    }
  }
  if (i < 0) return frame;
  const prices = frame.prices.slice();
  const oi = frame.oi.slice();
  prices[i] = last;
  const oiv = Number(tick?.oi);
  if (Number.isFinite(oiv) && oiv > 0) oi[i] = oiv;
  return { ...frame, prices, oi };
}

test("applyMinuteTick 填当前分钟槽, 否则改最后一笔", () => {
  const frame = {
    cats: ["2026-08-18 09:30:00", "2026-08-18 09:31:00", "2026-08-18 09:32:00"],
    prices: [10, 11, null],
    oi: [1, 2, null],
  };
  const now = new Date(2026, 7, 18, 9, 32, 5);
  const out = applyMinuteTick(frame, { last: 12.5, oi: 9 }, now);
  assert.equal(out.prices[2], 12.5);
  assert.equal(out.oi[2], 9);
  assert.equal(out.prices[1], 11);
  const late = applyMinuteTick(frame, { last: 13 }, new Date(2026, 7, 18, 10, 0, 0));
  assert.equal(late.prices[1], 13);
});

test("applyMinuteTick 周五夜盘凌晨对交易日槽, 不改写周五 23:xx", () => {
  const frame = {
    cats: [
      "2026-08-14 21:05:00",
      "2026-08-14 23:59:00",
      "2026-08-17 00:30:00",
      "2026-08-17 09:00:00",
    ],
    prices: [100, 101, null, null],
    oi: [1, 2, null, null],
  };
  const now = new Date(2026, 7, 15, 0, 30, 5);
  const out = applyMinuteTick(frame, { last: 102, oi: 9 }, now);
  assert.equal(out.prices[2], 102);
  assert.equal(out.oi[2], 9);
  assert.equal(out.prices[1], 101);
});

function applyDailyTick(bars, tick, now) {
  const last = Number(tick?.last);
  if (!Number.isFinite(last) || bars.length === 0) return bars;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
  const td = tradingDayOf(stamp);
  const i = bars.length - 1;
  const b = bars[i];
  if (b.t === td) {
    return [...bars.slice(0, i), { ...b, close: last, high: Math.max(b.high, last), low: Math.min(b.low, last) }];
  }
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const live = mins < 150 ? day >= 2 && day <= 6
    : (day === 0 || day === 6) ? false
      : (mins >= 540 && mins < 690) || (mins >= 810 && mins < 900) || mins >= 1260;
  if (live && td > b.t) {
    return [...bars, { t: td, open: last, high: last, low: last, close: last, vol: 0 }];
  }
  return bars;
}

test("applyDailyTick 叠当日最后一根高低收, 新交易日盘中另开一根", () => {
  const bars = [{ t: "2026-08-18", open: 10, high: 12, low: 9, close: 11, vol: 100 }];
  const same = applyDailyTick(bars, { last: 12.5 }, new Date(2026, 7, 18, 10, 0, 0));
  assert.equal(same.length, 1);
  assert.equal(same[0].close, 12.5);
  assert.equal(same[0].high, 12.5);
  assert.equal(same[0].low, 9);
  assert.equal(same[0].open, 10);
  const next = applyDailyTick(bars, { last: 13 }, new Date(2026, 7, 19, 10, 0, 0));
  assert.equal(next.length, 2);
  assert.equal(next[1].t, "2026-08-19");
  assert.equal(next[1].close, 13);
  const weekend = applyDailyTick(bars, { last: 99 }, new Date(2026, 7, 16, 10, 0, 0));
  assert.equal(weekend.length, 1);
  assert.equal(weekend[0].close, 11);
});

function pad2(n) {
  return String(n).padStart(2, "0");
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
function alignMinuteKey(t) {
  const s = (t || "").replace("T", " ").trim();
  if (s.length >= 16 && /^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 16);
  return hmOf(t);
}
function alignSeries(pairs, cats, loose = false) {
  const exact = new Map();
  const keys = new Map();
  const clock = new Map();
  for (const [t, v] of pairs ?? []) {
    exact.set(t, v);
    if (!loose) continue;
    const mk = alignMinuteKey(t);
    keys.set(mk, v);
    const hm = hmOf(t);
    if (hm && mk === hm) clock.set(hm, v);
  }
  const clockOk = loose && new Set(cats.filter(Boolean).map(tradingDayOf)).size <= 1;
  return cats.map((c) => {
    if (!c) return null;
    return exact.get(c)
      ?? (loose ? keys.get(alignMinuteKey(c)) : undefined)
      ?? (clockOk ? clock.get(hmOf(c)) : undefined)
      ?? null;
  });
}

test("一日分时隐波不把昨天 15:00 叠到今日空槽", () => {
  const cats = [
    "2026-08-18 09:30:00",
    "2026-08-18 10:00:00",
    "2026-08-18 15:00:00",
  ];
  const pairs = [
    ["2026-08-17 09:30:00", 20],
    ["2026-08-17 15:00:00", 22],
    ["2026-08-18 09:30:00", 18],
    ["2026-08-18 10:00:00", 19],
  ];
  const want = new Set(["2026-08-18"]);
  const iv = alignSeries(pairs.filter(([t]) => want.has(tradingDayOf(t))), cats, true);
  assert.equal(iv[0], 18);
  assert.equal(iv[1], 19);
  assert.equal(iv[2], null, "未到 15:00 的空槽保持空, 紫线不拉满");
});

test("两日分时隐波仍落在各自交易日", () => {
  const cats = [
    "2026-08-17 15:00:00",
    "",
    "2026-08-18 09:30:00",
    "2026-08-18 15:00:00",
  ];
  const pairs = [
    ["2026-08-17 15:00:00", 22],
    ["2026-08-18 09:30:00", 18],
  ];
  const iv = alignSeries(pairs, cats, true);
  assert.equal(iv[0], 22);
  assert.equal(iv[1], null);
  assert.equal(iv[2], 18);
  assert.equal(iv[3], null);
});

function sessionMarkIdxs(cats) {
  const out = [];
  let prevTd = "";
  let seenNight = false;
  let seenDay = false;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    if (!c) continue;
    const td = tradingDayOf(c);
    if (td !== prevTd) {
      seenNight = false;
      seenDay = false;
      prevTd = td;
    }
    const hm = c.slice(11, 16);
    if (!seenNight && (hm === "21:00" || hm === "21:01")) {
      out.push({ i, text: "夜" });
      seenNight = true;
    }
    if (!seenDay && (hm === "09:00" || hm === "09:30")) {
      out.push({ i, text: hm === "09:30" ? "开" : "日" });
      seenDay = true;
    }
  }
  return out;
}

function expiryYmd(raw) {
  const s = String(raw ?? "").trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

function expiryMarkIdx(days, expiry) {
  const ymd = expiryYmd(expiry);
  if (!ymd) return null;
  const i = days.findIndex((d) => d.slice(0, 10) === ymd);
  return i >= 0 ? i : null;
}

function alertMatchesCode(a, code) {
  const want = code.toUpperCase();
  if (!want) return false;
  const cc = String(a.contract_code ?? "").toUpperCase();
  const inst = String(a.instrument ?? "").toUpperCase();
  if (cc && cc === want) return true;
  if (inst && inst === want) return true;
  const m = inst.match(/^OPT_[A-Z]+_([A-Z0-9]+):(\d{6}):([CP]):(.+)$/);
  if (!m) return false;
  return `${m[1]}${m[2].slice(2)}${m[3]}${m[4]}` === want;
}

function alertMarkIdxs(cats, alerts, code) {
  const out = [];
  const seen = new Set();
  const dated = cats.some((c) => c && c.length > 10);
  for (const a of alerts) {
    if (!alertMatchesCode(a, code)) continue;
    const t = String(a.time ?? "");
    if (!t) continue;
    let i = -1;
    if (dated) {
      i = cats.findIndex((c) => c && c.slice(0, 16) === t.slice(0, 16));
    } else {
      i = cats.findIndex((c) => c && c.slice(0, 10) === tradingDayOf(t));
    }
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    const side = String(a.side ?? "").toLowerCase();
    out.push({ i, up: side !== "bid" && side !== "sell" });
  }
  return out;
}

test("sessionMarkIdxs 夜盘 21:00 和日盘开盘各钉一次", () => {
  const cats = [
    "2026-08-17 21:00:00",
    "2026-08-17 21:01:00",
    "2026-08-18 09:00:00",
    "2026-08-18 09:01:00",
  ];
  const m = sessionMarkIdxs(cats);
  assert.deepEqual(m.map((x) => x.text), ["夜", "日"]);
  assert.equal(m[0].i, 0);
  assert.equal(m[1].i, 2);
});

test("expiryMarkIdx / alertMarkIdxs 对上当前合约", () => {
  assert.equal(expiryMarkIdx(["2026-08-18", "2026-09-16"], "2026-09-16"), 1);
  assert.equal(expiryMarkIdx(["2026-08-18", "2026-08-25"], "20260825"), 1);
  assert.equal(expiryMarkIdx(["2026-08-18"], "2026-09-16"), null);
  const cats = ["2026-08-18 09:30:00", "2026-08-18 10:00:00"];
  const hits = alertMarkIdxs(cats, [
    { contract_code: "AG2609C16000", time: "2026-08-18 10:00:12", side: "ask" },
    { contract_code: "AU2609C800", time: "2026-08-18 10:00:00", side: "bid" },
  ], "ag2609C16000");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].i, 1);
  assert.equal(hits[0].up, true);
  assert.equal(alertMatchesCode({ instrument: "OPT_SHSE_588000:202608:P:1.8", contract_code: "10012124" }, "5880002608P1.8"), true);
  assert.equal(alertMatchesCode({ instrument: "OPT_SHSE_588000:202608:P:1.8", contract_code: "10012124" }, "AG2609C16000"), false);
});

test("minuteFrame 隐波按交易日过滤, 不用跨日钟面匹配", async () => {
  const src = await readFile(new URL("../src/components/deriv/OptionChartCard.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("want.has(tradingDayOf(t))"), "一日隐波只留当前交易日");
  assert.ok(src.includes("if (hm && mk === hm) clock.set(hm, v)"), "有日期的点不按 HH:MM 串日");
});
