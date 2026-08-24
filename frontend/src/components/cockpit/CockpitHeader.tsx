import { Link, useLocation } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { useClock } from "@/hooks/useClock";
import { cn } from "@/lib/utils";

export type PageNavItem = {
  to: string;
  label: string;
  short: string;
  match: (p: string) => boolean;
  primary: boolean;
};

/** Desktop header and phone bottom bar share this list. primary = thumb-row on phone. */
export const PAGE_NAV: PageNavItem[] = [
  { to: "/a-share", label: "A股", short: "A股", match: (p) => p.startsWith("/a-share"), primary: true },
  { to: "/derivatives", label: "期权期货", short: "期权", match: (p) => p.startsWith("/derivatives"), primary: true },
  { to: "/arb", label: "套利", short: "套利", match: (p) => p.startsWith("/arb"), primary: true },
  { to: "/event", label: "事件", short: "事件", match: (p) => p.startsWith("/event"), primary: true },
  { to: "/dxx", label: "短线侠", short: "短线侠", match: (p) => p.startsWith("/dxx"), primary: true },
  { to: "/fin", label: "财报窗口", short: "财报", match: (p) => p.startsWith("/fin"), primary: true },
  { to: "/us-market", label: "美股", short: "美股", match: (p) => p.startsWith("/us-market"), primary: true },
  { to: "/research", label: "研究", short: "研究", match: (p) => p.startsWith("/research"), primary: false },
  { to: "/backtest", label: "回测", short: "回测", match: (p) => p.startsWith("/backtest"), primary: true },
  { to: "/data", label: "数据", short: "数据", match: (p) => p.startsWith("/data"), primary: false },
  { to: "/ai-watch", label: "AI观察", short: "AI观察", match: (p) => p.startsWith("/ai-watch"), primary: false },
  { to: "/portfolio", label: "持仓", short: "持仓", match: (p) => p.startsWith("/portfolio"), primary: true },
  { to: "/settings", label: "接入 AI", short: "接入AI", match: (p) => p.startsWith("/settings"), primary: false },
];

export function parseAShareTab(raw: string | null): string {
  if (raw === "detail" || raw === "feed") return raw;
  return "review";
}

/** Flush rail for page nav. */
export const NAV_RAIL_CLASS =
  "flex min-w-0 items-center gap-px overflow-x-auto bg-black [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** 12px chip: idle gray, active yellow like THS tabs. */
export function navChipClass(active: boolean): string {
  return cn(
    "relative shrink-0 px-2 py-1 text-[12px] font-medium leading-none transition-colors duration-100",
    active
      ? "bg-[#2a1a00] text-[#ffcc00]"
      : "text-[#c8c8c8] hover:bg-[#1a1a1a] hover:text-white",
  );
}

export function CockpitHeader({
  isFullscreen,
  onToggleFullscreen,
  extra,
}: {
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  extra?: React.ReactNode;
}) {
  const { pathname } = useLocation();
  const now = useClock(1000);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];

  return (
    <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[#2a2a2a] bg-black px-1.5 sm:gap-2 sm:px-2">
      <Link to="/a-share" title="返回首页" className="flex shrink-0 items-center gap-1.5">
        <span className="flex h-5 w-5 items-center justify-center bg-[#e53935] text-[11px] font-bold text-white">
          V
        </span>
        <h1 className="text-[13px] font-semibold tracking-wide text-[#eee]">
          市场研究驾驶舱
          <span className="ml-2 hidden text-[9px] font-medium tracking-[0.16em] text-[#ffcc00]/70 xl:inline">
            MARKET RESEARCH COCKPIT
          </span>
        </h1>
      </Link>
      <div className="mx-0.5 hidden h-4 w-px bg-[#2a2a2a] md:block" />
      <nav className={cn(NAV_RAIL_CLASS, "hidden min-w-0 flex-1 md:flex")} aria-label="主导航">
        {PAGE_NAV.map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.to}
              to={l.to}
              prefetch={l.to === "/fin" ? "render" : "intent"}
              aria-current={active ? "page" : undefined}
              className={navChipClass(active)}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <div id="cockpit-header-actions" className="flex items-center gap-1.5" />
        {extra}
        <span className="hidden items-center gap-1 text-[11px] font-medium text-[#00d26a] sm:flex">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00d26a] opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#00d26a]" />
          </span>
          实时
        </span>
        <span className="hidden text-[11px] tabular-nums text-[#888] lg:inline">
          {dateStr} 星期{week}
        </span>
        <span className="border border-[#2a2a2a] bg-[#111] px-1.5 py-px font-mono text-[12px] font-bold text-[#ffcc00]">
          {hh}:{mm}
          <span className="text-[#886600]">:{ss}</span>
        </span>
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "退出全屏" : "全屏显示"}
          className="flex h-6 w-6 items-center justify-center border border-[#2a2a2a] bg-[#111] text-[#bbb] hover:border-primary/60 hover:text-primary"
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
    </header>
  );
}
