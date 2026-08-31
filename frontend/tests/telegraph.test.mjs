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
  assert.match(page, /NewsCockpitPanel/);
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
  assert.match(panel, /\["jin10", "金十"\]/);
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

function incomingFromFresh(items, fresh, source, already) {
  const out = [];
  items.forEach((it, i) => {
    const id = itemKey(it, i);
    if (!fresh.has(id) || already.has(id)) return;
    const extra = it.content || it.summary || "";
    out.push({
      id, title: it.title,
      content: extra && extra !== it.title ? extra : undefined,
      time: it.time, tags: it.tags, source,
    });
  });
  return out;
}

function enqueueNewsToasts(queue, incoming, now, ttl = 180_000, cap = 4) {
  const alive = queue.filter((t) => t.until > now);
  const have = new Set(alive.map((t) => t.id));
  const add = incoming
    .filter((it) => it.id && !have.has(it.id))
    .map((it) => ({ ...it, until: now + ttl }));
  return [...add, ...alive].slice(0, cap);
}

function pruneNewsToasts(queue, now) {
  return queue.filter((t) => t.until > now);
}

test("incomingFromFresh skips seen and first-paint keys", () => {
  const items = [
    { id: "a", title: "A", time: "2026-08-20 10:00", content: "A" },
    { id: "b", title: "B", time: "2026-08-20 10:01", content: "正文" },
  ];
  assert.deepEqual(incomingFromFresh(items, new Set(), "cls", new Set()), []);
  const neu = incomingFromFresh(items, new Set(["b"]), "cls", new Set(["a"]));
  assert.equal(neu.length, 1);
  assert.equal(neu[0].id, "b");
  assert.equal(neu[0].content, "正文");
});

test("news toasts last 3 min, cap 4, drop expired", () => {
  const now = 1_000_000;
  const incoming = ["1", "2", "3", "4", "5"].map((id) => ({
    id, title: id, source: "cls", time: "10:00",
  }));
  const q = enqueueNewsToasts([], incoming, now);
  assert.equal(q.length, 4);
  assert.equal(q[0].id, "1");
  assert.equal(q[0].until, now + 180_000);
  assert.equal(enqueueNewsToasts(q, [{ id: "1", title: "1", source: "cls" }], now + 10).length, 4);
  assert.deepEqual(pruneNewsToasts(q, now + 180_001).map((t) => t.id), []);
  assert.equal(pruneNewsToasts(q, now + 179_999).length, 4);
});

test("site-wide toast host rides telegraphHub, no second poll", async () => {
  const { readFile } = await import("node:fs/promises");
  const toast = await readFile(new URL("../src/lib/newsToast.ts", import.meta.url), "utf8");
  const host = await readFile(new URL("../src/components/cockpit/NewsToastHost.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../src/components/layout/Layout.tsx", import.meta.url), "utf8");
  const hub = await readFile(new URL("../src/lib/telegraphHub.ts", import.meta.url), "utf8");
  assert.match(toast, /export const NEWS_TOAST_MS = 180_000/);
  assert.match(toast, /export const NEWS_TOAST_CAP = 4/);
  assert.match(host, /useTelegraph/);
  assert.match(host, /incomingFromFresh/);
  assert.match(host, /180_000|NEWS_TOAST_MS|enqueueNewsToasts/);
  assert.doesNotMatch(host, /setInterval\(\s*\(\)\s*=>\s*void (api\.|loadTelegraph)/);
  assert.match(layout, /<NewsToastHost/);
  assert.match(host, /to="\/event"/);
  assert.doesNotMatch(host, /to="\/a-share"/);
  assert.match(host, /if \(!toasts\.length\) return/);
  assert.match(host, /document\.hidden/);
  assert.match(host, /visibilitychange/);
  assert.match(hub, /if \(!primed\[src\]\)/);
  assert.match(hub, /document\.hidden/);
  assert.match(hub, /visibilitychange/);
});
