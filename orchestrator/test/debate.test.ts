import assert from "node:assert/strict";
import { test } from "node:test";

import "../src/finance/register.ts";
import { DebateError, advanceDebate, getDebate, renderDossier, resetDebates, startDebate, type ChatFn } from "../src/debate.ts";
import { currentPlugin } from "../src/plugin.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatError, chatSend } from "../src/chat.ts";

const ENV = (evidence: Record<string, unknown>[]) => ({ script: "t", evidence });

for (const agent of ["claude", "codebuddy"] as const) {
  test(`${agent} 经真实聊天路由跑完五阶段辩论，不混用来源`, async (t) => {
    resetDebates();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-debate-local-"));
    t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
    const opts = { repoRoot: fileURLToPath(new URL("../../", import.meta.url)), dataRoot };
    const id = `local-${agent}`;
    startDebate({ id, symbol: "300308", sourceFingerprint: agent,
      envelopes: [ENV([{ id: "ev-test", field: "sample", value: 1 }])], gaps: ["合成测试，不代表真实行情"] });
    let count = 0;
    for (let i = 0; i < 5; i++) {
      const state = await advanceDebate(opts, { id, sourceFingerprint: agent }, async (message, session, signal) =>
        (await chatSend({ ...opts, signal, persistent: false, localAgentRunner: async (actual, local) => {
          assert.equal(actual, agent);
          assert.equal(local.controlledMcp, undefined);
          assert.match(local.userPrompt, /合成测试/);
          count += 1;
          return `第 ${count} 段：证据不足，需继续核实。`;
        } }, { message, session, llm: { provider: `cli-${agent}` } })).reply);
      assert.equal(state.stages[i]!.status, "done");
    }
    assert.equal(count, 5);
    assert.equal(getDebate(id)?.outcome, "completed");
  });
}

test("同名辩论不能覆盖在途状态，取消丢弃晚到结果并终止剩余阶段", async () => {
  resetDebates();
  const req = { id: "d-cancel", symbol: "300308", envelopes: [ENV([{ id: "ev-a", field: "value", value: 1 }])], gaps: [] };
  startDebate(req);
  const ctrl = new AbortController();
  let release!: (value: string) => void;
  let observed: AbortSignal | undefined;
  const run = advanceDebate({ repoRoot: process.cwd(), signal: ctrl.signal }, { id: req.id }, async (_m, _s, signal) => {
    observed = signal;
    return await new Promise<string>(resolve => { release = resolve; });
  });
  try {
    assert.throws(() => startDebate(req), (e: unknown) => e instanceof DebateError && e.code === "debate_exists");
    assert.equal(getDebate(req.id)?.stages[0]?.status, "running");
    assert.equal(observed, ctrl.signal);
  } finally { ctrl.abort(); release("这个晚到结果不得接受"); }
  const end = await run;
  assert.equal(end.done, true);
  assert.equal(end.outcome, "cancelled");
  assert.ok(end.stages.every(s => s.status === "cancelled" && !s.text));
  assert.deepEqual(getDebate(req.id), end);
  const unchanged = await advanceDebate({ repoRoot: process.cwd() }, { id: req.id }, async () => { throw new Error("取消后不能再调模型"); });
  assert.deepEqual(unchanged, end);
});

test("辩论取消保留已完成阶段；提前取消不占用阶段", async () => {
  resetDebates();
  const id = "d-partial-cancel";
  startDebate({ id, symbol: "300308", envelopes: [ENV([{ value: 1 }])], gaps: [] });
  await assert.rejects(advanceDebate({ repoRoot: process.cwd(), signal: AbortSignal.abort() }, { id }, async () => "不该调用"),
    (e: unknown) => e instanceof DebateError && e.code === "cancelled");
  assert.equal(getDebate(id)?.stages[0]?.status, "pending");
  await advanceDebate({ repoRoot: process.cwd() }, { id }, async () => "已完成的内容");
  const ctrl = new AbortController();
  const end = await advanceDebate({ repoRoot: process.cwd(), signal: ctrl.signal }, { id }, async (_m, _s, signal) => {
    assert.equal(signal, ctrl.signal);
    ctrl.abort();
    throw new Error("模拟底层响应取消");
  });
  assert.equal(end.outcome, "cancelled");
  assert.equal(end.stages[0]?.status, "done");
  assert.equal(end.stages[0]?.text, "已完成的内容");
  assert.ok(end.stages.slice(1).every(s => s.status === "cancelled"));
});

test("底层停止未确认不得升级为已取消，余下阶段失败且不能继续调用模型", async () => {
  for (const completed of [0, 1]) {
    resetDebates();
    const id = `shutdown-failed-${completed}`;
    const opts = { repoRoot: process.cwd() };
    startDebate({ id, symbol: "300308", envelopes: [ENV([{ value: 1 }])], gaps: [] });
    if (completed) await advanceDebate(opts, { id }, async () => "已经完成的正文");
    const ac = new AbortController();
    const end = await advanceDebate({ ...opts, signal: ac.signal }, { id }, async () => {
      ac.abort();
      throw new ChatError("agent_shutdown_failed", "未能确认本地 Agent 进程已退出");
    });
    assert.equal(end.outcome, "failed");
    assert.equal(end.done, true, "流程不再推进，不代表底层进程已经停止");
    assert.ok(end.stages.slice(completed).every(x => x.status === "failed" && x.error?.includes("agent_shutdown_failed")));
    if (completed) assert.equal(end.stages[0]?.text, "已经完成的正文");
    assert.deepEqual(await advanceDebate(opts, { id }, async () => { throw new Error("不能继续调用"); }), end);
  }
});

