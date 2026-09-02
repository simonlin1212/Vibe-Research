import { useSyncExternalStore } from "react";
import { api, ApiError, type ClsTelegraph, type ClsTelegraphItem } from "@/lib/api";

export type FeedSource = "cls" | "lives" | "jin10";
export const FEED_SOURCES: FeedSource[] = ["cls", "lives", "jin10"];

export function itemKey(it: ClsTelegraphItem, i: number) {
  return String(it.id ?? `${it.time}-${i}`);
}

const SEEN_KEY = "vr.cls.seenId";
const LIMIT = 40;
export const REFRESH_MS = 10_000;

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) || "";
  } catch {
    return "";
  }
}

function writeSeen(id: string) {
  try {
    localStorage.setItem(SEEN_KEY, id);
  } catch { /* ignore */ }
}

export function countNew(items: ClsTelegraphItem[], seen: string): number {
  if (!items.length) return 0;
  if (!seen) return Math.min(items.length, 9);
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    if (itemKey(items[i], i) === seen) break;
    n += 1;
  }
  return Math.min(n, 99);
}

type Snap = {
  cls: ClsTelegraph | null;
  lives: ClsTelegraph | null;
  jin10: ClsTelegraph | null;
  err: Partial<Record<FeedSource, string | null>>;
  loading: Partial<Record<FeedSource, boolean>>;
  newCount: number;
  fresh: Record<FeedSource, ReadonlySet<string>>;
};

export function feedOf(snap: Snap, src: FeedSource): ClsTelegraph | null {
  if (src === "lives") return snap.lives;
  if (src === "jin10") return snap.jin10;
  return snap.cls;
}

let seenId = readSeen();
const primed: Record<FeedSource, boolean> = { cls: false, lives: false, jin10: false };
const seenKeys = new Set<string>();
let snap: Snap = {
  cls: null,
  lives: null,
  jin10: null,
  err: {},
  loading: { cls: true },
  newCount: 0,
  fresh: { cls: new Set(), lives: new Set(), jin10: new Set() },
};
const listeners = new Set<() => void>();
let timer: number | null = null;
let clsInflight = false;

function emit() {
  listeners.forEach((l) => l());
}

async function pull(src: FeedSource, silent: boolean) {
  if (src === "cls") {
    if (clsInflight) return;
    clsInflight = true;
  }
  if (!silent) {
    snap = { ...snap, loading: { ...snap.loading, [src]: true }, err: { ...snap.err, [src]: null } };
    emit();
  }
  try {
    let next: ClsTelegraph;
    if (src === "cls") {
      next = await api.clsTelegraph(LIMIT);
    } else {
      const lives = await api.marketLives(1, LIMIT, src === "jin10" ? "jin10" : undefined);
      next = {
        count: lives.count,
        items: lives.items.map((it) => ({
          id: it.id, title: it.title, content: it.content, time: it.time,
          tags: it.tags,
        })),
      };
    }
    const items = next.items || [];
    const keys = items.map((it, i) => itemKey(it, i));
    let fresh = snap.fresh[src];
    if (!primed[src]) {
      keys.forEach((k) => seenKeys.add(k));
      primed[src] = true;
    } else {
      const neu = keys.filter((k) => !seenKeys.has(k));
      keys.forEach((k) => seenKeys.add(k));
      if (neu.length) fresh = new Set(neu);
    }
    snap = {
      ...snap,
      [src]: next,
      err: { ...snap.err, [src]: null },
      loading: { ...snap.loading, [src]: false },
      newCount: src === "cls" ? countNew(items, seenId) : snap.newCount,
      fresh: { ...snap.fresh, [src]: fresh },
    };
    emit();
  } catch (e) {
    snap = {
      ...snap,
      err: { ...snap.err, [src]: e instanceof ApiError ? e.message : "加载失败" },
      loading: { ...snap.loading, [src]: false },
    };
    emit();
  } finally {
    if (src === "cls") clsInflight = false;
  }
}

export function markClsSeen() {
  const items = snap.cls?.items;
  if (!items?.length) return;
  const top = itemKey(items[0], 0);
  if (seenId === top && snap.newCount === 0) return;
  seenId = top;
  writeSeen(top);
  snap = { ...snap, newCount: 0 };
  emit();
}

function refreshOpen() {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const src of FEED_SOURCES) {
    if (primed[src]) void pull(src, true);
  }
}

function beat() {
  refreshOpen();
}

function onVis() {
  if (!document.hidden) refreshOpen();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (timer == null) {
    void pull("cls", false);
    timer = window.setInterval(beat, REFRESH_MS);
    document.addEventListener("visibilitychange", onVis);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer != null) {
      window.clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVis);
    }
  };
}

export function loadTelegraph(src: FeedSource) {
  return pull(src, false);
}

export function useTelegraph() {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** Current feed items without subscribing. Used when packing the cockpit for AI. */
export function peekTelegraphItems(src: FeedSource): ClsTelegraphItem[] {
  return feedOf(snap, src)?.items ?? [];
}
