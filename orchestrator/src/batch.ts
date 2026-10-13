#!/usr/bin/env node
/**
 * 批量研究(Phase 1 M3):多个主体顺序跑完整研究(每个独立 run-id,互不影响),汇总到 .local/batches/<batch-id>/summary.md + summary.json。
 * 汇总只转录各运行的状态 / 标准产出列的 calc id / 证据数 / 冲突数 / 报告路径,不做任何横向数值比较(派生量归 calc)。
 * 用法:node orchestrator/src/batch.ts --symbols 300308,002463 [--provider <AI 来源>] [--model m] [--market SZ] [--endpoints full|core] [--knowledge on|off] [--python P] [--batch-id X] [--no-agent] [--overwrite]
 * 大脑:不传 --provider 就用后台默认(<数据根>/config.json 的 provider.profile 或环境变量 VRA_PROVIDER);--model 只对模型 API 有效。
 */
import { currentPlugin } from "./plugin.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RUN_ID_RE } from "./config.ts";
import { readJsonIfExists, writeJson } from "./fsutil.ts";
import { assertNoRemovedFlags, optionValue, parseArgs } from "./run.ts";
import { assertKnowledgeFlag, assertMarket, assertScope, repoRootFromHere, researchEnv, researchRuntimeEnv, serviceContext } from "./service.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export interface BatchItem { symbol: string; run_id: string; exit_code: number | null; status: string | null; evidence_count: number | null; calculation_count: number | null; conflicts: number | null; standard_columns: Record<string, string> | null; report: string | null; viewer: string | null; duration_ms: number; error?: string }

/** 标准列与表头显示名**由插件提供** —— 换个垂类这张表的列完全不同 */
const cols = (): readonly string[] => currentPlugin().standardColumns;
const label = (k: string): string => currentPlugin().standardColumnLabels[k] ?? k;

export function batchSummaryMarkdown(batchId: string, items: BatchItem[]): string {
  const L = [`# 批量研究汇总 · ${batchId}`, "", "> 只转录各运行产物(状态 / 标准产出列 calc id / 证据与冲突数),不做横向比较;每个主体的结论以其 report.md 为准。", "",
    `| 主体 | run_id | 状态 | 退出码 | 证据 | 计算 | 冲突 | ${cols().map((k) => label(k)).join(" | ")} | 耗时 s |`,
    `|${"---|".repeat(7 + cols().length + 1)}`];
  for (const it of items) {
    const sc = it.standard_columns ?? {};
    const c = (k: string) => String(sc[k] ?? "-").slice(0, 40);
    L.push(`| ${it.symbol} | ${it.run_id} | ${it.status ?? it.error ?? "?"} | ${it.exit_code ?? "-"} | `
      + `${it.evidence_count ?? "-"} | ${it.calculation_count ?? "-"} | ${it.conflicts ?? "-"} | `
      + `${cols().map((k) => c(k)).join(" | ")} | ${Math.round(it.duration_ms / 1000)} |`);
  }
  L.push("", "报告:", ...items.map((it) => `- ${it.symbol}: ${it.report ?? "(无)"}${it.viewer ? ` · 查看器 ${it.viewer}` : ""}`));
  return L.join("\n") + "\n";
}

/** 子进程正常结束的退出码:0 = 完整,2 = 不完整 / 数据过期(见 orchestrate.exitCodeFor);其余一律算失败 */
const FINISHED_EXIT = new Set([0, 2]);
/** 文件时间的粒度(有的文件系统只到秒级):清单写入时间早于开跑时刻这么多以上,才判定为旧运行留下的 */
const MTIME_SLACK_MS = 2000;

/**
 * 汇总一个主体的运行结果。
 * 🔴 传了 startedAt 时,只认**本次子进程写出的**清单:同一个 run-id 重跑被拒(目录非空,退出码 3)时,
 *    目录里还躺着上次 complete 的清单和报告 —— 不能拿它们当本次结果(审计 A12)。
 */
export function collectRun(runDir: string, symbol: string, runId: string, exitCode: number | null, durationMs: number, error?: string, startedAt?: number): BatchItem {
  const manifestPath = path.join(runDir, "manifest.json");
  const fresh = startedAt === undefined || (() => {
    try { return fs.statSync(manifestPath).mtimeMs >= startedAt - MTIME_SLACK_MS; } catch { return false; }
  })();
  const finished = startedAt === undefined || (exitCode !== null && FINISHED_EXIT.has(exitCode));
  const m0 = fresh ? readJsonIfExists<Record<string, unknown>>(manifestPath) : null;
  if (!m0 || (!finished && m0.status !== "failed")) {
    const why = !m0 ? "没有找到本次运行写出的清单" : `运行没有正常结束(退出码 ${exitCode ?? "无,进程被中断"})`;
    const own = m0 ? { evidence_count: (m0.evidence_count as number) ?? null, calculation_count: (m0.calculation_count as number) ?? null } : { evidence_count: null, calculation_count: null };
    return { symbol, run_id: runId, exit_code: exitCode, status: "failed", ...own, conflicts: null, standard_columns: null,
      report: null, viewer: null, duration_ms: durationMs, error: error ?? why };
  }
  const m = m0;
    // 标准列住在哪个阶段的产物里,**由插件说了算**。
  // 🔴 这里原本硬编码 `"valuation.json"` —— 纯净度词表全是中文与几个缩写,**看不见英文阶段名**,
  //    所以它一路躲过了棘轮。词表只测得到它认识的词(见 core_purity.test.ts 顶部的说明)。
  const val = readJsonIfExists<Record<string, unknown>>(path.join(runDir, "stages", `${currentPlugin().standardColumnsStage}.json`));
  return { symbol, run_id: runId, exit_code: exitCode, status: (m?.status as string) ?? null, evidence_count: (m?.evidence_count as number) ?? null, calculation_count: (m?.calculation_count as number) ?? null,
    conflicts: Array.isArray(m?.evidence_conflicts) ? (m!.evidence_conflicts as unknown[]).length : null, standard_columns: (val?.standard_columns as Record<string, string>) ?? null,
    report: fs.existsSync(path.join(runDir, "report.md")) ? path.join(runDir, "report.md") : null, viewer: fs.existsSync(path.join(runDir, "viewer.html")) ? path.join(runDir, "viewer.html") : null, duration_ms: durationMs, ...(error ? { error } : {}) };
}

