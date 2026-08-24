import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function num(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

function ivOf(s) {
  const b = num(s.ivBid);
  const a = num(s.ivAsk);
  if (b !== null && a !== null) return (b + a) / 2;
  return num(s.theoIv);
}

function maxOiVal(strikes) {
  let m = 0;
  for (const s of strikes) {
    const c = num(s.call.oi);
    const p = num(s.put.oi);
    if (c !== null && c > m) m = c;
    if (p !== null && p > m) m = p;
  }
  return m;
}

function ivSkew(strikes, fwd) {
  if (fwd === null || strikes.length === 0) return null;
  const below = [...strikes].reverse().find((s) => s.strike < fwd);
  const above = strikes.find((s) => s.strike > fwd);
  const putIv = below ? ivOf(below.put) : null;
  const callIv = above ? ivOf(above.call) : null;
  if (putIv === null || callIv === null) return null;
  return putIv - callIv;
}

function mk(strike, callOi = 0, putOi = 0, callIv = 20, putIv = 20) {
  return {
    strike,
    call: { oi: callOi, theoIv: callIv },
    put: { oi: putOi, theoIv: putIv },
  };
}

function hideItmSide(side, strike, fwd, keep, hide) {
  if (!hide || fwd === null) return false;
  const kept = keep == null ? [] : typeof keep === "number" ? [keep] : keep;
  if (kept.includes(strike)) return false;
  return side === "call" ? strike < fwd : strike > fwd;
}

function undBracket(strikes, px) {
  if (px == null || !Number.isFinite(px) || strikes.length < 2) return null;
  const ks = [...new Set(strikes)].sort((a, b) => a - b);
  let lo = null;
  let hi = null;
  for (const k of ks) {
    if (k <= px) lo = k;
    if (k >= px && hi == null) hi = k;
  }
  if (lo == null || hi == null) return null;
  if (lo !== hi) return { lo, hi };
  const i = ks.indexOf(lo);
  if (i >= 0 && i + 1 < ks.length) return { lo: ks[i], hi: ks[i + 1] };
  if (i > 0) return { lo: ks[i - 1], hi: ks[i] };
  return null;
}

test("ivSkew 沽虚值更贵为正", () => {
  const strikes = [mk(90, 0, 0, 18, 22), mk(100, 0, 0, 20, 20), mk(110, 0, 0, 19, 18)];
  const skew = ivSkew(strikes, 100);
  // below 90 put IV 22, above 110 call IV 19 -> 22-19=3
  assert.equal(skew, 3);
});

test("TQuotePanel 默认全部档位 / 自动 ATM 购", async () => {
  const src = await readFile(new URL("../src/components/deriv/TQuotePanel.tsx", import.meta.url), "utf8");
  assert.ok(!src.includes("sliceChain"), "不再切 ATM 附近窗");
  assert.ok(!src.includes("ATM附近"), "不再切换 ATM 附近");
  assert.ok(!src.includes("setShowAll"), "无全部/附近切换");
  assert.ok(src.includes("atm.callCode"), "换月后当前期权不在链上才 ATM 购");
  assert.ok(src.includes('pick?.kind === "und"'), "主力期货图不被 ATM 购覆盖");
  assert.ok(src.includes("undOfRow(r)"), "空 prodUnd 仍能进品种下拉");
  assert.ok(src.includes("findRowByUnd"), "ETF 回落对应当前品种, 不新开轮询");
  assert.ok(src.includes('kind: "option"'), "T 表点合约 kind=option");
  assert.ok(src.includes('useState<"asc" | "desc">("desc")'), "行权价默认降序");
  assert.ok(src.includes('label="行权价"'), "点行权价列头排序");
  assert.ok(src.includes("b.strike - a.strike"), "降序高档在上");
  assert.ok(src.includes("看涨期权Call"), "表头看涨期权Call");
  assert.ok(src.includes('colSpan={4} className="text-center text-[12px] font-semibold text-red-400">看涨期权Call'), "看涨期权Call 红字居中");
  assert.ok(src.includes('colSpan={4} className="text-center text-[12px] font-semibold text-emerald-400">看跌期权Put'), "看跌期权Put 绿字居中");
  assert.ok(src.includes(">Delta</th>"), "表头 Delta 不用 Δ");
  assert.ok(src.includes("相对昨理论价"), "价旁标涨幅");
  assert.ok(src.includes("s.pct"), "涨幅用 tquote pct, 不另轮询");
  const hd = src.slice(src.indexOf("num !top-5"), src.lastIndexOf(">IV</th>") + 8);
  assert.ok(/IV[\s\S]+Delta[\s\S]+持仓[\s\S]+最新价[\s\S]+最新价[\s\S]+持仓[\s\S]+Delta[\s\S]+IV/.test(hd), "最新价贴行权价两侧");
  assert.ok(src.includes("function OiBar"), "持仓用横向柱");
  assert.ok(src.includes("export function maxOiVal"), "横条标尺按可见档最大仓");
  assert.ok(src.includes("undPx"), "顶栏标的最新价");
  assert.ok(src.includes("tickLast ?? mktPx ?? futLast"), "新鲜 tick, 再主力 ctamap, 再当月 futPx");
  assert.ok(src.includes("tickFresh"), "陈旧 dataview 不盖顶栏");
  assert.ok(src.includes("<CtnText value={undCtn}"), "涨跌跟当月期货, ETF 回落行情观察");
  assert.ok(src.includes("mainCode === undCode"), "只有当月=主力才叠行情观察价");
  assert.ok(src.includes("d.ticks[undCode]"), "dataview 叠当月期货 last");
  assert.ok(src.includes('kind: "und"') && src.includes("cur.und"), "点顶栏期货价出标的图");
  assert.ok(src.includes("ProdSearchSelect"), "品种下拉可搜索");
  assert.ok(!/<select[\s\S]*品种/.test(src), "不再用原生 select 选品种");
  assert.ok(src.includes("更新 {cur.lastTime.slice(11, 19)"), "更新时间带标签且到秒");
  assert.ok(src.includes("隐藏实值"), "顶栏有隐藏实值开关");
  assert.ok(src.includes("expChipTitle"), "到期月小方块: 品名+YYMM");
  assert.ok(src.includes("剩"), "到期月小方块写剩N天");
  assert.ok(!src.includes("e.exp.slice(2)} ·"), "不再用 2610 · 26天");
  assert.ok(src.includes("overflow-x-auto px-1.5 py-1.5"), "小方块在看涨/看跌表下往右排");
  assert.ok(src.indexOf("看跌期权Put") < src.indexOf("{expChipTitle(prodAlias"), "小方块在 Call/Put 表后面");
  assert.ok(src.includes("deriv.tquote.hideItm"), "开关记本机");
  assert.ok(src.includes('storageGet("deriv.tquote.hideItm") !== "0"'), "未记过本机则默认隐藏实值");
  assert.ok(src.includes("hideItmSide"), "实值侧用 hideItmSide");
  assert.ok(src.includes("undBracket"), "现价卡在相邻两档");
  assert.ok(src.includes("SpotUndRow"), "两档之间插蓝线行");
  assert.ok(src.includes("bg-blue-500"), "蓝线横穿");
  assert.ok(src.includes("spot-und"), "现价行可识别");
  assert.ok(!src.includes("isAtm"), "不再把某一档标成 ATM");
  assert.ok(!src.includes(">ATM</span>"), "行权价旁不写 ATM 字母");
  assert.ok(!src.includes("lastTime.slice(5, 16)"), "不再截成月日暗字");
  assert.ok(src.includes("IvSmileChart"), "T 表左侧挂 IV 微笑");
  assert.ok(src.includes("IvTermChart"), "T 表左侧挂 ATM 隐波期限");
  assert.ok(src.includes("lg:flex-row"), "宽屏微笑+期限在表左");
  assert.ok(src.includes("onPickExp={setExp}"), "点期限月切 T 表");
  assert.ok(src.includes("theoSmile"), "微笑走 surface 原始 theovol, 不画 T 表补档");
  assert.ok(src.includes("spot={fwd}"), "微笑竖线走合成标的现价 forward");
  assert.ok(src.includes("expiry: cur?.expiryDate") || src.includes("expiry: cur.expiryDate"), "点合约带到期日给 markers");
});

test("IvSmileChart LC 复刻 analysis", async () => {
  const smile = await readFile(new URL("../src/components/deriv/IvSmileChart.tsx", import.meta.url), "utf8");
  const math = await readFile(new URL("../src/components/deriv/iv-chart-math.ts", import.meta.url), "utf8");
  const tip = await readFile(new URL("../src/components/deriv/IvHtmlTip.tsx", import.meta.url), "utf8");
  assert.ok(!smile.includes(">IV微笑<"), "标题去掉, 靠水印");
  assert.ok(smile.includes("useLcPriceChart"), "横轴行权价走 createOptionsChart");
  assert.ok(smile.includes("setPaneWatermark"), "IV微笑开淡字水印");
  assert.ok(smile.includes("LcWell"), "跟日K同一套井");
  assert.ok(smile.includes("IvHtmlTip"), "浮窗");
  assert.ok(!tip.includes("bg-white"), "浮窗不白底");
  assert.ok(smile.includes(">今<"), "今");
  assert.ok(smile.includes("OV_YDAY }}>昨<"), "昨标灰色, 免看成第二条紫线");
  assert.ok(smile.includes("rev < 1"), "等 chart boot 完再挂线, 避免叠两条今");
  assert.doesNotMatch(smile, /bag\.current = \{ rev, today: null, yday: null \}/);
  assert.ok(!smile.includes("echarts"), "不走 ECharts");
  assert.ok(!smile.includes("LcHoverTag"), "浮窗不是十字价签");
  assert.ok(smile.includes("synthSpotTipHtml"), "移到竖线才出合成标的现价");
  assert.ok(!smile.includes(">合成标的现价<"), "图上不钉合成标的现价");
  assert.ok(smile.includes("nearSmileStem"), "十字靠近竖线才出合成标的, 不挡图");
  assert.ok(!smile.includes("pointer-events-auto"), "竖线不抢十字");
  assert.ok(smile.includes("smileStemX"), "竖线按窗口线性, 不靠 LC 已有点");
  assert.ok(math.includes("smileStemX"), "合成标的像素X");
  assert.ok(math.includes("smileStemBox"), "合成标的竖茎像素盒");
  assert.ok(!math.includes("spot + eps"), "不再错位X");
  assert.ok(math.includes("合成标的现价"), "浮窗带合成标的");
  assert.ok(!math.includes("yesterday_forward"), "不画昨收竖线");
  assert.ok(math.includes("#a21caf"), "官网紫");
  assert.ok(tip.includes("createPortal"), "浮窗挂 body 不被左栏裁");
  const tq = await readFile(new URL("../src/components/deriv/TQuotePanel.tsx", import.meta.url), "utf8");
  assert.ok(tq.includes("displayLo"), "窗口走 display_strike");
});

test("IvTermChart LC 复刻 vol-ts", async () => {
  const term = await readFile(new URL("../src/components/deriv/IvTermChart.tsx", import.meta.url), "utf8");
  const math = await readFile(new URL("../src/components/deriv/iv-chart-math.ts", import.meta.url), "utf8");
  assert.ok(!term.includes(">IV期限<"), "标题去掉, 靠水印");
  assert.ok(term.includes("atmTermPoints"), "各月 ATM 隐波");
  assert.ok(term.includes("useLcPriceChart"), "横轴天数走 createOptionsChart");
  assert.ok(term.includes("setPaneWatermark"), "IV期限开淡字水印");
  assert.ok(term.includes("subscribeClick"), "点月切表");
  assert.ok(term.includes("IvHtmlTip"), "浮窗");
  assert.ok(term.includes("OV_YDAY }}>昨<"), "昨标灰色");
  assert.ok(term.includes("rev < 1"), "等 chart boot 完再挂线, 避免叠两条今");
  assert.doesNotMatch(term, /bag\.current = \{ rev, today: null, yday: null \}/);
  assert.ok(!term.includes("echarts"), "不走 ECharts");
  assert.ok(!term.includes("volatility-ts"), "不另打 volatility-ts-all");
  assert.ok(math.includes("* 0.05"), "横轴左右扩 5%");
  assert.ok(math.includes("平值隐波"), "悬浮窗标题对齐 vol-ts");
  assert.ok(math.includes("月总持仓量"), "悬浮窗含月总持仓");
});

function termTipHtml(tip) {
  const days = tip.dte != null ? ` · ${Math.round(tip.dte)}天` : "";
  const ivChg = tip.td != null && tip.yd != null ? tip.td - tip.yd : null;
  const hasOi = tip.callTd != null && tip.callYd != null && tip.putTd != null && tip.putYd != null;
  const pcrTd = hasOi && tip.callTd !== 0 ? tip.putTd / tip.callTd : null;
  return { days, ivChg, hasOi, pcrTd };
}

test("termTip 对齐官网 平值隐波 + 月总持仓", () => {
  const tip = termTipHtml({
    exp: "202701",
    dte: 126,
    td: 19.08,
    yd: 19.08,
    callTd: 40,
    callYd: 20,
    putTd: 179,
    putYd: 123,
  });
  assert.equal(tip.days, " · 126天");
  assert.equal(tip.ivChg, 0);
  assert.equal(tip.hasOi, true);
  assert.equal(Number(tip.pcrTd.toFixed(2)), 4.47);
});

function isValidVol(v) {
  return v != null && Number.isFinite(v) && v > 0 && v !== 100;
}

function smileFromStrikes(strikes) {
  const today = [];
  const yday = [];
  for (const s of strikes) {
    const td = num(s.call?.theoIv) ?? num(s.put?.theoIv);
    const yd = num(s.call?.theoIvYd) ?? num(s.put?.theoIvYd);
    if (isValidVol(td)) today.push([s.strike, td]);
    if (isValidVol(yd)) yday.push([s.strike, yd]);
  }
  today.sort((a, b) => a[0] - b[0]);
  yday.sort((a, b) => a[0] - b[0]);
  return { today, yday };
}

function smileYRange(today, yday, lo, hi) {
  const ys = [];
  for (const [x, y] of [...today, ...yday]) {
    if (lo != null && x < lo) continue;
    if (hi != null && x > hi) continue;
    ys.push(y);
  }
  if (!ys.length) return null;
  return [Math.min(...ys) - 1, Math.max(...ys) + 1];
}

function smileXRange(today, yday, lo, hi) {
  if (lo != null && hi != null && hi > lo) return [lo, hi];
  const xs = [...today, ...yday].map((p) => p[0]);
  if (!xs.length) return null;
  return [Math.min(...xs), Math.max(...xs)];
}

function smileStemX(spot, from, to, width) {
  if (spot == null || from == null || to == null) return null;
  if (![spot, from, to, width].every(Number.isFinite) || !(to > from) || width < 2) return null;
  const x = ((spot - from) / (to - from)) * width;
  if (x < 0 || x > width) return null;
  return x;
}

function nearSmileStem(px, stemX, hit = 7) {
  return px != null && stemX != null && Number.isFinite(px) && Number.isFinite(stemX)
    && Math.abs(px - stemX) <= hit;
}

test("smileStemX 按窗口线性, 合成价不必是行权价", () => {
  assert.equal(smileStemX(100, 0, 200, 200), 100);
  assert.equal(smileStemX(3850, 3500, 4200, 350), 175);
  assert.equal(smileStemX(100, 100, 100, 200), null);
  assert.equal(smileStemX(-10, 0, 200, 200), null);
  assert.equal(smileStemX(250, 0, 200, 200), null);
  assert.equal(smileStemX(0, 0, 200, 200), 0);
});

test("nearSmileStem 十字靠近竖线", () => {
  assert.equal(nearSmileStem(100, 100), true);
  assert.equal(nearSmileStem(107, 100), true);
  assert.equal(nearSmileStem(108, 100), false);
  assert.equal(nearSmileStem(100, null), false);
});

test("smileFromStrikes 用拟合隐波, 丢掉 100 占位", () => {
  const strikes = [
    { strike: 90, call: { theoIv: 24, theoIvYd: 25 }, put: { theoIv: 24, theoIvYd: 25 } },
    { strike: 100, call: { theoIv: 20, theoIvYd: 21 }, put: { theoIv: 20, theoIvYd: 21 } },
    { strike: 110, call: { theoIv: 100, theoIvYd: 23 }, put: { theoIv: 100, theoIvYd: 23 } },
  ];
  const all = smileFromStrikes(strikes);
  assert.deepEqual(all.today.map((p) => p[0]), [90, 100]);
  assert.equal(all.today[1][1], 20);
  assert.deepEqual(smileXRange(all.today, all.yday, 95, 105), [95, 105]);
  assert.deepEqual(smileYRange(all.today, all.yday, 95, 105), [19, 22]);
});

function atmTermPoints(expiries) {
  const today = [];
  const yday = [];
  for (const e of expiries) {
    const x = num(e.dte);
    if (x === null) continue;
    const iv = num(e.atmIv);
    if (isValidVol(iv)) today.push({ x, y: iv, exp: e.exp });
    const yd = num(e.atmIvYd);
    if (isValidVol(yd)) yday.push({ x, y: yd, exp: e.exp });
  }
  today.sort((a, b) => a.x - b.x);
  yday.sort((a, b) => a.x - b.x);
  return { today, yday };
}

function termXRange(today, yday) {
  const xs = [...today, ...yday].map((p) => p.x);
  if (!xs.length) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.05, hi === lo ? 1 : 0);
  return [lo - pad, hi + pad];
}

