import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import "../src/finance/register.ts";
import { GuidedToolError, guidedToolTurn, type GuidedToolDeps } from "../src/guided_tool.ts";
import { detectPython } from "../src/init.ts";
import { chatSend } from "../src/chat.ts";

const opts = { repoRoot: process.cwd(), dataRoot: process.cwd() };
const req = { name: "sample", label: "样例任务", session: "s1", message: "请验证这个想法" };

for (const agent of ["claude", "codebuddy"] as const) {
  test(`${agent} 经真实聊天路由引导工具，生成报告并保留强制披露`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-guided-local-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const replies = [model("ready"), model("complete")];
    const calls: unknown[] = [];
    const out = await guidedToolTurn({ repoRoot, dataRoot: root }, { ...req, llm: { provider: `cli-${agent}` } }, {
      chat: (o, r) => chatSend({ ...o, localAgentRunner: async (actual, local) => {
        assert.equal(actual, agent);
        assert.equal(local.controlledMcp, undefined, "模型只组参数，不自己跑计算或取数");
        assert.ok(local.outputSchema);
        assert.match(local.userPrompt, /真实能力说明/);
        if (replies.length === 1) {
          assert.match(local.userPrompt, /唯一可用的真实结果/);
          assert.match(local.userPrompt, /0.42/);
        }
        return replies.shift()!;
      } }, r),
      runTool: async (_name, body) => {
        calls.push(body);
        return (body as { action?: string }).action === "catalog" ? { ok: true, catalog: {} }
          : { ok: true, result: { score: 0.42, required_disclosures: ["仅为合成测试结果，不代表真实历史表现。"] } };
      },
    });
    assert.equal(out.status, "complete");
    assert.match(out.report!, /仅为合成测试结果/);
    assert.equal(calls.length, 2);
    assert.equal(replies.length, 0);
  });
}

function model(status: "needs_input" | "ready" | "complete", over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status,
    message: status === "needs_input" ? "还需要时间范围。" : status === "ready" ? "条件齐了，开始执行。" : "已经完成并形成报告。",
    title: status === "needs_input" ? "" : "验证主题",
    question: status === "needs_input" ? "" : "这个想法是否成立？",
    hypothesis: status === "needs_input" ? "" : "历史样本可以验证该想法。",
    logic: status === "needs_input" ? [] : ["按时间范围取样", "比较结果与基准"],
    tool_args_json: status === "ready" ? '{"start":"2020-01-01"}' : "",
    document: status === "complete" ? "## 核心结果\n\n真实工具返回显示验证完成。\n\n## 限制\n\n仅覆盖现有样本。" : "",
    ...over,
  });
}

test("首轮所有可见字段过检查；一次修正后只执行一次正式工具", async () => {
  const replies = [model("ready", { hypothesis: "建议建仓" }), model("ready"), model("complete")];
  const calls: unknown[] = [];
  const out = await guidedToolTurn(opts, req, {
    chat: async (o, r) => {
      if (replies.length === 2) assert.match(String(o.developerInstructions), /修正/);
      return { session: r.session!, reply: replies.shift()!, redacted: 0, duration_ms: 1 };
    },
    runTool: async (_name, body) => { calls.push(body); return { ok: true }; },
  });
  assert.equal(out.status, "complete");
  assert.equal(replies.length, 0);
  assert.equal(calls.length, 2, "能力查询一次，正式工具一次");
});

