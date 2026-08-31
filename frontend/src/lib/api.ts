// Vibe-Research 后端 API 客户端。/api → vite 代理到本地 FastAPI（默认 8900）。
// 后端未启动或数据源异常时抛 ApiError，页面据此优雅降级。
// 腾讯系行情在后端慢/挂时由浏览器直连 qt.gtimg.cn / ifzq 兜底。

import {
  fetchDirectBoards,
  fetchDirectQuotes,
  withFallback,
  type DirectQuote,
} from "@/lib/tencentDirect";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** FastAPI 422 detail is often an object list; String(detail) becomes [object Object]. */
export function httpDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const bits = detail.map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && "msg" in x && typeof x.msg === "string") return x.msg;
      return "";
    }).filter(Boolean);
    if (bits.length) return bits.join("; ");
  }
  return `HTTP ${status}`;
}

// 后端访问密钥（对应后端部署时的 VR_API_KEY，公网部署防蹭用）。只存本地浏览器。
const ACCESS_KEY = "vr-access-key";

export function loadAccessKey(): string {
  try {
    return localStorage.getItem(ACCESS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveAccessKey(key: string) {
  try {
    if (key) localStorage.setItem(ACCESS_KEY, key);
    else localStorage.removeItem(ACCESS_KEY);
  } catch {
    /* 隐私模式等场景 localStorage 不可用 */
  }
}

export function authHeaders(): Record<string, string> {
  const k = loadAccessKey();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<T> {
  let resp: Response;
  const headers: Record<string, string> = { ...authHeaders() };
  const opts: RequestInit = { method, cache: "no-store" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) opts.headers = headers;
  try {
    resp = await fetch(`/api${path}`, opts);
  } catch {
    throw new ApiError("连接不到后端，请先启动 backend（uvicorn app:app --port 8900）", 0);
  }
  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new ApiError("后端开启了访问鉴权（VR_API_KEY）：请在「接入 AI」页底部填写后端访问密钥", 401);
    }
    throw new ApiError(httpDetail(payload?.detail, resp.status), resp.status);
  }
  return (payload?.data ?? payload) as T;
}

const get = <T>(path: string) => request<T>(path, "GET");

/** Same as marketingdashboard: merge row stockFlow calls in a 60ms window. */
const quoteFlowLoader = (() => {
  let queue: { code: string; resolve: (v: QuoteFlow | null) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (code: string): Promise<QuoteFlow | null> =>
    new Promise((resolve) => {
      queue.push({ code, resolve });
      if (timer) return;
      timer = setTimeout(async () => {
        const batch = queue;
        queue = [];
        timer = null;
        const codes = [...new Set(batch.map((b) => b.code))];
        try {
          const rows = await get<QuoteFlow[]>(`/market/stock-flows?codes=${encodeURIComponent(codes.join(","))}`);
          const map = new Map((rows || []).map((r) => [r.code, r]));
          for (const b of batch) {
            const digits = b.code.replace(/^(sh|sz|bj)/i, "");
            b.resolve(map.get(b.code) ?? map.get(digits) ?? null);
          }
        } catch {
          for (const b of batch) b.resolve(null);
        }
      }, 60);
    });
})();

export interface Quote {
  name: string; price: number; last_close: number; change_pct: number;
  pe_ttm: number; pb: number; mcap_yi: number; turnover_pct: number;
  limit_up: number; limit_down: number;
  is_stale?: boolean; stale_reason?: string;
}

export interface Valuation {
  name: string; code: string; price: number; mcap_yi: number;
  pe_ttm: number; pb: number;
  eps_26e: number | null; eps_27e: number | null; pe_26e: number | null;
  cagr_pct: number | null; peg: number | null; digest_years: number | null;
  analyst_count: number; forecast_note?: string;
}

export interface Report {
  title: string; publishDate: string; orgSName: string;
  emRatingName?: string; indvInduName?: string; pdfUrl?: string | null;
}

export interface ValMetric {
  current: number; percentile: number; min: number; max: number;
  p20: number; p50: number; p80: number; n: number;
}
export interface ValPercentile {
  period: string; metrics: { pe_ttm?: ValMetric; pb?: ValMetric };
}

export interface Announcement {
  date: string; title: string; type: string; url: string;
}

export interface Financials {
  period: string | null;
  revenue: string | null; revenue_yoy: string | null;
  net_profit: string | null; net_profit_yoy: string | null;
  eps: string | null; bvps: string | null; roe: string | null;
  gross_margin: string | null; net_margin: string | null; op_cf_ps: string | null;
}

export interface NewsItem {
  新闻标题?: string; 发布时间?: string; 文章来源?: string; 新闻链接?: string;
}

/** 财联社电报 */
export interface ClsTelegraphItem {
  id?: string | number; title: string; content?: string; summary?: string;
  time: string; share_url?: string | null; tags?: string[];
}
export interface ClsTelegraph {
  source?: string; count: number; items: ClsTelegraphItem[];
}

export interface FundFlowMinutePoint {
  time: string;
  main_net: number;
  small_net: number;
  mid_net: number;
  large_net: number;
  super_net: number;
}
export interface FundFlowMinute {
  code: string;
  count: number;
  day_main_net: number;
  latest: FundFlowMinutePoint | null;
  rows: FundFlowMinutePoint[];
}

export interface IwencaiSelectRow {
  code: string; name: string;
}
export interface IwencaiSelect {
  query: string; total: number; rows: IwencaiSelectRow[];
}

export interface IndexQuote {
  name: string; price: number; change_pct: number; change_amt: number;
  /** 6-digit bare code */
  code?: string;
  /** Prefixed tencent symbol, e.g. sh000001 — required for index minute charts */
  symbol?: string;
}

export interface MarketSentiment {
  up: number; down: number; flat: number; zt: number; zt_real: number; dt: number; dt_real: number;
  active: string; breadth: string; speculation: string; date: string;
}
export interface SectorFlow {
  name: string; pct: number; net: number; inflow: number; outflow: number; firms: number;
}
export interface MarketOverview {
  sentiment: MarketSentiment; sectors: SectorFlow[]; updated: string;
}

// 短线情绪：连板梯队 / 最高连板 / 炸板率 / 封板率 / 晋级率 / 涨跌停家数 + 连板股清单（客观公开榜单）
export interface EmotionTier { boards: number; count: number; plus: boolean }
export interface LianbanStock {
  code: string; name: string; boards: number;
  price: number; pct: number; amount: number | null; float_cap: number | null; industry: string;
}
export interface MarketBreadth {
  n: number;
  up?: number; down?: number; flat?: number;
  p10?: number | null; p25?: number | null; p50?: number | null;
  p75?: number | null; p90?: number | null; avg?: number | null;
  histogram?: Array<{ label: string; count: number; pct: number }>;
  source?: string;
  updated?: string;
}
export interface EmotionSeals {
  sealed_up: number; fake_up: number;
  sealed_down: number; fake_down: number; unknown: number;
}
export interface ShortTermEmotion {
  date: string;
  zt_count: number; dt_count: number; zb_count: number;
  max_boards: number; lianban_count: number;
  ladder: EmotionTier[];
  zt_stocks?: LianbanStock[];
  dt_ladder?: EmotionTier[];
  dt_stocks?: LianbanStock[];
  lianban_stocks: LianbanStock[];
  seal_rate: number | null; break_rate: number | null; promotion_rate: number | null;
  yzt_count: number;
  breadth?: MarketBreadth;
  seals?: EmotionSeals;
}

/** 全市场龙虎榜（东财公开榜单，金额单位：万元） */
export interface DailyDragonTigerStock {
  code: string; name: string; reason: string;
  close: number; change_pct: number;
  net_buy_wan: number; buy_wan: number; sell_wan: number; turnover_pct: number;
}
export interface DailyDragonTiger {
  date: string; total_records: number; note?: string;
  stocks: DailyDragonTigerStock[];
}

export interface HsgtLive {
  date?: string; note?: string;
  latest: { time?: string; hgt_yi?: number | null; sgt_yi?: number | null } | null;
  points: Array<{ time: string; hgt_yi?: number | null; sgt_yi?: number | null }>;
}
export interface StockFlowRow {
  code: string; name: string; price: number; change_pct: number;
  main_net: number; main_pct: number; super_large_net?: number;
  amount?: number; turnover?: number;
}
export interface StockFlow {
  board?: string | null; total: number; note?: string; rows: StockFlowRow[];
}
export interface StockFlowCell {
  main_net: number | null;
  main_pct: number | null;
  netIn?: number | null;
  netRatio?: number | null;
}

/** One quote-row fund-flow (marketingdashboard /api/stock-flows). */
export interface QuoteFlow {
  code: string;
  netIn: number;
  netRatio: number;
}

export interface WorldIndex {
  symbol: string; name: string; label: string; region: "CN" | "HK" | "US" | "FX" | string;
  price: number; change: number; change_pct: number; amount?: number;
}
/** Cockpit quote hub row (Tencent). amount is yuan. */
export interface MarketQuote {
  symbol: string; name: string; price: number; pct: number;
  change?: number; prev?: number; amount?: number; turnover?: number;
  volume?: number; bid?: number; ask?: number; bid_vol?: number; ask_vol?: number;
  open?: number; high?: number; low?: number; amplitude?: number; vol_ratio?: number;
  float_mcap_yi?: number; limit_up?: number; limit_down?: number; pe_static?: number;
  pe_ttm?: number; pb?: number; mcap_yi?: number;
  is_stale?: boolean; stale_reason?: string;
}
export interface SectorBoard {
  code: string; raw_code?: string; name: string;
  price: number; change: number; pct: number;
  lead_code?: string; lead_name?: string; lead_pct?: number;
  pct5?: number; pct20?: number;
}
export interface BoardStock {
  code: string; symbol?: string; name: string; price: number; pct: number;
  amount?: number; turnover?: number;
  main_net?: number | null; main_pct?: number | null;
}
export interface StockRankRow {
  symbol: string; code: string; name: string;
  price: number; pct: number; amount: number; turnover?: number;
  main_net?: number; main_pct?: number;
}
export interface BoardFlowPoint { t: string; v: number }
export interface BoardFlowIntraday {
  code: string; name: string; net_in: number; points: BoardFlowPoint[];
}
export interface CommodityQuote {
  symbol: string; name: string; price: number; prev?: number;
  change: number; pct: number; high?: number; low?: number; time?: string;
}
export interface CommodityMinute {
  code: string; prec: number; points: Array<{ t: string; p: number }>;
}
export interface SpotBasisRow {
  exchange: string; name: string; spot: number; contract: string;
  futures: number; basis: number; basis_pct: number;
}
export interface SpotTable {
  date: string; source?: string;
  rows: SpotBasisRow[];
  history: Record<string, Array<{ t: string; p: number }>>;
}
export interface ChemSpot {
  id: string; name: string; price: number; quotes: number;
  date: string; source?: string; history: Array<{ t: string; p: number }>;
}
export interface FutureDaily {
  code: string; source?: string;
  points: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
}
export interface FearGreedItem {
  key: string;
  title: string;
  subtitle?: string;
  score: number | null;
  label?: string | null;
  raw?: number | null;
  detail?: string | null;
  timestamp?: string | null;
  source?: string | null;
}
export interface FearGreedBoard {
  items: FearGreedItem[];
  updated?: string;
}
export interface CtfiQuote {
  date?: string | null;
  price: number;
  chg?: number | null;
  pct?: number | null;
  extra?: string | null;
  routes?: Record<string, number>;
  source?: string;
  url?: string;
}
export interface EventCalDay {
  date: string;
  items: string[];
}
export interface EventCalBoard {
  days: EventCalDay[];
  count: number;
  src?: string;
}
export interface DxxFengRow {
  code: string; name: string; tags: string[]; a15: string; a20: string; a25: string;
}
export interface DxxFengDay {
  date: string; yizhi: number | null; seal: string; t15: string; t20: string; t25: string; rows: DxxFengRow[];
}
export interface DxxDabanRow {
  code: string; name: string; price: number | null; pct: number | null; amount: number | null;
  jj_pct: number | null; jj_amt: number | null; turn: number | null; concepts: string;
  mcap: number | null; net: number | null; board: string;
}
export interface DxxZtRow {
  code: string; name: string; reason: string; board: string; time: string;
}
export interface DxxCurve {
  last: Record<string, number>;
  series: Record<string, number[]>;
  labels: Record<string, string>;
}
export interface DxxStrong {
  legend: string[];
  last: Record<string, number>;
  series: { name: string; data: number[] }[];
}
export interface DxxFupan {
  date: string; qx: number | null; zt: number | null; dt: number | null;
  seal_rate: number | null; zt_ret: number | null; lb_ret: number | null;
}
export interface DxxWajueRow { code: string; name: string; hits: number }
export interface DxxBoard {
  src?: string;
  fengdan?: { days: DxxFengDay[] } | null;
  daban?: { rows: DxxDabanRow[] } | null;
  ztlive?: { count: number; rows: DxxZtRow[] } | null;
  qingxu?: DxxCurve | null;
  qxlive?: DxxCurve | null;
  strong?: DxxStrong | null;
  fupan?: DxxFupan | null;
  wajue?: { rows: DxxWajueRow[] } | null;
}
export interface OvlabParkedRow {
  und: string; parked: number; mult?: number; margin?: number;
}
export interface OvlabParked {
  rows: OvlabParkedRow[];
}
export interface StockBoards {
  code: string; name: string; industry: string; area: string;
  concepts: string[]; source?: string;
}
export interface MarketLiveItem {
  id: string | number; title: string; content: string; time: string;
  tags?: string[];
}
export interface MarketLives {
  source: string; count: number; items: MarketLiveItem[];
}

export interface FinStockProfit {
  code: string; name: string; industry: string;
  net_profit: number; profit_yoy: number; revenue_yoy: number; roe: number; eps: number;
}
export interface FinIndustryProfit {
  name: string; net_profit: number; count: number; yoy: number;
}
export interface FinCalendarItem {
  date: string; code: string; name: string; period: string;
}
export interface FinBoard {
  period: string; disclosed: number;
  stocks: FinStockProfit[];
  industries: FinIndustryProfit[];
  calendar: FinCalendarItem[];
  sector_tape?: { top: Array<{ name: string; change_pct: number }>; bottom?: Array<{ name: string; change_pct: number }>; total?: number };
  note?: string;
}
export interface FinForecastItem {
  date: string; code: string; name: string; type: string;
  profit_low: number; profit_high: number; yoy_low: number; yoy_high: number;
}
export interface FinForecast {
  period: string;
  stats: { good: number; bad: number; neutral: number };
  items: FinForecastItem[];
}
export interface FinReportRow {
  label: string; date: string;
  revenue: number; net_profit: number;
  revenue_yoy: number; profit_yoy: number;
  roe: number; gross_margin: number; net_margin: number;
  debt_ratio?: number; roic?: number; eps?: number; ocf_ps?: number;
}
export interface FinMainOp {
  name: string; income: number; income_ratio?: number;
  profit: number; profit_ratio?: number; margin?: number;
}
export interface FinMainOpHist {
  date: string;
  segments: Array<{ name: string; income: number; profit: number; margin?: number }>;
}
export interface FinMain {
  code: string; name: string; industry: string; reports: FinReportRow[];
  mainop?: FinMainOp[];
  mainop_history?: FinMainOpHist[];
  cash?: { operate: number; capex: number; free: number };
  balance?: { total_liabilities: number; accounts_receivable: number };
}
export interface FinCompanyBundle {
  main: FinMain;
  snapshot: Financials | null;
  valuation: Valuation | null;
  percentile: ValPercentile | null;
  announcements: Announcement[];
  reports: Report[];
}
export interface ThsProfile {
  code: string; name?: string; industry?: string;
  industries?: string[]; concepts?: string[]; source?: string;
}
export interface ThsRotation {
  kind: string; source?: string; n?: number;
  rows: Array<{
    name: string; count: number; avg_pct: number; up: number; down: number;
    leads?: Array<{ code: string; name: string; pct: number }>;
  }>;
}
/** 同花顺 fuyao 快照. pct 已由最新/昨收现算, 单位是百分点. */
export interface ThsSnapRow {
  market: string;
  code: string;
  last: number | null;
  prev: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  pct: number | null;
  volume?: number | null;
  amount?: number | null;
  lb?: number | null;
}
/** 同花顺 K 线. t 为毫秒时间戳. */
export interface ThsKlineBar {
  t: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
}
export interface StockBasicInfo {
  code: string; name?: string; industry?: string; area?: string;
  concepts?: string[];
  total_shares?: number | null; float_shares?: number | null;
  mcap?: number | null; float_mcap?: number | null;
  pe_ttm?: number | null; pb?: number | null; roe?: number | null;
  list_date?: string;
}

export interface RadarItem {
  title: string; url: string; time: string; source: string; summary?: string; zh?: string;
}
export interface Industry {
  key: string; name: string; accent: string; total: number; items: RadarItem[];
}
export interface RadarData {
  generated_at: string | null; recent_days: number; industries: Industry[];
  stats: { industries: number; total_sources: number; failed_sources?: number };
}

export interface Holding {
  code: string; name: string; price: number; shares: number; cost: number;
  market_value: number; pnl: number; pnl_pct: number;
}
export interface ClosedPosition {
  code: string; name: string; date: string; price: number; shares: number; cost: number;
  pnl: number; pnl_pct: number;
}
export interface PortfolioData {
  holdings: Holding[];
  totals: { market_value: number; cost: number; pnl: number; pnl_pct: number };
  closed: ClosedPosition[];
  realized_pnl: number;
  updated: string; last_refresh: string | null;
}

/** CTP 期货账户（只读查资金 / 持仓 / 委托 / 成交） */
export interface CtpPosition {
  exchange: string;
  instrument: string;
  direction: string;
  direction_code: string;
  hedge: string;
  position_date: string;
  position: number;
  yd_position: number;
  today_position: number;
  open_volume: number;
  close_volume: number;
  open_amount: number;
  close_amount: number;
  open_cost: number;
  position_cost: number;
  cost_per_lot: number;
  use_margin: number;
  exchange_margin: number;
  frozen_margin: number;
  frozen_cash: number;
  frozen_commission: number;
  long_frozen: number;
  short_frozen: number;
  close_profit: number;
  close_profit_by_date: number;
  close_profit_by_trade: number;
  position_profit: number;
  settlement_price: number;
  pre_settlement_price: number;
  margin_rate_by_money: number;
  margin_rate_by_volume: number;
  commission: number;
  cash_in: number;
  trading_day: string;
}
export interface CtpAccount {
  balance: number;
  /** 客户权益 / 动态权益 (Balance) */
  client_equity?: number;
  /** 市值权益 = 客户权益 + 多头期权市值 - 空头期权市值 */
  market_equity?: number;
  option_long_value?: number;
  option_short_value?: number;
  market_equity_method?: string;
  option_legs?: number;
  /** true while option ticks load in background */
  market_equity_pending?: boolean;
  available: number;
  curr_margin: number;
  exchange_margin: number;
  frozen_margin: number;
  frozen_cash: number;
  frozen_commission: number;
  pre_balance: number;
  pre_margin: number;
  deposit: number;
  withdraw: number;
  withdraw_quota: number;
  close_profit: number;
  position_profit: number;
  commission: number;
  credit: number;
  mortgage: number;
  cash_in: number;
  interest: number;
  delivery_margin: number;
  risk_ratio: number;
  currency: string;
  trading_day: string;
  account_id: string;
}
export interface CtpOrder {
  exchange: string;
  instrument: string;
  direction: string;
  direction_code: string;
  offset: string;
  hedge: string;
  price_type: string;
  limit_price: number;
  stop_price: number;
  volume_total: number;
  volume_traded: number;
  volume_left: number;
  min_volume: number;
  time_condition: string;
  volume_condition: string;
  status: string;
  status_code: string;
  submit_status: string;
  status_msg: string;
  order_sys_id: string;
  order_ref: string;
  order_local_id: string;
  broker_order_seq: number;
  insert_time: string;
  update_time: string;
  cancel_time: string;
  active_time: string;
  trading_day: string;
  front_id: number;
  session_id: number;
  force_close_reason: string;
  user_force_close: boolean;
  is_swap_order: boolean;
}
export interface CtpTrade {
  exchange: string;
  instrument: string;
  exchange_inst_id: string;
  direction: string;
  direction_code: string;
  offset: string;
  hedge: string;
  price: number;
  volume: number;
  amount: number;
  trade_id: string;
  order_sys_id: string;
  order_ref: string;
  order_local_id: string;
  broker_order_seq: number;
  trade_type: string;
  price_source: string;
  trade_source: string;
  trade_time: string;
  trading_day: string;
  sequence_no: number;
}
/** 持仓明细 (按开仓笔, 含逐笔平仓盈亏) */
export interface CtpPositionDetail {
  exchange: string;
  instrument: string;
  comb_instrument: string;
  direction: string;
  direction_code: string;
  hedge: string;
  open_date: string;
  trade_id: string;
  trade_type: string;
  open_price: number;
  volume: number;
  close_volume: number;
  close_amount: number;
  close_profit_by_date: number;
  close_profit_by_trade: number;
  position_profit_by_date: number;
  position_profit_by_trade: number;
  margin: number;
  exch_margin: number;
  margin_rate_by_money: number;
  margin_rate_by_volume: number;
  last_settlement_price: number;
  settlement_price: number;
  time_first_volume: number;
  trading_day: string;
}
export interface CtpPortfolioData {
  trading_day: string;
  account: CtpAccount;
  positions: CtpPosition[];
  details: CtpPositionDetail[];
  orders: CtpOrder[];
  trades: CtpTrade[];
  totals: {
    position_count: number;
    detail_count: number;
    order_count: number;
    trade_count: number;
    use_margin: number;
    position_profit: number;
    close_profit: number;
    detail_close_profit: number;
    detail_position_profit: number;
    market_equity?: number;
    option_long_value?: number;
    option_short_value?: number;
  };
  updated: string;
  user_masked: string;
  logged_in?: boolean;
  market_equity_pending?: boolean;
}
export interface CtpMarketEquityJob {
  status: "idle" | "pending" | "running" | "ready" | "error";
  seq: number;
  trading_day: string;
  updated: string | null;
  error: string | null;
  pending: boolean;
  account_patch: {
    client_equity?: number;
    market_equity?: number;
    option_long_value?: number;
    option_short_value?: number;
    market_equity_method?: string;
    option_legs?: number;
    market_equity_pending?: boolean;
  } | null;
}
export interface CtpStatus {
  configured: boolean;
  dependency_ok: boolean;
  dependency_msg: string;
  config_path: string;
  user_masked: string;
  ready: boolean;
  logged_in: boolean;
  logging_in: boolean;
  trading_day: string;
  host: string;
}
export interface CtpLogEntry {
  id: number;
  ts: string;
  level: string;
  message: string;
}
export interface CtpLogsData {
  logs: CtpLogEntry[];
  next_since: number;
  logged_in: boolean;
}
/** 结算单解析字段 */
export interface CtpSettlementParsed {
  equity: number | null;
  market_equity: number | null;
  client_equity: number | null;
  pre_balance: number | null;
  balance: number | null;
  available: number | null;
  deposit_withdraw: number | null;
  close_profit: number | null;
  position_profit: number | null;
  commission: number | null;
  curr_margin: number | null;
  risk_ratio: number | null;
  option_long_value: number | null;
  option_short_value: number | null;
}
export interface CtpSettlementData {
  trading_day: string;
  parsed: CtpSettlementParsed;
  content: string;
  chunk_count: number;
  updated: string;
  status?: string;
  from_cache?: boolean;
}
export interface CtpSettlementSeriesPoint {
  trading_day: string;
  date: string;
  equity: number | null;
  market_equity: number | null;
  client_equity: number | null;
  balance: number | null;
  available: number | null;
  deposit_withdraw?: number | null;
  close_profit: number | null;
  position_profit: number | null;
  commission: number | null;
  curr_margin: number | null;
  risk_ratio: number | null;
  status: string;
  from_cache: boolean;
  error: string | null;
  updated?: string;
}
export interface CtpSettlementPerfPoint {
  date: string;
  trading_day: string;
  equity: number;
  deposit_withdraw: number;
  commission: number;
  daily_pnl: number;
  /** income = daily_pnl - commission */
  daily_income?: number;
  daily_return: number;
  cum_pnl: number;
  cum_pnl_wan: number;
  cum_income?: number;
  cum_income_wan?: number;
  cum_return: number;
  nav: number;
  drawdown: number;
}
export interface CtpSettlementMonth {
  month: string;
  trading_day_start: string;
  trading_day_end: string;
  pnl: number;
  /** income = pnl - commission */
  income?: number;
  pnl_wan: number;
  deposit_withdraw: number;
  commission: number;
  days: number;
  win_days: number;
  loss_days: number;
  return: number;
  equity_start: number;
  equity_end: number;
}
export interface CtpSettlementAnalytics {
  perf: CtpSettlementPerfPoint[];
  monthly: CtpSettlementMonth[];
  calendar_daily: {
    date: string;
    trading_day: string;
    pnl: number;
    /** income = pnl - commission */
    income?: number;
    return: number;
    commission: number;
    equity: number;
  }[];
  summary: {
    days: number;
    start_date: string | null;
    end_date: string | null;
    start_equity: number | null;
    end_equity: number | null;
    total_pnl: number;
    total_pnl_wan: number;
    total_income?: number;
    total_commission?: number;
    total_return: number;
    nav: number;
    max_drawdown: number;
    win_days: number;
    loss_days: number;
    flat_days: number;
    win_rate: number | null;
    avg_daily_return: number;
    daily_volatility: number | null;
    ann_return: number | null;
    sharpe: number | null;
    best_day: { date: string; trading_day: string; daily_pnl: number; daily_return: number } | null;
    worst_day: { date: string; trading_day: string; daily_pnl: number; daily_return: number } | null;
    total_deposit_withdraw: number;
    method: string;
  };
  charts: {
    equity: { date: string; value: number }[];
    nav: { date: string; value: number }[];
    cum_return: { date: string; value: number }[];
    cum_pnl_wan: { date: string; value: number }[];
  };
}
export interface CtpSettlementRangeData {
  start: string;
  end: string;
  account: string;
  series: CtpSettlementSeriesPoint[];
  chart: { date: string; trading_day: string; equity: number; market_equity: number | null; client_equity: number | null }[];
  analytics?: CtpSettlementAnalytics;
  stats: {
    total_days: number;
    cached: number;
    fetched: number;
    empty: number;
    errors: number;
    missing: number;
    deferred?: number;
  };
  cache_file: string;
  updated: string;
}

// 资金面 / 筹码 / 信号（v3.3 并入，均为「用户查的那只股」的公开数据）
export interface MarginRow { date: string; rzye: number; rzmre: number; rzche: number; rqye: number; rqmcl: number; rzrqye: number }
export interface BlockTradeRow { date: string; price: number; close: number; premium_pct: number; vol: number; amount: number; buyer: string; seller: string }
export interface HolderRow { date: string; holder_num: number; change_ratio: number; avg_shares: number }
export interface EtfFlowRow {
  code: string; name: string; price: number; change_pct: number; total_mv: number;
  main_net_inflow: number; super_large_net: number; large_net: number;
  medium_net: number; small_net: number; update_time?: string;
}
export interface EtfFlow {
  sort_by: string; total: number; note?: string; rows: EtfFlowRow[];
}
export interface EtfShareDay {
  date: string; name?: string; shares_wan?: number; shares_yi: number;
}
export interface EtfSharePeriod {
  date: string; subscribe_yi: number | null; redeem_yi: number | null;
  net_yi: number | null; shares_yi: number | null; nav_yi?: number | null; nav_chg?: string;
}
export interface EtfShares {
  code: string; name: string; source?: string; unit?: string; note?: string;
  latest?: EtfShareDay | null; chg_yi?: number | null; chg_pct?: number | null;
  daily: EtfShareDay[]; periods: EtfSharePeriod[];
}
export const ETF_SHARE_WATCH = [
  { code: "510050", label: "上证50" },
  { code: "510300", label: "沪深300" },
  { code: "510500", label: "中证500" },
  { code: "588000", label: "科创50" },
  { code: "159915", label: "创业板" },
  { code: "159919", label: "嘉实300" },
] as const;
export interface ShareholderChangeRow {
  date: string; code: string; name: string; person: string; change_type: string;
  change_shares: number; change_ratio: number; avg_price: number;
  change_amount: number; after_holding: number; reason: string; position: string;
}
export interface ShareholderChanges {
  code?: string | null; change_type: string; total: number; note?: string;
  rows: ShareholderChangeRow[];
}
export interface LprRow { date: string; one_year: number; five_year: number }
export interface LprData {
  latest: LprRow | null; total: number; source?: string; note?: string; rows: LprRow[];
}
export interface CnBondYield {
  date: string; curve_type: string; source?: string;
  terms: Record<string, number>;
  spread_10_2?: number | null; spread_30_10?: number | null;
  curve_points?: number[][];
  error?: string; warning?: string;
}
export interface MacroBoardItem {
  key: string; name: string; value: number | null;
  date?: string; period?: string; unit?: string; label?: string;
  kind?: string; pct?: number | null; prev?: number | null; change?: number | null;
  stock?: number | null; loan?: number | null; source?: string;
}
export interface MacroBoardBucket { date?: string; source?: string; items: MacroBoardItem[] }
export interface MacroBoard {
  money?: MacroBoardBucket;
  month?: MacroBoardBucket;
  us?: MacroBoardBucket;
}
export interface DividendRow { date: string; bonus_rmb: number; transfer_ratio: number; bonus_ratio: number | null; plan: string }
export interface FundFlowRow { date: string; main_net: number; small_net: number; mid_net: number; large_net: number; super_net: number }
export interface DtSeat { name: string; buy_amt: number; sell_amt: number; net: number }
export interface DragonTiger {
  records: { date: string; reason: string; net_buy: number; turnover: number }[];
  seats: { buy: DtSeat[]; sell: DtSeat[] };
  institution: { buy_amt: number; sell_amt: number; net_amt: number };
}
export interface LockupRow { date: string; type: string; shares: number; able_shares: number; ratio: number }
export interface Lockup { history: LockupRow[]; upcoming: LockupRow[] }
export interface Board { name: string; code: string; change_pct: number | string; lead_stock: string }
export interface Blocks { total: number; boards: Board[]; concept_tags: string[] }
export interface HotConcept { concept: string; bk: string; hit: number }
export interface QaRow { company: string; question: string; answer: string | null; answerer: string; ask_time: string }
export interface IndustryRow { rank: number; name: string; change_pct: number; code: string; up_count: number; down_count: number }
export interface IndustryData { top: IndustryRow[]; bottom: IndustryRow[]; total: number }

export interface ReviewSnapshotError {
  name: string;
  error: string;
}
/** Daily Review BFF: paint (Tencent+overview) / top / full. */
export interface ReviewSnapshot {
  scope: "paint" | "top" | "full";
  indices: IndexQuote[] | null;
  overview: MarketOverview | null;
  emotion: ShortTermEmotion | null;
  industry: IndustryData | null;
  lhb: DailyDragonTiger | null;
  hsgt?: HsgtLive | null;
  errors: ReviewSnapshotError[];
  updated: string;
}

// 全球市场（美股 / 港股，移植自 global-stock-data · 东财域内源）
export interface GlobalQuote {
  code: string; name: string;
  price: number | null; open: number | null; high: number | null; low: number | null;
  prev_close: number | null; amount: number | null; mcap: number | null; change_pct: number | null;
}
export interface GlobalMetrics {
  report_date: string;
  revenue: number | null; revenue_yoy: number | null; net_profit: number | null;
  eps: number | null; roe: number | null; gross_margin: number | null;
  net_margin: number | null; debt_ratio: number | null;
}
export interface GlobalStock {
  code: string; name: string; market: string;
  quote: GlobalQuote; metrics: GlobalMetrics | null;
}
export interface HkCashflowItem { amount: number | null; yoy: number | null }
export interface HkCashflowPeriod {
  report_date: string; report: string | null;
  currency: string | null; account_standard: string | null;
  items: Record<string, HkCashflowItem>;
}
export interface HkCashflow {
  code: string; name: string; market: string;
  currency: string | null; item_order: string[]; periods: HkCashflowPeriod[];
}
export interface UsKlineBar {
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}
export interface UsKline {
  code: string; name?: string; market: string; source?: string;
  /** qfq = forward adjusted; none = raw (sina fallback) */
  adjust?: "qfq" | "none" | string;
  bars: UsKlineBar[];
}

/** Yahoo valuation / analyst / holders bundle */
export interface GlobalValuation {
  code?: string; name?: string; market?: string; yahoo_symbol?: string;
  /** yahoo | yahoo_quote | eastmoney */
  source?: string;
  current_price?: number | null; target_mean?: number | null;
  target_high?: number | null; target_low?: number | null;
  recommendation?: string | null;
  trailing_pe?: number | null; forward_pe?: number | null; peg_ratio?: number | null;
  price_to_book?: number | null; enterprise_value?: number | null;
  ev_to_ebitda?: number | null; beta?: number | null;
  profit_margin?: number | null; operating_margin?: number | null; gross_margin?: number | null;
  return_on_equity?: number | null; return_on_assets?: number | null;
  earnings_growth?: number | null; revenue_growth?: number | null;
  dividend_yield?: number | null; short_ratio?: number | null;
  market_cap?: number | null; total_cash?: number | null; total_debt?: number | null;
}
export interface GlobalAnalyst {
  code?: string; name?: string; market?: string;
  eps_trend: Array<{
    period?: string; end_date?: string; eps_estimate?: number | null;
    eps_high?: number | null; eps_low?: number | null;
    revenue_estimate?: number | null; num_analysts?: number | null;
  }>;
  rating_trend: Array<{
    period?: string; strong_buy?: number; buy?: number; hold?: number;
    sell?: number; strong_sell?: number;
  }>;
  upgrade_downgrade: Array<{
    date?: number; firm?: string; to_grade?: string; from_grade?: string; action?: string;
  }>;
}
export interface GlobalHolders {
  code?: string; name?: string; market?: string;
  overview: {
    insiders_pct?: number | null; institutions_pct?: number | null;
    institutions_float_pct?: number | null; institutions_count?: number | null;
  };
  top_holders: Array<{
    name?: string; shares?: number | null; value?: number | null;
    pct_held?: number | null; report_date?: string | null;
  }>;
}
export interface GlobalFundamentals {
  code: string; name: string; market: string; note?: string;
  source?: string | null;
  valuation: GlobalValuation | null;
  analyst: GlobalAnalyst | null;
  holders: GlobalHolders | null;
}

export function fundamentalsSourceLabel(src?: string | null) {
  if (src === "eastmoney") return "东财 (Yahoo 不可达)";
  if (src === "yahoo_quote") return "Yahoo quote";
  return "Yahoo";
}
export interface GlobalStmtItem { amount: number | null; yoy: number | null }
export interface GlobalStatements {
  code: string; name: string; market: string; statement: string;
  currency: string | null; item_order: string[];
  periods: Array<{
    report_date: string; report?: string | null; currency?: string | null;
    items: Record<string, GlobalStmtItem>;
  }>;
}
export interface GlobalSecFilings {
  code: string; name: string; cik: string; company_name?: string;
  filings: Array<{
    form: string; form_label?: string; date: string; description?: string; url?: string | null;
  }>;
}
export interface GlobalSecDaily {
  date: string; total: number; by_form: Record<string, number>;
  filings: Array<{
    form: string; form_label?: string; company: string; cik: string; date: string; url?: string | null;
  }>;
}
export interface GlobalEdgarScreener {
  compliance?: string; source?: string;
  tag: string; tag_label: string; period: string; unit: string;
  instant?: boolean; universe: number; ascending?: boolean;
  tags: Array<{ label: string; tag: string }>;
  rows: Array<{ cik?: number | string; entity?: string; value?: number; end?: string }>;
}
export interface GlobalMovers {
  board: string; market: string; total: number;
  stocks: Array<{
    code?: string; name?: string; price?: number | null; change_pct?: number | null;
    volume?: number | null; amount?: number | null; amplitude?: number | null;
  }>;
}
export interface GlobalStockNews {
  code: string; name?: string; market?: string; yahoo_symbol?: string;
  compliance?: string; source?: string;
  items: Array<{
    title?: string; publisher?: string; link?: string;
    publish_time?: string | null; publish_ts?: number | null; thumbnail?: string | null;
  }>;
}
export interface GlobalEarningsRow {
  date?: string; symbol?: string; name?: string; time?: string;
  eps_forecast?: string; market_cap?: string;
}
export interface GlobalEarningsCalendar {
  start: string; end: string; days: number; total: number;
  by_day: Array<{ date: string; count: number; rows: GlobalEarningsRow[] }>;
}
export interface GlobalOptContract {
  symbol?: string; expiry?: string; type?: string; strike?: number;
  bid?: number | null; ask?: number | null; volume?: number; open_interest?: number;
  iv?: number | null; delta?: number | null; gamma?: number | null;
  vega?: number | null; theta?: number | null; last_trade_price?: number | null;
  vol_oi_ratio?: number | null;
}
export interface GlobalOptSummary {
  call_volume: number; put_volume: number;
  put_call_volume_ratio: number | null;
  call_oi: number; put_oi: number;
  put_call_oi_ratio: number | null;
  volume_weighted_iv: number | null;
  net_delta_exposure_shares: number;
  contracts_total: number; contracts_traded: number;
}
export interface GlobalOptions {
  code: string; name: string; market: string; ticker: string;
  timestamp?: string; spot?: number | null; et_today?: string;
  compliance?: string; note?: string;
  expiries: string[];
  summary_all: GlobalOptSummary;
  summary_0dte: GlobalOptSummary | null;
  summary_7d: GlobalOptSummary | null;
  unusual_0dte: GlobalOptContract[];
  unusual_7d: GlobalOptContract[];
  atm_0dte: GlobalOptContract[];
}
/** A-share light chart bar (分时/5日/日K) */
export interface AShareLightBar {
  datetime: string;
  open: number; high: number; low: number; close: number;
  volume: number; amount?: number;
}
export interface AShareLightKline {
  code: string; name?: string;
  resolution: "1" | "5" | "1D" | string;
  adjust?: "qfq" | "none" | string;
  source?: string;
  prev_close?: number | null;
  bars: AShareLightBar[];
}

// OpenVlab 期权 / 期货波动率市场数据（移植自 openvlab.cn 爬虫, 公开 REST 接口）
export interface OvlabMarketRow {
  product_alias?: string; prodUnd?: string; product?: string;
  exchange?: string; sector_alias?: string; sector?: string;
  price?: number | string; ctn?: number | string;
  atmv_current?: number | string; atmv_1dchg?: number | string; atmv_percentile?: number | string;
  rv22?: number | string; valphaT?: number | string; carry?: number | string;
  skew_current?: number | string; skew_1dchg?: number | string; skew_percentile?: number | string;
  frontfwd_mom?: number | string; exp?: string; expiry_date?: string;
  last_time?: string; has_night_trading?: boolean | number; is_overseas?: boolean | number;
  [k: string]: unknown;
}
export type OvlabDetail = Record<string, unknown>;
export type OvlabVolatilityTs = Record<string, unknown>;
export interface OvlabFutureTsMonth {
  maturity?: number;
  bid?: number;
  ask?: number;
  future_tday?: number;
  future_yday?: number;
  oi_tday?: number;
  oi_yday?: number;
  days_to_expiry?: number;
}
export type OvlabFutureTs = Record<string, OvlabFutureTsMonth>;
export type OvlabFutureTsAll = Record<string, unknown>;
export interface ArbLeg {
  code: string;
  exp: string;
  px: number;
  pxYd?: number | null;
  oi?: number | null;
  dte: number;
}
export interface ArbCalendarRow {
  und: string;
  label: string;
  near: ArbLeg;
  next: ArbLeg;
  spread: number | null;
  spreadYd: number | null;
  spreadChg: number | null;
}
export interface ArbCrossRow {
  id: string;
  label: string;
  sector: string;
  aUnd: string;
  bUnd: string;
  aLabel: string;
  bLabel: string;
  a: ArbLeg;
  b: ArbLeg;
  spread: number | null;
  spreadYd: number | null;
  spreadChg: number | null;
}
export interface ArbIndexRow {
  id: string;
  und: string;
  label: string;
  cashCode: string;
  cashKind: "index" | "etf";
  cashLabel: string;
  cashMult: number;
  near: ArbLeg;
}
export interface ArbBoard {
  calendar: ArbCalendarRow[];
  cross: ArbCrossRow[];
  index: ArbIndexRow[];
}
export interface OvlabFlowAlert {
  time?: string; instrument?: string; contract_code?: string;
  rule_id?: string; side?: string; price?: number | string;
  ctn?: string; open_interest?: number; window_volume?: number;
  window_premium?: number; pct_change?: string;
  exp_date?: string; fill_type?: string;
  price_start?: number; price_end?: number;
  [k: string]: unknown;
}
export interface OvlabMqttStatus {
  enabled: boolean;
  connected: boolean;
  broker?: string;
  topics: string[];
  sources: string[];
  recv: number;
  raw?: number;
  drop?: number;
  last_at: number | null;
  feeds_ui: boolean;
  optionflow?: OvlabFlowAlert[];
  optionflow_n?: number;
  ctamap?: OvlabMarketRow[];
  ctamap_n?: number;
  dataview?: OvlabDataviewTick[];
  dataview_n?: number;
  error?: string | null;
}
/** MQTT dataview last print (per contract). */
export interface OvlabDataviewTick {
  instr: string;
  last?: number | null;
  oi?: number | null;
  /** unix seconds when the sidecar ingested this print */
  at?: number | null;
}
export interface OvlabWarehouseHistory {
  last_update_time?: string; value?: unknown; category?: string;
  ratioData?: unknown;
  [k: string]: unknown;
}
/** 仓单瘦身 (warehouse/history): 最新 + 日变 + 近90日. */
export interface OvlabWarehouseReceipt {
  product: string;
  asOf?: string;
  last?: number | null;
  chg?: number | null;
  updated?: string;
  spark?: Array<[string, number]>;
}
// 异动资金流 (flow-data)
export interface OvlabFlowDataRow {
  product_alias?: string; full_name?: string; product_und?: string;
  sector?: string; exchange?: string; instrument?: string;
  last_trade_price?: number; ctnPct?: number; underlying_price?: number;
  otmPct?: number; volume?: number; volume_value?: number;
  oi?: number; prevOi?: number; oiChange?: number; oiChangePct?: number; oiChangeVal?: number;
  strikePrice?: number; optType?: string; dte?: number;
  trade_at_ask?: number; trade_at_bid?: number; trade_at_mid?: number;
  ask_percentage?: number; bid_percentage?: number; mid_percentage?: number;
  contract_code?: string;
  [k: string]: unknown;
}
export interface OvlabFlowData {
  data: OvlabFlowDataRow[];
  totalCount?: number; page?: number; pageSize?: number; totalPages?: number;
}
export interface OvlabProductExpExpiry { exp?: number; expDate?: string; limit_up?: number; limit_down?: number; [k: string]: unknown }
export interface OvlabProductExp {
  sector?: string; sector_alias?: string; gui_order?: number;
  product?: string; product_und?: string; product_alias?: string;
  symbol?: string; symbol_und?: string; has_night_trading?: number;
  is_overseas?: string; exchange?: string;
  exps?: OvlabProductExpExpiry[];
  [k: string]: unknown;
}
export interface OvlabExchangeInfo { code?: string; name?: string; [k: string]: unknown }
export interface OvlabSectorInfo { code?: string; name?: string; [k: string]: unknown }

/** T 型报价: 单侧 (Call/Put) 每档. price 为 Black-76 理论价 (theoIv + forward 反推).
 *  pct 为相对昨理论价涨幅 (今-昨)/昨, 昨=forward_yd+theovol_yday 反推. */
export interface OvlabTQuoteSide {
  price?: number | null;
  /** 相对昨理论价, 小数比率 (0.03 = +3%). */
  pct?: number | null;
  ivBid?: number | null;
  ivAsk?: number | null;
  theoIv?: number | null;
  /** Yesterday fitted IV (theovol_yday). Same on call/put. */
  theoIvYd?: number | null;
  delta?: number | null;
  oi?: number | null;
  oiChg?: number | null;
}
export interface OvlabTQuoteStrike {
  strike: number;
  /** 期权合约代码 (OpenVlab), 如 AU2609C952. */
  callCode?: string;
  putCode?: string;
  call: OvlabTQuoteSide;
  put: OvlabTQuoteSide;
}
export interface OvlabTQuoteExpiry {
  exp: string;
  /** 标的码 (IV 日线用): 期货期权 {prod}{ym}, ETF 期权为基金代码. */
  und?: string;
  expiryDate?: string;
  dte?: number | null;
  /** Year fraction (maturity_tday). Term chart X is dte, not this. */
  maturity?: number | null;
  /** Smile window from surface display_strike. */
  displayLo?: number | null;
  displayHi?: number | null;
  forward?: number | null;
  forwardYd?: number | null;
  /** 当月期货最新 (future-ts future_tday). ETF 无期货则空, 前端回落行情观察. */
  futPx?: number | null;
  /** 当月期货涨幅 (今-昨)/昨. */
  futPct?: number | null;
  atmIv?: number | null;
  atmIvYd?: number | null;
  pcr?: number | null;
  moveUp?: number | null;
  moveDn?: number | null;
  sumOiCall?: number | null;
  sumOiPut?: number | null;
  /** Yesterday month OI (surface sum_poi_call). */
  sumOiCallYd?: number | null;
  sumOiPutYd?: number | null;
  lastTime?: string;
  atm?: number | null;
  /** Surface theovol_tday pairs (not T-ladder interp). */
  theoSmile?: Array<[number, number]>;
  /** Surface theovol_yday pairs. */
  theoSmileYd?: Array<[number, number]>;
  strikes: OvlabTQuoteStrike[];
}
export interface OvlabTQuote {
  product: string;
  expiries: OvlabTQuoteExpiry[];
}

/** 期权日K (分钟聚合): 交易日 OHLCV + 标的平值隐波日线. */
export interface OvlabOptionDailyBar {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}
export interface OvlabOptionDaily {
  code: string;
  und: string;
  bars: OvlabOptionDailyBar[];
  iv: Array<[string, number | null]>;
}

/** 期限结构: 单品种远期曲线点 (volatility-surface forward 今/昨 + 该月期权持仓). */
export interface OvlabTermPoint {
  exp: string;
  dte: number;
  fwd: number;
  fwdYd: number | null;
  /** Call+Put 期权持仓; 上游缺字段为 null. */
  oi?: number | null;
  /** 标的合约码: 期货 AG2609, ETF 为基金代码. */
  code?: string;
}
export interface OvlabTermStructure {
  curves: Record<string, OvlabTermPoint[]>;
}

/** Market hover preview: price + IV intraday series (price-volatility-series) */
export interface OvlabPriceVolSeriesItem {
  symbol?: string;
  prices?: Array<[string, number]>;
  volatilities?: Array<[string, number]>;
  intervals?: Array<[string, string]>;
  [k: string]: unknown;
}

// 轻量行情图表
export interface OvlabKlineBar {
  trade_date: string; ts_code?: string;
  open: number; high: number; low: number; close: number;
  pre_close?: number; settle?: number; change1?: number; change2?: number;
  vol?: number; amount?: number; oi?: number; oi_chg?: number;
  [k: string]: unknown;
}
export interface OvlabKlineHistory { data: OvlabKlineBar[] }
export interface OvlabAtmvolHistory { data: Array<[string, number]> }
export interface OvlabLastBar {
  close: number; open: number; high: number; low: number;
  oi?: number; vol?: number; pre_close?: number; pre_close_1w?: number;
  trade_date?: string; [k: string]: unknown;
}
export interface OvlabSymbolInfo {
  ticker?: string; name?: string; exchange?: string; description?: string;
  sector?: string; type?: string; pricescale?: number; minmov?: number;
  session?: string; expiration_date?: string; [k: string]: unknown;
}
export interface OvlabSearchItem {
  ticker?: string; name?: string; exchange?: string; description?: string;
  sector?: string; type?: string; pricescale?: number; minmov?: number;
  session?: string; expiration_date?: string; [k: string]: unknown;
}
export type OvlabVolSurface = Record<string, Record<string, unknown>>;
export type OvlabSkewmap = Record<string, Record<string, unknown>>;
export type OvlabSurfacemap = Record<string, Record<string, unknown>>;

// 持仓排名 (flow/option-flow)
export interface OvlabPositionProduct {
  product: string;
  product_alias: string;
  exchange_name: string;
  codes: string[];
}
export interface OvlabPositionProducts {
  last_trading_day: string;
  products: OvlabPositionProduct[];
}
export interface OvlabRankRow {
  id?: number | null;
  code?: string;
  day?: string;
  underlyingCode?: string;
  rankTypeId?: number;
  rank?: number;
  memberName?: string;
  indicator?: number;
  indicatorIncrease?: number;
  [k: string]: unknown;
}
export interface OvlabRankChart {
  style?: Record<string, unknown>;
  brokers?: unknown[];
  current?: unknown[];
  change?: unknown[];
  increase?: unknown[];
  decrease?: unknown[];
  [k: string]: unknown;
}
export interface OvlabFuturePositionDetails {
  codes?: string[];
  futureName?: string;
  instrument?: string;
  tradingDay?: string;
  days?: string[];
  short_rank_table?: OvlabRankRow[];
  long_rank_table?: OvlabRankRow[];
  net_short_rank_table?: OvlabRankRow[];
  net_long_rank_table?: OvlabRankRow[];
  short_rank_chart?: OvlabRankChart;
  long_rank_chart?: OvlabRankChart;
  net_short_rank_chart?: OvlabRankChart;
  net_long_rank_chart?: OvlabRankChart;
  maxNetShort?: { memberName?: string; netIndicator?: number };
  maxNetLong?: { memberName?: string; netIndicator?: number };
  status?: number;
  [k: string]: unknown;
}
export type OvlabOptionPositionDetails = Record<string, unknown>;

// —— Fino 机构观点 ——
export interface FinoOverviewRow {
  product_name?: string;
  product_code?: string;
  date?: string;
  report_type?: string;
  bull_count?: number;
  neutral_count?: number;
  bear_count?: number;
  bull_percentage?: number;
  neutral_percentage?: number;
  bear_percentage?: number;
  bull_views?: string;
  neutral_views?: string;
  bear_views?: string;
  consensus_views?: string;
  disagreement_views?: string;
  [k: string]: unknown;
}
/** rating: "+1" bull / "0" neutral / "-1" bear */
export interface FinoDetailRow {
  date?: string;
  viewpoint?: string;
  rating?: string | number;
  detail?: string;
  product_code?: string;
  product_name?: string;
  uni_id?: string;
  source?: string;
  [k: string]: unknown;
}

export interface ReviewWarmupStatus {
  trading_day?: boolean;
  session_now?: string;
}

export interface ReviewMailStatus {
  enabled: boolean;
  at: string;
  to: string | null;
  smtp_ready: boolean;
  llm_ready: boolean;
  llm_model: string | null;
  llm_provider: string | null;
  last_sent_date: string | null;
  last_error: string | null;
  last_ok: boolean;
  running: boolean;
  weekday: boolean;
  trading_day?: boolean;
}

export interface ReviewMailRun {
  ok: boolean;
  date?: string;
  to?: string;
  chars?: number;
  collect_errors?: string[];
  error?: string;
}

export interface ReviewContextPacked {
  text: string;
  missing: string[];
  prompt_task: string;
  errors: string[];
}

export const api = {
  health: () => get<{ ok: boolean }>("/health"),
  reviewWarmup: () => get<ReviewWarmupStatus>("/market/review-warmup"),
  reviewMailStatus: () => get<ReviewMailStatus>("/market/review-mail"),
  reviewMailSave: (body: { enabled?: boolean; at?: string; to?: string }) =>
    request<ReviewMailStatus>("/market/review-mail", "PUT", body),
  reviewMailRun: () => request<ReviewMailRun>("/market/review-mail/run", "POST"),
  reviewSnapshot: (opts?: { scope?: "paint" | "top" | "full" }) => {
    const p = new URLSearchParams({ scope: opts?.scope ?? "full" });
    return get<ReviewSnapshot>(`/market/review-snapshot?${p}`);
  },
  reviewContext: (body: {
    watch_codes?: string[];
    sector_kind?: "01" | "02";
    news_source?: "cls" | "lives" | "jin10";
  }) => request<ReviewContextPacked>("/market/review-context", "POST", body),
  stockFlow: (top = 15, board?: string | null) =>
    get<StockFlow>(`/market/stock-flow?top=${top}${board ? `&board=${encodeURIComponent(board)}` : ""}`),
  /** Quote-row 主力净额/净占比. 60ms 合并, 对齐参考看板 api.stockFlow(code). */
  quoteFlow: (code: string) => quoteFlowLoader(code),
  stockFlows: (codes: string[]) =>
    get<QuoteFlow[]>(`/market/stock-flows?codes=${encodeURIComponent(codes.slice(0, 40).join(","))}`),
  stockFlowBatch: (codes: string[]) =>
    get<Record<string, StockFlowCell>>(
      `/market/stock-flow-batch?codes=${encodeURIComponent(codes.slice(0, 40).join(","))}`,
    ),
  marketQuotes: (codes: string[]) =>
    withFallback(
      () => get<Record<string, MarketQuote>>(
        `/market/quotes?codes=${encodeURIComponent(codes.slice(0, 80).join(","))}`,
      ),
      async () => {
        const map = await fetchDirectQuotes(codes.slice(0, 80));
        const out: Record<string, MarketQuote> = {};
        const put = (k: string, q: DirectQuote) => { out[k] = q; };
        for (const [k, q] of Object.entries(map)) {
          put(k, q);
          put(q.symbol, q);
          if (/^(sh|sz|bj)\d{6}$/i.test(q.symbol)) put(q.symbol.slice(2), q);
        }
        return out;
      },
    ),
  sectorBoards: (kind: "01" | "02" = "01", direction: "0" | "1" = "0", n = 40) =>
    withFallback(
      () => get<SectorBoard[]>(`/market/boards?kind=${kind}&direction=${direction}&n=${n}`),
      async () => {
        const rows = await fetchDirectBoards(kind, direction === "1" ? 1 : 0, n);
        return rows.map((b) => ({
          code: b.code, raw_code: b.raw_code, name: b.name,
          price: b.price, change: b.change, pct: b.pct,
          lead_code: b.lead_code, lead_name: b.lead_name, lead_pct: b.lead_pct,
          pct5: b.pct5, pct20: b.pct20,
        }));
      },
    ),
  boardStocks: (code: string, n = 12) =>
    get<BoardStock[]>(`/market/board-stocks?code=${encodeURIComponent(code)}&n=${n}`),
  stockRank: (sort: "amount" | "changepercent" = "amount", asc: 0 | 1 = 0, n = 30) =>
    get<StockRankRow[]>(`/market/rank?sort=${sort}&asc=${asc}&n=${n}`),
  boardFlowIntraday: (n = 20, curves = true) =>
    get<BoardFlowIntraday[]>(`/market/board-flow-intraday?n=${n}${curves ? "" : "&curves=0"}`),
  commodities: (codes?: string) =>
    get<Record<string, CommodityQuote>>(`/market/commodities${codes ? `?codes=${encodeURIComponent(codes)}` : ""}`),
  fearGreed: () => get<FearGreedBoard>("/market/fear-greed"),
  ctfi: () => get<CtfiQuote>("/market/ctfi"),
  ctfiImg: async () => {
    let resp: Response;
    try {
      resp = await fetch("/api/market/ctfi-img", { cache: "no-store", headers: authHeaders() });
    } catch {
      throw new ApiError("连接不到后端，请先启动 backend（uvicorn app:app --port 8900）", 0);
    }
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new ApiError("后端开启了访问鉴权（VR_API_KEY）：请在「接入 AI」页底部填写后端访问密钥", 401);
      }
      throw new ApiError(`CTFI 图 HTTP ${resp.status}`, resp.status);
    }
    return resp.blob();
  },
  eventCalendar: () => get<EventCalBoard>("/event/calendar"),
  dxxBoard: () => get<DxxBoard>("/dxx/board"),
  commodityMinutes: (codes: string) =>
    get<Record<string, CommodityMinute | null>>(`/market/commodity-minutes?codes=${encodeURIComponent(codes)}`),
  spotTable: () => get<SpotTable>("/market/spot-table"),
  chemSpot: (id: string, name = "") =>
    get<ChemSpot>(`/market/chem-spot?id=${encodeURIComponent(id)}${name ? `&name=${encodeURIComponent(name)}` : ""}`),
  futureDaily: (code: string, n = 400) =>
    get<FutureDaily>(`/market/future-daily?code=${encodeURIComponent(code)}&n=${n}`),
  stockBoardsBatch: (codes: string[]) =>
    get<Record<string, StockBoards>>(`/market/stock-boards-batch?codes=${encodeURIComponent(codes.slice(0, 12).join(","))}`),
  marketLives: (page = 1, size = 40, source?: "jin10") =>
    get<MarketLives>(`/market/lives?page=${page}&size=${size}${source ? `&source=${source}` : ""}`),
  marketBreadth: () => get<MarketBreadth>("/market/breadth"),
  thsProfile: (code: string) =>
    get<ThsProfile>(`/market/ths-profile?code=${encodeURIComponent(code)}`),
  thsRotation: (kind: "concept" | "industry" = "concept", top = 15) =>
    get<ThsRotation>(`/market/ths-rotation?kind=${kind}&top=${top}`),
  /** 同花顺 fuyao 快照/K线. 独立源, 不进报价中心. */
  thsSnapshot: (codes: string[]) =>
    get<ThsSnapRow[]>(`/ths/snapshot?codes=${encodeURIComponent(codes.slice(0, 50).join(","))}`),
  thsKline: (code: string, period: "day_1" | "min_1" | "min_5" = "day_1", count = 400) =>
    get<ThsKlineBar[]>(`/ths/kline?code=${encodeURIComponent(code)}&period=${period}&count=${count}`),
  finBoard: (period = "") =>
    get<FinBoard>(`/fin/board${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  finForecast: (period = "") =>
    get<FinForecast>(`/fin/forecast${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  finCompany: (code: string) =>
    get<FinCompanyBundle>(`/fin/company?code=${encodeURIComponent(code)}`),
  finSuggest: (q: string, n = 8) =>
    get<Array<{ code: string; name: string }>>(`/fin/suggest?q=${encodeURIComponent(q)}&n=${n}`),
  etfFlow: (sortBy: "net_inflow" | "change_pct" = "net_inflow", limit = 40) =>
    get<EtfFlow>(`/market/etf-flow?sort_by=${sortBy}&limit=${limit}`),
  etfShares: (code = "510300", n = 80) =>
    get<EtfShares>(`/market/etf-shares?code=${encodeURIComponent(code)}&n=${n}`),
  etfSharesBatch: (codes: string[] = [...ETF_SHARE_WATCH.map((x) => x.code)], n = 80) =>
    get<{ items: EtfShares[] }>(
      `/market/etf-shares?codes=${encodeURIComponent(codes.join(","))}&n=${n}`,
    ),
  shareholderChanges: (opts?: { code?: string; changeType?: "all" | "增持" | "减持"; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.code) p.set("code", opts.code);
    if (opts?.changeType) p.set("change_type", opts.changeType);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    const q = p.toString();
    return get<ShareholderChanges>(`/shareholder-changes${q ? `?${q}` : ""}`);
  },
  lpr: (days = 365) => get<LprData>(`/market/lpr?days=${days}`),
  cnBondYield: (curveType: "treasury" | "policy" = "treasury") =>
    get<CnBondYield>(`/market/bond-yield?curve_type=${curveType}`),
  macroBoard: () => get<MacroBoard>("/market/macro-board"),
  stockBasic: (code: string) => get<StockBasicInfo>(`/stock-basic?code=${code}`),
  globalStock: (symbol: string, opts?: { withMetrics?: boolean }) => {
    const p = new URLSearchParams({ symbol });
    if (opts?.withMetrics === false) p.set("with_metrics", "false");
    return get<GlobalStock>(`/global/stock?${p}`);
  },
  usKline: (symbol: string, num = 180) =>
    get<UsKline>(`/global/us/kline?symbol=${encodeURIComponent(symbol)}&num=${num}`),
  hkCashflow: (symbol: string) => get<HkCashflow>(`/global/hk/cashflow?symbol=${encodeURIComponent(symbol)}`),
  globalEdgarScreener: (opts?: {
    tag?: string; year?: number; quarter?: number; top?: number; ascending?: boolean;
  }) => {
    const p = new URLSearchParams();
    if (opts?.tag) p.set("tag", opts.tag);
    if (opts?.year != null) p.set("year", String(opts.year));
    if (opts?.quarter != null) p.set("quarter", String(opts.quarter));
    if (opts?.top != null) p.set("top", String(opts.top));
    if (opts?.ascending) p.set("ascending", "true");
    const q = p.toString();
    return get<GlobalEdgarScreener>(`/global/edgar/screener${q ? `?${q}` : ""}`);
  },
  globalMovers: (board = "us_gainers", top = 20) =>
    get<GlobalMovers>(`/global/movers?board=${encodeURIComponent(board)}&top=${top}`),
  globalStockNews: (symbol: string, count = 10) =>
    get<GlobalStockNews>(`/global/stock/news?symbol=${encodeURIComponent(symbol)}&count=${count}`),
  globalFundamentals: (symbol: string) =>
    get<GlobalFundamentals>(`/global/stock/fundamentals?symbol=${encodeURIComponent(symbol)}`),
  globalStatements: (symbol: string, statement: "income" | "balance" | "cashflow" = "income", periods = 5) =>
    get<GlobalStatements>(
      `/global/stock/statements?symbol=${encodeURIComponent(symbol)}&statement=${statement}&periods=${periods}`,
    ),
  globalSecFilings: (symbol: string, limit = 30) =>
    get<GlobalSecFilings>(`/global/stock/sec-filings?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
  globalSecDaily: (opts?: { date?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.date) p.set("date", opts.date);
    if (opts?.limit) p.set("limit", String(opts.limit));
    const q = p.toString();
    return get<GlobalSecDaily>(`/global/sec/daily${q ? `?${q}` : ""}`);
  },
  globalEarningsCalendar: (opts?: { date?: string; days?: number }) => {
    const p = new URLSearchParams();
    if (opts?.date) p.set("date", opts.date);
    if (opts?.days != null) p.set("days", String(opts.days));
    const q = p.toString();
    return get<GlobalEarningsCalendar>(`/global/earnings-calendar${q ? `?${q}` : ""}`);
  },
  globalOptions: (symbol: string, unusualTop = 15) =>
    get<GlobalOptions>(
      `/global/stock/options?symbol=${encodeURIComponent(symbol)}&unusual_top=${unusualTop}`,
    ),
  portfolio: () => get<PortfolioData>("/portfolio"),
  addHolding: (code: string, shares: number, cost: number) => request<PortfolioData>("/portfolio/holding", "POST", { code, shares, cost }),
  removeHolding: (code: string) => request<PortfolioData>(`/portfolio/holding?code=${code}`, "DELETE"),
  refreshPortfolio: () => request<PortfolioData>("/portfolio/refresh", "POST"),
  closePosition: (code: string, date: string, price: number, shares: number, cost: number) =>
    request<PortfolioData>("/portfolio/close", "POST", { code, date, price, shares, cost }),
  removeClosed: (index: number) => request<PortfolioData>(`/portfolio/close?index=${index}`, "DELETE"),
  ctpStatus: () => get<CtpStatus>("/portfolio/ctp/status"),
  ctpLogs: (since = 0) => get<CtpLogsData>(`/portfolio/ctp/logs?since=${since}`),
  ctpLogin: () => request<{
    logged_in: boolean;
    trading_day: string;
    user_masked: string;
    message: string;
    portfolio?: CtpPortfolioData | null;
  }>("/portfolio/ctp/login", "POST"),
  ctpLogout: () => request<{ logged_in: boolean; message: string }>("/portfolio/ctp/logout", "POST"),
  ctpPortfolio: () => get<CtpPortfolioData>("/portfolio/ctp"),
  ctpMarketEquity: () => get<CtpMarketEquityJob>("/portfolio/ctp/market-equity"),
  ctpSettlement: (day: string, force = false) =>
    get<CtpSettlementData>(
      `/portfolio/ctp/settlement?day=${encodeURIComponent(day)}&force=${force ? "true" : "false"}`,
    ),
  ctpSettlementRange: (opts: { start: string; end?: string; refresh?: boolean; force?: boolean }) => {
    const p = new URLSearchParams({ start: opts.start });
    if (opts.end) p.set("end", opts.end);
    p.set("refresh", opts.refresh === false ? "false" : "true");
    p.set("force", opts.force ? "true" : "false");
    return get<CtpSettlementRangeData>(`/portfolio/ctp/settlement/range?${p}`);
  },
  valuation: (code: string) => get<Valuation>(`/valuation?code=${code}`),
  percentile: (code: string) => get<ValPercentile>(`/valuation/percentile?code=${code}`),
  financials: (code: string) => get<Financials>(`/financials?code=${code}`),
  announcements: (code: string) => get<Announcement[]>(`/announcements?code=${code}`),
  /** 轻量图：resolution 1=分时 / 5=五日 / 1D=日K前复权（腾讯） */
  /** code: 6-digit / sh000001 / hkHSI / hkHSTECH / usIXIC */
  ashareLightKline: (code: string, resolution = "1D", num = 365) =>
    get<AShareLightKline>(
      `/astock/light-kline?code=${encodeURIComponent(code)}&resolution=${encodeURIComponent(resolution)}&num=${num}`,
    ),
  /** One request, many codes. Same payload as ashareLightKline per key. */
  ashareLightKlineBatch: (codes: string[], resolution = "1", num = 240) =>
    get<Record<string, AShareLightKline | null>>(
      `/astock/light-kline-batch?codes=${encodeURIComponent(codes.slice(0, 40).join(","))}`
      + `&resolution=${encodeURIComponent(resolution)}&num=${num}`,
    ),
  reports: (code: string) => get<Report[]>(`/reports?code=${code}`),
  news: (code: string) => get<NewsItem[]>(`/news?code=${code}`),
  clsTelegraph: (limit = 50) => get<ClsTelegraph>(`/cls-telegraph?limit=${limit}`),
  margin: (code: string) => get<MarginRow[]>(`/margin?code=${code}`),
  blockTrade: (code: string) => get<BlockTradeRow[]>(`/block-trade?code=${code}`),
  holders: (code: string) => get<HolderRow[]>(`/holders?code=${code}`),
  dividend: (code: string) => get<DividendRow[]>(`/dividend?code=${code}`),
  fundFlow: (code: string) => get<FundFlowRow[]>(`/fund-flow?code=${code}`),
  fundFlowMinute: (code: string) => get<FundFlowMinute>(`/fund-flow/minute?code=${code}`),
  iwencaiStatus: () => get<{ configured: boolean }>("/iwencai/status"),
  iwencaiSelect: (q: string, limit = 12) =>
    get<IwencaiSelect>(`/iwencai/select?q=${encodeURIComponent(q)}&limit=${limit}`),
  dragonTiger: (code: string) => get<DragonTiger>(`/dragon-tiger?code=${code}`),
  lockup: (code: string) => get<Lockup>(`/lockup?code=${code}`),
  blocks: (code: string) => get<Blocks>(`/blocks?code=${code}`),
  hotConcepts: (code: string) => get<HotConcept[]>(`/hot-concepts?code=${code}`),
  investorQa: (code: string) => get<QaRow[]>(`/investor-qa?code=${code}`),
  // OpenVlab 期权 / 期货波动率
  ovlabMarket: () => get<OvlabMarketRow[]>("/ovlab/market"),
  ovlabDetail: (prodUnd: string, exps?: string) =>
    get<OvlabDetail>(`/ovlab/detail?prod_und=${encodeURIComponent(prodUnd)}${exps ? `&exps=${encodeURIComponent(exps)}` : ""}`),
  ovlabVolatilityTs: () => get<OvlabVolatilityTs>("/ovlab/volatility-ts"),
  ovlabFutureTsAll: () => get<OvlabFutureTsAll>("/ovlab/future-ts-all"),
  ovlabFutureTs: (prodUnd: string) => get<OvlabFutureTs>(`/ovlab/future-ts?prod_und=${encodeURIComponent(prodUnd)}`),
  ovlabParked: () => get<OvlabParked>("/ovlab/parked"),
  ovlabArbBoard: () => get<ArbBoard>("/ovlab/arb-board"),
  ovlabFlowAlert: () => get<OvlabFlowAlert[]>("/ovlab/flow-alert"),
  ovlabMqtt: (pin?: string[]) => {
    const q = (pin ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 12);
    const s = q.length ? `?pin=${encodeURIComponent(q.join(","))}` : "";
    return get<OvlabMqttStatus>(`/ovlab/mqtt${s}`);
  },
  /** SSE of the in-process MQTT sidecar. Prefix /api in the hook (needs Bearer). */
  ovlabMqttStreamPath: (pin?: string[]) => {
    const q = (pin ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 12);
    const s = q.length ? `?pin=${encodeURIComponent(q.join(","))}` : "";
    return `/ovlab/mqtt/stream${s}`;
  },
  ovlabFlowData: (product?: string, page = 1, pageSize = 50) =>
    request<OvlabFlowData>("/ovlab/flow-data", "POST", { product: product?.trim() || null, page, page_size: pageSize }),
  ovlabWarehouseHistory: (product: string) =>
    request<OvlabWarehouseHistory>("/ovlab/warehouse-history", "POST", { product }),
  ovlabWarehouseReceipt: (product: string) =>
    get<OvlabWarehouseReceipt>(`/ovlab/warehouse-receipt?product=${encodeURIComponent(product)}`),
  ovlabProductExps: (prodUnd?: string) =>
    get<OvlabProductExp[]>(`/ovlab/product-exps${prodUnd ? `?prod_und=${encodeURIComponent(prodUnd)}` : ""}`),
  ovlabExchangeInfo: () => get<OvlabExchangeInfo[]>("/ovlab/exchange-info"),
  ovlabSectorInfo: () => get<OvlabSectorInfo[]>("/ovlab/sector-info"),
  ovlabNextTradingDay: () => get<string>("/ovlab/next-trading-day"),
  ovlabHolidays: (exchange: string) => get<unknown>(`/ovlab/holidays?exchange=${encodeURIComponent(exchange)}`),
  // 轻量行情图表 (分时/5日实时变化, 加 _t 避免中间层缓存串周期)
  ovlabKlineHistory: (symbol: string, resolution = "1D", fromTs?: number, toTs?: number) => {
    const p = new URLSearchParams({ symbol, resolution });
    if (fromTs != null) p.set("from_ts", String(fromTs));
    if (toTs != null) p.set("to_ts", String(toTs));
    if (resolution === "1" || resolution === "5") p.set("_t", String(Date.now()));
    return get<OvlabKlineHistory>(`/ovlab/kline-history?${p}`);
  },
  ovlabAtmvolHistory: (symbol: string, resolution = "1D", fromTs?: number, toTs?: number) => {
    const p = new URLSearchParams({ symbol, resolution });
    if (fromTs != null) p.set("from_ts", String(fromTs));
    if (toTs != null) p.set("to_ts", String(toTs));
    if (resolution === "1" || resolution === "5") p.set("_t", String(Date.now()));
    return get<OvlabAtmvolHistory>(`/ovlab/atmvol-history?${p}`);
  },
  ovlabLastBar: (code: string) => get<OvlabLastBar>(`/ovlab/last-bar?code=${encodeURIComponent(code)}`),
  /** Batch price + IV preview series. codes like ["MA:202609"].
   *  Send as JSON string so both old (codes:str) and new (codes:list|str) backends accept it.
   *  Upstream also expects codes as JSON.stringify(array). Cached 5min server-side. */
  ovlabPriceVolatilitySeries: (codes: string[]) =>
    request<OvlabPriceVolSeriesItem[]>("/ovlab/price-volatility-series", "POST", {
      codes: JSON.stringify(codes),
    }),
  ovlabSearchSymbols: (keyword: string) =>
    get<OvlabSearchItem[]>(`/ovlab/search-symbols?keyword=${encodeURIComponent(keyword)}`),
  ovlabSymbolInfo: (code: string) => get<OvlabSymbolInfo>(`/ovlab/symbol-info?code=${encodeURIComponent(code)}`),
  ovlabVolatilitySurface: (product: string) =>
    get<OvlabVolSurface>(`/ovlab/volatility-surface?product=${encodeURIComponent(product)}`),
  /** T 型报价: 行权价链 (IV/Delta/持仓) + Black-76 理论价. 服务端缓存 2min, 休市冻结. */
  ovlabTQuote: (product: string) =>
    get<OvlabTQuote>(`/ovlab/tquote?product=${encodeURIComponent(product)}`),
  /** 期权日K: 分钟线聚合交易日 OHLCV + 标的平值隐波日线. 服务端缓存 5min, 休市冻结. */
  ovlabOptionDaily: (code: string, und: string) =>
    get<OvlabOptionDaily>(`/ovlab/option-daily?code=${encodeURIComponent(code)}&und=${encodeURIComponent(und)}`),
  /** 期限结构: 多品种远期曲线 (surface forward 今/昨). 服务端缓存 60s, 休市冻结. */
  ovlabTermStructure: (products: string[]) =>
    get<OvlabTermStructure>(`/ovlab/term-structure?products=${encodeURIComponent(products.join(","))}`),
  ovlabSkewmap: (selectedExpiries?: Record<string, unknown>) =>
    request<OvlabSkewmap>("/ovlab/skewmap", "POST", { selectedExpiries: selectedExpiries ?? {} }),
  ovlabSurfacemap: (product?: string) =>
    get<OvlabSurfacemap>(`/ovlab/surfacemap${product ? `?product=${encodeURIComponent(product)}` : ""}`),
  // 持仓排名
  ovlabOptionPositionProducts: () => get<OvlabPositionProducts>(`/ovlab/option-position-products`),
  ovlabOptionPositionDetails: (product: string, code: string, direction: "C" | "P", day: string) => {
    const p = new URLSearchParams({ product, code, direction, day });
    return get<OvlabOptionPositionDetails>(`/ovlab/option-position-details?${p}`);
  },
  ovlabFuturePositionProducts: () => get<OvlabPositionProducts>(`/ovlab/future-position-products`),
  ovlabFuturePositionDetails: (product: string, code: string, day: string) => {
    const p = new URLSearchParams({ product, code, direction: "0", day });
    return get<OvlabFuturePositionDetails>(`/ovlab/future-position-details?${p}`);
  },
  finoOverview: (report_type = "daily", start_date = "", end_date = "", codes = "") => {
    const p = new URLSearchParams({ report_type, start_date, end_date, codes });
    return get<FinoOverviewRow[]>(`/fino/overview?${p}`);
  },
  finoDetail: (report_type = "daily", start_date = "", end_date = "", codes = "") => {
    const p = new URLSearchParams({ report_type, start_date, end_date, codes });
    return get<FinoDetailRow[]>(`/fino/detail?${p}`);
  },
  researchSources: () => get<ResearchSources>("/research/sources"),
  researchKline: (symbol: string, source = "auto", num = 180, interval = "1D") => {
    const p = new URLSearchParams({ symbol, source, num: String(num), interval });
    return get<ResearchKline>(`/research/kline?${p}`);
  },
  researchCorrelation: (codes: string, window = 60) =>
    get<ResearchCorrelation>(`/research/correlation?codes=${encodeURIComponent(codes)}&window=${window}`),
  researchEtfHoldings: (symbol: string, market = "auto") =>
    get<ResearchEtf>(`/research/etf-holdings?symbol=${encodeURIComponent(symbol)}&market=${market}`),
  research13f: (opts: { manager?: string; cik?: string; ticker?: string; top?: number }) => {
    const p = new URLSearchParams();
    if (opts.manager) p.set("manager", opts.manager);
    if (opts.cik) p.set("cik", opts.cik);
    if (opts.ticker) p.set("ticker", opts.ticker);
    p.set("top", String(opts.top ?? 40));
    return get<Research13f>(`/research/13f?${p}`);
  },
  backtestMeta: () => get<BacktestMeta>("/backtest/meta"),
  backtestProgress: () => get<BacktestProgress>("/backtest/progress"),
  backtestRun: (body: BacktestRunBody) => request<BacktestResult>("/backtest/run", "POST", body),
  backtestRuns: (limit = 40, kind?: "account" | "factor" | "model") =>
    get<BacktestRunSummary[]>(`/backtest/runs?limit=${limit}${kind ? `&kind=${kind}` : ""}`),
  backtestRunGet: (id: string) => get<BacktestResult>(`/backtest/runs/${encodeURIComponent(id)}`),
  backtestRunDelete: (id: string) => request<{ ok: boolean; id: string }>(`/backtest/runs/${encodeURIComponent(id)}`, "DELETE"),
  backtestStore: () => get<BacktestStore>("/backtest/store"),
  backtestCover: (codes: string[], lookback?: string) => {
    const p = new URLSearchParams();
    p.set("codes", codes.join(","));
    if (lookback) p.set("lookback", lookback);
    return get<BacktestStoreCover>(`/backtest/store?${p}`);
  },
  backtestStoreSync: () => request<BacktestStoreSync>("/backtest/store/sync", "POST"),
  backtestStoreMembers: (index?: string, refresh = false) =>
    request<{ items: Array<Record<string, unknown>> }>("/backtest/store/members", "POST", {
      index: index || undefined,
      refresh,
    }),
  backtestStoreFundamentals: (opts?: { codes?: string[]; index?: string }) =>
    request<{ asked: number; ok: number; skip: number; fail: number; rows: number }>(
      "/backtest/store/fundamentals",
      "POST",
      opts || {},
    ),
  backtestStorePeek: (symbol: string, n = 30) =>
    get<BacktestStorePeek>(`/backtest/store/${encodeURIComponent(symbol)}?n=${n}`),
  backtestFactor: (body: BacktestFactorBody) => request<BacktestFactorResult>("/backtest/factor", "POST", body),
  backtestModel: (body: BacktestModelBody) => request<BacktestModelResult>("/backtest/model", "POST", body),
  backtestFactorCompare: (body: BacktestFactorCompareBody) =>
    request<BacktestFactorCompare>("/backtest/factor/compare", "POST", body),
  backtestIndexPool: (index: string, refresh = false, history = false) =>
    get<BacktestIndexPool>(
      `/backtest/index-pool?index=${encodeURIComponent(index)}${refresh ? "&refresh=1" : ""}${history ? "&history=1" : ""}`,
    ),
  openRouterUsage: () => get<OrUsageDay[]>("/ai-watch/openrouter-usage"),
  spendIndex: () => get<SpendIndexResp>("/ai-watch/spend-index"),
  aaModels: () => get<AaModelsResp>("/ai-watch/aa-models"),
  aiInfra: () => get<AiInfraResp>("/ai-watch/ai-infra"),
};

export interface OrShareRow {
  name: string;
  tokens: number;
  pct: number;
  date?: string;
}

export interface OrUsageDay {
  date: string;
  total: number;
  providers: OrShareRow[];
  countries: OrShareRow[];
}

export interface AaModel {
  slug: string;
  name: string;
  vendor: string;
  release: string;
  intel: number | null;
  input: number | null;
  output: number | null;
  cacheHit: number | null;
  taskCost: number | null;
}

export interface AaModelsResp {
  models: AaModel[];
  history: Record<string, { name: string; vendor: string; points: { t: string; i: number | null; o: number | null; task: number | null }[] }>;
  source: string;
}

export interface SpendIndexResp {
  points: {
    date: string;
    ttsi: number | null;
    pct: number | null;
    indexPoint: number | null;
    closed: number | null;
    open: number | null;
    premium: number | null;
  }[];
  events: { date: string; text: string }[];
  source: string;
}

export interface AiInfraPoint {
  year: number;
  capexB: number;
  depB: number;
  pricePerM: number;
  costPerM: number;
  grid: number;
  revenueB: number;
  roiPct: number;
  actual: boolean;
}

export interface AiInfraResp {
  generatedAt: string;
  series: AiInfraPoint[];
  sources: {
    sec: { ok: boolean; byCompany?: { name: string; capex: Record<string, number> }[]; err?: string };
    token: { ok: boolean; marketInputPerM?: number | null; frontierInputPerM?: number | null; vendorCount?: number; err?: string };
    ppi: { ok: boolean; trend?: string; yoy12m?: number; err?: string };
  };
  notes: string[];
}

export type ResearchSources = Record<string, { ok: boolean; need: string | null; markets: string[] }>;

export interface ResearchKlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ResearchKline {
  code: string;
  name?: string;
  market?: string;
  source?: string;
  adjust?: string;
  bars: ResearchKlineBar[];
}

export interface ResearchCorrelation {
  window: number;
  codes: string[];
  matrix: (number | null)[][];
  series?: { code: string; input: string; name?: string; source?: string; returns?: number }[];
  errors?: { code: string; error: string }[];
  note?: string;
}

export interface ResearchEtfHolding {
  symbol?: string;
  name?: string;
  ticker?: string;
  cusip?: string;
  pct_of_net_assets?: number;
  shares?: number;
  market_value_cny?: number;
  value_usd?: number;
  disclosure_source?: string;
}

export interface ResearchEtf {
  market: string;
  symbol: string;
  fund_name?: string;
  as_of?: string;
  coverage?: string;
  pct_of_net_assets_disclosed?: number;
  fund_report_holdings?: number;
  cross_referenced_holdings?: number;
  net_assets_usd?: number;
  holdings: ResearchEtfHolding[];
  periods?: { as_of?: string; coverage?: string; fund_report_holdings?: number; pct_of_net_assets_disclosed?: number }[];
  note?: string;
  source?: string;
}

export interface Research13fHolding {
  issuer?: string;
  cusip?: string;
  put_call?: string | null;
  value_usd?: number;
  shares?: number;
}

export interface Research13fChange {
  action: "new" | "increased" | "reduced" | "closed" | string;
  issuer?: string;
  cusip?: string;
  shares_before?: number;
  shares_after?: number;
  shares_change?: number;
  shares_change_pct?: number | null;
  value_usd_change?: number;
}

export interface Research13f {
  mode: "manager" | "ticker" | string;
  cik?: string;
  manager?: string;
  ticker?: string;
  cusip?: string;
  managers?: { cik: string; name?: string; period_end?: string; filing_date?: string }[];
  current?: {
    period_end?: string;
    filing_date?: string;
    value_units?: string;
    positions?: number;
    holdings?: Research13fHolding[];
  };
  prior?: { period_end?: string; filing_date?: string } | null;
  changes?: Research13fChange[];
  change_counts?: { new?: number; increased?: number; reduced?: number; closed?: number };
  note?: string;
}

export type BacktestStrategy = "hold" | "ma_cross" | "dates" | "rank_mom" | "top_k";

export interface BacktestEvent {
  code: string;
  side: "buy" | "sell";
  date: string;
}

export interface BacktestRunBody {
  codes: string[];
  strategy?: BacktestStrategy;
  lookback?: "1y" | "2y" | "3y";
  start?: string;
  end?: string;
  short_win?: number;
  long_win?: number;
  mom_win?: number;
  rebalance?: number;
  events?: BacktestEvent[];
  fill?: "open_t+1" | "close_t";
  initial_capital?: number;
  max_positions?: number;
  commission_pct?: number;
  commission_min?: number;
  stamp_tax_pct?: number;
  slippage_bps?: number;
  oos_frac?: number;
  oos_date?: string;
  tune_ma?: boolean;
  walk_forward?: boolean;
  index?: string;
  pit_members?: boolean;
  max_weight?: number;
  industry_neutral?: boolean;
  weight?: "equal" | "factor_weight";
  exclude_st?: boolean;
  min_list_days?: number;
}

export interface BacktestSymbolRow {
  symbol: string;
  name?: string;
  buys: number;
  sells: number;
  pnl: number;
  wins: number;
  trips: number;
  win_rate: number;
  avg_hold?: number;
}

export interface BacktestTrade {
  symbol: string;
  name?: string;
  side: "buy" | "sell" | string;
  date: string;
  signal_date?: string;
  price: number;
  shares: number;
  notional: number;
  commission: number;
  stamp_tax: number;
  cash_delta: number;
  pnl?: number | null;
  hold_days?: number;
  reason?: string;
}

export interface BacktestResult {
  equity_curve: { date: string; equity: number; cash: number; market_value: number }[];
  drawdown_curve: { date: string; drawdown: number }[];
  trades: BacktestTrade[];
  stats: {
    initial_capital: number;
    final_equity: number;
    total_return: number;
    cagr: number;
    sharpe: number;
    vol: number;
    max_drawdown: number;
    calmar: number;
    sortino?: number;
    days: number;
    trades: number;
    round_trips: number;
    win_rate: number;
    profit_factor: number | null;
    benchmark_return?: number | null;
    excess_return?: number | null;
    oos_return?: number | null;
    oos_sharpe?: number | null;
    oos_fresh_return?: number | null;
    oos_fresh_sharpe?: number | null;
    wf_mean_sharpe?: number | null;
    wf_compound_return?: number | null;
  };
  execution: {
    fills: number;
    open_positions: number;
    rejects: Record<string, number>;
  };
  universe?: {
    symbols: string[];
    names?: Record<string, string>;
    start?: string;
    end?: string;
    bars?: number;
    from_store?: number;
    fetched?: number;
  };
  strategy?: { name: string; short_win?: number; long_win?: number; mom_win?: number; rebalance?: number; top_k?: number; horizon?: number };
  warnings?: string[];
  disclaimer?: string;
  config?: {
    codes?: string[];
    start?: string;
    end?: string;
    strategy?: BacktestStrategy | string;
    short_win?: number;
    long_win?: number;
    mom_win?: number;
    rebalance?: number;
    events?: BacktestEvent[];
    fill?: "open_t+1" | "close_t";
    walk_forward?: boolean;
    tune_ma?: boolean;
    oos_frac?: number | string | null;
    index?: string;
    pit_members?: boolean;
    exclude_st?: boolean;
    min_list_days?: number;
    matcher?: {
      fill?: "open_t+1" | "close_t";
      commission_pct?: number;
      commission_min?: number;
      stamp_tax_pct?: number;
      slippage_bps?: number;
      initial_capital?: number;
      max_positions?: number;
      stop_loss_pct?: number;
      max_hold_days?: number;
      max_weight?: number;
      industry_neutral?: boolean;
    };
  };
  model?: BacktestModelInfo;
  tearsheet?: {
    monthly: { month: string; return: number }[];
    yearly: { year: string; return: number }[];
    drawdowns: { start: string; trough: string; end: string; depth: number; days: number }[];
  };
  by_symbol?: BacktestSymbolRow[];
  run_id?: string;
  data_hash?: string;
  data_hash_now?: string | null;
  data_hash_match?: boolean | null;
  created?: string;
  closed_end?: string;
  benchmark?: {
    symbol: string;
    name?: string;
    kind?: "tradable_equal" | "index_price" | string;
    curve: { date: string; equity: number | null }[];
    total_return?: number | null;
    note?: string;
  };
  oos?: {
    split: string;
    is_bars: number;
    oos_bars: number;
    stats_is: BacktestResult["stats"];
    stats_oos: BacktestResult["stats"];
    stats_oos_fresh: BacktestResult["stats"];
    note?: string;
  };
  walk_forward?: {
    folds: {
      is_start: string;
      is_end: string;
      oos_start: string;
      oos_end: string;
      short_win?: number;
      long_win?: number;
      stats: BacktestResult["stats"];
    }[];
    summary: { folds: number; mean_sharpe: number; mean_return: number; compound_return: number };
  };
}

export interface BacktestRunSummary {
  id: string;
  kind?: "account" | "factor" | "model" | string;
  created?: string;
  data_hash?: string;
  strategy?: { name?: string } | string;
  factor?: string;
  factor_label?: string;
  symbols?: string[];
  start?: string;
  end?: string;
  total_return?: number | null;
  sharpe?: number | null;
  excess_return?: number | null;
  ic_mean?: number | null;
}

export interface BacktestStoreSymbol {
  symbol: string;
  bars: number;
  from?: string | null;
  to?: string | null;
  years?: string[];
  adj: number;
}

export interface BacktestStoreSync {
  state: string;
  lookback?: string;
  start?: string;
  end?: string;
  universe?: number;
  done?: number;
  ok?: number;
  skip?: number;
  fail?: number;
  current?: string;
  error?: string;
  updated?: string;
}

export interface BacktestStoreUniverse {
  lookback: string;
  start: string;
  end: string;
  codes: number;
  on_disk: number;
  covered: number;
  window_match?: boolean;
  sync?: BacktestStoreSync;
}

export interface BacktestStoreProbe {
  start: string;
  end: string;
  asked: number;
  covered: number;
  missing: string[];
  partial: { symbol: string; from: string; to: string }[];
}

export interface BacktestStoreCover {
  root: string;
  closed_end?: string;
  universe?: BacktestStoreUniverse;
  probe: BacktestStoreProbe;
  note?: string;
}

export interface BacktestStore {
  root: string;
  closed_end?: string;
  bytes: { market: number; runs: number };
  probe?: BacktestStoreProbe;
  calendar: {
    loaded: boolean;
    count: number;
    from?: string | null;
    to?: string | null;
    source?: string | null;
    trading_day?: boolean;
    fallback?: boolean;
  };
  bars: { count: number; symbols: BacktestStoreSymbol[]; preview?: number };
  universe?: BacktestStoreUniverse;
  members: { index: string; rows: number; snapshots: number; from?: string | null; to?: string | null }[];
  fundamentals: { symbol: string; rows: number; from?: string | null; to?: string | null }[];
  runs: { count: number; recent: BacktestRunSummary[] };
  legacy_kline: number;
  note?: string;
}

export interface BacktestStorePeek {
  symbol: string;
  count: number;
  available?: [string, string] | null;
  bars: {
    date: string;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    factor?: number | null;
  }[];
}

export interface BacktestFactorDef {
  id: string;
  label: string;
  win: number;
  kind: string;
  group?: string;
}

export interface BacktestFactorBody {
  codes?: string[];
  pool?: "codes" | "store";
  factor?: string;
  lookback?: "1y" | "2y" | "3y";
  start?: string;
  end?: string;
  rebalance?: "daily" | "weekly" | "monthly";
  n_groups?: number;
  direction?: "high" | "low";
  weight?: "equal" | "factor_weight";
  ls_fee?: number;
  factors?: string[];
  index?: string;
  exclude_st?: boolean;
  min_list_days?: number;
}

export interface BacktestFactorCompareBody extends BacktestFactorBody {
  factors: string[];
}

export interface BacktestFactorCompare {
  factors: string[];
  rows: {
    id: string;
    label: string;
    group?: string;
    ic_mean: number | null;
    ir: number | null;
    ic_win_rate: number | null;
    ls_return: number | null;
    q_spread: number | null;
  }[];
  ic_corr: (number | null)[][];
  n_symbols: number;
  warnings?: string[];
}

export interface BacktestFactorResult {
  run_id?: string;
  created?: string;
  data_hash?: string;
  config?: BacktestFactorBody & Record<string, unknown>;
  factor: BacktestFactorDef;
  rebalance: string;
  direction?: "high" | "low";
  weight?: string;
  ls_fee?: number;
  n_groups: number;
  n_symbols: number;
  n_dates: number;
  n_periods: number;
  ic_mean: number | null;
  ic_pearson_mean?: number | null;
  ic_std: number | null;
  ir: number | null;
  ic_win_rate: number | null;
  ic_series: { date: string; ic: number }[];
  group_stats: {
    group: number;
    label: string;
    total_return: number;
    sharpe: number;
    max_drawdown: number;
    win_rate: number;
  }[];
  group_nav: Record<string, string | number>[];
  long_short_nav: { date: string; value: number }[];
  long_short_stats: {
    total_return: number;
    sharpe: number;
    max_drawdown: number;
    win_rate: number;
    top_group?: string;
    bottom_group?: string;
  };
  warnings?: string[];
  disclaimer?: string;
  universe?: {
    symbols: string[];
    start?: string;
    end?: string;
    bars?: number;
    from_store?: number;
    fetched?: number;
    pool?: string;
    n_requested?: number;
  };
}

export interface BacktestModelInfo {
  backend?: string;
  features?: string[];
  horizon?: number;
  split?: string | null;
  n_train?: number;
  params?: Record<string, number>;
  is_ic?: number | null;
  oos_ic?: number | null;
  grid?: Array<Record<string, number | null>>;
  drift?: { feature: string; psi: number | null; ks: number | null }[];
  n_features?: number;
}

export interface BacktestModelBody {
  codes: string[];
  lookback?: "1y" | "2y" | "3y";
  start?: string;
  end?: string;
  horizon?: number;
  rebalance?: number;
  mom_win?: number;
  tune?: boolean;
  oos_frac?: number;
  initial_capital?: number;
  max_positions?: number;
  max_weight?: number;
  industry_neutral?: boolean;
  exclude_st?: boolean;
  min_list_days?: number;
  commission_pct?: number;
  commission_min?: number;
  stamp_tax_pct?: number;
  slippage_bps?: number;
}

export type BacktestModelResult = BacktestResult & {
  kind?: "model";
  model?: BacktestModelInfo;
};

export interface BacktestProgress {
  state: "idle" | "running" | "done" | string;
  kind: string;
  step: string;
  label: string;
  done: number;
  total: number;
  current: string;
  note: string;
}

export interface BacktestIndexPoolDef {
  id: string;
  label: string;
}

export interface BacktestIndexPool {
  id: string;
  label: string;
  asof: string;
  codes: string[];
  n: number;
  stored: boolean;
  source: string;
  note: string;
}

export interface BacktestMeta {
  strategies: { id: BacktestStrategy; label: string; hint: string }[];
  fills: string[];
  lookbacks: string[];
  defaults: BacktestRunBody & Record<string, unknown>;
  limits: { max_codes: number; max_bars: number; factor_max_codes?: number };
  factors?: BacktestFactorDef[];
  index_pools?: BacktestIndexPoolDef[];
  disclaimer: string;
  notes: string[];
}