function nearestTermExp(pts, t) {
  if (!pts.length || !Number.isFinite(t)) return null;
  let best = pts[0];
  let dist = Math.abs(pts[0].x - t);
  for (const p of pts) {
    const d = Math.abs(p.x - t);
    if (d < dist) {
      dist = d;
      best = p;
    }
  }
  return best.exp;
}

test("atmTermPoints 按剩余天数排, 缺 dte/IV 丢掉", () => {
  const { today, yday } = atmTermPoints([
    { exp: "202611", dte: 54, atmIv: 18, atmIvYd: 17 },
    { exp: "202610", dte: 17, atmIv: 20, atmIvYd: null },
    { exp: "202612", dte: null, atmIv: 16, atmIvYd: 16 },
    { exp: "202701", dte: 80, atmIv: null, atmIvYd: 15 },
  ]);
  assert.deepEqual(today.map((p) => p.exp), ["202610", "202611"]);
  assert.deepEqual(today.map((p) => p.x), [17, 54]);
  assert.deepEqual(yday.map((p) => p.exp), ["202611", "202701"]);
  assert.deepEqual(termXRange(today, yday), [17 - (80 - 17) * 0.05, 80 + (80 - 17) * 0.05]);
});

test("nearestTermExp 点最近一个月", () => {
  const pts = [
    { x: 17, y: 20, exp: "202610" },
    { x: 54, y: 18, exp: "202611" },
  ];
  assert.equal(nearestTermExp(pts, 20), "202610");
  assert.equal(nearestTermExp(pts, 50), "202611");
  assert.equal(nearestTermExp([], 20), null);
  assert.equal(nearestTermExp(pts, Number.NaN), null);
});

