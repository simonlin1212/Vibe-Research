import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backtest = readFileSync(new URL("../src/verticals/finance/pages/Backtest.tsx", import.meta.url), "utf8");
const debate = readFileSync(new URL("../src/verticals/finance/pages/Debate.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("../src/verticals/finance/components/ui/ReportHistory.tsx", import.meta.url), "utf8");

test("#34 回测初始化 ID 在没有 crypto.randomUUID 的 HTTP 环境仍可生成", () => {
  const generators = backtest.match(/const id = [\s\S]*?\nconst session = [^\n]+/);
  assert.ok(generators);
  const [message, session] = vm.runInNewContext(`${generators[0]}\n[id(), session()]`, { crypto: {} }) as string[];
  assert.ok(message && session);
  assert.match(session, /^bt-[a-z0-9]+$/);
  assert.ok(session.length <= 24);
});

test("回测页面只保留 Agent 对话入口，不再暴露参数表单", () => {
  assert.match(backtest, /backend\.guidedTool\("backtest"/);
  assert.match(backtest, />回测 Agent<\/p>/);
  assert.match(backtest, /想验证什么，直接说/);
  assert.doesNotMatch(backtest, /Backtest Agent|先问清楚，再调用工具；不让客户手填一堆参数。/);
  assert.doesNotMatch(backtest, /初始资金|开始日期|结束日期|策略[\s\S]*<select|开始回测/);
  assert.doesNotMatch(backtest, /backend\.runTool/);
});

test("回测 Agent 的登录失败提示可直接指导用户重新接入 AI", () => {
  assert.match(backtest, /friendlyAgentError/);
  assert.doesNotMatch(backtest, /401\|unauthorized\|missing bearer\|authentication/);
});

test("回测报告包含假设、逻辑、结果并自动归档", () => {
  assert.match(backtest, /## 回测问题/);
  assert.match(backtest, /## 回测假设/);
  assert.match(backtest, /## 回测逻辑/);
  assert.match(backtest, /## 回测结果/);
  assert.match(backtest, /addNote\("回测"/);
  assert.match(backtest, /<ReportHistory kind="回测"/);
});

test("多空辩论完成后自动归档，并在本页展示历史报告", () => {
  assert.match(debate, /setNotes\(await addNote\("多空辩论"/);
  assert.match(debate, /报告已自动归档/);
  assert.match(debate, /<ReportHistory kind="多空辩论"/);
  assert.match(debate, /数字复核/);
  assert.match(debate, /算式重算不一致/);
  assert.match(debate, /abortRef\.current === ctrl/);
  assert.doesNotMatch(debate, /abortRef\.current\?\.abort\(\);\s*setRunning\(false\)/);
  assert.doesNotMatch(debate, />存入沉淀</);
});

test("报告记录支持主题和正文搜索、展开与日期时间", () => {
  assert.match(history, /搜索主题或报告内容/);
  assert.match(history, /n\.title.*n\.content/);
  assert.match(history, /toLocaleString\("zh-CN"/);
  assert.match(history, /ReactMarkdown/);
});
