import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { addReport } from "../src/report_library.ts";
import { ProductTaskOperations, ReportTaskMaterials, splitQuickPassages } from "../src/task_adapters.ts";
import { TaskRouteError, TaskRouter, makeResearchTask, type ResearchTask } from "../src/task_router.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.VRA_PYTHON?.trim()
  || (process.platform === "win32" ? "python" : path.join(REPO, "..", ".venv", "bin", "python"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-task-adapter-"));
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function quickTask(id: string, mode: "auto" | "quick" | "deep" = "auto"): ResearchTask {
  return makeResearchTask({ id: "task-real-report", kind: "locate_passages",
    requestedMode: mode, objective: "定位收入变化的原文", evidenceScope: "existing", workflow: "single_step",
    inputRefs: [{ kind: "report", id }], outputFormat: "text", operation: null });
}

test("真实研报适配器绑定正文 revision 与字符数，加载时再次核对", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "收入跟踪.md", content: b64("第一段。\n\n第二段提到收入增长。") });
  const materials = new ReportTaskMaterials(dataRoot);
  const operations = new ProductTaskOperations({ repoRoot: REPO, dataRoot, python: PYTHON });
  const route = await new TaskRouter({ materials, operations }).route(quickTask(rec.id));
  assert.equal(route.target, "quick");
  assert.equal(route.materials.inputs[0]?.contentChars, rec.chars);
  assert.match(route.materials.inputs[0]?.revision ?? "", /^[0-9a-f]{64}$/);
  const loaded = await materials.load(route, route.materials.inputs[0]!);
  assert.equal(loaded.title, rec.name);
  assert.deepEqual(loaded.excerpts, ["第一段。\n\n第二段提到收入增长。"]);
});

test("路由后正文变化会在模型调用前被拒，超大资料 Auto 改走 Deep", async () => {
  const dataRoot = tmp();
  const rec = await addReport(dataRoot, { name: "变化.md", content: b64("原始正文。") });
  const materials = new ReportTaskMaterials(dataRoot);
  const router = new TaskRouter({ materials, operations: new ProductTaskOperations({ repoRoot: REPO, dataRoot, python: PYTHON }) });
  const route = await router.route(quickTask(rec.id));
  const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, "knowledge/reports/manifest.json"), "utf8"));
  const textFile = path.join(dataRoot, "knowledge/reports", manifest.reports[0].text_file);
  fs.writeFileSync(textFile, "篡改正文。\n");
  await assert.rejects(() => materials.load(route, route.materials.inputs[0]!), /不一致|发生变化/);

  const largeRoot = tmp();
  const large = await addReport(largeRoot, { name: "大资料.txt", content: b64("大".repeat(40_001)) });
  const largeMaterials = new ReportTaskMaterials(largeRoot);
  const largeRouter = new TaskRouter({ materials: largeMaterials, operations: new ProductTaskOperations({ repoRoot: REPO, dataRoot: largeRoot, python: PYTHON }) });
  assert.equal((await largeRouter.route(quickTask(large.id))).target, "deep");
  await assert.rejects(() => largeRouter.route(quickTask(large.id, "quick")),
    (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible");
});

test("段落适配器优先保留完整段落，超长段按句边界切分且每段不超过上限", () => {
  const text = `短段。\n\n${"甲".repeat(1_100)}。${"乙".repeat(1_100)}。`;
  const parts = splitQuickPassages(text);
  assert.equal(parts.every((part) => part.length <= 2_000), true);
  assert.equal(parts.join("").replace(/\n/g, "").includes("短段。"), true);
  assert.equal(parts.some((part) => part.endsWith("。")), true);
});

test("真实操作注册表接受已登记查询、端点与计算，拒绝未知 id 和非法端点参数", async () => {
  const dataRoot = tmp();
  const ops = new ProductTaskOperations({ repoRoot: REPO, dataRoot, python: PYTHON });
  const blank = {} as ResearchTask;
  const queryId = Object.keys((await import("../src/plugin.ts")).currentPlugin().pageQueries ?? {})[0]!;
  await ops.validate(blank, { kind: "browse_data", queryId, args: {} });
  await ops.validate(blank, { kind: "calculate", functionId: "forward_pe", args: { price: 10, eps_forecast: 2 } });
  await assert.rejects(() => ops.validate(blank, { kind: "browse_data", queryId: "missing", args: {} }), TaskRouteError);
  await assert.rejects(() => ops.validate(blank, { kind: "browse_data", queryId, args: { refresh: "yes" } }), TaskRouteError);
  await assert.rejects(() => ops.validate(blank, { kind: "calculate", functionId: "missing", args: {} }), TaskRouteError);
  await assert.rejects(() => ops.validate(blank, { kind: "calculate", functionId: "forward_pe", args: { price: "abc", eps_forecast: 2 } }), TaskRouteError);
  await assert.rejects(() => ops.validate(blank, { kind: "calculate", functionId: "forward_pe", args: { price: 10 } }), TaskRouteError);
  await assert.rejects(() => ops.validate(blank, { kind: "refresh_registered_data", endpointIds: ["tx_quote"], args: { symbol: "../bad" } }), /非法代码/);
});
