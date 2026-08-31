import { useEffect, useMemo, useRef } from "react";
import type { EventCalBoard } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
/** 日红 一蓝 二绿 三金 四橙 五紫 六玫, 跟周末红条同一套字色. */
const WD_TONE = ["#ff2d2d", "#5b9cff", "#2ee59d", "#ffcc00", "#ff8a3d", "#c084fc", "#ff4d6d"] as const;

export function wdTone(dow: number): string {
  return WD_TONE[((dow % 7) + 7) % 7];
}

function todayKey() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseYmd(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 今天 周一 8/24 · 明天 周二 8/25 · 周三 8/26 */
export function labelCalDay(iso: string, today: string): {
  title: string; rel: string; wd: string; md: string; weekend: boolean; dow: number; tone: string;
} {
  const d = parseYmd(iso);
  if (!d) return { title: iso, rel: "", wd: "", md: iso, weekend: false, dow: 0, tone: WD_TONE[0] };
  const t = parseYmd(today);
  const dow = d.getDay();
  const wd = WEEK[dow];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  let rel = "";
  if (t) {
    const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
    if (diff === 0) rel = "今天";
    else if (diff === 1) rel = "明天";
    else if (diff === -1) rel = "昨天";
  }
  return {
    title: [rel, wd, md].filter(Boolean).join(" "),
    rel, wd, md, weekend: dow === 0 || dow === 6, dow, tone: wdTone(dow),
  };
}

export function EventCalPanel({
  data,
  error,
  loading,
}: {
  data: EventCalBoard | null;
  error: string | null;
  loading: boolean;
}) {
  const today = todayKey();
  const days = data?.days ?? [];
  const todayRef = useRef<HTMLDivElement | null>(null);
  const hasToday = useMemo(() => days.some((d) => d.date === today), [days, today]);

  useEffect(() => {
    todayRef.current?.scrollIntoView({ block: "start" });
  }, [hasToday, days.length]);

  if (loading && !data) {
    return <p className="px-2 py-6 text-center text-[13px] text-slate-500">拉日历…</p>;
  }
  if (error && !data) {
    return <p className="px-2 py-6 text-center text-[13px] text-destructive">{error}</p>;
  }
  if (!days.length) {
    return <p className="px-2 py-6 text-center text-[13px] text-slate-500">暂无日程</p>;
  }

  return (
    <div className="h-full overflow-y-auto px-2 py-1.5">
      {days.map((g) => {
        const isToday = g.date === today;
        const lab = labelCalDay(g.date, today);
        return (
          <div key={g.date} ref={isToday ? todayRef : undefined} className="mb-2.5">
            <div className={cn(
              "mb-px grid grid-cols-[1fr_auto_1fr] items-baseline border-l-2 px-1.5 py-1",
              isToday ? "border-primary bg-primary/12" : lab.weekend ? "border-[#ff2d2d] bg-[#ff2d2d]/8" : "border-[#2a2a2a] bg-[#141414]",
            )}>
              <span className={cn("text-[15px] font-semibold", isToday ? "text-primary" : "text-slate-100")}>
                {lab.rel}
              </span>
              <span className="flex items-baseline justify-center gap-1.5" style={{ color: lab.tone }}>
                <span className="text-[14px] font-medium">{lab.wd}</span>
                <span className="font-mono text-[14px] tabular-nums">{lab.md}</span>
              </span>
              <span className="text-right text-[12px] text-slate-500">{g.items.length}</span>
            </div>
            <ul className="border border-[#2a2a2a]">
              {g.items.map((t) => (
                <li key={t} className="border-t border-[#2a2a2a] px-2 py-1.5 text-[13px] leading-snug text-slate-200 first:border-t-0">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
