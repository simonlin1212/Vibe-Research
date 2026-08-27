import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Ship } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { FreshTag } from "@/components/deriv/derivShared";
import { usePolling } from "@/hooks/usePolling";
import { api, type CtfiQuote } from "@/lib/api";
import { pctColor } from "@/components/review/format";
import { cn } from "@/lib/utils";

const CTFI_URL = "https://www.sse.net.cn/index/singleIndex?indexType=ctfi";

const ROUTES: { key: string; name: string }[] = [
  { key: "CT1", name: "中东湾拉斯坦努拉 — 宁波" },
  { key: "CT2", name: "西非马隆格/杰诺 — 宁波" },
];

function packMacroContext(q: CtfiQuote | null): string {
  const lines = ["# 宏观页快照", "", "## CTFI 进口原油运价"];
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

function CtfiChart({ tick }: { tick: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
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
  }, [tick]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt="CTFI 走势"
      width={880}
      height={278}
      className="block h-auto w-full bg-white object-contain"
      style={{ aspectRatio: "880 / 278" }}
    />
  );
}

function CtfiPanel({ q, err, tick }: { q: CtfiQuote | null; err: string | null; tick: number }) {
  if (err && !q) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-500">{err}</p>;
  }
  if (!q) {
    return <p className="px-3 py-8 text-center text-[12px] text-slate-600">加载中…</p>;
  }
  const pct = q.pct ?? 0;
  const chg = q.chg;
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-auto p-4">
      <div className="w-full shrink-0 overflow-hidden rounded border border-slate-700/50 bg-white">
        <CtfiChart tick={tick} />
      </div>
      <div className="min-w-0">
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
  const poll = usePolling(() => api.ctfi(), 300_000, [tick]);

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  const rows: CockpitRow[] = useMemo(() => [
    {
      defaultH: 1,
      panels: [
        {
          id: "ctfi",
          title: "进口原油运价 CTFI",
          hint: "上海航运交易所 · 日更",
          icon: <Ship size={14} />,
          accent: "#38bdf8",
          defaultW: 1,
          mobileH: "h-[70vh]",
          right: <FreshTag updated={poll.updated} />,
          bodyClassName: "overflow-hidden",
          body: <CtfiPanel q={poll.data} err={poll.error} tick={tick} />,
        },
      ],
    },
  ], [poll.data, poll.error, poll.updated, tick]);

  const headerActions = (
    <>
      {poll.error ? <span className="text-[10px] text-destructive">{poll.error}</span> : null}
      <button
        type="button"
        onClick={() => setTick((n) => n + 1)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded border border-slate-700/60 px-2 text-[11px] text-slate-400 transition-colors hover:border-primary/50 hover:text-primary",
        )}
        title="重拉 CTFI"
      >
        <RefreshCw className="h-3 w-3" />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packMacroContext(poll.data)}
        label="问 AI"
        scopeKey="macro"
        suggestions={[
          "今天 CTFI 综合和中东/西非航线怎么读?",
          "运价涨跌对进口原油成本意味着什么?",
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
