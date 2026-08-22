import { ExternalLink, Plus, X } from "lucide-react";
import type { PmEvent, PmMarket } from "@/lib/api";
import { cn } from "@/lib/utils";

export function extractSlug(raw: string): string {
  const slugs = extractSlugs(raw);
  return slugs[0] || "";
}

export function extractSlugs(raw: string): string[] {
  const out: string[] = [];
  const text = raw.trim();
  if (!text) return out;
  const re = /polymarket\.com\/event\/([a-zA-Z0-9-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[1].toLowerCase();
    if (!out.includes(s)) out.push(s);
  }
  if (out.length) return out;
  if (/^[a-z0-9][a-z0-9-]{8,}$/i.test(text) && !text.includes(" ")) return [text.toLowerCase()];
  return out;
}

export function fmtVol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1) return `${n.toFixed(1)}%`;
  return `${Math.round(n)}%`;
}

function fmtEnd(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function Bar({ pct }: { pct: number | null | undefined }) {
  const w = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full bg-cyan-400" style={{ width: `${w}%` }} />
    </div>
  );
}

function MarketRow({ m }: { m: PmMarket }) {
  const pct = m.yes ?? m.outcomes[0]?.pct ?? null;
  const label = m.yes != null ? "Yes" : (m.outcomes[0]?.label ?? "");
  return (
    <div className={cn("rounded px-1.5 py-1", m.closed && "opacity-50")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-slate-300">{m.title}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-cyan-200">
          {label ? `${label} ` : ""}{fmtPct(pct)}
          {m.chg != null && Number.isFinite(m.chg) ? (
            <span className={cn("ml-1", m.chg >= 0 ? "text-rose-400" : "text-emerald-400")}>
              {m.chg >= 0 ? "+" : ""}{m.chg.toFixed(1)}
            </span>
          ) : null}
        </span>
      </div>
      <Bar pct={pct} />
    </div>
  );
}

function EventCard({
  ev,
  open,
  watched,
  onPick,
  onWatch,
}: {
  ev: PmEvent;
  open: boolean;
  watched: boolean;
  onPick: (slug: string) => void;
  onWatch: (slug: string) => void;
}) {
  const feat = ev.featured;
  const showMarkets = watched || open;
  return (
    <article
      className={cn(
        "rounded border-l-2 px-2 py-1.5",
        open || watched ? "border-cyan-400 bg-cyan-500/5" : "border-slate-700/50",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button type="button" onClick={() => onPick(open ? "" : ev.slug)} className="min-w-0 flex-1 text-left">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-[12px] font-semibold leading-5 text-slate-200">{ev.title}</p>
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-cyan-200">
              {fmtPct(feat?.pct)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            {ev.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded-sm bg-slate-800 px-1 py-px text-slate-400">{t}</span>
            ))}
            <span className="tabular-nums">{fmtVol(ev.volume24hr ?? ev.volume)}</span>
            {ev.end ? <span className="tabular-nums">至 {fmtEnd(ev.end)}</span> : null}
            {feat?.label ? <span className="truncate text-slate-400">{feat.label}</span> : null}
          </div>
          {!showMarkets ? <div className="mt-1"><Bar pct={feat?.pct} /></div> : null}
        </button>
        <button
          type="button"
          title={watched ? "移出监控" : "加入监控"}
          onClick={() => onWatch(ev.slug)}
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border text-[11px]",
            watched
              ? "border-cyan-500/40 text-cyan-300 hover:border-rose-400/50 hover:text-rose-300"
              : "border-slate-700/60 text-slate-400 hover:border-cyan-500/50 hover:text-cyan-300",
          )}
        >
          {watched ? <X size={12} /> : <Plus size={12} />}
        </button>
      </div>
      {showMarkets && (
        <div className="mt-1.5 space-y-0.5 border-t border-white/[0.06] pt-1.5">
          {ev.description ? (
            <p className="mb-1 line-clamp-3 text-[11px] leading-[1.55] text-slate-400">{ev.description}</p>
          ) : null}
          {(ev.markets ?? []).map((m) => <MarketRow key={m.id || m.title} m={m} />)}
          {ev.n_markets > ev.markets.length ? (
            <p className="px-1.5 text-[10px] text-slate-600">另有 {ev.n_markets - ev.markets.length} 档</p>
          ) : null}
          <a
            href={`https://polymarket.com/event/${ev.slug}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 px-1.5 text-[10px] text-cyan-400/80 hover:text-cyan-300"
          >
            打开 Polymarket <ExternalLink size={10} />
          </a>
        </div>
      )}
    </article>
  );
}

export function PmPanel({
  events,
  slug,
  detail,
  watch,
  error,
  loading,
  emptyHint,
  onPick,
  onWatch,
}: {
  events: PmEvent[];
  slug: string;
  detail: PmEvent | null;
  watch: string[];
  error: string | null;
  loading: boolean;
  emptyHint: string;
  onPick: (slug: string) => void;
  onWatch: (slug: string) => void;
}) {
  const listed = events.some((e) => e.slug === slug);
  const rows = !slug || listed || !detail ? events : [detail, ...events.filter((e) => e.slug !== detail.slug)];
  return (
    <div className="h-full min-h-0 space-y-1 overflow-y-auto p-1.5">
      {error && <p className="px-1 py-4 text-center text-[11px] text-rose-400/80">{error}</p>}
      {loading && !rows.length && <p className="py-6 text-center text-[11px] text-slate-600">加载中…</p>}
      {!loading && !error && !rows.length && (
        <p className="px-3 py-6 text-center text-[11px] leading-5 text-slate-600">{emptyHint}</p>
      )}
      {rows.map((ev) => (
        <EventCard
          key={ev.slug}
          ev={slug === ev.slug && detail ? detail : ev}
          open={slug === ev.slug}
          watched={watch.includes(ev.slug)}
          onPick={onPick}
          onWatch={onWatch}
        />
      ))}
    </div>
  );
}
