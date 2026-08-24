import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import { Play, Trash2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { api, ApiError, type BacktestFactorCompare, type BacktestFactorDef, type BacktestFactorResult, type BacktestIndexPoolDef, type BacktestRunSummary } from "@/lib/api";
import { parseCodes } from "@/lib/watchlist";
import { cn } from "@/lib/utils";
import { FALLBACK_INDEX_POOLS, IndexPoolButtons } from "@/pages/backtest/IndexPoolButtons";
import { jobPct, jobText, useBacktestJob } from "@/pages/backtest/useBacktestJob";

const FALLBACK_FACTORS: BacktestFactorDef[] = [
  { id: "momentum_20", label: "20日动量", win: 20, kind: "mom", group: "动量" },
  { id: "momentum_5", label: "5日动量", win: 5, kind: "mom", group: "动量" },
  { id: "rsi_14", label: "RSI(14)", win: 14, kind: "rsi", group: "超买超卖" },
  { id: "vol_20", label: "20日波动", win: 20, kind: "vol", group: "波动" },
  { id: "macd_hist", label: "MACD柱", win: 35, kind: "macd", group: "趋势" },
  { id: "zoo_alpha101", label: "WQ #101 日内实体", win: 1, kind: "zoo101", group: "WorldQuant" },
];

const GROUP_ORDER = ["动量", "超买超卖", "波动", "量价", "趋势", "WorldQuant", "财务PIT"];

function groupedFactors(factors: BacktestFactorDef[]) {
  const buckets = new Map<string, BacktestFactorDef[]>();
  for (const f of factors) {
    const g = f.group || "其他";
    const list = buckets.get(g) ?? [];
    list.push(f);
    buckets.set(g, list);
  }
  const keys = [...GROUP_ORDER.filter((g) => buckets.has(g)), ...[...buckets.keys()].filter((g) => !GROUP_ORDER.includes(g))];
  return keys.map((g) => [g, buckets.get(g)!] as const);
}

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function tone(v: number | null | undefined) {
  if (v == null || Number.isNaN(v) || v === 0) return "text-slate-300";
  return v > 0 ? "text-red-400" : "text-emerald-400";
}

function FactorCharts({ result }: { result: BacktestFactorResult }) {
  const icRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const icEl = icRef.current;
    const navEl = navRef.current;
    if (!icEl || !navEl) return;
    const ic = echarts.init(icEl, undefined, { renderer: "canvas" });
    const nav = echarts.init(navEl, undefined, { renderer: "canvas" });
    const onResize = () => {
      ic.resize();
      nav.resize();
    };
    window.addEventListener("resize", onResize);
    const dates = result.ic_series.map((p) => p.date);
    ic.setOption({
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 40, right: 12, top: 24, bottom: 24 },
      xAxis: { type: "category", data: dates, axisLabel: { color: "#64748b", fontSize: 10 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#1e293b" } }, axisLabel: { color: "#64748b", fontSize: 10 } },
      series: [{
        type: "bar",
        data: result.ic_series.map((p) => ({
          value: p.ic,
          itemStyle: { color: p.ic >= 0 ? "#f87171" : "#34d399" },
        })),
      }],
    });
    const navDates = result.group_nav.map((p) => String(p.date));
    const groups = result.group_stats.map((g) => g.label);
    const colors = ["#64748b", "#ffcc00", "#f0b90b", "#a78bfa", "#f87171", "#00d26a"];
    nav.setOption({
      backgroundColor: "transparent",
      animation: false,
      legend: { top: 0, textStyle: { color: "#94a3b8", fontSize: 10 } },
      grid: { left: 48, right: 12, top: 28, bottom: 24 },
      xAxis: { type: "category", data: navDates, axisLabel: { color: "#64748b", fontSize: 10 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#1e293b" } }, axisLabel: { color: "#64748b", fontSize: 10 } },
      series: [
        ...groups.map((g, i) => ({
          name: g,
          type: "line" as const,
          showSymbol: false,
          data: result.group_nav.map((p) => p[g] ?? null),
          lineStyle: { color: colors[i % colors.length], width: 1.3 },
        })),
        {
          name: "多空",
          type: "line" as const,
          showSymbol: false,
          data: navDates.map((d) => result.long_short_nav.find((p) => p.date === d)?.value ?? null),
          lineStyle: { color: "#fbbf24", width: 1.4, type: "dashed" as const },
        },
      ],
    });
    return () => {
      window.removeEventListener("resize", onResize);
      ic.dispose();
      nav.dispose();
    };
  }, [result]);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <GlassCard className="p-2">
        <p className="px-1 text-[11px] text-slate-400">Rank IC</p>
        <div ref={icRef} className="h-[220px] w-full" />
      </GlassCard>
      <GlassCard className="p-2">
        <p className="px-1 text-[11px] text-slate-400">五档净值 + 多空</p>
        <div ref={navRef} className="h-[220px] w-full" />
      </GlassCard>
    </div>
  );
}

export function FactorPanel({
  codes,
  lookback,
  onCodes,
}: {
  codes: string;
  lookback: "1y" | "2y" | "3y";
  onCodes: (codes: string) => void;
}) {
  const [factors, setFactors] = useState<BacktestFactorDef[]>(FALLBACK_FACTORS);
  const [indexPools, setIndexPools] = useState<BacktestIndexPoolDef[]>(FALLBACK_INDEX_POOLS);
  const [factorMax, setFactorMax] = useState(600);
  const [poolNote, setPoolNote] = useState("");
  const [indexId, setIndexId] = useState("");
  const [factor, setFactor] = useState("momentum_20");
  const [picked, setPicked] = useState<string[]>(["momentum_20", "rsi_14"]);
  const [rebalance, setRebalance] = useState<"daily" | "weekly" | "monthly">("monthly");
  const [pool, setPool] = useState<"codes" | "store">("codes");
  const [direction, setDirection] = useState<"high" | "low">("high");
  const [nGroups, setNGroups] = useState(5);
  const [weight, setWeight] = useState<"equal" | "factor_weight">("equal");
  const [excludeSt, setExcludeSt] = useState(true);
  const [minListDays, setMinListDays] = useState(60);
  const [compare, setCompare] = useState<BacktestFactorCompare | null>(null);
  const [running, setRunning] = useState(false);
  const job = useBacktestJob(running);
  const [opening, setOpening] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestFactorResult | null>(null);
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);

  function refreshRuns() {
    return api.backtestRuns(20, "factor").then(setRuns).catch(() => undefined);
  }

  useEffect(() => {
    void api.backtestMeta().then((m) => {
      if (m.factors?.length) setFactors(m.factors);
      if (m.index_pools?.length) setIndexPools(m.index_pools);
      const n = Number(m.limits?.factor_max_codes);
      if (Number.isFinite(n) && n > 0) setFactorMax(n);
    }).catch(() => undefined);
    void refreshRuns();
  }, []);

  function applyResult(out: BacktestFactorResult) {
    setResult(out);
    if (out.factor?.id) setFactor(out.factor.id);
    if (out.direction === "high" || out.direction === "low") setDirection(out.direction);
    if (out.n_groups === 3 || out.n_groups === 5 || out.n_groups === 10) setNGroups(out.n_groups);
    if (out.weight === "equal" || out.weight === "factor_weight") setWeight(out.weight);
    if (out.rebalance === "daily" || out.rebalance === "weekly" || out.rebalance === "monthly") {
      setRebalance(out.rebalance);
    }
    const nextPool = out.config?.pool || out.universe?.pool;
    if (nextPool === "codes" || nextPool === "store") setPool(nextPool);
  }

  async function run() {
    const list = parseCodes(codes);
    if (pool === "codes" && list.length < 2) {
      setError("表单标的至少 2 只, 或改用库存已覆盖");
      return;
    }
    setRunning(true);
    setError("");
    try {
      applyResult(await api.backtestFactor({
        codes: list,
        pool,
        factor,
        lookback,
        rebalance,
        n_groups: nGroups,
        direction,
        weight,
        index: indexId || undefined,
        exclude_st: excludeSt,
        min_list_days: minListDays,
      }));
      void refreshRuns();
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : "因子回测失败");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/80">
        先问因子有没有预测力: Rank IC、五档净值、多空。不是账户撮合, 没有 T+1 / 整手。
        从本机日 K 现场算: TickFlow 那组技术因子 + 3 条 WorldQuant 公式。不是 enriched, 也不是 460 条整库。换手率要股本, 没加。少于 30 只 IC 很噪。库存已覆盖最多 600 只, 不是全 A。
        财务 ROE/净利润/营收按公告日 PIT, 不是报告期偷看. 点指数导入后因子截面可按日成分掩码.
        周/月调仓用交易期末最后一根. 默认剔 ST (今天的名字) 和次新 (这段第一根 bar).
        实验落本机 runs/ 写完不改, 和账户实验分开列。
      </div>
      {runs.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {runs.map((r) => {
            const active = result?.run_id === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setOpening(r.id);
                  setError("");
                  void api.backtestRunGet(r.id).then((row) => {
                    applyResult(row as unknown as BacktestFactorResult);
                  }).catch((e) => {
                    setError(e instanceof ApiError ? e.message : "读因子实验失败");
                  }).finally(() => setOpening(""));
                }}
                className={cn(
                  "shrink-0 rounded border px-2 py-1 text-left text-[10px]",
                  active ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400 hover:text-slate-200",
                  opening === r.id && "opacity-60",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono">{r.id.slice(0, 15)}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-slate-600 hover:text-rose-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.backtestRunDelete(r.id).then(() => {
                        if (result?.run_id === r.id) setResult(null);
                        void refreshRuns();
                      });
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                </div>
                <div>
                  {r.factor_label || r.factor || "factor"}
                  {r.ic_mean != null ? ` · IC ${r.ic_mean.toFixed(3)}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <GlassCard className="flex flex-wrap items-end gap-2 p-3">
        <label className="block w-full">
          <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
            <span>标的 (最多 {factorMax})</span>
            <IndexPoolButtons
              pools={indexPools}
              cap={factorMax}
              onFill={(next, note, id) => {
                setError("");
                setPoolNote(note);
                setIndexId(id);
                onCodes(next);
                setPool("codes");
              }}
              onError={(msg) => {
                setPoolNote("");
                setError(msg);
              }}
            />
          </div>
          <textarea
            value={codes}
            onChange={(e) => {
              setIndexId("");
              onCodes(e.target.value);
            }}
            rows={2}
            className="w-full resize-y rounded border border-slate-700 bg-slate-950/60 px-2 py-1.5 font-mono text-[12px] text-slate-100 outline-none focus:border-primary/50"
            placeholder="600519 000858 300750"
          />
          <p className="mt-1 text-[10px] text-slate-500">
            已识别 {parseCodes(codes).length} 只
            {parseCodes(codes).length > factorMax ? ` · 一次最多 ${factorMax}` : ""}
          </p>
          {poolNote && <p className="mt-1 text-[10px] text-amber-200/80">{poolNote}</p>}
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-slate-500">因子</span>
          <select
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
            className="rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-100"
          >
            {groupedFactors(factors).map(([g, items]) => (
              <optgroup key={g} label={g}>
                {items.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div>
          <p className="mb-1 text-[10px] text-slate-500">调仓</p>
          <div className="flex gap-1">
            {(["monthly", "weekly", "daily"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setRebalance(k)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  rebalance === k ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400",
                )}
              >
                {k === "monthly" ? "月" : k === "weekly" ? "周" : "日"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-slate-500">周/月 = 交易期末最后一根</p>
        </div>
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
        <div>
          <p className="mb-1 text-[10px] text-slate-500">池子</p>
          <div className="flex gap-1">
            {([["codes", "表单标的"], ["store", "库存已覆盖"]] as const).map(([k, lab]) => (
              <button
                key={k}
                type="button"
                onClick={() => setPool(k)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  pool === k ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400",
                )}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] text-slate-500">方向</p>
          <div className="flex gap-1">
            {([["high", "越大越好"], ["low", "越小越好"]] as const).map(([k, lab]) => (
              <button
                key={k}
                type="button"
                onClick={() => setDirection(k)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  direction === k ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400",
                )}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] text-slate-500">分层</p>
          <div className="flex gap-1">
            {([3, 5, 10] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNGroups(n)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  nGroups === n ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] text-slate-500">权重</p>
          <div className="flex gap-1">
            {([["equal", "等权"], ["factor_weight", "因子加权"]] as const).map(([k, lab]) => (
              <button
                key={k}
                type="button"
                onClick={() => setWeight(k)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  weight === k ? "border-primary/50 bg-primary/10 text-primary" : "border-slate-700 text-slate-400",
                )}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/15 px-3 py-1 text-[12px] font-semibold text-primary hover:bg-primary/25 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {running ? jobText(job, "在算…") : "跑因子"}
        </button>
        <button
          type="button"
          onClick={() => {
            const list = parseCodes(codes);
            if (pool === "codes" && list.length < 2) {
              setError("表单标的至少 2 只, 或改用库存已覆盖");
              return;
            }
            const ids = picked.includes(factor) ? picked : [...picked, factor].slice(0, 6);
            setRunning(true);
            setError("");
            void api.backtestFactorCompare({
              codes: list,
              pool,
              factors: ids,
              lookback,
              rebalance,
              n_groups: nGroups,
              direction,
              weight,
              index: indexId || undefined,
              exclude_st: excludeSt,
              min_list_days: minListDays,
            }).then((out) => {
              setCompare(out);
            }).catch((e) => {
              setCompare(null);
              setError(e instanceof ApiError ? e.message : "对照失败");
            }).finally(() => setRunning(false));
          }}
          disabled={running}
          className="rounded border border-slate-600 px-3 py-1 text-[12px] text-slate-200 hover:border-primary/40 disabled:opacity-50"
        >
          对照已勾选
        </button>
      </GlassCard>
      <div className="flex flex-wrap gap-1.5">
        {factors.map((f) => {
          const on = picked.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setPicked((cur) => {
                  if (cur.includes(f.id)) return cur.filter((x) => x !== f.id);
                  if (cur.length >= 6) return cur;
                  return [...cur, f.id];
                });
              }}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px]",
                on ? "border-primary/40 bg-primary/10 text-primary" : "border-slate-800 text-slate-500",
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      {error && <p className="text-[12px] text-rose-300">{error}</p>}
      {running && (
        <GlassCard className="space-y-2 p-3">
          <p className="text-[12px] text-primary">{jobText(job, "在算 Rank IC / 五档")}</p>
          {job?.note ? <p className="text-[10px] text-slate-500">{job.note}</p> : null}
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-primary/80 transition-[width]" style={{ width: `${jobPct(job)}%` }} />
          </div>
        </GlassCard>
      )}
      {compare && (
        <GlassCard className="overflow-x-auto p-0">
          <p className="px-2 pt-2 text-[11px] text-slate-400">对照 · {compare.n_symbols} 只 · IC 相关看对角外是否接近 1</p>
          <table className="w-full min-w-[560px] text-left text-[11px]">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-800">
                {["因子", "IC", "IR", "IC胜率", "多空", "Q差"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-800/70">
                  <td className="px-2 py-1">{row.label}</td>
                  <td className={cn("px-2 py-1 font-mono", tone(row.ic_mean))}>{row.ic_mean == null ? "—" : row.ic_mean.toFixed(3)}</td>
                  <td className="px-2 py-1 font-mono">{row.ir == null ? "—" : row.ir.toFixed(2)}</td>
                  <td className="px-2 py-1 font-mono">{fmtPct(row.ic_win_rate)}</td>
                  <td className={cn("px-2 py-1 font-mono", tone(row.ls_return))}>{fmtPct(row.ls_return)}</td>
                  <td className={cn("px-2 py-1 font-mono", tone(row.q_spread))}>{fmtPct(row.q_spread)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
      )}
      {!result && !running && !compare && (
        <GlassCard>
          <EmptyState
            title="还没有跑过因子"
            description="左边账户表单先填一批代码, 或直接用库存已覆盖。先看 IC 正负和 Q5 是否好于 Q1, 再去账户里用动量轮动撮合。"
          />
        </GlassCard>
      )}
      {result && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="IC 均值" value={result.ic_mean == null ? "—" : result.ic_mean.toFixed(3)} className={tone(result.ic_mean)} />
            <Stat label="Pearson IC" value={result.ic_pearson_mean == null ? "—" : result.ic_pearson_mean.toFixed(3)} className={tone(result.ic_pearson_mean)} />
            <Stat label="IR" value={result.ir == null ? "—" : result.ir.toFixed(2)} className={tone(result.ir)} />
            <Stat label="IC 胜率" value={fmtPct(result.ic_win_rate)} />
            <Stat
              label="多空收益"
              value={fmtPct(result.long_short_stats.total_return)}
              className={tone(result.long_short_stats.total_return)}
            />
          </div>
          <p className="text-[10px] text-slate-500">
            {result.factor.label} · {result.rebalance} · {result.n_symbols} 只 · {result.n_periods} 期
            {result.universe?.from_store != null ? ` · 库存 ${result.universe.from_store}` : ""}
          </p>
          <FactorCharts result={result} />
          <GlassCard className="overflow-x-auto p-0">
            <table className="w-full min-w-[520px] text-left text-[11px]">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-800">
                  {["档", "收益", "夏普", "最大回撤", "胜率"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.group_stats.map((g) => (
                  <tr key={g.label} className="border-b border-slate-800/70">
                    <td className="px-2 py-1 font-mono">{g.label}</td>
                    <td className={cn("px-2 py-1 font-mono", tone(g.total_return))}>{fmtPct(g.total_return)}</td>
                    <td className="px-2 py-1 font-mono">{g.sharpe.toFixed(2)}</td>
                    <td className={cn("px-2 py-1 font-mono", tone(g.max_drawdown))}>{fmtPct(g.max_drawdown)}</td>
                    <td className="px-2 py-1 font-mono">{fmtPct(g.win_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>
          {(result.warnings || []).length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-amber-200/80">
              {result.warnings!.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <GlassCard className="py-2">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className={cn("mt-0.5 font-mono text-[16px] tabular-nums", className)}>{value}</p>
    </GlassCard>
  );
}
