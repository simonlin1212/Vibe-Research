import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Landmark, Percent, RefreshCw, Ship, Wallet } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { CellEmpty, FreshTag } from "@/components/deriv/derivShared";
import { FxPanel } from "@/components/macro/FxPanel";
import { LprPanel } from "@/components/macro/LprPanel";
import { MoneyPanel } from "@/components/macro/MoneyPanel";
import { MonthPanel } from "@/components/macro/MonthPanel";

const BondPanel = lazy(() =>
  import("@/components/macro/BondPanel").then((m) => ({ default: m.BondPanel })),
);
import { usePolling } from "@/hooks/usePolling";
import { api, type CnBondYield, type CtfiQuote, type LprData, type MacroBoard } from "@/lib/api";
import { pctColor } from "@/components/review/format";
import { cn } from "@/lib/utils";

const CTFI_URL = "https://www.sse.net.cn/index/singleIndex?indexType=ctfi";

const ROUTES: { key: string; name: string }[] = [
  { key: "CT1", name: "中东湾拉斯坦努拉 — 宁波" },
  { key: "CT2", name: "西非马隆格/杰诺 — 宁波" },
];

function packBond(title: string, bond: CnBondYield | null): string[] {
  const lines = ["", `## ${title}`];
  if (bond?.terms && Object.keys(bond.terms).length) {
    const pick = (["1Y", "2Y", "5Y", "10Y", "30Y"] as const)
      .map((k) => (bond.terms[k] != null ? `${k} ${bond.terms[k]}%` : ""))
      .filter(Boolean);
    const spr = [
      bond.spread_10_2 != null ? `10Y-2Y ${bond.spread_10_2}` : "",
      bond.spread_30_10 != null ? `30Y-10Y ${bond.spread_30_10}` : "",
    ].filter(Boolean);
    lines.push(`${bond.date || "—"} ${pick.join(" ")}${spr.length ? ` ${spr.join(" ")}` : ""}`.trim());
  } else {
    lines.push("未取到");
  }
  return lines;
}

function packItems(title: string, items: { name: string; value: number | null; period?: string; date?: string; unit?: string; label?: string }[] | undefined): string[] {
  const lines = ["", `## ${title}`];
  const rows = (items || []).filter((it) => it.value != null);
  if (!rows.length) {
    lines.push("未取到");
    return lines;
  }
  for (const it of rows) {
    const unit = it.unit === "亿" ? "亿" : it.unit === "%" ? "%" : "";
    const when = it.period || it.date || "";
    const extra = it.label ? ` ${it.label}` : "";
    lines.push(`${when} ${it.name} ${it.value}${unit}${extra}`.trim());
  }
  return lines;
}

function packMacroContext(
  q: CtfiQuote | null,
  lpr: LprData | null,
  bond: CnBondYield | null,
  policy: CnBondYield | null,
  board: MacroBoard | null,
): string {
  const lines = ["# 宏观页快照"];
  lines.push("", "## LPR");
  if (lpr?.latest) {
    lines.push(`${lpr.latest.date} 1Y ${lpr.latest.one_year}% 5Y ${lpr.latest.five_year}%`);
  } else {
    lines.push("未取到");
  }
  lines.push(...packBond("中债国债收益率", bond));
  lines.push(...packBond("政策性金融债收益率", policy));
  lines.push(...packItems("银行间利率", board?.money?.items));
  lines.push(...packItems("月度宏观", board?.month?.items));
  lines.push(...packItems("美债与美元指数", board?.us?.items));
  lines.push("", "## 美元/人民币");
  lines.push("实时价走报价中心 whUSDCNY, 见行情格子");
  lines.push("", "## CTFI 进口原油运价");
  if (!q?.price) {
    lines.push("未取到");
    return lines.join("\n");
  }
  const chg = q.chg != null ? `${q.chg > 0 ? "+" : ""}${q.chg}` : "—";
  const pct = q.pct != null ? `${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%` : "—";
  lines.push(`${q.date || "—"} 综合 ${q.price} 点  ${chg}  ${pct}`);
  for (const r of ROUTES) {
    const v = q.routes?.[r.key];
    if (v != null) lines.push(`${r.key} ${r.name} ${v}`);
  }
  lines.push("来源 上海航运交易所 公开页");
  return lines.join("\n");
}

