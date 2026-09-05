#!/usr/bin/env node
/**
 * Stop 钩子(Codex lifecycle hook,agent 每个 turn 想收工时由 Codex 同步调用;stdin = StopCommandInput JSON,cwd = 运行目录)。
 * 语义 = "缺产物 / 阶段校验不过,不许正常收工":
 *   - 不合格 → {"decision":"block","reason":...},agent 在同一 turn 内继续修(最多 MAX_STOP_BLOCKS 次,以本 (stage, attempt) 的日志计数);
 *   - 拦过 MAX_STOP_BLOCKS 次仍不合格 → 写终止标记 .vibe/stop-failed.json 并输出 {"continue":false,"stopReason":...}:本轮到此为止,
 *     编排器看到标记把这轮判为失败并带着校验错误补跑(不会被当成正常完成);
 *   - 合格 → 放行。
 * 上下文 / cwd 不一致、stdin 解析失败、内部异常 → 放行但一定出声(日志 + stderr),绝不让钩子故障卡死 agent。
 */
import fs from "node:fs";
import path from "node:path";

import { stages, type Stage } from "../src/config.ts";
import { MAX_STOP_BLOCKS, STOP_FAILED_REL, appendHookLog, contextMatchesCwd, readHookContext, readHookLog, readStdin, type StopFailedMarker } from "../src/hooks.ts";
import { writeJson } from "../src/fsutil.ts";
import { loadRun, validateStage } from "../src/validator.ts";


// **composition root**:钩子是独立子进程,也是一个入口 —— 垂类包要在这里注册
import "../src/finance/register.ts";
interface StopInput { cwd: string; stop_hook_active?: boolean; hook_event_name?: string; last_assistant_message?: string | null }

function expectedArtifacts(stage: Stage, runDir: string): string[] {
  const out = [path.join(runDir, "stages", `${stage}.json`)];
  if (stage === "report") out.unshift(path.join(runDir, "report.md"));
  return out;
}

const isRunDir = (d: string) => fs.existsSync(path.join(d, "manifest.json"));

async function main(): Promise<void> {
  let input: StopInput;
  try { input = JSON.parse(await readStdin()) as StopInput; } catch (e) { process.stderr.write(`[vibe stop hook] stdin 不是合法 JSON:${e instanceof Error ? e.message : String(e)}\n`); return; }
  const runDir = input.cwd;
  const ctx = readHookContext(runDir);
  const ts = () => new Date().toISOString();
  if (!ctx || !stages().includes(ctx.stage) || !contextMatchesCwd(ctx, runDir)) {
    if (isRunDir(runDir)) appendHookLog(runDir, { ts: ts(), hook: "stop", decision: "error", reason: !ctx ? "钩子上下文缺失(被删?)" : "钩子上下文与 cwd 不一致(被改?)" });
    process.stderr.write("[vibe stop hook] 无有效钩子上下文,放行\n");
    return;
  }
  const stage = ctx.stage as Stage;
  const problems: string[] = [];
  try {
    for (const f of expectedArtifacts(stage, runDir)) if (!fs.existsSync(f)) problems.push(`缺产物:${path.relative(runDir, f)}`);
    if (!problems.length) {
      const run = loadRun(runDir); // 账本用磁盘审计副本;最终裁判仍是编排器内存账本
      const r = validateStage(stage, run);
      problems.push(...r.errors.filter((e) => !/账本|编排器取数记录/.test(e)).slice(0, 8));
    }
  } catch (e) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "error", reason: e instanceof Error ? e.message : String(e) });
    process.stderr.write(`[vibe stop hook] 校验异常,放行:${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  if (!problems.length) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "allow", stop_hook_active: !!input.stop_hook_active });
    return;
  }
  const log = readHookLog(runDir);
  const priorBlocks = log.filter((e) => e.hook === "stop" && e.decision === "block" && e.stage === stage && e.attempt === ctx.attempt);
  // 推进感知:若上一次拦截之后 calcs/ 有新文件落盘 ⇒ agent 在持续产出中间计算(合规工作流:
  // 攒 N 轮 calc 才写 stage 文件),不是空转,拦截计数从"有推进的那个 block"重新起算;
  // 无推进的连续拦截才累加,空转 MAX_STOP_BLOCKS 次仍不合格才终止本轮。
  // (2026-09-05 600519 run: financials 阶段模型 3-5 轮 calc 全做对,但 stage 文件是最后一步,
  //  写文件前已被 2 次"缺产物"拦截终止本轮,文件在后续轮才补写落盘,编排器又不回头复核 ⇒ 永久 failed)
  const newCalcsSince = (sinceTs: string | undefined): number => {
    if (!sinceTs) return 0;
    const calcDir = path.join(runDir, "calcs");
    if (!fs.existsSync(calcDir)) return 0;
    let n = 0;
    const since = Date.parse(sinceTs);
    for (const f of fs.readdirSync(calcDir)) {
      try { if (fs.statSync(path.join(calcDir, f)).mtimeMs > since) n++; } catch { /* 并发删除,忽略 */ }
    }
    return n;
  };
  let prior = priorBlocks.length;
  for (let i = 1; i < priorBlocks.length; i++) {
    if (newCalcsSince(priorBlocks[i - 1].ts) > 0) prior = priorBlocks.length - i; // 最后一次"有推进的 block"之后的空转次数
  }
  if (prior < MAX_STOP_BLOCKS) {
    const reason = `【Stop 钩子】本阶段(${stage})还不能收工(第 ${prior + 1}/${MAX_STOP_BLOCKS} 次提醒),请先修好再结束本轮:\n- ${problems.join("\n- ")}`.slice(0, 1800);
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "block", reason, stop_hook_active: !!input.stop_hook_active });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  // 拦够次数仍不合格:终止本轮,留标记给编排器(这轮按失败处理并补跑),不算正常收工
  const marker: StopFailedMarker = { stage, attempt: ctx.attempt, problems: problems.slice(0, 8), blocks: priorBlocks.length, ts: ts() };
  writeJson(path.join(runDir, STOP_FAILED_REL), marker);
  const stopReason = `【Stop 钩子】已提醒 ${priorBlocks.length} 次仍不合格,终止本轮交编排器补跑:${problems.slice(0, 3).join("; ")}`.slice(0, 1000);
  appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "stop", reason: stopReason, stop_hook_active: !!input.stop_hook_active });
  process.stdout.write(JSON.stringify({ continue: false, stopReason, systemMessage: stopReason }));
}

main().catch((e) => { process.stderr.write(`[vibe stop hook] 顶层异常,放行:${e instanceof Error ? e.message : String(e)}\n`); }).finally(() => process.exit(0));
