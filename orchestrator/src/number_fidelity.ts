/**
 * 报告数字的**忠实度校验**:报告里写出的每个数字,是否真等于同一行所引 evidence / calc 的值。
 *
 * 🔴 为什么单独成模块(架构审计 2026-08-24):这套能力**早就写好、也被多轮审计打磨过**,
 * 但只活在硬测试里(`hardtest.ts` 的 judgeDisplayFidelity)。生产 `validateReport` 当时只查
 * "章节在不在、引用 id 存不存在" —— **不查数字是否等于所引 id 的值**。
 * 后果:报告可以引用一个**真实的 calc-id 却写另一个数字**,仍然判 complete。
 * 对一个金融研究产品来说,这是最不能留的缺口。
 * ⇒ 把它抽成共享模块,**生产 validator 与硬测试用同一份实现**(而不是复制两份各自漂移)。
 *
 * ⚠️ 下面这些正则里的每一条豁免,都对应一次真实误伤(速率标签 1.6T、公告文号、HTTP 状态码、
 * 域名里的数字、时间窗口标签、主体编号…)。**改它们之前先看注释,不要"清理"掉。**
 * 领域相关的那部分词表已移入 Plugin(金融的见 `finance/lexicon.ts`),这里只留机制。
 */
/**
 * 只声明**本模块真正用到的字段**,不绑死 merge.ts 或 hardtest 的完整类型 ——
 * 两边的 EvidenceItem 形状不同(一个带 endpoint/fetched_at/raw_ref,一个没有),
 * 绑死任一方都会让另一方传不进来。结构化类型足够,也更能说明这个模块依赖什么。
 */
export interface FidelityEvidence { value?: unknown }
export interface FidelityCalc {
  output: { value?: unknown; details?: unknown };
  inputs?: unknown;
}
type EvidenceItem = FidelityEvidence;
type CalcRecord = FidelityCalc;
import { resultProjection } from "./calc_projection.ts";
import { currentPlugin } from "./plugin.ts";

/** 从引用 id 收集可解释的数值(证据值、计算输出、计算 details / inputs 的数值叶子) */
export function numbersOf(ids: string[], evById: Map<string, EvidenceItem>, calcById: Map<string, CalcRecord>): { nums: number[]; texts: string[] } {
  const nums: number[] = []; const texts: string[] = [];
  const leaves = (v: unknown, depth = 0) => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) nums.push(v); else if (typeof v === "string") texts.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
  for (const id of ids) { const e = evById.get(id); if (e) { leaves(e.value); continue; } const c = calcById.get(id); if (c) { leaves(c.output.value); leaves(c.output.details); leaves(c.inputs); } }
  return { nums, texts };
}
/**
 * 只收 calc 的**输入**(不含 output.value / details)。
 * 🔴 这个区分是数字忠实度的核心:
 *   - calc 的**输入**同行并列是合法出处(`| 结果 34.07 倍 [calc] | 入参 943.0 元 / 27.68 元 |`);
 *   - calc 的**输出原始浮点**照抄则**必须判违规** —— 派生数字要写 display("37.40 倍"),
 *     不是 37.397700293773134。把两者混进同一个池,就等于把"照抄原始浮点"这条纪律废掉。
 */
/**
 * **inputs + output.details** 里的数值 —— 允许整数绑定的"中间量"池。
 *
 * 🔴 关键是**排除 `output.value` 本身**:否则 display 是 "37.00 倍" 时,报告写 "37 倍"
 * 会绕过逐字照抄(Codex fidelity-r2 P1)。
 * ⚠️ 也不能收窄到只剩 inputs:四锚这类结果的锚点(30)住在 `output.details.anchors` 里、
 * inputs 是空的,只认 inputs 会把"30 倍锚"这种**正当写法**误拦(实测被测试抓到)。
 */
export function intermediateNumbersOf(ids: string[], calcById: Map<string, CalcRecord>): number[] {
  const nums = inputNumbersOf(ids, calcById);
  const leaves = (v: unknown, depth = 0) => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) nums.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
  for (const id of ids) {
    const o = calcById.get(id)?.output;
    if (o && typeof o === "object") leaves((o as Record<string, unknown>).details);
  }
  return nums;
}

export function inputNumbersOf(ids: string[], calcById: Map<string, CalcRecord>): number[] {
  const nums: number[] = [];
  const leaves = (v: unknown, depth = 0) => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) nums.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
  for (const id of ids) { const c = calcById.get(id); if (c) leaves(c.inputs); }
  return nums;
}

const SCALES = [1, 1e4, 1e8, 100, 0.01, 1e-4, 1e-8];
export function numberBound(token: number, pool: number[], relTol = 2e-3): boolean {
  return pool.some((v) => SCALES.some((s) => { const w = v * s; if (!Number.isFinite(w)) return false; const tol = Math.max(Math.abs(token) * relTol, relTol * 2.5); return Math.abs(w - token) <= tol || Math.abs(Math.round(w * 100) / 100 - token) <= tol; }));
}
/** 一行里需要证据支撑的数字:排除日期 / 年份 / FY / 代码 / id 内数字 / 序号 / ×倍数记号 / 小整数计数 */

