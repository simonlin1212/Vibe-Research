import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { batchSummaryMarkdown, collectRun, runBatch } from "../src/batch.ts";
import { alertsMarkdown, diffEvidence, pickRuns, runAlerts } from "../src/alerts.ts";
import { evidenceAlerts, ServiceError } from "../src/service.ts";

test("观测日行情跨日对齐，财务资料期和不同来源仍严格分开", () => {
  const quote = (period: string, value: number, source = "tencent") => ({ id: `ev-${period}-${source}`, field: "price", period, value, source, unit: "元" });
  const diffs = diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 11)]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, "changed");
  assert.equal(diffs[0].base?.period, "2026-09-03");
  assert.equal(diffs[0].next?.period, "2026-09-04");
  assert.match(alertsMarkdown("X", "a", "b", diffs), /2026-09-03 → 2026-09-04/);
  assert.deepEqual(diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 10)]), []);
  assert.deepEqual(diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 11, "eastmoney")]).map(d=>d.kind).sort(), ["added", "removed"]);
  const fin = (period: string) => ({ ...quote(period, 10), field: "revenue_cum" });
  assert.deepEqual(diffEvidence([fin("2025-12-31")], [fin("2026-06-30")]).map(d=>d.kind).sort(), ["added", "removed"]);
});

test("观测序列只比较各次最新值，但旧日矛盾或不同口径不能被隐藏", () => {
  const e = (period: string, value: number) => ({ id: `ev-${period}-${value}`, field: "price", period, value, source: "tencent", unit: "元" });
  const diff = diffEvidence([e("2026-09-03", 10), e("2026-09-02", 8)], [e("2026-09-04", 11), e("2026-09-03", 10)]);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].base?.value, 10);
  assert.equal(diff[0].next?.value, 11);
  assert.throws(() => diffEvidence([e("2026-09-03", 10), e("2026-09-02", 8), e("2026-09-02", 9)], []), /同源同键/);
  assert.equal(diffEvidence([e("2026-09-03", 10)], [{ ...e("2026-09-04", 11), adjustment: "qfq" }]).length, 2);
  assert.equal(diffEvidence([e("2026-02-30", 10)], [e("2026-03-01", 11)]).length, 2, "不猜畸形日期");
});
import { writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
function repoWithRuns(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ba-"));
  const runs = path.join(repo, ".local", "runs");
  const mk = (id: string, symbol: string, finished: string, price: number, extra: Record<string, unknown>[] = []) => {
    fs.mkdirSync(path.join(runs, id, "stages"), { recursive: true });
    writeJson(path.join(runs, id, "manifest.json"), { run_id: id, symbol, market: "SZ", status: "complete", exit_code: 0, evidence_count: 2, calculation_count: 1, evidence_conflicts: [], finished_at: finished, started_at: finished });
    writeJson(path.join(runs, id, "evidence.json"), [{ id: `ev-${id}1`.padEnd(9, "0"), field: "price", value: price, unit: "元", period: "2026-08-21", adjustment: "none", source: "tencent" }, { id: `ev-${id}2`.padEnd(9, "0"), field: "pe_ttm", value: 50, unit: "倍", period: "2026-08-21", adjustment: "none", source: "tencent" }, ...extra]);
    writeJson(path.join(runs, id, "stages", "valuation.json"), { stage: "valuation", standard_columns: { pe_deducted_x4: "calc-1111111111111111", forward_pe: "未获取:x" } });
    fs.writeFileSync(path.join(runs, id, "report.md"), "# r\n");
  };
  mk("a1", "300308", "2026-08-20T10:00:00+08:00", 900);
  mk("a2", "300308", "2026-08-21T10:00:00+08:00", 943, [{ id: "ev-new0001", field: "announcement_title", value: "半年报", unit: "text", period: "2026-08-21", adjustment: "not_applicable", record_key: "k1", source: "szse" }]);
  mk("b1", "002463", "2026-08-21T11:00:00+08:00", 30);
  return repo;
}

test("batch:汇总只转录各运行产物;runner 注入不真跑;非法代码记错", () => {
  const repo = repoWithRuns();
  const calls: string[][] = [];
  const r = runBatch({ symbols: ["300308", "../x"], market: "SZ", endpoints: "core", knowledge: "off", batchId: "bt1", repoRoot: repo, python: "python3",
    runner: (argv) => { calls.push(argv); const id = argv[argv.indexOf("--run-id") + 1]; fs.mkdirSync(path.join(repo, ".local", "runs", id), { recursive: true }); writeJson(path.join(repo, ".local", "runs", id, "manifest.json"), { status: "complete", evidence_count: 3, calculation_count: 1, evidence_conflicts: [] }); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--endpoints") && calls[0].includes("core") && calls[0].includes("--knowledge") && calls[0].includes("off") && calls[0].includes("--market"));
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].status, "complete");
  assert.equal(r.items[1].error, "非法代码");
  assert.throws(() => runBatch({ symbols: ["300308"], market: "XX", repoRoot: repo, runner: () => ({ status: 0 }) }), /非法市场/);
  assert.throws(() => runBatch({ symbols: ["300308"], endpoints: "all" as never, repoRoot: repo, runner: () => ({ status: 0 }) }), /endpoints/);
  const md = fs.readFileSync(path.join(r.dir, "summary.md"), "utf8");
  assert.ok(md.includes("bt1-300308") && md.includes("非法代码") && !md.includes("建仓"));
  const it = collectRun(path.join(repo, ".local", "runs", "a2"), "300308", "a2", 0, 1000);
  assert.equal(it.standard_columns?.pe_deducted_x4, "calc-1111111111111111");
  assert.ok(batchSummaryMarkdown("x", [it]).includes("calc-1111111111111111"));
});

test("HTTP 变化提醒沿用当前数据根且只读，不读取或覆盖默认用户档案", (t) => {
  const repo = repoWithRuns();
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "vra-alert-isolated-"));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(isolated, { recursive: true, force: true }); });
  const ctx = { repoRoot: repo, dataRoot: isolated, python: "python3", node: process.execPath, providerEnvKey: null };
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), e => e instanceof ServiceError && e.code === "need_two_runs");
  assert.ok(!fs.existsSync(path.join(repo, ".local", "alerts")));
  fs.cpSync(path.join(repo, ".local", "runs"), path.join(isolated, "runs"), { recursive: true });
  const evidence = [{ id: "ev-isolated", field: "price", value: "ISOLATED_CANARY", unit: "元", period: "p", source: "test" }];
  writeJson(path.join(isolated, "runs", "a2", "evidence.json"), evidence);
  const result = evidenceAlerts(ctx, { symbol: "300308", market: "SZ" });
  assert.ok(JSON.stringify(result).includes("ISOLATED_CANARY"));
  assert.ok(!fs.existsSync(path.join(repo, ".local", "alerts")));
  assert.ok(!fs.existsSync(path.join(isolated, "alerts")), "GET 不应写入比较归档");
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308", base: "../outside", next: "a2" }), /非法 run-id/);
  fs.unlinkSync(path.join(isolated, "runs", "a2", "evidence.json"));
  fs.symlinkSync(path.join(repo, ".local", "runs", "a2", "evidence.json"), path.join(isolated, "runs", "a2", "evidence.json"));
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), /符号链接/);
  fs.unlinkSync(path.join(isolated, "runs", "a2", "manifest.json"));
  fs.symlinkSync(path.join(repo, ".local", "runs", "a2", "manifest.json"), path.join(isolated, "runs", "a2", "manifest.json"));
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), /符号链接/);
});

