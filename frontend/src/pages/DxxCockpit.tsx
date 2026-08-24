import { useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Flame, Layers, RefreshCw, Trophy, Zap } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import {
  DabanPanel, FengdanPanel, FupanWajuePanel, QingxuPanel, StrongPanel, ZtlivePanel, packDxxContext,
} from "@/components/dxx/panels";
import { FreshTag } from "@/components/deriv/derivShared";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function DxxCockpit() {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [tick, setTick] = useState(0);
  const poll = usePolling(() => api.dxxBoard(), 60_000, [tick], true);
  const board = poll.data;

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const rows: CockpitRow[] = useMemo(() => [
    {
      defaultH: 1,
      panels: [
        {
          id: "dxx-fengdan",
          title: "竞价封单",
          hint: "9:15 / 9:20 / 9:25 · 短线侠 getFengdanLast",
          icon: <Zap size={14} />,
          accent: "#ffcc00",
          defaultW: 0.34,
          mobileH: "h-[56vh]",
          right: <FreshTag updated={poll.updated} />,
          bodyClassName: "overflow-hidden",
          body: <FengdanPanel days={board?.fengdan?.days ?? []} />,
        },
        {
          id: "dxx-daban",
          title: "竞价 / 打板",
          hint: "getDabanData · 09:15 起",
          icon: <Flame size={14} />,
          accent: "#ffcc00",
          defaultW: 0.38,
          mobileH: "h-[56vh]",
          bodyClassName: "overflow-hidden",
          body: <DabanPanel rows={board?.daban?.rows ?? []} />,
        },
        {
          id: "dxx-ztlive",
          title: "涨停直播",
          hint: `getZtliveData${board?.ztlive?.count ? ` · ${board.ztlive.count}只` : ""}`,
          icon: <Trophy size={14} />,
          accent: "#ffcc00",
          defaultW: 0.28,
          mobileH: "h-[48vh]",
          bodyClassName: "overflow-hidden",
          body: <ZtlivePanel rows={board?.ztlive?.rows ?? []} />,
        },
      ],
    },
    {
      defaultH: 1,
      panels: [
        {
          id: "dxx-qx",
          title: "情绪",
          hint: "getLastQxlive / getChartByQingxu · 上游字段",
          icon: <Activity size={14} />,
          accent: "#ffcc00",
          defaultW: 0.34,
          mobileH: "h-[42vh]",
          bodyClassName: "overflow-hidden",
          body: <QingxuPanel live={board?.qxlive ?? null} hist={board?.qingxu ?? null} />,
        },
        {
          id: "dxx-strong",
          title: "板块强度",
          hint: "getLiveByStrong",
          icon: <Layers size={14} />,
          accent: "#ffcc00",
          defaultW: 0.33,
          mobileH: "h-[42vh]",
          bodyClassName: "overflow-hidden",
          body: <StrongPanel data={board?.strong ?? null} />,
        },
        {
          id: "dxx-fupan",
          title: "复盘 / 挖掘",
          hint: "getFupanByYidong · getWajueMatch 匹配次数",
          icon: <Flame size={14} />,
          accent: "#ffcc00",
          defaultW: 0.33,
          mobileH: "h-[48vh]",
          bodyClassName: "overflow-hidden",
          body: <FupanWajuePanel fupan={board?.fupan ?? null} wajue={board?.wajue?.rows ?? []} />,
        },
      ],
    },
  ], [board, poll.updated]);

  const headerActions = (
    <>
      {poll.error ? <span className="text-[10px] text-destructive">{poll.error}</span> : null}
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary",
        )}
        title="重拉短线侠"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packDxxContext(board)}
        label="问 AI"
        scopeKey="dxx"
        suggestions={[
          "今天竞价封单和一字家数怎么看?",
          "涨停直播里主线题材是哪些?",
          "短线侠情绪字段和涨停/跌停家数对得上吗?",
          "打板表里哪些板和概念重复出现?",
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
