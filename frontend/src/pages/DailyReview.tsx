import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  Sparkles, Loader2, AlertCircle, RefreshCw, X,
  ListOrdered, Globe, Layers, BarChart3,
  Activity, Star, Flame, ScrollText, LineChart,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { Chip, ChipGroup } from "@/components/ui/SectionHeader";
import { PageFallback } from "@/components/ui/PageFallback";
import { ReviewSentimentPanel } from "@/components/review/ReviewSentimentPanel";
import { ReviewBoardsSeg } from "@/components/review/ReviewBoardsSeg";
import { ReviewMoneySeg } from "@/components/review/ReviewMoneySeg";
import { ReviewRiskSeg } from "@/components/review/ReviewRiskSeg";
import { ChainPanel } from "@/components/review/ChainPanel";
import { WorldIndexPanel } from "@/components/cockpit/WorldIndexPanel";
import { SectorHotBar, SectorHotPanel, type SectorKind } from "@/components/cockpit/SectorHotPanel";
import { BoardFlowLivePanel } from "@/components/cockpit/BoardFlowLivePanel";
import { MoneyFlowRankPanel } from "@/components/cockpit/MoneyFlowRankPanel";
import { RankTabBar, StockRankPanel, type RankTab } from "@/components/cockpit/StockRankPanel";
import { CommodityPanel } from "@/components/cockpit/CommodityPanel";
import { reviewPending } from "@/components/review/reviewPending";
import { useReviewData } from "@/hooks/useReviewData";
import { api, ApiError } from "@/lib/api";
import { collectReviewContext } from "@/lib/reviewContext";
import { hasLlm, chatStream } from "@/lib/llm";

const AShareLightChart = lazy(() =>
  import("@/pages/AShareLightChart").then((m) => ({ default: m.AShareLightChart })),
);

