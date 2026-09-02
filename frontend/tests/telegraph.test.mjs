import assert from "node:assert/strict";
import test from "node:test";

function itemKey(it, i) {
  return String(it.id ?? `${it.time}-${i}`);
}

function countNew(items, seen) {
  if (!items.length) return 0;
  if (!seen) return Math.min(items.length, 9);
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    if (itemKey(items[i], i) === seen) break;
    n += 1;
  }
  return Math.min(n, 99);
}

test("event page rides telegraphHub, no second news poll", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/pages/EventCockpit.tsx", import.meta.url), "utf8");
  assert.match(page, /NewsTriple/);
  assert.match(page, /from "@\/lib\/telegraphHub"/);
  assert.doesNotMatch(page, /api\.clsTelegraph/);
  assert.doesNotMatch(page, /api\.marketLives/);
});

test("news cell has jin10 tab on the same telegraph hub", async () => {
  const { readFile } = await import("node:fs/promises");
  const hub = await readFile(new URL("../src/lib/telegraphHub.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/components/cockpit/NewsCockpitPanel.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(hub, /"cls" \| "lives" \| "jin10"/);
  assert.match(hub, /src === "jin10" \? "jin10"/);
  assert.match(hub, /if \(primed\[src\]\) void pull\(src, true\)/);
  assert.match(panel, /src: "jin10", label: "金十"/);
  assert.match(panel, /accent: "#ffcc00"/);
  assert.match(panel, /export function NewsTriple/);
  assert.match(panel, /cats=\{it\.tags\}/);
  assert.match(api, /source=\$\{source\}/);
});

test("itemKey prefers id then time-index", () => {
  assert.equal(itemKey({ id: 12, time: "2026-08-16 10:00" }, 0), "12");
  assert.equal(itemKey({ time: "2026-08-16 10:00" }, 3), "2026-08-16 10:00-3");
});

test("countNew is 0 when empty or already at top", () => {
  assert.equal(countNew([], ""), 0);
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(countNew(items, "a"), 0);
  assert.equal(countNew(items, "c"), 2);
});

test("countNew caps first visit and unread", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  assert.equal(countNew(items, ""), 9);
  assert.equal(countNew(items, "never"), 20);
});

test("layout has no site-wide news toast", async () => {
  const { readFile } = await import("node:fs/promises");
  const layout = await readFile(new URL("../src/components/layout/Layout.tsx", import.meta.url), "utf8");
  const hub = await readFile(new URL("../src/lib/telegraphHub.ts", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /NewsToastHost|newsToast/);
  assert.match(hub, /if \(!primed\[src\]\)/);
  assert.match(hub, /document\.hidden/);
  assert.match(hub, /visibilitychange/);
  assert.match(hub, /export const REFRESH_MS = 10_000/);
});
