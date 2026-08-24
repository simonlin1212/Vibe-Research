import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { WatchStar } from "@/components/cockpit/WatchStar";
import { MinuteSpark } from "@/components/review/MinuteSpark";
import { bgChg, fmtAmt, fmtPrice, pctColor } from "@/components/review/format";
import { usePolling } from "@/hooks/usePolling";
import { loadLightKline, sparkFromKline } from "@/lib/lightKline";
import { api } from "@/lib/api";
import { useQuote } from "@/lib/quoteHub";
import { boardLineParts, useStockBoards } from "@/lib/stockBoardsHub";
import { cn } from "@/lib/utils";
import { watchDigits } from "@/lib/watchlist";
import { klineHref, useAllowKlineJump } from "@/components/cockpit/QuoteLine";

const COMPACT_W = 400;
const KLINE_MS = 60_000;

function Stat({
  label,
  value,
  valueCls = "text-slate-300",
}: {
  label?: string;
  value: ReactNode;
  valueCls?: string;
}) {
  return (
    <span className="flex min-w-0 items-center justify-end gap-1 leading-none">
      {label && <span className="shrink-0 text-[9px] text-slate-600">{label}</span>}
      <span className={cn("truncate text-[11px] tabular-nums", valueCls)}>{value}</span>
    </span>
  );
}

function useRowBox() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [on, setOn] = useState(false);
  const [rowW, setRowW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const io = new IntersectionObserver(
      (ents) => setOn(ents.some((e) => e.isIntersecting)),
      { rootMargin: "80px" },
    );
    const ro = new ResizeObserver((ents) => setRowW(ents[0]?.contentRect.width ?? 0));
    io.observe(el);
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [el]);
  return { setEl, on, rowW };
}

export interface RowSpark {
  closes: number[];
  times?: string[];
  prevClose?: number | null;
}

