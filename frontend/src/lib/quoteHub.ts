import { useEffect, useMemo, useSyncExternalStore } from "react";
import { hubPollMs, primeTradingDay } from "@/lib/ashareSession";
import { api } from "@/lib/api";

/**
 * Cockpit quote hub: 5s when A-share is open or any 外盘 is subscribed;
 * 60s when closed/lunch/holiday and only A-share codes.
 * Equities/indices and futures are fetched in parallel so a slow Sina
 * tick cannot stall index prices.
 */

export interface HubQuote {
  name?: string;
  price: number;
  pct: number;
  change?: number;
  amount?: number;
  turnover?: number;
  volume?: number;
  bid?: number;
  ask?: number;
  bid_vol?: number;
  ask_vol?: number;
  open?: number;
  high?: number;
  low?: number;
  amplitude?: number;
  vol_ratio?: number;
  float_mcap_yi?: number;
  limit_up?: number;
  limit_down?: number;
  pe_static?: number;
  prev?: number;
  pe_ttm?: number;
  pb?: number;
  mcap_yi?: number;
  is_stale?: boolean;
  stale_reason?: string;
  /** Upstream tick time, if the quote line has one. */
  time?: string;
  /** Hydrated from localStorage; not a live tick this session. */
  fromStore?: boolean;
  updated: number;
}

export const QUOTE_POLL_MS = 5000;
const CHUNK = 80;
const STORE_KEY = "vr.quoteHub.v1";
const STORE_MAX = 120;
const STORE_MAX_AGE_MS = 12 * 3600_000;

const entries = new Map<string, HubQuote>();
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
    const raw = store.getItem(STORE_KEY) || (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORE_KEY) : null);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, HubQuote>;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed || {})) {
      if (v && Number.isFinite(v.price) && v.price > 0 && now - (v.updated || 0) < STORE_MAX_AGE_MS) {
        entries.set(k, { ...v, fromStore: true });
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
    const out: Record<string, HubQuote> = {};
    let n = 0;
    for (const [k, v] of entries) {
      if (n >= STORE_MAX) break;
      out[k] = v;
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

export function isFuturesCode(code: string): boolean {
  return /^(hf_|nf_)/i.test(code);
}

/** US / HK / JP / KR / FX / futures still tick when A-share is closed. */
export function isOffshoreCode(code: string): boolean {
  return isFuturesCode(code) || /^(us|hk|jp|ks|wh)/i.test(code);
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

function applyQuote(
  code: string,
  q: {
    name?: string; price: number; pct: number; change?: number;
    amount?: number; turnover?: number; volume?: number;
    bid?: number; ask?: number; bid_vol?: number; ask_vol?: number;
    open?: number; high?: number; low?: number; amplitude?: number; vol_ratio?: number;
    float_mcap_yi?: number; limit_up?: number; limit_down?: number; pe_static?: number;
    prev?: number; pe_ttm?: number; pb?: number; mcap_yi?: number;
    is_stale?: boolean; stale_reason?: string; time?: string;
  },
  now: number,
): boolean {
  if (!q || !Number.isFinite(q.price) || q.price <= 0) return false;
  const next: HubQuote = {
    name: q.name,
    price: q.price,
    pct: q.pct,
    change: q.change,
    amount: q.amount,
    turnover: q.turnover,
    volume: q.volume,
    bid: q.bid,
    ask: q.ask,
    bid_vol: q.bid_vol,
    ask_vol: q.ask_vol,
    open: q.open,
    high: q.high,
    low: q.low,
    amplitude: q.amplitude,
    vol_ratio: q.vol_ratio,
    float_mcap_yi: q.float_mcap_yi,
    limit_up: q.limit_up,
    limit_down: q.limit_down,
    pe_static: q.pe_static,
    prev: q.prev,
    pe_ttm: q.pe_ttm,
    pb: q.pb,
    mcap_yi: q.mcap_yi,
    is_stale: q.is_stale,
    stale_reason: q.stale_reason,
    time: q.time,
    updated: now,
  };
  const old = entries.get(code);
  if (!old || old.price !== next.price || old.pct !== next.pct || old.change !== next.change
    || old.amount !== next.amount || old.turnover !== next.turnover || old.volume !== next.volume
    || old.bid !== next.bid || old.ask !== next.ask
    || old.bid_vol !== next.bid_vol || old.ask_vol !== next.ask_vol
    || old.open !== next.open || old.high !== next.high || old.low !== next.low
    || old.amplitude !== next.amplitude || old.vol_ratio !== next.vol_ratio
    || old.float_mcap_yi !== next.float_mcap_yi
    || old.limit_up !== next.limit_up || old.limit_down !== next.limit_down
    || old.pe_static !== next.pe_static
    || old.pe_ttm !== next.pe_ttm || old.pb !== next.pb || old.mcap_yi !== next.mcap_yi
    || old.is_stale !== next.is_stale || old.time !== next.time || old.fromStore) {
    entries.set(code, next);
    return true;
  }
  return false;
}

async function tick() {
  if (!refCounts.size) return;
  const codes = [...refCounts.keys()];
  const stocks = codes.filter((c) => !isFuturesCode(c));
  const futures = codes.filter(isFuturesCode);
  const jobs: Promise<Record<string, { name?: string; price: number; pct: number; amount?: number; turnover?: number; prev?: number }>>[] = [];
  for (const c of chunks(stocks)) jobs.push(api.marketQuotes(c));
  if (futures.length) jobs.push(api.commodities(futures.join(",")));
  const rs = await Promise.allSettled(jobs);
  const now = Date.now();
  let changed = false;
  for (const r of rs) {
    if (r.status !== "fulfilled") continue;
    for (const [code, q] of Object.entries(r.value || {})) {
      if (applyQuote(code, q, now)) changed = true;
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
  }, hubPollMs(QUOTE_POLL_MS, new Date(), [...refCounts.keys()].some(isOffshoreCode)));
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
  // 0: first paint, after this commit's useEffects so all panels are subscribed.
  // Later: at most one fetch per 2s when many rows mount.
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

export function useQuote(code: string, enabled = true): HubQuote | null {
  useCodes(enabled && code ? [code] : []);
  return useSyncExternalStore(subscribe, () => (enabled && code ? entries.get(code) ?? null : null));
}

export function useQuotes(codes: string[]): Record<string, HubQuote> {
  useCodes(codes);
  const v = useSyncExternalStore(subscribe, getVersion);
  const key = codes.join(",");
  return useMemo(() => {
    const result: Record<string, HubQuote> = {};
    for (const c of codes) {
      const e = entries.get(c);
      if (e) result[c] = e;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
}

/** Read the hub without subscribing. Used when packing the current cockpit for AI. */
export function peekQuotes(codes: string[]): Record<string, HubQuote> {
  const result: Record<string, HubQuote> = {};
  for (const c of codes) {
    const e = entries.get(c);
    if (e) result[c] = e;
  }
  return result;
}
