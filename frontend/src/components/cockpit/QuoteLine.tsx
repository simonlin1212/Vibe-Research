import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MinuteSpark } from "@/components/review/MinuteSpark";
import { PctChip } from "@/components/review/PctChip";
import { bgChg, fmt, fmtAmt, fmtAmtInt, fmtPrice, pctColor } from "@/components/review/format";
import type { SparkSession } from "@/lib/sparkAxis";
import { cn } from "@/lib/utils";

/** Same cut as the A-share tab strip (`lg:hidden`). Phone keeps tabs, no kline jump. */
const LG_UP = "(min-width: 1024px)";

export function useAllowKlineJump() {
  const [ok, setOk] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(LG_UP).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(LG_UP);
    const sync = () => setOk(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return ok;
}

export function KlineLink({
  code,
  className,
  title,
  children,
}: {
  code: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const href = useAllowKlineJump() ? klineHref(code) : undefined;
  if (href) {
    return (
      <Link to={href} className={className} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

function Spark({
  closes,
  times,
  session,
  prevClose,
  pct,
  className,
}: {
  closes?: number[];
  times?: string[];
  session?: SparkSession;
  prevClose?: number | null;
  pct?: number | null;
  className?: string;
}) {
  return (
    <MinuteSpark
      closes={closes ?? []}
      times={times}
      session={session}
      prevClose={prevClose}
      pct={pct ?? 0}
      className={className}
    />
  );
}

export function QuoteLine({
  name,
  price,
  pct,
  amount,
  extra,
  extraClass,
  rank,
  closes,
  times,
  session,
  prevClose,
  href,
  unit,
  accent,
  badge,
  variant = "plain",
}: {
  name: string;
  price: number | null | undefined;
  pct: number | null | undefined;
  amount?: number | null;
  extra?: string;
  extraClass?: string;
  rank?: number;
  closes?: number[];
  times?: string[];
  session?: SparkSession;
  prevClose?: number | null;
  href?: string;
  unit?: string;
  accent?: string;
  /** Region chip before the name (CN / US / HK / FX). */
  badge?: string;
  variant?: "plain" | "index";
}) {
  const spark = (className?: string) => (
    <Spark closes={closes} times={times} session={session} prevClose={prevClose} pct={pct} className={className} />
  );
  const inner = variant === "index" ? (
    <div
      className="grid h-full min-h-5 w-full items-center gap-x-1.5"
      title={[unit, amount != null && amount > 0 ? fmtAmtInt(amount) : ""].filter(Boolean).join(" · ")}
      style={{
        gridTemplateColumns: `${badge ? "auto " : ""}minmax(5rem,1.2fr) minmax(2.5rem,1fr) 3.6rem 2.8rem`,
      }}
    >
      {badge && (
        <span className="inline-block w-6 shrink-0 rounded-sm bg-slate-700/50 text-center text-[8px] leading-3 text-slate-400">
          {badge}
        </span>
      )}
      <span className="truncate text-[11px] leading-none text-slate-200" style={accent ? { color: accent } : undefined}>
        {name}
      </span>
      <div className="flex h-[70%] min-h-3.5 max-h-6 min-w-0 items-center">{spark("h-full")}</div>
      <span className={cn("text-right text-[12px] font-bold leading-none tabular-nums", pctColor(pct ?? 0))}>
        {price != null && Number.isFinite(price) ? fmtPrice(price) : "—"}
      </span>
      <span
        className={cn(
          "justify-self-end rounded px-0.5 text-[10px] font-semibold leading-none tabular-nums",
          pct != null && Number.isFinite(pct) ? bgChg(pct) : "text-slate-600",
        )}
      >
        {pct != null && Number.isFinite(pct) ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}
      </span>
    </div>
  ) : (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {rank != null && (
          <span className="w-4 shrink-0 text-right font-mono text-[10px] text-slate-600">{rank}</span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-slate-200">
            {name}
          </span>
          {unit && <span className="block truncate text-[9px] text-slate-600">{unit}</span>}
        </span>
      </span>
      <div className="min-w-0">{spark()}</div>
      <span className="text-right">
        {amount != null && amount > 0 && (
          <span className="block font-mono text-[10px] tabular-nums text-slate-400">{fmtAmt(amount)}</span>
        )}
        {extra && (
          <span className={cn("block font-mono text-[10px] tabular-nums text-slate-500", extraClass)}>{extra}</span>
        )}
        <span className={cn("block font-mono text-[12px] font-bold tabular-nums", pctColor(pct ?? 0))}>
          {price != null && Number.isFinite(price) ? fmt(price) : "—"}
        </span>
      </span>
      <span className="text-right"><PctChip pct={pct} /></span>
    </>
  );
  const bar = accent && variant === "plain" ? (
    <span
      aria-hidden
      className="absolute left-0 top-0 h-full w-[3px] rounded-l"
      style={{ background: accent, opacity: 0.55 }}
    />
  ) : null;
  const cls = variant === "index"
    ? "flex min-h-5 w-full flex-1 items-center rounded px-1.5 hover:bg-slate-800/40"
    : cn(
      "relative grid grid-cols-[minmax(4.5rem,1fr)_minmax(3rem,1.2fr)_4.2rem_3.1rem] items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-slate-800/40",
    );
  const jump = useAllowKlineJump() ? (href ?? klineHref(unit)) : undefined;
  if (jump) {
    return <Link to={jump} className={cls}>{bar}{inner}</Link>;
  }
  return <div className={cls}>{bar}{inner}</div>;
}

/** Chart peek id. Keep market prefix so sh000001 is not sz000001. */
export function peekChartCode(raw: string): string {
  const s = (raw || "").trim();
  if (/^\d{6}$/.test(s)) return s;
  const cn = s.match(/^(sh|sz|bj)(\d{6})$/i);
  if (cn) return `${cn[1].toLowerCase()}${cn[2]}`;
  const ext = s.match(/^(hk|us|wh|jp|ks)([A-Za-z0-9]+)$/i);
  if (ext) return `${ext[1].toLowerCase()}${ext[2]}`;
  const fut = s.match(/^(hf_|nf_)([A-Za-z0-9]{1,12})$/i);
  if (fut) return `${fut[1].toLowerCase()}${fut[2]}`;
  return "";
}

export function klineHref(code?: string) {
  const id = peekChartCode(code || "");
  return id ? `/a-share?code=${id}` : undefined;
}
