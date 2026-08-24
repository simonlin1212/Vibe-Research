import { useMemo, useState } from "react";
import { Star } from "lucide-react";
import { useFin } from "@/components/fin/FinContext";
import { quarterLabel, TNUM } from "@/components/fin/utils";
import { useElementSize } from "@/hooks/useElementSize";
import type { FinCalendarItem } from "@/lib/api";

const DAY = 86_400_000;
const STRIP_H = 40;

const dateKey = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 21-day clickable strip + disclosure list. Same layout as marketingdashboard. */
export function FinCalendarPanel() {
  const [selDate, setSelDate] = useState<string | null>(null);
  const { select, board: data, boardError: error } = useFin();
  const { ref: boxRef, size } = useElementSize(40);
  const w = size.w;

  const view = useMemo(() => {
    const cal = data?.calendar ?? [];
    const counts = new Map<string, number>();
    for (const it of cal) counts.set(it.date, (counts.get(it.date) ?? 0) + 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const PAST = 7;
    const FUTURE = 14;
    const days = Array.from({ length: PAST + FUTURE }, (_, i) => {
      const offset = i - PAST;
      const key = dateKey(today.getTime() + offset * DAY);
      return { key, offset, count: counts.get(key) ?? 0, past: offset < 0 };
    });
    const todayKey = days[PAST].key;
    const peak = Math.max(...days.map((d) => d.count), 0);
    const byDate = new Map<string, FinCalendarItem[]>();
    for (const it of cal) {
      const arr = byDate.get(it.date) ?? [];
      arr.push(it);
      byDate.set(it.date, arr);
    }
    let listDate = todayKey;
    let listLabel = "今晚披露";
    if (!byDate.has(todayKey)) {
      let found = false;
      for (let i = 1; i <= PAST; i++) {
        const pastKey = dateKey(today.getTime() - i * DAY);
        if (byDate.has(pastKey)) {
          listDate = pastKey;
          listLabel = `${pastKey.slice(5).replace("-", "/")} 已披露`;
          found = true;
          break;
        }
      }
      if (!found) {
        const tmr = dateKey(today.getTime() + DAY);
        listDate = byDate.has(tmr) ? tmr : cal[0]?.date ?? todayKey;
        listLabel = listDate === tmr ? "明日披露" : `${listDate.slice(5).replace("-", "/")} 披露`;
      }
    }
    return {
      days,
      todayKey,
      PAST,
      todayCount: counts.get(todayKey) ?? 0,
      peak,
      byDate,
      list: byDate.get(listDate) ?? [],
      listLabel,
      heavy: new Set((data?.stocks ?? []).map((s) => s.code)),
    };
  }, [data]);

  const activeList = selDate ? (view.byDate.get(selDate) ?? []) : view.list;
  const activeListLabel = selDate
    ? (selDate === view.todayKey
      ? "今晚披露"
      : selDate < view.todayKey
        ? `${selDate.slice(5).replace("-", "/")} 已披露`
        : `${selDate.slice(5).replace("-", "/")} 披露`)
    : view.listLabel;

  const W = Math.max(w, 120);
  const padX = 6;
  const totalDays = view.days.length;
  const slot = (W - padX * 2) / totalDays;
  const bw = Math.max(3, slot * 0.55);
  const baseY = STRIP_H - 10;
  const peak = Math.max(view.peak, 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={boxRef} className="shrink-0">
        <svg width={W} height={STRIP_H} className="block">
          {view.days.map((d, i) => {
            const bh = d.count > 0 ? Math.max(2, (d.count / peak) * (baseY - 12)) : 0;
            const x = padX + i * slot + (slot - bw) / 2;
            const isToday = d.key === view.todayKey;
            const isSelected = selDate === d.key;
            return (
              <g key={d.key} style={{ cursor: "pointer" }} onClick={() => setSelDate(selDate === d.key ? null : d.key)}>
                <rect x={padX + i * slot} y={0} width={slot} height={baseY} fill="transparent" />
                {d.count > 0 && (
                  <rect
                    x={x}
                    y={baseY - bh}
                    width={bw}
                    height={bh}
                    rx={1.5}
                    fill={isToday && !selDate ? "#fbbf24" : d.past ? "#64748b" : "#ffcc00"}
                    opacity={isToday && !selDate ? 1 : d.past ? 0.5 : 0.4}
                    stroke={isSelected ? (isToday ? "#fbbf24" : "#e2e8f0") : "none"}
                    strokeWidth={isSelected ? 1 : 0}
                  />
                )}
                {d.count > 0 && (
                  <text x={x + bw / 2} y={baseY - bh - 2} fontSize={8} fill={isToday && !selDate ? "#fbbf24" : "#475569"} textAnchor="middle" style={TNUM}>
                    {d.count}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#1e293b" strokeWidth={1} />
          {[
            { i: 0, t: "-7d", a: "start" as const },
            { i: view.PAST, t: "今天", a: "middle" as const },
            { i: view.PAST + 7, t: "+7d", a: "middle" as const },
            { i: totalDays - 1, t: "+14d", a: "end" as const },
          ].map(({ i, t, a }) => (
            <text
              key={t}
              x={a === "start" ? padX : a === "end" ? W - padX : padX + i * slot + slot / 2}
              y={STRIP_H - 2}
              fontSize={8}
              fill={t === "今天" ? "#fbbf24" : "#475569"}
              textAnchor={a}
            >
              {t}
            </text>
          ))}
        </svg>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-slate-800/60 px-2 pt-1">
        <span className="text-[9px] text-amber-400">{activeListLabel}</span>
        <span className="ml-auto font-mono text-[9px] text-slate-600" style={TNUM}>
          今日 {view.todayCount} · 峰值 {view.peak}
        </span>
        {selDate && (
          <button type="button" onClick={() => setSelDate(null)} className="text-[8px] text-slate-500 hover:text-slate-300">
            × 返回
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
        {!data && <p className="py-6 text-center text-[11px] text-slate-600">{error ? "日历未接通" : "加载中…"}</p>}
        {data && activeList.length === 0 && (
          <p className="py-6 text-center text-[11px] text-slate-600">暂无披露安排</p>
        )}
        {activeList.map((it) => (
          <button
            key={`${it.date}-${it.code}`}
            type="button"
            onClick={() => select(it.code, it.name)}
            className="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-slate-800/40"
          >
            <span className="w-6 shrink-0">
              {view.heavy.has(it.code) ? <Star size={10} className="text-amber-400" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{it.name}</span>
            <span className="shrink-0 text-[9px] text-slate-500">{quarterLabel(it.period || it.date)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
