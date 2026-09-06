import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Thermometer, RefreshCw, Loader2, AlertCircle, Info, Gauge, CalendarClock, History, LineChart,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { useArchiveThenRefresh } from "../../../core/data/useArchiveThenRefresh";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { EChart } from "@/components/ui/EChart";
import { api, type GpuRentData, type GpuSpot, type ForwardMonth } from "@/lib/api";
import { cn } from "@/lib/utils";

// 产业信号：每期从公开零鉴权数据源移植一个「一句话信号」小栏目，逐期在此添加。
const TABS = [
  { key: "gpu-rent", label: "GPU租金", icon: Thermometer, desc: "近一年走势 + 现货中位价 + 远期资金预期" },
];

// 各型号折线颜色（主题橙留给旗舰 B200；中性灰文字两种主题下都可读）
const GPU_COLORS: Record<string, string> = {
  "B200": "#f97316", "H100 SXM": "#0ea5e9", "A100 SXM4": "#a78bfa",
};
const AXIS_COLOR = "#78716c";
const SPLIT_COLOR = "rgba(120,113,108,.18)";
const TOOLTIP_STYLE = {
  backgroundColor: "rgba(28,25,23,.92)", borderColor: "rgba(120,113,108,.3)",
  textStyle: { color: "#e7e5e4", fontSize: 12 },
};

// 数据是旧值回填（本轮抓取失败）时的提示徽标
function StaleBadge({ observedAt, fetchError }: { observedAt?: string | null; fetchError?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning"
      title={fetchError ? `本轮抓取失败：${fetchError}` : undefined}
    >
      <History className="h-3 w-3" /> 本轮抓取失败 · 显示 {observedAt || "上次"} 的数据
    </span>
  );
}

function SpotCard({ g }: { g: GpuSpot }) {
  if (g.err) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <div className="font-mono text-sm font-semibold">{g.gpu}</div>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> 抓取失败：{g.err}
        </p>
      </div>
    );
  }
  if (g.unavailable) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm font-semibold">{g.gpu}</span>
          {g.stale && <StaleBadge observedAt={g.observed_at} fetchError={g.fetch_error} />}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{g.note || "当前无在租报价"}</p>
        <p className="mt-1 text-[11px] text-muted-foreground/60">这是市场状态，不是数据故障。</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-sm font-semibold">
          <span className="h-2 w-2 rounded-full" style={{ background: GPU_COLORS[g.gpu] || "#f97316" }} />
          {g.gpu}
        </span>
        {g.stale && <StaleBadge observedAt={g.observed_at} fetchError={g.fetch_error} />}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-extrabold tracking-tight text-primary text-glow">${g.median?.toFixed(2)}</span>
        <span className="text-xs text-muted-foreground">/卡·时（中位）</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          = 上方曲线最新点
          {g.asof_ts != null && `（${new Date(g.asof_ts * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 观测）`}
        </span>
        {g.available_gpus != null && g.total_gpus != null && g.total_gpus > 0 && (
          <span>
            可租 {g.available_gpus} / 共 {g.total_gpus} 张（{Math.round((1 - g.available_gpus / g.total_gpus) * 100)}% 在租）
          </span>
        )}
      </div>
    </div>
  );
}

