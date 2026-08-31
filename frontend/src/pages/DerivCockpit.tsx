import { lazy, Suspense, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  AlertCircle, CalendarDays, CandlestickChart, LineChart,
  Loader2, RefreshCw, Sparkles, Table, TrendingUp, X, Zap,
} from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { Md } from "@/components/ui/Md";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { useDerivData, type DerivData } from "@/hooks/useDerivData";
import { daysToExpiry, num } from "@/components/ovlab/shared";
import { formatClock } from "@/lib/freshness";
import { api, ApiError, type EtfShares, type OvlabParked } from "@/lib/api";
import { chatStream, hasLlm } from "@/lib/llm";
import { cn } from "@/lib/utils";
import { IndexFutPanel } from "@/components/deriv/IndexFutPanel";
import { AlertPanel, ruleLabelOf } from "@/components/deriv/AlertPanel";
import { ExpiryCalPanel } from "@/components/deriv/ExpiryCalPanel";
import type { OptionPick } from "@/components/deriv/TQuotePanel";
import { CellEmpty, FreshTag, NightOnlySwitch, SessionBadge, contractCode, findRowByUnd, nightTradingOf, undSpotLast } from "@/components/deriv/derivShared";

const TermStructPanel = lazy(() =>
  import("@/components/deriv/TermStructPanel").then((m) => ({ default: m.TermStructPanel })),
);
const WatchPanel = lazy(() =>
  import("@/components/deriv/WatchPanel").then((m) => ({ default: m.WatchPanel })),
);
const ThsCmdIndexPanel = lazy(() =>
  import("@/components/deriv/ThsCmdIndexPanel").then((m) => ({ default: m.ThsCmdIndexPanel })),
);
const TQuotePanel = lazy(() =>
  import("@/components/deriv/TQuotePanel").then((m) => ({ default: m.TQuotePanel })),
);
const OptionChartCard = lazy(() =>
  import("@/components/deriv/OptionChartCard").then((m) => ({ default: m.OptionChartCard })),
);

function cellPending() {
  return <CellEmpty text="更新中…" />;
}

/** Pack the visible cells in-browser for Ask AI; missing cells say 未取到. */
function packCapitalLines(cap: OvlabParked | null): string {
  if (!cap?.rows?.length) return "\n\n期货沉淀: 未取到";
  const lines = ["", "## 期货沉淀 (持仓x价格x乘数x九期网保证金, 前8)"];
  for (const r of cap.rows.slice(0, 8)) {
    lines.push(`- ${r.und}: ${r.parked}`);
  }
  return `\n${lines.join("\n")}`;
}

function packEtfParked(d: DerivData, items: EtfShares[] | undefined): string {
  const yi = new Map((items ?? []).map((it) => [it.code, it.latest?.shares_yi]));
  const lines = ["", "## ETF沉淀 (份额x行情观察现价)"];
  let n = 0;
  for (const { def, row } of d.catalogRows) {
    if (def.group !== "etf") continue;
    n += 1;
    const s = yi.get(def.und);
    const px = num(row.price);
    if (s == null || px == null) {
      lines.push(`- ${def.label}(${def.und}): 未取到`);
      continue;
    }
    lines.push(`- ${def.label}(${def.und}): 份额 ${s}亿份 x 价 ${px.toFixed(3)} = ${(s * px).toFixed(2)}亿`);
  }
  return n ? `\n${lines.join("\n")}` : "\n\nETF沉淀(份额x现价): 未取到";
}

async function packDerivContextFull(d: DerivData): Promise<string> {
  const base = packDerivContext(d);
  let extra = "";
  try {
    extra += packCapitalLines(await api.ovlabParked());
  } catch {
    extra += packCapitalLines(null);
  }
  try {
    extra += packEtfParked(d, (await api.etfSharesBatch()).items);
  } catch {
    extra += packEtfParked(d, undefined);
  }
  return base + extra;
}