test("资料包:带上单位、资料期、证据 id 与读法护栏", () => {
  const { text, count } = renderDossier([
    ENV([{ id: "ev-1", field: "price", value: 100, unit: "元", period: "2026-08-26", note: "读法:全市场定价" }]),
  ]);
  assert.equal(count, 1);
  assert.match(text, /price = 100元 \(2026-08-26\) \[ev-1\]/);
  assert.match(text, /读法:全市场定价/, "护栏必须跟着数字一起进资料包 —— 只给数字不给读法 = 让双方各自脑补口径");
});

test("n/a 之类的类型标记不当单位贴在数字后面", () => {
  const { text } = renderDossier([ENV([{ id: "ev-2", field: "name", value: "某公司", unit: "text", period: "2026-08-26" }])]);
  assert.match(text, /name = 某公司 \(/, text);
});

test("🔴 资料包为空时拒绝开场 —— 没有共同事实的辩论只是两段作文", () => {
  resetDebates();
  assert.throws(
    () => startDebate({ id: "d-empty", symbol: "300308", envelopes: [ENV([])], gaps: ["全挂了"] }),
    (e: unknown) => e instanceof DebateError && e.code === "no_dossier",
  );
});

test("开场后阶段按契约排好、全部 pending;gaps 原样带着", () => {
  resetDebates();
  const st = startDebate({
    id: "d1",
    symbol: "300308",
    envelopes: [ENV([{ id: "ev-3", field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
    gaps: ["indicators_cn:取数失败"],
  });
  assert.equal(st.evidence_count, 1);
  assert.deepEqual(st.gaps, ["indicators_cn:取数失败"]);
  assert.deepEqual(
    st.stages.map((x) => x.status),
    st.stages.map(() => "pending"),
  );
  assert.equal(st.done, false);
  // 对外投影不带资料包原文
  assert.equal((getDebate("d1") as unknown as Record<string, unknown>).dossier, undefined);
});

test("🔴 一场辩论开始后不许中途换 AI 来源", async () => {
  resetDebates();
  startDebate({
    id: "d-source",
    symbol: "300308",
    envelopes: [ENV([{ id: "ev-source", field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
    gaps: [],
    sourceFingerprint: "source-a",
  });
  await assert.rejects(
    () => advanceDebate({ repoRoot: process.cwd() }, { id: "d-source", sourceFingerprint: "source-b" }, async () => "不应执行"),
    (e: unknown) => e instanceof DebateError && e.code === "debate_source_changed",
  );
  assert.equal(getDebate("d-source")?.stages[0]?.status, "pending", "换源被拒后不得占用或改写阶段");
  const continued = await advanceDebate(
    { repoRoot: process.cwd() },
    { id: "d-source", sourceFingerprint: "source-a" },
    async () => "多方论据…",
  );
  assert.equal(continued.stages[0]?.status, "done", "原 AI 来源仍能正常继续");
});

test("🔴 契约:sees 只能指向排在自己前面的阶段", () => {
  // 指向后面的阶段永远读不到内容,而产出照样是一篇像样的文章 —— 看不出这一环是瞎写的
  const stages = currentPlugin().debate!.stages;
  const seen: string[] = [];
  for (const st of stages) {
    for (const ref of st.sees) assert.ok(seen.includes(ref), `${st.id}.sees 指向了还没跑的 ${ref}`);
    seen.push(st.id);
  }
  // 多方陈述与空方陈述必须**互相看不见**:同时看得见就不是独立立论了
  const bull = stages.find((x) => x.id === "bull");
  const bear = stages.find((x) => x.id === "bear");
  assert.deepEqual(bull?.sees, [], "多方陈述阶段不该看到任何前置产出");
  assert.deepEqual(bear?.sees, [], "空方陈述阶段不该看到任何前置产出");
});

test("裁判要看得到四段全部 —— 少看一段就成了偏听", () => {
  const ref = currentPlugin().debate!.stages.find((x) => x.id === "referee");
  assert.deepEqual([...(ref?.sees ?? [])].sort(), ["bear", "bear_rebut", "bull", "bull_rebut"]);
});

/**
 * 🔴 并发推进同一场辩论必须被拒。
 * 触发场景:双击"下一阶段"、客户端自动重试、两个页面同时开着 ——
 * 两个请求都读到同一个 pending 阶段,**各打一次模型(双倍花费)**,
 * 后回来的覆盖先回来的,后续阶段看到哪一版取决于谁先完成。
 * ⚠️ 用真的并发跑(两个 promise 同时在飞),不是顺序调两次 —— 顺序调根本不会重现。
 */
test("同一场辩论不许被并发推进", async () => {
  resetDebates();
  startDebate({
    id: "d-race",
    symbol: "300308",
    envelopes: [ENV([{ id: "ev-9", field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
    gaps: [],
  });
  // chatSend 会去打真模型 —— 这里只要证明**第二个请求在第一个还没回来时被拒**,
  // 所以给一个必然失败但会 await 的环境即可:两个都进来的话,第二个不会是 debate_busy。
  const opts = { repoRoot: process.cwd() };
  // 🔴 注入假 chat:单测不该真去起引擎 —— 慢,而且在并发跑测试时会 EPIPE(实测)
  // 慢一点才撞得上:第一个还挂在 await 里时,第二个进来必须被拒
  const slow: ChatFn = () => new Promise((r) => setTimeout(() => r("多方论据…"), 120));
  const a = advanceDebate(opts, { id: "d-race" }, slow);
  const b = advanceDebate(opts, { id: "d-race" }, slow).then(
    () => "no-error",
    (e: unknown) => (e instanceof DebateError ? e.code : `other:${String(e)}`),
  );
  const [, second] = await Promise.all([a.catch(() => null), b]);
  assert.equal(second, "debate_busy", "第二个并发请求必须被拒,否则同一阶段会被打两次模型");
});

test("🔴 容量满时淘汰空闲的那场,但**在跑的**必须留下", async () => {
  resetDebates();
  const mk = (id: string) =>
    startDebate({
      id,
      symbol: "300308",
      envelopes: [ENV([{ id: `ev-${id}`, field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
      gaps: [],
    });
  // 最旧的那场让它进入 running(chatSend 会失败,但在失败前它是 busy 的)
  mk("d-busy");
  const slow: ChatFn = () => new Promise((r) => setTimeout(() => r("…"), 200));
  const running = advanceDebate({ repoRoot: process.cwd() }, { id: "d-busy" }, slow).catch(() => null);
  // 填到容量上限:必须真的填满,否则淘汰逻辑根本不会被触发 ——
  // ⚠️ 上一版这个测试只开了 2 场就断言"没被淘汰",**它测的根本不是淘汰**(变异掉守卫仍然绿)。
  for (let i = 0; i < 25; i++) mk(`d-filler-${i}`);
  assert.ok(getDebate("d-busy"), "在跑的那一场被淘汰了 —— 调用回来会写进一个已经不在表里的对象");
  assert.equal(getDebate("d-filler-0"), null, "空闲的老场次应该被淘汰掉(不然容量上限形同虚设)");
  await running;
});

/**
 * 🔴 阶段失败后**不许留在 running**。
 * 触发场景:模型调用抛异常(鉴权挂了 / 超时)。若 `running` 没被收回,
 * 这一场从此每次 advance 都撞 `debate_busy` —— **自己把自己锁死**,而且看不出为什么。
 */
test("阶段失败后能继续推进下一个(不会卡在 running)", async () => {
  resetDebates();
  startDebate({
    id: "d-stuck",
    symbol: "300308",
    envelopes: [ENV([{ id: "ev-s", field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
    gaps: [],
  });
  const opts = { repoRoot: process.cwd() };
  // 🔴 注入假 chat:单测不该真去起引擎 —— 慢,而且在并发跑测试时会 EPIPE(实测)
  const boom: ChatFn = () => Promise.reject(new Error("测试用:模型不可用"));
  // 第一次:chatSend 会失败(测试环境没有可用模型)→ 该阶段标 failed
  const a = await advanceDebate(opts, { id: "d-stuck" }, boom);
  assert.equal(a.stages[0]!.status, "failed", JSON.stringify(a.stages[0]));
  assert.equal(a.stages.some((x) => x.status === "running"), false, "失败之后不能有阶段还挂在 running");
  // 第二次:必须能进到下一个阶段,而不是撞 debate_busy
  const b = await advanceDebate(opts, { id: "d-stuck" }, boom);
  assert.equal(b.stages[1]!.status, "failed", "第二个阶段应该被推进过(而不是整场卡死)");
});

/**
 * 🔴 `done` 只说"跑完了",不说"跑成了"。
 * 全部阶段都失败时 done 也是 true —— 界面只看 done 会把"五段全空"显示成"辩论正常完成"。
 */
test("全部失败时 outcome=failed,而 done 仍是 true", async () => {
  resetDebates();
  startDebate({
    id: "d-allfail",
    symbol: "300308",
    envelopes: [ENV([{ id: "ev-f", field: "price", value: 1, unit: "元", period: "2026-08-26" }])],
    gaps: [],
  });
  const opts = { repoRoot: process.cwd() };
  // 🔴 注入假 chat:单测不该真去起引擎 —— 慢,而且在并发跑测试时会 EPIPE(实测)
  const boom: ChatFn = () => Promise.reject(new Error("测试用:模型不可用"));
  let st = await advanceDebate(opts, { id: "d-allfail" }, boom);
  while (!st.done) st = await advanceDebate(opts, { id: "d-allfail" }, boom);
  assert.equal(st.done, true);
  assert.equal(st.outcome, "failed", "全挂了就必须说全挂了,不能因为 done=true 就当成功");
});
