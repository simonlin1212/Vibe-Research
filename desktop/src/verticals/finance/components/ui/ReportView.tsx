import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 报告人类可读渲染层(非侵入:report.md 原文是数字忠实度校验的锚,一个字不动,
 * 全部美化只发生在这个展示组件的字符串预处理里,渲染走现成 .prose 表格 CSS)。
 * 病灶(2026-09-06 用户指出"表格不正常 + 人类看不懂"):
 *   ① 原先 <pre> 裸文本,表格 |---| 分隔符全裸露 → ReactMarkdown+remarkGfm 真渲染,
 *      index.css 已有 .prose table 边框样式
 *   ② 正文/表格里 ev-46a0ea88cb22 / calc-1a0fdfbae241722a 完整哈希满屏 →
 *      紧凑为 ev·46a0ea88 / calc·1a0fdfba(可辨识前 8 位),列宽砍半,完整 id 仍在 report.md 可查
 *   ③ 92,278,072,083.21 元(机器格式) → 922.78 亿元;20.416642 倍(6 位小数) → 20.4166 倍
 *
 * 纯字符串变换,不碰 ReactMarkdown 节点模型 → 粗体/链接/表格混排都不会炸。
 */

const ID_RE = /(?<![0-9a-zA-Z_-])(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9a-zA-Z_])/g;

/** ev-46a0ea88cb22 → ev·46a0ea88;calc-1a0fdfbae241722a → calc·1a0fdfba。
 *  ⚠️ ev 前缀 3 字符、calc 前缀 5 字符,取后 8 位 hex 的起点不同(曾混用导致 calc·c-1a0fdf 脏数据) */
const compactId = (id: string) => (id.startsWith("calc-") ? "calc·" + id.slice(5, 13) : "ev·" + id.slice(3, 11));

function parseNum(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 单元格值人性化(与单位无关,单格独立判断):5 位以上小数收 4 位;元且 >=1e8 → 亿元 */
function humanizeValue(v: string, u: string): { v: string; u: string } {
  const n = parseNum(v);
  const un = u.trim();
  if (n !== null && un === "元" && Math.abs(n) >= 1e8) {
    return { v: (n / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 }), u: "亿元" };
  }
  if (n !== null && /\.\d{5,}/.test(v.trim())) {
    return { v: String(Number(n.toFixed(4))), u };
  }
  return { v, u };
}

function preprocess(md: string): string {
  const lines = md.split("\n");
  return lines
    .map((line) => {
      let out = line;
      if (line.trimStart().startsWith("|")) {
        const inner = line.split("|").map((c) => c.trim()).slice(1, -1);
        const isSep = inner.length > 0 && inner.every((c) => c === "" || /^:?-{2,}:?$/.test(c));
        // 数据行:第 2 列(值)人性化;若第 3 列是单位形态则同步换算(事实表);
        // 估值表是 3 列(标准列|值|calc id),第 3 列不是单位,值单独收小数。
        if (!isSep && inner.length >= 2) {
          const h = humanizeValue(inner[1] ?? "", inner[2] ?? "");
          inner[1] = h.v;
          if (h.u !== (inner[2] ?? "")) inner[2] = h.u;
        }
        out = `| ${inner.join(" | ")} |`;
      }
      // id 紧凑化(表格 + 正文统一)
      return out.replace(ID_RE, compactId);
    })
    .join("\n");
}

export function ReportView({ content }: { content: string }) {
  const md = useMemo(() => preprocess(content), [content]);
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-foreground [&_table]:my-3 [&_th]:whitespace-nowrap [&_td]:align-top [&_a]:break-all">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
    </div>
  );
}
