import { useEffect, useMemo, useSyncExternalStore } from "react";
import { HUB_POLL_FUTURES_MS, hubPollMs, primeTradingDay } from "@/lib/ashareSession";
import { isOffshoreCode } from "@/lib/quoteHub";
import { loadLightKlineBatch } from "@/lib/lightKline";
import type { AShareLightKline } from "@/lib/api";

/**
 * Merge cockpit minute-spark subscriptions into one batch.
 * Open: 20s (5s if any subscribed code is 外盘). Closed: 60s, or 5s if 外盘.
 * Last frame stays in memory and localStorage so a new tab paints the line first.
 */

export const MINUTE_POLL_MS = 20_000;
const CHUNK = 40;
const MAX_AGE_MS = 15_000;
const STORE_KEY = "vr.minuteHub.v1";
const STORE_MAX = 20;
const STORE_MAX_AGE_MS = 12 * 3600_000;

const entries = new Map<string, AShareLightKline | null>();
const storedAt = new Map<string, number>();
const refCounts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let timer: number | null = null;
let looping = false;
let flushTimer: number | null = null;
let lastFlush = 0;
let persistTimer: number | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadStore() {
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, { at?: number; data?: AShareLightKline }>;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed || {})) {
      const kl = v?.data;
      const at = v?.at || 0;
      if (kl && (kl.bars?.length ?? 0) >= 2 && now - at < STORE_MAX_AGE_MS) {
        entries.set(k, kl);
        storedAt.set(k, at);
      }
    }
  } catch {
    /* ignore broken store */
  }
}

function saveStore() {
  const store = storage();
  if (!store) return;
  try {
    const out: Record<string, { at: number; data: AShareLightKline }> = {};
    let n = 0;
    for (const [k, v] of entries) {
      if (n >= STORE_MAX) break;
      if (!v || (v.bars?.length ?? 0) < 2) continue;
      out[k] = { at: storedAt.get(k) || Date.now(), data: v };
      n += 1;
    }
    store.setItem(STORE_KEY, JSON.stringify(out));
  } catch {
    /* quota / private mode */
  }
}

function schedulePersist() {
  if (persistTimer != null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    saveStore();
  }, 300);
}

loadStore();
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", saveStore);
}

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getVersion() {
  return version;
}

function chunks(codes: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < codes.length; i += CHUNK) out.push(codes.slice(i, i + CHUNK));
  return out;
}

async function tick() {
  if (!refCounts.size) return;
  const codes = [...refCounts.keys()];
  const rs = await Promise.allSettled(
    chunks(codes).map((c) => loadLightKlineBatch(c, "1", 240, MAX_AGE_MS)),
  );
  const now = Date.now();
  let changed = false;
  for (const r of rs) {
    if (r.status !== "fulfilled") continue;
    for (const [code, kl] of Object.entries(r.value || {})) {
      const old = entries.get(code);
      if (old !== kl) {
        entries.set(code, kl);
        storedAt.set(code, now);
        changed = true;
      }
    }
  }
  if (changed) {
    emit();
    schedulePersist();
  }
}

function onVisibility() {
  if (!document.hidden) void tick();
}

function arm() {
  if (timer != null) return;
  timer = window.setTimeout(() => {
    timer = null;
    if (!document.hidden) void tick();
    if (looping) arm();
  }, hubPollMs(
    [...refCounts.keys()].some(isOffshoreCode) ? HUB_POLL_FUTURES_MS : MINUTE_POLL_MS,
    new Date(),
    [...refCounts.keys()].some(isOffshoreCode),
  ));
}

function ensureLoop() {
  if (looping) return;
  looping = true;
  void primeTradingDay();
  document.addEventListener("visibilitychange", onVisibility);
  arm();
}

function maybeStopLoop() {
  if (refCounts.size > 0) return;
  looping = false;
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
  document.removeEventListener("visibilitychange", onVisibility);
}

function scheduleFlush() {
  if (flushTimer != null || document.hidden) return;
  const wait = lastFlush === 0 ? 0 : Math.max(0, 2000 - (Date.now() - lastFlush));
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    lastFlush = Date.now();
    void tick();
  }, wait);
}

function useCodes(codes: string[]) {
  const key = codes.join(",");
  useEffect(() => {
    const uniq = [...new Set(key ? key.split(",") : [])].filter(Boolean);
    for (const c of uniq) refCounts.set(c, (refCounts.get(c) || 0) + 1);
    ensureLoop();
    scheduleFlush();
    return () => {
      for (const c of uniq) {
        const n = (refCounts.get(c) || 1) - 1;
        if (n <= 0) {
          refCounts.delete(c);
        } else {
          refCounts.set(c, n);
        }
      }
      maybeStopLoop();
    };
  }, [key]);
}

export function useMinutes(codes: string[]): Record<string, AShareLightKline | null> {
  useCodes(codes);
  const v = useSyncExternalStore(subscribe, getVersion);
  const key = codes.join(",");
  return useMemo(() => {
    const result: Record<string, AShareLightKline | null> = {};
    for (const c of codes) {
      if (entries.has(c)) result[c] = entries.get(c) ?? null;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
}
