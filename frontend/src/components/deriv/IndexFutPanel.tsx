import { useMemo, useState } from "react";
import { api, ETF_SHARE_WATCH, type OvlabMarketRow, type OvlabParkedRow } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import type { DerivData } from "@/hooks/useDerivData";
import { cn } from "@/lib/utils";
import { fmtAmt } from "@/components/review/format";
import { nextSort, num, prevCloseOf, previewCode, toSparkMap, TrendSparkSvg, type SortState } from "@/components/ovlab/shared";
import { CellEmpty, cmpVal, contractCode, CtnText, IV_SORT_COLS, IvTriple, NightMoon, SortableHd, undOfRow } from "./derivShared";

type BoardKey = "product_alias" | "price" | "ctn" | "parked" | "atmv_current" | "atmv_percentile" | "carry";

const COLS: { key: BoardKey; label: string; cls: string; title?: string }[] = [
  { key: "product_alias", label: "品种", cls: "w-[3.8rem] justify-start text-left" },
  { key: "price", label: "最新", cls: "w-[3.8rem] justify-end text-right" },
  { key: "ctn", label: "涨跌", cls: "w-[3.6rem] justify-end text-right" },
  { key: "parked", label: "沉淀", cls: "w-[4rem] justify-end text-right", title: "期货=持仓x价格x乘数x九期网交易所保证金; ETF=份额x现价" },
  ...IV_SORT_COLS,
];

function parkedByUnd(rows: OvlabParkedRow[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    const u = (r.und || "").trim().toUpperCase();
    if (u && Number.isFinite(r.parked)) m.set(u, r.parked);
  }
  return m;
}

/** 亿份 * 现价 -> 元. 和复盘 ETF 份额同一口径. */
export function etfParkedYuan(sharesYi: number | null | undefined, price: number | null | undefined): number | null {
  if (sharesYi == null || price == null || !Number.isFinite(sharesYi) || !Number.isFinite(price)) return null;
  if (sharesYi <= 0 || price <= 0) return null;
  return sharesYi * 1e8 * price;
}

function parkedOf(row: OvlabMarketRow, cap: Map<string, number>, sharesYi: Map<string, number>): number | null {
  const und = undOfRow(row).toUpperCase();
  if (und && cap.has(und)) return cap.get(und)!;
  return etfParkedYuan(sharesYi.get(und), num(row.price));
}

interface BoardItem {
  key: string;
  label: string;
  row: OvlabMarketRow;
}

function fieldOf(
  row: OvlabMarketRow,
  label: string,
  key: BoardKey,
  cap: Map<string, number>,
  sharesYi: Map<string, number>,
): unknown {
  if (key === "product_alias") return label;
  if (key === "parked") return parkedOf(row, cap, sharesYi);
  return row[key];
}

/** Domestic commodity rows: sector_alias present and not 股指. */
function commodityRowsOf(rows: OvlabMarketRow[] | null): OvlabMarketRow[] {
  return (rows ?? []).filter((r) => {
    const s = String(r.sector_alias ?? "");
    return s && s !== "股指";
  });
}

/** 股指 + 商品主力: 一张竖表. 点列头整表排序; 默认股指在上、商品在下.
 *  非目录商品分时按可见码补拉. 行点击 -> onPickProduct (T 表 + 标的图). */
