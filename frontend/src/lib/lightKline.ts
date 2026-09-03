import { COMMODITIES, COMMODITY_CODES } from "@/config/cockpit";
import { api, type AShareLightBar, type AShareLightKline, type FutureDaily } from "@/lib/api";
import { hmOf } from "@/lib/derivMinuteAxis";
import { isFuturesCode, type HubQuote } from "@/lib/quoteHub";
import { fetchDirectMinute, withFallback } from "@/lib/tencentDirect";

function toTencentSym(code: string): string {
  if (/^(sh|sz|bj|hk|us|wh)/i.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    const p = /^(6|9|5)/.test(code) ? "sh" : code.startsWith("8") ? "bj" : "sz";
    return `${p}${code}`;
  }
  return code;
}

function canDirectMinute(code: string): boolean {
  return /^(sh|sz|bj|hk|us)/i.test(code) || /^\d{6}$/.test(code);
}

function hasBars(kl: AShareLightKline | null | undefined): boolean {
  return (kl?.bars?.length ?? 0) >= 2;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function quoteStamp(nowMs: number, fallback: string): string {
  const d = new Date(nowMs);
  const day = /^\d{4}-\d{2}-\d{2}/.test(fallback)
    ? fallback.slice(0, 10)
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Patch last bar with quote-hub last. Same hub as the watch table, no extra poll.

  Live T uses the wall clock, not q.updated (hub only bumps updated when price
  changes, so a stale persist can rewind T). Never move T backwards.
  Persist (fromStore) is not overlaid: refresh would paint last session's last.
 */
export function overlayQuoteBar(
  bars: AShareLightBar[],
  q: Pick<HubQuote, "price" | "high" | "low" | "fromStore"> | undefined,
  kind: "minute" | "daily",
  live = true,
  nowMs: number = Date.now(),
): AShareLightBar[] {
  if (!q || q.fromStore || !Number.isFinite(q.price) || q.price <= 0 || bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  const px = q.price;
  const hi = Math.max(last.high || px, Number.isFinite(q.high) ? (q.high as number) : px, px);
  const lo = Math.min(last.low > 0 ? last.low : px, Number.isFinite(q.low) && (q.low as number) > 0 ? (q.low as number) : px, px);
  if (kind === "daily") {
    if (last.close === px && last.high === hi && last.low === lo) return bars;
    return [...bars.slice(0, -1), { ...last, close: px, high: hi, low: lo }];
  }
  if (!live) {
    if (last.close === px && last.high === hi && last.low === lo) return bars;
    return [...bars.slice(0, -1), { ...last, close: px, high: hi, low: lo }];
  }
  const stamp = quoteStamp(nowMs, last.datetime);
  const lastHm = hmOf(last.datetime);
  const newHm = hmOf(stamp);
  if (newHm && lastHm && newHm > lastHm) {
    return [...bars, { datetime: stamp, open: px, high: px, low: px, close: px, volume: 0 }];
  }
  if (last.close === px && last.high === hi && last.low === lo && last.datetime === stamp) return bars;
  return [...bars.slice(0, -1), { ...last, close: px, high: hi, low: lo, datetime: stamp }];
}

function futureName(code: string): string | undefined {
  const key = code.toLowerCase();
  return COMMODITIES.find((c) => c.code.toLowerCase() === key)?.label;
}

function minuteToKline(code: string, prec: number, points: Array<{ t: string; p: number }>): AShareLightKline | null {
  const valid = points.filter((p) => p.p > 0 && p.t && hmOf(p.t));
  if (valid.length < 2) return null;
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    code,
    name: futureName(code),
    resolution: "1",
    prev_close: prec || null,
    bars: valid.map((p) => ({
      datetime: `${day} ${hmOf(p.t)}`,
      open: p.p, high: p.p, low: p.p, close: p.p, volume: 0,
    })),
  };
}

function futureDailyToKline(code: string, d: FutureDaily): AShareLightKline {
  const pts = d.points || [];
  return {
    code,
    name: futureName(code),
    resolution: "1D",
    adjust: "none",
    source: d.source || "sina",
    prev_close: pts.length >= 2 ? pts[pts.length - 2].c : null,
    bars: pts.filter((p) => p.t && Number.isFinite(p.c) && p.c > 0).map((p) => ({
      datetime: p.t.length <= 10 ? `${p.t} 00:00` : p.t,
      open: p.o, high: p.h, low: p.l, close: p.c, volume: p.v,
    })),
  };
}

function pickFutureMinute(
  map: Record<string, { prec: number; points: Array<{ t: string; p: number }> } | null> | null | undefined,
  code: string,
) {
  if (!map) return null;
  if (map[code]) return map[code];
  const key = Object.keys(map).find((k) => k.toLowerCase() === code.toLowerCase());
  return key ? map[key] : null;
}

/** Same commodity_minutes key as 宏观观察 / warmup. Sina 1d only. */
async function loadFutureKline(
  code: string,
  resolution: string,
  num: number,
): Promise<AShareLightKline> {
  if (resolution === "1D") {
    const d = await api.futureDaily(code, num);
    const kl = futureDailyToKline(code, d);
    if (!hasBars(kl)) throw new Error("future daily empty");
    return kl;
  }
  const map = await api.commodityMinutes(COMMODITY_CODES);
  const row = pickFutureMinute(map, code);
  const kl = row ? minuteToKline(code, row.prec, row.points || []) : null;
  if (!kl) throw new Error("future minute empty");
  kl.source = "sina";
  return kl;
}

async function directKline(code: string): Promise<AShareLightKline> {
  const sym = toTencentSym(code);
  const m = await fetchDirectMinute(sym);
  const kl = minuteToKline(code, m.prec, m.points);
  if (!kl) throw new Error("direct minute empty");
  return kl;
}

const TTL_MS = 55_000;
const FUTURE_TTL_MS = 4_000;
const MAX_INFLIGHT = 4;

const cache = new Map<string, { at: number; data: AShareLightKline }>();
const pending = new Map<string, Promise<AShareLightKline>>();
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_INFLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

/** Shared 55s cache + concurrency 4. Futures minutes 4s so 外盘 5s polls see new bars. */
export function loadLightKline(
  code: string,
  resolution = "1",
  num = 240,
  opts?: { bypassCache?: boolean },
): Promise<AShareLightKline> {
  const ttl = isFuturesCode(code) && resolution !== "1D" ? FUTURE_TTL_MS : TTL_MS;
  const key = `${code}:${resolution}:${num}`;
  if (!opts?.bypassCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
    const inflight = pending.get(key);
    if (inflight) return inflight;
  }
  const p = (async () => {
    await acquire();
    try {
      if (!opts?.bypassCache) {
        const again = cache.get(key);
        if (again && Date.now() - again.at < ttl) return again.data;
      }
      const data = isFuturesCode(code)
        ? await loadFutureKline(code, resolution, num)
        : await withFallback(
          () => api.ashareLightKline(code, resolution, num),
          resolution === "1" && canDirectMinute(code) ? () => directKline(code) : undefined,
        );
      if (hasBars(data)) cache.set(key, { at: Date.now(), data });
      return data;
    } finally {
      pending.delete(key);
      release();
    }
  })();
  pending.set(key, p);
  return p;
}

export function seedLightKline(
  code: string,
  data: AShareLightKline | null,
  resolution = "1",
  num = 240,
): void {
  if (!data) return;
  cache.set(`${code}:${resolution}:${num}`, { at: Date.now(), data });
}

/** One HTTP for many codes. Seeds the per-code cache. maxAgeMs skips still-fresh rows. */
export async function loadLightKlineBatch(
  codes: string[],
  resolution = "1",
  num = 240,
  maxAgeMs = TTL_MS,
): Promise<Record<string, AShareLightKline | null>> {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].slice(0, 40);
  if (!uniq.length) return {};
  const out: Record<string, AShareLightKline | null> = {};
  const need: string[] = [];
  const now = Date.now();
  for (const c of uniq) {
    const hit = cache.get(`${c}:${resolution}:${num}`);
    if (hit && now - hit.at < maxAgeMs) out[c] = hit.data;
    else need.push(c);
  }
  if (!need.length) return out;
  const map = await withFallback(
    () => api.ashareLightKlineBatch(need, resolution, num),
    resolution === "1"
      ? async () => {
        const fresh: Record<string, AShareLightKline | null> = {};
        await Promise.all(need.filter(canDirectMinute).map(async (code) => {
          try { fresh[code] = await directKline(code); } catch { fresh[code] = null; }
        }));
        return fresh;
      }
      : undefined,
  );
  const merged: Record<string, AShareLightKline | null> = { ...(map || {}) };
  if (resolution === "1") {
    const holes = need.filter((c) => !hasBars(merged[c]) && canDirectMinute(c));
    await Promise.all(holes.map(async (code) => {
      try { merged[code] = await directKline(code); } catch { merged[code] = merged[code] ?? null; }
    }));
  }
  for (const [code, data] of Object.entries(merged)) {
    seedLightKline(code, data, resolution, num);
    out[code] = data;
  }
  return out;
}

export function sparkFromKline(kl: AShareLightKline | null | undefined): {
  closes: number[];
  times: string[];
  prevClose?: number | null;
} | null {
  if (!kl) return null;
  const bars = kl.bars || [];
  return {
    closes: bars.map((b) => b.close).filter((n) => Number.isFinite(n)),
    times: bars.map((b) => b.datetime),
    prevClose: kl.prev_close,
  };
}

export function klineFromBatch(
  map: Record<string, AShareLightKline | null> | null | undefined,
  ...keys: Array<string | undefined>
): AShareLightKline | null {
  if (!map) return null;
  for (const k of keys) {
    if (k && map[k]) return map[k];
  }
  return null;
}
