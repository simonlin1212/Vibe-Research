import { useMemo, useState } from "react";
import { QuoteStockRow } from "@/components/cockpit/QuoteStockRow";
import { Chip, ChipGroup } from "@/components/ui/SectionHeader";
import { pctColor } from "@/components/review/format";
import { usePolling } from "@/hooks/usePolling";
import { api, type AShareLightKline, type BoardStock, type SectorBoard } from "@/lib/api";
import { sparkFromKline } from "@/lib/lightKline";
import { useMinutes } from "@/lib/minuteHub";
import { cn } from "@/lib/utils";

const POLL_MS = 10_000;
const MAX_STOCK_ROWS = 40;

export type SectorKind = "01" | "02";
type Side = "up" | "down";

export function SectorHotBar({
  kind,
  q,
  onKind,
  onQuery,
}: {
  kind: SectorKind;
  q: string;
  onKind: (k: SectorKind) => void;
  onQuery: (q: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <input
        value={q}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="搜索板块"
        className="h-6 w-20 rounded border border-slate-700/50 bg-slate-800/40 px-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-primary/50"
      />
      <ChipGroup className="border-0 bg-transparent p-0">
        <Chip active={kind === "01"} onClick={() => onKind("01")}>行业</Chip>
        <Chip active={kind === "02"} onClick={() => onKind("02")}>概念</Chip>
      </ChipGroup>
    </div>
  );
}

function fmtPct(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function boardId(b: { code?: string; raw_code?: string; name?: string } | null): string {
  if (!b) return "";
  return (b.raw_code || b.code || b.name || "").trim();
}

function BoardRow({
  b, maxAbs, active, leadLabel, onClick,
}: {
  b: SectorBoard;
  maxAbs: number;
  active: boolean;
  leadLabel: string;
  onClick: () => void;
}) {
  const w = maxAbs > 0 ? Math.min(100, (Math.abs(b.pct) / maxAbs) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[24px_1fr_52px_72px] items-center gap-1.5 rounded px-1.5 py-1 text-left",
        active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-[#1a1400]",
      )}
    >
      <span className="text-[10px] tabular-nums text-slate-600">
        {(b.code || "").slice(-4) || "—"}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-slate-200">{b.name}</span>
        <span className="mt-0.5 block h-1 rounded-full bg-slate-800">
          <span
            className={cn("block h-1 rounded-full", b.pct >= 0 ? "bg-red-400/80" : "bg-emerald-400/70")}
            style={{ width: `${w}%` }}
          />
        </span>
      </span>
      <span className={cn("text-right font-mono text-[12px] font-semibold tabular-nums", pctColor(b.pct))}>
        {fmtPct(b.pct)}
      </span>
      <span className="truncate text-right text-[10px] text-slate-500" title={leadLabel}>
        {b.lead_name || "—"}
        {b.lead_pct ? (
          <span className={cn("ml-0.5", pctColor(b.lead_pct))}>
            {b.lead_pct > 0 ? "+" : ""}{b.lead_pct.toFixed(1)}%
          </span>
        ) : null}
      </span>
    </button>
  );
}

function BoardList({
  title,
  tone,
  boards,
  loading,
  error,
  maxAbs,
  selectedId,
  onPick,
}: {
  title: string;
  tone: "up" | "down";
  boards: SectorBoard[];
  loading: boolean;
  error: string | null;
  maxAbs: number;
  selectedId: string;
  onPick: (b: SectorBoard) => void;
}) {
  const leadLabel = tone === "up" ? "领涨股" : "领跌股";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-1 pt-0.5">
        <div className="mb-0.5 flex items-center justify-between px-1.5 pt-0.5">
          <span className={cn("text-[11px] font-semibold", tone === "up" ? "text-red-400" : "text-emerald-400")}>
            {title}
          </span>
          <span className="text-[10px] text-slate-600">{boards.length ? `${boards.length}` : ""}</span>
        </div>
        <div className="grid grid-cols-[24px_1fr_52px_72px] items-center gap-1.5 px-1.5 py-1 text-[10px] text-slate-500">
          <span>代码</span>
          <span>板块 / 强度</span>
          <span className="text-right">涨跌幅</span>
          <span className="text-right">{leadLabel}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {loading && (
          <p className="py-6 text-center text-[11px] text-slate-600">
            {error ? "板块源未接通, 自动重试中" : "加载中…"}
          </p>
        )}
        {boards.slice(0, 80).map((b) => (
          <BoardRow
            key={boardId(b) || b.name}
            b={b}
            maxAbs={maxAbs}
            active={selectedId === boardId(b)}
            leadLabel={leadLabel}
            onClick={() => onPick(b)}
          />
        ))}
      </div>
    </div>
  );
}