export function IndexFutPanel({ d, nightOnly = false, onPickProduct }: {
  d: DerivData;
  nightOnly?: boolean;
  onPickProduct?: (prodUnd: string, undChart?: { code: string; name: string }) => void;
}) {
  const [sort, setSort] = useState<SortState<Record<BoardKey, unknown>>>({ key: null, dir: "desc" });
  const capPoll = usePolling(() => api.ovlabParked(), 300_000, []);
  const capMap = useMemo(() => parkedByUnd(capPoll.data?.rows), [capPoll.data]);
  const sharePoll = usePolling(
    () => api.etfSharesBatch([...ETF_SHARE_WATCH.map((x) => x.code)], 80),
    300_000,
    [],
  );
  const sharesYi = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of sharePoll.data?.items ?? []) {
      const yi = it.latest?.shares_yi;
      if (it.code && yi != null && Number.isFinite(yi)) m.set(it.code, yi);
    }
    return m;
  }, [sharePoll.data]);
  const items = useMemo(() => {
    const nightOk = (r: OvlabMarketRow) => !nightOnly || Number(r.has_night_trading) === 1;
    const indexItems: BoardItem[] = d.catalogRows
      .filter((c) => c.def.group !== "commodity" && nightOk(c.row))
      .map((c) => ({ key: c.def.product, label: c.def.label, row: c.row }));
    const catalogLabel = new Map(d.catalogRows.map((c) => [c.def.product, c.def.label]));
    const cmdItems: BoardItem[] = commodityRowsOf(d.rows)
      .filter(nightOk)
      .map((r) => ({
        key: `${r.product}-${r.exp ?? ""}`,
        label: catalogLabel.get(String(r.product ?? "")) ?? String(r.product_alias ?? r.product),
        row: r,
      }));
    const list = [...indexItems, ...cmdItems];
    if (!sort.key) return list;
    const key = sort.key;
    return [...list].sort((a, b) =>
      cmpVal(
        fieldOf(a.row, a.label, key, capMap, sharesYi),
        fieldOf(b.row, b.label, key, capMap, sharesYi),
        sort.dir,
      ),
    );
  }, [d.catalogRows, d.rows, nightOnly, sort, capMap, sharesYi]);

  // d.sparks 只覆盖目录码; 非目录品种 (LPG/燃油/乙二醇等) 按可见码补拉
  const missingKey = useMemo(() => {
    const codes = new Set<string>();
    for (const it of items) {
      const c = previewCode(it.row);
      if (c && !d.sparks[c]) codes.add(c);
    }
    return [...codes].sort().join("|");
  }, [items, d.sparks]);

  const extraPoll = usePolling(
    () => api.ovlabPriceVolatilitySeries(missingKey.split("|").filter(Boolean)),
    300_000,
    [missingKey],
    missingKey.length > 0,
  );
  const extraSparks = useMemo(() => toSparkMap(extraPoll.data), [extraPoll.data]);

  if (!d.rows) return <CellEmpty text={d.marketError ? "未取到" : "更新中…"} />;
  if (items.length === 0) return <CellEmpty text={nightOnly ? "无夜盘品种" : undefined} />;

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-card/95 px-2 pb-0.5 pt-1 text-[10px] text-slate-300">
        <span className="h-3.5 w-3.5 shrink-0" />
        {COLS.map((c) => (
          <SortableHd
            key={c.key}
            k={c.key}
            label={c.label}
            sort={sort}
            onSort={(k) => setSort((s) => nextSort(s, k))}
            className={c.cls}
            title={c.title}
          />
        ))}
        <span className="min-w-0 flex-1">分时</span>
      </div>
      <div className="divide-y divide-slate-800/60">
        {items.map(({ key, label, row }) => {
          const code = contractCode(row);
          const pc = previewCode(row);
          const spark = d.sparks[pc] ?? extraSparks[pc];
          const price = num(row.price);
          const parked = parkedOf(row, capMap, sharesYi);
          const prodUnd = undOfRow(row);
          return (
            <button
              key={key}
              type="button"
              onClick={onPickProduct
                ? () => onPickProduct(prodUnd, code ? { code, name: `${label} ${code}` } : undefined)
                : undefined}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors",
                onPickProduct && "hover:bg-slate-800/40",
              )}
              title={onPickProduct ? `看 ${label} 标的日K/分时, 调出 T 型报价` : undefined}
            >
              <NightMoon show={Number(row.has_night_trading) === 1} />
              <span className="w-[3.8rem] shrink-0 leading-tight">
                <span className="block truncate text-[12px] font-medium text-slate-200">{label}</span>
                <span className="block truncate font-mono text-[10px] text-primary/70">
                  {code || "-"}
                </span>
              </span>
              <span className="w-[3.8rem] shrink-0 text-right text-[12px] font-medium tabular-nums text-slate-200">
                {price !== null ? Number(price.toFixed(2)).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-"}
              </span>
              <span className="w-[3.6rem] shrink-0 text-right text-[12px]">
                <CtnText value={row.ctn} boldOver={3} />
              </span>
              <span
                className="w-[4rem] shrink-0 text-right text-[11px] tabular-nums text-slate-200"
                title={/^\d{6}$/.test(prodUnd) ? "ETF 份额x现价" : "持仓x价格x乘数x九期网交易所保证金"}
              >
                {parked == null ? "-" : fmtAmt(parked)}
              </span>
              <IvTriple row={row} />
              <span className="flex h-6 min-w-0 flex-1 items-center">
                <TrendSparkSvg
                  prices={spark?.prices ?? []}
                  volatilities={spark?.volatilities ?? []}
                  base={prevCloseOf(row)}
                  width={72}
                  height={24}
                  fill
                  className="h-6"
                  und={undOfRow(row)}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
