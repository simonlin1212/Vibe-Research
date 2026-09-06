import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "desktop", "src");
const FINANCE = path.join(SRC, "verticals", "finance");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);

/**
 * 前端的 Core / 垂类边界。
 *
 * 🔴 **2026-08-26 界面整套换成开源版 Vibe-Research 之后,前端的形状变了**:
 *    整套 UI(外壳 / 导航 / 组件 / 页面)都在 `verticals/finance/` 里,
 *    Core 只剩 `src/` 顶层那几个文件(组装根 + 全局样式)。
 *    ⇒ 断言必须跟着改。旧版查的是 `src/core/` 与 `lib/nav.ts`,那两样**已经不存在**,
 *      而 `walk()` 对不存在的目录返回空数组 ⇒ 前三条会**全绿地什么都没查**。
 *      (第四条读文件才炸出来 —— 否则这条棘轮会静默失效,那正是它最该防的事。)
 */

const coreFiles = () =>
  walk(SRC).filter((f) => !rel(f).startsWith("verticals" + path.sep));

test("🔴 Core UI 确实存在 —— 目录改名 / 搬走时,后面几条不许静默变成空查", () => {
  const files = coreFiles().map(rel);
  assert.ok(files.includes("main.tsx"), `没找到组装根 main.tsx,现有 Core 文件:${files.join(", ")}`);
  assert.ok(fs.existsSync(FINANCE), "垂类目录 verticals/finance 不在了");
  assert.ok(walk(FINANCE).length > 20, `垂类文件太少(${walk(FINANCE).length}),路径大概不对`);
});

