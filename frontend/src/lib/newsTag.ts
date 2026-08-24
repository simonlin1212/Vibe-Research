import { CHAINS } from "@/config/chains";

const MACRO = [
  "央行", "美联储", "降息", "加息", "降准", "GDP", "CPI", "PMI",
  "财政部", "国债", "专项债", "汇率", "人民币", "关税", "国常会",
];

const TAG_COLOR: Record<string, string> = {
  重要: "#fb7185",
  股票: "#ffcc00",
  宏观: "#fbbf24",
  英文: "#a78bfa",
  预告: "#94a3b8",
  政策: "#fbbf24",
};

export function tagColor(label: string): string {
  return TAG_COLOR[label] ?? "#ffcc00";
}

/** Tag a headline by chain keywords, then macro, then policy. */
export function newsTag(title: string, extra = ""): { label: string; color: string } | null {
  const text = `${title}${extra}`;
  for (const c of CHAINS) {
    if (c.keywords.some((k) => k && text.includes(k))) return { label: c.name, color: tagColor(c.name) };
  }
  if (MACRO.some((k) => text.includes(k))) return { label: "宏观", color: tagColor("宏观") };
  if (/MLF|LPR/.test(text)) return { label: "政策", color: tagColor("政策") };
  return null;
}