export function claimNumbers(line: string, symbol?: string): number[] { return claimTokens(line, symbol).map((t) => t.n); }
/** 数字及其书写形态(含紧随的单位字符,用于在字符串证据——如公告标题——里做原文匹配) */
/**
 * **领域词表契约**(Plugin 的一个插槽)。机制通用、词表随垂类而变 ——
 * 金融的在 `finance/lexicon.ts`;餐饮 AgentOS 会提供完全不同的一份。
 */
export interface Lexicon {
  //! 契约:所有正则必须是**原生 RegExp 字面量 / `new RegExp(...)`**,不许是子类、Proxy、
  //! 或带自定义 `flags`/`source` getter 的对象 —— 注册期会多次读取它们的属性。
  /** 金额语境(数值之前)——判断紧跟的字母后缀是金额单位还是类别标签 */
  moneyBefore: RegExp;
  /** 金额语境(数值之后):`1.6T 美元` */
  moneyAfter: RegExp;
  /** 类别标签语境:光通信的 1.6T / 800G 是产品类别名,不是数字主张 */
  categoryLabelContext: RegExp;
  /** 主体编号形态;数组按顺序全部剥除 */
  subjectCodePatterns: RegExp[];
  /** 时间窗口标签:窗口长度本身不是数字主张 */
  windowLabelPattern: RegExp;
  /** 本次主体编号是否为 6 位数字(决定要不要把裸写的编号也剥掉) */
  subjectCodeIsSixDigits: boolean;
}

let activeLexicon: Lexicon | null = null;
/** 注册时传进来的原始对象 —— 只用于"是不是同一份"的身份判断(活动词表本身是冻结快照) */
let registeredSource: Lexicon | null = null;

/**
 * 注入领域词表。**入口处调用一次**(见 `finance/register.ts`)。
 * 🔴 未注入就调用 claimTokens 会**直接抛错**,不给默认值 —— 若默认成"什么都不剥",
 * 某条没接上的路径会静默地把类别标签、主体编号都当成数字主张,表现为一堆假违规,
 * 而"为什么突然多了违规"是极难查的。**宁可当场炸。**
 */
/**
 * 注册领域词表。**同一进程只允许一份** —— 换成另一份会当场抛错。
 *
 * 🔴 为什么要拦:这是**进程级单例**,先注册金融包再注册餐饮包会静默覆盖,
 * 之后金融请求会拿餐饮词表去判数字,结果取决于注册顺序(Codex lexicon-r1 P1)。
 * 真正的解法是把词表做成**实例级依赖**、从 composition root 一路传下去(见文件末尾的"待办")。
 * 在那之前,**把静默串包变成当场失败** —— 这条纪律在本产品里比"能跑"更重要。
 *
 * ⚠️ 同时按**用途**校验正则标志。这条不能一刀切:
 * - 给 `.test()` 用的(moneyBefore / moneyAfter / categoryLabelContext)**不许带 `g`/`y`** ——
 *   它们有 `lastIndex` 状态,共享后反复 test 会交替命中 / 漏掉;
 * - 给 `.replace()` 用的(subjectCodePatterns / windowLabelPattern)**必须带 `g`** ——
 *   不带只会替换第一处,一行里出现两个主体编号时第二个剥不掉。
 * (我一度按"一律禁 g"实现,立刻被既有测试打红:金融包那两条本来就必须带 g。)
 */
const TEST_FIELDS = ["moneyBefore", "moneyAfter", "categoryLabelContext"] as const;

const isRe = (v: unknown): v is RegExp => v instanceof RegExp;
/** 克隆正则:`RegExp.prototype.compile()` 能**原地改**一个正则的 source 与 flags —— 共享对象就不叫快照 */
const cloneRe = (r: RegExp) => new RegExp(r.source, r.flags);

/**
 * 注册期间的重入守卫。
 *
 * 🔴 `lex` 的字段各读一次了,但 `r.flags` / `r.source` 仍会被读多次 —— 一个带自定义 `flags`
 * getter 的正则可以在校验途中**重入注册另一份词表**,内层注册成功、外层继续跑完再覆盖,
 * "已注册过另一份就不许覆盖"这条约束就被绕过了(Codex lexicon-r8)。
 * ⚠️ 这只对**敌意 / 带行为的正则**成立;契约本来就要求原生正则(见 `Lexicon` 文档)。
 * 守卫三行,顺带防住无意的重入,加上不亏。
 */
let registering = false;

export function setLexicon(lex: Lexicon): void {
  if (registering) throw new Error("setLexicon 不支持重入(注册过程中不许再次注册)");
  registering = true;
  try {
    setLexiconInner(lex);
  } finally {
    registering = false;
  }
}

