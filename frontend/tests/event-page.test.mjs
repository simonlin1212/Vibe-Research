import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("event page reuses telegraphHub and one polymarket board", () => {
  const page = readFileSync(join(root, "src/pages/EventCockpit.tsx"), "utf8");
  const panel = readFileSync(join(root, "src/components/event/PmPanel.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  const hub = readFileSync(join(root, "src/lib/telegraphHub.ts"), "utf8");
  assert.match(page, /NewsCockpitPanel/);
  assert.match(page, /peekTelegraphItems/);
  assert.match(page, /EventCalPanel/);
  assert.match(page, /api\.eventCalendar/);
  const cal = readFileSync(join(root, "src/components/event/EventCalPanel.tsx"), "utf8");
  assert.match(cal, /export function labelCalDay/);
  assert.match(cal, /今天/);
  assert.match(cal, /明天/);
  assert.match(cal, /周一/);
  assert.match(page, /api\.polymarketWatch/);
  assert.match(page, /event\.pm\.watch|addPmWatch|loadPmWatch/);
  assert.match(page, /api\.polymarketBoard/);
  assert.match(page, /api\.polymarketSearch/);
  assert.match(api, /polymarketWatch/);
  assert.match(api, /eventCalendar/);
  assert.match(api, /\/event\/calendar/);
  const watch = readFileSync(join(root, "src/lib/pmWatch.ts"), "utf8");
  assert.match(watch, /event\.pm\.watch/);
  assert.doesNotMatch(watch, /nato-x-russia/);
  assert.doesNotMatch(page, /clsTelegraph\(/);
  assert.doesNotMatch(page, /marketLives\(/);
  assert.doesNotMatch(page, /useQuotes/);
  assert.doesNotMatch(page, /quoteHub/);
  assert.match(api, /polymarketBoard/);
  assert.match(api, /\/polymarket\/board/);
  assert.match(hub, /export function peekTelegraphItems/);
  assert.match(panel, /extractSlug/);
  assert.match(panel, /polymarket\.com\/event\//);
});

function extractSlugs(raw) {
  const out = [];
  const text = raw.trim();
  const re = /polymarket\.com\/event\/([a-zA-Z0-9-]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[1].toLowerCase();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

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

test("extractSlugs reads one or many polymarket event urls", () => {
  assert.deepEqual(
    extractSlugs("https://polymarket.com/event/nato-x-russia-military-clash-in-2025"),
    ["nato-x-russia-military-clash-in-2025"],
  );
  assert.deepEqual(
    extractSlugs(
      "https://polymarket.com/event/nato-x-russia-military-clash-in-2025\nhttps://polymarket.com/event/what-price-will-wti-hit-in-august-2026",
    ),
    ["nato-x-russia-military-clash-in-2025", "what-price-will-wti-hit-in-august-2026"],
  );
  assert.deepEqual(extractSlugs("iran blockade"), []);
});
