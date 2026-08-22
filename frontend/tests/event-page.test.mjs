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
  assert.match(page, /api\.polymarketWatch/);
  assert.match(page, /event\.pm\.watch|addPmWatch|loadPmWatch/);
  assert.match(page, /api\.polymarketBoard/);
  assert.match(page, /api\.polymarketSearch/);
  assert.match(api, /polymarketWatch/);
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
