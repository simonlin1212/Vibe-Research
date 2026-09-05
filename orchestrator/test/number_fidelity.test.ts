import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/finance/register.ts";   // Core 不内置词表:未注册就抛错(这正是设计)
import { checkNumberFidelity, quotedHistory } from "../src/number_fidelity.ts";

const CALC = "calc-" + "a".repeat(16);
const EV = "ev-bbbbbb";
// ⚠️ resultProjection 只认**同时带 status/value/unit** 的结果对象 —— 缺任一个,display 就取不到,
// 数字会退而去绑输出原始值(那正是本检查要禁止的),测试就会"因为错误的理由通过"。
const calcs = new Map([[CALC, { output: { status: "ok", value: 34.07, unit: "倍", display: "34.07 倍", details: null }, inputs: { price: 943.0, eps: 27.68 } }]]);
const evs = new Map([[EV, { value: 200.42 }]]);
const n = (report: string, quoted: string[] = []) => checkNumberFidelity(report, evs as never, calcs as never, "300308", quoted).violations;

test("该抓的要抓到:引了真 id 却写别的数", () => {
  // 这正是架构审计点名的缺口 —— 在此之前 validateReport 只查 id 存不存在
  assert.equal(n(`## 估值\n前瞻 PE 为 41.90 倍 [${CALC}]。`).length, 1);
  assert.equal(n(`## 估值\n前瞻 PE 为 3407.00 倍 [${CALC}]。`).length, 1, "小数不许靠量纲缩放蒙混");
  assert.equal(n(`## 事实\nTTM 同比 250.42% [${EV}] [${CALC}]。`).length, 1, "证据原值被改也要抓");
});

test("该放的要放行:display 照抄 / calc 输入 / 证据原值", () => {
  assert.deepEqual(n(`## 估值\n前瞻 PE 为 34.07 倍 [${CALC}]。`), []);
  // 表格常见写法:结果与它的两个输入同行并列,读者点开该 calc 就能核对
  assert.deepEqual(n(`## 估值\n前瞻 PE 34.07 倍 [${CALC}],昨收 943.0 元 / EPS 27.68 元。`), []);
  assert.deepEqual(n(`## 事实\nTTM 同比 200.42% [${EV}] [${CALC}]。`), []);
});

test("没有引用 id 的行不在本检查范围(那是 judgeNumberBinding 的活)", () => {
  assert.deepEqual(n("## 估值\n前瞻 PE 大约 99.99 倍。"), []);
});

test("🔴 引用知识档案里的旧值不算违规 —— 如实标注新旧差异是**正确行为**", () => {
  const line = `## 风险与反证\n旧前瞻 CAGR 59.09% 不再适用,本次为 34.07 倍 [${CALC}]。`;
  assert.equal(n(line).length, 1, "没有档案文本时,59.09 确实无出处");
  assert.deepEqual(n(line, ["前瞻 CAGR 为 0.5909334882897681(小数),即 59.09%"]), [],
    "档案里有这个值 → 可追溯,不该判违规");
});

test("quotedHistory:从各阶段 knowledge_conflicts 收集 claim / refuted_by", () => {
  const stage = (s: string) => (s === "risk"
    ? { knowledge_conflicts: [{ claim: "旧 CAGR 59.09%", refuted_by: "本次 58.85%" }, { claim: 123 }] }
    : null);
  assert.deepEqual(quotedHistory(stage as never), ["旧 CAGR 59.09%", "本次 58.85%"]);
  assert.deepEqual(quotedHistory(() => null), []);
  assert.deepEqual(quotedHistory(() => ({ knowledge_conflicts: "不是数组" })), []);
});

test("applicable:没有带 display 的 calc 时不适用(旧运行不该被判失败)", () => {
  const old = new Map([[CALC, { output: { status: "ok", value: 1, unit: "倍", details: null }, inputs: {} }]]);   // 无 display = 旧运行
  assert.equal(checkNumberFidelity(`## 估值\nx 9.99 倍 [${CALC}]`, evs as never, old as never).applicable, false);
});

/* ---------- Codex fidelity-r1 的回归 ---------- */

const evMap = (rows: [string, unknown, string?][]) =>
  new Map(rows.map(([id, value, unit]) => [id, { id, value, unit } as never]));
