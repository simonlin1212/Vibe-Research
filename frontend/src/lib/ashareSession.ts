/** A-share session from Beijing clock. Holidays come from 交易日历 via warmup trading_day. */

import { api } from "@/lib/api";

export type AShareSessionKind = "open" | "closed" | "off";

export interface AShareSession {
  kind: AShareSessionKind;
  /** Short chip label */
  label: string;
  /** One-line hint */
  hint: string;
}

/** Quote / minute hub interval when not in continuous auction. */
export const HUB_POLL_CLOSED_MS = 60_000;

/** 外盘 quotes and minutes stay at 5s while A-share is closed. */
export const HUB_POLL_FUTURES_MS = 5_000;

/** null = calendar not loaded; false = 休市 (weekend or holiday). */
let _tradingDay: boolean | null = null;
let _primed = false;
let _prime: Promise<void> | null = null;

export function setTradingDay(ok: boolean | null) {
  _tradingDay = ok;
}

/** One fetch of warmup status. Hubs share this; not a second cache key. */
export function primeTradingDay(): Promise<void> {
  if (_primed) return Promise.resolve();
  if (_prime) return _prime;
  _prime = api.reviewWarmup()
    .then((s) => {
      if (typeof s.trading_day === "boolean") setTradingDay(s.trading_day);
    })
    .catch(() => {
      /* clock-only fallback; do not skip a real session */
    })
    .finally(() => {
      _primed = true;
      _prime = null;
    });
  return _prime;
}

export function hubPollMs(openMs: number, now: Date = new Date(), offshore = false): number {
  if (getAShareSession(now).kind === "open") return openMs;
  return offshore ? HUB_POLL_FUTURES_MS : HUB_POLL_CLOSED_MS;
}

function beijingParts(now: Date): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const weekday = wdMap[parts.weekday ?? ""] ?? now.getDay();
  const hour = Number(parts.hour ?? "0");
  const minute = Number(parts.minute ?? "0");
  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Approximate session: weekend / lunch / after-close → off or closed;
 * continuous auction windows → open. trading_day=false from 交易日历 wins.
 */
export function getAShareSession(now: Date = new Date()): AShareSession {
  if (_tradingDay === false) {
    return { kind: "off", label: "休市", hint: "今日休市 · 数据可能为上一交易日" };
  }
  const { weekday, minutes } = beijingParts(now);
  if (weekday === 0 || weekday === 6) {
    return { kind: "off", label: "休市", hint: "周末休市 · 数据可能为上一交易日" };
  }

  const amOpen = 9 * 60 + 30;
  const amClose = 11 * 60 + 30;
  const pmOpen = 13 * 60;
  const pmClose = 15 * 60;
  const preOpen = 9 * 60 + 15;

  if (minutes >= amOpen && minutes < amClose) {
    return { kind: "open", label: "交易中", hint: "上午连续竞价 09:30–11:30" };
  }
  if (minutes >= pmOpen && minutes < pmClose) {
    return { kind: "open", label: "交易中", hint: "下午连续竞价 13:00–15:00" };
  }
  if (minutes >= preOpen && minutes < amOpen) {
    return { kind: "open", label: "交易中", hint: "集合竞价时段 · 连续竞价即将开始" };
  }
  if (minutes >= amClose && minutes < pmOpen) {
    return { kind: "off", label: "休市", hint: "午间休市 11:30–13:00" };
  }
  if (minutes >= pmClose) {
    return { kind: "closed", label: "已收盘", hint: "今日已收盘 · 非交易时段数据可能静止" };
  }
  return { kind: "off", label: "休市", hint: "今日尚未开盘 · 非交易时段或源暂不可用时属正常" };
}