test("alerts:按事实键对齐两次运行;只列两值;默认取同标的最近两次;输出落 .local/alerts", () => {
  const repo = repoWithRuns();
  const runs = path.join(repo, ".local", "runs");
  assert.deepEqual(pickRuns(runs, "300308"), ["a1", "a2"]);
  const base = JSON.parse(fs.readFileSync(path.join(runs, "a1", "evidence.json"), "utf8"));
  const next = JSON.parse(fs.readFileSync(path.join(runs, "a2", "evidence.json"), "utf8"));
  const d = diffEvidence(base, next);
  assert.deepEqual(d.map((x) => [x.kind, x.field]), [["added", "announcement_title"], ["changed", "price"]]);
  const md = alertsMarkdown("300308", "a1", "a2", d);
  assert.ok(md.includes("900") && md.includes("943") && !/变化率|涨幅|%/.test(md.split("\n").slice(6).join("\n")), "只并列两值,不算变化率");
  const r = runAlerts({ symbol: "300308", market: "SZ", repoRoot: repo });
  assert.equal(r.base, "a1"); assert.equal(r.next, "a2"); assert.equal(r.diffs.length, 2);
  assert.ok(fs.existsSync(r.file) && r.file.includes(path.join(".local", "alerts", "SZ_300308")));
  assert.throws(() => runAlerts({ symbol: "002463", repoRoot: repo }), /不足两个/);
  // 显式指定跨标的 / 跨市场 / 同一运行 → 拒绝
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a1", next: "b1" }), /主体是 002463/);
  assert.throws(() => runAlerts({ symbol: "300308", market: "SH", repoRoot: repo, base: "a1", next: "a2" }), /市场是 SZ/);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a2", next: "a2" }), /同一运行/);
  assert.throws(() => runAlerts({ symbol: "../x", repoRoot: repo }), /非法代码/);
  // 省略 market:同代码不同市场的运行不得互比(以 base 运行市场为准)
  fs.mkdirSync(path.join(runs, "c1"), { recursive: true });
  writeJson(path.join(runs, "c1", "manifest.json"), { run_id: "c1", symbol: "300308", market: "SH", status: "complete", finished_at: "2026-08-22T10:00:00+08:00", started_at: "x" });
  writeJson(path.join(runs, "c1", "evidence.json"), []);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a2", next: "c1" }), /市场是 SH/);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo }), /市场是/);  // 默认挑最近两次 a2(SZ) 与 c1(SH) → 市场不同拒绝
  assert.equal(runAlerts({ symbol: "300308", market: "SZ", repoRoot: repo }).next, "a2");  // 指定市场则只在 SZ 内挑
  // 同字段多源:按来源各自对齐,不静默取舍;同源同键重复 → 拒绝
  const multi = diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "2026-08-21", source: "tencent" }, { id: "ev-2", field: "pe_ttm", value: 52, unit: "倍", period: "2026-08-21", source: "baostock" }],
    [{ id: "ev-3", field: "pe_ttm", value: 51, unit: "倍", period: "2026-08-21", source: "tencent" }, { id: "ev-4", field: "pe_ttm", value: 52, unit: "倍", period: "2026-08-21", source: "baostock" }]);
  assert.deepEqual(multi.map((d) => [d.kind, d.base?.source]), [["changed", "tencent"]]);
  assert.throws(() => diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }, { id: "ev-2", field: "pe_ttm", value: 51, unit: "倍", period: "p", source: "s" }], []), /同源同键但值不同/);
  // 同源同键同值(两个端点报同一事实)→ 去重不报错
  const same = diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }, { id: "ev-2", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }], [{ id: "ev-3", field: "pe_ttm", value: 52, unit: "倍", period: "p", source: "s" }]);
  assert.deepEqual(same.map((d) => [d.kind, d.base?.id]), [["changed", "ev-1"]]);
});
