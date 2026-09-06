import assert from "node:assert/strict";
import { test } from "node:test";

import { PLUGIN_SCHEMA, currentPlugin, registerPlugin, resetPlugin, type Plugin } from "../src/plugin.ts";
import { FINANCE_PLUGIN } from "../src/finance/plugin.ts";
import { stageOutputSchema } from "../src/schemas.ts";

/**
 * `Plugin` 注册期校验的单测。
 *
 * 🔴 这些校验是**编译期穷尽性检查的替代品** —— `Stage` 退化成 `string` 之后,
 * `Record<Stage, …>` 再也保证不了"每个阶段都配齐了",全靠注册时逐项核对。
 * 所以每一条都要有测试:校验本身失效了,是没人会发现的那种失效。
 */

const plugin = (over: Partial<Plugin> = {}): Plugin => ({ ...FINANCE_PLUGIN, ...over });
const withEvidence = (over: Partial<Plugin["evidence"]>): Plugin =>
  plugin({ evidence: { ...FINANCE_PLUGIN.evidence, ...over } });

/** 每个用例都从干净状态开始:注册是进程级单例,残留会让后面的用例莫名其妙 */
const fresh = (p: Plugin) => { resetPlugin(); registerPlugin(p); };
const rejects = (p: Plugin, re: RegExp) => {
  resetPlugin();
  assert.throws(() => registerPlugin(p), re);
};

test("观测字段与校验排除章节由插件声明、校验、只读一次并冻结", () => {
  rejects(plugin({ alertObservationFields: ["typo"] }), /alertObservationFields/);
  rejects(plugin({ fidelityExcludedSections: ["typo"] }), /fidelityExcludedSections/);
  for (const field of ["alertObservationFields", "fidelityExcludedSections"] as const) {
    rejects(plugin({ [field]: null } as unknown as Partial<Plugin>), /不符契约/);
    rejects(plugin({ [field]: [" "] }), /不符契约/);
    rejects(plugin({ [field]: ["price", "price"] }), /不符契约/);
    let calls = 0;
    const values = [...FINANCE_PLUGIN[field]!];
    const p = plugin();
    Object.defineProperty(p, field, { enumerable: true, get: () => { calls++; return values; } });
    fresh(p);
    assert.equal(calls, 1);
    values.push("unseen");
    assert.ok(!currentPlugin()[field]!.includes("unseen"));
    assert.ok(Object.isFrozen(currentPlugin()[field]));
  }
  fresh(plugin({ alertObservationFields: undefined, fidelityExcludedSections: undefined }));
  assert.deepEqual(currentPlugin().alertObservationFields, []);
  assert.deepEqual(currentPlugin().fidelityExcludedSections, []);
});

test("四张阶段表的键集必须与 stages 完全一致(这是编译期穷尽性的替代品)", () => {
  const { financials: _drop, ...missing } = FINANCE_PLUGIN.stageCalcs;
  rejects(plugin({ stageCalcs: missing }), /stageCalcs 的键必须与 stages 完全一致[\s\S]*缺少 financials/);
  rejects(plugin({ extraTopics: { ...FINANCE_PLUGIN.extraTopics, 打错的阶段名: ["x"] } }),
    /extraTopics 的键必须与 stages 完全一致[\s\S]*多出 打错的阶段名/);
  const { profile: _p, ...noLabel } = FINANCE_PLUGIN.stageLabels;
  rejects(plugin({ stageLabels: noLabel }), /stageLabels 的键必须与 stages 完全一致/);
});

test("阶段名必须是安全路径段:它会被拼进 stages/<stage>.json", () => {
  // 🔴 包里写个 ../.. 就能穿出运行目录
  for (const bad of ["../../etc", "a/b", "a\\b", ".hidden", "", "x".repeat(65)]) {
    rejects(plugin({ stages: [...FINANCE_PLUGIN.stages, bad] }),
      /不符契约|键必须与 stages/);
  }
});

