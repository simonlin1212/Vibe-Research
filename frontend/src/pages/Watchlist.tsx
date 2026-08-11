import { useMemo, useState } from "react";
import { Plus, X, RefreshCw, Star } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { StockSearchInput } from "@/components/ui/StockSearchInput";
import { loadWatch, saveWatch, type WatchItem } from "@/lib/watchlist";
import { useLiveQuotes, isTradingHours } from "@/hooks/useLiveQuotes";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// A 股红涨绿跌（与整个看板一致）。
const color = (v: number | undefined) =>
  v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-muted-foreground";
const pct = (v: number | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`);

const MKT_LABEL: Record<string, string> = { A: "A股", HK: "港股", US: "美股", KR: "韩股", FD: "场外基金" };

const LIVE_KEY = "vr-watchlist-live";

// localStorage 在隐私模式 / 嵌入式浏览器里可能直接抛异常。读写都要兜底，
// 否则初始化时一抛整个自选股页就白屏（与 lib/watchlist.ts 的处理保持一致）。
const loadLive = (): boolean => {
  try {
    return localStorage.getItem(LIVE_KEY) === "on";
  } catch {
    return false;
  }
};
const saveLive = (on: boolean) => {
  try {
    localStorage.setItem(LIVE_KEY, on ? "on" : "off");
  } catch {
    /* 存储不可用：开关本次会话内仍生效，只是不被记住 */
  }
};

export function Watchlist() {
  const [items, setItems] = useState<WatchItem[]>(loadWatch);
  const [input, setInput] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  // 实时行情默认**关闭**——开着会持续请求，让用户自己决定要不要开。
  const [live, setLive] = useState(loadLive);

  const { quotes, loading, updatedAt, polling, error, refresh } = useLiveQuotes(items, live);

  const toggleLive = () => {
    setLive((on) => {
      const next = !on;
      saveLive(next);
      return next;
    });
  };

  // 下拉选中 → 直接加入自选（去重：同 code+market 不重复加）
  const onSelect = (s: { code: string; market: string; name?: string }) => {
    if (items.some((x) => x.code === s.code && x.market === s.market)) {
      setHint("已在自选里");
      setInput("");
      return;
    }
    const next = [...items, { code: s.code, market: s.market }];
    setItems(next); saveWatch(next); setInput(""); setHint(`已添加 ${s.code}`);
  };

  // 手动添加 fallback：直接输入代码回车 → 调搜索取第一条
  const add = async () => {
    const q = input.trim();
    if (!q) return;
    try {
      const results = await api.search(q);
      if (results.length === 0) { setHint("未找到该股票"); return; }
      onSelect(results[0]);
    } catch {
      setHint("搜索失败");
    }
  };

  const remove = (code: string, market: string) => {
    const next = items.filter((x) => !(x.code === code && x.market === market));
    setItems(next); saveWatch(next);
  };

  const aiContext = useMemo(
    () =>
      items.length
        ? "我的自选股（本地）：\n" +
          items
            .map((it) => {
              const q = quotes[it.code];
              return q
                ? `${q.name}(${it.code}) 现价${q.price} ${pct(q.change_pct)} PE(TTM)${q.pe_ttm ?? "—"} 换手${q.turnover_pct ?? "—"}%`
                : `${it.code}（行情未取到）`;
            })
            .join("\n")
        : "还没有自选股。",
    [items, quotes],
  );

  return (
    <div>
      <PageHeader
        title="自选股"
        subtitle="批量添加、一屏总览你关注的标的。数据只存本地、不上传。"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={toggleLive}
              title={live ? "关闭实时行情" : "开启实时行情（交易时段每 3 秒自动刷新）"}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                live
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="relative flex h-2 w-2">
                {polling && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
                )}
                <span
                  className={cn(
                    "relative inline-flex h-2 w-2 rounded-full",
                    live ? "bg-primary" : "bg-muted-foreground/40",
                  )}
                />
              </span>
              实时行情
            </button>
            {items.length > 0 && (
              <AskAiButton
                context={aiContext}
                label="让 AI 读自选"
                suggestions={["这几只里哪些估值偏高", "帮我按赛道分组看看", "各自最大的风险点是什么"]}
              />
            )}
          </div>
        }
      />

      <GlassCard className="relative z-20 mb-4">
        <label className="mb-1.5 block text-xs text-muted-foreground">
          添加自选 —— 输入代码 / 拼音首字母 / 中文名，从下拉选中即可（支持 A 股 / 港股 / 美股）
        </label>
        <div className="flex gap-2">
          <StockSearchInput
            value={input}
            onChange={setInput}
            onSelect={onSelect}
            placeholder="代码 / 拼音 / 中文，如 gzmt / AAPL / 腾讯"
            className="flex-1 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <button
            onClick={add}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg bg-primary/15 px-4 text-sm font-medium text-primary shadow-glow hover:bg-primary/25"
          >
            <Plus className="h-4 w-4" /> 添加
          </button>
        </div>
        {hint && <p className="mt-2 text-xs text-muted-foreground/70">{hint}</p>}
      </GlassCard>

      <GlassCard glow>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-semibold">
            <Star className="h-4 w-4 text-primary" /> 自选总览
            <span className="text-xs font-normal text-muted-foreground">（{items.length}）</span>
          </h3>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
            {error ? (
              <span className="text-warning">{error}</span>
            ) : (
              <>
                {/* 把「开着却没在刷」的原因说清楚，否则用户会以为坏了 */}
                {live && !polling && items.length > 0 && (
                  <span>{isTradingHours() ? "已暂停（页面未激活）" : "非交易时段 · 已暂停"}</span>
                )}
                {polling && <span className="text-primary/80">实时 · 每 3 秒</span>}
                {updatedAt && (
                  <span className="font-mono">
                    {new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                )}
              </>
            )}
            <button
              onClick={refresh}
              disabled={loading}
              className="text-muted-foreground hover:text-primary"
              title="立即刷新"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
        </div>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/60">
            还没有自选股，用上面的搜索框添加（支持 A 股 / 港股 / 美股）。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "代码", "现价", "涨跌%", "PE(TTM)", "PB", "换手%", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const q = quotes[it.code];
                  return (
                    <tr key={`${it.market}:${it.code}`} className="border-b border-border/30">
                      <td className="px-2 py-2.5">
                        <span className="font-medium">{q?.name || "—"}</span>
                        {it.market && it.market !== "A" && (
                          <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{MKT_LABEL[it.market] || it.market}</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs text-muted-foreground">{it.code}</td>
                      <td className={cn("px-2 py-2.5 font-mono", color(q?.change_pct))}>{q ? q.price : "—"}</td>
                      <td className={cn("px-2 py-2.5 font-mono", color(q?.change_pct))}>{q ? pct(q.change_pct) : "—"}</td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{q?.pe_ttm ?? "—"}</td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{q?.pb ?? "—"}</td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{q?.turnover_pct ?? "—"}</td>
                      <td className="px-2 py-2.5">
                        <button
                          onClick={() => remove(it.code, it.market)}
                          className="text-muted-foreground/50 hover:text-destructive"
                          title="移除"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
