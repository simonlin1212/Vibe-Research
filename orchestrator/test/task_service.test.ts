import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { addReport } from "../src/report_library.ts";
import { resumeUnifiedTask, runUnifiedTask } from "../src/task_service.ts";
import type { DeepResearchBackend } from "../src/engines/codex_deep_engine.ts";
import { FinanceDeepTargetResolver } from "../src/finance/deep_target.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-task-service-"));
const PYTHON = process.env.VRA_PYTHON?.trim()
  || (process.platform === "win32" ? "python" : path.join(REPO, "..", ".venv", "bin", "python"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: REPO, dataRoot,
  python: PYTHON, node: process.execPath, providerEnvKey: null });
const task = (id: string, requestedMode: "auto" | "quick" | "deep" = "auto") => ({
  schemaVersion: 1, id: "task-api-1", kind: "locate_passages", requestedMode,
  objective: "定位收入变化的原文", evidenceScope: "existing", workflow: "single_step",
  inputRefs: [{ kind: "report", id }], outputFormat: "text", operation: null,
});

test("统一任务入口用真实研报适配器路由并执行 Quick，响应不回显密钥", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "收入.md", content: Buffer.from("收入同比增长。", "utf8").toString("base64") });
  const routed = await runUnifiedTask(ctx(dataRoot), { task: task(rec.id), execute: false });
  const result = await runUnifiedTask(ctx(dataRoot), {
    task: task(rec.id), execute: true, expectedRouteFingerprint: routed.route.routeFingerprint,
  }, undefined, {
    quickProvider: { name: "fixture", baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", model: "fixture", structuredOutput: "prompt" },
    complete: async (request) => {
      const payload = JSON.parse(String(request.messages[1]?.content));
      const excerpt = payload.materials[0].excerpts[0];
      return { message: { role: "assistant", content: JSON.stringify({ selections: [{
        kind: payload.materials[0].kind, id: payload.materials[0].id, revision: payload.materials[0].revision,
        excerptId: excerpt.excerptId,
      }] }) }, finishReason: "stop", usage: { total_tokens: 12 }, durationMs: 3 };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.route.target, "quick");
  assert.deepEqual(result.events.map((event) => event.type), ["started", "artifact", "completed"]);
  assert.equal(JSON.stringify(result).includes("secret-test-key"), false);
});

test("Deep 在 M3 通过统一入口启动现有六阶段流程，并可按指纹恢复状态", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "300308-深研.md", content: Buffer.from("公司代码 300308。正文。", "utf8").toString("base64") });
  const deepTask = { ...task(rec.id, "deep"), kind: "deep_research", evidenceScope: "open_discovery",
    workflow: "multi_step", outputFormat: "document", inputRefs: [{ kind: "report", id: rec.id }, { kind: "entity", id: "300308" }] };
  let runId = "";
  let terminal = false;
  const deepBackend: DeepResearchBackend = {
    start(request) { runId = request.run_id!; return { run_id: runId, run_dir: `runs/${runId}`, log: `logs/${runId}.log`, pid: 3 }; },
    status() { return { run_id: runId, exists: true, status: terminal ? "complete" : "running", exit_code: terminal ? 0 : null,
      stages: terminal ? [{ stage: "profile", status: "complete", attempts: 1 }] : [], evidence_count: terminal ? 9 : 0,
      calculation_count: terminal ? 2 : 0, finished_at: terminal ? "2026-09-04T12:00:00Z" : null,
      last_events: [], report: terminal, viewer: terminal ? `runs/${runId}/viewer.html` : null }; },
    report() { return { run_id: runId, report: "# 完成", appendix: null, availability: "ready", run_status: "complete" }; },
  };
  const deepDeps = { deepBackend, deepTargetResolver: new FinanceDeepTargetResolver(dataRoot) };
  const routed = await runUnifiedTask(ctx(dataRoot), { task: deepTask, execute: false }, undefined, deepDeps);
  assert.equal(routed.status, "routed");
  assert.equal(routed.executionAvailable, true);
  const started = await runUnifiedTask(ctx(dataRoot), { task: deepTask, execute: true,
    expectedRouteFingerprint: routed.route.routeFingerprint }, undefined, deepDeps);
  assert.equal(started.status, "running");
  assert.equal(started.events.at(-1)?.type, "started");
  terminal = true;
  const resumed = await resumeUnifiedTask(ctx(dataRoot), {
    runId, routeFingerprint: routed.route.routeFingerprint,
  }, undefined, deepDeps);
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.events.map((event) => event.type), ["progress", "artifact", "completed"]);
});