test("undBracket 现价夹在相邻两档, 贴档用本档与更高档", () => {
  assert.deepEqual(undBracket([90, 100, 110], 105), { lo: 100, hi: 110 });
  assert.deepEqual(undBracket([90, 100, 110], 100), { lo: 100, hi: 110 });
  assert.deepEqual(undBracket([90, 100, 110], 90), { lo: 90, hi: 100 });
  assert.equal(undBracket([90, 100, 110], 80), null);
  assert.equal(undBracket([90, 100, 110], 120), null);
  assert.equal(undBracket([100], 100), null);
  assert.equal(undBracket([90, 100], null), null);
});

test("hideItmSide 藏实值侧, 夹档两边都留", () => {
  assert.equal(hideItmSide("call", 90, 100, 100, true), true);
  assert.equal(hideItmSide("put", 90, 100, 100, true), false);
  assert.equal(hideItmSide("put", 110, 100, 100, true), true);
  assert.equal(hideItmSide("call", 110, 100, 100, true), false);
  assert.equal(hideItmSide("call", 100, 100, 100, true), false);
  assert.equal(hideItmSide("put", 100, 100, 100, true), false);
  assert.equal(hideItmSide("call", 90, 100, 100, false), false);
  assert.equal(hideItmSide("call", 90, null, 100, true), false);
  assert.equal(hideItmSide("call", 90, 105, [100, 110], true), true);
  assert.equal(hideItmSide("put", 110, 105, [100, 110], true), false);
  assert.equal(hideItmSide("call", 100, 105, [100, 110], true), false);
});

function expMd(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[2]}.${m[3]}` : "-";
}

function expChipTitle(alias, exp) {
  return `${alias}${String(exp ?? "").slice(-4)}`;
}

test("expChip 乙二醇2610 / 09.16 剩26天", () => {
  assert.equal(expChipTitle("乙二醇", "202610"), "乙二醇2610");
  assert.equal(expMd("20260916"), "09.16");
  assert.equal(expMd("2026-09-16"), "09.16");
  assert.equal(expMd(""), "-");
});

test("maxOiVal 取购沽两侧最大值", () => {
  const strikes = [mk(90, 100, 50), mk(100, 20, 800), mk(110, 40, 10)];
  assert.equal(maxOiVal(strikes), 800);
});
