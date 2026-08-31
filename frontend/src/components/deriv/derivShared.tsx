import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown } from "lucide-react";
import type { OvlabDataviewTick, OvlabMarketRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { num } from "@/components/ovlab/shared";
import { formatAge } from "@/lib/freshness";
import { storageGet, storageSet } from "@/lib/storage";
import { DERIV_DEFS } from "@/config/deriv";
import { undRootOf } from "@/lib/derivMinuteAxis";

/** 主力合约码: prodUnd + exp tail (e.g. IF2608). MQTT ctamap 常空 prodUnd, 用目录 AG_O->AG. */
export function undOfRow(r: Pick<OvlabMarketRow, "prodUnd" | "product">): string {
  const u = String(r.prodUnd ?? "").trim();
  if (u) return u;
  const p = String(r.product ?? "").trim();
  const def = DERIV_DEFS.find((d) => d.product.toUpperCase() === p.toUpperCase());
  if (def) return def.und;
  return p.replace(/_O$/i, "");
}

export function klineSym(r: Pick<OvlabMarketRow, "prodUnd" | "product" | "exp">): string {
  const und = undOfRow(r);
  const tail = String(r.exp ?? "").trim().slice(-4);
  return und && tail ? `${und}${tail}` : "";
}

/** Main-contract code for display: futures prodUnd + exp tail (IM2609); pure-digit underlying (ETF) shows itself. */
export function contractCode(r: Pick<OvlabMarketRow, "prodUnd" | "product" | "exp">): string {
  const und = undOfRow(r);
  if (!und) return "";
  return /^\d+$/.test(und) ? und : klineSym(r);
}

/** T-quote / 行情观察 product key: AU, AU_O, or catalog und. */
export function findRowByUnd<T extends Pick<OvlabMarketRow, "prodUnd" | "product">>(
  rows: T[] | null | undefined,
  prod: string,
): T | undefined {
  const want = prod.trim().toUpperCase();
  if (!want) return undefined;
  return rows?.find((r) => {
    const u = undOfRow(r).toUpperCase();
    return u === want || String(r.product ?? "").trim().toUpperCase() === want;
  });
}

/** Upstream 夜盘 is often the string "0"/"1". */
export function nightFlag(v: unknown): boolean | undefined {
  if (v === false || v === 0 || v === "0") return false;
  if (v === true || v === 1 || v === "1") return true;
  const n = Number(v);
  if (n === 0) return false;
  if (n === 1) return true;
  return undefined;
}

/** 行情观察 夜盘 flag. undefined = row missing, keep axis fallback. */
export function nightTradingOf(
  rows: Array<Pick<OvlabMarketRow, "prodUnd" | "product" | "has_night_trading">> | null | undefined,
  und: string,
): boolean | undefined {
  const want = undRootOf(und);
  if (!want || !rows?.length) return undefined;
  const row = rows.find((r) => {
    const u = undRootOf(undOfRow(r));
    const p = undRootOf(String(r.product ?? "").replace(/_O$/i, ""));
    return u === want || p === want;
  });
  if (!row) return undefined;
  return nightFlag(row.has_night_trading);
}

/** Dataview last is only trusted this many seconds in a live session. */
export const TICK_FRESH_S = 8;
/** Futures overlay vs 行情观察/history. SI option crumbs (~70) must not replace SI2610 (~8700). */
export const UND_TICK_MAX_REL = 0.35;

export function pxNear(
  a: number | null | undefined,
  b: number | null | undefined,
  maxRel = UND_TICK_MAX_REL,
): boolean {
  const x = num(a);
  const y = num(b);
  if (x == null || y == null || y <= 0) return false;
  return Math.abs(x - y) / y <= maxRel;
}

export function tickFresh(
  tick: Pick<OvlabDataviewTick, "last" | "at"> | null | undefined,
  nowSec = Date.now() / 1000,
  live = derivSession().live,
): boolean {
  if (num(tick?.last) == null) return false;
  if (!live) return true;
  const at = num(tick?.at);
  if (at == null) return false;
  return nowSec - at <= TICK_FRESH_S;
}

/** Fresh dataview last, else 行情观察 main-contract price. */
export function undSpotLast(
  code: string,
  ticks: Record<string, OvlabDataviewTick>,
  rows: OvlabMarketRow[] | null | undefined,
  nowSec = Date.now() / 1000,
  live = derivSession().live,
): number | null {
  const want = code.trim().toUpperCase();
  if (!want) return null;
  let spot: number | null = null;
  for (const r of rows ?? []) {
    if (contractCode(r).toUpperCase() !== want) continue;
    const px = num(r.price);
    if (px != null) { spot = px; break; }
  }
  const tick = ticks[want];
  const livePx = tickFresh(tick, nowSec, live) ? num(tick.last) : null;
  if (livePx != null && (spot == null || pxNear(livePx, spot))) return livePx;
  return spot;
}

/** 异动标的 -> 中文名: 目录码双向 (IO/IF 都指沪深300) + 目录外 ETF 补充. */
const ALERT_UND_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {
    "588080": "科创板50",
    "159901": "深100ETF",
    "159919": "300ETF",
    "159922": "500ETF",
  };
  for (const d of DERIV_DEFS) {
    m[d.product] = d.label;
    m[d.und] = d.label;
  }
  return m;
})();