function setLexiconInner(lex: Lexicon): void {
  // 🔴 同源幂等判断必须在**所有校验之前**:放在后面的话,"注册后外部改了原对象、再注册一次"
  //    会先在校验处抛错,而不是安静返回 —— 那就不是幂等(Codex lexicon-r4)。
  if (registeredSource === lex) return;
  if (registeredSource) {
    throw new Error("已注册过另一份领域词表:进程级单例不支持多垂类并存,请在各自进程 / composition root 里注入");
  }
  // 🔴 **每个字段各读一次**,之后只用局部值校验与建快照。
  //    词表若是带 getter 的对象 / Proxy,反复读取可以让"被校验的值"和"进快照的值"不是同一个;
  //    而 `{ ...lex }` 还会读遍**所有**可枚举属性 —— 一个与词表无关的 getter 抛错就能让注册失败
  //    (Codex lexicon-r7)。所以这里逐字段取,不用展开。
  const read = {
    moneyBefore: lex.moneyBefore, moneyAfter: lex.moneyAfter,
    categoryLabelContext: lex.categoryLabelContext,
    subjectCodePatterns: lex.subjectCodePatterns,
    windowLabelPattern: lex.windowLabelPattern,
    subjectCodeIsSixDigits: lex.subjectCodeIsSixDigits,
  };

  // 给 `.test()` 用的:必须是单个 RegExp,且**不许带 g/y** —— 它们有 lastIndex 状态,
  // 共享后反复 test 会交替命中 / 漏掉。
  for (const k of TEST_FIELDS) {
    const r = read[k];
    if (!isRe(r)) throw new Error(`词表 ${k} 必须是 RegExp,收到 ${Array.isArray(r) ? "数组" : typeof r}`);
    if (/[gy]/.test(r.flags)) throw new Error(`词表 ${k} 用于 .test(),不许带 g/y 标志`);
  }
  // 给 `.replace()` 用的:必须带 g(否则一行里只剥掉第一处)且不许带 y(sticky 常常一次都匹配不到)。
  // ⚠️ 两个字段的**形状不同**,不能用"RegExp 或其数组"一把抓 —— 那样 `subjectCodePatterns: /x/g`
  //    能过校验却在展开时炸,`windowLabelPattern: [/x/g]` 能存进去却让替换逻辑收到数组(Codex lexicon-r5)。
  const checkReplace = (k: string, r: unknown): RegExp => {
    if (!isRe(r)) throw new Error(`词表 ${k} 必须是 RegExp,收到 ${Array.isArray(r) ? "数组" : typeof r}`);
    if (!r.flags.includes("g") || r.flags.includes("y")) throw new Error(`词表 ${k} 用于 .replace(),必须带 g 且不许带 y`);
    return r;
  };
  if (!Array.isArray(read.subjectCodePatterns)) throw new Error("词表 subjectCodePatterns 必须是 RegExp 数组");
  const codes = [...read.subjectCodePatterns].map((r, i) => cloneRe(checkReplace(`subjectCodePatterns[${i}]`, r)));
  const window = cloneRe(checkReplace("windowLabelPattern", read.windowLabelPattern));

  // 🔴 先把快照建好,**最后再一起提交**。中途抛错会留下"registeredSource 已写、activeLexicon 还是 null"
  //    的半注册状态:同一对象重试被幂等判断直接返回、换一份又报"已注册过另一份",
  //    进程从此卡死在"未注入"(Codex lexicon-r5)。
  const snapshot = Object.freeze({
    moneyBefore: cloneRe(read.moneyBefore), moneyAfter: cloneRe(read.moneyAfter),
    categoryLabelContext: cloneRe(read.categoryLabelContext),
    subjectCodePatterns: Object.freeze(codes) as unknown as RegExp[],
    windowLabelPattern: window,
    subjectCodeIsSixDigits: Boolean(read.subjectCodeIsSixDigits),
  });
  activeLexicon = snapshot;
  registeredSource = lex;
}

/** 仅供测试:清掉已注册的词表(生产路径不该用) */
export function resetLexicon(): void { activeLexicon = null; registeredSource = null; }
/**
 * 当前活动词表;未注入直接抛错(不给静默默认值)。
 *
 * ⚠️ **已接受的残留**:返回的是冻结快照,但里面的 `RegExp` 对象本身仍可被 `compile()` 原地改。
 *
 * 这条边界的目标是"**注册方持有的原对象改不动已生效的词表**"(已做到:注册时克隆),
 * 不是"防住 Core 内部消费者乱改"。三条路都掂量过:
 * 1. `Object.freeze(regex)` —— **实测不行**:V8 的 `RegExp.prototype.exec` 会无条件写 `lastIndex`,
 *    冻结之后连 `.test()` 都抛 `TypeError: Cannot assign to read only property 'lastIndex'`,
 *    全局正则的 `.replace()` 更是直接废掉。**这条路是死的,别再试。**
 * 2. 每次调用返回深拷贝 —— 本函数在**逐行热路径**上调用,每行分配一批正则不划算。
 * 3. 改成函数门面(不暴露正则对象)—— 可行,但要重构 `claimTokens` 的内部 API,留作后续。
 *
 * ⇒ 现状:**内部调用方只读,不要改它**。要利用它得先能在进程内执行代码,
 *   那时攻击者已有更直接的手段 —— 在本产品的信任边界内可接受(Codex lexicon-r7~r9 反复讨论过)。
 */
export function currentLexicon(): Lexicon {
  if (!activeLexicon) throw new Error("未注入 Lexicon:入口处应先调用 setLexicon(见 finance/register.ts)");
  return activeLexicon;
}

