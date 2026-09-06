import assert from "node:assert/strict";
import test from "node:test";
import { debateStream } from "../src/verticals/finance/lib/agents.ts";
import { ApiError, backend, friendlyAgentError, type DebateState } from "../src/verticals/finance/lib/backend.ts";
import { LLM_KEY } from "../src/verticals/finance/lib/llmStore.ts";

const pending = (): DebateState => ({ id: "fixture", symbol: "300308", evidence_count: 1, gaps: [], done: false, outcome: "running",
  stages: [{ id: "bull", label: "多方", status: "pending", text: "" }] });

test("辩论 HTTP 客户端真正向 fetch 传递信号，并保留重复编号的可操作提示", async () => {
  const originalFetch = globalThis.fetch;
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === LLM_KEY ? JSON.stringify({ provider: "cli-codex" }) : null,
  } });
  const signal = new AbortController().signal;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.signal, signal);
    paths.push(String(input));
    return new Response(JSON.stringify(pending()), { headers: { "Content-Type": "application/json" } });
  };
  try {
    await backend.debateStart("300308", "standard", signal);
    await backend.debateAdvance("fixture", signal);
    assert.deepEqual(paths, ["/api/debate", "/api/debate/fixture/advance"]);
    const message = "这个辩论编号已存在，请使用新的编号重开";
    assert.equal(friendlyAgentError(new ApiError(message, 409, "debate_exists")), message);
  } finally {
    globalThis.fetch = originalFetch;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("辩论提前取消不发请求；取数和阶段请求都传信号，晚到结果不回写页面", async () => {
  const start = backend.debateStart, advance = backend.debateAdvance;
  let requests = 0, emitted = 0;
  try {
    backend.debateStart = async () => { requests++; return pending(); };
    await debateStream("300308", 1, {}, AbortSignal.abort());
    assert.equal(requests, 0);

    for (const cancelAt of ["start", "advance"]) {
      const ctrl = new AbortController();
      backend.debateStart = async (_symbol, _depth, signal) => {
        assert.equal(signal, ctrl.signal); requests++;
        if (cancelAt === "start") ctrl.abort();
        return pending();
      };
      backend.debateAdvance = async (_id, signal) => {
        assert.equal(signal, ctrl.signal); requests++;
        ctrl.abort();
        return { ...pending(), done: true, outcome: "completed", stages: [{ id: "bull", label: "多方", status: "done", text: "晚到内容" }] };
      };
      const before = requests;
      const final = await debateStream("300308", 1, { onDelta: () => emitted++, onStageDone: () => emitted++, onError: () => emitted++ }, ctrl.signal);
      assert.equal(final, undefined);
      assert.equal(requests - before, cancelAt === "start" ? 1 : 2);
      assert.equal(emitted, 0);
    }
  } finally { backend.debateStart = start; backend.debateAdvance = advance; }
});

test("停止未确认时保留失败原因与已经完成的阶段，不误报全场没跑起来", async () => {
  const start = backend.debateStart, advance = backend.debateAdvance;
  const errors: string[] = [], completed: string[] = [];
  try {
    backend.debateStart = async () => pending();
    backend.debateAdvance = async () => ({ ...pending(), done: true, outcome: "failed", stages: [
      { id: "bull", label: "多方", status: "done", text: "已完成部分" },
      { id: "bear", label: "空方", status: "failed", text: "", error: "agent_shutdown_failed:进程树退出未确认，不能视为已取消" },
    ] });
    const result = await debateStream("300308", 1, {
      onError: message => errors.push(message), onStageDone: (_stage, _label, text) => completed.push(text),
    });
    assert.equal(result?.outcome, "failed");
    assert.deepEqual(completed, ["已完成部分"]);
    assert.match(errors.at(-1)!, /agent_shutdown_failed.*未确认/);
    assert.ok(errors.every(x => !x.includes("所有阶段都失败") && !x.includes("根本没跑起来")));
  } finally { backend.debateStart = start; backend.debateAdvance = advance; }
});