export function DailyReview() {
  const d = useReviewData();
  const [review, setReview] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [flowSector, setFlowSector] = useState<{ code: string; name: string } | null>(null);
  const [moneyRight, setMoneyRight] = useState<ReactNode>(null);
  const [flowRight, setFlowRight] = useState<ReactNode>(null);
  const [sectorKind, setSectorKind] = useState<SectorKind>("01");
  const [sectorQ, setSectorQ] = useState("");
  const [rankTab, setRankTab] = useState<RankTab>("hot");
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const runReview = async () => {
    setReviewErr(null);
    setNeedConfig(false);
    if (!hasLlm()) { setNeedConfig(true); return; }
    setReviewLoading(true);
    setReview("");
    try {
      const packed = await api.reviewContext({
        watch_codes: d.watchCodes,
        sector_kind: sectorKind,
        news_source: "cls",
      });
      const snap = packed.text;
      const prompt = `以下是今天复盘驾驶舱的客观快照(与当前看板同源):\n${snap}\n\n${packed.prompt_task}`;
      await chatStream([{ role: "user", content: prompt }], snap, {
        onDelta: (t) => setReview((r) => r + t),
      });
    } catch (e) {
      setReviewErr(e instanceof ApiError ? e.message : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  const showReviewPanel = Boolean(aiOpen && (review || reviewLoading || needConfig || reviewErr));
  const chainOn = d.seg === "chain";

  const moneyProps = {
    etfShares: d.etfShares,
    etfSharesList: d.etfSharesList,
    etfFlow: d.etfFlow,
    etfSort: d.etfSort,
    onEtfSort: d.setEtfSort,
    lpr: d.lpr,
    bondY: d.bondY,
    shChg: d.shChg,
    shType: d.shType,
    onShType: d.setShType,
    moneyDone: d.moneyDone,
  };

  const topRows: CockpitRow[] = [
    {
      defaultH: 1,
      panels: [
        {
          id: "market-watch",
          title: "行情观察",
          hint: "全球关键指数 + 宏观观察",
          icon: <Globe size={14} />,
          accent: "#ffcc00",
          defaultW: 0.30,
          mobileH: "h-[64vh]",
          right: <span className="text-[10px] tabular-nums text-slate-500">5s</span>,
          body: (
            <div className="flex h-full min-h-0 flex-col sm:flex-row">
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-b border-slate-800/60 sm:border-b-0 sm:border-r">
                <WorldIndexPanel />
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <CommodityPanel />
              </div>
            </div>
          ),
        },
        {
          id: "sentiment",
          title: "涨跌分布 / 广度",
          icon: <BarChart3 size={14} />,
          accent: "#ffcc00",
          defaultW: 0.16,
          mobileH: "h-[380px]",
          right: (
            <span className="flex items-center gap-1.5 text-[10px] tabular-nums text-slate-500">
              {d.breadth?.n ? <span>家数 {d.breadth.n}</span> : null}
              <span>{d.breadthLabel}</span>
            </span>
          ),
          body: (
            <ReviewSentimentPanel
              sentiment={d.sentiment}
              ovDone={d.ovDone}
              pending={reviewPending(false, "lines")}
              breadth={d.breadth}
            />
          ),
        },
        {
          id: "sectors",
          title: "市场板块实时热点",
          hint: "点击板块看个股列表",
          icon: <Layers size={14} />,
          accent: "#00d26a",
          defaultW: 0.27,
          mobileH: "h-[420px]",
          right: (
            <SectorHotBar
              kind={sectorKind}
              q={sectorQ}
              onKind={setSectorKind}
              onQuery={setSectorQ}
            />
          ),
          body: (
            <SectorHotPanel
              kind={sectorKind}
              q={sectorQ}
            />
          ),
        },
        {
          id: "flow",
          title: "板块资金流向",
          icon: <Activity size={14} />,
          accent: "#ff4d4f",
          defaultW: 0.27,
          mobileH: "h-[380px]",
          right: flowRight,
          body: (
            <BoardFlowLivePanel
              selected={flowSector}
              onSelect={setFlowSector}
              onRight={setFlowRight}
            />
          ),
        },
      ],
    },
  ];

  const bottomLeft: CockpitRow[] = [
    {
      defaultH: 1,
      panels: [
        {
          id: "watch",
          title: "自选",
          hint: "点行出中间分时和日K",
          icon: <Star size={14} />,
          accent: "#ffcc00",
          defaultW: 1,
          mobileH: "h-[380px]",
          right: (
            <span className="text-[10px] tabular-nums text-slate-500">
              {d.watchCodes.length}只 · 5s
            </span>
          ),
          body: (
            <Suspense fallback={<PageFallback />}>
              <AShareLightChart embedded pane="table" />
            </Suspense>
          ),
        },
      ],
    },
  ];

  const bottomCenter: CockpitRow[] = [
    {
      defaultH: 1,
      panels: [
        {
          id: "ashare-chart",
          title: "分时 / 日K",
          hint: "上分时下日K, 点自选或榜单出图",
          icon: <LineChart size={14} />,
          accent: "#ffcc00",
          defaultW: 1,
          mobileH: "h-[640px]",
          bodyClassName: "!overflow-hidden p-0",
          body: (
            <Suspense fallback={<PageFallback />}>
              <AShareLightChart embedded pane="charts" />
            </Suspense>
          ),
        },
      ],
    },
  ];

  const bottomRight: CockpitRow[] = [
    {
      defaultH: 0.32,
      panels: [
        {
          id: "rank",
          title: "个股榜单",
          icon: <ListOrdered size={14} />,
          accent: "#ffcc00",
          defaultW: 1,
          mobileH: "h-[380px]",
          right: <RankTabBar tab={rankTab} onTab={setRankTab} />,
          body: <StockRankPanel tab={rankTab} />,
        },
      ],
    },
    {
      defaultH: 0.68,
      panels: [
        {
          id: "risk",
          title: "涨跌停",
          icon: <Flame size={14} />,
          accent: "#ff4d4f",
          defaultW: chainOn ? 0.28 : 0.32,
          mobileH: "h-[380px]",
          right: (
            <span className="text-[10px] tabular-nums text-slate-500">盘中 90s</span>
          ),
          body: (
            <ReviewRiskSeg
              emotion={d.emotion}
              emoDone={d.emoDone}
            />
          ),
        },
        {
          id: "detail",
          title: "主力 / 龙虎 / 资金 / 产业链",
          icon: <ScrollText size={14} />,
          accent: "#ffcc00",
          defaultW: chainOn ? 0.72 : 0.68,
          mobileH: "h-[520px]",
          maxZoomW: 0.82,
          right: (
            <div className="flex items-center gap-1.5">
              {d.seg === "inflow" ? moneyRight : null}
              <ChipGroup>
                {([
                  ["inflow", "主力"],
                  ["boards", "龙虎"],
                  ["money", "资金"],
                  ["chain", "产业链"],
                ] as const).map(([k, label]) => (
                  <Chip key={k} active={d.seg === k} onClick={() => d.setSeg(k)}>{label}</Chip>
                ))}
              </ChipGroup>
            </div>
          ),
          body: (
            <div className="h-full min-h-0 overflow-auto p-1">
              {d.seg === "inflow" ? (
                <MoneyFlowRankPanel
                  sectorFilter={flowSector}
                  onClearSector={() => setFlowSector(null)}
                  onRight={setMoneyRight}
                />
              ) : d.seg === "boards" ? (
                <ReviewBoardsSeg
                  lhb={d.lhb}
                  lhbDone={d.lhbDone}
                />
              ) : d.seg === "chain" ? (
                <ChainPanel />
              ) : (
                <ReviewMoneySeg {...moneyProps} />
              )}
            </div>
          ),
        },
      ],
    },
  ];

  const headerActions = (
    <>
      <button
        type="button"
        onClick={d.refreshTopRows}
        disabled={d.topRefreshing}
        className="inline-flex items-center gap-1 border border-[#333] bg-[#111] px-1.5 py-0.5 text-[10px] text-[#aaa] hover:border-primary/50 hover:text-primary disabled:opacity-50"
      >
        <RefreshCw className={`h-3 w-3 ${d.topRefreshing ? "animate-spin" : ""}`} />
        刷新
      </button>
      <button
        type="button"
        onClick={() => { setAiOpen(true); void runReview(); }}
        disabled={reviewLoading}
        className="inline-flex items-center gap-1 border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50"
      >
        {reviewLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        AI 复盘
      </button>
      <AskAiButton
        context=""
        getContext={() => collectReviewContext({
          watchCodes: d.watchCodes,
          sectorKind,
          newsSource: "cls",
        })}
        label="问 AI"
        suggestions={["今天大盘怎么走", "哪些指数领涨领跌", "盘面有什么值得注意"]}
      />
    </>
  );
  return (
    <div className="relative flex flex-col bg-background lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden">
      {headerSlot ? createPortal(headerActions, headerSlot) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-px bg-[#2a2a2a] lg:h-full">
        <div className="flex min-h-0 flex-col lg:h-[30%]">
          <CockpitLayout rows={topRows} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px lg:h-[70%] lg:flex-row">
          <div className="flex min-h-0 flex-col lg:h-full lg:w-[30%]">
            <CockpitLayout rows={bottomLeft} />
          </div>
          <div className="flex min-h-0 flex-col lg:h-full lg:w-[43%]">
            <CockpitLayout rows={bottomCenter} />
          </div>
          <div className="flex min-h-0 flex-col lg:h-full lg:w-[27%]">
            <CockpitLayout rows={bottomRight} />
          </div>
        </div>
      </div>

      {showReviewPanel && (
        <div className="absolute inset-x-2 top-8 z-30 max-h-[70%] overflow-auto border border-primary/40 bg-black p-3 sm:inset-x-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[#eee]">
              <Sparkles className="h-4 w-4 text-primary" /> AI 当日复盘
            </h3>
            <div className="flex items-center gap-2">
              {reviewLoading && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 生成中
                </span>
              )}
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                className="border border-[#333] p-1 text-[#888] hover:text-primary"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            已带入当前看板各格快照 (指数 / 板块 / 资金 / 榜单 / 涨跌停等)
          </p>
          {needConfig && (
            <div className="mt-3 flex items-center gap-2 rounded border border-warning/30 bg-warning/5 p-3 text-sm text-slate-400">
              <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
              还没接入 AI。<Link to="/settings" className="text-primary">先去接入你的 AI</Link>，之后一键出复盘。
            </div>
          )}
          {reviewErr && (
            <div className="mt-3 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" /> {reviewErr}
            </div>
          )}
          {review ? (
            <div className="prose prose-sm dark:prose-invert mt-3 max-w-none text-slate-200">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{review}</ReactMarkdown>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
