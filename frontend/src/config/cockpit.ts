/** Cockpit static defs: world indices + commodities. */

export interface IndexDef {
  code: string;
  label: string;
  region: "CN" | "HK" | "US" | "JP" | "KR" | "FX";
  accent?: string;
}

export const WORLD_INDEX_DEFS: IndexDef[] = [
  { code: "sh000001", label: "上证指数", region: "CN" },
  { code: "sz399001", label: "深证成指", region: "CN" },
  { code: "sz399006", label: "创业板指", region: "CN" },
  { code: "sh000688", label: "科创50", region: "CN" },
  { code: "sh000300", label: "沪深300", region: "CN" },
  { code: "sh000905", label: "中证500", region: "CN" },
  { code: "sh000852", label: "中证1000", region: "CN" },
  { code: "hkHSI", label: "恒生指数", region: "HK", accent: "#f43f5e" },
  { code: "hkHSTECH", label: "恒生科技", region: "HK", accent: "#c084fc" },
  { code: "usDJI", label: "道琼斯", region: "US" },
  { code: "usIXIC", label: "纳斯达克", region: "US" },
  { code: "usINX", label: "标普500", region: "US" },
  { code: "usVIX", label: "恐慌指数", region: "US" },
  { code: "usSOXX", label: "费城半导体", region: "US" },
  { code: "jpN225", label: "日经225", region: "JP", accent: "#ffcc00" },
  { code: "ksKOSPI", label: "韩国KOSPI", region: "KR", accent: "#4ade80" },
  { code: "whUSDCNY", label: "美元/人民币", region: "FX" },
];

export interface CommodityDef {
  code: string;
  label: string;
  unit: string;
  accent: string;
}

export const COMMODITIES: CommodityDef[] = [
  { code: "hf_XAU", label: "伦敦金", unit: "现货 · 美元/盎司", accent: "#ffca28" },
  { code: "hf_SI", label: "纽约白银", unit: "COMEX · 美元/盎司", accent: "#c0d0e0" },
  { code: "hf_CAD", label: "伦铜", unit: "美元/吨", accent: "#e8833a" },
  { code: "hf_CL", label: "纽约原油", unit: "美元/桶", accent: "#5aa9e6" },
  { code: "hf_NQ", label: "纳指期货", unit: "CME · NQ", accent: "#818cf8" },
  { code: "hf_BTC", label: "BTC期货", unit: "CME · CFD", accent: "#f7931a" },
];

export const COMMODITY_CODES = COMMODITIES.map((c) => c.code).join(",");

/** HK / JP / KR stay on 指数目录; 行情观察 draws them under NQ, then BTC. */
export const MACRO_INDEX_DEFS = WORLD_INDEX_DEFS.filter(
  (d) => d.region === "HK" || d.region === "JP" || d.region === "KR",
);
