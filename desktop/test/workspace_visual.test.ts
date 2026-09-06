import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
test("V2 保留原侧栏顺序、子栏目及真实 AI 入口", () => {
  const layout = read("verticals/finance/components/layout/Layout.tsx");
  const nav = layout.slice(layout.indexOf("const NAV ="), layout.indexOf("const INTEL_LINKS"));
  assert.deepEqual([...nav.matchAll(/label: "([^"]+)"/g)].map(m => m[1]), ["首页", "每日复盘", "资讯雷达", "产业信号", "板块中心", "个股研究", "多空辩论", "回测", "自选股", "我的持仓", "我的研报", "研究记录", "接入 AI"]);
  for (const route of ["/intel/investment-news", "/intel/news", "/intel/filings", "/intel/events", "/signals/gpu-rent", "/sectors/humanoid", "/sectors/ai-computing"]) assert.ok(layout.includes(route));
  assert.match(layout, /<FinanceAiConsole/);
  assert.match(layout, /<FinanceAiDock/);
  assert.match(layout, /workspace-sidebar/);
  assert.match(layout, /aria-expanded=\{groupOpen\}/);
  assert.match(layout, /aria-label=\{label\}/);
  assert.match(layout, /const closeMobileNav = \(\) => \{\s*setMobileOpen\(false\);[\s\S]*?requestAnimationFrame\(\(\) => menuRef\.current\?\.focus\(\)\)/);
  assert.equal((layout.match(/onClick=\{closeMobileNav\}/g) ?? []).length, 2);
  assert.match(layout, /event\.key === "Escape"[^\n]*closeMobileNav\(\)/);
});
test("V2 采用非绿色主题、紧凑圆角和明确键盘焦点", () => {
  const css = read("index.css");
  assert.match(css, /--radius: 0\.5rem/);
  assert.match(css, /--success: 217 /);
  assert.doesNotMatch(css, /radial-gradient|backdrop-filter/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});
test("正式首页取真实证据信封，不引入原型数据或模型自动任务", () => {
  const home = read("verticals/finance/pages/Home.tsx");
  const overview = read("verticals/finance/components/HomeOverview.tsx");
  assert.match(home, /<HomeOverview/);
  assert.match(home, /<FinanceHomeAgent/);
  assert.match(overview, /backend\.fetch\("tx_quotes_batch"/);
  assert.match(overview, /backend\.runs\(/);
  assert.match(overview, /fetched_at/);
  assert.match(overview, /\.id/);
  assert.match(overview, /test_scenario/);
  assert.doesNotMatch(overview, /云川|DEMO-|3,268|chatStream|backend\.research\(/);
});
