import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useSearchParams } from "react-router-dom";
import {
  BookOpen,
  CandlestickChart,
  Cpu,
  Database,
  FlaskConical,
  FileSpreadsheet,
  GitCompare,
  Globe2,
  Radio,
  LineChart,
  MoreHorizontal,
  Plug,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PageFallback } from "@/components/ui/PageFallback";
import { A_SHARE_TABS, CockpitHeader, NAV_RAIL_CLASS, PAGE_NAV, navChipClass, parseAShareTab } from "@/components/cockpit/CockpitHeader";
import { NewsToastHost } from "@/components/cockpit/NewsToastHost";
import { TickerTape } from "@/components/cockpit/TickerTape";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useTapeQuotes } from "@/hooks/useTapeQuotes";
import { cn } from "@/lib/utils";

const NAV_ICONS: Record<string, LucideIcon> = {
  "/a-share": CandlestickChart,
  "/fin": FileSpreadsheet,
  "/us-market": Globe2,
  "/research": BookOpen,
  "/backtest": FlaskConical,
  "/data": Database,
  "/ai-watch": Cpu,
  "/derivatives": LineChart,
  "/arb": GitCompare,
  "/event": Radio,
  "/portfolio": Wallet,
  "/settings": Plug,
};

const PRIMARY_NAV = PAGE_NAV.filter((l) => l.primary);
const MORE_NAV = PAGE_NAV.filter((l) => !l.primary);

function isCockpitPath(pathname: string, tab: string | null) {
  if (pathname.startsWith("/ai-watch") || pathname.startsWith("/fin")) return true;
  if (pathname.startsWith("/derivatives")) return true;
  if (pathname.startsWith("/arb")) return true;
  if (pathname.startsWith("/event")) return true;
  if (!pathname.startsWith("/a-share")) return false;
  if (!tab || tab === "review") return true;
  return false;
}

export function Layout() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { isFullscreen, toggle } = useFullscreen();
  const tapeItems = useTapeQuotes();
  const cockpit = isCockpitPath(pathname, params.get("tab"));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_NAV.some((l) => l.match(pathname));
  const aTab = parseAShareTab(params.get("tab"));
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  }, []);

  useLayoutEffect(() => {
    setMoreOpen(false);
    // Phone: #main is the shared scroller. Keep the new page at the top.
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        跳到内容
      </a>
      <CockpitHeader isFullscreen={isFullscreen} onToggleFullscreen={toggle} />
      <TickerTape items={tapeItems} />
      <NewsToastHost />
      {pathname.startsWith("/a-share") && (
        <nav
          className={cn(NAV_RAIL_CLASS, "shrink-0 border-b border-[#2a2a2a] px-1")}
          aria-label="A股页签"
        >
          {A_SHARE_TABS.map((t) => {
            const active = t.tab === null
              ? aTab === "review"
              : aTab === "kline" || aTab === "detail" || aTab === "feed";
            return (
              <Link key={t.label} to={t.to} aria-current={active ? "page" : undefined} className={navChipClass(active)}>
                {t.label}
              </Link>
            );
          })}
        </nav>
      )}
      <main
        id="main"
        ref={mainRef}
        className={cn(
          "min-h-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0",
          cockpit ? "flex flex-col overflow-auto lg:overflow-hidden" : "overflow-auto",
        )}
      >
        {cockpit ? (
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        ) : (
          <div
            className={cn(
              "mx-auto w-full pb-6 pt-3 px-3 sm:px-4",
              pathname.startsWith("/settings")
                ? "max-w-3xl"
                : "max-w-[1680px]",
            )}
          >
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        )}
      </main>
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur-md md:hidden pb-[env(safe-area-inset-bottom)]"
        aria-label="主导航"
      >
        {moreOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-2 border border-[#2a2a2a] bg-black p-1">
            {MORE_NAV.map((l) => {
              const Icon = NAV_ICONS[l.to];
              const active = l.match(pathname);
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2.5 text-[13px] font-medium",
                    active ? "bg-[#2a1a00] text-[#ffcc00]" : "text-[#ddd] hover:bg-[#1a1a1a]",
                  )}
                >
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                  {l.label}
                </Link>
              );
            })}
          </div>
        )}
        <div className="flex h-14 items-center justify-around px-1">
          {PRIMARY_NAV.map((l) => {
            const Icon = NAV_ICONS[l.to];
            const active = l.match(pathname);
            return (
              <Link
                key={l.to}
                to={l.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-[52px] flex-col items-center justify-center gap-0.5 py-1 text-[11px] font-medium",
                  active ? "text-[#ffcc00]" : "text-[#c8c8c8]",
                )}
              >
                <span className={cn(
                  "flex h-7 w-7 items-center justify-center",
                  active && "bg-[#2a1a00]",
                )}>
                  {Icon ? <Icon className="h-[18px] w-[18px]" /> : null}
                </span>
                {l.short}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className={cn(
              "flex min-w-[52px] flex-col items-center justify-center gap-0.5 py-1 text-[11px] font-medium",
              moreOpen || moreActive ? "text-[#ffcc00]" : "text-[#c8c8c8]",
            )}
            aria-expanded={moreOpen}
            aria-label="更多页面"
          >
            <span className={cn(
              "flex h-7 w-7 items-center justify-center",
              (moreOpen || moreActive) && "bg-[#2a1a00]",
            )}>
              <MoreHorizontal className="h-[18px] w-[18px]" />
            </span>
            更多
          </button>
        </div>
      </nav>
    </div>
  );
}
