import { lazy, Suspense } from "react";
import { BarChart3, Building2, CalendarDays, FileText, GitCompare, TrendingUp, Zap } from "lucide-react";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { FinProvider, useFin } from "@/components/fin/FinContext";
import { FinCalendarPanel } from "@/components/fin/FinCalendarPanel";
import { FinForecastPanel } from "@/components/fin/FinForecastPanel";
import { FinIndustryPanel } from "@/components/fin/FinIndustryPanel";
import { FinStockRankPanel } from "@/components/fin/FinStockRankPanel";
import { PeriodTabs } from "@/components/fin/PeriodTabs";
import { IndustryModeTabs, PeerModeTabs, StockRankTabs, TrendTabs } from "@/components/fin/FinTabs";

const FinCompanyPanel = lazy(() =>
  import("@/components/fin/FinCompanyPanel").then((m) => ({ default: m.FinCompanyPanel })),
);
const FinTrendPanel = lazy(() =>
  import("@/components/fin/FinTrendPanel").then((m) => ({ default: m.FinTrendPanel })),
);
const FinPeerPanel = lazy(() =>
  import("@/components/fin/FinPeerPanel").then((m) => ({ default: m.FinPeerPanel })),
);

function CellWait() {
  return <p className="px-3 py-8 text-center text-[12px] text-slate-600">加载中…</p>;
}

function FinBody() {
  const { company, board } = useFin();
  const rows: CockpitRow[] = [
    {
      defaultH: 0.40,
      panels: [
        {
          id: "cal",
          title: "财报日历",
          icon: <CalendarDays size={14} />,
          accent: "#ffcc00",
          defaultW: 0.22,
          maxZoomW: 0.3,
          mobileH: "h-[300px]",
          right: board ? (
            <span className="font-mono text-[10px] text-slate-500">已披露 {board.disclosed} 家</span>
          ) : undefined,
          body: <FinCalendarPanel />,
        },
        {
          id: "fc",
          title: "业绩预告",
          icon: <Zap size={14} />,
          accent: "#ffcc00",
          defaultW: 0.28,
          maxZoomW: 0.3,
          mobileH: "h-[340px]",
          body: <FinForecastPanel />,
        },
        {
          id: "ind",
          title: "行业盈利榜",
          icon: <Building2 size={14} />,
          accent: "#ffcc00",
          defaultW: 0.25,
          maxZoomW: 0.3,
          mobileH: "h-[360px]",
          right: (
            <div className="flex items-center gap-2 text-[10px]">
              <PeriodTabs />
              <span className="h-3 w-px bg-slate-700" />
              <IndustryModeTabs />
            </div>
          ),
          body: <FinIndustryPanel />,
        },
        {
          id: "rk",
          title: "个股盈利榜",
          icon: <BarChart3 size={14} />,
          accent: "#ff4d4f",
          defaultW: 0.25,
          maxZoomW: 0.3,
          mobileH: "h-[400px]",
          right: (
            <div className="flex items-center gap-2 text-[10px]">
              <PeriodTabs />
              <span className="h-3 w-px bg-slate-700" />
              <StockRankTabs />
            </div>
          ),
          body: <FinStockRankPanel />,
        },
      ],
    },
    {
      defaultH: 0.60,
      panels: [
        {
          id: "co",
          title: "公司财报",
          icon: <FileText size={14} />,
          accent: "#ffcc00",
          defaultW: 0.28,
          mobileH: "h-[380px]",
          right: <span className="max-w-[110px] truncate text-[10px] text-primary">{company.name}</span>,
          body: (
            <Suspense fallback={<CellWait />}>
              <FinCompanyPanel />
            </Suspense>
          ),
        },
        {
          id: "tr",
          title: "公司趋势",
          icon: <TrendingUp size={14} />,
          accent: "#ffcc00",
          defaultW: 0.40,
          mobileH: "h-[360px]",
          right: <TrendTabs />,
          body: (
            <Suspense fallback={<CellWait />}>
              <FinTrendPanel />
            </Suspense>
          ),
        },
        {
          id: "pr",
          title: "同业对比",
          icon: <GitCompare size={14} />,
          accent: "#ffcc00",
          defaultW: 0.32,
          mobileH: "h-[360px]",
          right: <PeerModeTabs />,
          body: (
            <Suspense fallback={<CellWait />}>
              <FinPeerPanel />
            </Suspense>
          ),
        },
      ],
    },
  ];

  return (
    <div className="flex flex-col bg-background lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden">
      <CockpitLayout rows={rows} />
    </div>
  );
}

export function FinWindow() {
  return (
    <FinProvider>
      <FinBody />
    </FinProvider>
  );
}