test("报告格式失败只修正模型输出，不重跑真实工具", async () => {
  const replies = [model("ready"), "不是 JSON", model("complete")];
  let toolCalls = 0;
  const out = await guidedToolTurn(opts, req, {
    chat: async () => ({ session: "x", reply: replies.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async () => { toolCalls++; return { ok: true }; },
  });
  assert.equal(out.status, "complete");
  assert.equal(toolCalls, 2);
});

for (const broken of ["非 JSON", model("ready", { title: "x".repeat(161) }),
  model("ready", { logic: ["建议建仓"] }), model("ready", { extra: "unexpected" })]) {
  test(`结构或边界连续两次失败明确拒绝，不执行工具 (${broken.slice(0, 30)})`, async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    await assert.rejects(() => guidedToolTurn(opts, req, {
      chat: async () => { modelCalls++; return { session: "x", reply: broken, redacted: 0, duration_ms: 1 }; },
      runTool: async () => { toolCalls++; return { ok: true }; },
    }), GuidedToolError);
    assert.equal(modelCalls, 2);
    assert.equal(toolCalls, 1);
  });
}

test("信息不足时只追问，不调用正式工具", async () => {
  const calls: unknown[] = [];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: model("needs_input"), redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => { calls.push(body); return { ok: true, catalog: { choices: ["a"] } }; },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.deepEqual(out, { status: "needs_input", message: "还需要时间范围。" });
  assert.deepEqual(calls, [{ action: "catalog" }], "不能在参数不足时偷偷跑正式任务");
});

test("组参数期间取消，不再启动正式工具", async () => {
  const ac = new AbortController();
  const calls: unknown[] = [];
  await assert.rejects(() => guidedToolTurn({ ...opts, signal: ac.signal }, req, {
    chat: async () => { ac.abort(); return { session: "x", reply: model("ready"), redacted: 0, duration_ms: 1 }; },
    runTool: async (_name, body) => { calls.push(body); return { ok: true }; },
  }));
  assert.deepEqual(calls, [{ action: "catalog" }]);
});

test("条件齐备后真实调用工具，并用工具返回生成完整报告", async () => {
  const chats = [model("ready"), model("complete")];
  const calls: unknown[] = [];
  const deps: GuidedToolDeps = {
    chat: async (o, r) => {
      assert.ok(o.outputSchema, "每轮都必须带结构化输出约束");
      assert.match(String(o.developerInstructions), /追问/);
      assert.match(String(o.contextText), /真实能力说明/);
      if (chats.length === 1) assert.match(r.message, /唯一可用的真实结果/);
      return { session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 };
    },
    runTool: async (_name, body) => {
      calls.push(body);
      if ((body as { action?: string }).action === "catalog") return { ok: true, catalog: { choices: ["a"] } };
      return { ok: true, result: { score: 0.42 } };
    },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.equal(out.status, "complete");
  assert.equal(out.hypothesis, "历史样本可以验证该想法。");
  assert.match(out.report ?? "", /核心结果/);
  assert.deepEqual(calls, [{ action: "catalog" }, { start: "2020-01-01" }]);
});

test("工具声明的强制披露由服务端确定性附加，不能依赖模型自觉", async () => {
  const chats = [model("ready"), model("complete", { document: "## 核心结果\n\n模型漏写了口径。" })];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => (body as { action?: string }).action === "catalog"
      ? { ok: true, catalog: {} }
      : { ok: true, result: { required_disclosures: ["本次基准是所测标的自身的等权买入持有，不是独立外部基准。"] } },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.match(out.report ?? "", /## 工具口径披露/);
  assert.match(out.report ?? "", /不是独立外部基准/);
});

test("模型把强制披露藏进 HTML 注释时，服务端仍追加可见披露", async () => {
  const disclosure = "本次基准是所测标的自身的等权买入持有，不是独立外部基准。";
  const chats = [model("ready"), model("complete", {
    document: `## 核心结果\n\n结果正文。\n\n<!-- ${disclosure} -->`,
  })];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => (body as { action?: string }).action === "catalog"
      ? { ok: true, catalog: {} }
      : { ok: true, result: { required_disclosures: [disclosure] } },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.match(out.report ?? "", /## 工具口径披露\n\n- 本次基准/);
  assert.equal((out.report ?? "").split(disclosure).length - 1, 2, "注释里的文本不能让可见披露消失");
});

test("真实回测 JSON 的运行期历史不足说明进入最终报告，即使模型漏写", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const python = process.env.VRA_PYTHON ?? detectPython(repo) ?? detectPython(path.join(repo, "..")) ?? "python3";
  const note = "以下标的自身历史不足：300308.SZ 仅 400 根，仍参与了回测。";
  const script = `from pathlib import Path
import json
from backtest.gate import plan_backtest
from backtest.run import Result
from backtest.cli import _result_view
p = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="long")
r = Result(metrics={}, plan=p, strategy="fixture", provenance={}, limits=p.limits, notes=[*p.notes, ${JSON.stringify(note)}], run_dir=Path("."))
print(json.dumps({"ok": True, "result": _result_view(r)}))`;
  const result = JSON.parse(execFileSync(python, ["-c", script], { cwd: repo, encoding: "utf8", timeout: 30_000 }));
  const chats = [model("ready"), model("complete", { document: "## 核心结果\n\n模型漏写了运行期限制。" })];
  const out = await guidedToolTurn(opts, req, {
    chat: async () => ({ session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => (body as { action?: string }).action === "catalog" ? { ok: true, catalog: {} } : result,
  });
  assert.ok(out.report?.includes(`- ${note}`));
});

for (const disclosures of [["限制".repeat(251)], Array.from({ length: 13 }, (_, i) => `限制 ${i}`)]) {
  test(`强制披露超限明确拒绝，不截断后出报告 (${disclosures.length})`, async () => {
    let chats = 0;
    await assert.rejects(() => guidedToolTurn(opts, req, {
      chat: async () => { chats++; return { session: "x", reply: model("ready"), redacted: 0, duration_ms: 1 }; },
      runTool: async (_name, body) => (body as { action?: string }).action === "catalog"
        ? { ok: true, catalog: {} } : { ok: true, result: { required_disclosures: disclosures } },
    }), (e: unknown) => e instanceof GuidedToolError && e.code === "bad_tool_result");
    assert.equal(chats, 1, "不得让模型在丢失披露后继续写成功报告");
  });
}

test("工具拒绝时回到补问，不伪装成完成", async () => {
  const chats = [model("ready"), model("needs_input", { message: "样本太短，请扩大时间范围。" })];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => (body as { action?: string }).action === "catalog"
      ? { ok: true, catalog: {} }
      : { ok: false, refused: { reason: "样本太短", remedy: "扩大时间范围" } },
  };
  assert.deepEqual(await guidedToolTurn(opts, req, deps), { status: "needs_input", message: "样本太短，请扩大时间范围。" });
});

test("Agent 不能用 action 覆盖能力说明入口，也不能在未执行时声称完成", async () => {
  const runTool = async (_name: string, body: unknown) => (body as { action?: string }).action === "catalog" ? { ok: true } : { ok: true };
  await assert.rejects(
    () => guidedToolTurn(opts, req, { chat: async () => ({ session: "x", reply: model("ready", { tool_args_json: '{"action":"catalog"}' }), redacted: 0, duration_ms: 1 }), runTool }),
    (e: unknown) => e instanceof GuidedToolError && e.code === "bad_tool_args",
  );
  await assert.rejects(
    () => guidedToolTurn(opts, req, { chat: async () => ({ session: "x", reply: model("complete"), redacted: 0, duration_ms: 1 }), runTool }),
    (e: unknown) => e instanceof GuidedToolError && e.code === "bad_agent_state",
  );
});
