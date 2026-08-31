import { useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, RefreshCw, Rss } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { NewsCockpitPanel, NewsFeedBar } from "@/components/cockpit/NewsCockpitPanel";
import { FreshTag } from "@/components/deriv/derivShared";
import { EventCalPanel } from "@/components/event/EventCalPanel";
import { usePolling } from "@/hooks/usePolling";
import { api, type EventCalBoard } from "@/lib/api";
import { peekTelegraphItems, type FeedSource } from "@/lib/telegraphHub";
import { cn } from "@/lib/utils";

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

function packEventContext(src: FeedSource, cal: EventCalBoard | null): string {
  const lines = ["# 事件页快照"];
  const news = peekTelegraphItems(src).slice(0, 16);
  lines.push("", `## 快讯 (${src})`);
  if (!news.length) lines.push("未取到");
  else {
    for (const it of news) {
      lines.push(`- ${it.time || ""} ${it.title}`);
    }
  }
  lines.push("", "## 财经日历");
  lines.push(...packCal(cal));
  return lines.join("\n");
}

export function EventCockpit() {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [newsAuto, setNewsAuto] = useState(true);
  const [newsSource, setNewsSource] = useState<FeedSource>("cls");
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const calPoll = usePolling(() => api.eventCalendar(), 300_000, [tick], true);

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
          hint: "财联社 / 新浪见闻 / 金十 · 与复盘同一口",
          icon: <Rss size={14} />,
          accent: "#ffcc00",
          defaultW: 0.50,
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
      ],
    },
  ], [newsSource, newsAuto, calPoll.data, calPoll.error, calPoll.updated]);

  const headerActions = (
    <>
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[12px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary",
        )}
        title="重拉日历"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packEventContext(newsSource, calPoll.data)}
        label="问 AI"
        scopeKey="event"
        suggestions={[
          "近几日财经日历里哪些值得盯?",
          "结合快讯, 日历里哪些和新闻对得上?",
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