test("extraTopics 某阶段为空是合法的,但该阶段不许写扩展发现(不是留一个空 enum)", () => {
  // 🔴 原本这里要求 extraTopics 每阶段非空 —— 第二个垂类真的会有"没有扩展议题"的阶段
  //    (餐饮的菜单阶段)。放宽的前提是 schema 那边把空议题表达成 maxItems: 0:
  //    报错说的是"这个阶段不允许扩展发现",而不是"topic 不在允许值里"(后者看不出根因)。
  fresh(plugin({ extraTopics: { ...FINANCE_PLUGIN.extraTopics, report: [] } }));
  const sc = stageOutputSchema("report" as never) as { properties: Record<string, { maxItems?: number }> };
  assert.equal(sc.properties.extra_findings.maxItems, 0, "没有议题的阶段不该允许写扩展发现");
  fresh(FINANCE_PLUGIN);
  const sc2 = stageOutputSchema("report" as never) as { properties: Record<string, { maxItems?: number }> };
  assert.equal(sc2.properties.extra_findings.maxItems, 12);
});

test("两套 market code 是不同规则:Only ⊆ Codes ⊆ markets", () => {
  rejects(withEvidence({ marketWideOnlyCodes: ["US"], marketWideCodes: ["CN"] }),
    /marketWideOnlyCodes 里的 US 不在 marketWideCodes 中/);
  rejects(withEvidence({ marketWideCodes: ["XX"], marketWideOnlyCodes: [] }),
    /marketWideCodes 里的 XX 不在 markets 中/);
  // 金融的正确配置:CN 只能是全市场(个股用 SH/SZ/BJ),US / HK 两者都行
  fresh(FINANCE_PLUGIN);
  assert.deepEqual([...currentPlugin().evidence.marketWideOnlyCodes], ["CN"]);
  assert.ok(currentPlugin().evidence.marketWideCodes.includes("US"));
});

test("标准列与显示名必须**互相覆盖**:缺一个就会静默少一列表头", () => {
  const { peg: _drop, ...missingLabel } = FINANCE_PLUGIN.standardColumnLabels;
  rejects(plugin({ standardColumnLabels: missingLabel }), /缺列 peg 的显示名/);
  rejects(plugin({ standardColumnLabels: { ...FINANCE_PLUGIN.standardColumnLabels, 不存在的列: "X" } }),
    /出现了不存在的列 不存在的列/);
});

test("selfTestCalc 的 args 要真的校验(它一度只写在错误文案里)", () => {
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: [] as never, expect: 20 } }), /不符契约/);
  rejects(plugin({ selfTestCalc: { fn: "", args: {}, expect: 20 } }), /不符契约/);
  // 🔴 ajv v8 的 type:"number" **接受 NaN / Infinity**(实测),所以这一条靠手写的有限性检查兜
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: {}, expect: NaN } }), /expect 必须是有限数/);
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: {}, expect: Infinity } }), /expect 必须是有限数/);
});

test("函数插槽必须是函数;standardColumnsStage 必须是已声明的阶段", () => {
  rejects(plugin({ quoteDecision: undefined as never }), /quoteDecision 必须是函数/);
  rejects(plugin({ baselinePeriod: undefined as never }), /baselinePeriod 必须是函数/);
  rejects(plugin({ standardColumnsStage: "nosuchstage" }), /standardColumnsStage[\s\S]*不是已声明的阶段/);
});

test("快照与原包解耦:注册后改原对象改不动已生效的包", () => {
  const mutable: Plugin = {
    ...FINANCE_PLUGIN,
    stages: [...FINANCE_PLUGIN.stages],
    stageScripts: JSON.parse(JSON.stringify(FINANCE_PLUGIN.stageScripts)) as Plugin["stageScripts"],
  };
  fresh(mutable);
  (mutable.stageScripts.profile.required as string[]).push("偷偷加的脚本");
  assert.ok(!currentPlugin().stageScripts.profile.required.includes("偷偷加的脚本"));
  // 快照里的数组也冻了:消费者一句 push 不该改掉已生效的运行计划
  assert.throws(() => (currentPlugin().stageScripts.profile.required as string[]).push("x"));
});

