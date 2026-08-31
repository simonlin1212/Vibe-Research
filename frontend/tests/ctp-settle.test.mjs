import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function liveSettlePreview(opts) {
  const liveEq = opts.equity;
  if (liveEq == null || !Number.isFinite(Number(liveEq))) return null;
  const td = (opts.tradingDay || "").replace(/-/g, "");
  const date = /^\d{8}$/.test(td)
    ? `${td.slice(0, 4)}-${td.slice(4, 6)}-${td.slice(6, 8)}`
    : opts.fallbackDate;
  const perf = opts.perf || [];
  if (perf.some((p) => p.date === date)) return null;
  const last = perf.length ? perf[perf.length - 1] : null;
  if (!last || last.date === date) return null;
  const prevEq = Number(last.equity);
  if (!Number.isFinite(prevEq)) return null;
  const dw = Number(opts.deposit || 0) - Number(opts.withdraw || 0);
  const comm = Number(opts.commission || 0);
  const dailyPnl = Number(liveEq) - prevEq - dw;
  const dailyRet = prevEq ? dailyPnl / prevEq : 0;
  return {
    date,
    tradingDay: date.replace(/-/g, ""),
    equity: Number(liveEq),
    dailyPnl,
    dailyIncome: dailyPnl - comm,
    dailyRet,
    commission: comm,
    depositWithdraw: dw,
    nav: Number(last.nav) * (1 + dailyRet),
    cumIncome: Number(last.cum_income ?? last.cum_pnl) + (dailyPnl - comm),
  };
}

function foldLiveSummary(s, perf, live) {
  if (!live) return s;
  const hist = Math.max(0, s.days - 1);
  const n = hist + 1;
  const avg = (s.avg_daily_return * hist + live.dailyRet) / n;
  const rows = (perf || []).slice(1).map((p) => Number(p.daily_return || 0)).concat(live.dailyRet);
  let sharpe = null;
  if (rows.length >= 2) {
    const mean = rows.reduce((a, r) => a + r, 0) / rows.length;
    const std = Math.sqrt(rows.reduce((a, r) => a + (r - mean) ** 2, 0) / (rows.length - 1));
    sharpe = std > 1e-12 ? (mean / std) * Math.sqrt(242) : null;
  }
  const peak = Math.max(0, ...(perf || []).map((p) => Number(p.nav) || 0), live.nav);
  const liveDd = peak > 0 ? live.nav / peak - 1 : 0;
  let win = s.win_days;
  let loss = s.loss_days;
  if (live.dailyPnl > 1e-9) win += 1;
  else if (live.dailyPnl < -1e-9) loss += 1;
  const decided = win + loss;
  return {
    ...s,
    days: s.days + 1,
    total_pnl: s.total_pnl + live.dailyPnl,
    total_return: live.nav - 1,
    nav: live.nav,
    max_drawdown: Math.min(s.max_drawdown, liveDd),
    win_days: win,
    loss_days: loss,
    win_rate: decided ? win / decided : null,
    ann_return: annReturnNatural(live.nav, s.start_date, live.date),
    sharpe,
  };
}

function annReturnNatural(nav, start, end) {
  if (!start || !end || !Number.isFinite(nav) || nav <= 0) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const span = Math.round((b - a) / 86_400_000);
  if (span <= 0) return null;
  return nav ** (365 / span) - 1;
}

test("今日预估叠进年化, 结算单已出则不再加", () => {
  const last = { date: "2026-08-20", equity: 1_000_000, nav: 1.1, cum_pnl: 10000 };
  const live = liveSettlePreview({
    equity: 1_010_000,
    tradingDay: "20260821",
    deposit: 0,
    withdraw: 0,
    commission: 0,
    perf: [last],
    fallbackDate: "2026-08-21",
  });
  assert.equal(live.date, "2026-08-21");
  assert.equal(live.dailyRet, 0.01);
  const settled = liveSettlePreview({
    equity: 1_010_000,
    tradingDay: "20260820",
    perf: [last],
    fallbackDate: "2026-08-21",
  });
  assert.equal(settled, null);
  const year = annReturnNatural(1.1, "2026-01-01", "2027-01-01");
  assert.ok(year != null && Math.abs(year - 0.1) < 1e-9);
  assert.equal(annReturnNatural(1.1, "2026-08-20", "2026-08-20"), null);
});

test("今日预估叠进回撤胜率Sharpe", () => {
  const last = { date: "2026-08-20", equity: 1_000_000, nav: 1.1, daily_return: 0.01, cum_pnl: 10000 };
  const live = liveSettlePreview({
    equity: 1_045_000,
    tradingDay: "20260821",
    perf: [last],
    fallbackDate: "2026-08-21",
  });
  const s = foldLiveSummary({
    days: 2,
    start_date: "2026-08-19",
    avg_daily_return: 0.01,
    total_pnl: 10000,
    max_drawdown: -0.02,
    win_days: 1,
    loss_days: 0,
    win_rate: 1,
    nav: 1.1,
    sharpe: 1,
  }, [{ date: "2026-08-19", nav: 1.0, daily_return: 0 }, last], live);
  assert.equal(s.days, 3);
  assert.ok(s.ann_return > 0);
  assert.equal(s.win_days, 2);
  assert.ok(s.sharpe != null);
  assert.ok(s.max_drawdown <= 0);
});

test("结算卡用同一套今日预估叠全部指标", async () => {
  const utils = await readFile(new URL("../src/components/portfolio/ctpUtils.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../src/components/portfolio/CtpPortfolio.tsx", import.meta.url), "utf8");
  assert.match(utils, /export function liveSettlePreview/);
  assert.match(utils, /export function foldLiveSummary/);
  assert.match(utils, /export function foldLiveMonthly/);
  assert.match(utils, /export function annReturnNatural/);
  assert.match(utils, /365 \/ span/);
  const py = await readFile(new URL("../../backend/ctp/settlement.py", import.meta.url), "utf8");
  assert.match(py, /年化按自然日 365/);
  assert.doesNotMatch(py, /年化按 242 交易日/);
  assert.match(port, /foldLiveSummary/);
  assert.match(port, /foldLiveMonthly/);
  assert.match(port, /buildCalDays\(rangeData, live\)/);
  assert.match(port, /含今日实时/);
  assert.match(port, /document\.hidden/);
  assert.match(port, /visibilitychange/);
  assert.match(port, /if \(!settleOpen\) return/);
  assert.match(port, /\[loggedIn, data, settleOpen\]/);
  assert.doesNotMatch(port, /from "echarts"/);
  assert.match(port, /CtpSettleChart/);
  const chart = await readFile(new URL("../src/components/portfolio/CtpSettleChart.tsx", import.meta.url), "utf8");
  assert.match(chart, /from "echarts"/);
  assert.match(chart, /liveSettlePreview/);
});
