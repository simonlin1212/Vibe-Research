/**
 * **交易时段与业务日期解析**(金融垂类)。
 *
 * 回答一个问题:**这一页现在该显示哪一天的数据?**
 *   · 交易日、收盘前 → 上一个交易日(盘中看不了今天的复盘,今天还没结束)
 *   · 交易日、收盘后 → 今天
 *   · 非交易日      → 最近一个交易日
 *
 * 🔴 **前端不许自己按本地时间推算**。用户机器的时区、夏令时、系统时钟都不可信;
 *    而且"今天是不是交易日"要查日历,前端猜不出来。⇒ 由后端解析,页面拿到的是**结果**。
 *
 * 🔴 **`session_phase` 绝不能被缓存**(注册表已给 `fetch_trade_calendar` 标 `cache_max_age_sec: 0`)。
 *    它是"按此刻算出来的",缓存住就变成:上午存了 `trading`,晚上再打开还是 `trading`,
 *    而且永远不会自己好 —— 而整个"复盘看哪一天"都建在它上面(Codex 架构评审 arch-r1 §B)。
 *
 * ⚠️ 这里**只解析、不取数**:日历数据由调用方传进来。这样它可测、可复算,
 *    也不会在"要不要取数"和"今天是不是交易日"之间绕成循环。
 * ⚠️ 与 `quote_freshness.ts` 不重叠:那个回答"**这条报价**是不是陈旧的"(研究运行的 validator 用),
 *    这个回答"**这一页**该显示哪一天"。
 */

/** 交易时段。`unknown` = 上游没给,**别当成任何一种**猜 */
export type SessionPhase = "pre_open" | "trading" | "post_close" | "closed" | "non_trading_day" | "unknown";

export interface CalendarFacts {
  /** 最近一个交易日(含今天,如果今天是交易日) */
  last_trading_day: string;
  /** 上一个交易日(不含今天) */
  previous_trading_day: string;
  is_today_trading_day: boolean;
  session_phase: SessionPhase;
}

export interface SessionContext extends CalendarFacts {
  /** 复盘该看哪一天 */
  review_date: string;
  /** 为什么是这一天 —— **要显示给用户**,否则他不知道为何看到的是昨天 */
  review_reason: string;
  /** 盘中 = 当天还在变,复盘数据不完整 */
  intraday: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 从日历事实推出业务日期。
 * @throws 日期字段形状不对时抛错 —— **不猜**:猜错一天,整页复盘都是错的日子,而且看不出来。
 */
export function resolveSession(f: CalendarFacts): SessionContext {
  for (const [k, v] of [["last_trading_day", f.last_trading_day], ["previous_trading_day", f.previous_trading_day]] as const) {
    if (!DATE_RE.test(String(v))) throw new Error(`交易日历的 ${k} 不是 YYYY-MM-DD:${JSON.stringify(v)}`);
  }
  // 收盘后才算"今天已经结束";盘前与盘中都还没有今天的完整数据
  const closedToday = f.is_today_trading_day && (f.session_phase === "post_close" || f.session_phase === "closed");

  if (!f.is_today_trading_day) {
    return { ...f, review_date: f.last_trading_day, review_reason: "今天不是交易日,显示最近一个交易日", intraday: false };
  }
  if (closedToday) {
    return { ...f, review_date: f.last_trading_day, review_reason: "今天已收盘,显示今天", intraday: false };
  }
  // 盘前 / 盘中 / 上游没给时段:一律退回上一个交易日。
  // 🔴 `unknown` 走这条是**刻意的保守**:宁可显示一天前的完整数据,
  //    也不要把半天的盘中数据当成"今天的复盘" —— 后者看不出是错的。
  const why =
    f.session_phase === "unknown"
      ? "拿不到当前时段,保守显示上一个交易日(半天的盘中数据不能当复盘)"
      : "今天还没收盘,显示上一个交易日";
  return { ...f, review_date: f.previous_trading_day, review_reason: why, intraday: f.session_phase === "trading" };
}

const PHASES: SessionPhase[] = ["pre_open", "trading", "post_close", "closed", "non_trading_day"];

/**
 * 从取数信封里挑出日历事实。
 * ⚠️ 认不出的时段一律 `unknown`,**不要默认成 `trading` 或 `closed`** ——
 *    默认成任何一个都会让"该看哪一天"静默地错掉。
 */
export function calendarFromEnvelope(env: { evidence?: { field?: string; value?: unknown }[] }): CalendarFacts | null {
  const get = (f: string): unknown => (env.evidence ?? []).find((e) => e.field === f)?.value;
  const last = String(get("last_trading_day") ?? "");
  const prev = String(get("previous_trading_day") ?? "");
  if (!DATE_RE.test(last) || !DATE_RE.test(prev)) return null;
  const phase = String(get("session_phase") ?? "");
  return {
    last_trading_day: last,
    previous_trading_day: prev,
    is_today_trading_day: get("is_today_trading_day") === true,
    session_phase: (PHASES as string[]).includes(phase) ? (phase as SessionPhase) : "unknown",
  };
}
