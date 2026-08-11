// 自选股实时行情轮询。
//
// 几个刻意的选择：
// - **3 秒一档**：A 股 level-1 行情本身就是 3 秒一笔快照，拉得再快也是同一份数据，
//   纯粹浪费请求。这就是「能拿到的最快频率」。
// - **递归 setTimeout 而不是 setInterval**：单次请求实测 ~750ms，网络一慢 setInterval
//   会让请求首尾叠在一起。改成「上一次结束后再等 N 秒」，永远不会堆叠。
// - **非交易时段自动暂停**：收盘后数据不再变化，继续轮询既无意义又给上游添压。
//   手动刷新按钮仍然可用。
// - **页面切走时暂停**：用户看不到的时候不该继续消耗流量（浏览器自身也会节流后台定时器）。
// - **失败退避**：连续失败时间隔翻倍（上限 30 秒），成功后立刻复位，避免断网时疯狂重试。

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Quote } from "@/lib/api";
import type { WatchItem } from "@/lib/watchlist";

export const LIVE_INTERVAL_MS = 3000;   // A 股 level-1 快照粒度
const MAX_BACKOFF_MS = 30_000;

/** 取当前的北京时间。
 *
 * ⚠️ 不能直接用 `new Date().getHours()` —— 那是**用户本机时区**。用户人在海外时，
 * 本地时间和 A 股交易时段完全对不上，会出现「盘中不刷 / 半夜狂刷」。
 * 这里统一换算到 UTC+8，无论用户在哪个时区都得到同一个答案。
 */
function beijingNow(): Date {
  const d = new Date();
  return new Date(d.getTime() + d.getTimezoneOffset() * 60_000 + 8 * 3600_000);
}

/** 是否处于 A 股交易时段（含 9:15 起的集合竞价）。
 *
 * 只判断「周一至周五 + 时间段」，**不含法定节假日**——那需要一份交易日历，
 * 而节假日里多轮询几次的代价远小于引入日历的复杂度（数据不变，界面也不会跳）。
 */
export function isTradingHours(): boolean {
  const bj = beijingNow();
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  const mins = bj.getHours() * 60 + bj.getMinutes();
  return (mins >= 9 * 60 + 15 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

export interface LiveQuotesState {
  quotes: Record<string, Quote>;
  loading: boolean;
  /** 上次成功取到数据的时间戳（ms），从未成功则为 null */
  updatedAt: number | null;
  /** 轮询是否真的在跑（开关开着 ≠ 在跑：非交易时段 / 页面切走都会暂停） */
  polling: boolean;
  error: string | null;
  /** 手动刷新（任何时候都可用，不受交易时段限制） */
  refresh: () => void;
}

export function useLiveQuotes(items: WatchItem[], enabled: boolean): LiveQuotesState {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 存最新的 codes（格式化为 market:code），让轮询循环不必因为 items 变化而重建
  const codesRef = useRef<string[]>([]);
  codesRef.current = items.map((x) => `${x.market}:${x.code}`);

  const failuresRef = useRef(0);
  const inFlightRef = useRef(false);
  const staleRef = useRef(false);          // 请求飞行途中自选变过 / 有请求被跳过
  const fetchRef = useRef<(() => Promise<boolean>) | null>(null);

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    const cs = codesRef.current;
    if (!cs.length) {
      setQuotes({});
      return true;
    }
    if (inFlightRef.current) {
      // 上一次还没回来，跳过这一拍；但要记下来，等它回来后补拉一次。
      // 否则「首次请求在飞 → 用户此时粘贴新代码」会让新代码的行情永远缺失
      // （默认不开轮询时没有下一拍来兜底，只能手动刷新）。
      staleRef.current = true;
      return true;
    }
    inFlightRef.current = true;
    const requested = cs.join(",");
    setLoading(true);
    try {
      const data = await api.quote(requested);
      setQuotes(data);
      setUpdatedAt(Date.now());
      setError(null);
      failuresRef.current = 0;
      return true;
    } catch {
      failuresRef.current += 1;
      // 第一次失败先不打扰用户（可能只是一次网络抖动），连续失败才提示
      if (failuresRef.current >= 2) setError("行情获取失败，正在重试…");
      return false;
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      // 这一趟拉的是不是已经过期的名单？过期就立刻补一次（只补一次，不会滚雪球：
      // 补拉时 staleRef 已复位，只有再次发生变动才会再补）。
      const changed = codesRef.current.join(",") !== requested;
      if (staleRef.current || changed) {
        staleRef.current = false;
        void fetchRef.current?.();
      }
    }
  }, []);
  fetchRef.current = fetchOnce;

  const refresh = useCallback(() => {
    void fetchOnce();
  }, [fetchOnce]);

  // 首次进入 / 自选变化：立即拉一次（与开关无关，页面总要有数据）
  useEffect(() => {
    void fetchOnce();
  }, [items, fetchOnce]);

  // 轮询循环
  useEffect(() => {
    // ⚠️ `cancelled` 与 `timer` 都是**这一次 effect 的局部变量**，不能用 ref 共享。
    // 循环体里有 `await`：cleanup 执行时若某一拍正卡在请求中，它返回后会照常排下一拍，
    // 于是旧循环「复活」并与新循环并行，实际频率翻倍（React StrictMode 的
    // mount→unmount→mount 必然触发，生产环境里切换开关同样会）。
    // 所以每次 await 之后都要重新检查 cancelled，且定时器句柄不跨 effect 共享。
    let cancelled = false;
    let timer: number | null = null;

    const clear = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const shouldRun = () => enabled && !document.hidden && isTradingHours() && codesRef.current.length > 0;

    const loop = async () => {
      if (cancelled) return;
      if (!shouldRun()) {
        setPolling(false);
        // 没在跑也要保持一个心跳，好在开盘 / 页面切回来时自动恢复
        timer = window.setTimeout(loop, 10_000);
        return;
      }
      setPolling(true);
      const ok = await fetchOnce();
      if (cancelled) return;          // 请求期间被卸载/切换：到此为止，别再排下一拍
      const wait = ok
        ? LIVE_INTERVAL_MS
        : Math.min(LIVE_INTERVAL_MS * 2 ** failuresRef.current, MAX_BACKOFF_MS);
      timer = window.setTimeout(loop, wait);
    };

    if (enabled) {
      void loop();
    } else {
      setPolling(false);
    }

    // 页面切回来时立刻重新评估，不用等下一拍
    const onVisible = () => {
      if (!document.hidden && enabled && !cancelled) {
        clear();
        void loop();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, fetchOnce]);

  return { quotes, loading, updatedAt, polling, error, refresh };
}
