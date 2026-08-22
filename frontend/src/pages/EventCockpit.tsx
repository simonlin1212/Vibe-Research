import { useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { Percent, RefreshCw, Rss } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { NewsCockpitPanel, NewsFeedBar } from "@/components/cockpit/NewsCockpitPanel";
import { FreshTag } from "@/components/deriv/derivShared";
import { PmPanel, extractSlugs, fmtPct, fmtVol } from "@/components/event/PmPanel";
import { usePolling } from "@/hooks/usePolling";
import { api, type PmEvent } from "@/lib/api";
import { addPmWatch, addPmWatchMany, loadPmWatch, removePmWatch } from "@/lib/pmWatch";
import { peekTelegraphItems, type FeedSource } from "@/lib/telegraphHub";
import { cn } from "@/lib/utils";

type Tab = "watch" | "hot";

function packEventContext(src: FeedSource, events: PmEvent[], slug: string): string {
  const lines = ["# 事件页快照"];
  const news = peekTelegraphItems(src).slice(0, 16);
  lines.push("", `## 快讯 (${src})`);
  if (!news.length) lines.push("未取到");
  else {
    for (const it of news) {
      lines.push(`- ${it.time || ""} ${it.title}`);
    }
  }
  lines.push("", "## Polymarket 监控");
  if (!events.length) lines.push("未取到");
  else {
    for (const ev of events.slice(0, 16)) {
      const feat = ev.featured;
      lines.push(`- ${ev.title}: ${feat?.label ?? "?"} ${fmtPct(feat?.pct)}  vol ${fmtVol(ev.volume24hr ?? ev.volume)}`);
      for (const m of ev.markets.slice(0, 8)) {
        lines.push(`  - ${m.title}: Yes ${fmtPct(m.yes ?? m.outcomes[0]?.pct)}`);
      }
    }
  }
  if (slug) lines.push("", `当前查看: ${slug}`);
  return lines.join("\n");
}

export function EventCockpit() {
  const [params, setParams] = useSearchParams();
  const slug = params.get("slug") || "";
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [newsAuto, setNewsAuto] = useState(true);
  const [newsSource, setNewsSource] = useState<FeedSource>("cls");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("watch");
  const [watch, setWatch] = useState<string[]>(loadPmWatch);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const addFromDraft = () => {
    const slugs = extractSlugs(draft);
    if (slugs.length) {
      const next = addPmWatchMany(slugs, watch);
      setWatch(next);
      setDraft("");
      setQ("");
      setTab("watch");
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set("slug", slugs[0]);
        return p;
      }, { replace: true });
      return;
    }
    const t = draft.trim();
    if (t) {
      setTab("hot");
      setQ(t);
    }
  };

  const toggleWatch = (s: string) => {
    if (watch.includes(s)) setWatch(removePmWatch(s, watch));
    else {
      setWatch(addPmWatch(s, watch));
      setTab("watch");
    }
  };

  const searching = tab === "hot" && Boolean(q);
  const watchPoll = usePolling(
    () => api.polymarketWatch(watch),
    30_000,
    [watch.join(","), tick],
    tab === "watch" && watch.length > 0,
  );
  const board = usePolling(() => api.polymarketBoard(), searching ? 0 : 30_000, [tick], tab === "hot" && !searching);
  const found = usePolling(
    () => api.polymarketSearch(q),
    searching ? 30_000 : 0,
    [q, tick],
    searching,
  );
  const detail = usePolling(
    () => api.polymarketEvent(slug),
    slug ? 30_000 : 0,
    [slug, tick],
    Boolean(slug) && tab === "hot",
  );

  const events = tab === "watch"
    ? (watchPoll.data?.events ?? [])
    : searching ? (found.data?.events ?? []) : (board.data?.events ?? []);
  const err = tab === "watch" ? watchPoll.error : searching ? found.error : board.error;
  const loading = tab === "watch"
    ? watch.length > 0 && !watchPoll.data && !watchPoll.error
    : searching ? !found.data && !found.error : !board.data && !board.error;
  const updated = tab === "watch" ? watchPoll.updated : searching ? found.updated : board.updated;

  const setSlug = (s: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (s) next.set("slug", s);
      else next.delete("slug");
      return next;
    }, { replace: true });
  };

  const rows: CockpitRow[] = useMemo(() => [
    {
      defaultH: 1,
      panels: [
        {
          id: "event-news",
          title: "实时新闻",
          hint: "财联社 / 新浪见闻 / 金十 · 与复盘同一口",
          icon: <Rss size={14} />,
          accent: "#38bdf8",
          defaultW: 0.40,
          mobileH: "h-[56vh]",
          right: (
            <NewsFeedBar
              source={newsSource}
              auto={newsAuto}
              onSource={setNewsSource}
              onAuto={setNewsAuto}
            />
          ),
          bodyClassName: "overflow-hidden",
          body: <NewsCockpitPanel source={newsSource} auto={newsAuto} />,
        },
        {
          id: "event-pm",
          title: "Polymarket",
          hint: tab === "watch" ? "本机监控 · 粘贴事件链接加入" : "24h 成交额 · 点 + 加入监控",
          icon: <Percent size={14} />,
          accent: "#e879f9",
          defaultW: 0.60,
          mobileH: "h-[70vh]",
          right: (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => { setTab("watch"); setQ(""); }}
                className={cn("rounded px-1.5 py-0.5 text-[10px]", tab === "watch" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-400 hover:text-slate-200")}
              >
                监控{watch.length ? ` ${watch.length}` : ""}
              </button>
              <button
                type="button"
                onClick={() => setTab("hot")}
                className={cn("rounded px-1.5 py-0.5 text-[10px]", tab === "hot" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-400 hover:text-slate-200")}
              >
                热门
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addFromDraft(); }}
                placeholder="粘贴链接加入"
                className="h-6 w-[8.5rem] rounded border border-slate-700/60 bg-black/30 px-1.5 text-[11px] text-slate-200 placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={addFromDraft}
                className="h-6 rounded border border-slate-700/60 px-1.5 text-[10px] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-300"
              >
                加入
              </button>
              <FreshTag updated={updated} />
            </div>
          ),
          bodyClassName: "overflow-hidden",
          body: (
            <PmPanel
              events={events}
              slug={slug}
              detail={detail.data}
              watch={watch}
              error={err || (tab === "hot" ? detail.error : null)}
              loading={loading}
              emptyHint={tab === "watch" ? "粘贴 Polymarket 事件链接, 点加入. 可一次贴多条." : "暂无事件"}
              onPick={setSlug}
              onWatch={toggleWatch}
            />
          ),
        },
      ],
    },
  ], [newsSource, newsAuto, draft, events, slug, detail.data, detail.error, err, loading, updated, tab, watch]);

  const headerActions = (
    <>
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px] text-slate-400 transition-colors hover:border-cyan-500/50 hover:text-cyan-300",
        )}
        title="重拉 Polymarket"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packEventContext(newsSource, events, slug)}
        label="问 AI"
        scopeKey="event"
        suggestions={[
          "监控里这些事件各档概率现在怎么排?",
          "结合快讯, 哪些档和新闻对得上?",
          "WTI 各价位 Yes 概率差在哪?",
        ]}
      />
    </>
  );

  return (
    <div className="relative flex flex-col bg-background lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden">
      {headerSlot ? createPortal(headerActions, headerSlot) : null}
      <CockpitLayout rows={rows} />
    </div>
  );
}
