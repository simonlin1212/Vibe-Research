import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, ShieldCheck, RefreshCw, Loader2, Trash2, AlertCircle, LineChart, Swords } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { StockSearchInput } from "@/components/ui/StockSearchInput";
import { api, ApiError, type PortfolioData, type Holding, type MarketTotal } from "@/lib/api";
import { cn } from "@/lib/utils";

const MKT_LABEL: Record<string, string> = { A: "A股", HK: "港股", US: "美股", KR: "韩股", FD: "场外基金" };
const MKT_CCY: Record<string, string> = { A: "人民币", HK: "港元", US: "美元", KR: "韩元", FD: "人民币" };

const REFRESH_MS = 30 * 60 * 1000; // 每半小时自动刷新
const pnlColor = (v: number) => (v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-muted-foreground");
const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
// 单价类（现价/成本/清仓价）最多 4 位小数：ETF/基金常见 3-4 位，截断成 2 位会与市值/盈亏对不上账
const fmtPx = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

export function Portfolio() {
  const navigate = useNavigate();
  const [data, setData] = useState<PortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState("");
  const [selMarket, setSelMarket] = useState("");
  const [selName, setSelName] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [adding, setAdding] = useState(false);
  // 场外基金：选中后拉最新净值，用户输"持有收益"反算成本价
  const [navPrice, setNavPrice] = useState<number | null>(null);
  const [holdProfit, setHoldProfit] = useState("");
  // 清仓录入
  const [cCode, setCCode] = useState("");
  const [cSelMarket, setCSelMarket] = useState("");
  const [cDate, setCDate] = useState("");
  const [cPrice, setCPrice] = useState("");
  const [cShares, setCShares] = useState("");
  const [cCost, setCCost] = useState("");
  const [closing, setClosing] = useState(false);
  const [cHoldProfit, setCHoldProfit] = useState("");

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setData(manual ? await api.refreshPortfolio() : await api.portfolio());
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), REFRESH_MS); // 每半小时自动刷新
    return () => clearInterval(t);
  }, [load]);

  // 选中场外基金时拉最新净值（用于"持有收益"反算成本价）
  const fetchNav = async (c: string): Promise<number | null> => {
    try {
      const q = await api.quote(`FD:${c}`);
      return q[c]?.price ?? null;  // 后端返回 key 是裸代码（无 FD: 前缀）
    } catch { return null; }
  };

  // 乐观更新汇总：对指定 market 增减 mv/cost/pnl，重算 pnl_pct（添加/删除时不拉行情，本地加减）
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const recomputeTotals = (totals: MarketTotal[], market: string, dMv: number, dCost: number, dPnl: number): MarketTotal[] => {
    const idx = totals.findIndex(t => t.market === market);
    if (idx < 0) {
      return [...totals, { market, market_value: r2(dMv), cost: r2(dCost), pnl: r2(dPnl), pnl_pct: dCost ? r2(dPnl / dCost * 100) : 0 }];
    }
    return totals.map((t, i) => {
      if (i !== idx) return t;
      const mv = t.market_value + dMv, cost = t.cost + dCost, pnl = t.pnl + dPnl;
      return { ...t, market_value: r2(mv), cost: r2(cost), pnl: r2(pnl), pnl_pct: cost ? r2(pnl / cost * 100) : 0 };
    });
  };

  // 场外基金：成本价 = 最新净值 - 持有收益 / 数量
  const computedCost = (() => {
    if (selMarket !== "FD" || !navPrice) return null;
    const s = parseFloat(shares), p = parseFloat(holdProfit);
    if (!(s > 0) || !Number.isFinite(p)) return null;
    return navPrice - p / s;
  })();

  const add = async () => {
    if (!code.trim()) { setErr("请输入或选择股票代码"); return; }
    const s = parseFloat(shares);
    if (!(s > 0)) { setErr("数量须大于 0"); return; }
    // 场外基金用"持有收益"反算成本价；其他市场直接用成本价输入
    let c: number;
    if (selMarket === "FD") {
      if (!navPrice) { setErr("正在获取最新净值，请稍候"); return; }
      const p = parseFloat(holdProfit);
      if (!Number.isFinite(p)) { setErr("持有收益请填数字（可为负）"); return; }
      c = navPrice - p / s;
    } else {
      c = parseFloat(cost);
      if (!Number.isFinite(c)) { setErr("成本价请填数字（可为负）"); return; }
    }
    const mkt = selMarket || "A";
    const codeTrim = code.trim();
    setAdding(true); setErr(null);
    try {
      // 后端只写盘返回纯持仓列表（不拉行情）；前端乐观更新，等轮询时统一校准
      const baseList = await api.addHolding(codeTrim, s, c, mkt);
      const base = baseList.find(b => b.code === codeTrim);
      const finalShares = base?.shares ?? s;
      const finalCost = base?.cost ?? c;
      setData(prev => {
        if (!prev) return prev;
        const oldRow = prev.holdings.find(h => h.code === codeTrim);
        // price：FD 用已拉净值；其余保留旧行已校准的现价（无则 0，待轮询补）
        const price = mkt === "FD" ? (navPrice ?? oldRow?.price ?? 0) : (oldRow?.price ?? 0);
        const mv = price * finalShares;
        const cv = finalCost * finalShares;
        const pnl = mv - cv;
        const newRow: Holding = {
          code: codeTrim, market: mkt, name: oldRow?.name || selName || codeTrim,
          price, shares: finalShares, cost: finalCost,
          market_value: r2(mv), pnl: r2(pnl), pnl_pct: cv ? r2(pnl / cv * 100) : 0,
        };
        // 同代码加仓：替换已有行（加权成本由后端算好）；否则追加
        const holdings = oldRow
          ? prev.holdings.map(h => h.code === codeTrim ? newRow : h)
          : [...prev.holdings, newRow];
        // 同代码加仓：先减去旧行汇总，再累加新行
        let totals = prev.totals;
        if (oldRow) {
          totals = recomputeTotals(totals, oldRow.market, -oldRow.market_value, -oldRow.cost * oldRow.shares, -oldRow.pnl);
        }
        totals = recomputeTotals(totals, mkt, mv, cv, pnl);
        return { ...prev, holdings, totals };
      });
      setCode(""); setSelMarket(""); setSelName(""); setShares(""); setCost("");
      setNavPrice(null); setHoldProfit("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (c: string) => {
    try {
      await api.removeHolding(c);
      setData(prev => {
        if (!prev) return prev;
        const row = prev.holdings.find(h => h.code === c);
        if (!row) return prev;
        const holdings = prev.holdings.filter(h => h.code !== c);
        const totals = recomputeTotals(prev.totals, row.market, -row.market_value, -row.cost * row.shares, -row.pnl);
        return { ...prev, holdings, totals };
      });
    } catch { /* ignore */ }
  };

  // 清仓录入：场外基金 买入成本 = 清仓价 - 持有收益 / 股数
  const cComputedCost = (() => {
    if (cSelMarket !== "FD") return null;
    const p = parseFloat(cPrice), s = parseFloat(cShares), hp = parseFloat(cHoldProfit);
    if (!(p > 0) || !(s > 0) || !Number.isFinite(hp)) return null;
    return p - hp / s;
  })();

  const addClose = async () => {
    if (!cCode.trim()) { setErr("清仓记录：请输入或选择股票代码"); return; }
    if (!cDate) { setErr("请选清仓日期"); return; }
    const p = parseFloat(cPrice), s = parseFloat(cShares);
    if (!(p > 0) || !(s > 0)) { setErr("清仓价 / 股数须大于 0"); return; }
    // 场外基金用"持有收益"反算买入成本；其他市场直接用成本输入
    let c: number;
    if (cSelMarket === "FD") {
      const hp = parseFloat(cHoldProfit);
      if (!Number.isFinite(hp)) { setErr("持有收益请填数字（可为负）"); return; }
      c = p - hp / s;
    } else {
      c = parseFloat(cCost);
      if (!Number.isFinite(c)) { setErr("买入成本请填数字（可为负）"); return; }
    }
    setClosing(true); setErr(null);
    try {
      setData(await api.closePosition(cCode.trim(), cDate, p, s, c, cSelMarket));
      setCCode(""); setCSelMarket(""); setCDate(""); setCPrice(""); setCShares(""); setCCost("");
      setCHoldProfit("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "添加清仓记录失败");
    } finally {
      setClosing(false);
    }
  };

  const removeClosed = async (i: number) => {
    try { setData(await api.removeClosed(i)); } catch { /* ignore */ }
  };

  const holdings = data?.holdings || [];
  const totals = data?.totals || [];
  const closed = data?.closed || [];

  const aiContext = holdings.length
    ? `我的持仓（本地数据，按市场分组）：\n` +
      holdings.map((h) => `${MKT_LABEL[h.market] || h.market} ${h.name}(${h.code}) ${h.shares}股 成本${h.cost} 现价${h.price} 浮盈${h.pnl}(${h.pnl_pct}%)`).join("\n") +
      (totals.length ? `\n汇总（按市场）：\n` + totals.map((t) => `${MKT_LABEL[t.market] || t.market} 市值${t.market_value} 成本${t.cost} 浮盈${t.pnl}(${t.pnl_pct}%)`).join("\n") : "")
    : "我的持仓：暂无记录。";

  return (
    <div>
      <PageHeader
        title="我的持仓"
        subtitle="自己录、存在本地，实时看浮动盈亏"
        actions={
          <div className="flex items-center gap-2">
            {holdings.length > 0 && (
              <AskAiButton context={aiContext} label="让 AI 看我的持仓"
                suggestions={["我的持仓集中在哪些方向", "结构上有什么风险", "帮我梳理一下"]} />
            )}
            <button onClick={() => load(true)} disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新
            </button>
          </div>
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>持仓<b className="text-foreground">只存在你本地</b>，不上传、不进仓库。行情每半小时自动刷新，也可手动刷新。本产品不提供标的、不给建议，只帮你把自己的账理清楚。</span>
      </div>

      {/* 汇总（按市场分组，各自币种独立，不折算汇率） */}
      {totals.length > 0 && (
        <div className="mb-4 space-y-3">
          {totals.map((t) => (
            <div key={t.market} className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{MKT_LABEL[t.market] || t.market}</span>
                <span>{MKT_CCY[t.market] || ""}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "市值", v: fmt(t.market_value), c: "text-foreground" },
                  { k: "成本", v: fmt(t.cost), c: "text-foreground" },
                  { k: "浮动盈亏", v: (t.pnl > 0 ? "+" : "") + fmt(t.pnl), c: pnlColor(t.pnl) },
                  { k: "盈亏比例", v: (t.pnl_pct > 0 ? "+" : "") + t.pnl_pct + "%", c: pnlColor(t.pnl) },
                ].map((m) => (
                  <div key={m.k}>
                    <p className="text-xs text-muted-foreground">{m.k}</p>
                    <p className={cn("mt-0.5 font-mono text-base font-bold", m.c)}>{m.v}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 录入 */}
      <GlassCard className="relative z-20 mb-4">
        <h3 className="mb-3 text-sm font-semibold">添加持仓</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股票代码</label>
            <StockSearchInput
              value={code}
              onChange={(v) => { setCode(v); if (selMarket) { setSelMarket(""); setSelName(""); setNavPrice(null); setHoldProfit(""); } }}
              onSelect={async (s) => {
                setSelMarket(s.market);
                setSelName(s.name);
                setNavPrice(null);
                setHoldProfit("");
                if (s.market === "FD") {
                  const nav = await fetchNav(s.code);
                  setNavPrice(nav);
                }
              }}
              placeholder="代码 / 拼音 / 中文"
              className="w-44 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{selMarket === "FD" ? "份额" : "数量（股）"}</label>
            <input value={shares} onChange={(e) => setShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          {selMarket === "FD" ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  持有收益{navPrice != null ? `（最新净值 ${fmtPx(navPrice)}）` : navPrice === null ? "（取净值中…）" : ""}
                </label>
                <input value={holdProfit} onChange={(e) => setHoldProfit(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="如 120.50，可负"
                  className="w-36 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
              </div>
              {computedCost != null && (
                <div className="pb-2 text-xs text-muted-foreground">
                  反算成本价 <span className="font-mono text-foreground">{fmtPx(computedCost)}</span>
                </div>
              )}
            </>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">成本价</label>
              <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="如 12.5，可负"
                className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
            </div>
          )}
          <button onClick={add} disabled={adding}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 添加
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/60">同一代码再次添加会按加权平均成本合并（加仓）。</p>
      </GlassCard>

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {/* 持仓表 */}
      <GlassCard glow>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">持仓明细</h3>
          {data?.updated && <span className="text-xs text-muted-foreground/60">更新于 {data.updated}</span>}
        </div>
        {holdings.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/60">还没有持仓记录，用上面的表单添加一笔。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "现价", "数量", "成本", "市值", "浮动盈亏", "盈亏%", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.code} className="border-b border-border/30">
                    <td className="px-2 py-2.5">
                      <span className="font-medium">{h.name}</span>
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{h.code}</span>
                      {h.market && h.market !== "A" && (
                        <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{MKT_LABEL[h.market] || h.market}</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 font-mono">{fmtPx(h.price)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmt(h.shares)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmtPx(h.cost)}</td>
                    <td className="px-2 py-2.5 font-mono">{fmt(h.market_value)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(h.pnl))}>{h.pnl > 0 ? "+" : ""}{fmt(h.pnl)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(h.pnl))}>{h.pnl_pct > 0 ? "+" : ""}{h.pnl_pct}%</td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {/* 个股数据 / 多空辩论仅 A 股支持（端点走 A 股数据源）；港美股/韩股/场外基金禁用 */}
                        {h.market === "A" && (
                          <button onClick={() => navigate(`/stock-data?code=${encodeURIComponent(h.code)}`)}
                            className="text-muted-foreground/50 hover:text-primary" title="个股数据">
                            <LineChart className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {h.market === "A" && (
                          <button onClick={() => navigate(`/debate?code=${encodeURIComponent(h.code)}`)}
                            className="text-muted-foreground/50 hover:text-primary" title="多空辩论">
                            <Swords className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button onClick={() => remove(h.code)} className="text-muted-foreground/50 hover:text-destructive" title="删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 清仓录入 */}
      <GlassCard className="relative z-20 mb-4 mt-6">
        <h3 className="mb-3 text-sm font-semibold">添加清仓记录</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股票代码</label>
            <StockSearchInput
              value={cCode}
              onChange={(v) => { setCCode(v); if (cSelMarket) { setCSelMarket(""); setCHoldProfit(""); } }}
              onSelect={(s) => { setCSelMarket(s.market); setCHoldProfit(""); }}
              placeholder="代码 / 拼音 / 中文"
              className="w-44 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">清仓日期</label>
            <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)}
              className="rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{cSelMarket === "FD" ? "清仓净值" : "清仓价"}</label>
            <input value={cPrice} onChange={(e) => setCPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="卖出价"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{cSelMarket === "FD" ? "份额" : "股数"}</label>
            <input value={cShares} onChange={(e) => setCShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          {cSelMarket === "FD" ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">持有收益</label>
                <input value={cHoldProfit} onChange={(e) => setCHoldProfit(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="如 120.50，可负"
                  className="w-32 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
              </div>
              {cComputedCost != null && (
                <div className="pb-2 text-xs text-muted-foreground">
                  反算买入成本 <span className="font-mono text-foreground">{fmtPx(cComputedCost)}</span>
                </div>
              )}
            </>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">买入成本</label>
              <input value={cCost} onChange={(e) => setCCost(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="成本价，可负"
                className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
            </div>
          )}
          <button onClick={addClose} disabled={closing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 记录
          </button>
        </div>
      </GlassCard>

      {/* 已清仓列表 */}
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">已清仓</h3>
        {closed.length > 0 && data && (
          <span className="text-sm">
            已实现盈亏合计 <b className={cn("font-mono", pnlColor(data.realized_pnl))}>{data.realized_pnl > 0 ? "+" : ""}{fmt(data.realized_pnl)}</b>
          </span>
        )}
      </div>
      <GlassCard>
        {closed.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground/60">还没有清仓记录。卖出后在上面记一笔，作为已实现盈亏的历史。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "清仓日期", "清仓价", "股数", "成本", "已实现盈亏", "盈亏%", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map((c, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="px-2 py-2.5">
                      <span className="font-medium">{c.name}</span>
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{c.code}</span>
                      {c.market && c.market !== "A" && (
                        <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{MKT_LABEL[c.market] || c.market}</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{c.date}</td>
                    <td className="px-2 py-2.5 font-mono">{fmtPx(c.price)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmt(c.shares)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmtPx(c.cost)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.pnl > 0 ? "+" : ""}{fmt(c.pnl)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.pnl_pct > 0 ? "+" : ""}{c.pnl_pct}%</td>
                    <td className="px-2 py-2.5">
                      <button onClick={() => removeClosed(i)} className="text-muted-foreground/50 hover:text-destructive" title="删除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