test("同一份幂等;换一份当场失败;reset 要把词表一起清掉", () => {
  fresh(FINANCE_PLUGIN);
  registerPlugin(FINANCE_PLUGIN);                       // 同一份:安静返回
  assert.throws(() => registerPlugin({ ...FINANCE_PLUGIN }), /不支持多垂类并存/);
  // 🔴 只清包不清词表的话,下一个包会在注册词表那步失败
  resetPlugin();
  registerPlugin({ ...FINANCE_PLUGIN });
  assert.equal(currentPlugin().id, "finance");
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);                        // 复原,不影响别的用例
});

test("未注册时读包直接抛错,不给静默默认值", () => {
  resetPlugin();
  assert.throws(() => currentPlugin(), /未注入插件/);
  registerPlugin(FINANCE_PLUGIN);
});

/* ---------- Codex domainpack-r2 的回归 ---------- */

test("每张嵌套表都只读一次:带 getter 的包不能「校验时一个值、建快照时另一个值」", () => {
  // 🔴 我一度只对 stageScripts 做了深层单读,其余五张表照旧二次读取 —— 同一个根因漏了五处
  for (const key of ["stageCalcs", "extraTopics", "semanticSlots", "stageLabels", "standardColumnLabels"] as const) {
    let n = 0;
    const evil: Record<string, unknown> = { ...(FINANCE_PLUGIN[key] as Record<string, unknown>) };
    const firstStage = FINANCE_PLUGIN.stages[0];
    const good = (FINANCE_PLUGIN[key] as Record<string, unknown>)[firstStage]
      ?? (FINANCE_PLUGIN[key] as Record<string, unknown>)[Object.keys(FINANCE_PLUGIN[key] as object)[0]];
    Object.defineProperty(evil, Object.keys(FINANCE_PLUGIN[key] as object)[0], {
      enumerable: true, get() { return n++ === 0 ? good : [12345]; },
    });
    resetPlugin();
    registerPlugin(plugin({ [key]: evil } as Partial<Plugin>));
    // 只读一次 ⇒ getter 只跑了一次,活动包里是"被校验过的那个值"
    assert.equal(n, 1, `${key} 被读了 ${n} 次`);
  }
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("selfTestCalc.args 必须是**普通对象**:Map / Date 展开后会静默变成 {}", () => {
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: new Map() as never, expect: 20 } }), /只能是 JSON 式的值/);
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: new Date() as never, expect: 20 } }), /只能是 JSON 式的值/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("关键脚本拼错要当场说:否则「关键脚本全失败 → failed」永远匹配不上(静默降级)", () => {
  rejects(plugin({ criticalScripts: ["fetch_quote", "fetch_finacials"] }),
    /criticalScripts 里的 fetch_finacials 没出现在任何阶段的取数计划里/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("非法表类型必须抛,不能被吞成空表(那等于绕过整个注册期校验)", () => {
  // 🔴 我上一轮的 entriesOnce 对 Map / Date / 字符串一律返回 [] ——
  //    没有阶段穷尽检查的那几张表就"空表通过"了(Codex domainpack-r3)
  for (const key of ["semanticSlots", "topicSections", "standardColumnLabels"] as const) {
    rejects(plugin({ [key]: new Map() } as Partial<Plugin>), new RegExp(`${key} 必须是普通对象`));
    rejects(plugin({ [key]: new Date() } as Partial<Plugin>), new RegExp(`${key} 必须是普通对象`));
  }
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("嵌套数组在**摄入时**就拷贝:带索引 getter 的数组骗不到快照", () => {
  let n = 0;
  const sneaky: unknown[] = [];
  Object.defineProperty(sneaky, "0", { enumerable: true, configurable: true, get: () => (++n < 2 ? "fetch_profile" : { injected: true }) });
  Object.defineProperty(sneaky, "length", { value: 1, writable: true });
  const p = plugin({ stageScripts: { ...FINANCE_PLUGIN.stageScripts, report: { required: sneaky as string[], optional: [] } } });
  resetPlugin();
  registerPlugin(p);
  assert.deepEqual([...currentPlugin().stageScripts.report.required], ["fetch_profile"]);   // 是被校验过的那个值
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("槽位与自检入参要**深**冻结:只冻第一层的话内层仍是共享可变引用", () => {
  const slot = { fn: "x", selector: { field: "revenue" } };
  const args = { input: { value: 1 } };
  const p = plugin({ semanticSlots: { profile: [slot] }, selfTestCalc: { fn: "forward_pe", args, expect: 20 } });
  resetPlugin();
  registerPlugin(p);
  slot.selector.field = "profit";
  args.input.value = 999;
  assert.equal((currentPlugin().semanticSlots.profile[0] as typeof slot).selector.field, "revenue");
  assert.equal((currentPlugin().selfTestCalc!.args as typeof args).input.value, 1);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("topicSections 的议题必须是已声明的(值是**扩展章节**,不能拿 reportSections 校验)", () => {
  rejects(plugin({ topicSections: { ...FINANCE_PLUGIN.topicSections, 拼错的议题: "资金与市场行为" } }),
    /topicSections 里的议题 拼错的议题 没有出现在任何阶段的 extraTopics 里/);
  // 值是扩展章节名,本来就不在 reportSections 里 —— 照字面查会把正确配置全判错
  fresh(FINANCE_PLUGIN);
  assert.ok(!currentPlugin().reportSections.includes(currentPlugin().topicSections["资金行为"]));
});

test("槽位与自检入参只接受 JSON 式的值:Map / Set / Date 会被拒(它们没法真的深冻结)", () => {
  // 🔴 原样返回的话它们是**共享可变引用**,注册后 shared.set(…) 就能改掉已生效的配置
  const shared = new Map([["field", "revenue"]]);
  rejects(plugin({ semanticSlots: { profile: [{ selector: shared }] } }), /只能是 JSON 式的值/);
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: { options: new Set() } as never, expect: 20 } }), /只能是 JSON 式的值/);
  rejects(plugin({ semanticSlots: { profile: [{ at: new Date() }] } }), /只能是 JSON 式的值/);
  // 正当的纯数据配置照旧通过
  resetPlugin();
  registerPlugin(plugin({ semanticSlots: { profile: [{ fn: "x", fields: ["a", "b"], n: 1, ok: true, none: null }] } }));
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("undefined / NaN / Infinity 不是 JSON 值:序列化后与快照对不上", () => {
  // 🔴 JSON.stringify({price: NaN, x: undefined}) → {"price":null} —— 快照一个值,CLI 收到另一个
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: { price: NaN }, expect: 20 } }), /不能是 NaN \/ Infinity/);
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: { price: undefined }, expect: 20 } }), /不能是 undefined/);
  rejects(plugin({ semanticSlots: { profile: [{ n: Infinity }] } }), /不能是 NaN \/ Infinity/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("__proto__ 不会污染快照:深拷贝用 Object.create(null) 建对象", () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  resetPlugin();
  registerPlugin(plugin({ selfTestCalc: { fn: "forward_pe", args: polluted, expect: 20 } }));
  const args = currentPlugin().selfTestCalc!.args as Record<string, unknown>;
  // `__proto__` 成了普通自有属性,而不是把原型改掉
  assert.ok(Object.prototype.hasOwnProperty.call(args, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("稀疏数组要拒:.map() 跳过空洞,而 JSON.stringify 会把空洞写成 null", () => {
  rejects(plugin({ selfTestCalc: { fn: "forward_pe", args: { values: new Array(1) as never }, expect: 20 } }),
    /是数组空洞/);
  const sparse: unknown[] = [1]; sparse[2] = 3;          // [1, <空>, 3]
  rejects(plugin({ semanticSlots: { profile: [{ xs: sparse }] } }), /是数组空洞/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("字符串必须 trim 后非空:ajv 的 minLength:1 会放行纯空格(迁移时差点丢了这条)", () => {
  // 🔴 旧的手写校验用的是 `trim() !== ""`;只写 minLength:1 是**比原来松**
  rejects(plugin({ id: "   " }), /不符契约/);
  rejects(plugin({ stageLabels: { ...FINANCE_PLUGIN.stageLabels, profile: "  " } }), /不符契约/);
  rejects(plugin({ alertFields: [...FINANCE_PLUGIN.alertFields, " "] }), /不符契约/);
  rejects(plugin({ selfTestCalc: { fn: " ", args: {}, expect: 20 } }), /不符契约/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

/* ---------- Codex ajv-r1 的回归 ---------- */

test("函数插槽也只读一次:带 getter 的插件不能「先给函数、再给字符串」", () => {
  let n = 0;
  const evil = { ...FINANCE_PLUGIN } as Record<string, unknown>;
  Object.defineProperty(evil, "quoteDecision", {
    enumerable: true,
    get() { return ++n === 1 ? FINANCE_PLUGIN.quoteDecision : "not-a-function"; },
  });
  resetPlugin();
  registerPlugin(evil as never);
  assert.equal(n, 1);
  assert.equal(typeof currentPlugin().quoteDecision, "function");
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("契约之外的字段要当场说:ajv 看不到被投影丢掉的那些", () => {
  // 🔴 我在注释里写过"多写一个字段就当场说",但 ajv 校验的是投影出来的 decl —— 那句话原本是假的
  rejects({ ...FINANCE_PLUGIN, typoField: "x" } as never, /有契约之外的字段:typoField/);
  rejects(plugin({ evidence: { ...FINANCE_PLUGIN.evidence, marketWideCode: ["US"] } } as never),
    /evidence 有契约之外的字段:marketWideCode/);
  rejects(plugin({ selfTestCalc: { ...FINANCE_PLUGIN.selfTestCalc, typo: true } } as never),
    /selfTestCalc 有契约之外的字段:typo/);
  rejects(plugin({ stageScripts: { ...FINANCE_PLUGIN.stageScripts, report: { required: [], optional: [], typo: [] } } } as never),
    /stageScripts\.report 有契约之外的字段:typo/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("__proto__ 之类的键要拒:写进普通对象会被静默吞掉,让整条配置凭空消失", () => {
  for (const table of ["semanticSlots", "topicSections", "stageLabels"] as const) {
    rejects(plugin({ [table]: JSON.parse('{"__proto__": []}') } as never), /不许用 __proto__ 作键/);
  }
  rejects(plugin({ stageCalcs: JSON.parse('{"constructor": []}') } as never), /不许用 constructor 作键/);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("stageScripts 也只读一次:多余字段检查与投影共用同一份(同一根因犯到第三次)", () => {
  let n = 0;
  const evil = { ...FINANCE_PLUGIN } as Record<string, unknown>;
  Object.defineProperty(evil, "stageScripts", {
    enumerable: true,
    get() { return ++n === 1 ? FINANCE_PLUGIN.stageScripts : { report: { required: [], optional: [], typo: [] } }; },
  });
  resetPlugin();
  registerPlugin(evil as never);
  assert.equal(n, 1);
  assert.deepEqual([...currentPlugin().stageScripts.profile.required], [...FINANCE_PLUGIN.stageScripts.profile.required]);
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("archive:区块参数、阶段引用与 tail 由 schema + 关系检查一起管住", () => {
  const arch = FINANCE_PLUGIN.archive;
  const withArch = (over: Partial<Plugin["archive"]>) => plugin({ archive: { ...arch, ...over } });
  const sec = (blocks: unknown[]) => [{ title: "X", tail: true, blocks }] as never;

  // 形状:未知 kind / 缺必填参数 / 多余字段 —— 判别式 union 让报错定位到具体那种区块
  rejects(withArch({ sections: sec([{ kind: "没有这种区块" }]) }), /kind|oneOf/);
  rejects(withArch({ sections: sec([{ kind: "stageSummary" }]) }), /stage/);
  rejects(withArch({ sections: sec([{ kind: "evidenceTable", stage: "profile" }]) }), /additional|properties/i);
  rejects(withArch({ sections: sec([]) }), /minItems|fewer than 1/i);

  // 关系:区块引用的阶段必须真的存在(拼错阶段名在渲染期只会静默出"(无)")
  rejects(withArch({ sections: sec([{ kind: "conclusions", stage: "risk_打错了" }]) }),
    /archive[\s\S]*引用了不存在的阶段 risk_打错了/);
  rejects(withArch({ sections: sec([{ kind: "stageSummaries", stages: ["profile", "不存在"] }]) }),
    /archive[\s\S]*引用了不存在的阶段 不存在/);
  rejects(withArch({ sections: sec([{ kind: "evidenceTable", stages: ["不存在"] }]) }),
    /archive[\s\S]*引用了不存在的阶段 不存在/);

  // 至少一节 tail:否则召回截断时尾部保护整个失效(而且是静默失效)
  rejects(withArch({ sections: arch.sections.map((s) => ({ ...s, tail: false })) as never }), /tail: true/);
  // tail 必须是连续后缀:中间夹一个 tail,截断会把它后面的普通章节一起当尾部保护(不报错)
  rejects(withArch({ sections: [{ title: "A", tail: true, blocks: [{ kind: "gaps" }] }, { title: "B", blocks: [{ kind: "gaps" }] }] as never }),
    /tail 章节必须是连续的结尾几节/);
  rejects(withArch({ sections: [{ title: "A", tail: true, blocks: [{ kind: "gaps" }] }, { title: "B", tail: false, blocks: [{ kind: "gaps" }] }, { title: "C", tail: true, blocks: [{ kind: "gaps" }] }] as never }),
    /tail 章节必须是连续的结尾几节/);
  // 合法:tail 在最后连着
  fresh(withArch({ sections: [{ title: "A", blocks: [{ kind: "gaps" }] }, { title: "B", tail: true, blocks: [{ kind: "gaps" }] }, { title: "C", tail: true, blocks: [{ kind: "gaps" }] }] as never }));

  // 数值上下限:1e100 也是合法 integer,不设上限的话 recallKnowledge 会抛 RangeError(Codex archive-r1)
  rejects(withArch({ validDays: 0 }), /validDays|minimum|>=/i);
  rejects(withArch({ maxFacts: 0 }), /maxFacts|minimum|>=/i);
  rejects(withArch({ validDays: 1e100 }), /validDays|maximum|<=/i);
  rejects(withArch({ maxFacts: 1e100 }), /maxFacts|maximum|<=/i);
  rejects(withArch({ validDays: 3651 }), /validDays|maximum|<=/i);

  // 多写一个字段当场说(ajv 校验的是投影,靠 assertNoExtraKeys 比对原对象)
  rejects(plugin({ archive: { ...arch, 手滑多写的字段: 1 } as never }), /archive[\s\S]*手滑多写的字段/);

  fresh(FINANCE_PLUGIN);
  assert.ok(currentPlugin().archive.sections.some((s) => s.tail), "金融包必须有 tail 章节");
  assert.throws(() => { (currentPlugin().archive.sections as unknown[]).push({} as never); }, /read only|frozen|extensible/i);
});

test("台账种类名:注册期必须挡住路径穿越与原型污染名(实测过 ajv propertyNames 真的生效)", () => {
  // 🔴 这条是被 Codex 审计逼出来的:它说"白名单只证明字符串是插件对象的键,不证明是安全文件名"。
  //    实测下来注册期确实挡住了,但**保证必须由代码钉死**,不能靠"另一处应该管住了"。
  const bad = ["../../config", "..", "a/b", "a\\b", "__proto__", "constructor", "prototype", "A", "", "x".repeat(40), "a.b", "with space"];
  for (const k of bad) {
    resetPlugin();
    assert.throws(
      () => registerPlugin({ ...FINANCE_PLUGIN, ledger: { kinds: { [k]: { label: "x", properties: {}, required: [] } } } } as never),
      `种类名 ${JSON.stringify(k)} 必须被拒`,
    );
  }
  resetPlugin();
  registerPlugin(FINANCE_PLUGIN);
});

test("🔴 stageSchemas 与 ledger 是**同一根因**的两个编译点:未知 format 两边都要拒", () => {
  const st = FINANCE_PLUGIN.stages[0]!;
  // ledger 那处上一轮已修;这次确认兄弟编译点没被漏下(漏一处 = 那一半静默不校验)
  rejects(
    plugin({ stageSchemas: { ...FINANCE_PLUGIN.stageSchemas, [st]: { properties: { d: { type: "string", format: "email" } }, required: [] } } }),
    /不认识的 format/,
  );
  // 认识的照过 —— 不是把 format 一律关死
  fresh(plugin({ stageSchemas: { ...FINANCE_PLUGIN.stageSchemas, [st]: { properties: { d: { type: "string", format: "date" } }, required: [] } } }));
  fresh(FINANCE_PLUGIN);
});

/* ===== 可选槽位的投影完整性（2026-08-27） ===== */

test("🔴 schema 里声明、垂类也设了的槽位，必须都活到 currentPlugin()", () => {
  // 加一个可选槽位要动**四处**：schema properties / 键集白名单 /
  // 注册期的 decl 投影 / currentPlugin() 的返回投影。
  // 真踩过：加 tools 时前两处改了、后两处漏了 —— 注册通过、测试全绿，
  // 但 `currentPlugin().tools` 是 undefined，界面上表现为「工具清单是空的」，
  // **没有任何一层报错**。这条就是钉这个的。
  const declared = Object.keys(
    (PLUGIN_SCHEMA as { properties: Record<string, unknown> }).properties,
  );
  const pack = currentPlugin() as unknown as Record<string, unknown>;
  const src = FINANCE_PLUGIN as unknown as Record<string, unknown>;
  const lost = declared.filter((k) => src[k] !== undefined && pack[k] === undefined);
  assert.deepEqual(lost, [],
    `这些槽位垂类声明了、却没活到 currentPlugin()（多半漏了某处投影）：${lost.join(" / ")}`);
});

/* ===== 辩论深度档位（2026-08-27 实测挖出来的） ===== */

test("🔴 界面上的深度档位必须真的少跑阶段", () => {
  // 原来那个「一轮 / 两轮」下拉框是**装饰性的**：适配层把参数命名成 `_rounds`
  // （下划线 = 声明我不用它），于是选了没有任何效果、永远跑完整五阶段，
  // 而旁边的耗时提示还跟着档位变 —— 告诉你 100 秒 / 3 次调用，实际 6 分钟 / 5 次。
  const d = currentPlugin().debate;
  assert.ok(d?.depths, "垂类没声明深度档位");
  const one = d!.depths!["1"]!;
  const two = d!.depths!["2"]!;
  assert.ok(one.length < two.length, "一轮必须比两轮少跑阶段，否则档位没有意义");
  assert.ok(!one.includes("bull_rebut") && !one.includes("bear_rebut"), "一轮不该有交叉反驳");
  assert.equal(two.length, d!.stages.length, "两轮应当覆盖全部阶段");
});

test("深度档位里的阶段 id 必须真实存在", () => {
  const d = currentPlugin().debate!;
  const ids = d.stages.map((s) => s.id);
  for (const [depth, list] of Object.entries(d.depths ?? {})) {
    for (const id of list) assert.ok(ids.includes(id), `档位 ${depth} 里的 ${id} 不是真实阶段`);
  }
});

test("每个档位都要有裁判（少了它就只剩两段各说各话）", () => {
  const d = currentPlugin().debate!;
  // 最后一个阶段（sees 最多的那个）就是裁判
  const referee = d.stages[d.stages.length - 1]!.id;
  for (const [depth, list] of Object.entries(d.depths ?? {})) {
    assert.ok(list.includes(referee), `档位 ${depth} 少了裁判 ${referee}`);
  }
});
