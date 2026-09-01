import { useMemo } from "react";
import { COMMODITIES, WORLD_INDEX_DEFS } from "@/config/cockpit";
import type { TapeItem } from "@/components/cockpit/TickerTape";
import { peekQuotes, useQuotes } from "@/lib/quoteHub";

const TAPE_CODES = [
  ...WORLD_INDEX_DEFS.map((d) => d.code),
  ...COMMODITIES.map((d) => d.code),
];

/** Settings / backtest / data / research do not keep the hub at 5s for hf_*. */
export function tapeLivePath(pathname: string): boolean {
  const p = pathname || "";
  return !["/settings", "/backtest", "/data", "/research"].some(
    (root) => p === root || p.startsWith(`${root}/`),
  );
}

function toItems(src: ReturnType<typeof peekQuotes>): TapeItem[] {
  const list: TapeItem[] = WORLD_INDEX_DEFS.flatMap((d) => {
    const q = src[d.code];
    if (!q || !Number.isFinite(q.price) || q.price <= 0) return [];
    return [{ key: d.code, label: q.name || d.label, price: q.price, pct: q.pct }];
  });
  for (const d of COMMODITIES) {
    const q = src[d.code];
    if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
    list.push({ key: d.code, label: d.label, price: q.price, pct: q.pct });
  }
  return list;
}

/** Site-wide tape: same quote hub. live=false peeks last print, no subscribe. */
export function useTapeQuotes(live = true) {
  const hub = useQuotes(live ? TAPE_CODES : []);
  return useMemo(
    () => toItems(live ? hub : peekQuotes(TAPE_CODES)),
    [hub, live],
  );
}