function packDerivContext(d: DerivData): string {
  const lines: string[] = ["# 期权/期货驾驶舱快照", `行情时间: ${formatClock(d.marketUpdated) || "未取到"}`];
  if (!d.rows) {
    lines.push("市场概览: 未取到");
  } else {
    lines.push("", "## 目录品种行情 (国内, 标的涨跌幅/平值隐波/隐波百分位)");
    for (const { def, row } of d.catalogRows) {
      const ctn = num(row.ctn);
      const iv = num(row.atmv_current);
      const ivp = num(row.atmv_percentile);
      lines.push(
        `- ${def.label}(${def.product}): 价 ${num(row.price)?.toFixed(2) ?? "-"}, 涨跌 ${ctn !== null ? (ctn * 100).toFixed(2) + "%" : "-"}, 隐波 ${iv?.toFixed(2) ?? "-"}, IV分位 ${ivp?.toFixed(0) ?? "-"}`,
      );
    }
  }
  if (!d.exps) {
    lines.push("", "临期期权日历: 未取到");
  } else {
    const today = new Date();
    const t = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const byDate = new Map<string, string[]>();
    for (const p of d.exps) {
      for (const e of p.exps ?? []) {
        const ds = String(e.expDate ?? "");
        if (!ds || ds < t) continue;
        if (ds.slice(0, 6) !== t.slice(0, 6)) continue;
        const name = String(p.product_alias ?? p.product_und ?? "");
        if (!byDate.has(ds)) byDate.set(ds, []);
        if (name) byDate.get(ds)!.push(name);
      }
    }
    const upcoming = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    lines.push("", "## 临期期权 (本月未过期)");
    if (upcoming.length === 0) {
      lines.push("本月无剩余到期");
    } else {
      for (const [ds, names] of upcoming) {
        lines.push(`- ${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}: ${names.slice(0, 12).join("、")}${names.length > 12 ? "…" : ""}`);
      }
    }
  }
  if (!d.alerts) {
    lines.push("", "异动: 未取到");
  } else {
    lines.push("", `## 最新异动 (前 ${Math.min(15, d.alerts.length)} 条)`);
    for (const a of d.alerts.slice(0, 15)) {
      const kind = ruleLabelOf(a);
      const dte = daysToExpiry(a.exp_date);
      lines.push(`- ${String(a.time ?? "").slice(5, 16)} ${a.contract_code ?? "-"} ${kind} 剩余${dte ?? "-"}天 区间${a.pct_change ?? "-"}`);
    }
  }
  return lines.join("\n");
}

