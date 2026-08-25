import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sessionSrc = readFileSync(join(root, "src/lib/ashareSession.ts"), "utf8");
const apiSrc = readFileSync(join(root, "src/lib/api.ts"), "utf8");

function beijingParts(now) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const weekday = wdMap[parts.weekday] ?? now.getDay();
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function kind(now, tradingDay = null) {
  if (tradingDay === false) return "off";
  const { weekday, minutes } = beijingParts(now);
  if (weekday === 0 || weekday === 6) return "off";
  if (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) return "open";
  if (minutes >= 13 * 60 && minutes < 15 * 60) return "open";
  if (minutes >= 9 * 60 + 15 && minutes < 9 * 60 + 30) return "open";
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) return "off";
  if (minutes >= 15 * 60) return "closed";
  return "off";
}

function hubPollMs(openMs, now, tradingDay = null, offshore = false) {
  if (kind(now, tradingDay) === "open") return openMs;
  return offshore ? 5_000 : 60_000;
}

/** UTC instant that is this Beijing wall clock. */
function bj(y, m, d, hh, mm) {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
}

test("warmup status is the only trading_day fetch", () => {
  assert.match(apiSrc, /reviewWarmup: \(\) => get<ReviewWarmupStatus>\("\/market\/review-warmup"\)/);
  assert.match(sessionSrc, /api\.reviewWarmup\(\)/);
  assert.equal((sessionSrc.match(/reviewWarmup/g) || []).length, 1);
});

test("clock: open session keeps 5s, rest stretches to 60s", () => {
  assert.equal(hubPollMs(5000, bj(2026, 8, 17, 10, 0)), 5000);
  assert.equal(hubPollMs(5000, bj(2026, 8, 17, 9, 20)), 5000);
  assert.equal(hubPollMs(5000, bj(2026, 8, 17, 12, 0)), 60_000);
  assert.equal(hubPollMs(5000, bj(2026, 8, 17, 20, 0)), 60_000);
  assert.equal(hubPollMs(5000, bj(2026, 8, 16, 10, 0)), 60_000);
  assert.equal(hubPollMs(5000, bj(2026, 8, 17, 20, 0), null, true), 5_000);
});

test("trading_day false wins over weekday auction hours", () => {
  assert.equal(hubPollMs(5000, bj(2026, 10, 1, 10, 0), false), 60_000);
  assert.equal(hubPollMs(20000, bj(2026, 10, 1, 10, 0), false), 60_000);
  assert.equal(hubPollMs(20000, bj(2026, 10, 1, 10, 0), false, true), 5_000);
});
