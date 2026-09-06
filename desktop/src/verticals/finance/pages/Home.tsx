import { type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  FileText,
  FlaskConical,
  LayoutGrid,
  Microscope,
  NotebookPen,
  Radar,
  Settings,
  Sparkles,
  Star,
  Swords,
  Thermometer,
  Wallet,
} from "lucide-react";

import { FinanceHomeAgent } from "@/components/ui/FinanceAiDock";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { useAiPage } from "../../../core/ai/pageContext";
import { HomeOverview } from "../components/HomeOverview";

type Feature = {
  to: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
};

const GROUPS: { title: string; features: Feature[] }[] = [
  {
    title: "看市场",
    features: [
      { to: "/daily-review", title: "每日复盘", icon: Activity },
      { to: "/intel", title: "资讯雷达", icon: Radar },
      { to: "/signals", title: "产业信号", icon: Thermometer },
      { to: "/sectors", title: "板块中心", icon: LayoutGrid },
    ],
  },
  {
    title: "做研究",
    features: [
      { to: "/research", title: "个股研究", icon: Microscope },
      { to: "/debate", title: "多空辩论", icon: Swords },
      { to: "/backtest", title: "回测", icon: FlaskConical },
    ],
  },
  {
    title: "研究资产",
    features: [
      { to: "/watchlist", title: "自选股", icon: Star },
      { to: "/portfolio", title: "我的持仓", icon: Wallet },
      { to: "/my-reports", title: "我的研报", icon: FileText },
      { to: "/notes", title: "研究记录", icon: NotebookPen },
    ],
  },
];

export function Home() {
  const runtime = useAiRuntime();
  const modelReady = runtime.status === "ok";
  const agentEnabled = runtime.config?.executionMode !== "direct";

  useAiPage({
    key: "home",
    title: "首页",
    context: "这是 Vibe Research 首页，可以直接与本地 Agent 交流，或进入各项研究功能。",
    suggestions: ["今天先看什么", "帮我开始一份研究", "这套 Agent 能做什么"],
  });

  return (
    <div>
      <section className="mb-7 py-2">
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wide text-primary">
              <Sparkles className="h-3.5 w-3.5" /> {agentEnabled ? "Vibe Research Agent 已开启" : "模型直连模式"}
            </div>
            <h1 className="workspace-title mt-3">研究，从全局开始。</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              {agentEnabled ? "看市场、做研究、留证据。Agent 驱动完整流程，AI 来源自由接入。" : "当前直接连接所选模型；确定性数据功能照常可用，深度任务需要重新开启 Agent。"}
            </p>
          </div>
          <Link
            to="/settings"
            className="inline-flex shrink-0 items-center gap-2 self-start rounded border border-border bg-card px-4 py-2.5 text-xs font-medium text-primary transition-colors hover:border-primary/50 sm:self-center"
          >
            <Settings className="h-4 w-4" />
            {modelReady ? "AI 已接入" : "接入 AI"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <HomeOverview />

      <div className="mt-5">
        <FinanceHomeAgent />
      </div>

      <section className="mt-7" aria-labelledby="feature-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Workbench</p>
            <h2 id="feature-heading" className="mt-1 text-lg font-bold">功能入口</h2>
          </div>
          <span className="text-xs text-muted-foreground">点击即达</span>
        </div>

        <div className="glass divide-y divide-border px-4 sm:px-5">
          {GROUPS.map((group) => (
            <div key={group.title} className="grid gap-2 py-3 sm:grid-cols-[6.5rem_1fr] sm:items-center">
              <h3 className="text-xs font-semibold text-muted-foreground">{group.title}</h3>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {group.features.map(({ to, title, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    title={title}
                    className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors hover:bg-primary/[0.08] hover:text-primary"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                    <span className="truncate">{title}</span>
                    <ArrowRight className="ml-auto hidden h-3.5 w-3.5 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 sm:block" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Disclaimer />
    </div>
  );
}
