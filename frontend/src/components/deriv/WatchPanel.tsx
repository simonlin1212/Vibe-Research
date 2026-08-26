import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api, type OvlabKlineBar, type OvlabLastBar, type OvlabSearchItem } from "@/lib/api";
import type { DerivData } from "@/hooks/useDerivData";
import { usePolling } from "@/hooks/usePolling";
import { cn } from "@/lib/utils";
import { nextSort, num, TrendPreviewCell, type PreviewSeries, type SortState } from "@/components/ovlab/shared";
import { storageGet, storageSet } from "@/lib/storage";
import { CellEmpty, cmpVal, contractCode, findRowByUnd, IvpBar, NightMoon, nightFlag, SortableHd, tickFresh, undOfRow } from "./derivShared";

const WATCH_KEY = "deriv.watch";
const MAX_WATCH = 20;

function loadWatch(): string[] {
  try {
    const arr = JSON.parse(storageGet(WATCH_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** pct chip, futures settle-based change vs pre_close. */
function PctText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-600">-</span>;
  return (
    <span className={cn(
      "text-[12px] tabular-nums",
      value > 0 ? "text-red-400" : value < 0 ? "text-emerald-400" : "text-slate-400",
      Math.abs(value) >= 3 && "font-bold",
    )}>
      {value > 0 ? "+" : ""}{value.toFixed(2)}%
    </span>
  );
}

type WatchKey = "code" | "close" | "pct";

/** 自选合约: local deriv.watch (具体合约代码, 如 IM2609). 旧品种条目自动迁到主力合约.
 *  行情: last-bar 60s 做底, MQTT dataview 叠最新价; 分时: kline-history 1m 近 20h, 5min 轮询 (纯价格线, 不叠 IV).
 *  点列头排序; 点合约出驾驶舱日K/分时. 注: OpenVlab 无期权合约级行情接口, 搜索仅索引期货合约. */
export function WatchPanel({ d, onPick, compact = false }: {
  d: DerivData;
  onPick?: (code: string, prodUnd?: string) => void;
  /** 窄列模式 (嵌进主板卡第三列): 隐藏别名与 IV分位 列. */
  compact?: boolean;
}) {
  const [watch, setWatch] = useState<string[]>(loadWatch);
  const [sort, setSort] = useState<SortState<Record<WatchKey, unknown>>>({ key: null, dir: "desc" });
  const [kw, setKw] = useState("");
  const [hits, setHits] = useState<OvlabSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | null>(null);

  const save = (next: string[]) => {
    setWatch(next);
    storageSet(WATCH_KEY, JSON.stringify(next));
  };

  // 旧条目是 prodUnd (如 MA), 有行情后迁到主力合约代码 (如 MA2610)
  useEffect(() => {
    if (!d.rows) return;
    let changed = false;
    const next = watch.map((w) => {
      if (/\d/.test(w)) return w;
      const row = findRowByUnd(d.rows, w);
      const sym = row ? contractCode(row) : "";
      if (sym) changed = true;
      return sym || w;
    });
    if (changed) save(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.rows]);

  const watchKey = useMemo(() => [...watch].sort().join("|"), [watch]);

  // 合约最新 bar (close/pre_close/oi/vol), 60s
  const quotePoll = usePolling(
    () => Promise.all(watch.map((c) => api.ovlabLastBar(c).catch(() => null))),
    60_000,
    [watchKey],
    watch.length > 0,
  );
  const quotes = useMemo(() => {
    const m: Record<string, OvlabLastBar | null> = {};
    watch.forEach((c, i) => { m[c] = quotePoll.data?.[i] ?? null; });
    return m;
  }, [watch, quotePoll.data]);

  // 合约当日分钟线 (近 20h 含夜盘), 5min
  const sparkPoll = usePolling(
    () => {
      const fromTs = Math.floor(Date.now() / 1000) - 20 * 3600;
      return Promise.all(watch.map((c) => api.ovlabKlineHistory(c, "1", fromTs).catch(() => null)));
    },
    300_000,
    [watchKey],
    watch.length > 0,
  );
  const sparks = useMemo(() => {
    const m: Record<string, PreviewSeries> = {};
    watch.forEach((c, i) => {
      const bars = sparkPoll.data?.[i]?.data;
      if (!Array.isArray(bars)) return;
      const prices = (bars as OvlabKlineBar[])
        .map((b) => [String(b[0]), num(b[1])] as [string, number | null])
        .filter((p): p is [string, number] => p[1] !== null);
      if (prices.length >= 2) m[c] = { prices, volatilities: [] };
    });
    return m;
  }, [watch, sparkPoll.data]);
  const sparkLoading = sparkPoll.data === null && watch.length > 0;

  // 合约 -> 品种行: 先精确主力码, 再按字母前缀对目录 und.
  const productOf = useMemo(() => {
    const all = d.rows ?? [];
    return (ticker: string) => {
      const t = ticker.toUpperCase();
      const exact = all.find((r) => contractCode(r).toUpperCase() === t);
      if (exact) return exact;
      const head = t.match(/^[A-Z]+/)?.[0] ?? "";
      return head ? findRowByUnd(all, head) : undefined;
    };
  }, [d.rows]);

  const onSearch = (v: string) => {
    setKw(v);
    if (timer.current) window.clearTimeout(timer.current);
    if (!v.trim()) { setHits([]); return; }
    timer.current = window.setTimeout(() => {
      setSearching(true);
      api.ovlabSearchSymbols(v.trim())
        .then((r) => setHits(Array.isArray(r) ? r.slice(0, 8) : []))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 300);
  };

  const add = (ticker: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t || watch.includes(t) || watch.length >= MAX_WATCH) return;
    save([...watch, t]);
    setKw("");
    setHits([]);
  };

  const shown = useMemo(() => {
    const rows = watch.map((code) => {
      const lb = quotes[code];
      const tick = d.ticks[code.toUpperCase()];
      const close = (tickFresh(tick) ? num(tick?.last) : null) ?? num(lb?.close);
      const pre = num(lb?.pre_close);
      const pct = close !== null && pre ? ((close - pre) / pre) * 100 : null;
      return { code, close, pre, pct };
    });
    if (!sort.key) return rows;
    const key = sort.key;
    return [...rows].sort((a, b) => cmpVal(a[key], b[key], sort.dir));
  }, [watch, quotes, sort, d.ticks]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative shrink-0 px-2 pt-1.5">
        <input
          value={kw}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="加自选: 合约代码, 如 IM2609"
          className="w-full rounded border border-slate-700/60 bg-slate-900/40 px-2 py-1 text-[12px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-primary/50"
        />
        {kw.trim() && (
          <div className="absolute inset-x-2 top-full z-20 mt-0.5 overflow-hidden rounded border border-slate-700/70 bg-slate-900 shadow-xl">
            {searching && <div className="px-2 py-1.5 text-[10px] text-slate-500">搜索中…</div>}
            {!searching && hits.length === 0 && <div className="px-2 py-1.5 text-[10px] text-slate-600">无匹配 (仅期货合约)</div>}
            {hits.map((h, i) => (
              <button
                key={`${h.ticker ?? i}`}
                type="button"
                onClick={() => add(String(h.ticker ?? ""))}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] text-slate-300 hover:bg-slate-800/60"
              >
                <Plus className="h-3 w-3 shrink-0 text-primary" />
                <span className="shrink-0 tabular-nums">{String(h.ticker ?? "")}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{String(h.name ?? h.description ?? "")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-2 pb-0.5 text-[10px] text-slate-300">
        <SortableHd k="code" label="合约" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="min-w-0 flex-1 justify-start" />
        <SortableHd k="close" label="最新" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="justify-end" />
        <SortableHd k="pct" label="涨跌" sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} className="justify-end" />
        <span className="w-[52px] shrink-0">分时</span>
        <span className="w-3 shrink-0" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {watch.length === 0 && <CellEmpty text="暂无自选, 上方搜索添加" />}
        {shown.map(({ code, close, pre, pct }) => {
          const prod = productOf(code);
          return (
            <div
              key={code}
              className="group flex w-full items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-800/40"
            >
              <button
                type="button"
                onClick={onPick ? () => {
                  const pu = prod ? undOfRow(prod) : "";
                  onPick(code, pu || undefined);
                } : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="shrink-0 text-[12px] font-medium tabular-nums text-primary/90">{code}</span>
                {compact ? (
                  <span className="min-w-0 flex-1" />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">
                    {prod ? String(prod.product_alias ?? "") : ""}
                  </span>
                )}
                <NightMoon show={Number(prod?.has_night_trading) === 1} />
                <span className="text-[12px] font-medium tabular-nums text-slate-200">
                  {close !== null ? Number(close.toFixed(2)).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-"}
                </span>
                <PctText value={pct} />
                {!compact && <IvpBar value={prod?.atmv_percentile} />}
              </button>
              <TrendPreviewCell series={sparks[code]} loading={sparkLoading && !sparks[code]} base={pre} und={code} hasNight={nightFlag(prod?.has_night_trading)} />
              <button
                type="button"
                onClick={() => save(watch.filter((w) => w !== code))}
                className="hidden shrink-0 text-slate-600 hover:text-red-400 group-hover:block"
                title="移出自选"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