const calcMap = (rows: { id: string; output: unknown; inputs?: unknown; ver?: string }[]) =>
  new Map(rows.map((r) => [r.id, { calculation_id: r.id, output: r.output, inputs: r.inputs ?? {},
                                   calc_version: r.ver ?? "0.3.2" } as never]));
const CID = "calc-1111111111111111";
const rep = (body: string) => `## 估值\n${body}\n`;

test("display 必须逐字照抄:少写一位有效数字不算照抄", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 37.4, unit: "倍", display: "37.40 倍" } }]);
  // 🔴 原来用 startsWith,于是 "37.4" 命中 "37.40 倍" —— 而"少写一位"正是这个判定要抓的
  const bad = checkNumberFidelity(rep(`| 扣非×4 PE | 37.4 倍 | ${CID} |`), evMap([]), calcs);
  assert.equal(bad.violations.length, 1);
  const good = checkNumberFidelity(rep(`| 扣非×4 PE | 37.40 倍 | ${CID} |`), evMap([]), calcs);
  assert.deepEqual(good.violations, []);
  // 只截掉**单位后缀**仍算照抄(204.53亿 ← "204.53 亿元")
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: 2.045e10, unit: "亿元", display: "204.53 亿元" } }]);
  assert.deepEqual(checkNumberFidelity(rep(`| 净利 | 204.53亿 | ${CID} |`), evMap([]), c2).violations, []);
});

