import { lazy, Suspense, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageFallback } from "@/components/ui/PageFallback";
import {
  api,
  ApiError,
  type Research13f,
  type ResearchCorrelation,
  type ResearchEtf,
  type ResearchKline,
  type ResearchSources,
} from "@/lib/api";
import { storageGet, storageSet } from "@/lib/storage";
import { cn } from "@/lib/utils";

type Tab = "corr" | "etf" | "f13" | "kline";

const TABS: { id: Tab; label: string }[] = [
  { id: "corr", label: "相关性" },
  { id: "etf", label: "ETF 穿透" },
  { id: "f13", label: "13F 环比" },
  { id: "kline", label: "扩展日 K" },
];

const CorrHeat = lazy(() =>
  import("@/pages/research/ResearchCharts").then((m) => ({ default: m.CorrHeat })),
);
const ResearchKlineChart = lazy(() =>
  import("@/pages/research/ResearchCharts").then((m) => ({ default: m.ResearchKlineChart })),
);

const CORR_KEY = "vr-research-corr";
const ETF_KEY = "vr-research-etf";
const F13_KEY = "vr-research-13f";
const KL_KEY = "vr-research-kline";

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtYi(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return fmtNum(v, 0);
}

export function Research() {
  const [tab, setTab] = useState<Tab>("corr");
  const [sources, setSources] = useState<ResearchSources | null>(null);

  useEffect(() => {
    void api.researchSources().then(setSources).catch(() => setSources(null));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
      <PageHeader
        title="研究桌"
        subtitle="Stooq / Baostock / pykrx · 相关热力图 · ETF 穿透 · 13F 环比。只呈现公开披露, 不推荐不预测。"
        actions={
          <div className="flex border border-[#2a2a2a] bg-black p-px text-[12px]">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "px-2 py-1",
                  tab === t.id ? "bg-[#2a1a00] text-primary" : "text-[#888] hover:text-[#eee]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      {tab === "corr" && <CorrPanel />}
      {tab === "etf" && <EtfPanel />}
      {tab === "f13" && <ThirteenFPanel />}
      {tab === "kline" && <KlinePanel sources={sources} />}
    </div>
  );
}

function CorrPanel() {
  const [input, setInput] = useState(() => storageGet(CORR_KEY) || "510300,600519,AAPL,00700.HK");
  const [windowN, setWindowN] = useState(60);
  const [data, setData] = useState<ResearchCorrelation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(codes = input, win = windowN) {
    setLoading(true);
    setError("");
    try {
      const out = await api.researchCorrelation(codes, win);
      setData(out);
      storageSet(CORR_KEY, codes);
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial
  }, []);

  return (
    <GlassCard>
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(input, windowN);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="min-w-[220px] flex-1 rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-200"
          placeholder="510300,600519,AAPL,00700.HK"
        />
        <select
          value={windowN}
          onChange={(e) => setWindowN(Number(e.target.value))}
          className="rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-300"
        >
          {[40, 60, 90, 120].map((n) => (
            <option key={n} value={n}>
              {n} 日
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12px] text-primary disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          计算
        </button>
      </form>
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      {data?.errors?.length ? (
        <p className="mb-2 text-[11px] text-slate-500">
          未纳入: {data.errors.map((e) => `${e.code} (${e.error})`).join(" · ")}
        </p>
      ) : null}
      {!data && !error ? (
        <EmptyState title="相关矩阵" loading={loading} />
      ) : data?.matrix?.length ? (
        <Suspense fallback={<PageFallback />}>
          <CorrHeat data={data} />
        </Suspense>
      ) : (
        <EmptyState title="相关矩阵" />
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        Pearson, 重叠日收益。青=同向, 玫瑰=反向。不是预测, 窗口变了数字就会变。
      </p>
    </GlassCard>
  );
}

function EtfPanel() {
  const [input, setInput] = useState(() => storageGet(ETF_KEY) || "510300");
  const [data, setData] = useState<ResearchEtf | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(symbol = input) {
    setLoading(true);
    setError("");
    try {
      const out = await api.researchEtfHoldings(symbol.trim());
      setData(out);
      storageSet(ETF_KEY, symbol.trim());
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data?.holdings ?? [];

  return (
    <GlassCard>
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-40 rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-200"
          placeholder="510300 或 IVV"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12px] text-primary disabled:opacity-50"
        >
          穿透
        </button>
        <span className="text-[11px] text-slate-500">A 股中报/年报全持仓 · 美股 N-PORT (需 VR_SEC_CONTACT)</span>
      </form>
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      {loading && !data ? <EmptyState title="ETF 持仓" loading /> : null}
      {data && (
        <>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-slate-300">
            <span>{data.fund_name || data.symbol}</span>
            <span className="text-slate-500">as of {data.as_of || "—"}</span>
            <span className="text-slate-500">覆盖 {data.coverage || "—"}</span>
            {data.pct_of_net_assets_disclosed != null && (
              <span>基金披露净值 {fmtPct(data.pct_of_net_assets_disclosed)}</span>
            )}
            {data.cross_referenced_holdings ? (
              <span className="text-slate-500">星号交叉引用 {data.cross_referenced_holdings} 行已排除</span>
            ) : null}
          </div>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-card text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">代码</th>
                  <th className="py-1 pr-2 font-medium">名称</th>
                  <th className="py-1 pr-2 text-right font-medium">占净值</th>
                  <th className="py-1 text-right font-medium">市值</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h, i) => (
                  <tr key={`${h.symbol || h.ticker || h.cusip || i}`} className="border-t border-slate-800/80">
                    <td className="py-1 pr-2 font-mono text-slate-300">{h.symbol || h.ticker || h.cusip || "—"}</td>
                    <td className="py-1 pr-2 text-slate-200">{h.name || "—"}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-primary">
                      {fmtPct(h.pct_of_net_assets, 3)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-slate-400">
                      {h.market_value_cny != null ? fmtYi(h.market_value_cny) : fmtYi(h.value_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">{data.note}</p>
        </>
      )}
    </GlassCard>
  );
}

function ThirteenFPanel() {
  const [input, setInput] = useState(() => storageGet(F13_KEY) || "Berkshire");
  const [mode, setMode] = useState<"manager" | "ticker">("manager");
  const [data, setData] = useState<Research13f | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(q = input, m = mode) {
    setLoading(true);
    setError("");
    try {
      const out = await api.research13f(m === "ticker" ? { ticker: q.trim() } : { manager: q.trim() });
      setData(out);
      storageSet(F13_KEY, q.trim());
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const holdings = data?.current?.holdings ?? [];
  const changes = data?.changes ?? [];

  return (
    <GlassCard>
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <div className="flex rounded-lg bg-muted/40 p-0.5 text-[11px]">
          {(["manager", "ticker"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-md px-2 py-0.5",
                mode === m ? "bg-background text-primary" : "text-slate-500",
              )}
            >
              {m === "manager" ? "管理人" : "标的持有人"}
            </button>
          ))}
        </div>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-52 rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-200"
          placeholder={mode === "ticker" ? "AAPL" : "Berkshire 或 CIK"}
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12px] text-primary disabled:opacity-50"
        >
          查询
        </button>
        <span className="text-[11px] text-slate-500">需 VR_SEC_CONTACT · 季度披露, 滞后数周</span>
      </form>
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      {loading && !data ? <EmptyState title="13F" loading /> : null}
      {data?.mode === "ticker" && (
        <div className="max-h-[480px] overflow-auto">
          <p className="mb-2 text-[12px] text-slate-400">
            {data.ticker} 提及列表{data.cusip ? ` · CUSIP ${data.cusip}` : ""} · 点管理人看环比
          </p>
          <table className="w-full text-left text-[12px]">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">CIK</th>
                <th className="py-1 font-medium">管理人</th>
                <th className="py-1 font-medium">报告期</th>
              </tr>
            </thead>
            <tbody>
              {(data.managers ?? []).map((m) => (
                <tr key={m.cik} className="border-t border-slate-800/80">
                  <td className="py-1">
                    <button
                      type="button"
                      className="font-mono text-primary hover:underline"
                      onClick={() => {
                        setMode("manager");
                        setInput(m.cik);
                        void load(m.cik, "manager");
                      }}
                    >
                      {m.cik}
                    </button>
                  </td>
                  <td className="py-1 text-slate-200">{m.name || "—"}</td>
                  <td className="py-1 text-slate-500">{m.period_end || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.mode === "manager" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-[12px] text-slate-300">
              {data.manager || data.cik} · {data.current?.period_end} · {data.current?.positions} 条
              {data.prior?.period_end ? ` · 上期 ${data.prior.period_end}` : ""}
            </p>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 bg-card text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">发行人</th>
                    <th className="py-1 text-right font-medium">股数</th>
                    <th className="py-1 text-right font-medium">市值 USD</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => (
                    <tr key={`${h.cusip}-${h.put_call || ""}`} className="border-t border-slate-800/80">
                      <td className="py-1 text-slate-200">
                        {h.issuer || h.cusip}
                        {h.put_call ? <span className="ml-1 text-slate-500">{h.put_call}</span> : null}
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-400">{fmtNum(h.shares, 0)}</td>
                      <td className="py-1 text-right tabular-nums text-primary">{fmtYi(h.value_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p className="mb-1 text-[12px] text-slate-300">
              环比
              {data.change_counts
                ? ` · 新开 ${data.change_counts.new ?? 0} / 加 ${data.change_counts.increased ?? 0} / 减 ${data.change_counts.reduced ?? 0} / 清 ${data.change_counts.closed ?? 0}`
                : ""}
            </p>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 bg-card text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">动作</th>
                    <th className="py-1 font-medium">发行人</th>
                    <th className="py-1 text-right font-medium">股数变化</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={`${c.cusip}-${c.action}-${i}`} className="border-t border-slate-800/80">
                      <td
                        className={cn(
                          "py-1",
                          c.action === "new" || c.action === "increased" ? "text-primary" : "text-rose-300",
                        )}
                      >
                        {c.action}
                      </td>
                      <td className="py-1 text-slate-200">{c.issuer || c.cusip}</td>
                      <td className="py-1 text-right tabular-nums text-slate-400">
                        {fmtNum(c.shares_change, 0)}
                        {c.shares_change_pct != null ? ` (${fmtPct(c.shares_change_pct, 1)})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {data?.note && <p className="mt-2 text-[11px] text-slate-500">{data.note}</p>}
    </GlassCard>
  );
}

function KlinePanel({ sources }: { sources: ResearchSources | null }) {
  const [input, setInput] = useState(() => storageGet(KL_KEY) || "AAPL");
  const [source, setSource] = useState("auto");
  const [data, setData] = useState<ResearchKline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(symbol = input, src = source) {
    setLoading(true);
    setError("");
    try {
      const out = await api.researchKline(symbol.trim(), src, 180);
      setData(out);
      storageSet(KL_KEY, symbol.trim());
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <GlassCard>
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-40 rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-200"
          placeholder="AAPL / 005930.KS"
        />
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded border border-slate-700/70 bg-slate-900/60 px-2 py-1 text-[12px] text-slate-300"
        >
          {["auto", "pykrx", "stooq", "baostock"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12px] text-primary disabled:opacity-50"
        >
          拉取
        </button>
        {data && (
          <span className="text-[11px] text-slate-500">
            {data.name || data.code} · {data.source} · {data.adjust}
          </span>
        )}
      </form>
      {sources && (
        <p className="mb-2 text-[11px] text-slate-500">
          {Object.entries(sources)
            .map(([k, v]) => `${k}${v.ok ? "" : " (未装)"}`)
            .join(" · ")}
        </p>
      )}
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      {loading && !data ? (
        <EmptyState title="K 线" loading />
      ) : data?.bars?.length ? (
        <Suspense fallback={<PageFallback />}>
          <ResearchKlineChart data={data} />
        </Suspense>
      ) : (
        <EmptyState title="K 线" />
      )}
    </GlassCard>
  );
}