test("直连模式可以先看见 Deep 路由，但不能执行，明确要求开启 Agent", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "300308-深研.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const deepTask = { ...task(rec.id, "deep"), kind: "deep_research", evidenceScope: "open_discovery",
    workflow: "multi_step", outputFormat: "document", inputRefs: [{ kind: "report", id: rec.id }, { kind: "entity", id: "300308" }] };
  const deps = { deepTargetResolver: new FinanceDeepTargetResolver(dataRoot) };
  const llm = { provider: "deepseek", apiKey: "test-key", model: "deepseek-v4" };
  const routed = await runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: false, executionMode: "direct", llm,
  }, undefined, deps);
  assert.equal(routed.route.target, "deep");
  assert.equal(routed.executionAvailable, false);
  await assert.rejects(() => runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: true, executionMode: "direct", expectedRouteFingerprint: routed.route.routeFingerprint,
    llm,
  }, undefined, deps), (error: unknown) => error instanceof ServiceError && error.code === "agent_required");
});

test("任务路由绑定 AI 来源，Claude / WorkBuddy 订阅可启动六阶段", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "300308-深研.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const deepTask = { ...task(rec.id, "deep"), kind: "deep_research", evidenceScope: "open_discovery",
    workflow: "multi_step", outputFormat: "document" };
  const deps = { deepTargetResolver: new FinanceDeepTargetResolver(dataRoot) };
  const claude = { provider: "cli-claude", model: "claude-subscription" };
  const routed = await runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: false, executionMode: "agent", llm: claude,
  }, undefined, deps);
  assert.equal(routed.route.target, "deep");
  assert.equal(routed.executionAvailable, true, "Claude 已有受控 MCP 六阶段适配器");
  assert.equal(routed.route.engineFamily, "local_agent", "Claude 订阅不能冒充 Codex Harness");

  const codebuddyRouted = await runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: false, executionMode: "agent", llm: { provider: "cli-codebuddy" },
  }, undefined, deps);
  assert.equal(codebuddyRouted.executionAvailable, true, "CodeBuddy 已有受控 MCP 六阶段适配器");
  assert.equal(codebuddyRouted.route.engineFamily, "local_agent", "WorkBuddy 订阅不能冒充 Codex Harness");

  let startedRuntime: unknown = null;
  const backend: DeepResearchBackend = {
    start(_request, internal) { startedRuntime = internal?.runtimeLlm; return { run_id: "task-local-agent", run_dir: "runs/task-local-agent", log: "logs/task-local-agent.log", pid: 7 }; },
    status() { throw new Error("not used"); }, report() { throw new Error("not used"); },
  };
  const started = await runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: true, executionMode: "agent", llm: { provider: "cli-codebuddy" },
    expectedRouteFingerprint: codebuddyRouted.route.routeFingerprint,
  }, undefined, { ...deps, deepBackend: backend });
  assert.equal(started.events[0]?.payload?.executor, "local-agent-deep-v1");
  assert.deepEqual(startedRuntime, { provider: "cli-codebuddy" });

  await assert.rejects(() => runUnifiedTask(ctx(dataRoot), {
    task: deepTask, execute: true, executionMode: "agent", llm: { provider: "cli-codex", model: "codex-subscription" },
    expectedRouteFingerprint: routed.route.routeFingerprint,
  }, undefined, deps), (error: unknown) => error instanceof ServiceError && error.code === "route_changed");
});