test("失败 / 非有限结果的 display 不是合法靶子", () => {
  const calcs = calcMap([{ id: CID, output: { status: "error", value: null, unit: "倍", display: "37.40 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 37.40 倍 | ${CID} |`), evMap([]), calcs).violations.length, 1);
});

test("引用旧值:左边界防冒名,但允许截位", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const quoted = ["旧前瞻 CAGR 59.09%;旧 PEG 0.6328580294544913 倍"];
  // 截位引用是正常写法
  assert.deepEqual(checkNumberFidelity(rep(`旧 PEG 0.632858 倍不再适用 [${CID}]`), evMap([]), calcs, undefined, quoted).violations, []);
  // 但"59.09%"里藏不下一个编造的"9.09%"
  assert.equal(checkNumberFidelity(rep(`旧 CAGR 9.09% 不再适用 [${CID}]`), evMap([]), calcs, undefined, quoted).violations.length, 1);
});

test("方向词承载正负号:证据 -1.92,报告写「下降 1.92」是对的", () => {
  const ev = evMap([["ev-aaaaaaaaaaaa", -1.92, "美元/卡时"]]);
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  assert.deepEqual(checkNumberFidelity(rep(`中位较上次观测下降 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations, []);
  // 没有方向词时不放宽
  assert.equal(checkNumberFidelity(rep(`中位为 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations.length, 1);
});

test("纯 evidence 行也查:引了真实 id 却写了别的数要被抓出来", () => {
  // 实测依据:48 个真实运行里,事实表把证据 id 整体错位了一行,原实现完全查不到
  const ev = evMap([["ev-bbbbbbbbbbbb", 39.03, "元/股"]]);
  const bad = checkNumberFidelity("## 事实\n| EPS均值 | 70.96 | 元/股 | ev-bbbbbbbbbbbb |\n", ev, calcMap([]));
  // 归入 evidenceViolations:它与 display 无关,**不受 applicable 门控**(旧运行同样该报)
  assert.equal(bad.evidenceViolations?.length, 1);
  assert.deepEqual(bad.violations, []);
  const good = checkNumberFidelity("## 事实\n| EPS最小值 | 39.03 | 元/股 | ev-bbbbbbbbbbbb |\n", ev, calcMap([]));
  assert.deepEqual(good.evidenceViolations, []);
});

test("证据文本匹配要忽略空白:「12.34 亿元」与「12.34亿」是同一个数", () => {
  const ev = evMap([["ev-cccccccccccc", "公告(合同金额 12.34 亿元)"]]);
  assert.deepEqual(checkNumberFidelity("## 卡口事件\n- 合同金额 12.34亿 [ev-cccccccccccc]\n", ev, calcMap([])).violations, []);
});

test("missingDisplay 按每条 calc 自己的版本判,不误杀真旧运行", () => {
  const old = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍" }, ver: "0.3.1" }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 1 倍 | ${CID} |`), evMap([]), old).missingDisplay, false);
  const cur = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍" }, ver: "0.3.2" }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 1 倍 | ${CID} |`), evMap([]), cur).missingDisplay, true);
});


test("整数 calc 输出也不能绕过 display,但 details 里的中间量仍可绑", () => {
  // output.value=37 / display="37.00 倍" → 写 "37 倍" 必须违规(否则小数被管、整数放行,规则自相矛盾)
  const c1 = calcMap([{ id: CID, output: { status: "ok", value: 37, unit: "倍", display: "37.00 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 37 倍 | ${CID} |`), evMap([]), c1).violations.length, 1);
  // 但 details 里的锚点(inputs 为空)是正当中间量,不能误拦
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: null, unit: "年", display: null,
                                           details: { anchors: { a: 30 } } } }]);
  assert.deepEqual(checkNumberFidelity(rep(`景气延续 30 倍锚 [${CID}]`), evMap([]), c2).violations, []);
});

test("小数用紧容差(上游 review 反例):details 里是 27.30,报告写 27.35 = 改了数字,必须拦", () => {
  // 真实 percentile_rank 形状:value=分位(10.66)、details.min=最低 PE(27.30)。
  // 2e-3 相对容差(整数档)套小数会让 numberBound(27.35,[27.30])→true 放过改写;
  // 小数档 1e-6 下 0.05 的差远大于容差,必须判违规。
  const c = calcMap([{ id: CID, output: { status: "ok", value: 10.66, unit: "%", display: "10.66%",
                                           details: { min: 27.30, median: 28.96, max: 54.97 } } }]);
  assert.equal(checkNumberFidelity(rep(`| 近五年最低 | 27.35 倍 | ${CID} |`), evMap([]), c).violations.length, 1);
  // 照抄 details 里的 27.30(两位)是正当引用,放行
  assert.deepEqual(checkNumberFidelity(rep(`| 近五年最低 | 27.30 倍 | ${CID} |`), evMap([]), c).violations, []);
});

test("三类可溯源合法写法在 1e-6 紧容差下仍放行(details 副统计量 / 元→亿 / 小数→%)", () => {
  const c = calcMap([{ id: CID, output: { status: "ok", value: 10.66, unit: "%", display: "10.66%",
                                           details: { min: 17.661621 } } }]);
  // ① details 副统计量:17.66 vs 17.661621(四舍五入到两位命中)
  assert.deepEqual(checkNumberFidelity(rep(`近五年最低 17.66 倍 [${CID}]`), evMap([]), c).violations, []);
  // ② 量纲换算:272.40 亿 vs inputs 27239985194.41 元(×1e-8 后取两位)
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: 11, unit: "期", display: "11 期" },
                        inputs: { cumulative: [{ value: 27239985194.41 }] } }]);
  assert.deepEqual(checkNumberFidelity(rep(`单季扣非 272.40 亿元 [${CID}]`), evMap([]), c2).violations, []);
  // ③ 小数→百分比:19.52% vs details.range_over_mean 0.1952(×100 后取两位)
  const c3 = calcMap([{ id: CID, output: { status: "ok", value: 1.21, unit: "倍", display: "1.21 倍",
                                           details: { range_over_mean: 0.19524189261031363 } } }]);
  assert.deepEqual(checkNumberFidelity(rep(`一致预期分歧 19.52% [${CID}]`), evMap([]), c3).violations, []);
});

test("无符号 token 不许绑到带负号的文本:方向不能反", () => {
  const ev = evMap([["ev-dddddddddddd", "同比 -1.92%"]]);
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  // 没有方向词时,"1.92%" 不能靠子串命中 "-1.92%"
  assert.equal(checkNumberFidelity(rep(`同比为 1.92% [ev-dddddddddddd] [${CID}]`), ev, calcs).violations.length, 1);
  // 有方向词时走 `-token` 这条路,允许
  assert.deepEqual(checkNumberFidelity(rep(`同比下降 1.92% [ev-dddddddddddd] [${CID}]`), ev, calcs).violations, []);
});

test("只有失败结果残留 display 时不算适用", () => {
  const calcs = calcMap([{ id: CID, output: { status: "error", value: null, unit: "倍", display: "37.40 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 99.99 倍 | ${CID} |`), evMap([]), calcs).applicable, false);
});

test("符号边界要能识别带空格的负号与 Unicode 负号", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  for (const hist of ["同比 - 1.92%", "同比 −1.92%", "同比 -1.92%"]) {
    // 无方向词:正数不许绑到负值
    assert.equal(checkNumberFidelity(rep(`同比为 1.92% [${CID}]`), evMap([]), calcs, undefined, [hist]).violations.length, 1, hist);
    // 有方向词:引用历史负值是正当写法(r3 的符号边界一度把它也拦了)
    assert.deepEqual(checkNumberFidelity(rep(`同比下降 1.92% [${CID}]`), evMap([]), calcs, undefined, [hist]).violations, [], hist);
  }
});

test("行内显式负号要按负值绑定;markdown 列表标记与破折号不是负号", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const pos = evMap([["ev-eeeeeeeeeeee", 1.92, "%"]]);
  // 证据是 +1.92,报告写 −1.92%(Unicode 负号)→ 方向反了,必须违规
  assert.equal(checkNumberFidelity(rep(`同比为 −1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations.length, 1);
  assert.equal(checkNumberFidelity(rep(`同比为 - 1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations.length, 1);
  const neg = evMap([["ev-ffffffffffff", -1.92, "%"]]);
  assert.deepEqual(checkNumberFidelity(rep(`同比为 −1.92% [ev-ffffffffffff] [${CID}]`), neg, calcs).violations, []);
  // 行首列表标记不是负号
  assert.deepEqual(checkNumberFidelity(`## 估值\n- 1.92% 为同比 [ev-eeeeeeeeeeee] [${CID}]\n`, pos, calcs).violations, []);
  // 破折号也不是负号
  assert.deepEqual(checkNumberFidelity(rep(`毛利率—1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations, []);
});

test("行首的 Unicode 负号是负号,不是列表标记", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const pos = evMap([["ev-999999999999", 1.92, "%"]]);
  // markdown 列表标记只会是 ASCII `-`;行首 `−` 就是负数
  assert.equal(checkNumberFidelity(`## 估值\n−1.92% 为同比 [ev-999999999999] [${CID}]\n`, pos, calcs).violations.length, 1);
  const neg = evMap([["ev-888888888888", -1.92, "%"]]);
  assert.deepEqual(checkNumberFidelity(`## 估值\n−1.92% 为同比 [ev-888888888888] [${CID}]\n`, neg, calcs).violations, []);
  // ASCII 行首仍按列表标记处理
  assert.deepEqual(checkNumberFidelity(`## 估值\n- 1.92% 为同比 [ev-999999999999] [${CID}]\n`, pos, calcs).violations, []);
});

test("词表注册的护栏:按用途校验正则标志,且不许两个插件并存", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  // ⚠️ 身份检查在最前面 ⇒ 已注册状态下,任何**另一份**词表都会先被"多垂类并存"拦下,
  //    根本走不到标志校验。要测标志校验必须先 reset(这个顺序本身就是设计)。
  resetLexicon();
  const bad = { ...FINANCE_LEXICON, moneyBefore: /x/g };          // .test() 用的不许带 g
  assert.throws(() => setLexicon(bad as never), /不许带 g\/y/);
  const bad2 = { ...FINANCE_LEXICON, subjectCodePatterns: [/\d{6}/] };  // .replace() 用的必须带 g
  assert.throws(() => setLexicon(bad2 as never), /必须带 g/);
  setLexicon(FINANCE_LEXICON);
  // 进程级单例:换一份就当场失败,而不是静默串包
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON } as never), /不支持多垂类并存/);
  setLexicon(FINANCE_LEXICON);                              // 同一份幂等,不抛
  resetLexicon();
  setLexicon(FINANCE_LEXICON);                              // 复原,不影响同文件其它用例
});

test("非正则值不能混过注册(否则要等到 .test() 时才崩)", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, moneyBefore: "美元" } as never), /必须是 RegExp/);
  setLexicon(FINANCE_LEXICON);
});

