import { useEffect, useRef } from "react";
import { newsTag, tagColor } from "@/lib/newsTag";
import { feedOf, itemKey, loadTelegraph, markClsSeen, useTelegraph, type FeedSource } from "@/lib/telegraphHub";
import type { ClsTelegraphItem } from "@/lib/api";
import { cn } from "@/lib/utils";

function TagPills({
  title, extra, isNew, cats,
}: {
  title: string; extra?: string; isNew?: boolean; cats?: string[];
}) {
  const inferred = newsTag(title, extra);
  const labels = [...(cats ?? [])];
  if (inferred && !labels.includes(inferred.label)) {
    const loose = inferred.label === "宏观" || inferred.label === "政策";
    if (!loose || !labels.length) labels.push(inferred.label);
  }
  if (!labels.length && !isNew) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {labels.map((label) => {
        const color = tagColor(label);
        return (
          <span
            key={label}
            className="rounded-sm px-1 py-px text-[10px] leading-none"
            style={{ background: `${color}22`, color }}
          >
            {label}
          </span>
        );
      })}
      {isNew && (
        <span className="bg-primary/20 px-1 py-px text-[10px] leading-none text-primary">NEW</span>
      )}
    </span>
  );
}

function NewsRow({ it, isNew }: { it: ClsTelegraphItem; isNew: boolean }) {
  const extra = it.content || it.summary || "";
  const body = extra && extra !== it.title ? extra : null;
  return (
    <article
      className={cn(
        "border-l-2 px-2.5 py-2 transition-colors hover:bg-white/[0.03]",
        isNew ? "border-primary bg-primary/5" : "border-transparent",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] tabular-nums text-slate-400">
          {(it.time || "").slice(11, 16) || (it.time || "").slice(-8, -3) || "—"}
        </span>
        <TagPills title={it.title} extra={extra} isNew={isNew} cats={it.tags} />
      </div>
      <p className="mt-0.5 text-[14px] font-semibold leading-6 text-slate-100">{it.title}</p>
      {body && <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.55] text-slate-400">{body}</p>}
    </article>
  );
}

export const NEWS_LANES: { src: FeedSource; label: string; accent: string }[] = [
  { src: "cls", label: "财联社", accent: "#ff4d4d" },
  { src: "lives", label: "新浪/见闻", accent: "#5b9cff" },
  { src: "jin10", label: "金十", accent: "#ffcc00" },
];

export function NewsAutoBar({ auto, onAuto }: { auto: boolean; onAuto: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-[12px] text-slate-400 hover:text-slate-200">
      <input
        type="checkbox"
        checked={auto}
        onChange={(e) => onAuto(e.target.checked)}
        className="accent-primary"
      />
      自动滚动
    </label>
  );
}

export function NewsFeedBar({
  source,
  auto,
  onSource,
  onAuto,
}: {
  source: FeedSource;
  auto: boolean;
  onSource: (s: FeedSource) => void;
  onAuto: (v: boolean) => void;
}) {
  const snap = useTelegraph();
  const count = feedOf(snap, source)?.count;
  return (
    <div className="flex items-center gap-1 text-[12px]">
      {NEWS_LANES.map(({ src: k, label }) => (
        <button
          key={k}
          type="button"
          onClick={() => onSource(k)}
          className={cn(
            "rounded px-1.5 py-0.5",
            source === k ? "bg-primary/15 text-primary" : "text-slate-400 hover:text-slate-200",
          )}
        >
          {label}
        </button>
      ))}
      <span className="mx-0.5 h-3 w-px bg-slate-700" />
      <label className="flex cursor-pointer items-center gap-1 text-slate-400">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => onAuto(e.target.checked)}
          className="accent-primary"
        />
        自动滚动{count != null ? ` · ${count}条` : ""}
      </label>
    </div>
  );
}

/** Three equal lanes. Same telegraph hub, no second poll. */
export function NewsTriple({ auto }: { auto: boolean }) {
  const snap = useTelegraph();
  return (
    <div className="grid h-full min-h-0 grid-cols-3">
      {NEWS_LANES.map(({ src, label, accent }) => {
        const n = feedOf(snap, src)?.count;
        const neu = snap.fresh[src]?.size ?? 0;
        return (
          <div
            key={src}
            className="flex min-h-0 min-w-0 flex-col border-l border-[#2a2a2a] first:border-l-0"
            style={{ boxShadow: `inset 2px 0 0 ${accent}` }}
          >
            <div
              className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[#2a2a2a] px-2.5"
              style={{ background: `${accent}18` }}
            >
              <span className="truncate text-[13px] font-semibold tracking-wide" style={{ color: accent }}>
                {label}
              </span>
              {neu > 0 ? (
                <span
                  className="shrink-0 rounded-sm px-1 text-[10px] font-semibold leading-4 text-black"
                  style={{ background: accent }}
                >
                  +{neu}
                </span>
              ) : null}
              {n != null ? (
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-slate-500">{n}</span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              <NewsCockpitPanel source={src} auto={auto} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** CLS + Sina/Wallstreetcn + Jin10 feed for the review cockpit cell. */
export function NewsCockpitPanel({ source, auto }: { source: FeedSource; auto: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const snap = useTelegraph();
  const data = feedOf(snap, source);
  const err = snap.err[source];
  const loading = snap.loading[source];
  const fresh = snap.fresh[source];

  useEffect(() => {
    void loadTelegraph(source);
  }, [source]);

  useEffect(() => {
    if (snap.cls) markClsSeen();
  }, [snap.cls]);

  useEffect(() => {
    if (!auto || !fresh.size) return;
    boxRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [auto, fresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={boxRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto scroll-smooth p-1.5">
        {err && <p className="px-1 py-4 text-center text-[13px] text-rose-400/80">{err}</p>}
        {loading && !data && <p className="py-6 text-center text-[13px] text-slate-600">加载中…</p>}
        {data && !(data.items?.length) && <p className="py-6 text-center text-[13px] text-slate-600">暂无数据</p>}
        {(data?.items ?? []).map((it, i) => (
          <NewsRow key={itemKey(it, i)} it={it} isNew={fresh.has(itemKey(it, i))} />
        ))}
      </div>
    </div>
  );
}
