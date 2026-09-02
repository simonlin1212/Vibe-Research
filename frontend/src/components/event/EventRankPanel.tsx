import { useMemo, useState } from "react";
import type { EventRankItem, EventRankTab } from "@/lib/api";
import { cn } from "@/lib/utils";

const RANK_TONE = ["#ff2d2d", "#ff8a3d", "#ffcc00"] as const;

function rankColor(n: number): string {
  return n >= 1 && n <= 3 ? RANK_TONE[n - 1] : "#94a3b8";
}

export function RankTabs({
  tabs,
  value,
  onChange,
  wrap,
}: {
  tabs: { id: string; name: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
  wrap?: boolean;
}) {
  if (tabs.length <= 1) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5",
        wrap ? "flex-wrap" : "max-w-full overflow-x-auto [scrollbar-width:none]",
      )}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 text-[12px]",
            value === t.id
              ? "bg-primary/20 font-medium text-primary"
              : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
          )}
        >
          {t.name}
          {t.count != null ? (
            <span className="ml-1 font-mono text-[10px] tabular-nums opacity-70">{t.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function RankRow({ it, tweet }: { it: EventRankItem; tweet?: boolean }) {
  const inner = (
    <>
      <span
        className="w-6 shrink-0 pt-px text-right font-mono text-[12px] font-semibold tabular-nums"
        style={{ color: rankColor(it.rank) }}
      >
        {it.rank}
      </span>
      <span className="min-w-0 flex-1">
        {tweet && (it.handle || it.metric) ? (
          <span className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-slate-400">
            {it.handle ? <span className="text-slate-300">@{it.handle}</span> : null}
            {it.age ? <span>{it.age}</span> : null}
            {it.metric ? <span className="text-primary/90">{it.metric}</span> : null}
          </span>
        ) : it.extra ? (
          <span className="mb-0.5 block truncate text-[11px] text-slate-400">{it.extra}</span>
        ) : null}
        <span className="block text-[13px] leading-snug text-slate-100">{it.title}</span>
      </span>
    </>
  );
  const cls = "flex items-start gap-1.5 border-t border-[#2a2a2a] px-2 py-1.5 first:border-t-0";
  if (it.url) {
    return (
      <a href={it.url} target="_blank" rel="noreferrer" className={cn(cls, "hover:bg-white/[0.04]")}>
        {inner}
      </a>
    );
  }
  return <div className={cls}>{inner}</div>;
}

export function RankList({
  items,
  tweet,
  loading,
  error,
}: {
  items: EventRankItem[];
  tweet?: boolean;
  loading?: boolean;
  error?: string | null;
}) {
  if (loading && !items.length) {
    return <p className="px-2 py-6 text-center text-[13px] text-slate-500">拉热榜…</p>;
  }
  if (error && !items.length) {
    return <p className="px-2 py-6 text-center text-[13px] text-destructive">{error}</p>;
  }
  if (!items.length) {
    return <p className="px-2 py-6 text-center text-[13px] text-slate-500">暂无条目</p>;
  }
  return (
    <div className="h-full overflow-y-auto">
      {items.map((it) => (
        <RankRow key={`${it.rank}-${it.url || it.title}`} it={it} tweet={tweet} />
      ))}
    </div>
  );
}

/** Tabs on their own row so long names (腾讯网-综合早报) stay visible. */
export function RankBoard({
  tabs,
  value,
  onChange,
  items,
  tweet,
  loading,
  error,
}: {
  tabs: { id: string; name: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
  items: EventRankItem[];
  tweet?: boolean;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#2a2a2a] px-1 py-0.5">
        <RankTabs wrap tabs={tabs} value={value} onChange={onChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <RankList items={items} tweet={tweet} loading={loading} error={error} />
      </div>
    </div>
  );
}

const HOT_ALIAS: Record<string, string> = {
  金十数据: "金十",
};
const HOT_DROP = new Set(["雪球"]);

export function hotTabKey(name: string): string {
  return HOT_ALIAS[name] ?? name;
}

/** NewsNow first, then REBANG uniques. Drop empty and same-name dupes (微博/知乎/金十). */
export function mergeHotTabs(
  newsnow?: EventRankTab[],
  rebang?: EventRankTab[],
): EventRankTab[] {
  const out: EventRankTab[] = [];
  const seen = new Set<string>();
  const push = (t: EventRankTab) => {
    if (!t.items.length) return;
    const key = hotTabKey(t.name);
    if (HOT_DROP.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(key === t.name ? t : { ...t, name: key });
  };
  for (const t of newsnow ?? []) push(t);
  for (const t of rebang ?? []) push(t);
  return out;
}

export function pickTab(tabs: EventRankTab[] | undefined, prefer: string[]): string {
  const rows = tabs ?? [];
  for (const name of prefer) {
    const hit = rows.find((t) => t.name === name && t.items.length);
    if (hit) return hit.id;
  }
  const first = rows.find((t) => t.items.length) ?? rows[0];
  return first?.id ?? "";
}

export function useRankTab(tabs: EventRankTab[] | undefined, prefer: string[]) {
  const fallback = useMemo(() => pickTab(tabs, prefer), [tabs, prefer.join("|")]);
  const [id, setId] = useState("");
  const cur = tabs?.some((t) => t.id === id) ? id : fallback;
  const items = tabs?.find((t) => t.id === cur)?.items ?? [];
  return { id: cur, setId, items };
}