// 远期单月：一句话总结 + 概率分布柱图
function ForwardMonthPanel({ m }: { m: ForwardMonth }) {
  const im = m.implied_median;
  const impliedText = !im ? null
    : im.bound === "exact" ? `$${im.value.toFixed(2)}`
    : im.bound === "above" ? `高于 $${im.value}（最高档之上）`
    : `低于 $${im.value}（最低档之下）`;
  const mlIndex = m.distribution.findIndex((b) => b.label === m.most_likely.label);

  const option = useMemo(() => ({
    grid: { left: 44, right: 16, top: 24, bottom: 44 },
    tooltip: {
      trigger: "axis" as const, ...TOOLTIP_STYLE,
      valueFormatter: (v: unknown) => `${v}%`,
    },
    xAxis: {
      type: "category" as const,
      data: m.distribution.map((b) => b.label),
      axisLabel: { color: AXIS_COLOR, fontSize: 10, rotate: 32 },
      axisLine: { lineStyle: { color: SPLIT_COLOR } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: "{value}%" },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    },
    series: [{
      name: "概率", type: "bar" as const, barMaxWidth: 34,
      data: m.distribution.map((b, i) => ({
        value: +(b.p * 100).toFixed(1),
        itemStyle: { color: i === mlIndex ? "#f97316" : "rgba(249,115,22,.32)", borderRadius: [4, 4, 0, 0] },
      })),
    }],
  }), [m, mlIndex]);

  return (
    <div>
      {/* 一句话总结：预期多少钱 + 概率多少 */}
      <div className="mb-3 rounded-xl border border-primary/25 bg-primary/5 p-3.5 text-sm leading-relaxed">
        市场当前对 <b className="font-mono">{m.month}</b> 月均租金（B200）的预期：
        {impliedText && <>中位约 <b className="text-primary">{impliedText}</b>/卡·时，</>}
        最可能落在 <b className="text-primary">{m.most_likely.label}</b>
        （概率 <b className="text-primary">{(m.most_likely.p * 100).toFixed(0)}%</b>）。
        <span className="text-xs text-muted-foreground">
          按 Ornn 跨平台指数的整月平均结算——是「整月均价」，与上方「此刻」的现货挂单价口径不同，数值不能直接对比。
        </span>
      </div>
      <EChart option={option} height={230} />
      <p className="mt-1 text-center text-[11px] text-muted-foreground/60">
        {m.month} 月均租金落在各价位区间的预期概率 · {m.close_date} 结算
      </p>
    </div>
  );
}

