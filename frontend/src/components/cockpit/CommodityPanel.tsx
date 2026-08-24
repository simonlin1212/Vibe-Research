import { useState } from "react";
import { QuoteLine } from "@/components/cockpit/QuoteLine";
import { COMMODITIES, COMMODITY_CODES, MACRO_INDEX_DEFS } from "@/config/cockpit";
import { usePolling } from "@/hooks/usePolling";
import { api, type FutureDaily } from "@/lib/api";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { sparkSessionForRegion } from "@/lib/sparkAxis";
import { cn } from "@/lib/utils";

const MINUTE_MS = 60_000;
const DAILY_MS = 3600_000;
const FUT_CODES = COMMODITIES.map((c) => c.code);
const MACRO_CODES = MACRO_INDEX_DEFS.map((d) => d.code);
const FUT_HEAD = COMMODITIES.filter((c) => c.code === "hf_NQ");
const FUT_TAIL = [
  ...COMMODITIES.filter((c) => c.code === "hf_BTC"),
  ...COMMODITIES.filter((c) => c.code !== "hf_NQ" && c.code !== "hf_BTC"),
];

export function CommodityPanel() {
  const [tab, setTab] = useState<"fut" | "daily">("fut");
  const hub = useQuotes([...FUT_CODES, ...MACRO_CODES]);
  const indexMinutes = useMinutes(MACRO_CODES);
  const { data: minutes, error } = usePolling(() => api.commodityMinutes(COMMODITY_CODES), MINUTE_MS, []);
  const { data: daily } = usePolling(async () => {
    const out: Record<string, FutureDaily | null> = {};
    await Promise.all(
      COMMODITIES.filter((c) => c.code.startsWith("hf_") || c.code.startsWith("nf_")).map(async (c) => {
        try {
          out[c.code] = await api.futureDaily(c.code, 60);
        } catch {
          out[c.code] = null;
        }
      }),
    );
    return out;
  }, DAILY_MS, [], tab === "daily");

  const futLine = (c: (typeof COMMODITIES)[number]) => {
    const q = hub[c.code];
    const m = minutes?.[c.code];
    const closes = (m?.points || []).map((p) => p.p).filter((n) => Number.isFinite(n) && n > 0);
    const times = (m?.points || []).map((p) => p.t);
    return (
      <QuoteLine
        key={c.code}
        name={c.label}
        price={q?.price}
        pct={q?.pct}
        unit={c.unit}
        accent={c.accent}
        closes={closes}
        times={times}
        session="h24"
        prevClose={m?.prec ?? q?.prev}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 px-2 py-1">
        {([
          ["fut", "标的"],
          ["daily", "日K"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              tab === k ? "bg-primary/15 text-primary" : "text-slate-500 hover:text-slate-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 pt-0">
        {tab === "fut" && (
          <>
            {![...FUT_CODES, ...MACRO_CODES].some((code) => hub[code]?.price) && (
              <p className="py-6 text-center text-[11px] text-slate-600">
                {error ? "商品行情未接通, 自动重试中" : "加载中…"}
              </p>
            )}
            {FUT_HEAD.map(futLine)}
            {MACRO_INDEX_DEFS.map((d) => {
              const q = hub[d.code];
              const kl = indexMinutes[d.code];
              const closes = (kl?.bars || []).map((b) => b.close).filter((n) => Number.isFinite(n) && n > 0);
              const times = (kl?.bars || []).map((b) => b.datetime);
              const last = closes.length ? closes[closes.length - 1] : undefined;
              const prev = kl?.prev_close ?? q?.prev;
              const rawPct = q?.pct ?? (
                last != null && prev ? ((last - prev) / prev) * 100 : undefined
              );
              const pct = rawPct != null && Number.isFinite(rawPct)
                ? Number(rawPct.toFixed(2))
                : undefined;
              return (
                <QuoteLine
                  key={d.code}
                  name={q?.name || d.label}
                  price={q?.price ?? last}
                  pct={pct}
                  unit={d.code}
                  closes={closes}
                  times={times}
                  session={sparkSessionForRegion(d.region)}
                  accent={d.accent}
                  prevClose={prev}
                />
              );
            })}
            {FUT_TAIL.map(futLine)}
          </>
        )}
        {tab === "daily" && (
          <>
            {!daily && (
              <p className="py-6 text-center text-[11px] text-slate-600">加载中…</p>
            )}
            {COMMODITIES.map((c) => {
              const q = hub[c.code];
              const pts = daily?.[c.code]?.points ?? [];
              const closes = pts.map((p) => p.c).filter((n) => Number.isFinite(n) && n > 0);
              const times = pts.map((p) => p.t);
              const prevClose = pts.length >= 2 ? pts[pts.length - 2].c : q?.prev;
              return (
                <QuoteLine
                  key={c.code}
                  name={c.label}
                  price={q?.price}
                  pct={q?.pct}
                  unit={c.unit}
                  accent={c.accent}
                  closes={closes}
                  times={times}
                  session="daily"
                  prevClose={prevClose}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