test("注册后的词表不能被原地改;.replace() 字段不许带 y", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex = { ...FINANCE_LEXICON, subjectCodePatterns: [...FINANCE_LEXICON.subjectCodePatterns] };
  setLexicon(lex as never);
  // 原地改外部对象不该影响已注册的快照
  (lex as { moneyBefore: RegExp }).moneyBefore = /恶意/g;
  lex.subjectCodePatterns.push(/恶意/g);
  assert.notEqual(currentLexicon().moneyBefore.source, "恶意");
  assert.equal(currentLexicon().subjectCodePatterns.length, FINANCE_LEXICON.subjectCodePatterns.length);
  // sticky 正则会让 replace 常常一次都匹配不到
  resetLexicon();
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, windowLabelPattern: /\d+日/gy } as never), /不许带 y/);
  setLexicon(FINANCE_LEXICON);
});

test("同一份词表重复注册必须是真幂等:改完再注册不能替换活动快照", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex = { ...FINANCE_LEXICON, subjectCodePatterns: [...FINANCE_LEXICON.subjectCodePatterns] };
  setLexicon(lex as never);
  // 改完原对象再注册一次:必须**安静返回**(不重做快照,也不因校验抛错)
  (lex as { moneyBefore: RegExp }).moneyBefore = /完全不同的规则/g;   // 连非法标志一起改
  setLexicon(lex as never);
  assert.notEqual(currentLexicon().moneyBefore.source, "完全不同的规则");
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("两个 .replace() 字段的形状不同,不能一把抓;失败也不许留下半注册状态", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  // subjectCodePatterns 必须是数组;windowLabelPattern 必须是单个正则
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, subjectCodePatterns: /代码/g } as never), /必须是 RegExp 数组/);
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, windowLabelPattern: [/窗口/g] } as never), /必须是 RegExp/);
  // 🔴 失败之后必须还能正常注册 —— 半注册状态会让进程永久卡在"未注入"
  setLexicon(FINANCE_LEXICON);
  assert.ok(currentLexicon().moneyBefore instanceof RegExp);
});

