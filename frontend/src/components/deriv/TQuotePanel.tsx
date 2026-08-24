import { Fragment, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { api, type OvlabTQuoteExpiry, type OvlabTQuoteSide, type OvlabTQuoteStrike } from "@/lib/api";
import type { DerivData } from "@/hooks/useDerivData";
import { usePolling } from "@/hooks/usePolling";
import { num } from "@/components/ovlab/shared";
import { cn } from "@/lib/utils";
import { CellEmpty, CtnText, ProdSearchSelect, SortableHd, contractCode, findRowByUnd, tickFresh, undOfRow } from "./derivShared";
import { IvSmileChart } from "./IvSmileChart";
import { IvTermChart } from "./IvTermChart";
import { storageGet, storageSet } from "@/lib/storage";

/** 右下日K/分时: 点行情观察出标的, 点 T 表出期权合约. */
export interface OptionPick {
  kind: "option" | "und";
  code: string; // option: AU2609C952; und: IF2608 / 510300
  und: string;  // 标的码 (日K IV 叠加 / 分时轴)
  name: string;
  expiry?: string;
}

/** 代码转展示名: AU2609C952 -> AU2609购952. 锚定末尾 C/P+行权价, 防品种码本身含 C/P (玉米 C / PP / ZC). */
export function optionName(code: string): string {
  return code.replace(/C(\d+(?:\.\d+)?)$/, "购$1").replace(/P(\d+(?:\.\d+)?)$/, "沽$1");
}

/** 20260916 / 2026-09-16 -> 09.16 */
export function expMd(raw?: string | null): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[2]}.${m[3]}` : "-";
}

/** 乙二醇2610 */
export function expChipTitle(alias: string, exp: string): string {
  return `${alias}${String(exp ?? "").slice(-4)}`;
}

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
}

function fmtOi(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(Math.round(v));
}

/** 行权价: 整数不带小数, 非整数最多 2 位. */
function fmtStrike(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function fmtPct(v: number, digits = 1): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** 市场 IV 取买卖中值, 缺失回落理论 IV. */
export function ivOf(s: OvlabTQuoteSide): number | null {
  const b = num(s.ivBid);
  const a = num(s.ivAsk);
  if (b !== null && a !== null) return (b + a) / 2;
  return num(s.theoIv);
}

/** 沽虚值 IV - 购虚值 IV; 正=沽更贵 (下行保护需求). */
export function ivSkew(strikes: OvlabTQuoteStrike[], fwd: number | null): number | null {
  if (fwd === null || strikes.length === 0) return null;
  const below = [...strikes].reverse().find((s) => s.strike < fwd);
  const above = strikes.find((s) => s.strike > fwd);
  const putIv = below ? ivOf(below.put) : null;
  const callIv = above ? ivOf(above.call) : null;
  if (putIv === null || callIv === null) return null;
  return putIv - callIv;
}

/** Adjacent rungs that bracket undPx. Exact hit uses this strike + the next higher. */
export function undBracket(
  strikes: number[],
  px: number | null,
): { lo: number; hi: number } | null {
  if (px == null || !Number.isFinite(px) || strikes.length < 2) return null;
  const ks = [...new Set(strikes)].sort((a, b) => a - b);
  let lo: number | null = null;
  let hi: number | null = null;
  for (const k of ks) {
    if (k <= px) lo = k;
    if (k >= px && hi == null) hi = k;
  }
  if (lo == null || hi == null) return null;
  if (lo !== hi) return { lo, hi };
  const i = ks.indexOf(lo);
  if (i >= 0 && i + 1 < ks.length) return { lo: ks[i], hi: ks[i + 1] };
  if (i > 0) return { lo: ks[i - 1], hi: ks[i] };
  return null;
}

/** 隐藏实值侧: 夹档 (或 ATM 回落) 两边都留; 购实值=strike<fwd, 沽实值=strike>fwd. */
export function hideItmSide(
  side: "call" | "put",
  strike: number,
  fwd: number | null,
  keep: number | readonly number[] | null,
  hide: boolean,
): boolean {
  if (!hide || fwd === null) return false;
  const kept = keep == null ? [] : typeof keep === "number" ? [keep] : keep;
  if (kept.includes(strike)) return false;
  return side === "call" ? strike < fwd : strike > fwd;
}

/** Full-width blue line between the two bracketing strikes; label is und last. */
function SpotUndRow({ px, rowRef }: { px: number; rowRef: Ref<HTMLTableRowElement> }) {
  const line = "absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-blue-500";
  return (
    <tr
      ref={rowRef}
      className="spot-und pointer-events-none !border-t-0 !bg-transparent hover:!bg-transparent hover:!shadow-none"
    >
      <td colSpan={4} className="relative !h-5 !p-0">
        <span className={line} />
      </td>
      <td className="relative !px-0 !py-0 text-center">
        <span className={line} />
        <span
          className="relative z-[1] inline-block bg-slate-950 px-1 text-[11px] font-semibold tabular-nums leading-none text-blue-400"
          title="当月期货现价"
        >
          {fmtPrice(px)}
        </span>
      </td>
      <td colSpan={4} className="relative !h-5 !p-0">
        <span className={line} />
      </td>
    </tr>
  );
}

/** 可见档购+沽持仓最大值, 给横条定标尺. */
export function maxOiVal(strikes: OvlabTQuoteStrike[]): number {
  let m = 0;
  for (const s of strikes) {
    const c = num(s.call.oi);
    const p = num(s.put.oi);
    if (c !== null && c > m) m = c;
    if (p !== null && p > m) m = p;
  }
  return m;
}

/** 持仓横条: Call 向右长(朝行权价), Put 向左长; 数字叠在条上. */
function OiBar({
  value, max, side, highlight, chg,
}: {
  value: number | null;
  max: number;
  side: "call" | "put";
  highlight?: boolean;
  chg?: number | null;
}) {
  const pct = value !== null && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const call = side === "call";
  return (
    <span className={cn("relative flex h-[1.05rem] w-[5.2rem] items-center overflow-hidden", call ? "justify-end" : "justify-start")}>
      <span
        className={cn(
          "absolute inset-y-0",
          call ? "right-0 rounded-l-[2px]" : "left-0 rounded-r-[2px]",
          highlight ? "bg-amber-300/25" : call ? "bg-red-400/15" : "bg-emerald-400/15",
        )}
        style={{ width: `${pct}%` }}
      />
      <span className={cn("relative z-[1] px-0.5 tabular-nums text-[10px]", highlight ? "text-amber-200" : "text-slate-200")}>
        {fmtOi(value)}
        {highlight && <span className="ml-0.5 text-[9px] text-amber-400/80">仓</span>}
        {chg != null && chg !== 0 && (
          <span className={cn("ml-0.5 text-[9px]", chg > 0 ? "text-red-400/70" : "text-emerald-400/70")}>
            {chg > 0 ? "+" : ""}{Math.round(chg)}
          </span>
        )}
      </span>
    </span>
  );
}

function fmtMove(up: number | null | undefined, dn: number | null | undefined): string | null {
  if (up == null && dn == null) return null;
  const u = up != null ? up * 100 : null;
  const d = dn != null ? dn * 100 : null;
  if (u != null && d != null && Math.abs(u + d) < 0.15) return `±${Math.abs(u).toFixed(1)}%`;
  const us = u != null ? fmtPct(u) : "-";
  const ds = d != null ? `${d.toFixed(1)}%` : "-";
  return `${us} / ${ds}`;
}

/** 单侧 4 格: 最新价贴行权价. call 右对齐 (IV Delta 持仓 最新价), put 左对齐反向. 整侧可点选. */
function SideCells({ s, itm, side, selected, maxOi, oiMax, atmIv, onPick }: {
  s: OvlabTQuoteSide;
  itm: boolean;
  side: "call" | "put";
  selected?: boolean;
  maxOi?: boolean;
  oiMax?: number;
  atmIv?: number | null;
  onPick?: () => void;
}) {
  const iv = ivOf(s);
  const delta = num(s.delta);
  const oi = num(s.oi);
  const oiChg = num(s.oiChg);
  const ivDiff = iv !== null && atmIv != null ? iv - atmIv : null;
  const bg = selected ? "bg-violet-500/15" : itm ? "bg-slate-800/40" : undefined;
  const alignCls = side === "call" ? "num" : "text-left tabular-nums";
  const pickCls = onPick ? "cursor-pointer hover:bg-violet-500/10" : undefined;
  const px = num(s.price);
  const chg = num(s.pct);
  const chgPct = chg !== null ? chg * 100 : null;
  const priceTd = (
    <td
      key="price"
      onClick={onPick}
      className={cn(alignCls, "text-[12px] font-medium text-slate-100", bg, pickCls)}
      title={chgPct !== null ? `相对昨理论价 ${fmtPct(chgPct, 2)}` : undefined}
    >
      {fmtPrice(px)}
      {chgPct !== null && (
        <span className={cn(
          "ml-0.5 text-[10px] font-normal tabular-nums",
          chgPct > 0 ? "text-red-400" : chgPct < 0 ? "text-emerald-400" : "text-slate-500",
        )}>
          {fmtPct(chgPct, Math.abs(chgPct) >= 100 ? 0 : 1)}
        </span>
      )}
    </td>
  );
  const ivTd = (
    <td
      key="iv"
      onClick={onPick}
      className={cn(
        alignCls, bg, pickCls,
        ivDiff !== null && ivDiff >= 1.5 ? "text-red-400" : ivDiff !== null && ivDiff <= -1.5 ? "text-emerald-400" : "text-violet-300/90",
      )}
      title={`买IV ${num(s.ivBid)?.toFixed(1) ?? "-"} / 卖IV ${num(s.ivAsk)?.toFixed(1) ?? "-"}${ivDiff != null ? ` · vs ATM ${ivDiff > 0 ? "+" : ""}${ivDiff.toFixed(1)}` : ""}`}
    >
      {iv !== null ? iv.toFixed(1) : <span className="nil">-</span>}
    </td>
  );
  const deltaTd = (
    <td key="delta" onClick={onPick} className={cn(alignCls, "text-slate-200", bg, pickCls)}>
      {delta !== null ? delta.toFixed(2) : "-"}
    </td>
  );
  const oiTd = (
    <td
      key="oi"
      onClick={onPick}
      className={cn("w-[5.4rem] min-w-[5.4rem] p-0.5", alignCls, bg, pickCls)}
      title={oiChg !== null ? `持仓 ${fmtOi(oi)}  变化 ${oiChg > 0 ? "+" : ""}${Math.round(oiChg)}` : `持仓 ${fmtOi(oi)}`}
    >
      <OiBar value={oi} max={oiMax ?? 0} side={side} highlight={maxOi} chg={oiChg} />
    </td>
  );
  return side === "call"
    ? <>{ivTd}{deltaTd}{oiTd}{priceTd}</>
    : <>{priceTd}{oiTd}{deltaTd}{ivTd}</>;
}

/** T 型报价: 行权价链 (理论价/IV/Delta/持仓横条) x 到期月. 数据 OpenVlab volatility-surface + Black-76.
 *  品种受控于驾驶舱 (点品种行联动); 点单侧格子发出 kind=option 联动日K/分时卡.
 *  换品种下拉出主力期货图; 换到期月且当前期权不在链上时才 ATM 购; kind=und 不覆盖.
 *  点顶栏当月期货价也切 kind=und. 标的最新: 新鲜 dataview, 当月=主力则 ctamap, 再 futPx. */
export function TQuotePanel({ d, product, onProduct, pick, onPickContract }: {
  d: DerivData;
  product?: string;
  onProduct?: (prod: string) => void;
  pick?: OptionPick | null;
  onPickContract?: (p: OptionPick) => void;
}) {
  const products = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ code: string; alias: string }> = [];
    for (const r of d.rows ?? []) {
      const code = undOfRow(r);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, alias: String(r.product_alias ?? code) });
    }
    return out;
  }, [d.rows]);

  const prod = product ?? "";
  useEffect(() => {
    if (prod || products.length === 0 || !onProduct) return;
    const preferred = d.rows?.find((r) => num(r.atmv_current) !== null);
    onProduct(undOfRow(preferred ?? {}) || products[0].code);
  }, [prod, products, d.rows, onProduct]);

  const [exp, setExp] = useState<string>("");
  const [strikeDir, setStrikeDir] = useState<"asc" | "desc">("desc");
  const [hideItm, setHideItm] = useState(() => storageGet("deriv.tquote.hideItm") !== "0");
  const toggleHideItm = () => {
    setHideItm((on) => {
      const next = !on;
      storageSet("deriv.tquote.hideItm", next ? "1" : "0");
      return next;
    });
  };
  useEffect(() => { setExp(""); }, [prod]);

  const tq = usePolling(
    () => (prod ? api.ovlabTQuote(prod) : Promise.resolve(null)),
    60_000,
    [prod],
    Boolean(prod),
  );
  const loading = tq.data === null && !tq.error;
  const expiries = tq.data?.expiries ?? [];
  const cur: OvlabTQuoteExpiry | undefined = expiries.find((e) => e.exp === exp) ?? expiries[0];
  const fwd = num(cur?.forward);
  const atm = cur?.atm ?? null;
  const mkt = useMemo(() => findRowByUnd(d.rows, prod), [d.rows, prod]);
  const futLast = num(cur?.futPx);
  const futPct = num(cur?.futPct);
  const undCode = String(cur?.und ?? "").trim().toUpperCase();
  const tick = d.ticks[undCode];
  const tickLast = tickFresh(tick) ? num(tick?.last) : null;
  const mainCode = mkt ? contractCode(mkt).toUpperCase() : "";
  const mktPx = undCode && mainCode === undCode ? num(mkt?.price) : null;
  let undPx = tickLast ?? mktPx ?? futLast;
  let undCtn: number | null = null;
  if (tickLast != null) {
    const basePx = mktPx ?? futLast;
    const baseCtn = mktPx != null ? num(mkt?.ctn) : futPct;
    undCtn = baseCtn;
    if (basePx != null && baseCtn != null && 1 + baseCtn !== 0) {
      const prev = basePx / (1 + baseCtn);
      if (prev !== 0) undCtn = (tickLast - prev) / prev;
    }
  } else if (mktPx != null) {
    undCtn = num(mkt?.ctn);
  } else {
    undCtn = futPct ?? num(mkt?.ctn);
  }
  const bracket = useMemo(
    () => undBracket((cur?.strikes ?? []).map((s) => s.strike), undPx),
    [cur, undPx],
  );
  const keepStrikes = useMemo(
    () => (bracket ? [bracket.lo, bracket.hi] : (atm != null ? [atm] : [])),
    [bracket, atm],
  );

  const maxCall = useMemo(() => {
    if (!cur) return null as number | null;
    let best = -1, k: number | null = null;
    for (const s of cur.strikes ?? []) {
      if (hideItmSide("call", s.strike, fwd, keepStrikes, hideItm)) continue;
      const v = num(s.call.oi);
      if (v !== null && v > best) { best = v; k = s.strike; }
    }
    return k;
  }, [cur, hideItm, fwd, keepStrikes]);
  const maxPut = useMemo(() => {
    if (!cur) return null as number | null;
    let best = -1, k: number | null = null;
    for (const s of cur.strikes ?? []) {
      if (hideItmSide("put", s.strike, fwd, keepStrikes, hideItm)) continue;
      const v = num(s.put.oi);
      if (v !== null && v > best) { best = v; k = s.strike; }
    }
    return k;
  }, [cur, hideItm, fwd, keepStrikes]);

  const rows = useMemo(() => {
    if (!cur) return [];
    const list = (cur.strikes ?? []).slice();
    list.sort((a, b) => strikeDir === "desc" ? b.strike - a.strike : a.strike - b.strike);
    return list;
  }, [cur, strikeDir]);
  const oiMax = useMemo(() => {
    let m = 0;
    for (const s of rows) {
      if (!hideItmSide("call", s.strike, fwd, keepStrikes, hideItm)) {
        const c = num(s.call.oi);
        if (c !== null && c > m) m = c;
      }
      if (!hideItmSide("put", s.strike, fwd, keepStrikes, hideItm)) {
        const p = num(s.put.oi);
        if (p !== null && p > m) m = p;
      }
    }
    return m;
  }, [rows, hideItm, fwd, keepStrikes]);
  const prodAlias = products.find((p) => p.code === prod)?.alias ?? prod;
  const fwdYd = num(cur?.forwardYd);
  const fwdChg = fwd !== null && fwdYd !== null && fwdYd !== 0 ? ((fwd - fwdYd) / fwdYd) * 100 : null;
  const atmIvChg = cur?.atmIv != null && cur?.atmIvYd != null ? cur.atmIv - cur.atmIvYd : null;
  const skew = useMemo(() => (cur ? ivSkew(cur.strikes ?? [], fwd) : null), [cur, fwd]);
  const move = fmtMove(cur?.moveUp, cur?.moveDn);

  const emitPick = (code: string | undefined) => {
    if (!code || !onPickContract) return;
    onPickContract({ kind: "option", code, und: cur?.und ?? "", name: optionName(code), expiry: cur?.expiryDate });
  };

  useEffect(() => {
    if (!cur?.strikes?.length || !onPickContract) return;
    if (pick?.kind === "und") return;
    const inChain = cur.strikes.some((s) => s.callCode === pick?.code || s.putCode === pick?.code);
    if (inChain) return;
    const atm = cur.strikes.find((s) => s.strike === cur.atm) ?? cur.strikes[cur.strikes.length >> 1];
    if (!atm?.callCode) return;
    onPickContract({ kind: "option", code: atm.callCode, und: cur.und ?? "", name: optionName(atm.callCode), expiry: cur.expiryDate });
  }, [prod, cur?.exp, cur?.und, pick?.code, pick?.kind, onPickContract]);

  const spotRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    spotRowRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [prod, cur?.exp, bracket?.lo, bracket?.hi]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative z-20 flex shrink-0 items-center gap-1 px-1.5 pt-1">
        <ProdSearchSelect
          value={prod}
          options={products.map((p) => ({ value: p.code, label: `${p.alias} ${p.code}` }))}
          onChange={(v) => onProduct?.(v)}
        />
        {undPx !== null && (
          <button
            type="button"
            className="flex shrink-0 items-baseline gap-1.5 px-1"
            title="看当月期货日K/分时"
            disabled={!cur?.und || !onPickContract}
            onClick={() => {
              if (!cur?.und || !onPickContract) return;
              onPickContract({ kind: "und", code: cur.und, und: cur.und, name: cur.und });
            }}
          >
            <span className={cn(
              "text-[17px] font-semibold tabular-nums leading-none",
              undCtn != null && undCtn > 0 ? "text-red-400"
                : undCtn != null && undCtn < 0 ? "text-emerald-400"
                  : "text-slate-50",
            )}>
              {fmtPrice(undPx)}
            </span>
            <span className="text-[13px] font-medium leading-none">
              <CtnText value={undCtn} />
            </span>
          </button>
        )}
        <span className="min-w-0 flex-1" />
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-[10px] text-slate-500">隐藏实值</span>
          <button
            type="button"
            role="switch"
            aria-checked={hideItm}
            title="隐藏实值侧, 现价夹档两边都留"
            onClick={toggleHideItm}
            className={cn(
              "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
              hideItm ? "bg-primary/70" : "bg-slate-700/70",
            )}
          >
            <span
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform",
                hideItm ? "translate-x-[12px]" : "translate-x-[2px]",
              )}
            />
          </button>
        </span>
        {cur?.lastTime && (
          <span
            className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[12px] font-medium tabular-nums text-primary"
            title={`上游更新 ${cur.lastTime}`}
          >
            更新 {cur.lastTime.slice(11, 19) || cur.lastTime}
          </span>
        )}
      </div>

      {cur && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-1.5 py-1 text-[11px] tabular-nums text-slate-400">
          <span>
            远期 <span className="text-slate-300">{fwd !== null ? fmtPrice(fwd) : "-"}</span>
            {fwdChg !== null && (
              <span className={cn("ml-0.5", fwdChg > 0 ? "text-red-400" : fwdChg < 0 ? "text-emerald-400" : "")}>
                {fmtPct(fwdChg, 2)}
              </span>
            )}
          </span>
          <span>
            ATM隐波 <span className="text-violet-300">{cur.atmIv?.toFixed(1) ?? "-"}</span>
            {atmIvChg !== null && (
              <span className={cn("ml-0.5", atmIvChg > 0 ? "text-red-400" : atmIvChg < 0 ? "text-emerald-400" : "")}>
                {atmIvChg > 0 ? "+" : ""}{atmIvChg.toFixed(1)}
              </span>
            )}
          </span>
          <span title="Put/Call 持仓比">
            PCR <span className="text-slate-300">{cur.pcr?.toFixed(2) ?? "-"}</span>
          </span>
          <span title="购/沽总持仓">
            持仓 <span className="text-slate-300">{fmtOi(cur.sumOiCall)}</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">{fmtOi(cur.sumOiPut)}</span>
          </span>
          {skew !== null && (
            <span title="虚值沽IV - 虚值购IV, 正=沽更贵">
              偏度 <span className={cn(skew > 0.5 ? "text-amber-300" : skew < -0.5 ? "text-primary" : "text-slate-300")}>
                {skew > 0 ? "沽+" : skew < 0 ? "购+" : ""}{Math.abs(skew).toFixed(1)}
              </span>
            </span>
          )}
          {move && <span>预期 <span className="text-slate-300">{move}</span></span>}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {cur && (
          <div className="flex h-[240px] shrink-0 flex-col lg:h-auto lg:w-[30%] lg:min-h-0 lg:min-w-[200px] lg:max-w-[380px]">
            <IvSmileChart
              smileTd={cur.theoSmile}
              smileYd={cur.theoSmileYd}
              strikes={cur.strikes ?? []}
              displayLo={num(cur.displayLo)}
              displayHi={num(cur.displayHi)}
              spot={fwd}
            />
            <IvTermChart
              expiries={expiries}
              onPickExp={setExp}
            />
          </div>
        )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-[11px] text-slate-500">更新中…</div>
        )}
        {!loading && !cur && <CellEmpty text={tq.error ? "未取到" : "暂无数据"} />}
        {cur && (
          <table className="data-table dense text-[11px]">
            <thead>
              <tr>
                <th colSpan={4} className="text-center text-[12px] font-semibold text-red-400">看涨期权Call</th>
                <th rowSpan={2} className="text-center align-middle font-semibold text-slate-200">
                  <SortableHd
                    k="strike"
                    label="行权价"
                    sort={{ key: "strike", dir: strikeDir }}
                    onSort={() => setStrikeDir((d) => (d === "desc" ? "asc" : "desc"))}
                    className="justify-center"
                    title="点此按行权价升/降序"
                  />
                </th>
                <th colSpan={4} className="text-center text-[12px] font-semibold text-emerald-400">看跌期权Put</th>
              </tr>
              <tr>
                <th className="num !top-5 font-semibold text-slate-200">IV</th>
                <th className="num !top-5 font-semibold text-slate-200">Delta</th>
                <th className="num !top-5 font-semibold text-slate-200">持仓</th>
                <th className="num !top-5 font-semibold text-slate-200">最新价</th>
                <th className="!top-5 font-semibold text-slate-200">最新价</th>
                <th className="!top-5 font-semibold text-slate-200">持仓</th>
                <th className="!top-5 font-semibold text-slate-200">Delta</th>
                <th className="!top-5 font-semibold text-slate-200">IV</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const callItm = fwd !== null && s.strike < fwd;
                const putItm = fwd !== null && s.strike > fwd;
                const hideCall = hideItmSide("call", s.strike, fwd, keepStrikes, hideItm);
                const hidePut = hideItmSide("put", s.strike, fwd, keepStrikes, hideItm);
                const mny = fwd !== null && fwd !== 0 ? ((s.strike / fwd) - 1) * 100 : null;
                const after = Boolean(
                  bracket && undPx != null
                  && s.strike === (strikeDir === "desc" ? bracket.hi : bracket.lo),
                );
                return (
                  <Fragment key={s.strike}>
                  <tr>
                    {hideCall ? (
                      <td colSpan={4} className="bg-slate-950/30" />
                    ) : (
                      <SideCells
                        s={s.call}
                        itm={callItm}
                        side="call"
                        selected={pick?.kind === "option" && pick.code === s.callCode}
                        maxOi={maxCall !== null && s.strike === maxCall}
                        oiMax={oiMax}
                        atmIv={cur.atmIv}
                        onPick={s.callCode && onPickContract ? () => emitPick(s.callCode) : undefined}
                      />
                    )}
                    <td
                      className="text-center text-[12px] font-medium tabular-nums text-slate-200"
                      title={mny !== null ? `相对远期 ${fmtPct(mny, 2)}` : undefined}
                    >
                      {fmtStrike(s.strike)}
                    </td>
                    {hidePut ? (
                      <td colSpan={4} className="bg-slate-950/30" />
                    ) : (
                      <SideCells
                        s={s.put}
                        itm={putItm}
                        side="put"
                        selected={pick?.kind === "option" && pick.code === s.putCode}
                        maxOi={maxPut !== null && s.strike === maxPut}
                        oiMax={oiMax}
                        atmIv={cur.atmIv}
                        onPick={s.putCode && onPickContract ? () => emitPick(s.putCode) : undefined}
                      />
                    )}
                  </tr>
                  {after && <SpotUndRow px={undPx!} rowRef={spotRowRef} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {expiries.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-1.5 py-1.5">
          {expiries.map((e) => (
            <button
              key={e.exp}
              type="button"
              onClick={() => setExp(e.exp)}
              className={cn(
                "flex shrink-0 flex-col items-start rounded-md px-1.5 py-1 text-left tabular-nums",
                cur?.exp === e.exp
                  ? "bg-primary/20 text-primary ring-1 ring-primary/40"
                  : "bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-slate-100",
              )}
              title={`到期日 ${e.expiryDate ?? "-"}`}
            >
              <span className="text-[11px] font-medium leading-tight">{expChipTitle(prodAlias, e.exp)}</span>
              <span className={cn("text-[10px] leading-tight", cur?.exp === e.exp ? "text-primary/80" : "text-slate-500")}>
                {expMd(e.expiryDate)} 剩{e.dte != null && Number.isFinite(e.dte) ? Math.round(e.dte) : "-"}天
              </span>
            </button>
          ))}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