/** 批次退出码:有任何一项失败、出错或拿不到状态 → 2;否则 0 */
export function batchExitCode(items: readonly BatchItem[]): number {
  return items.some((i) => i.status === "failed" || i.status === null || i.error) ? 2 : 0;
}

export function runBatch(opts: { symbols: string[]; market?: string; endpoints?: "full" | "core"; knowledge?: "on" | "off"; python?: string; batchId?: string; noAgent?: boolean; overwrite?: boolean; repoRoot?: string;
  /** 命令行对后台默认的临时覆盖;不传就用后台默认 */
  provider?: string; model?: string;
  /** 测试注入:不真拉起子进程;env 是本来要交给子进程的那份(含来源描述) */
  runner?: (argv: string[], env: NodeJS.ProcessEnv) => { status: number | null } }): { batchId: string; dir: string; items: BatchItem[] } {
  const ctx = serviceContext({ repoRoot: opts.repoRoot, python: opts.python });
  const market = assertMarket(opts.market);
  const scope = assertScope(opts.endpoints);
  const kn = assertKnowledgeFlag(opts.knowledge);
  const batchId = opts.batchId ?? `batch-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  if (!RUN_ID_RE.test(batchId)) throw new Error(`非法 batch-id ${batchId}`);
  // 大脑在批次开始前解析一次(后台默认 AI 来源,或 --provider / --model 临时覆盖):没配 / 缺 key 当场报错,
  // 不跑出一整排失败的运行。每个子进程拿到的是同一份来源描述,与服务层拉起单次研究同一条交接路径。
  const childEnv: NodeJS.ProcessEnv = {
    ...researchEnv(),
    ...(opts.noAgent ? {} : researchRuntimeEnv(ctx, undefined, process.env, { providerOverride: opts.provider, model: opts.model })),
  };
  const dir = path.join(ctx.dataRoot, "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  const items: BatchItem[] = [];
  const flush = () => { writeJson(path.join(dir, "summary.json"), { batch_id: batchId, items }); fs.writeFileSync(path.join(dir, "summary.md"), batchSummaryMarkdown(batchId, items)); };
  for (const symRaw of opts.symbols) {
    const symbol = symRaw.trim();
    if (!/^[A-Za-z0-9.\-]{1,12}$/.test(symbol)) { items.push({ symbol, run_id: "-", exit_code: null, status: null, evidence_count: null, calculation_count: null, conflicts: null, standard_columns: null, report: null, viewer: null, duration_ms: 0, error: "非法代码" }); flush(); continue; }
    const runId = `${batchId}-${symbol}`;
    const runDir = path.join(ctx.dataRoot, "runs", runId);
    const argv = [path.join(ctx.repoRoot, "orchestrator", "src", "run.ts"), "--symbol", symbol, "--run-id", runId, "--python", ctx.python, "--endpoints", scope, "--knowledge", kn];
    if (market) argv.push("--market", market);
    if (opts.noAgent) argv.push("--no-agent");
    if (opts.overwrite) argv.push("--overwrite");
    const t0 = Date.now();
    const r = opts.runner ? opts.runner(argv, childEnv) : spawnSync(process.execPath, argv, { cwd: ctx.repoRoot, stdio: ["ignore", "inherit", "inherit"], env: childEnv, windowsHide: true });  // 最小环境:基础 + VRA_* + 本次大脑的登录上下文或 key
    items.push(collectRun(runDir, symbol, runId, r.status, Date.now() - t0, undefined, t0));
    flush();  // 每跑完一个就落盘,中断也有部分汇总
  }
  flush();
  return { batchId, dir, items };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  assertNoRemovedFlags(a);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const symbols = (str(a.symbols) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) { console.error("用法:node orchestrator/src/batch.ts --symbols 300308,002463 [--provider <AI 来源>] [--model m] [--market SZ] [--endpoints full|core] [--knowledge on|off] [--python P] [--batch-id X] [--no-agent] [--overwrite]"); process.exit(2); }
  const r = runBatch({ symbols, provider: optionValue(a, "provider"), model: optionValue(a, "model"), market: str(a.market), endpoints: str(a.endpoints) as "full" | "core" | undefined, knowledge: str(a.knowledge) as "on" | "off" | undefined, python: str(a.python), batchId: str(a["batch-id"]), noAgent: a["no-agent"] === true, overwrite: a.overwrite === true, repoRoot: str(a["repo-root"]) ?? repoRootFromHere() });
  console.error(`[batch] ${r.batchId} done → ${r.dir}/summary.md`);
  process.exit(batchExitCode(r.items));
}

if (process.argv[1] && process.argv[1].endsWith("batch.ts")) main().catch((e) => { console.error(`[batch] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