/** 类别标签(如 1.6T / 800G)不是数字主张——但只在"有类别语境、无金额语境"时剥;两个语境正则都由 Plugin 提供(Codex 审查 voice-r1/r2) */
export function stripSpeedLabels(s: string, lex: Lexicon = currentLexicon()): string {
  return s.replace(/(?<![\d.])\d+(?:\.\d+)?\s?[TG](?:bps|b)?(?![A-Za-z0-9])/g, (m, off: number, str: string) => {
    const before = str.slice(Math.max(0, off - 12), off);
    const after = str.slice(off + m.length, off + m.length + 12);
    if (lex.moneyBefore.test(before) || lex.moneyAfter.test(after)) return m;
    return lex.categoryLabelContext.test(before) || lex.categoryLabelContext.test(after) ? " " : m;
  });
}
export function claimTokens(line: string, symbol?: string, lex: Lexicon = currentLexicon()): { n: number; raw: string }[] {
  // 先剥离 id、日期、年份 / FY、6 位代码、字母前缀代码(C39)、序号 / 计数 / ×N / 季度标记 / 情景锚点记号(30x);年份与代码只在独立数字时剥离,不能咬进 19826269128.43 这类长数字
  // 先剥 URL(链接里的数字不是主张)与速率标签(1.6T / 800G / 3.2T / 400Gbps 是产品类别名,不是数字主张);
  // 但金额语境不剥:"$1.6T" / "1.6T 美元" / "800G 元" 前有货币符号或后接金额 / 百分比单位时仍是数字主张(Codex 审查 voice-r1)
  // 先剥 URL 与域名(163.com / 36kr.com 里的数字不是主张;ht6 真踩),再剥速率标签
  // HTTP 状态码(HTTP 429 / 状态码 402)是故障描述不是数字主张(ht11:agent 如实写"H100 因 HTTP 429 未获取"被判未绑定)
  // 联邦公报文号 2026-11571 / 公告编号 2026-001 是编号不是数字(年份剥掉后会留下 -11571 负数 —— Codex policy-r1)
  // 先把"日期 + 时刻"当整体剥掉(报告里发布时间的写法:2026-08-24 20:45 / 2026-08-24T20:45:00);
  // **裸时刻不剥** —— 否则"配比 35:65"这种真主张会被漏掉(Codex headlines-r2)
  line = line.replace(/\d{4}-\d{2}-\d{2}[\sT]{0,3}\d{1,2}:\d{2}(?::\d{2})?/g, " ");
  let s = stripSpeedLabels(line.replace(/https?:\/\/[^\s)\]]+/g, " ").replace(/(HTTP|状态码|status)\s?[1-5]\d{2}(?!\d)/gi, " ").replace(/(?<![\d.])(19|20)\d{2}-\d{3,6}(?![\d.-])/g, " ").replace(/(?<![\d.])1260H\b/g, " ").replace(/(?<![\w.])[\w-]+(?:\.[\w-]+)*\.(?:com|cn|net|org|io|co|hk|tw|jp|kr|de|uk|info|biz|tv|me|ai|app)(?:\.[a-z]{2})?(?![\w.])/gi, " ")).replace(/(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9a-zA-Z_])/g, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\d{4}Q[1-4]|\d{4}H[12]/g, " ")
    .replace(/FY\s?\d{4}/g, " ").replace(/(?<![\d.])(19|20)\d{2}(?![\d.])\s*[年]?/g, " ")// 主体编号默认剥掉,**但后面紧跟单位就是真数字**(踩坑实例见 finance/lexicon.ts)
    // 主体编号剥离的条件由 Plugin 的 subjectCodePatterns 给出,或**等于本次运行的主体编号**。
    // 单位白名单永远补不全(辆 / 平方米 / 千瓦…—— Codex commodity-r3),所以裸的、又不是本次主体编号的数字一律当真主张交给绑定校验
    ;
  for (const re of lex.subjectCodePatterns) s = s.replace(re, " ");
  s = s
    .replace(/(?<![\d.])[A-Za-z]\d+(?![\d.])/g, " ")
    .replace(/第\s*\d+\s*[次条行名]|\d+\s*[次条行个家名项]\b|×\s*\d+|\d+\s*季度?|Q\d|(?<![\d.])\d+(?:\.\d+)?x\b/g, " ")
    // 时间**窗口标签**不是数字主张(窗口长度 ≠ 数据点)—— 具体词表由 Plugin 提供,踩坑记录见 finance/lexicon.ts
    // 只有**后接窗口词**才算窗口标签;"回款周期约 30 天" / "交付周期约 45 日" 是真主张,不能剥(Codex commodity-r2)
    .replace(lex.windowLabelPattern, " ");
  if (lex.subjectCodeIsSixDigits && symbol && /^\d{6}$/.test(symbol)) s = s.replace(new RegExp(`(?<![\\d.])${symbol}(?![\\d.])`, "g"), " ");  // 本次主体编号在正文里裸写也当编号
  const out: { n: number; raw: string }[] = [];
  for (const m of s.matchAll(/-?\d[\d,]*\.?\d*(?:e[+-]?\d+)?/gi)) {
    const raw = m[0]; const n = Number(raw.replace(/,/g, "")); if (!Number.isFinite(n)) continue;
    const after = s.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 3);
    // ≤20 的小整数:只有紧跟单位 / 百分号 / 倍 / 元 / 亿 / 万 时才算实质数字(否则视为计数)
    // ≤20 的小整数只在**纯整数写法**时视为计数跳过("近 5 年" / "第 2 批");带小数点的是 calc 0.3.2 display 写法("2.00 年" / "0.00 年"),必须绑定证据。
    // "期" 进白名单:quarterize 的期数 display 就是整数("11 期"),必须绑定;"年" 不进(叙述里"近 5 年"太常见,交给 judgeDisplayFidelity 的叙述豁免规则处理)。
    if (Number.isInteger(n) && Math.abs(n) <= 20 && !/e/i.test(raw) && !/\.\d/.test(raw) && !/^\s*(%|倍|元|亿|万|x|X|pp|百分点|期)/.test(after)) continue;  // "1." 列表编号不算小数
    out.push({ n, raw: raw + (/^\s*(%|倍|元|亿|万|百分点|年|期)/.exec(after)?.[0]?.trim() ?? "") });
  }
  return out;
}