/** Two-row stock line: name/code, spark, amount/price, main-net/ratio bar, turnover, pct. */
export function QuoteStockRow({
  code,
  name,
  price,
  pct,
  amount,
  turnover,
  mainNet,
  mainPct,
  rank,
  symbol,
  link = true,
  spark,
  tag,
  watchable = true,
  boards: wantBoards = true,
  flow = false,
  active = false,
  onPick,
}: {
  code: string;
  name: string;
  price: number | null | undefined;
  pct: number | null | undefined;
  amount?: number | null;
  turnover?: number | null;
  mainNet?: number | null;
  mainPct?: number | null;
  rank?: number;
  symbol?: string;
  link?: boolean;
  /** Parent-owned spark. undefined = fetch here. */
  spark?: RowSpark | null;
  /** Chain-role label, shown after the code. */
  tag?: string;
  watchable?: boolean;
  /** Industry/concept tag. Off for rotating sector rows to spare em_get. */
  boards?: boolean;
  /** Fetch 主力净额/净占比 (Eastmoney ulist, 30s). Same as marketingdashboard QuoteRow flow. */
  flow?: boolean;
  active?: boolean;
  onPick?: (code: string) => void;
}) {
  const { setEl, on: visible, rowW } = useRowBox();
  const compact = rowW > 0 && rowW < COMPACT_W;
  const owned = spark !== undefined;
  const hubCode = symbol && /^(sh|sz|bj)/i.test(symbol) ? symbol : code;
  const hub = useQuote(hubCode);
  const livePrice = hub && hub.price > 0 ? hub.price : price;
  const livePct = hub ? hub.pct : pct;
  const liveAmt = amount ?? hub?.amount;
  const liveTurn = turnover ?? hub?.turnover;
  const needFetch = flow && mainNet == null && mainPct == null;
  const { data: fl } = usePolling(
    () => api.quoteFlow(code),
    30_000,
    [code],
    visible && needFetch,
  );
  const liveNet = mainNet ?? fl?.netIn ?? null;
  const liveMainPct = mainPct ?? fl?.netRatio ?? null;
  const boards = useStockBoards(code, visible && wantBoards);
  const boardLine = wantBoards ? boardLineParts(boards) : null;
  const showStar = watchable && !!watchDigits(code);

  const { data: kl } = usePolling(
    () => loadLightKline(code, "1", 240),
    KLINE_MS,
    [code],
    visible && !owned,
  );
  const ownSpark = owned ? spark : sparkFromKline(kl);
  const closes = ownSpark?.closes ?? [];
  const times = ownSpark?.times;
  const prevClose = ownSpark?.prevClose;
  const allowJump = useAllowKlineJump();
  const href = link && !onPick && allowJump ? klineHref(code) : undefined;
  const hasAmt = liveAmt != null && liveAmt > 0;
  const hasTurn = liveTurn != null && liveTurn > 0;
  const ratioBar = liveMainPct != null ? Math.min(100, Math.abs(liveMainPct) * 2) : 0;
  const rankCls = rank != null && rank <= 3 ? "text-amber-400" : "text-slate-600";

  const inner = (
    <div
      className="grid items-center gap-x-1"
      style={{
        gridTemplateColumns: `${showStar ? "14px " : ""}${rank != null ? "auto " : ""}72px minmax(0,1fr) minmax(0,1fr) ${hasAmt ? "64px" : "0px"} 60px`,
        gridTemplateRows: "18px 14px",
      }}
    >
      {showStar && (
        <div className="row-span-2 self-center">
          <WatchStar code={code} />
        </div>
      )}
      {rank != null && (
        <div className={cn("row-span-2 self-center text-[11px] font-bold leading-none tabular-nums", rankCls)}>
          {rank}
        </div>
      )}
      <div className="row-span-2 flex min-w-0 flex-col justify-center gap-1 leading-none">
        <span className="truncate text-[11px] text-slate-200">{name}</span>
        <span
          className="truncate text-[10px] text-slate-500"
          title={hub?.stale_reason || undefined}
        >
          {tag ? `${symbol || code} · ${tag}` : (symbol || code)}
          {hub?.is_stale ? " · 停/废" : ""}
        </span>
      </div>
      <div className="col-span-2 flex h-5 min-w-0 items-center self-center">
        <MinuteSpark
          closes={closes}
          times={times}
          session="ashare"
          prevClose={prevClose}
          pct={livePct ?? 0}
          className="h-5"
        />
      </div>
      {hasAmt ? <Stat label="额" value={fmtAmt(liveAmt)} /> : <div />}
      <Stat label="价" value={fmtPrice(livePrice)} />
      <Stat
        label={compact ? "净" : "主力净额"}
        value={fmtAmt(liveNet)}
        valueCls={cn("font-semibold", liveNet != null ? pctColor(liveNet) : "text-slate-600")}
      />
      <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap leading-none">
        <span className="shrink-0 text-[9px] text-slate-600">{compact ? "占" : "净占比"}</span>
        <span className="h-1 min-w-0 flex-1 self-center rounded-full bg-slate-800">
          <span
            className={cn("block h-1 rounded-full", (liveMainPct ?? 0) < 0 ? "bg-emerald-400/80" : "bg-rose-400/80")}
            style={{ width: `${ratioBar}%` }}
          />
        </span>
        <span className={cn("truncate text-[11px] tabular-nums", liveMainPct != null ? pctColor(liveMainPct) : "text-slate-600")}>
          {liveMainPct != null && Number.isFinite(liveMainPct) ? `${liveMainPct.toFixed(1)}%` : "—"}
        </span>
      </div>
      {hasTurn ? <Stat label="换" value={`${liveTurn!.toFixed(1)}%`} /> : <div />}
      <Stat
        label="幅"
        value={
          livePct != null && Number.isFinite(livePct) ? (
            <span className={cn("rounded px-0.5 font-semibold", bgChg(livePct))}>
              {livePct > 0 ? "+" : ""}{livePct.toFixed(2)}%
            </span>
          ) : "—"
        }
      />
    </div>
  );

  const line = boardLine && (
    <div
      className="mt-0.5 flex h-[13px] min-w-0 items-center text-[9px] leading-none"
      title={`${boardLine.industry}${boardLine.concepts ? ` · ${boardLine.concepts}` : ""}`}
    >
      <span className="truncate">
        {boardLine.industry && <span className="text-[#ffcc00]/80">{boardLine.industry}</span>}
        {boardLine.concepts && (
          <span className="text-slate-600">
            {boardLine.industry ? " · " : ""}
            {boardLine.concepts}
          </span>
        )}
      </span>
    </div>
  );
  const cls = cn(
    "group block w-full px-1.5 py-[2px] text-left transition-colors hover:bg-[#1a1400] hover:shadow-[inset_2px_0_0_#ffcc00]",
    active && "bg-[#1a1400] shadow-[inset_2px_0_0_#ffcc00]",
  );
  return (
    <div ref={setEl}>
      {onPick ? (
        <button type="button" onClick={() => onPick(code)} className={cls}>{inner}{line}</button>
      ) : href ? (
        <Link to={href} className={cls}>{inner}{line}</Link>
      ) : (
        <div className={cls}>{inner}{line}</div>
      )}
    </div>
  );
}