export function DerivCockpit() {
  const [optPick, setOptPick] = useState<OptionPick | null>(null);
  const d = useDerivData(optPick ? [optPick.code, optPick.und] : []);
  const chartTick = useMemo(() => {
    if (!optPick) return undefined;
    const t = d.ticks[optPick.code.toUpperCase()];
    if (optPick.kind !== "und") return t;
    const last = undSpotLast(optPick.code, d.ticks, d.rows);
    if (last == null) return t;
    return { instr: optPick.code, last, oi: t?.oi };
  }, [optPick, d.ticks, d.rows]);
  const chartHasNight = useMemo(
    () => (optPick ? nightTradingOf(d.rows, optPick.und) : undefined),
    [optPick, d.rows],
  );
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [nightOnly, setNightOnly] = useState(false);
  const [boardTab, setBoardTab] = useState<"spot" | "watch" | "index">("spot");
  // T 型报价联动: 点行情观察出标的图; 点 T 表出期权图
  const [tqProd, setTqProd] = useState("");
  const pickProduct = (p: string, undChart?: { code: string; name: string }) => {
    const prod = p.trim();
    if (prod) setTqProd(prod);
    const row = findRowByUnd(d.rows, prod);
    const code = (undChart?.code || (row ? contractCode(row) : "")).trim();
    if (code) {
      setOptPick({ kind: "und", code, und: code, name: undChart?.name ?? `${prod} ${code}` });
      return;
    }
    if (prod) setOptPick(null);
  };
  const [review, setReview] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
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
      const snap = await packDerivContextFull(d);
      const prompt = [
        `以下是期权/期货驾驶舱的客观快照(与当前看板同源):\n${snap}`,
        "请写一段简洁的衍生品盘面复盘(中文, 300字内): 先总述股指/商品情绪与涨跌分布, 再点出隐波百分位极端(>=90 或 <=10)的品种, 最后列值得关注的异动合约。只陈述快照事实, 不做投资建议。",
      ].join("\n\n");
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

  const rows: CockpitRow[] = [
    {
      defaultH: 0.29,
      panels: [
        {
          id: "main-board",
          title: "行情观察",
          icon: <LineChart size={14} />,
          accent: "#ffcc00",
          defaultW: 0.36,
          mobileH: "h-[64vh]",
          right: (
            <span className="flex items-center gap-2">
              {boardTab === "spot" ? <NightOnlySwitch on={nightOnly} onChange={setNightOnly} /> : null}
              {boardTab === "index" ? null : <FreshTag updated={d.marketUpdated} />}
            </span>
          ),
          body: (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 gap-0.5 border-b border-slate-800/60 px-2 py-1">
                {([
                  ["spot", "股指·商品"],
                  ["watch", "自选"],
                  ["index", "指数"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setBoardTab(id)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px]",
                      boardTab === id ? "bg-slate-800 text-slate-200" : "text-slate-500 hover:text-slate-300",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {boardTab === "watch" ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={cellPending()}>
                    <WatchPanel
                      d={d}
                      onPick={(code, prodUnd) => {
                        if (prodUnd) pickProduct(prodUnd, { code, name: code });
                        else setOptPick({ kind: "und", code, und: code, name: code });
                      }}
                    />
                  </Suspense>
                </div>
              ) : boardTab === "index" ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={cellPending()}>
                    <ThsCmdIndexPanel />
                  </Suspense>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <IndexFutPanel d={d} nightOnly={nightOnly} onPickProduct={pickProduct} />
                </div>
              )}
            </div>
          ),
        },
        {
          id: "expiry-cal",
          title: "临期期权日历",
          icon: <CalendarDays size={14} />,
          accent: "#ffcc00",
          defaultW: 0.20,
          mobileH: "h-[56vh]",
          right: d.exps ? <span className="font-mono text-[10px] text-slate-500">{d.exps.length}品种</span> : undefined,
          body: <ExpiryCalPanel d={d} />,
        },
        {
          id: "term-struct",
          title: "期限结构",
          hint: "远期曲线 · 仓单",
          icon: <TrendingUp size={14} />,
          accent: "#00d26a",
          defaultW: 0.22,
          mobileH: "h-[44vh]",
          right: <FreshTag updated={d.marketUpdated} />,
          body: (
            <Suspense fallback={cellPending()}>
              <TermStructPanel d={d} />
            </Suspense>
          ),
        },
        {
          id: "alert",
          title: "异动",
          icon: <Zap size={14} />,
          accent: "#ffcc00",
          defaultW: 0.22,
          mobileH: "h-[50vh]",
          right: <FreshTag updated={d.alertUpdated} />,
          body: <AlertPanel d={d} />,
        },
      ],
    },
    {
      defaultH: 0.71,
      panels: [
        {
          id: "tquote",
          title: "T 型报价",
          hint: "理论价=Black-76",
          icon: <Table size={14} />,
          accent: "#ffcc00",
          defaultW: 0.68,
          maxZoomW: 0.88,
          mobileH: "h-[56vh]",
          body: (
            <Suspense fallback={cellPending()}>
              <TQuotePanel
                d={d}
                product={tqProd}
                onProduct={pickProduct}
                pick={optPick}
                onPickContract={setOptPick}
              />
            </Suspense>
          ),
        },
        {
          id: "opt-charts",
          title: "分时 / 日K",
          hint: optPick ? optPick.name : "点行情观察或 T 表",
          icon: <CandlestickChart size={14} />,
          accent: "#ff4d4f",
          defaultW: 0.32,
          mobileH: "h-[40vh]",
          bodyClassName: "!overflow-hidden p-0",
          body: (
            <Suspense fallback={cellPending()}>
              <div className="grid h-full min-h-0 min-w-0 grid-rows-2 gap-px bg-[#2a2a2a]">
                <OptionChartCard
                  pick={optPick}
                  mode="minute"
                  tick={chartTick}
                  alerts={d.alerts ?? undefined}
                  hasNight={chartHasNight}
                />
                <OptionChartCard
                  pick={optPick}
                  mode="daily"
                  tick={chartTick}
                  alerts={d.alerts ?? undefined}
                />
              </div>
            </Suspense>
          ),
        },
      ],
    },
  ];

  const headerActions = (
    <>
      <SessionBadge />
      <button
        type="button"
        onClick={d.refresh}
        disabled={d.refreshing}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-50",
        )}
        title="重拉 market / 异动"
      >
        <RefreshCw className={cn("h-3 w-3", d.refreshing && "animate-spin")} />
        刷新
      </button>
      <button
        type="button"
        onClick={() => { setAiOpen(true); void runReview(); }}
        disabled={reviewLoading}
        className="inline-flex h-6 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
      >
        {reviewLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        AI 复盘
      </button>
      <AskAiButton
        context=""
        getContext={() => packDerivContextFull(d)}
        label="问 AI"
        scopeKey="deriv"
        suggestions={[
          "今天哪些品种隐波百分位极端?",
          "本月还有哪些合约到期?",
          "最新异动集中在哪些合约?",
          "哪些品种沉淀资金最大?",
        ]}
      />
    </>
  );

  return (
    <div className="relative flex flex-col bg-background lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden">
      {headerSlot ? createPortal(headerActions, headerSlot) : null}
      <CockpitLayout rows={rows} />

      {showReviewPanel && (
        <div className="absolute inset-x-2 top-8 z-30 max-h-[70%] overflow-auto border border-primary/40 bg-black p-3 sm:inset-x-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
              <Sparkles className="h-4 w-4 text-primary" /> AI 衍生品复盘
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
                className="rounded border border-slate-700/60 p-1 text-slate-400 hover:text-primary"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            已带入当前看板各格快照 (股指衍生 / 商品主力 / 临期期权 / 异动等)
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
              <Md>{review}</Md>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
