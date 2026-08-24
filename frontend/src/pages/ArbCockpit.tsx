import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, CandlestickChart, GitCompare, RefreshCw, Table2 } from "lucide-react";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { CockpitLayout, type CockpitRow } from "@/components/cockpit/CockpitLayout";
import { useArbData } from "@/hooks/useArbData";
import { CalendarPanel } from "@/components/arb/CalendarPanel";
import { CrossPanel } from "@/components/arb/CrossPanel";
import { BasisPanel } from "@/components/arb/BasisPanel";
import { SpreadChart } from "@/components/arb/SpreadChart";
import { LegCard } from "@/components/arb/LegCard";
import { signed, type ArbPick } from "@/components/arb/arbShared";
import { FreshTag, SessionBadge } from "@/components/deriv/derivShared";
import { peekQuotes } from "@/lib/quoteHub";
import { INDEX_CASH_CODES } from "@/config/arb";
import { formatClock } from "@/lib/freshness";
import { cn } from "@/lib/utils";

function packArbContext(d: ReturnType<typeof useArbData>, pick: ArbPick | null): string {
  const lines = ["# 套利驾驶舱快照", `行情时间: ${formatClock(d.updated) || "未取到"}`];
  if (!d.board) {
    lines.push("看板: 未取到");
    return lines.join("\n");
  }
  lines.push("", "## 跨期 (近月 - 次月, 按 |较昨| 前 12)");
  const cal = [...d.calendar].sort((a, b) => Math.abs(b.spreadChg ?? 0) - Math.abs(a.spreadChg ?? 0));
  if (cal.length === 0) lines.push("未取到");
  else {
    for (const r of cal.slice(0, 12)) {
      lines.push(`- ${r.label} ${r.near.code}/${r.next.code}: 价差 ${signed(r.spread)} 较昨 ${signed(r.spreadChg)}`);
    }
  }
  lines.push("", "## 跨品种 (近月 - 近月)");
  if (d.cross.length === 0) lines.push("未取到");
  else {
    for (const r of d.cross) {
      lines.push(`- ${r.label}(${r.sector}) ${r.a.code}-${r.b.code}: 价差 ${signed(r.spread)} 较昨 ${signed(r.spreadChg)}`);
    }
  }
  lines.push("", "## 股指期现");
  const quotes = peekQuotes(INDEX_CASH_CODES);
  if (d.index.length === 0) lines.push("未取到");
  else {
    for (const r of d.index) {
      const q = quotes[r.cashCode];
      const cash = q?.price != null ? q.price * r.cashMult : null;
      const basis = cash != null ? r.near.px - cash : null;
      lines.push(`- ${r.label}: 期货 ${r.near.px} 现货 ${cash ?? "未取到"} 基差 ${signed(basis)}`);
    }
  }
  if (pick) lines.push("", `当前查看: ${pick.label} (${pick.left} - ${pick.kind === "idx" ? pick.cashCode : pick.right})`);
  return lines.join("\n");
}

export function ArbCockpit() {
  const d = useArbData();
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [pick, setPick] = useState<ArbPick | null>(null);
  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("cockpit-header-actions"));
  }, []);

  useEffect(() => {
    if (pick) return;
    const row = d.index.find((r) => r.id === "IF-sh000300") ?? d.index[0];
    if (!row) return;
    setPick({
      kind: "idx",
      key: `idx:${row.id}`,
      label: row.label,
      left: row.near.code,
      right: row.cashCode,
      leftUnd: row.und,
      cashCode: row.cashCode,
      cashMult: row.cashMult,
    });
  }, [d.index, pick]);

  const legs = useMemo(() => {
    if (!pick) return {};
    if (pick.kind === "cal") {
      const r = d.calendar.find((x) => `cal:${x.und}` === pick.key);
      return { near: r?.near, next: r?.next };
    }
    if (pick.kind === "cross") {
      const r = d.cross.find((x) => `cross:${x.id}` === pick.key);
      return { a: r?.a, b: r?.b };
    }
    const r = d.index.find((x) => `idx:${x.id}` === pick.key);
    return { near: r?.near };
  }, [pick, d.calendar, d.cross, d.index]);

  const mqttHint = d.mqtt
    ? (d.mqtt.enabled ? (d.mqtt.connected ? "MQTT 已连接" : "MQTT 未连") : "MQTT 关")
    : undefined;

  const rows: CockpitRow[] = [
    {
      defaultH: 0.36,
      panels: [
        {
          id: "arb-cal",
          title: "跨期价差",
          hint: "近月 - 次月",
          icon: <ArrowLeftRight size={14} />,
          accent: "#ffcc00",
          defaultW: 0.38,
          mobileH: "h-[56vh]",
          right: <FreshTag updated={d.updated} extra={mqttHint} />,
          body: (
            <div className="h-full min-h-0 overflow-y-auto">
              <CalendarPanel rows={d.calendar} error={d.error} pick={pick} onPick={setPick} />
            </div>
          ),
        },
        {
          id: "arb-cross",
          title: "跨品种价差",
          hint: "近月对近月 1:1",
          icon: <GitCompare size={14} />,
          accent: "#00d26a",
          defaultW: 0.30,
          mobileH: "h-[48vh]",
          right: <FreshTag updated={d.updated} />,
          body: (
            <div className="h-full min-h-0 overflow-y-auto">
              <CrossPanel rows={d.cross} error={d.error} pick={pick} onPick={setPick} />
            </div>
          ),
        },
        {
          id: "arb-basis",
          title: "期现基差",
          hint: "股指走报价中心 · 现期走生意社",
          icon: <Table2 size={14} />,
          accent: "#ffcc00",
          defaultW: 0.32,
          mobileH: "h-[52vh]",
          right: <FreshTag updated={d.updated} />,
          body: <BasisPanel rows={d.index} error={d.error} pick={pick} onPick={setPick} />,
        },
      ],
    },
    {
      defaultH: 0.64,
      panels: [
        {
          id: "arb-chart",
          title: pick?.kind === "idx" ? "日度升贴水" : "价差图",
          hint: pick?.kind === "idx" ? "期货−现货 · 零轴=平水" : "两腿相减 · 零轴=平水",
          icon: <CandlestickChart size={14} />,
          accent: "#ffcc00",
          defaultW: 0.78,
          maxZoomW: 0.92,
          mobileH: "h-[48vh]",
          bodyClassName: "overflow-hidden",
          body: <SpreadChart pick={pick} />,
        },
        {
          id: "arb-legs",
          title: "两腿 / 仓单",
          hint: pick ? pick.label : "点上排一对",
          icon: <Table2 size={14} />,
          accent: "#ff4d4f",
          defaultW: 0.22,
          mobileH: "h-[40vh]",
          body: <LegCard pick={pick} near={legs.near} next={legs.next} a={legs.a} b={legs.b} />,
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
        title="重拉 arb-board"
      >
        <RefreshCw className={cn("h-3 w-3", d.refreshing && "animate-spin")} />
        刷新
      </button>
      <AskAiButton
        context=""
        getContext={() => packArbContext(d, pick)}
        label="问 AI"
        scopeKey="arb"
        suggestions={[
          "今天跨期价差较昨变动最大的是哪些品种?",
          "股指日度升贴水最近怎么走?",
          "黑色系跨品种价差较昨怎么变?",
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
