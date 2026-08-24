import { QuoteLine } from "@/components/cockpit/QuoteLine";
import { WORLD_INDEX_DEFS } from "@/config/cockpit";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { sparkSessionForRegion } from "@/lib/sparkAxis";

const PANEL_DEFS = WORLD_INDEX_DEFS.filter(
  (d) => d.region === "CN" || d.region === "US" || d.region === "FX",
);
const INDEX_CODES = PANEL_DEFS.map((d) => d.code);
const KLINE_SYMS = PANEL_DEFS
  .filter((d) => /^(sh|sz|us|wh)/i.test(d.code))
  .map((d) => d.code);

/** A + US + FX. HK / JP / KR draw in 行情观察 under NQ. */
export function WorldIndexPanel() {
  const hub = useQuotes(INDEX_CODES);
  const minutes = useMinutes(KLINE_SYMS);
  const groups = [
    { name: "A股", defs: PANEL_DEFS.filter((d) => d.region === "CN") },
    { name: "美股 · 汇率", defs: PANEL_DEFS.filter((d) => d.region !== "CN") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-1">
      {groups.map((g) => (
        <div key={g.name}>
          <div className="px-1 pb-0.5 pt-1 text-[9px] font-medium uppercase tracking-widest text-slate-500">
            {g.name}
          </div>
          {g.defs.map((d) => {
            const h = hub[d.code];
            const kl = minutes[d.code];
            const closes = (kl?.bars || []).map((b) => b.close).filter((n) => Number.isFinite(n));
            const times = (kl?.bars || []).map((b) => b.datetime);
            return (
              <QuoteLine
                key={d.code}
                variant="index"
                name={h?.name || d.label}
                unit={d.code}
                badge={d.region}
                price={h?.price}
                pct={h?.pct}
                amount={d.region !== "US" ? h?.amount : undefined}
                closes={closes}
                times={times}
                session={sparkSessionForRegion(d.region)}
                prevClose={kl?.prev_close}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