function StockPane({
  board,
  stocks,
  minutes,
  onClose,
}: {
  board: SectorBoard;
  stocks: BoardStock[] | null;
  minutes: Record<string, AShareLightKline | null>;
  onClose: () => void;
}) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-1">
      <div className="mb-1 flex items-baseline justify-between gap-2 px-1.5 pt-1">
        <span className="truncate text-[12px] font-semibold text-primary">{board.name}</span>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("font-mono text-[12px] font-semibold tabular-nums", pctColor(board.pct))}>
            {fmtPct(board.pct)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
          >
            关闭
          </button>
        </div>
      </div>
      <div className="mb-1 grid grid-cols-2 gap-1 px-1.5 text-[10px] text-slate-500">
        <span>5日 <span className={pctColor(board.pct5 ?? 0)}>{fmtPct(board.pct5)}</span></span>
        <span>20日 <span className={pctColor(board.pct20 ?? 0)}>{fmtPct(board.pct20)}</span></span>
      </div>
      {!stocks && (
        <p className="py-4 text-center text-[11px] text-slate-600">成分股加载中…</p>
      )}
      {(stocks ?? []).map((s) => {
        const sp = sparkFromKline(minutes[s.code] || minutes[s.symbol || ""]);
        return (
          <QuoteStockRow
            key={s.code}
            code={s.code}
            symbol={s.symbol || s.code}
            name={s.name}
            price={s.price}
            pct={s.pct}
            amount={s.amount}
            turnover={s.turnover}
            link={false}
            boards={false}
            mainNet={s.main_net}
            mainPct={s.main_pct}
            spark={sp ?? { closes: [] }}
          />
        );
      })}
      {!!stocks?.length && (
        <p className="px-1.5 pt-1 text-right text-[9px] text-slate-600">
          前 {stocks.length} 只成分股
        </p>
      )}
    </div>
  );
}

/** Left: leading boards. Right: lagging boards. Click a board to open constituents on the other half. */
export function SectorHotPanel({
  kind,
  q,
}: {
  kind: SectorKind;
  q: string;
}) {
  const [picked, setPicked] = useState<{ side: Side; id: string } | null>(null);
  const [prevKind, setPrevKind] = useState(kind);
  if (prevKind !== kind) {
    setPrevKind(kind);
    setPicked(null);
  }

  const n = kind === "01" ? 80 : 120;
  const { data: upData, error: upErr } = usePolling(
    () => api.sectorBoards(kind, "0", n),
    POLL_MS,
    [kind],
  );
  const { data: downData, error: downErr } = usePolling(
    () => api.sectorBoards(kind, "1", n),
    POLL_MS,
    [kind],
  );

  const upFiltered = useMemo(
    () => (upData ?? []).filter((b) => !q || b.name.includes(q)),
    [upData, q],
  );
  const downFiltered = useMemo(
    () => (downData ?? []).filter((b) => !q || b.name.includes(q)),
    [downData, q],
  );

  const activeBoard = useMemo(() => {
    if (!picked) return null;
    const list = picked.side === "up" ? upFiltered : downFiltered;
    return list.find((b) => boardId(b) === picked.id) ?? null;
  }, [picked, upFiltered, downFiltered]);

  const stockCode = activeBoard?.raw_code || activeBoard?.code || "";
  const { data: stocks } = usePolling(
    () => (stockCode ? api.boardStocks(stockCode, MAX_STOCK_ROWS) : Promise.resolve([])),
    POLL_MS,
    [stockCode],
    !!stockCode,
  );
  const stockCodes = (stocks ?? []).map((s) => s.code);
  const minutes = useMinutes(stockCodes);
  const upMax = Math.max(...upFiltered.map((b) => Math.abs(b.pct)), 0.01);
  const downMax = Math.max(...downFiltered.map((b) => Math.abs(b.pct)), 0.01);

  const pickBoard = (side: Side, b: SectorBoard) => {
    const id = boardId(b);
    if (activeBoard && picked?.side === side && boardId(activeBoard) === id) {
      setPicked(null);
      return;
    }
    setPicked({ side, id });
  };

  const selectedId = activeBoard ? boardId(activeBoard) : "";
  const stocksOnRight = !!activeBoard && picked?.side === "up";
  const stocksOnLeft = !!activeBoard && picked?.side === "down";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {stocksOnLeft && activeBoard ? (
          <StockPane
            board={activeBoard}
            stocks={stocks}
            minutes={minutes}
            onClose={() => setPicked(null)}
          />
        ) : (
          <BoardList
            title="领涨"
            tone="up"
            boards={upFiltered}
            loading={!upData}
            error={upErr}
            maxAbs={upMax}
            selectedId={picked?.side === "up" ? selectedId : ""}
            onPick={(b) => pickBoard("up", b)}
          />
        )}
        <div className="hidden w-px shrink-0 bg-slate-700/40 sm:block" />
        <div className="h-px shrink-0 bg-slate-700/40 sm:hidden" />
        {stocksOnRight && activeBoard ? (
          <StockPane
            board={activeBoard}
            stocks={stocks}
            minutes={minutes}
            onClose={() => setPicked(null)}
          />
        ) : (
          <BoardList
            title="领跌"
            tone="down"
            boards={downFiltered}
            loading={!downData}
            error={downErr}
            maxAbs={downMax}
            selectedId={picked?.side === "down" ? selectedId : ""}
            onPick={(b) => pickBoard("down", b)}
          />
        )}
      </div>
    </div>
  );
}
