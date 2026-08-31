import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePolling } from "@/hooks/usePolling";
import { api, type FinBoard, type FinCompanyBundle } from "@/lib/api";
import { storageGet, storageSet } from "@/lib/storage";

export interface FinCompany {
  code: string;
  name: string;
}

export type FinTrendTab = "perf" | "quality" | "leverage";
export type FinPeerMode = "radar" | "table";
export type FinIndustryMode = "tree" | "bar";
export type FinStockTab = "profit" | "growth";

interface FinCtx {
  company: FinCompany;
  recent: FinCompany[];
  select: (code: string, name: string) => void;
  period: string;
  setPeriod: (p: string) => void;
  periods: { value: string; label: string }[];
  board: FinBoard | null;
  prevBoard: FinBoard | null;
  boardError: string | null;
  companyBundle: FinCompanyBundle | null;
  companyError: string | null;
  trendTab: FinTrendTab;
  setTrendTab: (t: FinTrendTab) => void;
  peerMode: FinPeerMode;
  setPeerMode: (m: FinPeerMode) => void;
  industryMode: FinIndustryMode;
  setIndustryMode: (m: FinIndustryMode) => void;
  stockTab: FinStockTab;
  setStockTab: (t: FinStockTab) => void;
}

const DEFAULT_COMPANY: FinCompany = { code: "600519", name: "贵州茅台" };
const LS_RECENT = "fin:recent";
const LS_CURRENT = "fin:company";
const MAX_RECENT = 6;

function currentPeriod(d = new Date()): string {
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  if (m <= 3) return `${y - 1}-09-30`;
  if (m <= 6) return `${y}-03-31`;
  if (m <= 9) return `${y}-06-30`;
  return `${y}-09-30`;
}

function prevPeriod(p: string): string {
  const y = p.slice(0, 4);
  const md = p.slice(4);
  if (md === "-03-31") return `${Number(y) - 1}-12-31`;
  const map: Record<string, string> = {
    "-06-30": "-03-31",
    "-09-30": "-06-30",
    "-12-31": "-09-30",
  };
  return `${y}${map[md] ?? "-09-30"}`;
}

function periodLabel(p: string): string {
  const q: Record<string, string> = { "-03-31": "Q1", "-06-30": "Q2", "-09-30": "Q3", "-12-31": "Q4" };
  return `${p.slice(2, 4)}${q[p.slice(4)] ?? ""}`;
}

const CUR = currentPeriod();
const PREV = prevPeriod(CUR);
const PERIOD_OPTIONS = [
  { value: CUR, label: `${periodLabel(CUR)}·披露` },
  { value: PREV, label: periodLabel(PREV) },
];

function parseCompany(raw: string | null): FinCompany | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const code = String((v as FinCompany).code || "").replace(/^(sh|sz|bj)/i, "");
    const name = String((v as FinCompany).name || "");
    if (!/^\d{6}$/.test(code)) return null;
    return { code, name: name || code };
  } catch {
    return null;
  }
}

function loadRecent(): FinCompany[] {
  try {
    const raw = storageGet(LS_RECENT);
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) {
      return v
        .map((x) => parseCompany(JSON.stringify(x)))
        .filter((x): x is FinCompany => !!x)
        .slice(0, MAX_RECENT);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function loadCompany(recent: FinCompany[]): FinCompany {
  return parseCompany(storageGet(LS_CURRENT)) ?? recent[0] ?? DEFAULT_COMPANY;
}

const FinContext = createContext<FinCtx>({
  company: DEFAULT_COMPANY,
  recent: [],
  select: () => {},
  period: CUR,
  setPeriod: () => {},
  periods: PERIOD_OPTIONS,
  board: null,
  prevBoard: null,
  boardError: null,
  companyBundle: null,
  companyError: null,
  trendTab: "perf",
  setTrendTab: () => {},
  peerMode: "radar",
  setPeerMode: () => {},
  industryMode: "tree",
  setIndustryMode: () => {},
  stockTab: "profit",
  setStockTab: () => {},
});

export function FinProvider({ children }: { children: ReactNode }) {
  const recentInit = loadRecent();
  const [company, setCompany] = useState<FinCompany>(() => loadCompany(recentInit));
  const [recent, setRecent] = useState<FinCompany[]>(recentInit);
  const [period, setPeriod] = useState(CUR);
  const [trendTab, setTrendTab] = useState<FinTrendTab>("perf");
  const [peerMode, setPeerMode] = useState<FinPeerMode>("radar");
  const [industryMode, setIndustryMode] = useState<FinIndustryMode>("tree");
  const [stockTab, setStockTab] = useState<FinStockTab>("profit");

  const select = useCallback((code: string, name: string) => {
    const bare = code.replace(/^(sh|sz|bj)/i, "");
    if (!/^\d{6}$/.test(bare)) return;
    const next = { code: bare, name: name || bare };
    setCompany(next);
    storageSet(LS_CURRENT, JSON.stringify(next));
    setRecent((rs) => {
      const list = [next, ...rs.filter((r) => r.code !== bare)].slice(0, MAX_RECENT);
      storageSet(LS_RECENT, JSON.stringify(list));
      return list;
    });
  }, []);

  const boardPoll = usePolling(() => api.finBoard(period), 1800_000, [period]);
  const firstReady = !!(boardPoll.data || boardPoll.error);
  const prevP = prevPeriod(period);
  const prevBoardPoll = usePolling(() => api.finBoard(prevP), 1800_000, [prevP], firstReady);
  const companyPoll = usePolling(
    () => api.finCompany(company.code),
    1800_000,
    [company.code],
    firstReady && Boolean(company.code),
  );
  const bundle = companyPoll.data;
  const bundleOk = !bundle?.main?.code || bundle.main.code === company.code;

  const value = useMemo(
    () => ({
      company,
      recent,
      select,
      period,
      setPeriod,
      periods: PERIOD_OPTIONS,
      board: boardPoll.data,
      prevBoard: prevBoardPoll.data,
      boardError: boardPoll.error,
      companyBundle: bundleOk ? bundle : null,
      companyError: companyPoll.error,
      trendTab,
      setTrendTab,
      peerMode,
      setPeerMode,
      industryMode,
      setIndustryMode,
      stockTab,
      setStockTab,
    }),
    [
      company, recent, select, period,
      boardPoll.data, boardPoll.error, prevBoardPoll.data,
      bundle, bundleOk, companyPoll.error,
      trendTab, peerMode, industryMode, stockTab,
    ],
  );
  return <FinContext.Provider value={value}>{children}</FinContext.Provider>;
}

export function useFin() {
  return useContext(FinContext);
}
