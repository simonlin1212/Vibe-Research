import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { newsTag, tagColor } from "@/lib/newsTag";
import {
  dismissNewsToast, enqueueNewsToasts, incomingFromFresh, NEWS_SRC_LABEL,
  pruneNewsToasts, type NewsToast,
} from "@/lib/newsToast";
import { feedOf, useTelegraph, type FeedSource } from "@/lib/telegraphHub";
import { cn } from "@/lib/utils";

const FEEDS: FeedSource[] = ["cls", "lives", "jin10"];

function toastTime(t: string) {
  return t.slice(11, 16) || t.slice(-8, -3) || "";
}

export function NewsToastHost() {
  const snap = useTelegraph();
  const { pathname } = useLocation();
  const [toasts, setToasts] = useState<NewsToast[]>([]);
  const seenRef = useRef(new Set<string>());
  const hoverRef = useRef(false);
  const underAShareTabs = pathname.startsWith("/a-share");

  useEffect(() => {
    const already = seenRef.current;
    const incoming = FEEDS.flatMap((src) => (
      incomingFromFresh(feedOf(snap, src)?.items ?? [], snap.fresh[src], src, already)
    ));
    if (!incoming.length) return;
    incoming.forEach((it) => already.add(it.id));
    setToasts((q) => enqueueNewsToasts(q, incoming, Date.now()));
  }, [snap]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (hoverRef.current) return;
      const now = Date.now();
      setToasts((q) => {
        const next = pruneNewsToasts(q, now);
        return next.length === q.length ? q : next;
      });
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  if (!toasts.length) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed right-3 z-[70] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2",
        underAShareTabs ? "top-[7.25rem]" : "top-[4.75rem]",
      )}
      role="status"
      aria-live="polite"
      aria-label="7x24快讯"
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
    >
      {toasts.map((t) => {
        const inferred = newsTag(t.title, t.content || "");
        const labels = [...(t.tags ?? [])];
        if (inferred && !labels.includes(inferred.label)) labels.push(inferred.label);
        return (
          <article
            key={t.id}
            className="pointer-events-auto border border-[#2a2a2a] bg-black px-2 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] tabular-nums text-slate-500">{toastTime(t.time)}</span>
              <span className="text-[9px] text-primary/80">{NEWS_SRC_LABEL[t.source]}</span>
              {labels.map((label) => (
                <span
                  key={label}
                  className="rounded-sm px-1 py-px text-[9px] leading-none"
                  style={{ background: `${tagColor(label)}22`, color: tagColor(label) }}
                >
                  {label}
                </span>
              ))}
              <button
                type="button"
                className="ml-auto rounded p-0.5 text-slate-500 hover:bg-white/10 hover:text-slate-200"
                aria-label="关闭"
                onClick={() => setToasts((q) => dismissNewsToast(q, t.id))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <Link to="/a-share" className="mt-1 block text-[12px] font-semibold leading-5 text-slate-100 hover:text-primary">
              {t.title}
            </Link>
            {t.content && (
              <p className="mt-0.5 line-clamp-3 text-[11px] leading-[1.55] text-slate-400">{t.content}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
