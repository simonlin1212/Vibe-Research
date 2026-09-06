import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarFromEnvelope, resolveSession, type CalendarFacts } from "../src/finance/session.ts";

const base: CalendarFacts = {
  last_trading_day: "2026-08-26",
  previous_trading_day: "2026-08-25",
  is_today_trading_day: true,
  session_phase: "trading",
};

test("上游真实非交易日枚举保留，不降为 unknown", () => {
  const facts = calendarFromEnvelope({ evidence: Object.entries({ ...base,
    is_today_trading_day: false, session_phase: "non_trading_day" }).map(([field, value]) => ({ field, value })) });
  assert.equal(facts?.session_phase, "non_trading_day");
  const context = resolveSession(facts!);
  assert.equal(context.review_date, base.last_trading_day);
  assert.equal(context.intraday, false);
  assert.match(context.review_reason, /不是交易日/);
});

test("🔴 盘中看上一个交易日 —— 今天还没结束,半天的数据不是复盘", () => {
  const r = resolveSession({ ...base, session_phase: "trading" });
  assert.equal(r.review_date, "2026-08-25");
  assert.equal(r.intraday, true);
  assert.match(r.review_reason, /还没收盘/);
});

test("盘前也看上一个交易日(今天连开都没开)", () => {
  const r = resolveSession({ ...base, session_phase: "pre_open" });
  assert.equal(r.review_date, "2026-08-25");
  assert.equal(r.intraday, false, "盘前不是盘中");
});

test("收盘后才看今天", () => {
  for (const phase of ["post_close", "closed"] as const) {
    const r = resolveSession({ ...base, session_phase: phase });
    assert.equal(r.review_date, "2026-08-26", phase);
    assert.equal(r.intraday, false);
    assert.match(r.review_reason, /已收盘/);
  }
});

test("非交易日看最近一个交易日", () => {
  const r = resolveSession({ ...base, is_today_trading_day: false, session_phase: "closed", last_trading_day: "2026-08-22" });
  assert.equal(r.review_date, "2026-08-22");
  assert.match(r.review_reason, /不是交易日/);
});

test("🔴 拿不到时段时**保守退回上一个交易日**,不猜成收盘", () => {
  const r = resolveSession({ ...base, session_phase: "unknown" });
  assert.equal(r.review_date, "2026-08-25", "宁可显示一天前的完整数据,也不要把半天的盘中数据当复盘");
  assert.match(r.review_reason, /拿不到当前时段/, "要说清为什么,别让用户以为产品在乱跳");
});

test("🔴 日期形状不对就抛错,不猜 —— 猜错一天整页都是错的日子,而且看不出来", () => {
  for (const bad of ["", "2026/08/26", "昨天", "20260826"]) {
    assert.throws(() => resolveSession({ ...base, previous_trading_day: bad }), /previous_trading_day/, bad);
    assert.throws(() => resolveSession({ ...base, last_trading_day: bad }), /last_trading_day/, bad);
  }
});

test("从信封挑事实:认不出的时段一律 unknown,不默认成任何一种", () => {
  const mk = (evidence: { field: string; value: unknown }[]) => calendarFromEnvelope({ evidence });
  const good = mk([
    { field: "last_trading_day", value: "2026-08-26" },
    { field: "previous_trading_day", value: "2026-08-25" },
    { field: "is_today_trading_day", value: true },
    { field: "session_phase", value: "trading" },
  ]);
  assert.equal(good?.session_phase, "trading");
  assert.equal(good?.is_today_trading_day, true);

  // 上游给了个没见过的时段:不能默认成 trading / closed —— 那会让"看哪一天"静默错掉
  const weird = mk([
    { field: "last_trading_day", value: "2026-08-26" },
    { field: "previous_trading_day", value: "2026-08-25" },
    { field: "session_phase", value: "lunch_break" },
  ]);
  assert.equal(weird?.session_phase, "unknown");
  assert.equal(weird?.is_today_trading_day, false, "没给就是 false,不臆测");

  // 缺日期 → null,让调用方知道"拿不到",而不是拿一个编出来的日子往下跑
  assert.equal(mk([{ field: "session_phase", value: "trading" }]), null);
  assert.equal(calendarFromEnvelope({}), null);
});
