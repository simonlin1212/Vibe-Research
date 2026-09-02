import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("event page reuses telegraphHub and event calendar", () => {
  const page = readFileSync(join(root, "src/pages/EventCockpit.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  const hub = readFileSync(join(root, "src/lib/telegraphHub.ts"), "utf8");
  assert.match(page, /资讯页快照/);
  assert.match(page, /NewsTriple/);
  assert.match(page, /peekTelegraphItems/);
  assert.match(page, /FEED_SOURCES/);
  assert.match(page, /EventCalPanel/);
  assert.match(page, /api\.eventCalendar/);
  assert.ok(page.indexOf("event-cal") < page.indexOf("event-news"), "财经日历在左");
  const cal = readFileSync(join(root, "src/components/event/EventCalPanel.tsx"), "utf8");
  assert.match(cal, /export function labelCalDay/);
  assert.match(cal, /今天/);
  assert.match(cal, /明天/);
  assert.match(cal, /周一/);
  assert.match(cal, /grid-cols-\[1fr_auto_1fr\]/, "日期居中, 今天和条数分列两边");
  assert.match(cal, /WD_TONE/, "周一到周日字色");
  assert.match(cal, /lab\.tone/);
  assert.match(cal, /text-\[13px\] leading-snug/, "日历正文比驾驶舱默认 11px 大一档");
  assert.match(api, /eventCalendar/);
  assert.match(api, /\/event\/calendar/);
  assert.doesNotMatch(page, /clsTelegraph\(/);
  assert.doesNotMatch(page, /marketLives\(/);
  assert.doesNotMatch(page, /useQuotes/);
  assert.doesNotMatch(page, /quoteHub/);
  assert.doesNotMatch(page, /polymarket/i);
  assert.doesNotMatch(page, /PmPanel/);
  assert.doesNotMatch(api, /polymarket/i);
  assert.match(hub, /export function peekTelegraphItems/);
});

test("event page hangs three public rank boards", () => {
  const page = readFileSync(join(root, "src/pages/EventCockpit.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  const rank = readFileSync(join(root, "src/components/event/EventRankPanel.tsx"), "utf8");
  assert.match(page, /api\.eventRanks/);
  assert.match(page, /event-sopilot/);
  assert.match(page, /event-hot/);
  assert.match(page, /event-aihot/);
  assert.doesNotMatch(page, /id: "event-newsnow"/);
  assert.doesNotMatch(page, /id: "event-rebang"/);
  assert.ok(page.indexOf("event-news") < page.indexOf("event-sopilot"), "热榜在第二行");
  assert.ok(page.indexOf("event-hot") < page.indexOf("event-aihot"), "合成热榜在 AIHOT 前");
  assert.match(api, /eventRanks/);
  assert.match(api, /\/event\/ranks/);
  assert.match(api, /aihot\?/);
  assert.match(rank, /export function RankList/);
  assert.match(rank, /export function pickTab/);
  assert.match(rank, /export function mergeHotTabs/);
  assert.match(rank, /export function RankBoard/);
  assert.match(rank, /wrap \? "flex-wrap"/);
  assert.match(page, /<RankBoard/);
  const panel = readFileSync(join(root, "src/components/cockpit/Panel.tsx"), "utf8");
  assert.match(panel, /h2 className="shrink-0/);
  assert.doesNotMatch(rank, /lg:max-w-\[36vw\]/);
  assert.match(page, /东方财富/);
  assert.match(page, /X起爆/);
  assert.match(page, /AIHOT/);
  assert.match(page, /#1d9bf0/);
  assert.match(page, /#c084fc/);
  assert.match(page, /主题/);
  assert.doesNotMatch(page, /telegraphHub.*ranks|clsTelegraph/);
  assert.doesNotMatch(page, /useQuotes/);
});

test("mergeHotTabs keeps NewsNow first and aliases 金十数据", () => {
  const rank = readFileSync(join(root, "src/components/event/EventRankPanel.tsx"), "utf8");
  assert.match(rank, /NewsNow first, then REBANG uniques/);
  assert.match(rank, /金十数据: "金十"/);
  assert.match(rank, /HOT_DROP = new Set\(\["雪球"\]\)/);
  assert.match(rank, /for \(const t of newsnow/);
  assert.match(rank, /for \(const t of rebang/);
});

function labelCalDay(iso, today) {
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const d = parse(iso);
  const t = parse(today);
  const wd = WEEK[d.getDay()];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const rel = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === -1 ? "昨天" : "";
  return { title: [rel, wd, md].filter(Boolean).join(" "), weekend: d.getDay() === 0 || d.getDay() === 6 };
}

test("labelCalDay 写成 今天周一8/24, 不是 2026-08-24", () => {
  assert.deepEqual(labelCalDay("2026-08-24", "2026-08-24"), { title: "今天 周一 8/24", weekend: false });
  assert.deepEqual(labelCalDay("2026-08-25", "2026-08-24"), { title: "明天 周二 8/25", weekend: false });
  assert.deepEqual(labelCalDay("2026-08-30", "2026-08-24"), { title: "周日 8/30", weekend: true });
});
