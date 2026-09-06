import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { CodexDeepEngine, DeepExecutionError, type DeepResearchBackend } from "../src/engines/codex_deep_engine.ts";
import { FinanceDeepTargetResolver } from "../src/finance/deep_target.ts";
import { addReport } from "../src/report_library.ts";
import { ProductTaskOperations, ReportTaskMaterials } from "../src/task_adapters.ts";
import { TaskRouter } from "../src/task_router.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { researchReportContext } from "../src/orchestrate.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-deep-engine-"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: REPO, dataRoot,
  python: path.join(REPO, "..", ".venv", "bin", "python"), node: process.execPath, providerEnvKey: null });

test("Deep 已知启动校验给出操作指引，但不透传异常正文", async (t) => {
  const dataRoot = tmp();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const route = await deepRoute(dataRoot, []);
  for (const code of ["invalid_task_context", "path_symlink", "unknown"]) {
    const backend: DeepResearchBackend = {
      start() { throw new ServiceError(code, "/private/fake-user/auth.json private-canary"); },
      status() { throw new Error("unused"); }, report() { throw new Error("unused"); },
    };
    const events = [];
    for await (const event of new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend }).run(route)) events.push(event);
    assert.equal(events.at(-1)?.type, "failed");
    const output = JSON.stringify(events);
    assert.doesNotMatch(output, /private-canary|auth\.json/);
    if (code === "invalid_task_context") assert.match(output, /关注点或圈选资料格式无效/);
    else assert.match(output, /检查本地 Agent/);
  }
});

async function deepRoute(dataRoot: string, reportIds: readonly string[], entity = "300308") {
  const task = {
    schemaVersion: 1, id: "task-deep-1", kind: "deep_research", requestedMode: "deep",
    objective: "重点核查收入变化、证据冲突与下一数据点。", evidenceScope: "open_discovery",
    workflow: "multi_step", inputRefs: [
      ...reportIds.map((id) => ({ kind: "report" as const, id })),
      { kind: "entity" as const, id: entity },
    ], outputFormat: "document", operation: null,
  };
  return new TaskRouter({ materials: new ReportTaskMaterials(dataRoot), operations: new ProductTaskOperations(ctx(dataRoot)) }).route(task);
}

test("Deep 适配器只启动现有 Codex 六阶段入口，并把任务与材料范围绑定到 run-id", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-收入.md", content: Buffer.from("公司代码 300308。收入变化。", "utf8").toString("base64") });
  await addReport(dataRoot, { name: "300308-未勾选.md", content: Buffer.from("公司代码 300308。未勾选秘密段落。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  const starts: unknown[] = [];
  const backend: DeepResearchBackend = {
    start(request, internal) {
      starts.push({ request, internal });
      return { run_id: request.run_id!, run_dir: `runs/${request.run_id}`, log: `logs/${request.run_id}.log`, pid: 42 };
    },
    status(runId) { return { run_id: runId, exists: false, status: null, exit_code: null, stages: [],
      evidence_count: null, calculation_count: null, finished_at: null, last_events: [], report: false, viewer: null }; },
    report(runId) { return { run_id: runId, report: null, appendix: null, availability: "missing", run_status: null }; },
  };
  const events = [];
  for await (const event of new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend }).run(route)) events.push(event);

  assert.deepEqual(events.map((event) => event.type), ["started"]);
  assert.match(events[0]!.runId, /^task-/);
  const reportRevision = route.materials.inputs.find((item) => item.id === report.id)!.revision!;
  assert.deepEqual(starts, [{
    request: { symbol: "300308", market: "SZ", endpoints: "full", knowledge: "on", run_id: events[0]!.runId },
    internal: { taskObjective: route.task.objective, reportIds: [report.id], reportRevisions: { [report.id]: reportRevision } },
  }]);
  const binding = JSON.parse(fs.readFileSync(path.join(dataRoot, "task-runs", `${events[0]!.runId}.json`), "utf8"));
  assert.equal(binding.route_fingerprint, route.routeFingerprint);
  assert.equal(binding.task_id, route.task.id);
  assert.equal(binding.symbol, "300308");
  assert.deepEqual(binding.report_ids, [report.id]);
  assert.equal(JSON.stringify(binding).includes(route.task.objective), false, "绑定账本不复制用户任务正文");
  const recalled = researchReportContext({ dataRoot, symbol: "300308", taskObjective: route.task.objective,
    reportIds: [report.id], reportRevisions: { [report.id]: reportRevision } });
  assert.ok(recalled?.text.includes("收入变化"));
  assert.equal(recalled?.text.includes("未勾选秘密段落"), false, "Deep 不得按同代码扩到用户未勾选的资料");
});