/** calc 0.3.2 起给每个结果附 `display`。更早的版本没有,是**正常的旧运行**不是缺陷。 */
export function supportsDisplay(v: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return false;                       // 版本读不出来 → 不做要求(宁可漏报也不误杀旧运行)
  const [, a, b, c] = m.map(Number) as unknown as [string, number, number, number];
  return a > 0 || b > 3 || (b === 3 && c >= 2);
}

export const normDisp = (s: string) => s.replace(/\s+/g, "");

/**
 * 在历史文本里找一个数字写法。**只要求左边界**(左边不能紧邻数字 / 小数点)。
 *
 * 左边界防的是"59.09%"里藏着一个编造的"9.09%"(Codex fidelity-r1 P1)。
 * ⚠️ 右边界**故意不要**:引用旧值时截位是正常写法(档案里是 0.6328580294544913,
 * 报告写"旧值 0.632858 不再适用"),加了右边界会把这种正当引用判成编造 —— 实测拦掉 3 处。
 * 与 display 的"逐字照抄"不同:那是**本次算出来的数**,截位就是丢精度;这是**引用旧值**,性质不同。
 */
/**
 * 符号规范化:Unicode 负号(U+2212 等)统一成 ASCII `-`,并把"符号与数字之间的空白"去掉。
 * 不做这一步,`- 1.92%` 与 `−1.92%` 都能绕过下面的符号边界(Codex fidelity-r4)。
 */
export const normSign = (s: string) => s.split("\n").map((line) => {
  // 🔴 只认**真负号**:U+2212 与全角负号。en dash / em dash 是标点(破折号、区间号),
  //    一律当负号会误伤"毛利率—1.92%"这类正当写法(Codex fidelity-r5)。
  // 🔴 行首的 markdown 列表标记 `- ` 不是负号,原样保留 —— 否则"- 1.92% 为历史值"整行被当成负值。
  const head = /^(\s*[-*+]\s+)?/.exec(line)![0];
  return head + line.slice(head.length).replace(/[\u2212\uFF0D]/g, "-").replace(/([+-])\s+(?=[\d.])/g, "$1");
}).join("\n");

/**
 * token 在行内**是否带负号**。`claimTokens` 的正则不吃符号,`−1.92%` 会被解析成正数 1.92,
 * 直接拿去绑一个正值证据 —— 方向反了却判通过(Codex fidelity-r5 P1)。
 * ⚠️ 行首的 markdown 列表标记 `- ` 不算负号(它前面没有任何非空白字符)。
 */
export function negatedAt(line: string, idx: number): boolean {
  if (idx <= 0) return false;
  const head = line.slice(0, idx);
  const m = /([-+\u2212\uFF0D])\s*$/.exec(head);
  if (!m || m[1] === "+") return false;
  // 🔴 "行首 = 列表标记"这条豁免**只对 ASCII 连字符成立** —— markdown 的列表标记是 `-`,
  //    不会是 U+2212 / 全角负号。行首写 `−1.92%` 就是个负数,不是列表项(Codex fidelity-r6)。
  if (m[1] !== "-") return true;
  return /\S/.test(head.slice(0, m.index));      // ASCII `-`:前面还有内容才算负号
}

export function quotedIncludes(rawHay: string, rawNeedle: string): boolean {
  const hay = normSign(rawHay), needle = normSign(rawNeedle);
  if (!needle) return false;
  const signedNeedle = /^[+-]/.test(needle);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    if (/[\d.]/.test(before)) continue;
    // 🔴 无符号的 token 不许绑到**带负号**的文本:证据写"同比 -1.92%"、报告写"1.92%",
    //    方向就反了。带符号的 needle(方向词那条路径传的 `-1.92%`)不受此限(Codex fidelity-r3 P1)。
    if (!signedNeedle && /[+-]/.test(before)) continue;
    return true;
  }
  return false;
}
export const PROSE_BEFORE = /(近|过去|未来|连续|第|每|共|约|前|后|历时|超过|不足|以上|以下|至少|最多)\s*$/;
/**
 * 中文用**方向词**承载正负号:证据值是 -1.92,报告写"下降 1.92 美元/卡时"是正确写法,
 * 不是丢了符号(实测这类占误报的一大半)。命中这些词时,允许按绝对值绑定。
 * ⚠️ 仅放宽**符号**,不放宽数值本身;方向词写反(该"降"写成"升")这里抓不到 —— 那是语义层的事。
 */
