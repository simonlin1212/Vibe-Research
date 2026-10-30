import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_MODEL_LIST, ModelListSession, guardModelOptions, type ModelListReply, type ModelListState } from "../src/verticals/finance/lib/modelList.ts";

const KEY = "sk-settings-fixture-0123456789";
const reply = (ids: string[], extra: Partial<ModelListReply> = {}): ModelListReply =>
  ({ models: ids.map((id) => ({ id, name: id })), url: "https://gw.example/v1/models", duration_ms: 120, ...extra });
const describe = (e: unknown) => ({ text: "获取失败", detail: e instanceof Error ? e.message : String(e) });

/** 一个由测试决定何时完成的请求:模拟"还在路上"的 GET /models */
function pending() {
  let resolve!: (r: ModelListReply) => void;
  let reject!: (e: unknown) => void;
  let signal!: AbortSignal;
  const request = (s: AbortSignal) => { signal = s; return new Promise<ModelListReply>((res, rej) => { resolve = res; reject = rej; }); };
  return { request, resolve: (r: ModelListReply) => resolve(r), reject: (e: unknown) => reject(e), signal: () => signal };
}

test("获取过程中点「忘记配置」:在途请求被取消,列表和提示清空;旧请求随后成功返回也不再显示", async () => {
  const seen: ModelListState[] = [];
  const s = new ModelListSession((st) => seen.push(st));
  const p = pending();
  const run = s.start(KEY, p.request, describe);
  assert.equal(s.state.loading, true);

  s.reset();                                     // 页面 forget() 调的就是它
  assert.equal(p.signal().aborted, true, "在途请求必须被取消");
  assert.deepEqual(s.state, EMPTY_MODEL_LIST, "列表与全部提示清空,也不再显示「正在获取」");

  const writes = seen.length;
  p.resolve(reply(["old-model-1", "old-model-2"]));  // 旧请求晚回来
  await run;
  assert.deepEqual(s.state, EMPTY_MODEL_LIST, "旧结果不得重新显示");
  assert.equal(seen.length, writes, "旧请求回来后不得再写状态");
});

test("获取过程中清除配置:旧请求随后失败返回,也不把报错重新显示出来", async () => {
  const s = new ModelListSession(() => {});
  const p = pending();
  const run = s.start(KEY, p.request, describe);
  s.reset();
  p.reject(new Error(`401 invalid key ${KEY}`));
  await run;
  assert.deepEqual(s.state, EMPTY_MODEL_LIST);
});

test("清除后重新获取:只显示新一轮的结果,前一轮晚到的结果被丢弃", async () => {
  const s = new ModelListSession(() => {});
  const first = pending();
  const run1 = s.start(KEY, first.request, describe);
  s.reset();
  const second = pending();
  const run2 = s.start("sk-new-key-abcdefghijklmn", second.request, describe);
  second.resolve(reply(["new-model"]));
  await run2;
  first.resolve(reply(["stale-model"]));
  await run1;
  assert.deepEqual(s.state.models?.map((m) => m.id), ["new-model"]);
  assert.equal(s.state.loading, false);
});

test("🔴 模型 id 回显本次 key 的整行隐藏(不改写成替身 id),名称回显 key 的脱敏,并提示隐藏了几个", async () => {
  const s = new ModelListSession(() => {});
  await s.start(KEY, async () => ({
    models: [
      { id: "good", name: "Good" },
      { id: `invalid_${KEY}`, name: "x" },
      { id: "named", name: `Echo ${KEY}` },
    ],
    hidden: 1,                                 // 后端已经隐藏了 1 个(通用密钥形态)
    url: "https://gw.example/v1/models", duration_ms: 50,
  }), describe);
  assert.deepEqual(s.state.models?.map((m) => m.id), ["good", "named"]);
  assert.ok(!JSON.stringify(s.state).includes(KEY), `状态里还有 key:${JSON.stringify(s.state)}`);
  assert.ok(!s.state.models!.some((m) => m.id.includes("***")), "不许生成被抹过的替身 id");
  assert.equal(s.state.models!.find((m) => m.id === "named")!.name, "Echo ***");
  assert.match(s.state.msg, /另有 2 个模型.*已隐藏/);
});

test("guardModelOptions:JSON 转义形态的 key 同样识别;没填 key 时原样返回", () => {
  const quoted = `${KEY}"q`;
  const esc = JSON.stringify(quoted).slice(1, -1);
  const g = guardModelOptions([{ id: `a-${esc}`, name: "a" }, { id: "b", name: `b ${esc}` }], quoted);
  assert.deepEqual(g.models, [{ id: "b", name: "b ***" }]);
  assert.equal(g.hidden, 1);
  assert.deepEqual(guardModelOptions([{ id: "x", name: "x" }], "  ").models, [{ id: "x", name: "x" }]);
});

test("全部模型都因含 key 被隐藏:按空列表报,不显示一个空的选择框", async () => {
  const s = new ModelListSession(() => {});
  await s.start(KEY, async () => reply([KEY]), describe);
  assert.equal(s.state.models, null);
  assert.match(s.state.err, /空的模型列表/);
  assert.match(s.state.detail, /另有 1 个模型/);
  assert.ok(!s.state.detail.includes(KEY));
});
