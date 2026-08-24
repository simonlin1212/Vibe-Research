import { useState, useEffect, useCallback, useRef } from "react";
import * as echarts from "echarts";
import {
  RefreshCw, Loader2, AlertCircle, LogIn, LogOut, ChevronDown, ChevronLeft, ChevronRight, Terminal, ShieldCheck,
} from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { GlanceStrip, type GlanceMetric } from "@/components/ui/GlanceStrip";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { useSectionOpen } from "@/hooks/useExpandAll";
import {
  api, ApiError, type CtpPortfolioData, type CtpStatus, type CtpLogEntry, type CtpSettlementRangeData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { storageGet, storageSet } from "@/lib/storage";
import { fmt, fmtPx, pctInt, pnlColor, signed, wanInt, ymdInput, ymdSpanDays } from "@/components/portfolio/format";
import {
  CAL_METRICS, SETTLE_CHARTS, WEEK_LABELS, buildCalDays, foldLiveMonthly,
  foldLiveSummary, liveSettlePreview, ctpTh, td,
  type CalMetric, type SettleChartKey,
} from "@/components/portfolio/ctpUtils";

const SETTLE_RANGE_START_KEY = "ctp.settle.rangeStart.v2";
const SETTLE_RANGE_END_KEY = "ctp.settle.rangeEnd.v2";
const DEFAULT_SETTLE_START = "2026-04-08";

function previewLive(data: CtpPortfolioData | null, range: CtpSettlementRangeData | null) {
  return liveSettlePreview({
    equity: data?.account?.market_equity ?? data?.account?.client_equity ?? data?.account?.balance,
    tradingDay: data?.trading_day,
    deposit: data?.account?.deposit,
    withdraw: data?.account?.withdraw,
    commission: data?.account?.commission,
    perf: range?.analytics?.perf,
    fallbackDate: ymdInput(new Date()),
  });
}

function loadSavedYmd(key: string, fallback: string): string {
  const s = storageGet(key);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

export function CtpPortfolio() {
  const [status, setStatus] = useState<CtpStatus | null>(null);
  const [data, setData] = useState<CtpPortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logs, setLogs] = useState<CtpLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [rangeStart, setRangeStart] = useState(() => loadSavedYmd(SETTLE_RANGE_START_KEY, DEFAULT_SETTLE_START));
  const [rangeEnd, setRangeEnd] = useState(() => loadSavedYmd(SETTLE_RANGE_END_KEY, ymdInput(new Date())));
  const [rangeForce, setRangeForce] = useState(false);
  const [rangeData, setRangeData] = useState<CtpSettlementRangeData | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [settleChart, setSettleChart] = useState<SettleChartKey>("nav");
  const [settleTab, setSettleTab] = useState<"settle" | "calendar">("settle");
  const [calMode, setCalMode] = useState<"day" | "month">("day");
  const [calMetric, setCalMetric] = useState<CalMetric>("income");
  const [calYm, setCalYm] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const equityChartRef = useRef<HTMLDivElement>(null);
  const equityChartInst = useRef<echarts.ECharts | null>(null);
  const sinceRef = useRef(0);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const loggedIn = !!(status?.logged_in);
  const [sub, setSub] = useState<"positions" | "details" | "orders" | "trades">("positions");
  // Chart DOM unmounts when settlement CollapsibleSection is closed; re-init on open.
  const [settleOpen] = useSectionOpen("ctp.settlement", false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.ctpStatus());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "读取 CTP 配置状态失败");
    }
  }, []);

  const pullLogs = useCallback(async () => {
    try {
      const d = await api.ctpLogs(sinceRef.current);
      if (d.logs.length) {
        setLogs((prev) => {
          const merged = [...prev, ...d.logs];
          return merged.length > 400 ? merged.slice(-400) : merged;
        });
        sinceRef.current = d.next_since;
      } else {
        sinceRef.current = d.next_since;
      }
      if (d.logged_in !== status?.logged_in) {
        setStatus((s) => (s ? { ...s, logged_in: d.logged_in } : s));
      }
    } catch { /* ignore poll errors */ }
  }, [status?.logged_in]);

  useEffect(() => {
    storageSet(SETTLE_RANGE_START_KEY, rangeStart);
  }, [rangeStart]);
  useEffect(() => {
    storageSet(SETTLE_RANGE_END_KEY, rangeEnd);
  }, [rangeEnd]);

  // Hydrate status + portfolio if session still open
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.ctpStatus();
        if (cancelled) return;
        setStatus(s);
        if (!s.logged_in) return;
        setQuerying(true);
        try {
          const d = await api.ctpPortfolio();
          if (!cancelled) setData(d);
        } catch (e) {
          if (!cancelled) setErr(e instanceof ApiError ? e.message : "CTP 查询失败");
        } finally {
          if (!cancelled) setQuerying(false);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : "读取 CTP 配置状态失败");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Poll logs while on this tab; faster during login/query
  useEffect(() => {
    pullLogs();
    const ms = loggingIn || querying ? 400 : 1500;
    const t = setInterval(pullLogs, ms);
    return () => clearInterval(t);
  }, [pullLogs, loggingIn, querying]);

  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (loggingIn || querying) setLogsOpen(true);
    else if (data && loggedIn) setLogsOpen(false);
  }, [loggingIn, querying, data, loggedIn]);

  const doLogin = async () => {
    setLoggingIn(true);
    setErr(null);
    try {
      const r = await api.ctpLogin();
      if (r.portfolio) setData(r.portfolio);
      await loadStatus();
      await pullLogs();
      if (!r.logged_in) setErr(r.message || "登录未成功");
      else if (!r.portfolio && r.message.includes("查询失败")) setErr(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "CTP 登录失败");
      await loadStatus();
      await pullLogs();
    } finally {
      setLoggingIn(false);
    }
  };

  const doLogout = async () => {
    setLoggingOut(true);
    setErr(null);
    try {
      await api.ctpLogout();
      setData(null);
      await loadStatus();
      await pullLogs();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "退出失败");
    } finally {
      setLoggingOut(false);
    }
  };

  const query = async () => {
    setQuerying(true);
    setErr(null);
    try {
      const d = await api.ctpPortfolio();
      setData(d);
      await loadStatus();
      await pullLogs();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "CTP 查询失败");
      await pullLogs();
    } finally {
      setQuerying(false);
    }
  };

  // Poll background 市值权益 (option ticks are rate-limited; must not block portfolio)
  useEffect(() => {
    const pending = !!(data?.market_equity_pending || data?.account?.market_equity_pending);
    if (!pending || !loggedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await api.ctpMarketEquity();
        if (cancelled) return;
        if (job.status === "ready" && job.account_patch) {
          const patch = job.account_patch;
          setData((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              market_equity_pending: false,
              account: {
                ...prev.account,
                ...patch,
                market_equity_pending: false,
              },
              totals: {
                ...prev.totals,
                market_equity: patch.market_equity ?? prev.totals.market_equity,
                option_long_value: patch.option_long_value ?? prev.totals.option_long_value,
                option_short_value: patch.option_short_value ?? prev.totals.option_short_value,
              },
            };
          });
          void pullLogs();
          return;
        }
        if (job.status === "error") {
          setData((prev) => prev
            ? {
              ...prev,
              market_equity_pending: false,
              account: { ...prev.account, market_equity_pending: false },
            }
            : prev);
          void pullLogs();
          return;
        }
        timer = setTimeout(poll, 1200);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 600);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [data?.market_equity_pending, data?.account?.market_equity_pending, data?.updated, loggedIn, pullLogs]);

  const loadSettlementRange = async (refresh: boolean) => {
    const start = rangeStart.replace(/-/g, "");
    const end = rangeEnd.replace(/-/g, "");
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) {
      setErr("请选择有效的开始/结束日期");
      return;
    }
    const span = ymdSpanDays(rangeStart, rangeEnd);
    if (!Number.isFinite(span) || span < 1) {
      setErr("开始日期不能晚于结束日期");
      return;
    }
    if (refresh && !loggedIn) {
      setErr("补拉缺失结算单需先登录 CTP");
      return;
    }
    setRangeLoading(true);
    setErr(null);
    try {
      const d = await api.ctpSettlementRange({
        start,
        end,
        refresh,
        force: refresh && rangeForce,
      });
      setRangeData(d);
      await pullLogs();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "结算区间查询失败");
      await pullLogs();
    } finally {
      setRangeLoading(false);
    }
  };

  // Load cached settlement when account panel is available (no CTP)
  useEffect(() => {
    if (!(loggedIn || data) || rangeData || rangeLoading) return;
    void loadSettlementRange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, data]);

  // Jump calendar to latest month with data when range loads
  useEffect(() => {
    if (!rangeData?.analytics) return;
    const days = buildCalDays(rangeData, previewLive(data, rangeData));
    if (!days.length) return;
    setCalYm(days[days.length - 1].date.slice(0, 7));
  }, [rangeData, data?.account?.market_equity, data?.account?.client_equity, data?.account?.balance, data?.trading_day]);

  // Settlement performance charts
  useEffect(() => {
    if (!settleOpen || settleTab !== "settle") {
      if (!settleOpen && equityChartInst.current) {
        equityChartInst.current.dispose();
        equityChartInst.current = null;
      }
      return;
    }
    const el = equityChartRef.current;
    if (!el) return;
    const meta = SETTLE_CHARTS.find((c) => c.key === settleChart)!;
    let raw = (rangeData?.analytics?.charts?.[settleChart]
      || (settleChart === "equity"
        ? (rangeData?.chart || []).map((p) => ({ date: p.date, value: p.equity }))
        : [])
    ).map((p) => ({ date: p.date, value: p.value, live: false as boolean }));

    // Append today's live point when settlement bill for trading day is missing
    let liveAppended = false;
    {
      const live = previewLive(data, rangeData);
      if (live) {
        const liveValue =
          settleChart === "equity" ? live.equity
          : settleChart === "nav" ? live.nav
          : settleChart === "cum_return" ? (live.nav - 1) * 100
          : settleChart === "cum_pnl_wan" ? live.cumIncome / 10000
          : null;
        if (liveValue != null && Number.isFinite(liveValue)) {
          raw = [...raw, { date: live.date, value: liveValue, live: true }];
          liveAppended = true;
        }
      } else if (settleChart === "equity") {
        const liveEq = data?.account?.market_equity ?? data?.account?.client_equity ?? data?.account?.balance;
        const td = (data?.trading_day || "").replace(/-/g, "");
        const liveDate = /^\d{8}$/.test(td)
          ? `${td.slice(0, 4)}-${td.slice(4, 6)}-${td.slice(6, 8)}`
          : ymdInput(new Date());
        const hasLive = liveEq != null && Number.isFinite(Number(liveEq));
        const hasSettleDay = raw.some((p) => p.date === liveDate);
        if (hasLive && !hasSettleDay && !(rangeData?.analytics?.perf || []).length) {
          raw = [{ date: liveDate, value: Number(liveEq), live: true }];
          liveAppended = true;
        }
      }
    }

    if (!equityChartInst.current) {
      equityChartInst.current = echarts.init(el);
    }
    const inst = equityChartInst.current;
    const css = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const cText = `hsl(${css("--muted-foreground", "215 16% 57%")})`;
    const cAxis = `hsl(${css("--border", "217 20% 22%")})`;
    const cGrid = `hsl(${css("--border", "217 20% 22%")})`;
    const cLine = "#ffcc00";
    if (!raw.length) {
      inst.clear();
      inst.setOption({
        title: {
          text: "暂无足够结算数据",
          left: "center",
          top: "center",
          textStyle: { color: cText, fontSize: 13, fontWeight: 400 },
        },
      });
      return;
    }
    const dates = raw.map((p) => p.date);
    const vals = raw.map((p) => p.value);
    const axisFmt = (v: number) => {
      if (settleChart === "equity") return `${Math.round(v / 10000)}万`;
      if (settleChart === "cum_pnl_wan") return `${Math.round(v)}万`;
      if (settleChart === "cum_return") return `${Math.round(v)}%`;
      if (settleChart === "nav") return Number(v).toFixed(4);
      return String(v);
    };
    const tipFmt = (v: number) => {
      if (settleChart === "equity") {
        return `${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
      }
      if (settleChart === "cum_pnl_wan") {
        const yuan = v * 10000;
        return `${yuan.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
      }
      if (settleChart === "cum_return") return `${v.toFixed(2)}%`;
      if (settleChart === "nav") return Number(v).toFixed(4);
      return String(v);
    };
    const cornerText = (idx: number) => {
      const i = Math.max(0, Math.min(idx, raw.length - 1));
      const p = raw[i];
      const tag = p.live ? " · 实时" : "";
      return `${p.date}${tag}\n${meta.label} ${tipFmt(p.value)}`;
    };
    const lastIdx = raw.length - 1;
    const seriesData = vals.map((v, i) => {
      if (liveAppended && i === lastIdx) {
        return {
          value: v,
          symbol: "circle",
          symbolSize: 8,
          itemStyle: { color: cLine, borderColor: "#fff", borderWidth: 1 },
        };
      }
      return v;
    });

    inst.setOption({
      animation: false,
      title: {
        show: true,
        left: 56,
        top: 6,
        text: cornerText(lastIdx),
        textStyle: {
          color: cText,
          fontSize: 12,
          fontWeight: 400,
          lineHeight: 18,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        },
      },
      // Keep axis pointer, hide floating popup — values shown in title (top-left)
      tooltip: {
        trigger: "axis",
        showContent: false,
        axisPointer: { type: "line", lineStyle: { color: cAxis, type: "dashed" } },
      },
      grid: { left: 52, right: 20, top: 44, bottom: 40, containLabel: false },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: cAxis } },
        axisLabel: { color: cText, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: meta.unit,
        nameTextStyle: { color: cText, fontSize: 10 },
        splitLine: { lineStyle: { color: cGrid, opacity: 0.35 } },
        axisLabel: { color: cText, fontSize: 10, formatter: (v: number) => axisFmt(v) },
      },
      series: [
        {
          name: meta.label,
          type: "line",
          data: seriesData,
          showSymbol: false,
          symbol: "circle",
          symbolSize: 6,
          connectNulls: true,
          lineStyle: { width: 2, color: cLine },
          itemStyle: { color: cLine },
          emphasis: { focus: "none", scale: true, lineStyle: { width: 2.5, color: cLine }, itemStyle: { color: cLine } },
          blur: { lineStyle: { opacity: 1, color: cLine }, itemStyle: { opacity: 1 } },
        },
      ],
    }, { notMerge: true });

    // Layout may still be shifting (left account cards mount after funds query).
    // Resize after paint so the canvas matches the final grid width.
    const bumpResize = () => {
      try {
        inst.resize({ width: "auto", height: "auto" });
      } catch {
        inst.resize();
      }
    };
    requestAnimationFrame(() => {
      bumpResize();
      requestAnimationFrame(bumpResize);
    });
    const resizeTimers = [50, 200, 400].map((ms) => window.setTimeout(bumpResize, ms));

    const setCorner = (idx: number) => {
      inst.setOption({ title: { text: cornerText(idx) } }, { lazyUpdate: true });
    };

    const resolveIdx = (ev: unknown): number | null => {
      const e = ev as {
        currTrigger?: string;
        axesInfo?: Array<{
          axisDim?: string;
          value?: number | string;
          seriesDataIndices?: Array<{ dataIndex?: number }>;
        }>;
      };
      if (e?.currTrigger === "leave") return null;
      const xAxis = (e.axesInfo ?? []).find((a) => a.axisDim === "x") ?? e.axesInfo?.[0];
      const fromSeries = xAxis?.seriesDataIndices?.find((s) => Number.isInteger(s?.dataIndex));
      if (fromSeries && Number.isInteger(fromSeries.dataIndex)) {
        return fromSeries.dataIndex as number;
      }
      const val = xAxis?.value;
      // Category axis often reports index as number, not date label
      if (typeof val === "number" && Number.isFinite(val)) {
        const i = Math.round(val);
        if (i >= 0 && i < dates.length) return i;
      }
      if (val != null) {
        const i = dates.indexOf(String(val));
        if (i >= 0) return i;
      }
      return null;
    };

    const onPointer = (ev: unknown) => {
      const idx = resolveIdx(ev);
      if (idx == null) {
        setCorner(lastIdx);
        return;
      }
      setCorner(idx);
    };

    // Fallback: pixel -> category index (when axesInfo is empty)
    const zr = inst.getZr();
    const onMove = (e: { offsetX: number; offsetY: number }) => {
      const point: [number, number] = [e.offsetX, e.offsetY];
      try {
        if (!inst.containPixel({ gridIndex: 0 }, point)) return;
        const data = inst.convertFromPixel({ xAxisIndex: 0 }, point);
        const xVal = Array.isArray(data) ? data[0] : data;
        const di = Math.round(Number(xVal));
        if (Number.isFinite(di) && di >= 0 && di < dates.length) setCorner(di);
      } catch {
        /* ignore during dispose */
      }
    };
    const onGlobalOut = () => setCorner(lastIdx);

    inst.off("updateAxisPointer");
    inst.on("updateAxisPointer", onPointer);
    zr.off("mousemove", onMove);
    zr.off("globalout", onGlobalOut);
    zr.on("mousemove", onMove);
    zr.on("globalout", onGlobalOut);

    const onWinResize = () => bumpResize();
    window.addEventListener("resize", onWinResize);
    return () => {
      resizeTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("resize", onWinResize);
      inst.off("updateAxisPointer", onPointer);
      zr.off("mousemove", onMove);
      zr.off("globalout", onGlobalOut);
    };
  }, [rangeData, settleChart, settleTab, settleOpen, data?.account?.market_equity, data?.account?.client_equity, data?.account?.balance, data?.account?.deposit, data?.account?.withdraw, data?.account?.commission, data?.trading_day]);

  // Keep chart sized when container width changes (account cards / tab switch / async ME)
  useEffect(() => {
    if (!settleOpen) return;
    const el = equityChartRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (settleTab !== "settle") return;
      const inst = equityChartInst.current;
      if (!inst) return;
      // Defer one frame: ResizeObserver can fire mid-layout
      requestAnimationFrame(() => {
        try {
          inst.resize({ width: "auto", height: "auto" });
        } catch {
          inst.resize();
        }
      });
    });
    ro.observe(el);
    // Also watch parent card — width often changes when left column appears
    const parent = el.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [settleTab, settleOpen, !!data?.account, rangeData?.analytics?.summary?.days]);

  useEffect(() => () => {
    equityChartInst.current?.dispose();
    equityChartInst.current = null;
  }, []);

  const acc = data?.account;
  const positions = data?.positions || [];
  const details = data?.details || [];
  const orders = data?.orders || [];
  const trades = data?.trades || [];
  const totals = data?.totals;
  const busy = loggingIn || querying || loggingOut;

  const aiContext = data
    ? `我的期货账户(CTP 只读)：交易日${data.trading_day} 权益${acc?.balance ?? "-"} 可用${acc?.available ?? "-"} 持仓盈亏${totals?.position_profit ?? 0}\n` +
      `持仓:\n` + positions.map((p) => `${p.instrument} ${p.direction} ${p.position}手 持仓盈亏${p.position_profit} 保证金${p.use_margin}`).join("\n") +
      `\n持仓明细(${details.length}):\n` + details.slice(0, 30).map((d) => `${d.open_date} ${d.instrument} ${d.direction} 开仓价${d.open_price} 余${d.volume} 平仓盈亏(逐笔)${d.close_profit_by_trade} 持仓盈亏(逐笔)${d.position_profit_by_trade}`).join("\n") +
      `\n委托(${orders.length}):\n` + orders.slice(0, 20).map((o) => `${o.insert_time} ${o.instrument} ${o.direction}${o.offset} ${o.volume_traded}/${o.volume_total}@${o.limit_price} ${o.status}`).join("\n") +
      `\n成交(${trades.length}):\n` + trades.slice(0, 20).map((t) => `${t.trade_time} ${t.instrument} ${t.direction}${t.offset} ${t.volume}@${t.price}`).join("\n")
    : "期货账户：尚未查询。";

  const statusLabel = loggingIn || status?.logging_in
    ? "登录中"
    : loggedIn
      ? "已连接"
      : "未连接";
  const statusTone = loggingIn || status?.logging_in
    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/30"
    : loggedIn
      ? "bg-success/15 text-success ring-1 ring-success/30"
      : "bg-muted/60 text-muted-foreground ring-1 ring-border/60";
  const risk = acc?.risk_ratio ?? 0;
  const riskTone = risk >= 80 ? "text-danger" : risk >= 50 ? "text-amber-600 dark:text-amber-400" : "text-foreground";
  const riskBar = risk >= 80 ? "bg-danger" : risk >= 50 ? "bg-amber-500" : "bg-primary";
  const hasBook = !!(data || loggedIn);
  const posByTrade = totals?.detail_position_profit ?? 0;
  const closeByTrade = totals?.detail_close_profit ?? 0;
  const dayPnl = Math.round((posByTrade + closeByTrade) * 100) / 100;
  const glanceEquity = acc
    ? (acc.market_equity ?? acc.client_equity ?? acc.balance)
    : null;
  const ctpGlance: GlanceMetric[] = acc && Object.keys(acc).length > 0
    ? [
        { label: "权益", value: fmt(glanceEquity ?? 0), tone: "primary" },
        { label: "可用", value: fmt(acc.available), tone: "muted" },
        {
          label: "风险度",
          value: `${risk}%`,
          tone: risk >= 80 ? "up" : risk >= 50 ? "flat" : "down",
        },
        {
          label: "当日盈亏",
          value: (totals?.detail_count ?? details.length) > 0 || dayPnl !== 0 ? signed(dayPnl) : "—",
          tone: dayPnl > 0 ? "up" : dayPnl < 0 ? "down" : "flat",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* Session bar */}
      <GlassCard className="!p-3 sm:!p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", statusTone)}>
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                loggingIn || status?.logging_in ? "animate-pulse bg-amber-500" : loggedIn ? "bg-success" : "bg-muted-foreground",
              )} />
              {statusLabel}
            </span>
            <div className="text-sm">
              <span className="font-semibold tracking-tight">CTP 交易账户</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">{status?.user_masked || "未配置"}</span>
            </div>
            {(status?.trading_day || data?.trading_day) && (
              <span className="rounded border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                交易日 {status?.trading_day || data?.trading_day}
              </span>
            )}
            {data?.updated && (
              <span className="text-[11px] text-muted-foreground/70">更新 {data.updated}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasBook && positions.length > 0 && (
              <AskAiButton context={aiContext} label="AI 看仓" scopeKey="ctp"
                suggestions={["持仓结构有什么风险", "保证金占用是否偏高", "帮我梳理多空敞口"]} />
            )}
            {!loggedIn ? (
              <button onClick={doLogin} disabled={busy || status?.ready === false}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground btn-press hover:opacity-90 disabled:opacity-50">
                {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                {loggingIn ? "登录中…" : "登录账户"}
              </button>
            ) : (
              <>
                <button onClick={query} disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm hover:border-primary/40 hover:text-foreground disabled:opacity-50">
                  {querying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {querying ? "刷新中…" : "刷新"}
                </button>
                <button onClick={doLogout} disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
                  {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                  退出
                </button>
              </>
            )}
          </div>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <span>只读查询 · 不下单不撤单 · 凭证存本机 <code className="rounded bg-muted/50 px-1">{status?.config_path || "~/.vibe-research/ctp.json"}</code></span>
        </p>
      </GlassCard>

      {status && !status.ready && (
        <GlassCard className="!p-4 border-amber-500/25">
          <h3 className="mb-2 text-sm font-semibold">账户尚未就绪</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {!status.dependency_ok && <li>· {status.dependency_msg || "请安装 openctp-ctp"}</li>}
            {!status.configured && (
              <li>· 配置 <code className="rounded bg-muted px-1">{status.config_path}</code>（参考 <code className="rounded bg-muted px-1">backend/ctp.json.example</code>）</li>
            )}
          </ul>
        </GlassCard>
      )}

      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {ctpGlance.length > 0 && (
        <GlanceStrip
          title="账户一眼"
          subtitle={data?.trading_day ? `交易日 ${data.trading_day}` : undefined}
          metrics={ctpGlance}
          onRefresh={loggedIn ? () => void query() : undefined}
          refreshing={querying}
        />
      )}

      {/* Empty state before first login */}
      {!hasBook && status?.ready && (
        <GlassCard glow>
          <EmptyState
            title="连接期货账户"
            description="登录后自动拉取资金、持仓、明细、委托与成交，做成一屏交易看板。"
            action={
              <button
                type="button"
                onClick={doLogin}
                disabled={busy}
                className="btn-press mt-1 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                登录账户
              </button>
            }
          />
        </GlassCard>
      )}

      {/* Left: account metrics (vertical) · Right: settlement */}
      {((acc && Object.keys(acc).length > 0) || hasBook) && (
        <div className="grid min-w-0 items-start gap-3 lg:grid-cols-12">
          {acc && Object.keys(acc).length > 0 && (
            <div className="flex min-w-0 flex-col gap-3 lg:col-span-4">
              <GlassCard glow className="!p-4">
                {(() => {
                  const clientEq = acc.client_equity ?? acc.balance;
                  const marketEq = acc.market_equity ?? clientEq;
                  const optLong = acc.option_long_value ?? 0;
                  const optShort = acc.option_short_value ?? 0;
                  const hasOpt = (acc.option_legs ?? 0) > 0 || optLong !== 0 || optShort !== 0;
                  const mePending = !!(acc.market_equity_pending || data?.market_equity_pending);
                  return (
                    <>
                      <p className="text-xs text-muted-foreground">
                        市值权益
                        {mePending ? <span className="ml-1.5 text-muted-foreground/70">计算中…</span> : null}
                      </p>
                      <p className="mt-1 font-mono text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">
                        {fmt(marketEq)}
                      </p>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          <span>客户权益 <b className="font-mono text-foreground">{fmt(clientEq)}</b></span>
                          <span>昨结 <b className="font-mono text-foreground">{fmt(acc.pre_balance)}</b></span>
                        </div>
                        {mePending ? (
                          <p className="text-[11px] text-muted-foreground/70">
                            期权行情后台拉取中(流控), 先显示客户权益
                          </p>
                        ) : hasOpt ? (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            <span>多头期权市值 <b className="font-mono text-foreground">{fmt(optLong)}</b></span>
                            <span>空头期权市值 <b className="font-mono text-foreground">{fmt(optShort)}</b></span>
                          </div>
                        ) : (
                          <p className="text-[11px] text-muted-foreground/70">
                            无期权持仓时市值权益=客户权益
                          </p>
                        )}
                      </div>
                    </>
                  );
                })()}
              </GlassCard>

              <GlassCard className="!p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">可用资金</p>
                    <p className="mt-1 font-mono text-xl font-bold tabular-nums sm:text-2xl">{fmt(acc.available)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">可取</p>
                    <p className="mt-1 font-mono text-base font-semibold tabular-nums">{fmt(acc.withdraw_quota ?? 0)}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">风险度</span>
                    <span className={cn("font-mono font-semibold", riskTone)}>{risk}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                    <div className={cn("h-full rounded-full transition-all", riskBar)} style={{ width: `${Math.min(100, Math.max(0, risk))}%` }} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <span>占用保证金 <b className="block font-mono text-sm text-foreground">{fmt(acc.curr_margin)}</b></span>
                    <span>交易所保证金 <b className="block font-mono text-sm text-foreground">{fmt(acc.exchange_margin ?? 0)}</b></span>
                  </div>
                </div>
              </GlassCard>

              <GlassCard className="!p-4">
                {(() => {
                  // Prefer 逐笔 from InvestorPositionDetail (account Close/PositionProfit often 0 intraday)
                  const posByTrade = totals?.detail_position_profit ?? 0;
                  const closeByTrade = totals?.detail_close_profit ?? 0;
                  const byTradeTotal = Math.round((posByTrade + closeByTrade) * 100) / 100;
                  const hasDetail = (totals?.detail_count ?? details.length) > 0;
                  return (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs text-muted-foreground">当日盈亏 · 逐笔</p>
                          <p className={cn("mt-1 font-mono text-xl font-bold tabular-nums sm:text-2xl", pnlColor(byTradeTotal))}>
                            {hasDetail || byTradeTotal !== 0 ? signed(byTradeTotal) : "—"}
                          </p>
                        </div>
                        <p className="text-right text-[10px] text-muted-foreground/70">
                          持仓明细汇总
                        </p>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-[11px] text-muted-foreground">持仓盈亏</p>
                          <p className={cn("mt-0.5 font-mono text-lg font-bold tabular-nums", pnlColor(posByTrade))}>
                            {signed(posByTrade)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">平仓盈亏</p>
                          <p className={cn("mt-0.5 font-mono text-lg font-bold tabular-nums", pnlColor(closeByTrade))}>
                            {signed(closeByTrade)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground">
                        <span>手续费 <b className="font-mono text-foreground">{fmt(acc.commission)}</b></span>
                        <span>冻结手续费 <b className="font-mono text-foreground">{fmt(acc.frozen_commission ?? 0)}</b></span>
                        <span>今日入金 <b className="font-mono text-foreground">{fmt(acc.deposit ?? 0)}</b></span>
                        <span>今日出金 <b className="font-mono text-foreground">{fmt(acc.withdraw ?? 0)}</b></span>
                      </div>
                    </>
                  );
                })()}
              </GlassCard>
            </div>
          )}

          <CollapsibleSection
            title="结算 / 盈亏日历"
            storageKey="ctp.settlement"
            defaultOpen={false}
            summary={
              rangeData?.stats
                ? `有效 ${(rangeData.analytics?.summary.days ?? rangeData.chart.length) + (previewLive(data, rangeData) ? 1 : 0)}`
                : undefined
            }
            className={cn(
              "mb-0 min-w-0",
              acc && Object.keys(acc).length > 0 ? "lg:col-span-8" : "lg:col-span-12",
            )}
          >
          <GlassCard glow className="!p-0 min-w-0 overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-border/50 px-3 sm:px-4">
              <div className="flex min-w-0 gap-0.5">
                {([
                  ["settle", "结算"],
                  ["calendar", "盈亏日历"],
                ] as const).map(([k, lab]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSettleTab(k)}
                    className={cn(
                      "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
                      settleTab === k
                        ? "font-semibold text-foreground after:absolute after:inset-x-2 after:bottom-0 after:z-10 after:h-0.5 after:rounded-full after:bg-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {lab}
                  </button>
                ))}
              </div>
              {rangeData?.stats && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 pb-2.5 text-[11px] text-muted-foreground">
                  <span>有效 {(rangeData.analytics?.summary.days ?? rangeData.chart.length) + (previewLive(data, rangeData) ? 1 : 0)}</span>
                  <span>缓存 {rangeData.stats.cached}</span>
                  {rangeData.stats.missing > 0 && <span>缺失 {rangeData.stats.missing}</span>}
                  {(rangeData.stats.deferred ?? 0) > 0 && (
                    <span className="text-warning">未拉完 {rangeData.stats.deferred} 天, 再点一次拉取</span>
                  )}
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-4 overflow-x-hidden p-3 sm:p-4">
              {/* Settlement defines height; calendar overlays and fills the same box */}
              <div className="relative min-w-0">
              <div className={cn(
                "space-y-4",
                settleTab !== "settle" && "invisible pointer-events-none",
              )}>
              <div className="flex min-w-0 flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  开始
                  <input
                    type="date"
                    value={rangeStart}
                    onChange={(e) => setRangeStart(e.target.value)}
                    className="max-w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  结束
                  <input
                    type="date"
                    value={rangeEnd}
                    onChange={(e) => setRangeEnd(e.target.value)}
                    className="max-w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                </label>
                <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rangeForce}
                    onChange={(e) => setRangeForce(e.target.checked)}
                    className="rounded border-border"
                  />
                  强制重查
                </label>
                <button
                  type="button"
                  disabled={rangeLoading}
                  onClick={() => void loadSettlementRange(false)}
                  className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-sm hover:border-primary/40 disabled:opacity-50"
                >
                  读缓存
                </button>
                <button
                  type="button"
                  disabled={rangeLoading || !loggedIn}
                  onClick={() => void loadSettlementRange(true)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium",
                    loggedIn && !rangeLoading
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "cursor-not-allowed bg-muted text-muted-foreground",
                  )}
                >
                  {rangeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {rangeLoading ? "拉取中…" : "拉取区间"}
                </button>
                <p className="basis-full text-[11px] text-muted-foreground/70">
                  柜台每次最多补拉 90 个交易日, 已缓存的会跳过; 没拉完再点一次即可.
                </p>
              </div>

              {rangeData?.analytics?.summary && rangeData.analytics.summary.days > 0 && (() => {
                const live = previewLive(data, rangeData);
                const s = foldLiveSummary(rangeData.analytics!.summary, rangeData.analytics!.perf, live);
                return (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                    {[
                      ["累计收益", wanInt(s.total_pnl_wan), pnlColor(s.total_pnl)],
                      ["累计收益率", pctInt(s.total_return), pnlColor(s.total_return)],
                      ["净值", s.nav.toFixed(4), "text-foreground"],
                      ["最大回撤", pctInt(s.max_drawdown), "text-success"],
                      ["胜率", s.win_rate != null ? pctInt(s.win_rate) : "—", "text-foreground"],
                      ["年化(估)", s.ann_return != null ? pctInt(s.ann_return) : "—", s.ann_return != null ? pnlColor(s.ann_return) : "text-muted-foreground"],
                      ["交易日", String(s.days), "text-foreground"],
                      ["Sharpe", s.sharpe != null ? s.sharpe.toFixed(2) : "—", "text-foreground"],
                    ].map(([k, v, c]) => (
                      <div
                        key={k}
                        className="rounded-lg border border-border/40 bg-muted/10 px-2.5 py-2"
                        title={live ? "含今日实时" : undefined}
                      >
                        <p className="text-[11px] text-muted-foreground">{k}</p>
                        <p className={cn("mt-0.5 font-mono text-sm font-semibold tabular-nums", c)}>{v}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <div className="flex flex-wrap gap-1">
                {SETTLE_CHARTS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setSettleChart(c.key)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      settleChart === c.key
                        ? "bg-primary/15 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div ref={equityChartRef} className="h-56 w-full min-w-0 overflow-hidden rounded-lg border border-border/40 bg-muted/10" />
              </div>

              <div className={cn(
                "absolute inset-0 flex min-h-0 flex-col overflow-hidden",
                settleTab !== "calendar" && "invisible pointer-events-none",
              )}>
              {rangeData?.analytics && (() => {
                const live = previewLive(data, rangeData);
                const daily = buildCalDays(rangeData, live);
                if (!daily.length) {
                  return (
                    <div className="flex h-full items-center justify-center rounded-lg border border-border/40 text-sm text-muted-foreground/60">
                      暂无日历数据
                    </div>
                  );
                }
                const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
                const [cy, cm] = calYm.split("-").map(Number);
                const shiftMonth = (delta: number) => {
                  const dt = new Date(cy, cm - 1 + delta, 1);
                  setCalYm(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`);
                };
                const shiftYear = (delta: number) => {
                  setCalYm(`${cy + delta}-${String(cm).padStart(2, "0")}`);
                };
                type MonthHit = {
                  month: string;
                  pnl: number;
                  income: number;
                  return: number;
                  commission: number;
                };
                const monthByKey = Object.fromEntries(
                  foldLiveMonthly(rangeData.analytics!.monthly, live).map((m) => {
                    const commission = Number(m.commission || 0);
                    const pnl = Number(m.pnl || 0);
                    const income = m.income != null
                      ? Number(m.income)
                      : Math.round((pnl - commission) * 100) / 100;
                    return [m.month, {
                      month: m.month,
                      pnl,
                      income,
                      return: Number(m.return || 0),
                      commission,
                    } satisfies MonthHit];
                  }),
                ) as Record<string, MonthHit>;
                const first = new Date(cy, cm - 1, 1);
                const daysInMonth = new Date(cy, cm, 0).getDate();
                const startPad = first.getDay();
                const cells: ({ kind: "empty" } | { kind: "day"; day: number; date: string })[] = [];
                for (let i = 0; i < startPad; i++) cells.push({ kind: "empty" });
                for (let d = 1; d <= daysInMonth; d++) {
                  const date = `${calYm}-${String(d).padStart(2, "0")}`;
                  cells.push({ kind: "day", day: d, date });
                }
                while (cells.length % 7 !== 0) cells.push({ kind: "empty" });
                const monthRow = monthByKey[calYm];
                const yearMonths = Object.values(monthByKey).filter((m) => m.month.startsWith(`${cy}-`));
                const yearPnl = yearMonths.reduce((s, m) => s + m.pnl, 0);
                const yearIncome = yearMonths.reduce((s, m) => s + m.income, 0);
                const yearComm = yearMonths.reduce((s, m) => s + (m.commission || 0), 0);
                const scope = calMode === "day" ? "本月" : "本年";

                const metricValue = (hit: { pnl: number; income: number; commission: number }) => {
                  if (calMetric === "income") return hit.income;
                  if (calMetric === "commission") return hit.commission;
                  return hit.pnl;
                };
                const cellTone = (hit: { pnl: number; income: number; commission: number } | undefined) => {
                  if (!hit) return "border-border/30 bg-muted/10 text-muted-foreground/50";
                  if (calMetric === "commission") {
                    const c = hit.commission || 0;
                    if (c > 0) return "border-emerald-800/30 bg-emerald-900/10 text-emerald-900 dark:text-emerald-400";
                    return "border-border/40 bg-muted/20 text-muted-foreground";
                  }
                  const v = metricValue(hit);
                  if (v > 0) return "border-danger/30 bg-danger/15 text-danger";
                  if (v < 0) return "border-success/30 bg-success/15 text-success";
                  return "border-border/40 bg-muted/20 text-muted-foreground";
                };
                const cellValue = (hit: { pnl: number; income: number; commission: number }) => {
                  if (calMetric === "commission") {
                    const c = Math.round(hit.commission || 0);
                    return c === 0 ? "0" : String(c);
                  }
                  const y = Math.round(metricValue(hit));
                  return y === 0 ? "0" : signed(y);
                };
                const footerLeft = calMode === "day"
                  ? monthRow
                    ? { pnl: monthRow.pnl, income: monthRow.income, commission: monthRow.commission }
                    : null
                  : yearMonths.length
                    ? { pnl: yearPnl, income: yearIncome, commission: yearComm }
                    : null;

                const metricToggle = (
                  <div className="flex gap-0.5 rounded-md border border-border/50 bg-muted/20 p-0.5">
                    {CAL_METRICS.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => setCalMetric(m.key)}
                        className={cn(
                          "rounded px-2 py-1 text-xs transition-colors",
                          calMetric === m.key
                            ? "bg-background font-medium text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                );

                const footerBar = (
                  <div className="mt-3 flex flex-wrap items-end justify-between gap-2 border-t border-border/40 pt-2.5">
                    <div className="text-xs">
                      {footerLeft ? (
                        calMetric === "commission" ? (
                          <>
                            <p className="text-muted-foreground">{scope}累计手续费</p>
                            <p className="mt-0.5 font-mono text-sm font-semibold text-emerald-900 dark:text-emerald-400">
                              {Math.round(footerLeft.commission)}元
                            </p>
                          </>
                        ) : calMetric === "income" ? (
                          <>
                            <p className="text-muted-foreground">{scope}累计收益</p>
                            <p className={cn("mt-0.5 font-mono text-sm font-semibold", pnlColor(footerLeft.income))}>
                              {signed(Math.round(footerLeft.income))}元
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-muted-foreground">{scope}累计盈亏</p>
                            <p className={cn("mt-0.5 font-mono text-sm font-semibold", pnlColor(footerLeft.pnl))}>
                              {signed(Math.round(footerLeft.pnl))}元
                            </p>
                          </>
                        )
                      ) : (
                        <p className="text-muted-foreground">暂无数据</p>
                      )}
                    </div>
                    {metricToggle}
                  </div>
                );

                return (
                  <div className="flex h-full min-h-0 flex-col gap-2">
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <div className="flex gap-1">
                        {(["day", "month"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setCalMode(m)}
                            className={cn(
                              "rounded-md px-2.5 py-1 text-xs",
                              calMode === m ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted/40",
                            )}
                          >
                            {m === "day" ? "日历" : "月表"}
                          </button>
                        ))}
                      </div>
                    </div>
                    {calMode === "day" ? (
                      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/40 p-2.5 sm:p-3">
                        <div className="mb-2 flex shrink-0 items-center justify-between">
                          <button
                            type="button"
                            onClick={() => shiftMonth(-1)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            aria-label="上一月"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <p className="font-mono text-sm font-semibold sm:text-base">{calYm}</p>
                          <button
                            type="button"
                            onClick={() => shiftMonth(1)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            aria-label="下一月"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                        <div
                          className="grid min-h-0 flex-1 grid-cols-7 gap-1 sm:gap-1.5"
                          style={{ gridTemplateRows: `auto repeat(${Math.ceil(cells.length / 7)}, minmax(0, 1fr))` }}
                        >
                          {WEEK_LABELS.map((w) => (
                            <div key={w} className="py-0.5 text-center text-[11px] text-muted-foreground sm:text-xs">{w}</div>
                          ))}
                          {cells.map((c, i) => {
                            if (c.kind === "empty") {
                              return <div key={`e-${i}`} className="min-h-0 rounded-md" />;
                            }
                            const hit = byDate[c.date];
                            return (
                              <div
                                key={c.date}
                                title={hit
                                  ? `${c.date} 盈亏 ${signed(Math.round(hit.pnl))}元 · 收益 ${signed(Math.round(hit.income))}元 · 手续费 ${Math.round(hit.commission || 0)}元`
                                  : c.date}
                                className={cn(
                                  "flex min-h-0 flex-col items-center justify-center rounded-md border px-0.5 py-0.5 sm:px-1",
                                  cellTone(hit),
                                )}
                              >
                                <span className="font-mono text-[10px] opacity-70 sm:text-xs">{c.day}</span>
                                <span className="font-mono text-xs font-semibold leading-tight sm:text-sm">
                                  {hit ? cellValue(hit) : ""}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="shrink-0">{footerBar}</div>
                      </div>
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/40 p-2.5 sm:p-3">
                        <div className="mb-2 flex shrink-0 items-center justify-between">
                          <button
                            type="button"
                            onClick={() => shiftYear(-1)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            aria-label="上一年"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <p className="font-mono text-sm font-semibold sm:text-base">{cy} 年</p>
                          <button
                            type="button"
                            onClick={() => shiftYear(1)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            aria-label="下一年"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-3 gap-1.5 sm:gap-2.5">
                          {Array.from({ length: 12 }, (_, i) => {
                            const month = i + 1;
                            const key = `${cy}-${String(month).padStart(2, "0")}`;
                            const hit = monthByKey[key];
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => { setCalYm(key); setCalMode("day"); }}
                                className={cn(
                                  "flex min-h-0 flex-col items-center justify-center rounded-md border px-1.5 py-1.5 transition-colors sm:px-2",
                                  cellTone(hit),
                                  hit && "hover:opacity-90",
                                  key === calYm && "ring-1 ring-primary/50",
                                )}
                                title={hit
                                  ? `${key} 盈亏 ${signed(Math.round(hit.pnl))}元 · 收益 ${signed(Math.round(hit.income))}元 · 手续费 ${Math.round(hit.commission || 0)}元`
                                  : key}
                              >
                                <span className="font-mono text-xs opacity-70 sm:text-sm">{month}月</span>
                                {hit ? (
                                  <span className="mt-0.5 font-mono text-sm font-semibold leading-tight sm:text-base">
                                    {cellValue(hit)}
                                  </span>
                                ) : (
                                  <span className="mt-0.5 text-sm">—</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <div className="shrink-0">{footerBar}</div>
                      </div>
                    )}
                  </div>
                );
              })()}
              {!rangeData?.analytics && (
                <div className="flex h-full items-center justify-center rounded-lg border border-border/40 text-sm text-muted-foreground/60">
                  暂无日历数据
                </div>
              )}
              </div>
              </div>
            </div>
          </GlassCard>
          </CollapsibleSection>
        </div>
      )}

      {/* Order book / positions panel */}
      {hasBook && (
      <CollapsibleSection
        title="持仓 / 委托 / 成交"
        storageKey="ctp.tables"
        defaultOpen={false}
        summary={`${positions.length} 持仓`}
      >
      <GlassCard glow className="!p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 pt-3 sm:px-4">
          <div className="flex gap-0.5 overflow-x-auto">
          {([
            ["positions", `持仓`, String(positions.length)],
            ["details", `明细`, String(details.length)],
            ["orders", `委托`, String(orders.length)],
            ["trades", `成交`, String(trades.length)],
          ] as const).map(([k, lab, n]) => (
            <button key={k} type="button" onClick={() => setSub(k)}
              className={cn(
                "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
                sub === k
                  ? "font-semibold text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}>
              {lab}
              {n ? <span className={cn("ml-1.5 font-mono text-[11px]", sub === k ? "text-primary" : "text-muted-foreground/70")}>{n}</span> : null}
            </button>
          ))}
          </div>
        </div>

        <div className="p-3 sm:p-4">

        {sub === "positions" && (
          <>
            {!data && (querying || loggingIn) ? (
              <p className="py-12 text-center text-sm text-muted-foreground/60">正在同步持仓…</p>
            ) : positions.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground/60">当前无持仓</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border/40">
                <table className="data-table">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-muted-foreground">
                      {["合约", "方向", "总仓", "今/昨", "开仓成本/手", "昨结", "结算价", "占用保证金", "持仓盈亏", "平仓盈亏", "开/平量", "冻结(多/空)", "手续费", "投保", "仓型"].map((h) => (
                        <th key={h} className={ctpTh(h)}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p, i) => (
                      <tr key={`${p.instrument}-${p.direction}-${p.position_date}-${i}`} className="border-b border-border/25 hover:bg-muted/25">
                        <td className={td}>
                          <span className="font-medium font-mono">{p.instrument}</span>
                          {p.exchange ? <span className="ml-1.5 text-[11px] text-muted-foreground/60">{p.exchange}</span> : null}
                        </td>
                        <td className={cn(td, "font-semibold", p.direction === "多" ? "text-danger" : p.direction === "空" ? "text-success" : "")}>{p.direction}</td>
                        <td className={cn("num font-mono")}>{fmt(p.position)}</td>
                        <td className={cn("num font-mono text-xs text-muted-foreground")}>{fmt(p.today_position)}/{fmt(p.yd_position)}</td>
                        <td className={cn("num font-mono text-xs")} title="OpenCost/手数 (含合约乘数)">{fmtPx(p.cost_per_lot ?? 0)}</td>
                        <td className={cn("num font-mono")}>{fmtPx(p.pre_settlement_price)}</td>
                        <td className={cn("num font-mono")}>{fmtPx(p.settlement_price)}</td>
                        <td className={cn("num font-mono")}>{fmt(p.use_margin)}</td>
                        <td className={cn("num font-mono", pnlColor(p.position_profit))}>{signed(p.position_profit)}</td>
                        <td className={cn("num font-mono", pnlColor(p.close_profit))}>{signed(p.close_profit)}</td>
                        <td className={cn("num font-mono text-xs text-muted-foreground")}>{fmt(p.open_volume ?? 0)}/{fmt(p.close_volume ?? 0)}</td>
                        <td className={cn("num font-mono text-xs text-muted-foreground")}>{fmt(p.long_frozen ?? 0)}/{fmt(p.short_frozen ?? 0)}</td>
                        <td className={cn("num font-mono text-xs")}>{fmt(p.commission)}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{p.hedge}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{p.position_date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {sub === "details" && (
          <>
            {details.length === 0 ? (
              <EmptyState title="暂无持仓明细" description="登录并同步后，这里会显示合约持仓。" />
            ) : (
              <div className="space-y-2">
                {totals && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>按开仓笔 · 含逐笔盈亏</span>
                    <span>平仓(逐笔) <b className={cn("font-mono", pnlColor(totals.detail_close_profit ?? 0))}>{signed(totals.detail_close_profit ?? 0)}</b></span>
                    <span>持仓(逐笔) <b className={cn("font-mono", pnlColor(totals.detail_position_profit ?? 0))}>{signed(totals.detail_position_profit ?? 0)}</b></span>
                  </div>
                )}
                <div className="overflow-x-auto rounded-lg border border-border/40">
                  <table className="data-table">
                    <thead>
                      <tr className="border-b border-border/50 text-left text-muted-foreground">
                        {["开仓日", "合约", "买卖", "投保", "开仓价", "剩余", "已平", "昨结", "结算价", "保证金", "平仓盈亏(逐笔)", "持仓盈亏(逐笔)", "平仓盈亏(逐日)", "成交编号"].map((h) => (
                          <th key={h} className={ctpTh(h)}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {details.map((d, i) => (
                        <tr key={`${d.instrument}-${d.trade_id}-${d.open_date}-${i}`} className="border-b border-border/25 hover:bg-muted/25">
                          <td className={cn(td, "font-mono text-xs text-muted-foreground whitespace-nowrap")}>{d.open_date || "-"}</td>
                          <td className={td}>
                            <span className="font-mono font-medium">{d.instrument}</span>
                            {d.exchange ? <span className="ml-1 text-[11px] text-muted-foreground/60">{d.exchange}</span> : null}
                          </td>
                          <td className={cn(td, "font-semibold", d.direction === "买" ? "text-danger" : d.direction === "卖" ? "text-success" : "")}>{d.direction}</td>
                          <td className={cn(td, "text-xs text-muted-foreground")}>{d.hedge}</td>
                          <td className={cn("num font-mono")}>{fmtPx(d.open_price)}</td>
                          <td className={cn("num font-mono")}>{fmt(d.volume)}</td>
                          <td className={cn("num font-mono text-muted-foreground")}>{fmt(d.close_volume)}</td>
                          <td className={cn("num font-mono")}>{fmtPx(d.last_settlement_price)}</td>
                          <td className={cn("num font-mono")}>{fmtPx(d.settlement_price)}</td>
                          <td className={cn("num font-mono")}>{fmt(d.margin)}</td>
                          <td className={cn("num font-mono", pnlColor(d.close_profit_by_trade))}>{signed(d.close_profit_by_trade)}</td>
                          <td className={cn("num font-mono", pnlColor(d.position_profit_by_trade))}>{signed(d.position_profit_by_trade)}</td>
                          <td className={cn("num font-mono text-xs", pnlColor(d.close_profit_by_date))}>{signed(d.close_profit_by_date)}</td>
                          <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{d.trade_id || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {sub === "orders" && (
          <>
            {orders.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground/60">当日暂无委托</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border/40">
                <table className="data-table">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-muted-foreground">
                      {["报单时间", "合约", "买卖", "开平", "投保", "价格类型", "报单价", "止损价", "成交/剩余/总量", "有效期", "状态", "提交状态", "撤单时间", "报单编号", "本地编号"].map((h) => (
                        <th key={h} className={ctpTh(h)}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o, i) => (
                      <tr key={`${o.order_sys_id}-${o.order_ref}-${i}`} className="border-b border-border/25 hover:bg-muted/25">
                        <td className={cn(td, "font-mono text-xs text-muted-foreground whitespace-nowrap")}>{o.insert_time || "-"}</td>
                        <td className={td}>
                          <span className="font-mono font-medium">{o.instrument}</span>
                          {o.exchange ? <span className="ml-1 text-[11px] text-muted-foreground/60">{o.exchange}</span> : null}
                        </td>
                        <td className={cn(td, "font-semibold", o.direction === "买" ? "text-danger" : o.direction === "卖" ? "text-success" : "")}>{o.direction}</td>
                        <td className={cn(td, "text-muted-foreground")}>{o.offset}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{o.hedge}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{o.price_type}</td>
                        <td className={cn("num font-mono")}>{fmtPx(o.limit_price)}</td>
                        <td className={cn("num font-mono text-xs text-muted-foreground")}>{o.stop_price ? fmtPx(o.stop_price) : "-"}</td>
                        <td className={cn(td, "font-mono text-xs whitespace-nowrap tabular-nums")}>{fmt(o.volume_traded)}/{fmt(o.volume_left)}/{fmt(o.volume_total)}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")} title={o.volume_condition}>{o.time_condition || "-"}</td>
                        <td className={cn(td, "text-xs")} title={o.status_msg}>{o.status}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{o.submit_status || "-"}</td>
                        <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{o.cancel_time || "-"}</td>
                        <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{o.order_sys_id || "-"}</td>
                        <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{o.order_local_id || o.order_ref || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {sub === "trades" && (
          <>
            {trades.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground/60">当日暂无成交</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border/40">
                <table className="data-table">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-muted-foreground">
                      {["成交时间", "合约", "买卖", "开平", "投保", "成交价", "手数", "成交额", "成交编号", "报单编号"].map((h) => (
                        <th key={h} className={ctpTh(h)}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={`${t.trade_id}-${i}`} className="border-b border-border/25 hover:bg-muted/25">
                        <td className={cn(td, "font-mono text-xs text-muted-foreground whitespace-nowrap")}>{t.trade_time || "-"}</td>
                        <td className={td}>
                          <span className="font-mono font-medium">{t.instrument}</span>
                          {t.exchange ? <span className="ml-1 text-[11px] text-muted-foreground/60">{t.exchange}</span> : null}
                        </td>
                        <td className={cn(td, "font-semibold", t.direction === "买" ? "text-danger" : t.direction === "卖" ? "text-success" : "")}>{t.direction}</td>
                        <td className={cn(td, "text-muted-foreground")}>{t.offset}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>{t.hedge}</td>
                        <td className={cn("num font-mono")}>{fmtPx(t.price)}</td>
                        <td className={cn("num font-mono")}>{fmt(t.volume)}</td>
                        <td className={cn("num font-mono")}>{fmt(t.amount ?? t.price * t.volume)}</td>
                        <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{t.trade_id || "-"}</td>
                        <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{t.order_sys_id || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        </div>
      </GlassCard>
      </CollapsibleSection>
      )}

      {/* Collapsible CTP log console */}
      <GlassCard className="!p-0 overflow-hidden">
        <button
          type="button"
          onClick={() => setLogsOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/20 sm:px-4"
        >
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            连接日志
            <span className="font-mono text-[11px] font-normal text-muted-foreground">{logs.length}</span>
            {(loggingIn || querying) && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          </span>
          <span className="inline-flex items-center gap-2">
            {logsOpen && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); setLogs([]); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setLogs([]); } }}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                清屏
              </span>
            )}
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", logsOpen && "rotate-180")} />
          </span>
        </button>
        {logsOpen && (
          <div
            ref={logBoxRef}
            className="max-h-44 overflow-y-auto border-t border-border/40 bg-black/25 px-3 py-2 font-mono text-[11px] leading-5 sm:px-4"
          >
            {logs.length === 0 ? (
              <p className="text-muted-foreground/60">登录与查询过程会显示在这里。</p>
            ) : (
              logs.map((l) => (
                <div
                  key={l.id}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    l.level === "error" && "text-destructive",
                    l.level === "warn" && "text-amber-600 dark:text-amber-400",
                    l.level === "info" && "text-muted-foreground",
                  )}
                >
                  <span className="text-muted-foreground/45">{l.ts}</span>{" "}
                  <span className="opacity-60">[{l.level}]</span> {l.message}
                </div>
              ))
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
}

