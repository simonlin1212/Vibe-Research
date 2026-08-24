import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { OvlabProductExp } from "@/lib/api";
import { cn } from "@/lib/utils";

type ExpItem = { alias: string; und: string; ex: string };

const EX_NAME: Record<string, string> = {
  SSE: "沪市", SHSE: "沪市", SZSE: "深市", SHSZ: "深市", SHFE: "上期", CZCE: "郑商", DCE: "大商",
  CFFEX: "中金", GFEX: "广期", INE: "能源", GLOBEX: "芝商",
  上交所: "沪市", 深交所: "深市", 上期所: "上期", 郑商所: "郑商", 大商所: "大商",
  中金所: "中金", 广期所: "广期", 能源所: "能源",
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const EX_ORDER = ["中金", "沪市", "深市", "上期", "能源", "郑商", "大商", "广期", "芝商"];

function exName(ex: string): string {
  return EX_NAME[ex] || EX_NAME[ex.toUpperCase()] || ex;
}

function ymdToday(): string {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
}

/** Inclusive remaining calendar days. Today = 0. */
function daysLeftOf(ds: string, today: string): number {
  return Math.round(
    (new Date(Number(ds.slice(0, 4)), Number(ds.slice(4, 6)) - 1, Number(ds.slice(6, 8))).getTime()
      - new Date(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8))).getTime()) / 86400000,
  );
}

function groupByEx(list: ExpItem[]): { ex: string; name: string; items: ExpItem[] }[] {
  const map = new Map<string, ExpItem[]>();
  for (const p of list) {
    const k = p.ex || "其他";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(p);
  }
  return [...map.entries()]
    .map(([ex, items]) => ({ ex, name: exName(ex), items }))
    .sort((a, b) => rankEx(a.name) - rankEx(b.name));
}

function rankEx(name: string): number {
  const i = EX_ORDER.indexOf(name);
  return i < 0 ? 99 : i;
}

function cellExNames(list: ExpItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of list) {
    const n = exName(p.ex || "其他");
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  names.sort((a, b) => rankEx(a) - rankEx(b));
  return names;
}