test("Deep 长流程在真正读取资料时复核路由版本，不会静默改读后来变化的正文", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-版本.md", content: Buffer.from("公司代码 300308。旧正文。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  const expected = route.materials.inputs.find((item) => item.id === report.id)!.revision!;
  const textFile = path.join(dataRoot, "knowledge", "reports", "texts", `${report.id}.txt`);
  fs.writeFileSync(textFile, "公司代码 300308。后来变化的新正文。", "utf8");
  assert.throws(() => researchReportContext({ dataRoot, symbol: "300308", taskObjective: route.task.objective,
    reportIds: [report.id], reportRevisions: { [report.id]: expected } }), /资料在任务路由后发生变化/);
});

test("Deep 接受上限内的 16 份圈选资料时，每一份都进入研究上下文", async () => {
  const dataRoot = tmp();
  const reports = [];
  for (let index = 0; index < 16; index += 1) {
    reports.push(await addReport(dataRoot, { name: `300308-材料-${index + 1}.md`,
      content: Buffer.from(`公司代码 300308。第 ${index + 1} 份材料。` + "正文".repeat(1_000), "utf8").toString("base64") }));
  }
  const route = await deepRoute(dataRoot, reports.map((report) => report.id));
  const revisions = Object.fromEntries(route.materials.inputs
    .filter((item) => item.kind === "report")
    .map((item) => [item.id, item.revision!]));
  const recalled = researchReportContext({ dataRoot, symbol: "300308", taskObjective: route.task.objective,
    reportIds: reports.map((report) => report.id), reportRevisions: revisions });
  assert.equal(recalled?.hits.length, 16);
  assert.deepEqual(new Set(recalled?.hits.map((hit) => hit.id)), new Set(reports.map((report) => report.id)));
  assert.equal(recalled?.truncated, false);
});

test("Deep 圈选资料有缺失时整次拒绝，不得回退读取同代码的未勾选资料", async () => {
  const dataRoot = tmp();
  const unselected = await addReport(dataRoot, { name: "300308-未勾选.md", content: Buffer.from("公司代码 300308。整库秘密。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, ["a".repeat(32)]);
  let started = false;
  const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend: {
    start() { started = true; throw new Error("不应启动"); }, status() { throw new Error("unused"); }, report() { throw new Error("unused"); },
  } });
  const events = [];
  for await (const item of engine.run(route)) events.push(item);
  assert.equal(started, false);
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(events.at(-1)?.payload?.code, "deep_start_failed");
  assert.ok(fs.existsSync(path.join(dataRoot, "knowledge", "reports", "texts", `${unselected.id}.txt`)));
});

test("Deep 恢复核对路由指纹，并把既有 manifest 状态投影成稳定统一事件", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-恢复.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  let status: ReturnType<DeepResearchBackend["status"]> = {
    run_id: "placeholder", exists: false, status: null, exit_code: null, stages: [], evidence_count: null,
    calculation_count: null, finished_at: null, last_events: [], report: false, viewer: null,
  };
  const backend: DeepResearchBackend = {
    start(request) { status = { ...status, run_id: request.run_id! }; return { run_id: request.run_id!, run_dir: `runs/${request.run_id}`, log: "logs/x.log", pid: 9 }; },
    status() { return status; },
    report(runId) { return { run_id: runId, report: "# 已完成", appendix: "附录", availability: "ready", run_status: "complete" }; },
  };
  const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend });
  const started = [];
  for await (const event of engine.run(route)) started.push(event);
  const runId = started[0]!.runId;

  status = { run_id: runId, exists: true, status: "complete", exit_code: 0,
    stages: [{ stage: "profile", status: "complete", attempts: 1 }, { stage: "report", status: "complete", attempts: 1 }],
    evidence_count: 23, calculation_count: 4, finished_at: "2026-09-04T12:00:00Z", last_events: [], report: true,
    viewer: `runs/${runId}/viewer.html` };
  const resumed = [];
  for await (const event of engine.resume!({ runId, routeFingerprint: route.routeFingerprint })) resumed.push(event);
  assert.deepEqual(resumed.map((event) => [event.sequence, event.type]), [[2, "progress"], [3, "progress"], [8, "artifact"], [9, "completed"]]);
  assert.equal(resumed[2]!.payload?.artifactType, "deep_research_report");
  assert.equal(resumed[2]!.payload?.report, "# 已完成");
  assert.equal(resumed[3]!.payload?.researchStatus, "complete");

  await assert.rejects(async () => {
    for await (const _event of engine.resume!({ runId, routeFingerprint: "0".repeat(64) })) { /* consume */ }
  }, (error: unknown) => error instanceof DeepExecutionError && error.code === "resume_mismatch");
});

