import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Plus, ShieldCheck, RefreshCw, Loader2, Trash2, AlertCircle, FlaskConical } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { api, ApiError, type PortfolioData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { REFRESH_MS, fmt, fmtPx, pnlColor } from "@/components/portfolio/format";

export function StockPortfolio() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [adding, setAdding] = useState(false);
  const [cCode, setCCode] = useState("");
  const [cDate, setCDate] = useState("");
  const [cPrice, setCPrice] = useState("");
  const [cShares, setCShares] = useState("");
  const [cCost, setCCost] = useState("");
  const [closing, setClosing] = useState(false);

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
    const t = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const add = async () => {
    if (!/^\d{6}$/.test(code.trim())) { setErr("请输入 6 位股票代码"); return; }
    const s = parseFloat(shares), c = parseFloat(cost);
    if (!(s > 0) || !Number.isFinite(c)) { setErr("数量须大于 0，成本价请填数字（可为负）"); return; }
    setAdding(true); setErr(null);
    try {
      setData(await api.addHolding(code.trim(), s, c));
      setCode(""); setShares(""); setCost("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (c: string) => {
    try { setData(await api.removeHolding(c)); } catch { /* ignore */ }
  };

  const addClose = async () => {
    if (!/^\d{6}$/.test(cCode.trim())) { setErr("清仓记录：请输入 6 位代码"); return; }
    const p = parseFloat(cPrice), s = parseFloat(cShares), c = parseFloat(cCost);
    if (!cDate) { setErr("请选清仓日期"); return; }
    if (!(p > 0) || !(s > 0) || !Number.isFinite(c)) { setErr("清仓价 / 股数须大于 0，成本请填数字（可为负）"); return; }
    setClosing(true); setErr(null);
    try {
      setData(await api.closePosition(cCode.trim(), cDate, p, s, c));
      setCCode(""); setCDate(""); setCPrice(""); setCShares(""); setCCost("");
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
  const totals = data?.totals;
  const closed = data?.closed || [];

  const aiContext = totals
    ? `我的持仓（本地数据）：\n` + holdings.map((h) => `${h.name}(${h.code}) ${h.shares}股 成本${h.cost} 现价${h.price} 浮盈${h.pnl}(${h.pnl_pct}%)`).join("\n") +
      `\n汇总：市值${totals.market_value} 总浮盈${totals.pnl}(${totals.pnl_pct}%)`
    : "我的持仓：暂无记录。";

  return (
    <div>
      <div className="mb-4 flex items-center justify-end gap-2">
        {holdings.length > 0 && (
          <>
            <Link
              to={`/backtest?codes=${holdings.map((h) => h.code).filter(Boolean).slice(0, 100).join(",")}&from=portfolio&autostart=1`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20"
            >
              <FlaskConical className="h-4 w-4" />
              回测这些
            </Link>
            <AskAiButton context={aiContext} label="让 AI 看我的持仓" scopeKey="stock"
              suggestions={["我的持仓集中在哪些方向", "结构上有什么风险", "帮我梳理一下"]} />
          </>
        )}
        <button onClick={() => load(true)} disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          刷新
        </button>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>持仓<b className="text-foreground">只存在你本地</b>，不上传、不进仓库。行情每半小时自动刷新，也可手动刷新。本产品不提供标的、不给建议，只帮你把自己的账理清楚。</span>
      </div>

      {totals && holdings.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: "总市值", v: fmt(totals.market_value), c: "text-foreground" },
            { k: "总成本", v: fmt(totals.cost), c: "text-foreground" },
            { k: "浮动盈亏", v: (totals.pnl > 0 ? "+" : "") + fmt(totals.pnl), c: pnlColor(totals.pnl) },
            { k: "盈亏比例", v: (totals.pnl_pct > 0 ? "+" : "") + totals.pnl_pct + "%", c: pnlColor(totals.pnl) },
          ].map((m) => (
            <GlassCard key={m.k} className="p-3">
              <p className="text-xs text-muted-foreground">{m.k}</p>
              <p className={cn("mt-1 font-mono text-lg font-bold", m.c)}>{m.v}</p>
            </GlassCard>
          ))}
        </div>
      )}

      <GlassCard className="mb-4">
        <h3 className="mb-3 text-sm font-semibold">添加持仓</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">股票代码</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位代码"
              className="field-input w-28" />
          </div>
          <div>
            <label className="field-label">数量（股）</label>
            <input value={shares} onChange={(e) => setShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="field-input w-28" />
          </div>
          <div>
            <label className="field-label">成本价</label>
            <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="如 12.5，可负"
              className="field-input w-28" />
          </div>
          <button onClick={add} disabled={adding}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary btn-press ring-1 ring-primary/20 hover:bg-primary/25 disabled:opacity-50">
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

      <GlassCard glow>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">持仓明细</h3>
          {data?.updated && <span className="text-xs text-muted-foreground/60">更新于 {data.updated}</span>}
        </div>
        {holdings.length === 0 ? (
          <EmptyState title="还没有持仓记录" description="用上面的表单添加一笔，行情会自动刷新。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th className="num">现价</th>
                  <th className="num">数量</th>
                  <th className="num">成本</th>
                  <th className="num">市值</th>
                  <th className="num">浮动盈亏</th>
                  <th className="num">盈亏%</th>
                  <th className="act" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.code}>
                    <td className="name">
                      {h.name}
                      <span className="code ml-1.5">{h.code}</span>
                    </td>
                    <td className="num font-mono">{fmtPx(h.price)}</td>
                    <td className="num font-mono text-muted-foreground">{fmt(h.shares)}</td>
                    <td className="num font-mono text-muted-foreground">{fmtPx(h.cost)}</td>
                    <td className="num font-mono">{fmt(h.market_value)}</td>
                    <td className={cn("num font-mono", pnlColor(h.pnl))}>{h.pnl > 0 ? "+" : ""}{fmt(h.pnl)}</td>
                    <td className={cn("num font-mono", pnlColor(h.pnl))}>{h.pnl_pct > 0 ? "+" : ""}{h.pnl_pct}%</td>
                    <td className="act">
                      <button type="button" onClick={() => remove(h.code)} className="btn-press text-muted-foreground/50 hover:text-destructive" title="删除">
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

      <GlassCard className="mb-4 mt-6">
        <h3 className="mb-3 text-sm font-semibold">添加清仓记录</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">股票代码</label>
            <input value={cCode} onChange={(e) => setCCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位代码"
              className="field-input w-24" />
          </div>
          <div>
            <label className="field-label">清仓日期</label>
            <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)}
              className="field-input" />
          </div>
          <div>
            <label className="field-label">清仓价</label>
            <input value={cPrice} onChange={(e) => setCPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="卖出价"
              className="field-input w-24" />
          </div>
          <div>
            <label className="field-label">股数</label>
            <input value={cShares} onChange={(e) => setCShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="field-input w-24" />
          </div>
          <div>
            <label className="field-label">买入成本</label>
            <input value={cCost} onChange={(e) => setCCost(e.target.value.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, ""))} placeholder="成本价，可负"
              className="field-input w-24" />
          </div>
          <button onClick={addClose} disabled={closing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary btn-press ring-1 ring-primary/20 hover:bg-primary/25 disabled:opacity-50">
            {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 记录
          </button>
        </div>
      </GlassCard>

      <CollapsibleSection
        title="已清仓"
        storageKey="stock.closed"
        defaultOpen={false}
        summary={
          closed.length > 0
            ? `${closed.length} 笔${data ? ` · 已实现 ${data.realized_pnl > 0 ? "+" : ""}${fmt(data.realized_pnl)}` : ""}`
            : "暂无记录"
        }
      >
        <GlassCard>
          {closed.length === 0 ? (
            <EmptyState
              title="还没有清仓记录"
              description="卖出后在上面记一笔，作为已实现盈亏的历史。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>清仓日期</th>
                    <th className="num">清仓价</th>
                    <th className="num">股数</th>
                    <th className="num">成本</th>
                    <th className="num">已实现盈亏</th>
                    <th className="num">盈亏%</th>
                    <th className="act" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {closed.map((c, i) => (
                    <tr key={i}>
                      <td className="name">
                        {c.name}
                        <span className="code ml-1.5">{c.code}</span>
                      </td>
                      <td className="font-mono text-muted-foreground">{c.date}</td>
                      <td className="num font-mono">{fmtPx(c.price)}</td>
                      <td className="num font-mono text-muted-foreground">{fmt(c.shares)}</td>
                      <td className="num font-mono text-muted-foreground">{fmtPx(c.cost)}</td>
                      <td className={cn("num font-mono", pnlColor(c.pnl))}>{c.pnl > 0 ? "+" : ""}{fmt(c.pnl)}</td>
                      <td className={cn("num font-mono", pnlColor(c.pnl))}>{c.pnl_pct > 0 ? "+" : ""}{c.pnl_pct}%</td>
                      <td className="act">
                        <button type="button" onClick={() => removeClosed(i)} className="btn-press text-muted-foreground/50 hover:text-destructive" title="删除">
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
      </CollapsibleSection>
    </div>
  );
}


