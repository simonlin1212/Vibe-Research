import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { chatStream } from "../src/verticals/finance/lib/llm.ts";
import { backend } from "../src/verticals/finance/lib/backend.ts";

test("全球指数失败进入可见状态与 AI 摘要，不静默消失", async () => {
  const text = fs.readFileSync(new URL("../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("DailyReview.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Map<string, ts.Expression>();
  function visit(n: ts.Node): void {
    if (ts.isVariableDeclaration(n) && n.initializer) expressions.set(n.name.getText(source), n.initializer);
    ts.forEachChild(n, visit);
  }
  visit(source);
  const compile = (name: string) => ts.transpileModule(`(${expressions.get(name)!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let globalErr: string | null = null;
  let globalDone = false;
  const noop = () => {};
  vm.runInNewContext(compile("loadIndices"), {
    Error,
    api: { indices: async () => [], globalIndices: async () => { throw new Error("全球指数未接入"); },
      emotion: async () => null, turnoverTop: async () => null, marketOverview: async () => null },
    backend: { page: async () => ({ blocks: [] }) },
    setIndices: noop, setIdxErr: noop, setGlobalIdx: noop,
    setGlobalDone: (v: boolean) => { globalDone = v; }, setGlobalErr: (v: string | null) => { globalErr = v; },
    setEmotion: noop, setEmoDone: noop, setTurnover: noop, setToDone: noop,
    setPageErr: noop, setPageMeta: noop, setOverview: noop, setOvDone: noop,
  })();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalDone, true);
  assert.match(globalErr!, /全球指数未接入/);
  const summary = vm.runInNewContext(compile("dataSummary"), {
    pageMeta: null, indices: [], globalIdx: [], globalErr, globalDone,
    sentiment: null, sentCells: [], emotion: null, sectors: [], turnover: null,
  });
  assert.match(summary, /【海外指数】.*未接入/);
  assert.doesNotMatch(text, /globalIdx\.length > 0 &&/, "面板不再以有数据为显示前提");
});

test("复盘按钮通过真实 chatStream 发出一次页面数据，并保留业务日、缺口与读法", async () => {
  // 执行页面本身的回调，避免在测试中重抄一份提示词而掩盖调用方回归。
  const source = ts.createSourceFile("DailyReview.tsx", fs.readFileSync(new URL(
    "../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runReview" && node.initializer) callbacks.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(callbacks.length, 1);
  const compiled = ts.transpileModule(`(${callbacks[0]!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const summary = "业务日：2026-09-04\n上涨：1234家\n【缺口】资金流未取到\n【读法·行情】样本范围受限";
  const messages: string[] = [];
  const errors: unknown[] = [];
  const loading: boolean[] = [];
  const original = backend.chat;
  backend.chat = async (message) => {
    messages.push(message);
    return { reply: "客观复盘", redacted: 0 } as Awaited<ReturnType<typeof backend.chat>>;
  };
  try {
    const run = vm.runInNewContext(compiled, {
      dataSummary: summary, hasLlm: () => true, chatStream,
      setReviewErr: (error: unknown) => errors.push(error), setNeedConfig: () => {},
      setReviewLoading: (value: boolean) => loading.push(value), setReview: () => {},
    }) as () => Promise<void>;
    await run();
    assert.deepEqual(errors, [null]);
    assert.deepEqual(loading, [true, false]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.split(summary).length - 1, 1, "页面摘要在最终消息里只能出现一次");
    assert.match(messages[0]!, /不要就它下任何结论/);
    assert.match(messages[0]!, /引用数字时带上它的读法护栏/);
  } finally { backend.chat = original; }
});
