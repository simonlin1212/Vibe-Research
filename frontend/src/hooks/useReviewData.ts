import { useState, useEffect, useCallback, useRef } from "react";
import {
  api, type MarketOverview, type ShortTermEmotion,
  type DailyDragonTiger, type IndustryData,
  type EtfFlow, type EtfShares, ETF_SHARE_WATCH, type ShareholderChanges,
  type ReviewSnapshot, type HsgtLive,
  type MarketBreadth,
} from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { useSegment } from "@/components/ui/SegmentNav";
import { getAShareSession, primeTradingDay } from "@/lib/ashareSession";
import { formatClock } from "@/lib/freshness";
import { useWatchCodes } from "@/lib/watchlist";

const SEG_KEYS = ["inflow", "boards", "money", "chain"] as const;
/** Match review warmup open cadence. Reads last-good; warmup put_emotion fills it. */
const TOP_POLL_MS = 90_000;

export type ReviewSeg = (typeof SEG_KEYS)[number];

export function useReviewData() {
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [emotion, setEmotion] = useState<ShortTermEmotion | null>(null);
  const [lhb, setLhb] = useState<DailyDragonTiger | null>(null);
  const [industry, setIndustry] = useState<IndustryData | null>(null);
  const [etfFlow, setEtfFlow] = useState<EtfFlow | null>(null);
  const [etfShares, setEtfShares] = useState<EtfShares | null>(null);
  const [etfSharesList, setEtfSharesList] = useState<EtfShares[]>([]);
  const [etfSort, setEtfSort] = useState<"net_inflow" | "change_pct">("net_inflow");
  const [shChg, setShChg] = useState<ShareholderChanges | null>(null);
  const [shType, setShType] = useState<"all" | "增持" | "减持">("all");
  const [hsgt, setHsgt] = useState<HsgtLive | null>(null);
  const [moneyDone, setMoneyDone] = useState(false);
  const watchCodes = useWatchCodes();

  const [ovDone, setOvDone] = useState(false);
  const [emoDone, setEmoDone] = useState(false);
  const [lhbDone, setLhbDone] = useState(false);
  const [topRefreshing, setTopRefreshing] = useState(false);
  const [topUpdatedAt, setTopUpdatedAt] = useState<Date | null>(null);
  const topRefreshingRef = useRef(false);

  const [segRaw, setSeg] = useSegment("ashare.review.v2", [...SEG_KEYS], "inflow");
  const seg: ReviewSeg = (SEG_KEYS as readonly string[]).includes(segRaw)
    ? (segRaw as ReviewSeg)
    : "inflow";

  const topUpdatedLabel = formatClock(topUpdatedAt, { refreshing: topRefreshing });

  const { data: breadth, updated: breadthUpdated } = usePolling<MarketBreadth>(
    () => api.marketBreadth(),
    180_000,
    [],
    emoDone,
  );
  const breadthLabel = formatClock(
    breadth?.updated || breadthUpdated || topUpdatedAt,
    { refreshing: topRefreshing && !breadth },
  );

  const applyPaint = useCallback((s: ReviewSnapshot) => {
    setHsgt(s.hsgt ?? null);
    setOverview(s.overview ?? null);
    setOvDone(true);
  }, []);

  const applyTop = useCallback((s: ReviewSnapshot) => {
    applyPaint(s);
    setEmotion(s.emotion ?? null);
    setIndustry(s.industry ?? null);
    setEmoDone(true);
  }, [applyPaint]);

  const applyFull = useCallback((s: ReviewSnapshot) => {
    applyTop(s);
    setLhb(s.lhb ?? null);
    setLhbDone(true);
  }, [applyTop]);

  const refreshTopRows = useCallback(() => {
    if (topRefreshingRef.current) return;
    topRefreshingRef.current = true;
    setTopRefreshing(true);
    setOvDone(false);
    setEmoDone(false);

    void api.reviewSnapshot({ scope: "top" })
      .then(applyTop)
      .catch(() => {
        setOverview(null);
        setEmotion(null);
        setHsgt(null);
        setOvDone(true);
        setEmoDone(true);
      })
      .finally(() => {
        setTopUpdatedAt(new Date());
        setTopRefreshing(false);
        topRefreshingRef.current = false;
      });
  }, [applyTop]);

  useEffect(() => {
    let cancelled = false;
    setOvDone(false); setEmoDone(false);
    void (async () => {
      const snap = (scope: "paint" | "top") =>
        api.reviewSnapshot({ scope });
      const paintP = snap("paint").then((s) => {
        if (!cancelled) {
          applyPaint(s);
          setTopUpdatedAt(new Date());
        }
      }).catch(() => {
        if (!cancelled) setOvDone(true);
      });
      await paintP;
      if (cancelled) return;
      try {
        const top = await snap("top");
        if (!cancelled) applyTop(top);
      } catch {
        if (!cancelled) setEmoDone(true);
      } finally {
        if (!cancelled) setTopUpdatedAt(new Date());
      }
    })();
    return () => { cancelled = true; };
    // bootstrap once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (seg !== "boards" || !emoDone || lhbDone) return;
    let cancelled = false;
    void api.reviewSnapshot({ scope: "full" })
      .then((s) => {
        if (!cancelled) applyFull(s);
      })
      .catch(() => {
        if (!cancelled) setLhbDone(true);
      })
      .finally(() => {
        if (!cancelled) setTopUpdatedAt(new Date());
      });
    return () => { cancelled = true; };
  }, [seg, emoDone, lhbDone, applyFull]);

  useEffect(() => {
    void primeTradingDay();
  }, []);

  useEffect(() => {
    if (!emoDone) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (getAShareSession().kind !== "open") return;
      if (topRefreshingRef.current) return;
      void api.reviewSnapshot({ scope: "top" })
        .then((s) => {
          applyTop(s);
          setTopUpdatedAt(new Date());
        })
        .catch(() => {});
    };
    const id = window.setInterval(tick, TOP_POLL_MS);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [emoDone, applyTop]);

  useEffect(() => {
    if (seg !== "money") return;
    let cancelled = false;
    setMoneyDone(false);
    Promise.all([
      api.etfFlow(etfSort, 40).catch(() => null),
      api.shareholderChanges({ changeType: shType, limit: 40 }).catch(() => null),
    ]).then(([ef, sc]) => {
      if (cancelled) return;
      setEtfFlow(ef);
      setShChg(sc);
    }).finally(() => {
      if (!cancelled) setMoneyDone(true);
    });
    return () => { cancelled = true; };
  }, [etfSort, shType, seg]);

  useEffect(() => {
    if (seg !== "money") return;
    let cancelled = false;
    api.etfSharesBatch(ETF_SHARE_WATCH.map((x) => x.code), 80).then((d) => {
      if (cancelled) return;
      const items = d.items ?? [];
      setEtfSharesList(items);
      setEtfShares(items.find((x) => x.code === "510300") ?? items[0] ?? null);
    }).catch(() => {
      if (cancelled) return;
      setEtfSharesList([]);
      setEtfShares(null);
    });
    return () => { cancelled = true; };
  }, [seg]);

  return {
    emotion,
    breadth,
    breadthLabel,
    lhb,
    etfFlow,
    etfShares,
    etfSharesList,
    etfSort,
    setEtfSort,
    shChg,
    shType,
    setShType,
    hsgt,
    moneyDone,
    watchCodes,
    ovDone,
    emoDone,
    lhbDone,
    topRefreshing,
    topUpdatedLabel,
    refreshTopRows,
    seg,
    setSeg,
    sentiment: overview?.sentiment,
    indTop: industry?.top?.[0],
    indBot: industry?.bottom?.[0],
  };
}