function GpuRentPanel() {
  const [activeMonth, setActiveMonth] = useState(0);

  // 打开先给存档、后台再刷（见 core/data/useArchiveThenRefresh）：
  // 这一页要拉一年曲线 + 三张卡的挂单数 + 十几个远期合约，干等好几十秒没有必要。
  const { data, err, loading, refreshing, staleNote, refresh } =
    useArchiveThenRefresh<GpuRentData>((r) => (r ? api.gpuRentRefresh() : api.gpuRent()), []);

  const hasData = !!data?.generated_at;
  const fw = data?.forward;
  const months = fw?.months || [];
  const month = months[Math.min(activeMonth, Math.max(months.length - 1, 0))];
  const histGpus = data?.history?.gpus || [];
  const histStale = histGpus.filter((g) => g.stale);

  // 主图：近一年三条日线。刻意不把 Kalshi 远期画进来——它按 Ornn 指数「整月平均」
  // 结算，与 Vast 日中位是两个市场两种口径，拼在一条线上会误导（实测就被看出"冲突"）。
  const trendOption = useMemo(() => {
    const series: Record<string, unknown>[] = histGpus
      .filter((g) => g.points && g.points.length > 0)
      .map((g) => ({
        name: g.gpu, type: "line", showSymbol: false,
        data: g.points!.map(([t, v]) => [t * 1000, v]),
        lineStyle: { width: 1.8 }, itemStyle: { color: GPU_COLORS[g.gpu] || "#f97316" },
        emphasis: { focus: "series" },
      }));
    return {
      grid: { left: 44, right: 20, top: 40, bottom: 28 },
      legend: { top: 4, textStyle: { color: AXIS_COLOR, fontSize: 11 }, itemWidth: 16 },
      tooltip: {
        trigger: "axis" as const, ...TOOLTIP_STYLE,
        valueFormatter: (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : `${v}`),
      },
      xAxis: {
        type: "time" as const,
        axisLabel: { color: AXIS_COLOR, fontSize: 10 },
        axisLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: "${value}" },
        splitLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      series,
    };
  }, [histGpus]);

  const settledText = (fw?.settled || [])
    .map((s) => `${s.month} 实际落在 ${s.lo != null && s.hi != null ? `$${s.lo}~${s.hi}` : s.lo != null ? `≥$${s.lo}` : `<$${s.hi}`} 档`)
    .join(" · ");

  // 预期曲线（term structure）：已结算月的实际落点 + 各在市结算月的隐含预期中位。
  // 两段都是 Ornn 指数「月均」口径——同一把尺子，连成一条时间线是合法的
  // （与 Vast 日中位历史曲线不同口径，所以这张图独立放在远期区、不与上方主图混）。
  const curveOption = useMemo(() => {
    // 只画有完整区间的结算月：单边结果（全 yes / 全 no）只是「高于/低于某档」的
    // 开放区间，画成精确点就是把边界当实际值——那些月留在下方文字行里表述
    const actual = (fw?.settled || [])
      .filter((s) => s.lo != null && s.hi != null)
      .map((s) => ({ month: s.month, mid: (s.lo! + s.hi!) / 2 }));
    const expected = months
      .filter((m) => m.implied_median?.bound === "exact")
      .map((m) => ({ month: m.month, mid: m.implied_median!.value }));
    const cats = [...new Set([...actual.map((a) => a.month), ...expected.map((e) => e.month)])].sort();
    const lastActualIdx = actual.length ? cats.indexOf(actual[actual.length - 1]!.month) : -1;
    const actualData = cats.map((c) => actual.find((a) => a.month === c)?.mid ?? null);
    // 预期线从最后一个实际点起笔，视觉上连续
    const expectedData = cats.map((c, i) => {
      const e = expected.find((x) => x.month === c);
      if (e) return e.mid;
      return i === lastActualIdx ? actual[actual.length - 1]!.mid : null;
    });
    return {
      grid: { left: 44, right: 20, top: 34, bottom: 28 },
      legend: { top: 2, textStyle: { color: AXIS_COLOR, fontSize: 11 }, itemWidth: 16 },
      tooltip: {
        trigger: "axis" as const, ...TOOLTIP_STYLE,
        valueFormatter: (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : "—"),
      },
      xAxis: {
        type: "category" as const, data: cats,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, rotate: 28 },
        axisLine: { lineStyle: { color: SPLIT_COLOR } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value" as const, scale: true,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: "${value}" },
        splitLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      series: [
        {
          name: "已结算月实际（区间中点）", type: "line" as const, data: actualData,
          symbol: "circle", symbolSize: 7, lineStyle: { width: 2 },
          itemStyle: { color: "#8095b5" }, connectNulls: false,
        },
        {
          name: "市场预期中位", type: "line" as const, data: expectedData,
          symbol: "circle", symbolSize: 5, lineStyle: { width: 2, type: "dashed" as const },
          itemStyle: { color: "#f97316" }, connectNulls: false,
        },
      ],
    };
  }, [fw, months]);
  const hasCurve = months.some((m) => m.implied_median?.bound === "exact");

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{hasData ? `更新于 ${data!.generated_at}` : "历史 / 现货 / 远期三条腿，都来自零鉴权公开接口"}</span>
          {/* 🔴 先给存档、后台刷 ⇒ 用户必须看得出他现在看的是哪一份 */}
          {refreshing && hasData && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> 刷新中（下面是上次的存档）
            </span>
          )}
          {loading && <span className="text-[11px]">正在取…（这一页还没有存档）</span>}
          {staleNote && <span className="text-[11px] text-warning">{staleNote}</span>}
        </span>
        <button onClick={refresh} disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {refreshing ? "抓取中…（远期 123 张合约逐档拉取，约 1 分钟）" : "刷新"}
        </button>
      </div>

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}
      {data?.errors && data.errors.length > 0 && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
          <p className="mb-1 font-medium">本轮有数据源抓取失败（对应区块显示上一次的数据）：</p>
          {data.errors.map((e, i) => <p key={i}>· {e}</p>)}
        </div>
      )}

      {!hasData && !err ? (
        <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground/70">
          还没有抓取数据，点上方<b className="text-foreground">「刷新」</b>拉取（约 30 秒）。
        </div>
      ) : hasData && (
        <>
          {/* ① 近一年走势 */}
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
            <LineChart className="h-4 w-4 text-primary" /> 近一年租金走势 · 每日中位价
            {histStale.length > 0 && <StaleBadge observedAt={histStale[0]!.observed_at} fetchError={histStale[0]!.fetch_error} />}
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground/70">
            {data!.history_source}
          </p>
          {histGpus.some((g) => g.points?.length) ? (
            <EChart option={trendOption} height={320} />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground/60">
              历史序列暂不可用{histGpus.find((g) => g.err) ? `：${histGpus.find((g) => g.err)!.err}` : ""}
            </p>
          )}

          {/* ② 现货 */}
          <div className="mb-1.5 mt-6 flex items-center gap-1.5 text-sm font-semibold">
            <Gauge className="h-4 w-4 text-primary" /> 现货租金 · 最新观测值
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground/70">{data!.spot_source}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {data!.spot.gpus.map((g) => <SpotCard key={g.gpu} g={g} />)}
          </div>

          {/* ③ 远期 */}
          <div className="mb-1.5 mt-6 flex items-center gap-1.5 text-sm font-semibold">
            <CalendarClock className="h-4 w-4 text-primary" /> 远期 · 全球资金的预期概率（仅 B200）
            {fw?.stale && <StaleBadge observedAt={fw.observed_at} fetchError={fw.fetch_error} />}
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground/70">
            {data!.forward_source}
            {fw?.n_contracts != null && ` · 在市合约 ${fw.n_contracts} 张 · 有报价结算月 ${months.length} 个${
              fw.n_months != null && fw.n_months > months.length ? `（另 ${fw.n_months - months.length} 个月暂无报价）` : ""}`}
          </p>
          {fw?.err ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> 抓取失败：{fw.err}
            </p>
          ) : fw?.unavailable ? (
            <p className="text-sm text-muted-foreground">{fw.note}（市场状态，非故障）</p>
          ) : months.length > 0 ? (
            <>
              {/* 预期曲线：远期是涨是跌一眼看清（实线=已结算实际，虚线=各月预期中位，同为月均口径） */}
              {hasCurve && (
                <div className="mb-4">
                  <EChart option={curveOption} height={240} />
                  <p className="mt-1 text-center text-[11px] text-muted-foreground/60">
                    同一把尺子（Ornn 指数月均）：实线 = 已结算月的实际落点（取区间中点），虚线 = 各结算月的市场预期中位
                  </p>
                </div>
              )}
              <div className="mb-3 flex flex-wrap gap-2">
                {months.map((m, i) => (
                  <button key={m.month} onClick={() => setActiveMonth(i)}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-xs transition-colors",
                      i === Math.min(activeMonth, months.length - 1)
                        ? "border-primary bg-primary/15 font-medium text-primary shadow-glow"
                        : "border-primary/25 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                    )}>
                    {m.month}
                  </button>
                ))}
              </div>
              {month && <ForwardMonthPanel m={month} />}
              {settledText && (
                <p className="mt-3 text-[11px] text-muted-foreground/70">
                  已结算月份（月均实际落点，可与上方历史曲线互证）：{settledText}
                </p>
              )}
            </>
          ) : null}

          {/* ④ 怎么读 */}
          <div className="mt-6 rounded-xl border border-border/60 bg-muted/20 p-4">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Info className="h-4 w-4 text-primary" /> 怎么读这组数（三条口径边界）
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
              {data!.how_to_read.map((h, i) => <li key={i}>{h}</li>)}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}

