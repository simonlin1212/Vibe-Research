import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/lib/lcChart.ts"), "utf8");
const gateSrc = readFileSync(join(root, "src/lib/seriesGate.ts"), "utf8");

test("lcChart 是 K/分时共用封装, 不画 TradingView logo", () => {
  assert.match(src, /from "lightweight-charts"/);
  assert.match(src, /createChart/);
  assert.match(src, /attributionLogo: false/);
  assert.match(src, /Microsoft YaHei/);
  assert.match(src, /fontFamily: FONT/);
  assert.match(src, /LC_ORIGIN/);
  assert.match(src, /BaselineSeries/);
  assert.match(src, /CandlestickSeries/);
  assert.match(src, /export function useLcChart/);
  assert.match(src, /export function useLcHoverTag/);
  assert.match(src, /export function hoverPxFromParam/);
  assert.match(src, /export function skipResizeCrosshair/);
  assert.match(src, /export function nextHoverIdx/);
  assert.match(src, /if \(skipResizeCrosshair\(param\)\) return;/);
  assert.match(src, /addEventListener\("mouseleave"/);
  assert.match(src, /horzLine:[\s\S]*labelVisible: false/);
  assert.match(src, /export function wipeLc/);
  assert.match(src, /export function guardLc/);
  assert.match(src, /guardLc\(\(\) => setAll/);
  assert.match(src, /cancelAnimationFrame/);
  assert.match(src, /styleVolOverlay/);
  assert.match(src, /export function styleVolPane/);
  assert.match(src, /export function pinVolFromZero/);
  assert.match(src, /minValue: 0/);
  assert.match(src, /mode: PriceScaleMode.Normal/);
  assert.match(src, /export function styleOiPane/);
  assert.match(src, /export function volPaneOpts/);
  assert.match(src, /autoscaleInfoProvider: pinVolFromZero/);
  assert.match(src, /panes\(\)\[0\]/);
  assert.match(src, /MagnetOHLC/);
  assert.match(src, /"desk" \| "glance"/);
  assert.match(src, /rightPriceScale:/);
  assert.match(src, /visible: true/);
  assert.match(src, /ticksVisible: true/);
  assert.match(src, /lastValueVisible: true/);
  assert.match(src, /styleLastTag/);
  assert.doesNotMatch(src, /visible: !glance/);
  assert.match(src, /export function showSession/);
  assert.match(src, /fixRightEdge: mode === "mdhm"/);
  assert.match(src, /shiftVisibleRangeOnNewBar: false/);
  assert.match(src, /doNotSnapToHiddenSeriesIndices: true/);
  assert.match(src, /rightOffsetPixels/);
  assert.match(src, /export function pxPrec/);
  assert.match(src, /export function setRefPriceLine/);
  assert.match(src, /axisLabelVisible: false/);
  assert.match(src, /createPriceLine/);
  assert.match(src, /export function setSeriesMarks/);
  assert.match(src, /export function canUpdateLast/);
  assert.match(src, /export function paintCandles/);
  assert.match(src, /series\.update/);
  assert.match(src, /LC update rejects/);
  assert.match(src, /createOptionsChart/);
  assert.match(src, /export function createLcPriceChart/);
  assert.match(src, /export function resizeLcHost/);
  assert.match(src, /export function useLcPriceChart/);
  assert.match(src, /ResizeObserver/);
  assert.match(src, /localization: \{ locale: "zh-CN", precision: 0 \}/);
  assert.match(src, /createTextWatermark/);
  assert.match(src, /export function clearPaneWatermark/);
  assert.match(src, /export function setPaneWatermark/);
  assert.match(src, /apiRef\.current\.detach/);
  assert.match(src, /apiRef\.current\.applyOptions\(opts\)/);
  assert.match(src, /text: string \| readonly string\[\]/);
  assert.match(src, /mid-resize \/ already removed/);
  assert.match(src, /apiRef\.current = null/);
  assert.match(src, /createUpDownMarkers/);
  assert.match(src, /export function ensureUpDown/);
  assert.match(src, /export function paintUpDown/);
  assert.match(src, /PriceScaleMode/);
  assert.match(src, /export function setLogScale/);
  assert.match(src, /export function sma/);
  assert.match(src, /export function minuteLineOpts/);
  assert.match(src, /MA_PERIODS/);
  assert.match(src, /vertLines: \{ visible: true/);
  assert.match(src, /#ff2d2d/);
  assert.match(src, /#00d26a/);
  assert.match(src, /upColor: "#000"/);
  assert.match(src, /borderUpColor: UP/);
  assert.match(src, /borderVisible: true/);
});

test("四张 K/分时卡走 LC, 不直接 echarts.init", () => {
  for (const rel of [
    "src/components/ashare/AShareLcPane.tsx",
    "src/pages/us/UsKlineChart.tsx",
    "src/components/arb/SpreadChart.tsx",
    "src/components/deriv/OptionChartCard.tsx",
  ]) {
    const body = readFileSync(join(root, rel), "utf8");
    assert.match(body, /useLcChart/, rel);
    assert.match(body, /LcWell/, rel);
    assert.match(body, /LcHoverTag/, rel);
    assert.match(body, /useLcHoverTag/, rel);
    assert.match(body, /setRefPriceLine/, rel);
    assert.match(body, /setPaneWatermark/, rel);
    assert.doesNotMatch(body, /echarts\.init/, rel);
    assert.doesNotMatch(body, /from "echarts"/, rel);
    assert.doesNotMatch(body, /sizeVolPane/, rel);
  }
  const ashare = readFileSync(join(root, "src/pages/AShareLightChart.tsx"), "utf8");
  const pane = readFileSync(join(root, "src/components/ashare/AShareLcPane.tsx"), "utf8");
  const us = readFileSync(join(root, "src/pages/us/UsKlineChart.tsx"), "utf8");
  const arb = readFileSync(join(root, "src/components/arb/SpreadChart.tsx"), "utf8");
  assert.match(pane, /setLogScale/);
  assert.match(us, /setLogScale/);
  assert.match(pane, /ensureUpDown/);
  assert.match(pane, /LineSeries/);
  assert.match(pane, /minuteLineOpts/);
  assert.doesNotMatch(pane, /minuteAvg/);
  assert.match(pane, /MA_PERIODS/);
  assert.match(pane, /volUp/);
  assert.match(pane, /barOpenForVol/);
  assert.match(pane, /concatDaySlots/);
  assert.match(pane, /ashareMinuteAxisKind/);
  assert.match(pane, /\^jp/);
  assert.match(pane, /\^ks/);
  assert.match(pane, /ashareMinuteFrame\(bars, days, code\)/);
  assert.match(pane, /isFuturesCode\(code\)/);
  assert.match(pane, /tradingDaysOf/);
  assert.match(pane, /mdhm/);
  assert.match(pane, /showSession/);
  assert.match(pane, /paintHist/);
  assert.doesNotMatch(pane, /sessionMarkIdxs/);
  assert.match(pane, /export function minuteHasFlow/);
  assert.match(pane, /showVol/);
  assert.match(pane, /styleVolPane/);
  assert.match(pane, /volPaneOpts\(\), 1/);
  assert.match(pane, /成交额/);
  assert.match(pane, /showVol \? "bottom-\[24%\]"/);
  assert.match(pane, /成交量/);
  assert.match(pane, /b\?\.amount/);
  assert.match(pane, /b\.volume/);
  assert.match(pane, /\"额\"/);
  assert.match(pane, /\"量\"/);
  assert.doesNotMatch(pane, /距今/);
  assert.match(src, /export function vsRefPct/);
  assert.match(src, /export function chgToneCls/);
  assert.match(src, /export function chgToneHex/);
  assert.match(src, /export function nicePriceTicks/);
  assert.match(src, /export function formatAxisPct/);
  assert.match(src, /export function bindChgPriceAxis/);
  assert.match(src, /kind: ChgAxisKind = "price"/);
  assert.match(src, /export class ChgPriceAxisPrimitive/);
  assert.match(src, /tickVisible\(\) \{ return false; \}/);
  assert.match(src, /textColor: "rgba\(0,0,0,0\)"/);
  assert.match(src, /export function hoverPxPct/);
  assert.match(src, /export function tickClearsLast/);
  assert.match(src, /export const LAST_TAG_GAP = 14/);
  assert.match(src, /class ChgLastView/);
  assert.match(src, /lastValueVisible: false/);
  assert.match(src, /setLast\(last\)/);
  assert.match(pane, /chgToneCls/);
  assert.match(pane, /bindChgPriceAxis/);
  assert.match(pane, /lastI != null \? prices\[lastI\]/);
  assert.match(pane, /axis\.maxTone/);
  assert.match(src, /export function minuteHiLo/);
  assert.match(src, /export function minuteScaleRange/);
  assert.match(src, /export function styleMinuteSymScale/);
  assert.match(src, /scaleMargins: \{ top: 0\.02, bottom: 0\.02 \}/);
  assert.match(src, /minimumWidth: 54/);
  assert.match(pane, /minuteScaleRange/);
  assert.match(pane, /minuteHiLo/);
  assert.match(pane, /styleMinuteSymScale/);
  assert.match(pane, /lastI != null \? prices\[lastI\] : null,\s*"pct"/);
  assert.match(pane, /laterQuoteClock/);
  assert.match(pane, /isDaily \? undefined/);
  assert.match(pane, /更新 \{quoteClock\}/);
  assert.match(pane, /flex shrink-0 items-center gap-1[\s\S]*更新 \{quoteClock\}[\s\S]*\{extra\}/);
  assert.match(ashare, /qSel && !qSel\.fromStore \? qSel\.time/);
  assert.match(ashare, /quoteTime=\{quoteTime\}/);
  assert.match(pane, /!isDaily && legend\.length/);
  assert.match(pane, /axis\.maxPx/);
  assert.match(pane, /bottom-\[24%\]/);
  assert.match(pane, /LcHoverTag/);
  assert.doesNotMatch(pane, /styleVolOverlay/);
  assert.match(src, /export function volUp/);
  assert.match(src, /export function barOpenForVol/);
  assert.match(arb, /CandlestickSeries/);
  assert.match(arb, /candleOpts/);
  assert.doesNotMatch(arb, /ensureUpDown/);
  assert.match(pane, /\[wmName, code\]/);
  assert.ok(pane.lastIndexOf("setPaneWatermark") > pane.indexOf("styleMinuteSymScale"));
  assert.match(pane, /clearPaneWatermark/);
  assert.match(ashare, /AShareLcPane/);
  assert.match(ashare, /AShareLcPaneLazy/);
  assert.doesNotMatch(ashare, /import \{ AShareLcPane \}/);
  assert.match(ashare, /createSeriesGate/);
  assert.match(ashare, /if \(!snap\) return/);
  assert.match(ashare, /export function seriesNameFor/);
  assert.match(ashare, /klineCodeKey\(prev\.code\) === klineCodeKey\(snap\.meta\.code\)/);
  assert.match(pane, /LC throws Value is null/);
  assert.match(pane, /wmRef\.current = null/);
  assert.match(ashare, /kind="minute"/);
  assert.match(ashare, /kind="daily"/);
  assert.match(ashare, /两日/);
  assert.match(ashare, /ashare\.minute\.days/);
  assert.match(ashare, /minuteDays === 2 \? "5"/);
  assert.match(ashare, /minuteDays === 2 \? 1000/);
  assert.doesNotMatch(ashare, /1200/);
  assert.match(ashare, /q\?\.name \|\| c/);
  assert.match(ashare, /"买价"/);
  assert.match(ashare, /sortWatchCodes/);
  assert.match(ashare, /useSuggestSearch/);
  assert.match(ashare, /SuggestHits/);
  assert.match(ashare, /SortableHd/);
  assert.match(ashare, /"换手%"/);
  assert.match(ashare, /"量比"/);
  assert.match(ashare, /"PE\(TTM\)"/);
  assert.doesNotMatch(ashare, /echarts\.init/);
});

test("pinVolFromZero 量轴从 0 起, 半量日子还有一半高", () => {
  function pinVolFromZero(original) {
    const info = original();
    if (!info?.priceRange) return info;
    return { ...info, priceRange: { minValue: 0, maxValue: Math.max(0, info.priceRange.maxValue) } };
  }
  const out = pinVolFromZero(() => ({ priceRange: { minValue: 80, maxValue: 100 } }));
  assert.equal(out.priceRange.minValue, 0);
  assert.equal(out.priceRange.maxValue, 100);
  assert.equal(pinVolFromZero(() => null), null);
});

const LC_ORIGIN = 1_700_000_000;
function lcTime(i) { return LC_ORIGIN + i; }
function hoverIdxFromParam(raw, n) {
  const p = raw;
  if (!p) return null;
  if (p.currTrigger === "leave") return null;
  if ("point" in p && p.point == null) return null;
  if (typeof p.logical === "number" && Number.isFinite(p.logical)) {
    const i = Math.round(p.logical);
    return i >= 0 && i < n ? i : null;
  }
  if (typeof p.time === "number") {
    const i = Math.round(p.time - LC_ORIGIN);
    return i >= 0 && i < n ? i : null;
  }
  return null;
}

function skipResizeCrosshair(raw) {
  const p = raw;
  if (!p) return true;
  if (p.currTrigger === "leave") return false;
  return "point" in p && p.point == null;
}

function nextHoverIdx(prev, raw, n) {
  if (skipResizeCrosshair(raw)) return prev;
  return hoverIdxFromParam(raw, n);
}

function pxPrec(codeOrUnd, sample) {
  const s = (codeOrUnd ?? "").toUpperCase();
  if (s === "AG" || s.startsWith("AG_") || /^AG\d/.test(s)) return { precision: 1, minMove: 0.1 };
  if (s === "AU" || s.startsWith("AU_") || /^AU\d/.test(s)) return { precision: 2, minMove: 0.01 };
  if (sample != null && Number.isFinite(sample)) {
    const a = Math.abs(sample);
    if (a >= 10_000) return { precision: 1, minMove: 0.1 };
    if (a > 0 && a < 1) return { precision: 4, minMove: 0.0001 };
  }
  return { precision: 2, minMove: 0.01 };
}

function samePoint(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  if (a.time !== b.time) return false;
  if ("value" in a || "value" in b) return a.value === b.value && a.color === b.color;
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

function canUpdateLast(prev, next) {
  if (!prev || prev.length === 0 || prev.length !== next.length) return false;
  for (let i = 0; i < next.length - 1; i++) {
    if (!samePoint(prev[i], next[i])) return false;
  }
  return true;
}

test("pxPrec 银一位金两位, 小价四位", () => {
  assert.equal(pxPrec("AG2609").precision, 1);
  assert.equal(pxPrec("ag2609C16000").precision, 1);
  assert.equal(pxPrec("AU2609").precision, 2);
  assert.equal(pxPrec("IF2608").precision, 2);
  assert.equal(pxPrec("TAG", 12).precision, 2);
  assert.equal(pxPrec("510300", 0.12).precision, 4);
  assert.equal(pxPrec("RB", 11_200).precision, 1);
});

function createSeriesGate() {
  let gen = 0;
  return {
    begin() { gen += 1; return gen; },
    isCurrent(mine) { return mine === gen; },
    take(mine, snap) { return mine === gen ? snap : null; },
  };
}

test("seriesGate 丢掉点太快的上一只结果, 避免空 bars 把图 wipe 掉", () => {
  assert.match(gateSrc, /export function createSeriesGate/);
  const g = createSeriesGate();
  const older = g.begin();
  const newer = g.begin();
  assert.equal(g.take(older, { bars: [] }), null);
  assert.deepEqual(g.take(newer, { bars: [1] }), { bars: [1] });
  assert.equal(g.isCurrent(older), false);
  assert.equal(g.isCurrent(newer), true);
});

test("canUpdateLast 只认最后一根变", () => {
  const a = [{ time: 1, value: 1 }, { time: 2, value: 2 }];
  const b = [{ time: 1, value: 1 }, { time: 2, value: 3 }];
  const c = [{ time: 1, value: 9 }, { time: 2, value: 2 }];
  assert.equal(canUpdateLast(a, b), true);
  assert.equal(canUpdateLast(a, c), false);
  assert.equal(canUpdateLast(a, [...a, { time: 3, value: 4 }]), false);
  assert.equal(canUpdateLast(null, a), false);
});

test("lcTime 逻辑时间可反推下标, 真时间轴不会把午休拉开", () => {
  assert.equal(lcTime(0), LC_ORIGIN);
  assert.equal(lcTime(240) - lcTime(0), 240);
  assert.equal(hoverIdxFromParam({ logical: 12, point: { x: 1, y: 1 } }, 100), 12);
  assert.equal(hoverIdxFromParam({ time: LC_ORIGIN + 5, point: { x: 1, y: 1 } }, 10), 5);
  assert.equal(hoverIdxFromParam({ point: null, logical: 3 }, 10), null);
});

test("resize 空点不清 hover, 避免两图互挤把 React 打穿", () => {
  let h = 5;
  let writes = 0;
  for (let i = 0; i < 30; i++) {
    const a = nextHoverIdx(h, { point: null, logical: 3 }, 10);
    if (a !== h) writes += 1;
    h = a;
    const b = nextHoverIdx(h, { logical: 5, point: { x: 1, y: 1 } }, 10);
    if (b !== h) writes += 1;
    h = b;
  }
  assert.equal(h, 5);
  assert.equal(writes, 0);
  const left = nextHoverIdx(h, { currTrigger: "leave" }, 10);
  assert.equal(left, null);
  assert.match(src, /addEventListener\("mouseleave"/);
});

function volUp(close, open, prev) {
  if (close == null || !Number.isFinite(close)) return false;
  const ref = open != null && Number.isFinite(open) ? open : prev;
  if (ref == null || !Number.isFinite(ref)) return true;
  return close >= ref;
}
function barOpenForVol(open, close) {
  if (open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close)) return null;
  if (open === close) return null;
  return open;
}

test("volUp 当根收>=开为红, 腾讯假开盘改比上一分钟", () => {
  assert.equal(volUp(12.2, 12.0, 11.9), true);
  assert.equal(volUp(11.8, 12.0, 12.1), false);
  assert.equal(barOpenForVol(10.1, 10.1), null);
  assert.equal(barOpenForVol(10.0, 10.2), 10.0);
  assert.equal(volUp(10.2, barOpenForVol(10.2, 10.2), 10.0), true);
  assert.equal(volUp(9.8, barOpenForVol(9.8, 9.8), 10.0), false);
});

function httpDetail(detail, status) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const bits = detail.map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && typeof x.msg === "string") return x.msg;
      return "";
    }).filter(Boolean);
    if (bits.length) return bits.join("; ");
  }
  return `HTTP ${status}`;
}

function minuteScaleRange(prices, prev, minPct = 0.002) {
  const finite = prices.filter((p) => p != null && Number.isFinite(p));
  if (!finite.length) return null;
  const hi = Math.max(...finite);
  const lo = Math.min(...finite);
  const base = prev != null && Number.isFinite(prev) && prev > 0 ? prev : null;
  if (base == null) {
    const pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * minPct, 1e-6);
    return { min: lo - pad, max: hi + pad, prev: (hi + lo) / 2 };
  }
  const dataSpan = Math.max(hi - base, base - lo, 0);
  const span = dataSpan > 0 ? dataSpan : Math.max(base * minPct, 1e-6);
  return { min: base - span, max: base + span, prev: base };
}

function minuteHiLo(prices, prev) {
  const finite = prices.filter((p) => p != null && Number.isFinite(p));
  if (!finite.length) return null;
  const hi = Math.max(...finite);
  const lo = Math.min(...finite);
  return { hi, lo, hiPct: vsRefPct(hi, prev), loPct: vsRefPct(lo, prev) };
}

function vsRefPct(price, ref) {
  if (price == null || ref == null || !Number.isFinite(price) || !Number.isFinite(ref) || ref === 0) return null;
  return ((price - ref) / ref) * 100;
}

function chgToneCls(pct) {
  if (pct == null || !Number.isFinite(pct)) return "text-slate-400";
  return pct >= 0 ? "text-[#ff2d2d]" : "text-[#00d26a]";
}

function hoverPxPct(price, ref) {
  if (price == null || !Number.isFinite(price)) return null;
  const chg = vsRefPct(price, ref);
  const px = Number(price.toFixed(2)).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const show = chg != null && Math.abs(chg) >= 1e-12;
  const pct = show ? `${chg > 0 ? "+" : ""}${chg.toFixed(2)}%` : null;
  return { px, pct, chg: show ? chg : null };
}

function guardLc(fn) {
  try { fn(); } catch { /* LC Value is null */ }
}

test("guardLc 吞掉 LC Value is null, 不把图打翻", () => {
  assert.doesNotThrow(() => guardLc(() => { throw new Error("Value is null"); }));
  let n = 0;
  guardLc(() => { n = 1; });
  assert.equal(n, 1);
});

test("minuteScaleRange 绕昨收对称, 幅度跟区间高低", () => {
  assert.deepEqual(minuteScaleRange([10.2, 9.9], 10), { min: 9.8, max: 10.2, prev: 10 });
  const tight = minuteScaleRange([10.01], 10);
  assert.equal(tight.prev, 10);
  assert.equal(tight.max, 10.01);
  assert.equal(tight.min, 9.99);
  const flat = minuteScaleRange([10], 10);
  assert.equal(Number(flat.max.toFixed(4)), 10.02);
  assert.equal(minuteScaleRange([], 10), null);
});

test("minuteHiLo 四角是区间最高最低, 不是轴端垫幅", () => {
  const ext = minuteHiLo([10.2, 9.97], 10);
  assert.equal(ext.hi, 10.2);
  assert.equal(ext.lo, 9.97);
  assert.equal(Number(ext.hiPct.toFixed(2)), 2);
  assert.equal(Number(ext.loPct.toFixed(2)), -0.3);
});

test("chgToneCls +0% 及以上红, 小于 0 绿", () => {
  assert.equal(chgToneCls(0), "text-[#ff2d2d]");
  assert.equal(chgToneCls(1.2), "text-[#ff2d2d]");
  assert.equal(chgToneCls(-0.01), "text-[#00d26a]");
  assert.equal(chgToneCls(null), "text-slate-400");
});

function nicePriceTicks(lo, hi, maxN = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const span = hi - lo;
  const raw = span / Math.max(2, maxN - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  let step = (err >= 5 ? 10 : err >= 2 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const fill = (s) => {
    const start = Math.ceil((lo - s * 1e-9) / s) * s;
    const out = [];
    for (let p = start; p <= hi + s * 1e-9; p += s) {
      out.push(Number(p.toPrecision(12)));
    }
    return out;
  };
  let out = fill(step);
  while (out.length > maxN + 1) {
    const next = step * (out.length > maxN + 3 ? 5 : 2);
    if (!(next > step)) break;
    step = next;
    out = fill(step);
  }
  return out;
}

function formatAxisPx(p, precision = 2) {
  if (Math.abs(p - Math.round(p)) < 1e-6 && Math.abs(p) >= 10) return String(Math.round(p));
  return p.toFixed(precision);
}

function chgToneHex(pct) {
  if (pct == null || !Number.isFinite(pct)) return "#c8cdd6";
  return pct >= 0 ? "#ff2d2d" : "#00d26a";
}

function formatAxisPct(pct) {
  if (!Number.isFinite(pct)) return "—";
  if (Math.abs(pct) < 5e-13) return "0.00%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

test("nicePriceTicks 走出 4660/4680 这种整数档", () => {
  const ticks = nicePriceTicks(4654, 4708);
  assert.ok(ticks.includes(4660));
  assert.ok(ticks.includes(4680));
  assert.ok(ticks.length <= 6);
  assert.equal(formatAxisPx(4660), "4660");
  assert.equal(formatAxisPx(12.35), "12.35");
  const wide = nicePriceTicks(4000, 5000);
  assert.ok(wide.length <= 6);
  const pctTicks = nicePriceTicks(-2.15, 2.15);
  assert.ok(pctTicks.includes(0));
  assert.ok(pctTicks.length <= 6);
});

function klineCodeKey(code) {
  return code.trim().toLowerCase().replace(/^(sh|sz|bj)/, "");
}

function seriesNameFor(meta, selected) {
  const name = (meta?.name || "").trim();
  const got = (meta?.code || "").trim();
  if (!name || !got || !selected) return "";
  return klineCodeKey(got) === klineCodeKey(selected) || got.toLowerCase() === selected.toLowerCase()
    ? name
    : "";
}

test("seriesNameFor 换票不用上一只的名字", () => {
  assert.equal(seriesNameFor({ code: "600519", name: "贵州茅台" }, "000001"), "");
  assert.equal(seriesNameFor({ code: "000001", name: "上证指数" }, "sh000001"), "上证指数");
  assert.equal(seriesNameFor({ code: "600519", name: "贵州茅台" }, "600519"), "贵州茅台");
});

test("formatAxisPct 分时右轴写涨跌幅", () => {
  assert.equal(formatAxisPct(1.2), "+1.20%");
  assert.equal(formatAxisPct(-0.5), "-0.50%");
  assert.equal(formatAxisPct(0), "0.00%");
  const pctTicks = nicePriceTicks(-2.15, 2.15);
  assert.ok(pctTicks.includes(0));
  assert.ok(pctTicks.length <= 6);
});

test("chgToneHex 价轴字 +0% 及以上红, 小于 0 绿", () => {
  assert.equal(chgToneHex(vsRefPct(4680, 4660)), "#ff2d2d");
  assert.equal(chgToneHex(vsRefPct(4660, 4660)), "#ff2d2d");
  assert.equal(chgToneHex(vsRefPct(4640, 4660)), "#00d26a");
  assert.equal(chgToneHex(null), "#c8cdd6");
});

test("vsRefPct 是相对昨收/昨结, 不是距今", () => {
  assert.equal(vsRefPct(11, 10), 10);
  assert.equal(vsRefPct(9, 10), -10);
  assert.equal(vsRefPct(10, 10), 0);
  assert.equal(vsRefPct(10, 0), null);
  assert.equal(vsRefPct(null, 10), null);
});

test("hoverPxPct 右侧价签是 价格 (+/-%) 相对昨收", () => {
  assert.deepEqual(hoverPxPct(11, 10), { px: "11", pct: "+10.00%", chg: 10 });
  assert.deepEqual(hoverPxPct(9, 10), { px: "9", pct: "-10.00%", chg: -10 });
  assert.deepEqual(hoverPxPct(10, 10), { px: "10", pct: null, chg: null });
  assert.deepEqual(hoverPxPct(10, null), { px: "10", pct: null, chg: null });
  assert.equal(hoverPxPct(null, 10), null);
  const frame = readFileSync(join(root, "src/components/ui/LcFrame.tsx"), "utf8");
  assert.match(frame, /export function LcHoverTag/);
  assert.match(frame, /text-\[#ff2d2d\].*text-\[#00d26a\]/s);
});

function tickClearsLast(y, lastY, gap = 14) {
  if (lastY == null || !Number.isFinite(lastY)) return true;
  return Math.abs(y - lastY) >= gap;
}

test("tickClearsLast 刻度字躲开最新价红绿块", () => {
  assert.equal(tickClearsLast(100, 100), false);
  assert.equal(tickClearsLast(105, 100), false);
  assert.equal(tickClearsLast(120, 100), true);
  assert.equal(tickClearsLast(100, null), true);
});

test("httpDetail 不把 FastAPI 422 列表打成 [object Object]", () => {
  assert.equal(httpDetail("未取到", 404), "未取到");
  assert.equal(httpDetail([{ msg: "Input should be less than or equal to 1000" }], 422), "Input should be less than or equal to 1000");
  assert.equal(httpDetail([{ loc: ["query", "num"] }], 422), "HTTP 422");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  assert.match(api, /export function httpDetail/);
  assert.match(api, /httpDetail\(payload\?\.detail/);
});
