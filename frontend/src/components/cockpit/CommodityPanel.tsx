import { klineHref, QuoteLine } from "@/components/cockpit/QuoteLine";
import { COMMODITIES, COMMODITY_CODES, MACRO_INDEX_DEFS } from "@/config/cockpit";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { HUB_POLL_FUTURES_MS, hubPollMs } from "@/lib/ashareSession";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { sparkSessionForRegion } from "@/lib/sparkAxis";

const FUT_CODES = COMMODITIES.map((c) => c.code);
const MACRO_CODES = MACRO_INDEX_DEFS.map((d) => d.code);
const FUT_HEAD = COMMODITIES.filter((c) => c.code === "hf_NQ");
const FUT_TAIL = [
  ...COMMODITIES.filter((c) => c.code === "hf_BTC"),
  ...COMMODITIES.filter((c) => c.code !== "hf_NQ" && c.code !== "hf_BTC"),
];

export function CommodityPanel() {
  const hub = useQuotes([...FUT_CODES, ...MACRO_CODES]);
  const indexMinutes = useMinutes(MACRO_CODES);
  const minMs = hubPollMs(HUB_POLL_FUTURES_MS, new Date(), true);
  const { data: minutes, error } = usePolling(() => api.commodityMinutes(COMMODITY_CODES), minMs, []);

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
        href={klineHref(c.code)}
        accent={c.accent}
        closes={closes}
        times={times}
        session="h24"
        prevClose={m?.prec ?? q?.prev}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-1">
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
    </div>
  );
}
