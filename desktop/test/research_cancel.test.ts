import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { backend, ApiError } from "../src/verticals/finance/lib/backend.ts";

function callback(page: string, name: string) {
  const source = ts.createSourceFile(page, fs.readFileSync(new URL(`../src/verticals/finance/pages/${page}.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) found.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(found.length, 1);
  return ts.transpileModule(`(${found[0]!.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test("取消接口独立于当前模型设置，只发送准确的运行编号", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/research/cancel");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), { run_id: "run-1" });
    return new Response(JSON.stringify({ run_id: "run-1", status: "cancelling", finished_at: null }));
  };
  try { assert.equal((await backend.cancelResearch("run-1")).status, "cancelling"); }
  finally { globalThis.fetch = original; }
});

test("研究页面取消后继续等待确认；晚到的另一次运行回包不覆盖当前页面", async () => {
  const original = backend.cancelResearch;
  let resolve: (value: never) => void = () => {};
  backend.cancelResearch = async () => new Promise((done) => { resolve = done; });
  const wanted = { current: "a" };
  const active: unknown[] = [], watched: string[] = [];
  const run = vm.runInNewContext(callback("Research", "cancel"), {
    active: { run_id: "a", status: "running" }, cancelling: false, backend, ApiError,
    watchGeneration: { current: 0 }, timer: { current: null }, window: { clearInterval: () => {} },
    wantRun: wanted, setCancelling: () => {}, setErr: () => {}, setActive: (st: unknown) => active.push(st), watch: (id: string) => watched.push(id),
  }) as () => Promise<void>;
  try {
    const first = run();
    resolve({ run_id: "a", status: "cancelling", finished_at: null } as never); await first;
    assert.equal((active[0] as { status: string }).status, "cancelling"); assert.deepEqual(watched, ["a"]);
    const second = run(); wanted.current = "b";
    resolve({ run_id: "a", status: "cancelled", finished_at: "now" } as never); await second;
    assert.equal(active.length, 1);
  } finally { backend.cancelResearch = original; }
});

test("研报材料页请求取消但不终止状态轮询，避免把请求当确认", async () => {
  const original = backend.cancelResearch;
  const controller = new AbortController();
  let notices = "";
  backend.cancelResearch = async () => ({ status: "cancelling", finished_at: null } as never);
  try {
    const run = vm.runInNewContext(callback("MyReports", "cancelDeep"), {
      deepRunId: "deep-1", cancelPending: false, taskAbortRef: { current: controller }, backend,
      setCancelPending: () => {}, setTaskNotice: (text: string) => { notices = text; },
      setTaskError: () => {}, friendlyAgentError: String,
    }) as () => Promise<void>;
    await run();
    assert.equal(controller.signal.aborted, false); assert.match(notices, /等待后台确认/);
  } finally { backend.cancelResearch = original; }
});

test("同一运行重开轮询时丢弃旧响应，已取消不会回退成正在取消", async () => {
  const intervals: (() => void)[] = [];
  const replies: ((status: unknown) => void)[] = [];
  const states: unknown[] = [];
  const context = {
    wantRun: { current: "a" }, watchGeneration: { current: 0 }, timer: { current: null },
    window: { setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} },
    backend: { researchStatus: () => new Promise((resolve) => replies.push(resolve)) }, ApiError,
    setWatchErr: () => {}, setActive: (st: unknown) => states.push(st), loadRuns: () => {},
  };
  const watch = vm.runInNewContext(callback("Research", "watch"), context) as (id: string) => void;
  watch("a"); intervals[0]!(); intervals[0]!();
  assert.equal(replies.length, 1, "同一代不能叠加请求");
  watch("a"); intervals[1]!();
  replies[1]!({ status: "cancelled", finished_at: "now" });
  await new Promise((r) => setImmediate(r));
  replies[0]!({ status: "cancelling", finished_at: null });
  await new Promise((r) => setImmediate(r));
  intervals[1]!();
  assert.deepEqual(states, [{ status: "cancelled", finished_at: "now" }]);
  assert.equal(replies.length, 2, "终态之后停止跟踪");
});
