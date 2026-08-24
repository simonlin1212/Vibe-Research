import { useMemo, useState } from "react";
import { KlineLink } from "@/components/cockpit/QuoteLine";
import { PctChip } from "@/components/review/PctChip";
import { fmtAmt } from "@/components/review/format";
import type {
  DxxBoard, DxxCurve, DxxDabanRow, DxxFengDay, DxxFupan, DxxStrong, DxxWajueRow, DxxZtRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-[11px] text-slate-500">{text}</p>;
}

function Spark({ data, className }: { data: number[]; className?: string }) {
  const pts = useMemo(() => {
    if (data.length < 2) return "";
    const lo = Math.min(...data);
    const hi = Math.max(...data);
    const span = hi - lo || 1;
    return data.map((v, i) => {
      const x = (i / (data.length - 1)) * 100;
      const y = 16 - ((v - lo) / span) * 14 - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [data]);
  if (!pts) return null;
  const up = data[data.length - 1] >= data[0];
  return (
    <svg viewBox="0 0 100 16" className={cn("h-4 w-full", className)} preserveAspectRatio="none">
      <polyline fill="none" stroke={up ? "#ff4d4f" : "#00d26a"} strokeWidth="1.2" points={pts} />
    </svg>
  );
}

export function FengdanPanel({ days }: { days: DxxFengDay[] }) {
  const [idx, setIdx] = useState(0);
  const day = days[Math.min(idx, Math.max(days.length - 1, 0))];
  if (!day) return <Empty text="暂无封单. 交易日 09:15 起更新." />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[#2a2a2a] px-2 py-1 text-[10px] text-slate-400">
        {days.slice(0, 5).map((d, i) => (
          <button
            key={d.date}
            type="button"
            onClick={() => setIdx(i)}
            className={cn("rounded px-1.5 py-0.5", i === idx ? "bg-primary/15 text-primary" : "hover:text-slate-200")}
          >
            {d.date.slice(5)}
          </button>
        ))}
        <span className="ml-auto tabular-nums">
          一字 {day.yizhi ?? "—"} · 封单 {day.seal || "—"}
        </span>
      </div>
      <div className="grid shrink-0 grid-cols-3 border-b border-[#2a2a2a] px-2 py-1 text-[10px] text-slate-500">
        <span>9:15 {day.t15}</span>
        <span className="text-center">9:20 {day.t20}</span>
        <span className="text-right">9:25 {day.t25}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-[#111] text-[10px] text-slate-500">
            <tr>
              <th className="px-1.5 py-1 text-left font-medium">名称</th>
              <th className="px-1 py-1 text-left font-medium">标签</th>
              <th className="px-1 py-1 text-right font-medium">9:15</th>
              <th className="px-1 py-1 text-right font-medium">9:20</th>
              <th className="px-1.5 py-1 text-right font-medium">9:25</th>
            </tr>
          </thead>
          <tbody>
            {day.rows.map((r) => (
              <tr key={r.code} className="border-t border-[#2a2a2a]">
                <td className="px-1.5 py-0.5">
                  <KlineLink code={r.code} className="text-slate-200 hover:text-primary" title={r.code}>
                    {r.name}
                  </KlineLink>
                </td>
                <td className="max-w-[7rem] truncate px-1 py-0.5 text-slate-400">{r.tags.join(" ")}</td>
                <td className="px-1 py-0.5 text-right tabular-nums text-slate-300">{r.a15 || "—"}</td>
                <td className="px-1 py-0.5 text-right tabular-nums text-slate-300">{r.a20 || "—"}</td>
                <td className="px-1.5 py-0.5 text-right tabular-nums text-slate-200">{r.a25 || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DabanPanel({ rows }: { rows: DxxDabanRow[] }) {
  if (!rows.length) return <Empty text="暂无打板. 交易日 09:15 起更新." />;
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[#111] text-[10px] text-slate-500">
          <tr>
            <th className="px-1.5 py-1 text-left font-medium">名称</th>
            <th className="px-1 py-1 text-right font-medium">涨幅</th>
            <th className="px-1 py-1 text-right font-medium">额</th>
            <th className="px-1 py-1 text-left font-medium">板</th>
            <th className="px-1.5 py-1 text-left font-medium">概念</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-[#2a2a2a]">
              <td className="px-1.5 py-0.5">
                <KlineLink code={r.code} className="text-slate-200 hover:text-primary" title={r.code}>
                  {r.name}
                </KlineLink>
              </td>
              <td className="px-1 py-0.5 text-right"><PctChip pct={r.pct} /></td>
              <td className="px-1 py-0.5 text-right tabular-nums text-slate-300">{fmtAmt(r.amount)}</td>
              <td className="px-1 py-0.5 text-amber-400">{r.board || "—"}</td>
              <td className="max-w-[8rem] truncate px-1.5 py-0.5 text-slate-400">{r.concepts || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ZtlivePanel({ rows }: { rows: DxxZtRow[] }) {
  if (!rows.length) return <Empty text="暂无涨停直播" />;
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[#111] text-[10px] text-slate-500">
          <tr>
            <th className="px-1.5 py-1 text-left font-medium">名称</th>
            <th className="px-1 py-1 text-left font-medium">原因</th>
            <th className="px-1 py-1 text-left font-medium">板</th>
            <th className="px-1.5 py-1 text-right font-medium">首封</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-[#2a2a2a]">
              <td className="px-1.5 py-0.5">
                <KlineLink code={r.code} className="text-slate-200 hover:text-primary" title={r.code}>
                  {r.name}
                </KlineLink>
              </td>
              <td className="px-1 py-0.5 text-slate-300">{r.reason || "—"}</td>
              <td className="px-1 py-0.5 text-amber-400">{r.board || "—"}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-slate-400">{r.time || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LIVE_KEYS = ["QX", "ZT", "DT", "LBGD", "KQXY", "SZ", "XD", "PB"] as const;

export function QingxuPanel({ live, hist }: { live: DxxCurve | null; hist: DxxCurve | null }) {
  const last = live?.last ?? hist?.last ?? {};
  const labels = live?.labels ?? hist?.labels ?? {};
  const spark = live?.series?.QX ?? hist?.series?.QX ?? [];
  if (!Object.keys(last).length) return <Empty text="暂无情绪曲线" />;
  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-1.5">
      <Spark data={spark} className="mb-1.5 h-8" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 gap-1">
          {LIVE_KEYS.map((k) => {
            const v = last[k];
            if (v == null) return null;
            return (
              <div key={k} className="flex items-baseline justify-between border border-[#2a2a2a] px-1.5 py-1">
                <span className="text-[10px] text-slate-500">{labels[k] || k}</span>
                <span className="font-mono text-[12px] tabular-nums text-slate-200">{Number.isInteger(v) ? v : v.toFixed(1)}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] text-slate-600">上游字段, 不是本站评分</p>
      </div>
    </div>
  );
}

export function StrongPanel({ data }: { data: DxxStrong | null }) {
  const rows = data?.series ?? [];
  if (!rows.length) return <Empty text="暂无板块强度" />;
  return (
    <div className="h-full overflow-y-auto px-2 py-1">
      {rows.map((r) => {
        const last = r.data[r.data.length - 1];
        return (
          <div key={r.name} className="mb-1.5">
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="text-slate-200">{r.name}</span>
              <span className="font-mono tabular-nums text-slate-300">{last?.toFixed?.(1) ?? last}</span>
            </div>
            <Spark data={r.data} />
          </div>
        );
      })}
    </div>
  );
}

export function FupanWajuePanel({
  fupan, wajue,
}: {
  fupan: DxxFupan | null; wajue: DxxWajueRow[];
}) {
  const [tab, setTab] = useState<"fupan" | "wajue">("fupan");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-[#2a2a2a] px-2 py-1">
        {([["fupan", "复盘"], ["wajue", "挖掘"]] as const).map(([id, lab]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn("rounded px-1.5 py-0.5 text-[10px]", tab === id ? "bg-primary/15 text-primary" : "text-slate-400 hover:text-slate-200")}
          >
            {lab}
          </button>
        ))}
      </div>
      {tab === "fupan" ? (
        <div className="grid grid-cols-2 gap-1.5 p-2">
          {([
            ["日期", fupan?.date || "—"],
            ["情绪", fupan?.qx ?? "—"],
            ["涨停", fupan?.zt ?? "—"],
            ["跌停", fupan?.dt ?? "—"],
            ["封板率", fupan?.seal_rate != null ? `${fupan.seal_rate}%` : "—"],
            ["涨停表现", fupan?.zt_ret != null ? `${fupan.zt_ret}%` : "—"],
            ["连板表现", fupan?.lb_ret != null ? `${fupan.lb_ret}%` : "—"],
          ] as [string, string | number][]).map(([k, v]) => (
            <div key={k} className="border border-[#2a2a2a] px-1.5 py-1.5">
              <div className="text-[10px] text-slate-500">{k}</div>
              <div className={cn("font-mono text-[15px] tabular-nums", k.includes("跌") ? "text-[#00d26a]" : "text-slate-100")}>{v}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!wajue.length ? <Empty text="暂无挖掘匹配" /> : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[#111] text-[10px] text-slate-500">
                <tr>
                  <th className="px-1.5 py-1 text-left font-medium">名称</th>
                  <th className="px-1.5 py-1 text-right font-medium">匹配次数</th>
                </tr>
              </thead>
              <tbody>
                {wajue.map((r) => (
                  <tr key={r.code} className="border-t border-[#2a2a2a]">
                    <td className="px-1.5 py-0.5">
                      <KlineLink code={r.code} className="text-slate-200 hover:text-primary" title={r.code}>
                        {r.name}
                      </KlineLink>
                    </td>
                    <td className="px-1.5 py-0.5 text-right tabular-nums text-slate-300">{r.hits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export function packDxxContext(b: DxxBoard | null): string {
  const lines = ["# 短线侠快照", "上游公开页, 只陈述数字, 不荐股."];
  if (!b) return lines.concat("未取到").join("\n");
  const fd = b.fengdan?.days?.[0];
  if (fd) {
    lines.push("", `## 竞价封单 ${fd.date} 一字${fd.yizhi ?? "?"} 封单${fd.seal || "?"}`);
    for (const r of fd.rows.slice(0, 12)) {
      lines.push(`- ${r.name} ${r.code} ${r.tags.join("/")} 9:25 ${r.a25}`);
    }
  }
  const zt = b.ztlive?.rows ?? [];
  if (zt.length) {
    lines.push("", `## 涨停直播 ${b.ztlive?.count ?? zt.length}只`);
    for (const r of zt.slice(0, 16)) lines.push(`- ${r.name} ${r.reason} ${r.board} ${r.time}`);
  }
  const db = b.daban?.rows ?? [];
  if (db.length) {
    lines.push("", "## 打板");
    for (const r of db.slice(0, 12)) {
      lines.push(`- ${r.name} ${r.pct ?? "?"} ${r.board} ${r.concepts}`);
    }
  }
  const qx = b.qxlive?.last ?? b.qingxu?.last;
  if (qx) {
    lines.push("", "## 情绪(上游字段)");
    lines.push(Object.entries(qx).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  if (b.fupan?.date) {
    lines.push("", `## 复盘 ${b.fupan.date} 涨停${b.fupan.zt} 跌停${b.fupan.dt} 封板${b.fupan.seal_rate}`);
  }
  return lines.join("\n");
}