function CtfiChart({ tick, ready }: { tick: number; ready: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let dead = false;
    let url = "";
    api.ctfiImg()
      .then((blob) => {
        if (dead) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!dead) setSrc(null);
      });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tick, ready]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt="CTFI 走势"
      width={880}
      height={278}
      className="block h-auto max-h-[180px] w-auto max-w-[560px] bg-white object-contain"
      style={{ aspectRatio: "880 / 278" }}
    />
  );
}

function CtfiPanel({ q, err, tick, ready }: { q: CtfiQuote | null; err: string | null; tick: number; ready: boolean }) {
  if (err && !q) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!q) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">加载中…</p>;
  }
  const pct = q.pct ?? 0;
  const chg = q.chg;
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-auto p-4 lg:flex-row lg:items-start lg:gap-6">
      <div className="w-fit max-w-full shrink-0 overflow-hidden rounded border border-slate-700/50 bg-white">
        <CtfiChart tick={tick} ready={ready} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-slate-500">{q.date || "—"} · 综合指数 · 点</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <span className={cn("font-mono text-4xl font-bold tabular-nums", pctColor(pct))}>
            {q.price.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className={cn("font-mono text-sm tabular-nums", pctColor(pct))}>
            {chg != null ? `${chg > 0 ? "+" : ""}${chg.toFixed(2)} 点` : ""}
            {q.pct != null ? `  ${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%` : ""}
          </span>
        </div>
        <table className="mt-4 w-full text-left text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="pb-1.5 font-medium">航线</th>
              <th className="pb-1.5 text-right font-medium">点</th>
            </tr>
          </thead>
          <tbody>
            {ROUTES.map((r) => (
              <tr key={r.key} className="border-t border-slate-800/80">
                <td className="py-1.5 text-slate-300">
                  <span className="mr-2 font-mono text-[10px] text-slate-500">{r.key}</span>
                  {r.name}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-slate-200">
                  {q.routes?.[r.key] != null
                    ? q.routes[r.key].toLocaleString("zh-CN", { minimumFractionDigits: 2 })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
          基期 2012-11-28 = 1000 点。数字与图来自
          <a href={q.url || CTFI_URL} target="_blank" rel="noreferrer" className="mx-1 text-slate-400 hover:text-primary">
            上海航运交易所公开页
          </a>
          ，只呈现、不评分。
        </p>
      </div>
    </div>
  );
}

export function MacroCockpit() {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [tick, setTick] = useState(0);
  const lpr = usePolling(() => api.lpr(730), 300_000, [tick]);
  const board = usePolling(() => api.macroBoard(), 300_000, [tick]);
  const firstReady = !!(lpr.data || lpr.error || board.data || board.error);
  const bond = usePolling(() => api.cnBondYield("treasury"), 300_000, [tick], firstReady);
  const policy = usePolling(() => api.cnBondYield("policy"), 300_000, [tick], firstReady);
  const poll = usePolling(() => api.ctfi(), 300_000, [tick], firstReady);

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const rows: CockpitRow[] = useMemo(() => [
    {
      defaultH: 0.24,
      panels: [
        {
          id: "lpr",
          title: "LPR",
          hint: "中国货币网 · 月更",
          icon: <Activity size={14} />,
          accent: "#ffcc00",
          defaultW: 0.22,
          mobileH: "h-[32vh]",
          right: <FreshTag updated={lpr.updated} />,
          bodyClassName: "overflow-hidden",
          body: <LprPanel data={lpr.data} err={lpr.error} />,
        },
        {
          id: "money",
          title: "银行间利率",
          hint: "DR007 / SHIBOR · 日更",
          icon: <Percent size={14} />,
          accent: "#f59e0b",
          defaultW: 0.38,
          mobileH: "h-[36vh]",
          right: <FreshTag updated={board.updated} />,
          bodyClassName: "overflow-hidden",
          body: <MoneyPanel data={board.data} err={board.error} />,
        },
        {
          id: "fx",
          title: "汇率 / 美债",
          hint: "美元人民币 · 美债10Y · 美元指数",
          icon: <Wallet size={14} />,
          accent: "#38bdf8",
          defaultW: 0.4,
          mobileH: "h-[36vh]",
          right: <FreshTag updated={board.updated} />,
          bodyClassName: "overflow-hidden",
          body: <FxPanel data={board.data} err={board.error} />,
        },
      ],
    },
    {
      defaultH: 0.28,
      panels: [
        {
          id: "bond",
          title: "国债收益率",
          hint: "中债登 · 日更",
          icon: <Landmark size={14} />,
          accent: "#00d26a",
          defaultW: 0.5,
          mobileH: "h-[42vh]",
          right: <FreshTag updated={bond.updated} />,
          bodyClassName: "overflow-hidden",
          body: (
            <Suspense fallback={<CellEmpty text="更新中…" />}>
              <BondPanel data={bond.data} err={bond.error} />
            </Suspense>
          ),
        },
        {
          id: "policy-bond",
          title: "政策性金融债",
          hint: "中债登 · 日更",
          icon: <Landmark size={14} />,
          accent: "#a78bfa",
          defaultW: 0.5,
          mobileH: "h-[42vh]",
          right: <FreshTag updated={policy.updated} />,
          bodyClassName: "overflow-hidden",
          body: (
            <Suspense fallback={<CellEmpty text="更新中…" />}>
              <BondPanel data={policy.data} err={policy.error} />
            </Suspense>
          ),
        },
      ],
    },
    {
      defaultH: 0.18,
      panels: [
        {
          id: "month",
          title: "月度宏观",
          hint: "CPI / PPI / PMI / 社融 / M2",
          icon: <Percent size={14} />,
          accent: "#fb7185",
          defaultW: 1,
          mobileH: "h-[36vh]",
          right: <FreshTag updated={board.updated} />,
          bodyClassName: "overflow-hidden",
          body: <MonthPanel data={board.data} err={board.error} />,
        },
      ],
    },
    {
      defaultH: 0.3,
      panels: [
        {
          id: "ctfi",
          title: "进口原油运价 CTFI",
          hint: "上海航运交易所 · 日更",
          icon: <Ship size={14} />,
          accent: "#38bdf8",
          defaultW: 1,
          mobileH: "h-[56vh]",
          right: <FreshTag updated={poll.updated} />,
          bodyClassName: "overflow-hidden",
          body: <CtfiPanel q={poll.data} err={poll.error} tick={tick} ready={firstReady} />,
        },
      ],
    },
  ], [
    poll.data, poll.error, poll.updated,
    lpr.data, lpr.error, lpr.updated,
    bond.data, bond.error, bond.updated,
    policy.data, policy.error, policy.updated,
    board.data, board.error, board.updated,
    firstReady, tick,
  ]);

  const headerActions = (
    <>
      {poll.error ? <span className="text-[10px] text-destructive">{poll.error}</span> : null}
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary",
        )}
        title="重拉宏观格子"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packMacroContext(poll.data, lpr.data, bond.data, policy.data, board.data)}
        label="问 AI"
        scopeKey="macro"
        suggestions={[
          "今天 LPR、DR007、SHIBOR 怎么读?",
          "国债和政策性金融债曲线差在哪?",
          "月度 CPI/PPI/PMI/社融/M2 和美债10Y、美元指数怎么放在一起看?",
          "今天 CTFI 综合和中东/西非航线怎么读?",
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
