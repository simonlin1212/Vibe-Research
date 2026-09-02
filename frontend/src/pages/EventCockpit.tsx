import { useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Flame, RefreshCw, Rss, Sparkles, Twitter } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { NewsAutoBar, NewsTriple } from "@/components/cockpit/NewsCockpitPanel";
import { FreshTag } from "@/components/deriv/derivShared";
import { EventCalPanel } from "@/components/event/EventCalPanel";
import { mergeHotTabs, RankBoard, RankList, RankTabs, useRankTab } from "@/components/event/EventRankPanel";
import { usePolling } from "@/hooks/usePolling";
import { api, type EventCalBoard, type EventRankBoard, type EventRankItem } from "@/lib/api";
import { FEED_SOURCES, peekTelegraphItems } from "@/lib/telegraphHub";
import { cn } from "@/lib/utils";

const HOT_PREFER = ["财联社", "东方财富", "华尔街见闻", "金十", "微博"];
const AH_PREFER = ["全部", "主题", "热点", "精选"];

function packCal(cal: EventCalBoard | null): string[] {
  const days = cal?.days ?? [];
  if (!days.length) return ["未取到"];
  const out: string[] = [];
  for (const g of days.slice(0, 5)) {
    out.push(`${g.date}`);
    for (const t of g.items.slice(0, 8)) out.push(`- ${t}`);
  }
  return out;
}

function packItems(title: string, items: EventRankItem[]): string[] {
  const lines = ["", `## ${title}`];
  if (!items.length) {
    lines.push("未取到");
    return lines;
  }
  for (const it of items.slice(0, 12)) {
    const who = it.handle ? `@${it.handle} ` : "";
    lines.push(`${it.rank}. ${who}${it.title}`);
  }
  return lines;
}

function packEventContext(
  cal: EventCalBoard | null,
  ranks: EventRankBoard | null,
  hotItems: EventRankItem[],
  ahItems: EventRankItem[],
  soKind: "rising" | "hot",
): string {
  const lines = ["# 资讯页快照"];
  const names = { cls: "财联社", lives: "新浪/见闻", jin10: "金十" } as const;
  for (const src of FEED_SOURCES) {
    const news = peekTelegraphItems(src).slice(0, 10);
    lines.push("", `## 快讯 (${names[src]})`);
    if (!news.length) lines.push("未取到");
    else {
      for (const it of news) {
        lines.push(`- ${it.time || ""} ${it.title}`);
      }
    }
  }
  lines.push("", "## 财经日历");
  lines.push(...packCal(cal));
  lines.push(...packItems(`X起爆 · ${soKind === "hot" ? "最热" : "飙升"}`, ranks?.sopilot?.[soKind] ?? []));
  lines.push(...packItems("热榜", hotItems));
  lines.push(...packItems("AIHOT", ahItems));
  return lines.join("\n");
}

export function EventCockpit() {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [newsAuto, setNewsAuto] = useState(true);
  const [soKind, setSoKind] = useState<"rising" | "hot">("rising");
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const calPoll = usePolling(() => api.eventCalendar(), 300_000, [tick], true);
  const rankPoll = usePolling(() => api.eventRanks(), 180_000, [tick], true);
  const ranks = rankPoll.data;
  const hotTabs = useMemo(
    () => mergeHotTabs(ranks?.newsnow?.tabs, ranks?.rebang?.tabs),
    [ranks?.newsnow?.tabs, ranks?.rebang?.tabs],
  );
  const hot = useRankTab(hotTabs, HOT_PREFER);
  const ah = useRankTab(ranks?.aihot?.tabs, AH_PREFER);
  const soItems = (soKind === "hot" ? ranks?.sopilot?.hot : ranks?.sopilot?.rising) ?? [];

  const rows: CockpitRow[] = useMemo(() => [
    {
      defaultH: 1,
      panels: [
        {
          id: "event-cal",
          title: "财经日历",
          hint: "短线侠日程 · 与九言同一口",
          icon: <CalendarDays size={14} />,
          accent: "#ffcc00",
          defaultW: 0.50,
          mobileH: "h-[48vh]",
          right: <FreshTag updated={calPoll.updated} />,
          bodyClassName: "overflow-hidden",
          body: (
            <EventCalPanel
              data={calPoll.data}
              error={calPoll.error}
              loading={!calPoll.data && !calPoll.error}
            />
          ),
        },
        {
          id: "event-news",
          title: "实时新闻",
          hint: "与复盘同一口",
          icon: <Rss size={14} />,
          accent: "#ffcc00",
          defaultW: 0.50,
          mobileH: "h-[56vh]",
          right: <NewsAutoBar auto={newsAuto} onAuto={setNewsAuto} />,
          bodyClassName: "overflow-hidden",
          body: <NewsTriple auto={newsAuto} />,
        },
      ],
    },
    {
      defaultH: 1,
      panels: [
        {
          id: "event-sopilot",
          title: "X起爆",
          hint: "推文起爆",
          icon: <Twitter size={14} />,
          accent: "#1d9bf0",
          defaultW: 0.30,
          mobileH: "h-[52vh]",
          right: (
            <RankTabs
              tabs={[
                { id: "rising", name: "飙升", count: ranks?.sopilot?.rising?.length },
                { id: "hot", name: "最热", count: ranks?.sopilot?.hot?.length },
              ]}
              value={soKind}
              onChange={(id) => setSoKind(id === "hot" ? "hot" : "rising")}
            />
          ),
          bodyClassName: "overflow-hidden",
          body: (
            <RankList
              items={soItems}
              tweet
              loading={!ranks && !rankPoll.error}
              error={rankPoll.error}
            />
          ),
        },
        {
          id: "event-hot",
          title: "热榜",
          hint: "聚合",
          icon: <Flame size={14} />,
          accent: "#2ee59d",
          defaultW: 0.40,
          mobileH: "h-[52vh]",
          bodyClassName: "overflow-hidden",
          body: (
            <RankBoard
              tabs={hotTabs.map((t) => ({ id: t.id, name: t.name, count: t.items.length }))}
              value={hot.id}
              onChange={hot.setId}
              items={hot.items}
              loading={!ranks && !rankPoll.error}
              error={rankPoll.error}
            />
          ),
        },
        {
          id: "event-aihot",
          title: "AIHOT",
          hint: "AI 动态",
          icon: <Sparkles size={14} />,
          accent: "#c084fc",
          defaultW: 0.30,
          mobileH: "h-[52vh]",
          right: (
            <RankTabs
              tabs={(ranks?.aihot?.tabs ?? []).map((t) => ({ id: t.id, name: t.name, count: t.items.length }))}
              value={ah.id}
              onChange={ah.setId}
            />
          ),
          bodyClassName: "overflow-hidden",
          body: (
            <RankList
              items={ah.items}
              loading={!ranks && !rankPoll.error}
              error={rankPoll.error}
            />
          ),
        },
      ],
    },
  ], [
    newsAuto, calPoll.data, calPoll.error, calPoll.updated,
    ranks, rankPoll.error, soKind, soItems, hotTabs, hot.id, hot.items,
    ah.id, ah.items,
  ]);

  const headerActions = (
    <>
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[12px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary",
        )}
        title="重拉日历和热榜"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packEventContext(calPoll.data, ranks, hot.items, ah.items, soKind)}
        label="问 AI"
        scopeKey="event"
        suggestions={[
          "近几日财经日历里哪些值得盯?",
          "结合快讯和热榜, 日历里哪些和新闻对得上?",
          "X起爆和国内热榜里哪些跟盘面有关?",
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