function fmtLongDate(ds: string): string {
  const y = Number(ds.slice(0, 4));
  const m = Number(ds.slice(4, 6));
  const d = Number(ds.slice(6, 8));
  const w = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日 周${w}`;
}

function finePointer(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function placeTip(rect: DOMRect, popW: number, popH: number): { top: number; left: number } {
  let left = rect.left + rect.width / 2 - popW / 2;
  let top = rect.bottom + 8;
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  if (left < 8) left = 8;
  if (top + popH > window.innerHeight - 8) top = rect.top - popH - 8;
  if (top < 8) top = 8;
  return { top, left };
}

function groupByDate(data: OvlabProductExp[]): Map<string, ExpItem[]> {
  const today = ymdToday();
  const byDate = new Map<string, ExpItem[]>();
  for (const p of data) {
    for (const e of p.exps ?? []) {
      const d = String(e.expDate ?? "");
      if (!d) continue;
      const left = daysLeftOf(d, today);
      if (left < 0) continue;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push({
        alias: String(p.product_alias ?? ""),
        und: String(p.product_und ?? p.product ?? ""),
        ex: String(p.exchange ?? ""),
      });
    }
  }
  return byDate;
}

/** 临期期权月历: 同帧 product-exps, 只画当前查看月且未过期, 格子标交易所, 点/悬停看标的. */
export function ExpiryCalendar({ data }: { data: OvlabProductExp[] }) {
  const byDate = groupByDate(data);
  const popRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ ds: string; top: number; left: number; list: ExpItem[] } | null>(null);
  const [view, setView] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });

  const monthLabel = `${view.y}年 ${view.m + 1}月`;
  const startWeekday = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < 42) cells.push(null);

  const fmtD = (d: number) => `${view.y}${String(view.m + 1).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  const today = ymdToday();
  const monthPrefix = `${view.y}${String(view.m + 1).padStart(2, "0")}`;
  let monthDays = 0;
  for (const ds of byDate.keys()) {
    if (ds.startsWith(monthPrefix)) monthDays += 1;
  }
  const prevMonth = () => {
    setTip(null);
    setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  };
  const nextMonth = () => {
    setTip(null);
    setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));
  };

  const showTip = (el: HTMLElement, ds: string, list: ExpItem[]) => {
    if (list.length === 0) { setTip(null); return; }
    const groups = groupByEx(list);
    const popW = Math.min(252, window.innerWidth - 16);
    let popH = 44;
    for (const g of groups) popH += 20 + Math.ceil(g.items.length / 3) * 22;
    popH = Math.min(popH + 8, Math.min(340, window.innerHeight - 24));
    const { top, left } = placeTip(el.getBoundingClientRect(), popW, popH);
    setTip({ ds, top, left, list });
  };

  useEffect(() => {
    if (!tip) return;
    const onDown = (e: PointerEvent) => {
      const node = e.target as HTMLElement | null;
      if (!node) return;
      if (popRef.current?.contains(node)) return;
      if (node.closest("[data-exp-cell]")) return;
      setTip(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [tip]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <div className="flex h-6 shrink-0 items-center justify-between gap-1 border-b border-[#2a2a2a] px-1.5">
        <span className="text-[11px] tabular-nums text-[#888]">{monthDays} 个到期日</span>
        <div className="flex items-center gap-px">
          <button type="button" onClick={prevMonth} className="p-1 text-[#888] hover:bg-[#1a1400] hover:text-primary">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[84px] text-center text-[12px] font-semibold tabular-nums text-[#ffcc00]">{monthLabel}</span>
          <button type="button" onClick={nextMonth} className="p-1 text-[#888] hover:bg-[#1a1400] hover:text-primary">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setTip(null);
              setView({ y: new Date().getFullYear(), m: new Date().getMonth() });
            }}
            className="ml-0.5 border border-[#333] px-1.5 py-px text-[11px] text-[#aaa] hover:border-primary/50 hover:text-primary"
          >
            今日
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 border-b border-[#2a2a2a] text-center text-[10px]">
        {WEEKDAYS.map((w, idx) => (
          <div key={w} className={cn("py-px font-medium", idx === 0 || idx === 6 ? "text-[#ff4d4f]" : "text-[#888]")}>{w}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px bg-[#2a2a2a]">
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="bg-black" />;
          const ds = fmtD(d);
          const list = byDate.get(ds) ?? [];
          const isToday = ds === today;
          const hasExpiry = list.length > 0;
          const daysLeft = daysLeftOf(ds, today);
          const hot = hasExpiry && daysLeft <= 7;
          const weekend = i % 7 === 0 || i % 7 === 6;
          const exNames = hasExpiry ? cellExNames(list) : [];
          return (
            <div
              key={i}
              data-exp-cell=""
              onMouseEnter={(e) => { if (finePointer()) showTip(e.currentTarget, ds, list); }}
              onMouseLeave={() => { if (finePointer()) setTip(null); }}
              onClick={(e) => {
                if (finePointer()) return;
                if (!hasExpiry || tip?.ds === ds) { setTip(null); return; }
                showTip(e.currentTarget, ds, list);
              }}
              className={cn(
                "relative flex min-h-0 flex-col items-center justify-center overflow-hidden bg-black px-px text-[12px] leading-none",
                weekend && !isToday && !hot && "text-[#ff4d4f]",
                !weekend && !hasExpiry && !isToday && "text-[#555]",
                hasExpiry && !isToday && !hot && "cursor-pointer text-[#eee]",
                hot && !isToday && "cursor-pointer bg-[#1a0808] text-[#ff4d4f]",
                isToday && "bg-[#1a1400] text-[#ffcc00] shadow-[inset_0_0_0_1px_#ffcc00]",
                hasExpiry && isToday && "cursor-pointer",
                hasExpiry && tip?.ds === ds && "shadow-[inset_0_0_0_1px_#ffcc00]",
              )}
            >
              <span className={cn("shrink-0 tabular-nums", isToday && "font-bold")}>
                {d}
              </span>
              {hasExpiry && (
                <span className={cn(
                  "mt-px max-h-[22px] w-full overflow-hidden text-center text-[9px] leading-[11px] tracking-tight",
                  isToday ? "text-[#ffcc00]/70" : hot ? "text-[#ff4d4f]/80" : "text-[#888]",
                )}>
                  {exNames.join(" ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {tip && createPortal(
        <div
          ref={popRef}
          className="fixed z-[80] w-[min(252px,calc(100vw-16px))] border border-[#2a2a2a] bg-black p-2"
          style={{ top: tip.top, left: tip.left }}
        >
          <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-[#2a2a2a] pb-1">
            <span className="text-[12px] font-semibold tracking-wide text-[#ffcc00]">{fmtLongDate(tip.ds)}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-[#888]">{tip.list.length} 个标的</span>
          </div>
          <div className="max-h-[min(280px,50vh)] space-y-1.5 overflow-y-auto">
            {groupByEx(tip.list).map((g) => (
              <div key={g.ex}>
                <div className="mb-0.5 text-[10px] font-medium text-[#ffcc00]">{g.name}</div>
                <div className="flex flex-wrap gap-px">
                  {g.items.map((p, i) => (
                    <span
                      key={`${p.und}-${i}`}
                      className="inline-flex items-center border border-[#2a2a2a] bg-[#0d0d0d] px-1.5 py-0.5 text-[10px] leading-tight text-[#eee]"
                    >
                      {p.alias || p.und}
                      {p.alias && p.und && p.alias !== p.und ? (
                        <span className="ml-1 font-mono text-[9px] text-[#888]">{p.und}</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