test("快照必须克隆正则:RegExp.compile() 能原地改 source/flags,共享对象就不叫快照", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const re = /ABC/g;
  setLexicon({ ...FINANCE_LEXICON, subjectCodePatterns: [re] } as never);
  (re as unknown as { compile: (s: string, f: string) => void }).compile("XYZ", "gy");
  assert.equal(currentLexicon().subjectCodePatterns[0].source, "ABC");   // 快照不受影响
  assert.ok(!currentLexicon().subjectCodePatterns[0].flags.includes("y"));
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("注册只读词表自己的六个字段:无关的 getter 抛错不该让注册失败", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex: Record<string, unknown> = { ...FINANCE_LEXICON };
  Object.defineProperty(lex, "unrelated", { enumerable: true, get() { throw new Error("boom"); } });
  setLexicon(lex as never);                       // 不该炸
  resetLexicon();
  // 每个字段只读一次:第二次读会返回非法值的 getter 不该被读到
  let n = 0;
  const tricky: Record<string, unknown> = { ...FINANCE_LEXICON };
  Object.defineProperty(tricky, "subjectCodePatterns", {
    enumerable: true, get() { return ++n === 1 ? [/safe/g] : "changed"; },
  });
  setLexicon(tricky as never);
  assert.equal(n, 1);
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("注册不支持重入:带行为的正则不能在校验途中偷偷注册另一份", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const hostile = /x/;
  let reentryError: unknown = null;
  Object.defineProperty(hostile, "flags", {
    get() {
      try { setLexicon({ ...FINANCE_LEXICON } as never); } catch (e) { reentryError = e; }
      return "";
    },
  });
  // 外层注册本来就该成功(它是合法的第一份);被拦的是**内层重入** ——
  // 攻击路径是"内层先注册另一份、外层再覆盖",守卫在第一步就断掉了
  setLexicon({ ...FINANCE_LEXICON, moneyBefore: hostile } as never);
  assert.match(String(reentryError), /不支持重入/);
  assert.equal(currentLexicon().moneyBefore.source, "x");    // 生效的是外层那份,没被内层换掉
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
  assert.ok(currentLexicon().moneyBefore instanceof RegExp);
});
