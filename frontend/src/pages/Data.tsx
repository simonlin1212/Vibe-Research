import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { api, ApiError, type BacktestStore, type BacktestStorePeek } from "@/lib/api";
import { cn } from "@/lib/utils";

function fmtBytes(n: number) {
  if (!n) return "0 B";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtNum(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

export function Data() {
  const [store, setStore] = useState<BacktestStore | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [peekSym, setPeekSym] = useState("");
  const [peek, setPeek] = useState<BacktestStorePeek | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pitBusy, setPitBusy] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setStore(await api.backtestStore());
    } catch (e) {
      setStore(null);
      setError(e instanceof ApiError ? e.message : "本机库存没读到");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const uni = store?.universe;
  const syncState = uni?.sync?.state;
  useEffect(() => {
    if (syncState !== "running") return;
    const t = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [syncState]);

  async function fillUniverse() {
    setSyncing(true);
    setError("");
    try {
      await api.backtestStoreSync();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "补齐没启动");
    } finally {
      setSyncing(false);
    }
  }

  async function openPeek(symbol: string) {
    setPeekSym(symbol);
    setPeeking(true);
    try {
      setPeek(await api.backtestStorePeek(symbol, 20));
    } catch (e) {
      setPeek(null);
      setError(e instanceof ApiError ? e.message : "这段日 K 没读到");
    } finally {
      setPeeking(false);
    }
  }

  const cal = store?.calendar;
  const symbols = store?.bars.symbols || [];

  return (
    <div className="mx-auto max-w-6xl px-3 py-3 sm:px-4">
      <PageHeader
        title="本机数据"
        subtitle="看本机日历、标的池日 K、按日成分、财务 PIT、实验。可补齐近 3 年已收盘日 K，不清库。"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fillUniverse()}
              disabled={syncing || syncState === "running"}
              className="inline-flex items-center gap-1 rounded border border-primary/60 px-2 py-1 text-[11px] text-primary hover:text-primary disabled:opacity-50"
            >
              {syncState === "running" ? "补齐中…" : "补齐近3年"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPitBusy("members");
                setError("");
                void api.backtestStoreMembers().then(() => load()).catch((e) => {
                  setError(e instanceof ApiError ? e.message : "按日成分没补上");
                }).finally(() => setPitBusy(""));
              }}
              disabled={!!pitBusy}
              className="inline-flex items-center gap-1 rounded border border-primary/60 px-2 py-1 text-[11px] text-primary hover:text-primary disabled:opacity-50"
            >
              {pitBusy === "members" ? "成分…" : "补齐按日成分"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPitBusy("fund");
                setError("");
                void api.backtestStoreFundamentals().then(() => load()).catch((e) => {
                  setError(e instanceof ApiError ? e.message : "财务PIT没补上");
                }).finally(() => setPitBusy(""));
              }}
              disabled={!!pitBusy}
              className="inline-flex items-center gap-1 rounded border border-primary/60 px-2 py-1 text-[11px] text-primary hover:text-primary disabled:opacity-50"
            >
              {pitBusy === "fund" ? "财务…" : "补齐财务PIT"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:text-slate-100"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
              刷新
            </button>
          </div>
        }
      />

      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}

      {loading && !store && (
        <GlassCard>
          <EmptyState title="在读本机目录" loading />
        </GlassCard>
      )}

      {store && (
        <>
          <p className="mb-2 font-mono text-[10px] text-slate-500">
            {store.root} · 已收盘至 {store.closed_end || "?"} · 行情 {fmtBytes(store.bytes.market)} · 实验{" "}
            {fmtBytes(store.bytes.runs)}
          </p>

          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="交易日历"
              value={cal?.loaded ? `${cal.count} 日` : "周末回退"}
              hint={
                cal?.loaded
                  ? `${cal.from} ~ ${cal.to} · ${cal.source || "?"}`
                  : "还没有日历文件, 工作日当开市"
              }
            />
            <Stat
              label="日 K"
              value={`${store.bars.count} 只`}
              hint={
                store.universe
                  ? `标的池 ${store.universe.covered}/${store.universe.codes} 覆盖 ${store.universe.start} ~ ${store.universe.end}`
                  : "回测或补齐后写入 parquet"
              }
            />
            <Stat
              label="实验"
              value={`${store.runs.count} 个`}
              hint="写完不改, 回看时对哈希"
            />
            <Stat
              label="成分 / 财务"
              value={`${store.members.length} / ${store.fundamentals.length}`}
              hint={
                store.members.length || store.fundamentals.length
                  ? [
                      ...store.members.map((m) => `${m.index} ${m.snapshots}张 ${m.from || "?"}~${m.to || "?"}`),
                      store.fundamentals.length ? `财务 ${store.fundamentals.length} 只` : "",
                    ].filter(Boolean).join(" · ")
                  : "点补齐按日成分 / 财务PIT, 挂已有 members/ 与 fundamentals/"
              }
            />
          </div>

          {uni?.sync && (uni.sync.state === "running" || uni.sync.error) && (
            <p className="mb-2 text-[11px] text-slate-400">
              {uni.sync.state === "running"
                ? `补齐 ${uni.sync.done || 0}/${uni.sync.universe || 0}`
                  + (uni.sync.current ? ` · ${uni.sync.current}` : "")
                : uni.sync.error}
            </p>
          )}

          {store.legacy_kline > 0 && (
            <p className="mb-2 text-[11px] text-amber-200/80">
              还有 {store.legacy_kline} 个旧版 kline/*.json, 回测已经不读它们。
            </p>
          )}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <GlassCard className="overflow-x-auto p-0">
              {symbols.length === 0 ? (
                <EmptyState
                  title="还没有日 K"
                  description="点「补齐近3年」拉标的池, 或去回测页跑几只。"
                />
              ) : (
                <table className="w-full min-w-[560px] text-left text-[11px]">
                  <thead className="text-slate-500">
                    <tr className="border-b border-slate-800">
                      {["代码", "根数", "起", "止", "复权因子"].map((h) => (
                        <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {symbols.map((s) => (
                      <tr
                        key={s.symbol}
                        className={cn(
                          "cursor-pointer border-b border-slate-800/70 hover:bg-slate-800/40",
                          peekSym === s.symbol && "bg-primary/10",
                        )}
                        onClick={() => void openPeek(s.symbol)}
                      >
                        <td className="px-2 py-1 font-mono text-slate-200">{s.symbol}</td>
                        <td className="px-2 py-1 font-mono tabular-nums">{s.bars}</td>
                        <td className="px-2 py-1 font-mono text-slate-400">{s.from || "—"}</td>
                        <td className="px-2 py-1 font-mono text-slate-400">{s.to || "—"}</td>
                        <td className="px-2 py-1 font-mono tabular-nums text-slate-400">{s.adj}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </GlassCard>

            <div className="space-y-3">
              <GlassCard className="overflow-x-auto p-0">
                <p className="px-2 py-1.5 text-[11px] text-slate-400">
                  {peek
                    ? `${peek.symbol} 最近 ${peek.bars.length} 根 · 共 ${peek.count}`
                    : "点左边一只看原始 OHLC"}
                </p>
                {peeking && <EmptyState title="在读" loading />}
                {peek && peek.bars.length > 0 && (
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-slate-500">
                      <tr className="border-b border-slate-800">
                        {["日期", "收", "因子"].map((h) => (
                          <th key={h} className="px-2 py-1 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {peek.bars.map((b) => (
                        <tr key={b.date} className="border-b border-slate-800/70">
                          <td className="px-2 py-1 font-mono text-slate-400">{b.date}</td>
                          <td className="px-2 py-1 font-mono tabular-nums">{fmtNum(b.close)}</td>
                          <td className="px-2 py-1 font-mono tabular-nums text-slate-500">
                            {b.factor == null ? "—" : fmtNum(b.factor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </GlassCard>

              <GlassCard className="p-2">
                <p className="mb-1 text-[11px] text-slate-400">最近实验</p>
                {(store.runs.recent || []).length === 0 ? (
                  <p className="text-[11px] text-slate-500">还没有 run</p>
                ) : (
                  <ul className="space-y-1">
                    {store.runs.recent.map((r) => (
                      <li key={r.id}>
                        <Link
                          to="/backtest"
                          className="font-mono text-[11px] text-primary hover:text-primary"
                        >
                          {r.id}
                        </Link>
                        <span className="ml-2 text-[10px] text-slate-500">
                          {r.kind === "factor" ? (r.factor_label || r.factor || "因子") : ((r.symbols || []).slice(0, 3).join(" ") || "账户")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to="/backtest" className="mt-2 inline-block text-[11px] text-primary hover:text-primary">
                  去回测
                </Link>
              </GlassCard>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <GlassCard className="py-2">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-[16px] tabular-nums text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-500">{hint}</p>}
    </GlassCard>
  );
}