test("确定性计算由统一任务入口真实执行，不把成功路由冒充成已处理", async () => {
  const dataRoot = tmp();
  const calcTask = {
    schemaVersion: 1, id: "task-calc-1", kind: "calculate", requestedMode: "auto",
    objective: "计算前瞻倍数", evidenceScope: "existing", workflow: "single_step", inputRefs: [],
    outputFormat: "data", operation: { kind: "calculate", functionId: "forward_pe",
      args: { price: 100, eps_forecast: 5 } },
  };
  const routed = await runUnifiedTask(ctx(dataRoot), { task: calcTask, execute: false });
  const result = await runUnifiedTask(ctx(dataRoot), {
    task: calcTask, execute: true, expectedRouteFingerprint: routed.route.routeFingerprint,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.executionAvailable, true);
  assert.equal(result.route.target, "deterministic");
  assert.deepEqual(result.events.map((event) => event.type), ["started", "artifact", "completed"]);
  const artifact = result.events.find((event) => event.type === "artifact");
  assert.equal(((artifact?.payload?.result as { output?: { value?: unknown } })?.output?.value), 20);
});

test("execute=false 只完成确定性路由；已取消的请求不会进入计算", async () => {
  const dataRoot = tmp();
  const calcTask = {
    schemaVersion: 1, id: "task-calc-route", kind: "calculate", requestedMode: "auto",
    objective: "只判断路径", evidenceScope: "existing", workflow: "single_step", inputRefs: [],
    outputFormat: "data", operation: { kind: "calculate", functionId: "forward_pe",
      args: { price: 100, eps_forecast: 5 } },
  };
  const routed = await runUnifiedTask(ctx(dataRoot), { task: calcTask, execute: false });
  assert.equal(routed.status, "routed");
  assert.deepEqual(routed.events, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runUnifiedTask(ctx(dataRoot), {
    task: calcTask, execute: true, expectedRouteFingerprint: routed.route.routeFingerprint,
  }, controller.signal),
    (error: unknown) => error instanceof ServiceError && error.code === "cancelled");
});

test("两段式执行必须与第一次路由指纹一致，不一致时拒绝而不是换路线", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "会变化.md", content: Buffer.from("原始正文。", "utf8").toString("base64") });
  const routed = await runUnifiedTask(ctx(dataRoot), { task: task(rec.id), execute: false });
  await assert.rejects(() => runUnifiedTask(ctx(dataRoot), {
    task: task(rec.id), execute: true, expectedRouteFingerprint: "f".repeat(64),
    llm: { provider: "cli-claude" },
  }), (error: unknown) => error instanceof ServiceError && error.code === "route_changed");
  assert.match(routed.route.routeFingerprint, /^[a-f0-9]{64}$/);
});

test("统一任务请求拒绝注入依赖、非法 llm 与契约外字段", async () => {
  const dataRoot = tmp();
  for (const request of [
    { task: {}, materials: {} },
    { task: {}, execute: "yes" },
    { task: {}, expectedRouteFingerprint: "short" },
    { task: task("0".repeat(32)), execute: false, llm: { provider: "mimo", apiKey: 42 } },
    { task: task("0".repeat(32)), llm: { provider: "mimo", apiKey: "x", resolver: "evil" } },
  ]) {
    await assert.rejects(() => runUnifiedTask(ctx(dataRoot), request),
      (error: unknown) => error instanceof ServiceError && error.code === "invalid_task_request");
  }
  const rec = await addReport(dataRoot, { name: "两阶段.md", content: Buffer.from("正文。", "utf8").toString("base64") });
  await assert.rejects(() => runUnifiedTask(ctx(dataRoot), { task: task(rec.id), execute: true }),
    (error: unknown) => error instanceof ServiceError && error.code === "invalid_task_request");
});