test("Deep 运行中的 manifest 占位退出码不得被当成终态", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-运行中.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  let runId = "";
  const backend: DeepResearchBackend = {
    start(request) { runId = request.run_id!; return { run_id: runId, run_dir: `runs/${runId}`, log: "logs/x", pid: 4 }; },
    status() { return { run_id: runId, exists: true, status: "running", exit_code: 2,
      stages: [{ stage: "profile", status: "running", attempts: 1 }], evidence_count: 0,
      calculation_count: 0, finished_at: null, last_events: [], report: false, viewer: null }; },
    report() { throw new Error("运行中不得读取报告"); },
  };
  const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend });
  const started = [];
  for await (const item of engine.run(route)) started.push(item);
  const resumed = [];
  for await (const item of engine.resume!({ runId, routeFingerprint: route.routeFingerprint })) resumed.push(item);
  assert.deepEqual(resumed.map((item) => item.type), ["progress"]);
});

test("Deep 启动目录长期未出现时失败收口，非成功终态也不得冒充完成", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-状态.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  let now = new Date("2026-09-04T12:00:00Z");
  let status: ReturnType<DeepResearchBackend["status"]> = { run_id: "placeholder", exists: false, status: null,
    exit_code: null, stages: [], evidence_count: null, calculation_count: null, finished_at: null,
    last_events: [], report: false, viewer: null };
  const backend: DeepResearchBackend = {
    start(request) { status = { ...status, run_id: request.run_id! }; return { run_id: request.run_id!, run_dir: "runs/x", log: "logs/x", pid: 3 }; },
    status() { return status; },
    report(runId) { return { run_id: runId, report: "# 未完整", appendix: null, availability: "ready", run_status: "incomplete" }; },
  };
  const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend, now: () => now });
  const started = [];
  for await (const item of engine.run(route)) started.push(item);
  const runId = started[0]!.runId;

  now = new Date("2026-09-04T12:01:01Z");
  const lost = [];
  for await (const item of engine.resume!({ runId, routeFingerprint: route.routeFingerprint })) lost.push(item);
  assert.equal(lost.at(-1)?.type, "failed");
  assert.equal(lost.at(-1)?.payload?.code, "deep_start_lost");

  status = { ...status, exists: true, status: "incomplete", exit_code: 2,
    finished_at: "2026-09-04T12:02:00Z", report: true };
  const incomplete = [];
  for await (const item of engine.resume!({ runId, routeFingerprint: route.routeFingerprint })) incomplete.push(item);
  assert.deepEqual(incomplete.slice(-2).map((item) => item.type), ["artifact", "failed"]);
});

test("Deep 不猜标的：无代码、多代码和非 A 股材料都在启动前失败", async () => {
  for (const symbols of [[], ["300308", "600519"], ["NVDA"]]) {
    const dataRoot = tmp();
    const name = symbols.length ? `${symbols.join("-")}.md` : "没有代码.md";
    const report = await addReport(dataRoot, { name, content: Buffer.from("研究材料。", "utf8").toString("base64") });
    const route = await new TaskRouter({ materials: new ReportTaskMaterials(dataRoot), operations: new ProductTaskOperations(ctx(dataRoot)) }).route({
      schemaVersion: 1, id: "task-deep-invalid", kind: "deep_research", requestedMode: "deep",
      objective: "完整研究", evidenceScope: "open_discovery", workflow: "multi_step",
      inputRefs: [{ kind: "report", id: report.id }], outputFormat: "document", operation: null,
    });
    let started = false;
    const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend: {
      start() { started = true; throw new Error("不应启动"); }, status() { throw new Error("unused"); }, report() { throw new Error("unused"); },
    } });
    const events = [];
    for await (const event of engine.run(route)) events.push(event);
    assert.equal(started, false);
    assert.equal(events.at(-1)?.type, "failed");
    assert.match(String(events.at(-1)?.payload?.code), /^deep_(entity_required|multiple_entities|unsupported_entity)$/);
  }
});

test("既有六阶段入口同步拒绝启动时，不留下可恢复的幽灵绑定", async () => {
  const dataRoot = tmp();
  const report = await addReport(dataRoot, { name: "300308-失败.md", content: Buffer.from("公司代码 300308。", "utf8").toString("base64") });
  const route = await deepRoute(dataRoot, [report.id]);
  const engine = new CodexDeepEngine({ ctx: ctx(dataRoot), materials: new FinanceDeepTargetResolver(dataRoot), backend: {
    start() { throw new Error("spawn refused"); }, status() { throw new Error("unused"); }, report() { throw new Error("unused"); },
  } });
  const events = [];
  for await (const event of engine.run(route)) events.push(event);
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(fs.existsSync(path.join(dataRoot, "task-runs", `${events[0]!.runId}.json`)), false);
});
