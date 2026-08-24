import { useEffect, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { api, ApiError, type BacktestModelResult, type BacktestRunSummary } from "@/lib/api";
import { parseCodes } from "@/lib/watchlist";
import { cn } from "@/lib/utils";
import { jobPct, jobText, useBacktestJob } from "@/pages/backtest/useBacktestJob";

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function tone(v: number | null | undefined) {
  if (v == null || Number.isNaN(v) || v === 0) return "text-slate-300";
  return v > 0 ? "text-red-400" : "text-emerald-400";
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className={cn("text-[13px] font-semibold", className)}>{value}</p>
    </div>
  );
}

export function ModelPanel({
  codes,
  lookback,
}: {
  codes: string;
  lookback: "1y" | "2y" | "3y";
}) {
  const [horizon, setHorizon] = useState(5);
  const [rebalance, setRebalance] = useState(20);
  const [topK, setTopK] = useState(10);
  const [tune, setTune] = useState(true);
  const [maxWeight, setMaxWeight] = useState(0);
  const [industryNeutral, setIndustryNeutral] = useState(false);
  const [excludeSt, setExcludeSt] = useState(true);
  const [minListDays, setMinListDays] = useState(60);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestModelResult | null>(null);
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const job = useBacktestJob(running);

  async function refreshRuns() {
    try {
      setRuns(await api.backtestRuns(20, "model"));
    } catch {
      setRuns([]);
    }
  }

  useEffect(() => {
    void refreshRuns();
  }, []);

  async function run() {
    const list = parseCodes(codes);
    if (list.length < 2) {
      setError("模型至少 2 只");
      return;
    }
    setRunning(true);
    setError("");
    try {
      const out = await api.backtestModel({
        codes: list,
        lookback,
        horizon,
        rebalance,
        tune,
        oos_frac: 0.3,
        max_positions: topK,
        max_weight: maxWeight > 0 ? maxWeight / 100 : 0,
        industry_neutral: industryNeutral,
        exclude_st: excludeSt,
        min_list_days: minListDays,
        commission_pct: 0.00025,
        commission_min: 5,
        stamp_tax_pct: 0.0005,
        slippage_bps: 5,
        initial_capital: 1_000_000,
      });
      setResult(out);
      void refreshRuns();
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : "模型失败");
    } finally {
      setRunning(false);
    }
  }

  const drift = result?.model?.drift?.filter((r) => r.psi != null || r.ks != null).slice(0, 8) ?? [];

  return (
    <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
      <GlassCard className="space-y-3 p-3">
        <p className="text-[11px] leading-relaxed text-slate-400">
          同一块日 K 训 LightGBM, 分数进 Top-K 目标权重. 网格只在切点前. 没装 lightgbm 会提示.
          宇宙仍最多 600 只, 不是每天重选全 A.
        </p>
        <label className="block text-[11px] text-slate-400">
          前瞻天数
          <input
            type="number"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value) || 5)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <label className="block text-[11px] text-slate-400">
          再平衡(日)
          <input
            type="number"
            value={rebalance}
            onChange={(e) => setRebalance(Number(e.target.value) || 20)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <label className="block text-[11px] text-slate-400">
          Top-K
          <input
            type="number"
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value) || 10)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <label className="block text-[11px] text-slate-400">
          个股上限 % (0=不限)
          <input
            type="number"
            value={maxWeight}
            onChange={(e) => setMaxWeight(Number(e.target.value) || 0)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <input type="checkbox" checked={tune} onChange={(e) => setTune(e.target.checked)} />
          样本内网格 (切点前)
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={industryNeutral}
            onChange={(e) => setIndustryNeutral(e.target.checked)}
          />
          行业中性 (缺归属单独一组)
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <input type="checkbox" checked={excludeSt} onChange={(e) => setExcludeSt(e.target.checked)} />
          剔除 ST / 退
        </label>
        <label className="block text-[11px] text-slate-400">
          次新天数 (0=关)
          <input
            type="number"
            min={0}
            value={minListDays}
            onChange={(e) => setMinListDays(Number(e.target.value) || 0)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/15 px-3 py-1 text-[12px] font-semibold text-primary hover:bg-primary/25 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {running ? jobText(job, "在训…") : "跑模型"}
        </button>
        {running && (
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-primary/80" style={{ width: `${jobPct(job)}%` }} />
          </div>
        )}
        {error && <p className="text-[12px] text-rose-300">{error}</p>}
        {runs.length > 0 && (
          <div className="space-y-1">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-[10px] text-slate-400">
                <button
                  type="button"
                  className="font-mono hover:text-primary"
                  onClick={() => {
                    void api.backtestRunGet(r.id).then((row) => setResult(row as BacktestModelResult)).catch((e) => {
                      setError(e instanceof ApiError ? e.message : "读实验失败");
                    });
                  }}
                >
                  {r.id.slice(0, 18)}
                </button>
                <button
                  type="button"
                  className="text-slate-600 hover:text-rose-300"
                  onClick={() => {
                    void api.backtestRunDelete(r.id).then(() => {
                      if (result?.run_id === r.id) setResult(null);
                      void refreshRuns();
                    });
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </GlassCard>
      <div className="space-y-3">
        {!result && !running && (
          <GlassCard>
            <EmptyState
              title="还没有跑过模型"
              description="左边账户表单先填一批代码. 分数只在切点前拟合, 切点后另开一笔钱验."
            />
          </GlassCard>
        )}
        {result && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="收益" value={fmtPct(result.stats.total_return)} className={tone(result.stats.total_return)} />
              <Stat label="夏普" value={result.stats.sharpe.toFixed(2)} />
              <Stat label="Sortino" value={(result.stats.sortino ?? 0).toFixed(2)} />
              <Stat label="样本外新开" value={fmtPct(result.oos?.stats_oos_fresh.total_return)} className={tone(result.oos?.stats_oos_fresh.total_return)} />
              <Stat label="样本内 IC" value={result.model?.is_ic == null ? "—" : result.model.is_ic.toFixed(3)} />
              <Stat label="样本外 IC" value={result.model?.oos_ic == null ? "—" : result.model.oos_ic.toFixed(3)} />
              <Stat label="训练点" value={String(result.model?.n_train ?? "—")} />
              <Stat label="特征" value={String(result.model?.n_features ?? result.model?.features?.length ?? "—")} />
            </div>
            <p className="text-[10px] text-slate-500">
              {result.model?.backend} · 前瞻 {result.model?.horizon ?? result.strategy?.horizon} 日
              {result.model?.split ? ` · 切点 ${result.model.split}` : ""}
              {result.run_id ? ` · ${result.run_id}` : ""}
            </p>
            {result.warnings?.length ? (
              <p className="text-[10px] text-amber-100/70">{result.warnings.slice(0, 4).join(" · ")}</p>
            ) : null}
            {drift.length > 0 && (
              <GlassCard className="overflow-x-auto p-0">
                <table className="w-full min-w-[360px] text-left text-[11px]">
                  <thead className="text-slate-500">
                    <tr className="border-b border-slate-800">
                      {["特征", "PSI", "KS"].map((h) => (
                        <th key={h} className="px-2 py-1 font-normal">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {drift.map((r) => (
                      <tr key={r.feature} className="border-b border-slate-800/60">
                        <td className="px-2 py-1 font-mono">{r.feature}</td>
                        <td className="px-2 py-1 font-mono">{r.psi == null ? "—" : r.psi.toFixed(3)}</td>
                        <td className="px-2 py-1 font-mono">{r.ks == null ? "—" : r.ks.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>
            )}
          </>
        )}
      </div>
    </div>
  );
}