export function Signals() {
  // 当前小栏目由路由驱动（/signals/:tab），与侧栏子项联动；不认识的参数回落到第一个
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam! : TABS[0]!.key;
  const cur = TABS.find((t) => t.key === tab)!;

  useAiPage({
    key: `signals:${tab}`,
    title: `产业信号 · ${cur.label}`,
    context: `产业信号 · 当前小栏目「${cur.label}」：${cur.desc}。可选小栏目：${TABS.map((t) => t.label).join("、")}。`,
    suggestions: ["这个信号怎么读", "它领先还是滞后", "什么情况下算转向"],
  });

  return (
    <div>
      <PageHeader title="产业信号" subtitle="一句话产业信号：零鉴权公开数据直连，逐期添加小栏目" />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => navigate(`/signals/${key}`)}
            className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
              tab === key ? "bg-primary/15 font-medium text-primary shadow-glow" : "text-muted-foreground hover:bg-muted/50")}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <GlassCard glow>
        <div className="mb-3 flex items-center gap-2">
          <cur.icon className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">{cur.label}</h3>
          <span className="text-xs text-muted-foreground">{cur.desc}</span>
        </div>
        {cur.key === "gpu-rent" && <GpuRentPanel />}
      </GlassCard>

      <p className="mt-3 text-[11px] text-muted-foreground/60">
        只呈现公开接口的价格事实与合约报价，不产出「过剩 / 短缺」的判断、不构成任何建议——怎么解读，交给你自己接入的 AI（工具名 query_gpu_rent）。
      </p>
      <Disclaimer />
    </div>
  );
}