/** 异动合约中文名: OPT_SHSE_588000:202608:P:1.8 -> 科创50沽8月1.8; 解析不了回落 contract_code. */
export function alertOptionName(a: { instrument?: string; contract_code?: string }): string {
  const raw = String(a.instrument ?? "").trim();
  const m = raw.match(/^OPT_[A-Z]+_([A-Z0-9]+):(\d{6}):([CP]):(.+)$/i);
  if (!m) return String(a.contract_code ?? "") || raw || "-";
  const [, und, ym, side, strike] = m;
  const name = ALERT_UND_NAME[und.toUpperCase()] ?? und;
  return `${name}${side.toUpperCase() === "C" ? "购" : "沽"}${Number(ym.slice(4))}月${strike}`;
}

/** Panel header right slot: freshness age label, same language as A-share cells. */
export function FreshTag({ updated, extra }: { updated: number; extra?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const beat = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      tick((n) => n + 1);
    };
    const id = window.setInterval(beat, 15_000);
    const onVis = () => { if (!document.hidden) tick((n) => n + 1); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  const age = updated ? formatAge(updated) : null;
  return (
    <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
      {extra ? <span className="mr-1.5">{extra}</span> : null}
      {age ?? "更新中…"}
    </span>
  );
}

/** Per-cell empty state: one cell fails quietly, never drags the screen down. */
export function CellEmpty({ text = "未取到" }: { text?: string }) {
  return (
    <div className="flex h-full min-h-[60px] items-center justify-center text-[11px] text-slate-600">
      {text}
    </div>
  );
}

export function NightMoon({ show }: { show?: boolean }) {
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {show ? (
        <span
          className="flex h-3.5 w-3.5 items-center justify-center border border-primary/50 bg-primary/10 text-[10px] leading-none text-primary"
          aria-label="夜盘"
        >
          夜
        </span>
      ) : null}
    </span>
  );
}

/** Header-right toggle: keep only night-trading products. */
export function NightOnlySwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[10px] text-slate-500">仅夜盘</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        title="只看有夜盘的品种"
        onClick={() => onChange(!on)}
        className={cn(
          "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
          on ? "bg-primary/70" : "bg-slate-700/70",
        )}
      >
        <span
          className={cn(
            "inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform",
            on ? "translate-x-[12px]" : "translate-x-[2px]",
          )}
        />
      </button>
    </span>
  );
}

type DerivSession = { label: string; tone: string; live: boolean };
const SESSION_DAY: DerivSession = { label: "日盘", tone: "text-emerald-400", live: true };
const SESSION_NOON: DerivSession = { label: "午休", tone: "text-amber-400", live: false };
const SESSION_NIGHT: DerivSession = { label: "夜盘", tone: "text-primary", live: true };
const SESSION_CLOSED: DerivSession = { label: "休市", tone: "text-slate-500", live: false };

/** Coarse futures session from local time: 日盘 09:00-15:00 (午休 11:30-13:30), 夜盘 21:00-02:30. */
export function derivSession(now = new Date()): DerivSession {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  // 凌晨夜盘段属于前一交易日: 周二~周六 00:00-02:30
  if (mins < 150) return day >= 2 && day <= 6 ? SESSION_NIGHT : SESSION_CLOSED;
  if (day === 0 || day === 6) return SESSION_CLOSED;
  if (mins >= 540 && mins < 690) return SESSION_DAY;
  if (mins >= 690 && mins < 810) return SESSION_NOON;
  if (mins >= 810 && mins < 900) return SESSION_DAY;
  if (mins >= 1260) return SESSION_NIGHT;
  return SESSION_CLOSED;
}