export const SIGNED_BEFORE = /(下降|上升|下跌|上涨|回落|回升|减少|增加|降低|提高|收窄|扩大|低|高|多|少|降|升|增|减|差)\s*$/;

export function reportSections(report: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}; let cur = "_head";
  out[cur] = [];
  for (const line of report.split("\n")) { const m = /^##\s+(.+)$/.exec(line); if (m) { cur = m[1].trim(); out[cur] = []; continue; } out[cur].push(line); }
  return out;
}

export interface FidelityResult {
  /** 该写 display 却没写 —— 不是"不适用",是 calc 侧缺陷,必须报出来 */
  missingDisplay?: boolean;
  /** 纯 evidence 行的违规。**不受 `applicable` 门控** —— 它与 display 无关 */
  evidenceViolations?: string[];
  /** 本次运行是否有带 display 的 calc(旧运行没有 → 不适用,不判失败) */
  applicable: boolean;
  total: number;
  exact: number;
  violations: string[];
}

/**
 * 逐行检查:一行里若引了 calc,则该行的数字必须能对上所引 calc 的 display,
 * 或对上同行 evidence 的原值(事实数字照抄),或是 calc 的输入 / 中间量。
 * `symbol` 用于把本次主体代码从"数字主张"里剔掉(裸写的 6 位代码不是数字)。
 */
