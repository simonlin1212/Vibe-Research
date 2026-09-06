import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../src/finance/register.ts";
import { type EvidenceItem, type CalcRecord } from "../src/merge.ts";
import { peDisclosureLines, peDisclosureErrors, peDisclosurePrompt } from "../src/finance/pe_disclosure.ts";
import { loadRun, validateStage } from "../src/validator.ts";

const id = "calc-" + "a".repeat(16);
const evidence = [
  { id: "ev-aaaaaaaa", field: "pe_ttm", value: 20, source: "tencent", raw_ref: "raw/quote.csv" },
  { id: "ev-bbbbbbbb", field: "pe_ttm_traded_history_points", value: 3, source: "baostock", raw_ref: "raw/history.csv" },
] as EvidenceItem[];
const calc: CalcRecord = { calculation_id: id, function: "percentile_rank", calc_version: "0.3.2", inputs_resolved: {},
  output: { status: "ok", value: 50, unit: "%", reason: "", details: {} },
  inputs: { current: 20, history: { history_csv: { column: "peTTM", raw_ref: "raw/history.csv" } } },
  inputs_refs: evidence.map(e => ({ ref_type: "evidence", ref_id: e.id })),
};
const title = "# 示例研究报告 · 状态:complete";

test("PE 披露跟随实际参数绑定的来源，未知来源不猜，同源不冒充跨源", () => {
  const [line] = peDisclosureLines(evidence, [calc]);
  assert.match(line, /当前值来源 tencent；历史序列来源 baostock/);
  assert.match(line, /跨来源或不同财务口径/);
  assert.match(line, new RegExp(id));
  assert.equal(peDisclosureLines(evidence, [{ ...calc, function: "other" }]).length, 0);
  assert.equal(peDisclosureLines(evidence, [{ ...calc, output: { ...calc.output, status: "error" } }]).length, 0);
  assert.match(peDisclosureLines([{ ...evidence[0], value: 21 }, evidence[1]], [calc])[0], /当前值来源 未核实/);
  assert.match(peDisclosureLines([evidence[0], { ...evidence[1], raw_ref: "raw/other.csv" }], [calc])[0], /历史序列来源 未核实/);
  assert.match(peDisclosureLines([evidence[0], { ...evidence[1], source: "tencent" }], [calc])[0], /当前值来源 tencent；历史序列来源 tencent/);
  assert.ok(!peDisclosureLines([{ ...evidence[0], source: "<evil>" }, evidence[1]], [calc])[0].includes("<evil>"));
});

test("必须是标题后的可见披露，不接受代码块、注释、正文末尾或否定改写", () => {
  const required = peDisclosureLines(evidence, [calc]);
  const block = required.join("\n");
  assert.deepEqual(peDisclosureErrors(`${title}\n\n${block}\n\n## 事实\n内容`, required), []);
  for (const report of [
    `${title}\n\n内容\n${block}`, `${title}\n\n<!--\n${block}\n-->`,
    `${title}\n\n\`\`\`\n${block}\n\`\`\``, `${title}\n\n<div hidden>\n${block}\n</div>`,
    `${title}\n\n${block.replace("不代表", "代表")}\n\n内容`, `${title}\n\n${block.replace(id, "calc-" + "b".repeat(16))}\n\n内容`,
  ]) assert.equal(peDisclosureErrors(report, required).length, 1);
});

test("损坏的计算记录不让披露生成器抛异常，生产校验仍保留 schema 错误", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-pe-malformed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ["fetch", "calcs", "stages"]) fs.mkdirSync(path.join(dir, sub));
  const malformed: unknown[] = [null, { function: "percentile_rank" },
    { ...calc, output: null }, { ...calc, inputs_refs: null },
    { ...calc, inputs_refs: {} }, { ...calc, inputs_refs: [null] }];
  fs.writeFileSync(path.join(dir, "stages/report.json"), JSON.stringify({ stage: "report", status: "complete", summary: "测试", evidence_ids: [], calculation_ids: [], gaps: [] }));
  for (const record of malformed) {
    assert.doesNotThrow(() => peDisclosureLines(evidence, [record as CalcRecord]));
    fs.writeFileSync(path.join(dir, "calcs/test.json"), JSON.stringify(record));
    assert.doesNotThrow(() => peDisclosurePrompt(dir));
    const result = validateStage("report", loadRun(dir));
    assert.ok(result.errors.some(e => e.startsWith("test.json ")), "必须报告计算文件错误，而不是被缺少阶段的早退分支挡住");
  }
});

test("落盘产物同时进入真实报告提示与生产阶段 validator", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-pe-disclosure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ["fetch", "calcs", "stages"]) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, "fetch/test.json"), JSON.stringify({ script: "test", evidence }));
  fs.writeFileSync(path.join(dir, "calcs/test.json"), JSON.stringify(calc));
  fs.writeFileSync(path.join(dir, "stages/report.json"), JSON.stringify({ stage: "report", status: "complete", summary: "测试", evidence_ids: [], calculation_ids: [id], gaps: [] }));
  const lines = peDisclosureLines(evidence, [calc]);
  assert.ok(peDisclosurePrompt(dir).includes(lines[0]));
  fs.writeFileSync(path.join(dir, "report.md"), `${title}\n\n## 事实\n资料`);
  assert.ok(validateStage("report", loadRun(dir)).errors.some(e => e.startsWith("PE 分位来源披露")));
  fs.writeFileSync(path.join(dir, "report.md"), `${title}\n\n${lines.join("\n")}\n\n## 事实\n资料`);
  assert.ok(!validateStage("report", loadRun(dir)).errors.some(e => e.startsWith("PE 分位来源披露")));
});