/** Header badge: current futures session, re-ticks every 30s. */
export function SessionBadge() {
  const [, tick] = useState(0);
  useEffect(() => {
    const beat = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      tick((n) => n + 1);
    };
    const id = window.setInterval(beat, 30_000);
    const onVis = () => { if (!document.hidden) tick((n) => n + 1); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  const s = derivSession();
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px]", s.tone)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.live ? "animate-pulse bg-current" : "bg-slate-600")} />
      {s.label}
    </span>
  );
}

/** ctn is a decimal ratio upstream; render as signed percent with A-share red/green. */
export function CtnText({ value, boldOver }: { value: unknown; boldOver?: number }) {
  const n = num(value);
  if (n === null) return <span className="text-slate-600">-</span>;
  const pct = n * 100;
  const bold = boldOver != null && Math.abs(pct) >= boldOver;
  return (
    <span
      className={cn(
        "tabular-nums",
        pct > 0 ? "text-red-400" : pct < 0 ? "text-emerald-400" : "text-slate-400",
        bold && "font-bold",
      )}
    >
      {pct > 0 ? "+" : ""}{pct.toFixed(2)}%
    </span>
  );
}

const SEEN_KEY = "deriv.alertSeen";
const SEEN_CAP = 300;

function loadSeen(): Set<string> {
  try {
    const arr = JSON.parse(storageGet(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Local seen-set for flow alerts, mirroring NewsCockpitPanel's NEW badge.
 * New keys keep the badge until `flushMs` after they first rendered.
 */
export function useAlertSeen(keys: string[], flushMs = 10_000) {
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (keys.length === 0) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSeen((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        const arr = [...next].slice(-SEEN_CAP);
        storageSet(SEEN_KEY, JSON.stringify(arr));
        return new Set(arr);
      });
    }, flushMs);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [keys.join("|"), flushMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return seen;
}

/** Numeric first, else zh string. Missing values go last. */
export function cmpVal(a: unknown, b: unknown, dir: "asc" | "desc"): number {
  const mul = dir === "asc" ? 1 : -1;
  const an = num(a);
  const bn = num(b);
  if (an !== null && bn !== null) return (an - bn) * mul;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return String(a ?? "").localeCompare(String(b ?? ""), "zh") * mul;
}

/** Flex header button: click cycles desc -> asc -> off. */
export function SortableHd<K extends string>({
  k, label, sort, onSort, className, title,
}: {
  k: K;
  label: string;
  sort: { key: K | null; dir: "asc" | "desc" };
  onSort: (k: K) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      title={title}
      onClick={() => onSort(k)}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 select-none hover:text-slate-100",
        active ? "text-primary" : "text-slate-300",
        className,
      )}
    >
      {label}
      {active
        ? (sort.dir === "asc" ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />)
        : <ArrowUpDown className="h-2.5 w-2.5 opacity-30" />}
    </button>
  );
}

export const IV_SORT_COLS = [
  { key: "atmv_current" as const, label: "隐波", cls: "w-[2.7rem] justify-end text-right", title: "平值隐波" },
  { key: "atmv_percentile" as const, label: "IV分位", cls: "w-[5.4rem] justify-center", title: "隐波百分位, 左便宜 / 右贵" },
  { key: "carry" as const, label: "溢价", cls: "w-[2.6rem] justify-end text-right", title: "IV溢价 = 隐波 - 实波" },
];

/** IV percentile: spectrum marker + number. Green=cheap, red=expensive. */
export function IvpBar({ value }: { value: unknown }) {
  const n = num(value);
  if (n === null) {
    return <span className="inline-block w-[5.4rem] shrink-0 text-center text-[11px] text-slate-600">-</span>;
  }
  const pv = Math.max(0, Math.min(100, n));
  const tick = pv >= 90 ? "bg-red-300" : pv <= 10 ? "bg-emerald-300" : "bg-white";
  const left = 3 + pv * 0.94;
  const numCls = pv >= 90 ? "text-red-400" : pv <= 10 ? "text-emerald-400" : "text-slate-300";
  return (
    <span className="inline-flex w-[5.4rem] shrink-0 items-center gap-1" title={`IV分位 ${pv.toFixed(0)}`}>
      <span className="relative h-1.5 min-w-0 flex-1 overflow-visible rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-red-500">
        <span
          className={cn("absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-sm shadow-[0_0_4px_rgba(0,0,0,0.8)]", tick)}
          style={{ left: `${left}%` }}
        />
      </span>
      <span className={cn("w-[1.55rem] shrink-0 text-right text-[11px] tabular-nums", numCls, (pv >= 90 || pv <= 10) && "font-semibold")}>
        {pv.toFixed(0)}
      </span>
    </span>
  );
}

/** Compact 隐波 / IV分位 / 溢价 cells for 股指 and 商品 rows. */
export function IvTriple({ row }: { row: Pick<OvlabMarketRow, "atmv_current" | "atmv_percentile" | "carry"> }) {
  const iv = num(row.atmv_current);
  const carry = num(row.carry);
  return (
    <>
      <span className="w-[2.7rem] shrink-0 text-right text-[11px] tabular-nums text-slate-300" title="平值隐波">
        {iv !== null ? iv.toFixed(2) : "-"}
      </span>
      <IvpBar value={row.atmv_percentile} />
      <span
        className={cn(
          "w-[2.6rem] shrink-0 text-right text-[11px] tabular-nums",
          carry !== null && carry > 0 ? "text-red-400" : carry !== null && carry < 0 ? "text-emerald-400" : "text-slate-400",
        )}
        title="IV溢价 = 隐波 - 实波"
      >
        {carry !== null ? carry.toFixed(1) : "-"}
      </span>
    </>
  );
}

export type ProdOption = { value: string; label: string };

/** Filter by code or alias (case-insensitive, ignore spaces). */
export function filterProdOptions(opts: ProdOption[], q: string): ProdOption[] {
  const s = q.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return opts;
  return opts.filter((o) => `${o.value}${o.label}`.toLowerCase().replace(/\s+/g, "").includes(s));
}

/** Compact product combobox: left click to type-search, right chevron opens the list. */
export function ProdSearchSelect({
  value,
  options,
  onChange,
  title = "品种",
  className,
}: {
  value: string;
  options: ProdOption[];
  onChange: (v: string) => void;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cur = options.find((o) => o.value === value);
  const hits = useMemo(() => filterProdOptions(options, q), [options, q]);

  const close = () => {
    setOpen(false);
    setSearching(false);
    setQ("");
    setHi(0);
  };

  const startSearch = () => {
    setSearching(true);
    setOpen(true);
    setHi(0);
  };

  const toggleList = () => {
    if (open) {
      close();
      return;
    }
    setSearching(false);
    setQ("");
    setHi(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!searching) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [searching]);

  const pick = (v: string) => {
    onChange(v);
    close();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((n) => Math.min(hits.length - 1, n + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((n) => Math.max(0, n - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[hi] ?? hits[0];
      if (hit) pick(hit.value);
    }
  };

  return (
    <div ref={boxRef} className={cn("relative shrink-0", className)}>
      <div className="flex h-6 w-full max-w-[8.5rem] items-stretch overflow-hidden rounded border border-slate-700/60 bg-slate-900 hover:border-slate-500">
        {searching ? (
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); }}
            onKeyDown={onKey}
            placeholder="搜代码 / 名称"
            title="搜索品种"
            className="min-w-0 flex-1 bg-transparent px-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600"
          />
        ) : (
          <button
            type="button"
            title="点此搜索品种"
            onClick={startSearch}
            className="min-w-0 flex-1 truncate px-1.5 text-left text-[11px] text-slate-200 outline-none"
          >
            {cur?.label || title}
          </button>
        )}
        <button
          type="button"
          title="展开列表"
          aria-label="展开列表"
          onClick={toggleList}
          className="flex w-5 shrink-0 items-center justify-center border-l border-slate-700/60 text-slate-500 outline-none hover:bg-slate-800/80 hover:text-slate-300"
        >
          <ChevronDown className={cn("h-3 w-3", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-52 overflow-hidden rounded border border-slate-700/70 bg-slate-900 shadow-xl">
          <div className="max-h-56 overflow-y-auto py-0.5">
            {hits.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] text-slate-600">无匹配</div>
            )}
            {hits.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.value)}
                className={cn(
                  "flex w-full px-2 py-1 text-left text-[11px]",
                  i === hi ? "bg-slate-800 text-slate-100" : "text-slate-300 hover:bg-slate-800/60",
                  o.value === value && "text-primary",
                )}
              >
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
