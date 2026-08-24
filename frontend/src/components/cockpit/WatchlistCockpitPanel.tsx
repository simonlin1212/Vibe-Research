import { QuoteStockRow } from "@/components/cockpit/QuoteStockRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { SuggestHits, useSuggestSearch } from "@/hooks/useSuggestSearch";
import { sparkFromKline } from "@/lib/lightKline";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { addWatch, useWatchCodes } from "@/lib/watchlist";

const MAX_ROWS = 40;

/** Watchlist rows share QuoteStockRow + the 5s quote hub. Search adds by name/code. */
export function WatchlistCockpitPanel() {
  const codes = useWatchCodes();
  const visible = codes.slice(0, MAX_ROWS);
  const hub = useQuotes(visible);
  const minutes = useMinutes(visible);
  const s = useSuggestSearch({ skipCode: true });

  const pick = (code: string) => {
    addWatch(code);
    s.clear();
  };

  const searchBox = (
    <div ref={s.boxRef} className="relative shrink-0 px-1.5 pt-1">
      <input
        value={s.q}
        onChange={(e) => s.type(e.target.value)}
        onFocus={() => s.hits.length && s.setOpen(true)}
        onKeyDown={(e) => s.onKeyDown(e, (h) => pick(h.code), pick)}
        placeholder="搜名称 / 代码 / 拼音, 回车加入"
        className="h-6 w-full rounded bg-slate-800/60 px-2 text-[11px] text-slate-200 placeholder:text-[9px] placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      {s.open && (
        <SuggestHits
          hits={s.hits}
          hi={s.hi}
          onPick={(h) => pick(h.code)}
          className="absolute left-1.5 right-1.5 top-8 z-20 overflow-hidden rounded border border-border bg-card shadow-lg"
        />
      )}
    </div>
  );

  if (!codes.length) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {searchBox}
        <EmptyState
          title="还没有自选股"
          description="上面搜名称或代码即可加入, 加完立刻出行情。"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {searchBox}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {visible.map((c) => {
          const hq = hub[c];
          const sp = sparkFromKline(minutes[c]);
          return (
            <QuoteStockRow
              key={c}
              code={c}
              name={hq?.name || c}
              price={hq?.price}
              pct={hq?.pct}
              amount={hq?.amount}
              turnover={hq?.turnover}
              spark={sp ?? { closes: [] }}
              flow
            />
          );
        })}
        {codes.length > MAX_ROWS && (
          <p className="px-1.5 pt-1 text-center text-[10px] text-slate-600">
            自选较多, 仅展示前 {MAX_ROWS} 只 · 共 {codes.length} 只
          </p>
        )}
      </div>
    </div>
  );
}
