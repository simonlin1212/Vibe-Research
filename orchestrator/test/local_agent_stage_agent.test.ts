import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAgentStageAgent } from "../src/engines/local_agent_stage_agent.ts";
import { LocalAgentError } from "../src/local_agent_runtime.ts";

test("订阅阶段把用户取消信号传给真实运行适配器", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-cancel-"));
  try {
    for (const agent of ["claude", "codebuddy"] as const) {
      const ac = new AbortController();
      let received: AbortSignal | undefined;
      const runner = new LocalAgentStageAgent({ agent, runId: "cancel", runDir: root,
        repoRoot: root, python: "python3", eventsPath: path.join(root, "events.jsonl"), timeoutMs: 1000,
        complete: async (_agent, options) => { received = options.signal; return "{}"; } });
      await runner.runTurn("profile", 1, "x", undefined, ac.signal);
      assert.equal(received, ac.signal);
      ac.abort();
      assert.equal(received?.aborted, true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("进程树退出未确认必须冒泡，不能被取消检查盖成成功取消", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-stop-fail-"));
  try {
    const ac = new AbortController();
    const runner = new LocalAgentStageAgent({ agent: "claude", runId: "stop-fail", runDir: root,
      repoRoot: root, python: "python3", eventsPath: path.join(root, "events.jsonl"), timeoutMs: 1000,
      complete: async () => { ac.abort(new Error("用户取消研究")); throw new LocalAgentError("agent_shutdown_failed", "未确认"); } });
    await assert.rejects(runner.runTurn("profile", 1, "x", undefined, ac.signal),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_shutdown_failed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("本机订阅 Agent 每阶段只得到五个受控 MCP 工具，并如实记账产物变更", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-stage-"));
  const runDir = path.join(root, "run");
  fs.mkdirSync(path.join(runDir, "stages"), { recursive: true });
  const events = path.join(runDir, "events.jsonl");
  try {
    const runner = new LocalAgentStageAgent({ agent: "codebuddy", runId: "r1", runDir,
      repoRoot: root, python: "python3", eventsPath: events, timeoutMs: 10_000,
      complete: async (agent, options) => {
        assert.equal(agent, "codebuddy");
        assert.equal(options.controlledMcp?.serverName, "vra");
        assert.deepEqual(options.controlledMcp?.allowedTools.sort(), [
          "mcp__vra__calculate", "mcp__vra__list_run_files", "mcp__vra__read_run_file",
          "mcp__vra__write_report", "mcp__vra__write_stage",
        ]);
        assert.ok(!options.systemPrompt.includes("Bash"));
        fs.writeFileSync(path.join(runDir, "stages", "profile.json"), "{}\n");
        return '{"summary":"done"}';
      },
    });
    const result = await runner.runTurn("profile", 0, "做公司画像", { type: "object" });
    assert.equal(result.failed, null);
    assert.equal(result.threadId, null);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.fileChanges, [path.join(runDir, "stages", "profile.json")]);
    assert.match(fs.readFileSync(events, "utf8"), /local_agent\.turn_end/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("本机订阅 Agent 失败转成 turn failure，不把它冒充成模型空回复", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-stage-fail-"));
  try {
    const runner = new LocalAgentStageAgent({ agent: "claude", runId: "r2", runDir: root,
      repoRoot: root, python: "python3", eventsPath: path.join(root, "events.jsonl"), timeoutMs: 10_000,
      complete: async () => { throw new Error("boom"); } });
    const result = await runner.runTurn("profile", 0, "x");
    assert.match(result.failed ?? "", /boom/);
    assert.equal(result.itemCount, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("本机订阅 Agent 登录失效时立即终止研究，不做无意义的阶段重试", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-stage-auth-"));
  try {
    let calls = 0;
    const runner = new LocalAgentStageAgent({ agent: "claude", runId: "r3", runDir: root,
      repoRoot: root, python: "python3", eventsPath: path.join(root, "events.jsonl"), timeoutMs: 10_000,
      complete: async () => {
        calls += 1;
        throw new LocalAgentError("agent_not_authenticated", "Claude Code 登录已失效");
      } });
    await assert.rejects(() => runner.runTurn("profile", 1, "x"),
      (error: unknown) => error instanceof LocalAgentError && error.code === "agent_not_authenticated");
    assert.equal(calls, 1);
    const events = fs.readFileSync(path.join(root, "events.jsonl"), "utf8");
    assert.match(events, /local_agent\.turn_failed/);
    assert.match(events, /local_agent\.turn_end/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("本机订阅 Agent 版本过旧时也立即终止，不重复调用缺少安全参数的 CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-stage-old-cli-"));
  try {
    const runner = new LocalAgentStageAgent({ agent: "codebuddy", runId: "r4", runDir: root,
      repoRoot: root, python: "python3", eventsPath: path.join(root, "events.jsonl"), timeoutMs: 10_000,
      complete: async () => { throw new LocalAgentError("agent_cli_too_old", "CodeBuddy 版本过旧"); } });
    await assert.rejects(() => runner.runTurn("profile", 1, "x"),
      (error: unknown) => error instanceof LocalAgentError && error.code === "agent_cli_too_old");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
