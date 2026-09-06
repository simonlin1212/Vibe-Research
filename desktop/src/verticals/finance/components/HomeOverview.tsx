import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw, FileText } from "lucide-react";
import { backend, num, rows, str, type Evidence, type FetchResult, type RunListItem } from "../lib/backend";

const number = (e: Evidence | undefined) => {
  const value = num(e);
  return value === null ? "未获取" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
};
const provenance = (e: Evidence | undefined) => e
  ? `证据 ${e.id} · ${e.source} · 资料期 ${e.period} · 取数 ${e.fetched_at}` : "此字段未获取";
const statusName: Record<string, string> = {
  complete: "已完成", incomplete: "资料不完整", failed: "失败", running: "研究中",
  cancelling: "正在取消", cancelled: "已取消", finalizing: "归档收尾中",
};

/** Home only reads the existing snapshot and archive. It never starts research or a model call. */
export function HomeOverview() {
  const [snapshot, setSnapshot] = useState<FetchResult | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [marketError, setMarketError] = useState(false);
  const [runsError, setRunsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setMarketError(false); setRunsError(false);
    setSnapshot(null); setRuns(null);
    void backend.fetch("tx_quotes_batch").then(result => {
      if (!cancelled) setSnapshot(result);
    }).catch(() => { if (!cancelled) setMarketError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    void backend.runs(12).then(result => {
      if (!cancelled) setRuns(result.filter(run => !run.test_scenario).slice(0, 3));
    }).catch(() => { if (!cancelled) setRunsError(true); });
    return () => { cancelled = true; };
  }, [revision]);
  const quotes = snapshot && ["ok", "partial"].includes(snapshot.envelope.status)
    ? rows(snapshot.envelope).slice(0, 3) : [];
  return <div className="workspace-home-grid mb-6">
    <section className="glass min-w-0 overflow-hidden" aria-label="首页行情快照">
      <div className="workspace-panel-head">
        <h2>市场概览</h2>
        <button disabled={loading} aria-label="重读首页行情与归档" onClick={() => setRevision(v => v + 1)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />重读快照
        </button>
      </div>
      {loading ? <p role="status" className="px-5 py-10 text-sm text-muted-foreground">正在读取本地行情快照…</p>
        : marketError ? <p role="status" className="px-5 py-10 text-sm text-destructive">行情快照未读取成功，请重试或到每日复盘查看数据源状态。</p>
        : <>
          {quotes.length ? <div className="grid grid-cols-3">
            {quotes.map(row => {
              const price = row.fields.price, change = row.fields.change_pct;
              const pct = num(change);
              return <div key={row.key} className="workspace-index">
                <p className="truncate text-xs text-muted-foreground">{str(row.fields.security_name) || row.key}</p>
                <p title={provenance(price)} className="workspace-index-value mt-3 font-mono">{number(price)}</p>
                <p className="text-[10px] text-muted-foreground">{price?.unit || "单位未提供"}</p>
                <p title={provenance(change)} className={`mt-3 font-mono text-xs ${pct === null || pct === 0 ? "text-muted-foreground" : pct > 0 ? "text-danger" : "text-success"}`}>
                  {pct !== null && pct > 0 ? "+" : ""}{number(change)}{pct === null ? "" : change?.unit || "%"}
                  <span className="ml-1">{pct === null ? "" : pct > 0 ? "上涨" : pct < 0 ? "下跌" : "持平"}</span>
                </p>
              </div>;
            })}
          </div> : <p role="status" className="px-5 py-10 text-sm text-muted-foreground">尚无可显示的指数快照。进入每日复盘可检查或刷新行情。</p>}
          {snapshot && snapshot.envelope.status !== "ok" && <p role="status" className="border-t border-border px-5 py-3 text-xs text-warning">数据状态：{snapshot.envelope.status === "partial" ? "部分获取，缺失项保留" : "获取失败，不能据此判断市场"}。请到每日复盘查看详情。</p>}
        </>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-4 text-[11px] text-muted-foreground">
        <span>取数时刻：{snapshot?.envelope.fetched_at || "未提供"}<br />历史快照，不代表实时行情；悬停数字查看证据。</span>
        <Link to="/daily-review" className="inline-flex items-center gap-1 text-primary">查看盘面<ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
    </section>
    <section className="glass min-w-0 overflow-hidden" aria-label="最近研究归档">
      <div className="workspace-panel-head"><h2>回到最近研究</h2><FileText className="h-4 w-4 text-muted-foreground" /></div>
      <div className="px-5 py-4">
        {runsError ? <p role="status" className="py-4 text-sm text-destructive">归档读取失败，请重试；这不表示没有研究记录。</p>
          : runs === null ? <p role="status" className="py-4 text-sm text-muted-foreground">正在读取研究归档…</p>
          : !runs.length ? <><p className="workspace-editorial py-3 text-xl">从一个值得核对的问题开始。</p><p className="text-xs leading-6 text-muted-foreground">尚无正式研究归档。进入个股研究，填写代码并确认后开始。</p></>
          : runs.map(run => <div key={run.run_id} className="border-b border-border py-3 first:pt-0 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{run.name || run.symbol || "未标注公司"}</span><span className="text-[10px] text-muted-foreground">{statusName[run.status ?? ""] || "状态未确认"}</span></div>
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{run.symbol || "代码未提供"} · {run.started_at || "时间未提供"}</p>
          </div>)}
        <Link to="/research" className="mt-4 inline-flex items-center gap-2 text-xs text-primary">进入研究与归档<ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
    </section>
  </div>;
}