export function checkNumberFidelity(report: string, evById: Map<string, EvidenceItem>,
                                    calcById: Map<string, CalcRecord>, symbol?: string,
                                    quoted: string[] = [], lex: Lexicon = currentLexicon()): FidelityResult {
  // `quoted` = 可**逐字引用**的历史文本(知识档案召回内容、knowledge_conflicts 的 claim)。
  // 报告写"旧前瞻 CAGR 59.09% 不再适用,本次为 58.85%"时,59.09% 是对档案的**引用**,
  // 本次运行的证据里当然没有它 —— 不把这类纳入可绑定池,就会把"如实标注新旧差异"这个**正确行为**判成违规。
  const quotedText = quoted.join("\n");
  const secs = reportSections(report);
  let total = 0, exact = 0, anyDisplay = false, shouldHaveDisplay = 0;
  // 违规提示用:全量"display / 数值"索引。校验时数字必须绑**同行引用的 id**(纪律不变),
  // 但报违规时告诉 agent"这个数其实存在于 X 的 display / 值里,把 X 补进同行引用即可"——
  // 9 万 token 上下文里自己找要翻 800 条 evidence,提示一下是 1 token 的事(2026-09-05 600519
  // run: report 收敛 9→3→1,最后 1 个就是 5.47% 漏引 calc-e45da3 的 display,数本身全对)。
  const displayOwner = (raw: string): string | null => {
    const n = normDisp(raw);
    for (const [id, rec] of calcById) {
      for (const r of resultProjection(rec.output)) {
        if (r.display && r.status === "ok" && normDisp(r.display) === n) return id;
      }
    }
    return null;
  };
  // evidence 数值归属:val 与某条 evidence 的数值叶子相等(含 元→亿/万、小数→% 量纲)但没引它。
  // 容差 2e-5 相对 = 覆盖"亿元 2 位小数"的展示舍入(445.1688 亿 → 445.17 亿,相对差 2.7e-6);
  // 这只是**提示**(不放松校验):校验该拦的还是拦,提示给错也只是让 agent 多看一个 id。
  const valueOwner = (val: number): string | null => {
    const scaled = [val, val * 1e8, val * 1e4, val / 1e8, val / 1e4, val * 100];
    for (const [id, e] of evById) {
      const v = e.value;
      if (typeof v === "number" && Number.isFinite(v)) {
        if (scaled.some((s) => Math.abs(s - v) <= Math.abs(v) * 2e-5 + 1e-9)) return id;
      }
    }
    return null;
  };
  const violations: string[] = [];        // display 纪律相关(引用了 calc 的行)—— 受 applicable 门控
  const evidenceViolations: string[] = []; // 纯 evidence 行 —— **与 display 无关,始终上报**
  for (const [sec, lines] of Object.entries(secs)) {
    if (sec === "_head" || sec === "数据缺口") continue;
    for (const line of lines) {
      const ids = [...line.matchAll(/(?<![0-9a-zA-Z_-])(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9a-zA-Z_])/g)].map((m) => m[1]);
      const calcIds = ids.filter((id) => calcById.has(id));
      const evIds = ids.filter((id) => evById.has(id));
      // 🔴 **纯 evidence 行也要查**。原先只查引用了 calc 的行,于是"引了一个真实的 ev-id 却写了
      //    另一个数字"在事实表里完全没人管 —— 而事实表恰恰是整篇报告数字最密集的地方。
      //    ⚠️ 这条不是拍脑袋加的:在本机 48 个真实运行上实测过 —— 1209 行纯 evidence 行、
      //    806 个需校验 token,报出 5 个,逐个核对后 **4 个是真缺陷**
      //    (某次运行的事实表把证据 id 整体错位了一行:70.96 那行引的 id 实际值是 39.03),
      //    1 个是空格造成的误报(已在下面的文本匹配里规范化空白)(Codex fidelity-r1 P1)。
      if (!calcIds.length && !evIds.length) continue;
      const displays = new Set<string>();
      for (const id of calcIds) {
        const rec = calcById.get(id)!;
        // 判据用**这条记录自己的 calc_version**:0.3.2 起才写 display,更早的版本没有属正常。
        // 用"引用了 calc 却没 display"当判据会把真·旧运行一并判失败(实测把全部端到端夹具打红)。
        const expectsDisplay = supportsDisplay(String((rec as { calc_version?: unknown }).calc_version ?? ""));
        for (const r of resultProjection(rec.output)) {
        // 只有**成功**的结果才被要求写 display:失败结果合理地没有 display,
        // 拿它触发 missingDisplay 会把正常运行拦下(Codex fidelity-r2)。
        const succeeded = r.status === "ok";
        if (expectsDisplay && succeeded && !r.hasDisplay) shouldHaveDisplay++;
        // `anyDisplay` 与"合法靶子"必须同一判据:只有失败结果残留 display 时,
        // 本该"不适用"却会打开上报门控(Codex fidelity-r3)。
        if (r.hasDisplay && succeeded) anyDisplay = true;
        // 只有**成功且数值有限**的结果的 display 才是合法靶子:失败子结果残留的 display
        // 会让一个本不该出现的数字看着"照抄了 display"(Codex fidelity-r1 P1)
        // status 必须**明确是 ok**(不再放行 undefined)。
        // value 允许 null:`resultProjection` 把**非数值 value 归一成 null**
        // (`typeof o.value === "number" ? o.value : null`),所以判定类结果(value 是文本)
        // 到这里就是 null —— 它们的 display 同样是合法靶子,写成"只收有限数"会把它们误杀。
        if (r.display && succeeded && (r.value === null || Number.isFinite(r.value))) {
          displays.add(normDisp(r.display));
        }
        }
      }
      const evPool = numbersOf(evIds, evById, calcById);
      const calcPool = numbersOf(calcIds, evById, calcById);
      // 🔴 `startsWith` 允许**截断数字**:display 是 "37.40 倍" 时,报告写 "37.4" 也会命中 ——
      //    而"少写一位有效数字"正是这个判定要抓的东西(Codex fidelity-r1 P1)。
      //    只允许截掉**单位后缀**(剩余部分不以数字开头),不允许截掉数字本身。
      const hasDisp = (raw: string) => {
        const n = normDisp(raw);
        return [...displays].some((x) => x === n || (x.startsWith(n) && !/^[\d.]/.test(x.slice(n.length))));
      };
      let cursor = 0;
      for (const t of claimTokens(line, symbol, lex)) {
        const unit = /[^0-9.,e+-]+$/.exec(t.raw)?.[0] ?? "";
        const num = t.raw.slice(0, t.raw.length - unit.length);
        const decimal = /\.\d/.test(num);
        if (!decimal && !unit) continue;                                   // 纯整数计数,豁免
        // 从游标往后找:同一行出现两次相同数字时,`indexOf` 永远取第一次,
        // 于是"约 30 次,合计 30 次"里第二个 30 会借第一个前面的"约"蒙混过去(fidelity-r1 P2)
        const idx = line.indexOf(num, cursor);
        if (idx >= 0) cursor = idx + num.length;
        const before = idx >= 0 ? line.slice(Math.max(0, idx - 6), idx) : "";
        if (!decimal && PROSE_BEFORE.test(before)) continue;               // "近 5 年" / "连续 3 期":叙述,豁免
        total++;
        const signed = SIGNED_BEFORE.test(before);        // "下降 1.92" ← 证据 / display 为 -1.92
        // 行内**显式写了负号**时,要拿负值去绑:否则 "−1.92%" 会被当成 1.92 绑上一个正值证据
        const neg = negatedAt(line, idx);
        const val = neg ? -t.n : t.n;
        const raw = neg ? `-${t.raw}` : t.raw;
        if (hasDisp(raw) || (signed && hasDisp(`-${t.raw}`))) { exact++; continue; }
        // 原始事实数字照抄 evidence。文本匹配要**规范化空白**:证据里写"12.34 亿元"、
        // 报告写"12.34亿",本是同一个数,不该因为一个空格判成编造。
        // 文本证据同样要**左边界**:裸 includes 会让 "59.09%" 承载一个编造的 "9.09%"(fidelity-r2 P1)。
        // 右边界仍不加(单位后缀 / 合理截位要放行),空白规范化后再比。
        const inText = (needle: string) => evPool.texts.some((x) => quotedIncludes(normDisp(x), normDisp(needle)));
        if (numberBound(val, evPool.nums) || (signed && numberBound(-t.n, evPool.nums))
            || inText(raw) || (signed && inText(`-${t.raw}`))) { exact++; continue; }
        // 逐字引用知识档案里的旧值。⚠️ **必须带边界**:裸 `includes` 会让 "59.09%" 里
        // 命中一个编造的 "9.09%"(Codex fidelity-r1 P1) —— 那不是"引用",是巧合。
        // ⚠️ 引用历史负值时也要走方向词那条路:档案是 "-1.92%"、报告写"下降 1.92%",
        //    加了符号边界后若不给这条路径补 `-token`,正当写法反而被拦(这是 r3 修复引入的,r4 抓到)。
        if (quotedText && (quotedIncludes(quotedText, raw) || quotedIncludes(quotedText, String(val))
            || (signed && (quotedIncludes(quotedText, `-${t.raw}`) || quotedIncludes(quotedText, String(-t.n)))))) { exact++; continue; }
        // 可绑 calc 的**输入 / 中间量(output.details)**,带量纲缩放(元→亿、小数→%),
        // 不能绑 output.value。年 / 期 单位除外:"消化 30 年"里的 30 是锚(倍)不是年数,放行等于放过一个真错误。
        // 🔴 历史(1e-9 死匹配、只认 inputs)会误杀三种**可溯源**的合法写法:
        //   ① 引用 details 里的副统计量(percentile_rank 的 min/median/max,
        //      如「近五年最低分位 17.66 倍 [calc-percentile_rank]」);
        //   ② 量纲换算(inputs 是 27239985194.41 元,报告写「272.40 亿」);
        //   ③ 小数→百分比(details 是 0.1952,报告写「19.52%」)。
        // 2026-09 一次真实 run 5/5 次成稿全灭的根因之一。
        // 防"照抄输出原始浮点"的纪律由**池排除 output.value** 承担(intermediateNumbersOf
        // 只收 inputs + details),与匹配宽松度无关 —— 原始浮点 37.397700293773134 不在池里。
        // ⚠️ 容差按整数/小数分档(上游 review):2e-3 相对容差是为整数锚(30 倍、1504 亿)定的,
        //    套到小数上会把「改数字」放过(numberBound(27.35,[27.30])→true)。上三类合法写法
        //    靠 numberBound 内「四舍五入到两位」那一条命中,小数分支用紧容差 1e-6 即可全放行,
        //    同时「27.35 vs 27.30」这类真改写仍被拦。
        if (!/^(年|期)$/.test(unit) && numberBound(val, intermediateNumbersOf(calcIds, calcById), decimal ? 1e-6 : 2e-3)) { exact++; continue; }
        // 🔴 两类违规必须分开:`applicable`(本次有没有 display)只能决定**display 纪律**适不适用,
        //    决定不了"引了一个真实 ev-id 却写了别的数"要不要报 —— 那与 display 无关。
        //    合在一起的后果:旧 calc 运行 / 纯取数运行里,事实表写错数字完全不会被报出来(Codex fidelity-r2 P1)。
        // 提示(不放松校验):数字若实际存在于**未引用**的 calc display / evidence 值里,
        //  直接告诉 agent 该引哪个 id —— 把"违规"变成 1 token 可执行的修复指令,
        //  而不是让它在 9 万 token 上下文里自己翻 800 条 evidence。
        const hint = displayOwner(raw) ?? (neg ? null : valueOwner(val)) ?? (signed ? valueOwner(-val) : null);
        const msg = `[${sec}] ${t.raw} ← ${line.slice(0, 80)}` + (hint ? ` 【数字真实存在,只是没引用:补引 ${hint}】` : " 【数字不在任何已引用证据/计算中:改写或补正确引用】");
        (calcIds.length ? violations : evidenceViolations).push(msg);
      }
    }
  }
  // 🔴 `applicable=false` 有两种截然不同的原因,生产里必须分开(Codex fidelity-r1 P1):
  //    ① 报告根本没引用带结果的 calc(旧运行 / 纯取数运行)→ 确实不适用;
  //    ② calc 版本本该写 display 却没写 → 那是 calc 侧的缺陷,
  //       此时静默跳过等于把整条数字忠实度防线关掉,而外面看不出来。⇒ 用 `missingDisplay` 报出来。
  return { applicable: anyDisplay, total, exact, violations, evidenceViolations, missingDisplay: shouldHaveDisplay > 0 };
}


/** 各阶段 knowledge_conflicts 的 claim / refuted_by 文本 —— 报告引用"旧值"时的可追溯来源 */
export function quotedHistory(stageOf: (s: string) => Record<string, unknown> | null): string[] {
  const out: string[] = [];
  for (const st of currentPlugin().stages) {   // 阶段清单由契约给,不写死(全审 r4)
    const kc = (stageOf(st) as { knowledge_conflicts?: unknown } | null)?.knowledge_conflicts;
    if (!Array.isArray(kc)) continue;
    for (const c of kc) {
      if (c && typeof c === "object") for (const k of ["claim", "refuted_by"]) {
        const v = (c as Record<string, unknown>)[k];
        if (typeof v === "string") out.push(v);
      }
    }
  }
  return out;
}