test("🔴 只有组装根可以 import 垂类 —— 别处 import 等于绕开注册点", () => {
  const roots = new Set(["main.tsx"]);
  const bad: string[] = [];
  for (const f of coreFiles()) {
    const r = rel(f);
    if (roots.has(r)) continue;
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/verticals\//.test(m[1]!)) bad.push(`${r} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `只有 main.tsx 能接垂类:\n  ${bad.join("\n  ")}`);
});

test("Core UI 里不许出现行业词(它换个行业要能原样搬走)", () => {
  // ⚠️ 收词优先收完整术语;"证伪 / 目标"这类二字词会命中普通中文,反而制造噪音。
  const WORDS = ["持仓", "涨停", "复盘", "板块", "行情", "标的", "estimates", "valuation",
    "成本", "建仓", "仓位", "裁决点", "证伪条件", "开盘", "收盘", "换手", "账户", "论点", "股票"];
  const hits: string[] = [];
  for (const f of coreFiles()) {
    const s = fs.readFileSync(f, "utf8");
    for (const w of WORDS) if (s.includes(w)) hits.push(`${rel(f)}:${w}`);
  }
  assert.deepEqual(hits, [], `Core UI 出现行业词:\n  ${hits.join("\n  ")}`);
});

test("导航与路由双向对得上 —— 有导航没路由=点了白屏,有路由没导航=永远点不到", () => {
  // ⚠️ 不动态 import .tsx —— Node 的测试跑不了 JSX。按文本解析同样能双向查。
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");

  const routes = [...routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const navTos = [...layoutSrc.matchAll(/\bto:\s*"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.ok(routes.length >= 10 && navTos.length >= 10,
    `解析出来太少,正则可能失效:routes=${routes.length} nav=${navTos.length}`);

  // 参数路由(`/sectors/:key`)覆盖它的静态前缀 —— 导航里的子项走的就是这条
  const staticRoutes = routes.filter((p) => !p.includes(":"));
  const paramPrefixes = routes.filter((p) => p.includes(":")).map((p) => p.slice(0, p.indexOf("/:")));
  const reachable = (to: string) =>
    staticRoutes.includes(to) || paramPrefixes.some((pre) => to.startsWith(pre + "/"));

  assert.deepEqual(navTos.filter((t) => !reachable(t)), [], "有导航项没有对应路由(点了白屏)");

  // 反向:每条静态路由要么在导航里,要么是明示的旧地址兼容跳转。
  const redirects = [...routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"\s*,\s*element:\s*<Navigate\b/g)].map((m) => m[1]!);
  const orphan = staticRoutes.filter((p) => p !== "/" && !navTos.includes(p) && !redirects.includes(p));
  assert.deepEqual(orphan, [], "有路由不在导航里(永远点不到)");

  // 参数路由的静态父路径必须真的存在,否则它谁也点不到
  assert.deepEqual(paramPrefixes.filter((p) => p !== "" && !staticRoutes.includes(p)), [],
    "参数路由的静态父路径要有页面");
});

test("产品界面不展示 Phoenix Tree 官网入口", () => {
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  assert.ok(!/phoenixtree\.ai/i.test(layoutSrc), "本产品不进入官网产品系统，侧栏不得展示 Phoenix Tree 网址");
});

test("首屏后端失败态给普通用户一键启动命令与重试入口", () => {
  const mainSrc = fs.readFileSync(path.join(SRC, "main.tsx"), "utf8");
  const viteSrc = fs.readFileSync(path.join(REPO, "desktop", "vite.config.ts"), "utf8");
  assert.match(mainSrc, /macOS \/ Linux 请运行 scripts\/start/);
  assert.match(mainSrc, /Windows 请运行 scripts\\\\start\.cmd/);
  assert.match(mainSrc, /retry\.textContent = "重新连接"/);
  assert.match(mainSrc, /window\.location\.reload\(\)/);
  assert.match(viteSrc, /本机服务没有启动或已经关闭/);
  assert.doesNotMatch(viteSrc, /先执行 node orchestrator\/src\/api\.ts/);
});

test("根路径是极简功能首页,首屏可直接与 Agent 交流", () => {
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const homeSrc = fs.readFileSync(path.join(FINANCE, "pages", "Home.tsx"), "utf8");

  assert.match(routerSrc, /path:\s*"\/",\s*element:\s*<Home\s*\/>/);
  assert.ok(!/Navigate\s+to="\/daily-review"/.test(routerSrc), "根路径仍在跳过首页");
  assert.match(layoutSrc, /to:\s*"\/",\s*icon:\s*Home,\s*label:\s*"首页"/);
  assert.match(layoutSrc, /to:\s*"\/settings",\s*icon:\s*Settings,\s*label:\s*"接入 AI"/);
  assert.match(homeSrc, /<FinanceHomeAgent\s*\/>/);
  // V2 标题已由用户确认；这里守护接入状态，而不是锁死旧版宣传标题。
  assert.match(homeSrc, /<h1\b[^>]*>研究，从全局开始。<\/h1>/);
  assert.match(homeSrc, /agentEnabled\s*=\s*runtime\.config\?\.executionMode\s*!==\s*"direct"/);
  assert.match(homeSrc, /agentEnabled\s*\?\s*"Vibe Research Agent 已开启"\s*:\s*"模型直连模式"/);
  assert.match(homeSrc, /to="\/settings"/);
  assert.ok(!/Codex Harness 研究流程|全部功能，一页直达|先看清今天发生了什么/.test(homeSrc),
    "首页仍保留上一版的大段说明");

  for (const route of [
    "/daily-review", "/intel", "/signals", "/sectors", "/debate", "/backtest",
    "/research", "/watchlist", "/portfolio", "/my-reports", "/notes",
  ]) {
    assert.match(homeSrc, new RegExp(`to:\\s*"${route}"`), `首页缺少功能入口:${route}`);
  }
  assert.ok(!/to:\s*"\/stock-data"/.test(homeSrc), "首页不应同时列出两个个股研究入口");
  assert.equal((homeSrc.match(/title:\s*"个股研究"/g) ?? []).length, 1, "首页只保留一个个股研究");
});

test("个股研究只有一个入口，旧地址跳转且归档保留名称代码与状态时间", () => {
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const researchSrc = fs.readFileSync(path.join(FINANCE, "pages", "Research.tsx"), "utf8");

  assert.match(routerSrc, /path:\s*"\/stock-data"\s*,\s*element:\s*<Navigate\s+replace\s+to="\/research"/);
  assert.equal((layoutSrc.match(/label:\s*"个股研究"/g) ?? []).length, 1);
  assert.ok(!/label:\s*"深度研究"/.test(layoutSrc));
  assert.match(researchSrc, /title="个股研究"/);
  assert.match(researchSrc, /\^\\d\{6\}\$/, "现有研究底座只支持 A 股，界面必须按真实能力限制输入");
  assert.match(researchSrc, /startResearch\(\{[\s\S]{0,400}symbol:\s*code,[\s\S]{0,400}endpoints:\s*scope,/, "A 股代码必须传到真实研究入口");
  assert.ok(!/港股或美股标的跑完整|A 股 \/ 港股 \/ 美股代码/.test(researchSrc), "界面不能承诺尚未接通的港美完整研究");
  const archive = researchSrc.slice(researchSrc.indexOf("<h3 className=\"mb-3 font-semibold\">研究归档"));
  // 2026-09-06 Simon 确认补充状态和时间；不改变原导航与研究入口。
  assert.match(archive, /<ResearchRunItem key=\{r\.run_id\} run=\{r\}/);
  const item = fs.readFileSync(path.join(FINANCE, "components", "ResearchRunItem.tsx"), "utf8");
  assert.match(item, /run\.name\s*\?\?\s*"个股"/);
  assert.match(item, /run\.symbol\s*\?\?\s*"—"/);
  assert.match(item, /run\.status/); assert.match(item, /run\.started_at/);
});

test("首页 Agent 是可发送的真实对话区,不是装饰输入框", () => {
  const homeSrc = fs.readFileSync(path.join(FINANCE, "pages", "Home.tsx"), "utf8");
  const dockSrc = fs.readFileSync(path.join(FINANCE, "components", "ui", "FinanceAiDock.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const llmSrc = fs.readFileSync(path.join(FINANCE, "lib", "llm.ts"), "utf8");

  assert.match(homeSrc, /<FinanceHomeAgent\s*\/>/,
    "首页对话可用性必须读取全局 AI 运行状态，不能另开一套后端回落判定");
  const homeAgent = dockSrc.slice(
    dockSrc.indexOf("export function FinanceHomeAgent"),
    dockSrc.indexOf("export function FinanceAiConsole"),
  );
  assert.match(homeAgent, /FinanceHomeAgent\(\)/);
  assert.match(homeAgent, /const configured = runtime\.status === "ok"/);
  assert.match(homeAgent, /useAiChat\("home-agent",\s*sendTurn\)/);
  assert.match(homeAgent, /!configured[\s\S]*<AiMessages[\s\S]*<AiComposer/);
  assert.match(homeAgent, /onPick=\{setDraft\}/,
    "首页任务模板应先填入输入框，不能点击后立刻冒充已执行");
  assert.match(homeAgent, /value=\{draft\}[\s\S]*onValueChange=\{setDraft\}/,
    "预填任务必须允许用户把‘这家公司 / 这个行业’改成真实名称");
  assert.match(homeAgent, /onSend=\{\(text\) => void chat\.submit\(text\)\}/);
  assert.match(homeAgent, /onClick=\{chat\.clear\}/);
  assert.match(dockSrc, /backend\.chat\(message, session, signal\)/,
    "首页 submit 必须最终接到真实后端对话接口");
  assert.match(dockSrc, /FinanceAiConsole[\s\S]*configured=\{runtime\.status === "ok"\}/);
  assert.match(dockSrc, /FinanceAiDock[\s\S]*configured=\{runtime\.status === "ok"\}/);
  const hasLlmBlock = llmSrc.slice(llmSrc.indexOf("export function hasLlm"), llmSrc.indexOf("export function loadLlm"));
  assert.match(hasLlmBlock, /readAiRuntime\(\)/, "全局 Agent 必须识别浏览器里保存的 AI 来源与执行模式");
  assert.doesNotMatch(hasLlmBlock, /cached|optimistic|backendProvider/,
    "首次接入必须由用户明确选择，不能暗中回落到后端环境变量");
  assert.match(layoutSrc, /pathname !== "\/" && <FinanceAiDock/);
  assert.match(layoutSrc, /document\.getElementById\("home-agent"\)/);
});

test("全局 AI 来源与执行模式在品牌区、Agent 面板与模型页三处口径一致", () => {
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const dockSrc = fs.readFileSync(path.join(FINANCE, "components", "ui", "FinanceAiDock.tsx"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(FINANCE, "pages", "Settings.tsx"), "utf8");

  assert.match(layoutSrc, /本地金融研究 Agent/);
  assert.match(layoutSrc, /Vibe Research Agent/);
  assert.match(layoutSrc, /Claude Code Agent/);
  assert.match(layoutSrc, /WorkBuddy \/ CodeBuddy Agent/);
  assert.match(layoutSrc, /模型直连/);
  assert.match(dockSrc, /Vibe Research Agent/);
  assert.match(dockSrc, /单轮模型调用 · 无 Agent 记忆/);
  assert.match(dockSrc, /trigger: agentEnabled \? "问 Agent" : "问模型"/);
  assert.match(settingsSrc, /一、连接 AI/);
  assert.match(settingsSrc, /二、Vibe Research Agent/);
  assert.match(settingsSrc, /等待连接 AI/, "未配置时不能冒充已经选中了 Codex Harness");
  assert.match(settingsSrc, /本地 API 已连接/);
  assert.match(settingsSrc, /默认开启/);
  assert.match(settingsSrc, /WorkBuddy \/ CodeBuddy/);
  assert.match(settingsSrc, /@tencent-ai\/codebuddy-code/);
  assert.doesNotMatch(settingsSrc, /适配器尚未完成|目前只接通 Codex 与 Claude Code/);
});

test("产品能力与密钥文案不许超过代码实际做到的范围", () => {
  const dailySrc = fs.readFileSync(path.join(FINANCE, "pages", "DailyReview.tsx"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(FINANCE, "pages", "Settings.tsx"), "utf8");
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const english = fs.readFileSync(path.join(REPO, "README_en.md"), "utf8");

  const quickReview = dailySrc.match(/\) : !needConfig[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.match(quickReview, /已经取到的客观数据、缺口与读法护栏交给所选模型整理/);
  assert.match(quickReview, /不会启动完整研究工具链/);
  assert.match(quickReview, /to="\/research"/);
  assert.ok(!/调用[^，。；<]{0,20}工具|校验(?:证据|数据)|证据校验/.test(quickReview),
    `快速复盘段不许承诺实际没有执行的工具或校验:${quickReview}`);

  const runtimeBlock = settingsSrc.slice(settingsSrc.indexOf("const runtimeState"), settingsSrc.indexOf("return (", settingsSrc.indexOf("const runtimeState")));
  assert.match(runtimeBlock, /info\s*\?\s*\{\s*label:\s*"本地 API 已连接"/);
  assert.match(runtimeBlock, /err\s*\?\s*\{\s*label:\s*"本地 API 未连接"/);
  assert.ok(!/label:\s*"(?!本地 API )[^"\n]*已连接"/.test(runtimeBlock),
    `运行状态只能证明本地 API 连通:${runtimeBlock}`);

  const zhSecurity = readme.slice(readme.indexOf("## 安全与隐私"), readme.indexOf("## 开发与测试"));
  const enSecurity = english.slice(english.indexOf("## Security and privacy"), english.indexOf("## Development and tests"));
  assert.match(zhSecurity, /后端默认 provider 的 key 只走环境变量/);
  assert.match(zhSecurity, /浏览器里填写的 API key[^\n]*localStorage/);
  assert.match(zhSecurity, /仅在调用时经本机后端转给所选模型服务商/);
  assert.ok(!/密钥只走环境变量/.test(zhSecurity), "浏览器已支持 localStorage，README 不能继续声称全部密钥只走环境变量");
  assert.match(enSecurity, /backend's default provider come only from environment variables/);
  assert.match(enSecurity, /API key entered in the browser[^\n]*localStorage/);
  assert.match(enSecurity, /sent through the local backend to the selected model provider only when used/);
  assert.ok(!/Secrets via environment variables only/i.test(enSecurity), "English README 不能继续声称全部密钥只走环境变量");
});

test("README 首屏与架构图明确区分 Harness 和模型供应商", () => {
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const english = fs.readFileSync(path.join(REPO, "README_en.md"), "utf8");

  for (const [name, source] of [["中文", readme], ["英文", english]] as const) {
    assert.match(source, /Codex Harness|Codex harness/, `${name} README 没有 Codex Harness 定位`);
    assert.match(source, /Local Agent Runtime/, `${name} README 架构图没有本地 Agent 运行时`);
    assert.match(source, /Model Provider/, `${name} README 架构图没有把模型供应商拆成独立一层`);
  }
});
