/**
 * **受控工具运行时**(Core):一次运行里,模型能做的全部动作就这五件。
 *
 * 列产物 / 读产物 / 调确定性计算器 / 写当前阶段 / 写报告 —— 没有 Shell、没有网络、没有任意文件访问。
 * 换个垂类(餐饮、法务…)这五件事一行都不用重写,所以它们属于 Core;
 * 具体能算什么(calc 函数)、阶段叫什么名字,才是垂类的事。
 *
 * 🔴 **为什么要有 registry,而不是两个引擎各写一套分发**:
 *    入参 schema 必须**只有一份**。Codex 走 MCP、直连走 function calling,
 *    如果各自手写一套工具表,迟早有一边漏掉校验 —— 而漏掉的那边**不会报错**,
 *    只会开始接受本该被拒的参数。测试断言"两个分发器恰好调了同一个函数"挡不住这个,
 *    只有**共同生成**才是结构性保证:两条路都必须经 `callRunTool()` 这一个入口。
 *
 * ⚠️ 本文件从 finance/run_tools_mcp.ts 搬来,实现逐字保持(它已在 Windows 研究链路上跑通并过 CI)。
 *    那个路径仍然存在(runner.ts 按路径把它当 MCP 服务器拉起),现在是一层薄入口。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { atomicWrite, readJsonIfExists, writeJson } from "./fsutil.ts";
import { readHookContext } from "./hooks.ts";
import { currentPlugin } from "./plugin.ts";
import { calcRecordSchema, validateStageOutput } from "./schemas.ts";

export const MAX_READ_CHARS = 1_000_000;
const CALC_FILE_RE = /^\d{2}_[a-z0-9][a-z0-9_]{0,80}\.json$/;
const CALC_FUNCTION_RE = /^[a-z][a-z0-9_]{0,80}$/;
const CALC_OWNERS_REL = path.join(".vibe", "calc-owners.json");

/** 与落盘契约共用引用格式，让模型在工具调用时修正，而不是等整个阶段结束。 */
function referenceIdSchema(kind: "evidence" | "calculation") {
  const variant = calcRecordSchema.properties.inputs_refs.items.oneOf.find(v => v.properties.ref_type.const === kind);
  if (!variant) throw new Error(`计算契约缺少引用类型:${kind}`);
  return z.string().regex(new RegExp(variant.properties.ref_id.pattern));
}

export interface RunToolsContext {
  runDir: string;
  repoRoot: string;
  python: string;
}

export class RunToolsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RunToolsError"; this.code = code; }
}

/**
 * 当前阶段来自磁盘上的 turn 上下文,**不是**函数入参 —— 编排器每个 turn 前写一次。
 * 这样模型无法自称在别的阶段:它连"我是哪个阶段"都不是自己说了算。
 */
function currentStage(ctx: RunToolsContext): string {
  const turn = readHookContext(ctx.runDir);
  if (!turn?.stage || path.resolve(turn.run_dir) !== path.resolve(ctx.runDir)) {
    throw new RunToolsError("turn_context_missing", "当前阶段上下文缺失或与运行目录不一致");
  }
  return turn.stage;
}

function safeReadable(ctx: RunToolsContext, rel: string): string {
  const normalized = String(rel ?? "").replaceAll("\\", "/");
  const allowed = normalized === "conflicts.json" || normalized === "report.md" ||
    /^(fetch|calcs|stages)\/[A-Za-z0-9._-]+\.json$/.test(normalized);
  if (!allowed || normalized.includes("..")) throw new RunToolsError("path_not_allowed", `不允许读取:${rel}`);
  const target = path.resolve(ctx.runDir, ...normalized.split("/"));
  const root = path.resolve(ctx.runDir);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
    throw new RunToolsError("file_unavailable", `文件不存在或不是普通文件:${rel}`);
  }
  return target;
}

function boundedText(text: string, offset = 0, limit = 200_000): { text: string; offset: number; next_offset: number | null; total_chars: number } {
  const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, text.length));
  const size = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200_000, MAX_READ_CHARS));
  const end = Math.min(text.length, start + size);
  return { text: text.slice(start, end), offset: start, next_offset: end < text.length ? end : null, total_chars: text.length };
}

export function listRunFiles(ctx: RunToolsContext): { files: { path: string; bytes: number }[]; stage: string } {
  const files: { path: string; bytes: number }[] = [];
  for (const dir of ["fetch", "calcs", "stages"]) {
    const base = path.join(ctx.runDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((x) => /^[A-Za-z0-9._-]+\.json$/.test(x)).sort()) {
      const file = path.join(base, name);
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink()) files.push({ path: `${dir}/${name}`, bytes: st.size });
    }
  }
  for (const name of ["conflicts.json", "report.md"]) {
    const file = path.join(ctx.runDir, name);
    if (fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) files.push({ path: name, bytes: fs.statSync(file).size });
  }
  return { files, stage: currentStage(ctx) };
}

export function readRunFile(ctx: RunToolsContext, rel: string, offset?: number, limit?: number): ReturnType<typeof boundedText> & { path: string } {
  const file = safeReadable(ctx, rel);
  const text = fs.readFileSync(file, "utf8");
  return { path: rel.replaceAll("\\", "/"), ...boundedText(text, offset, limit) };
}

export function runCalculation(ctx: RunToolsContext, input: {
  function: string; args: Record<string, unknown>; evidence_ids?: string[]; calculation_ids?: string[]; output_file: string;
}): Record<string, unknown> {
  const stage = currentStage(ctx);
  if (!CALC_FUNCTION_RE.test(input.function)) throw new RunToolsError("bad_function", "计算函数名格式非法");
  // 🔴 `list` 是计算器的**元命令**,不是计算函数:它打印函数清单(合法 JSON、退出码 0),
  //    照写进 calcs/ 就是一份没有 output 字段的假记录,validator 读到它会当场崩。
  //    ⇒ 拒绝写盘,但**把清单给模型** —— 它想知道有哪些函数是正当需求,尤其在拿不到
  //      方法论说明的通道里(2026-09-04 真踩:模型正是这么试探的)。
  if (input.function === "list") {
    let available = "(清单获取失败)";
    try {
      const probe = spawnSync(ctx.python, [path.join(ctx.repoRoot, "calc", "cli.py"), "list"],
        { cwd: ctx.runDir, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      const fns = (JSON.parse(probe.stdout || "{}") as { functions?: Record<string, string> }).functions;
      if (fns) available = Object.keys(fns).join(", ");
    } catch { /* 拿不到就如实说拿不到,不编 */ }
    throw new RunToolsError("not_a_calculation",
      `list 是计算器的元命令,不产生计算记录,因此不会写入 calcs/。可用的计算函数:${available}。` +
      "请改用其中一个具体函数,并给出它需要的 args 与 evidence_ids。");
  }
  if (!CALC_FILE_RE.test(input.output_file)) throw new RunToolsError("bad_output_file", "output_file 必须形如 NN_name.json(两位数字 + 下划线 + 小写标识符)");
  const calcDir = path.join(ctx.runDir, "calcs");
  fs.mkdirSync(calcDir, { recursive: true });
  const scratchDir = path.join(ctx.runDir, ".vibe");
  fs.mkdirSync(scratchDir, { recursive: true });
  const ownersFile = path.join(ctx.runDir, CALC_OWNERS_REL);
  const owners = readJsonIfExists<Record<string, string>>(ownersFile) ?? {};
  const target = path.join(calcDir, input.output_file);
  if (fs.existsSync(target) && owners[input.output_file] !== stage) {
    throw new RunToolsError("calc_owned_by_other_stage", `${input.output_file} 已由 ${owners[input.output_file] ?? "先前运行"} 阶段创建，当前 ${stage} 阶段不得覆盖`);
  }
  const argsFile = path.join(scratchDir, `calc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeJson(argsFile, input.args ?? {});
  const cli = path.join(ctx.repoRoot, "calc", "cli.py");
  const argv = [cli, input.function, "--args-file", argsFile, "--run-dir", ctx.runDir];
  if (input.evidence_ids?.length) argv.push("--evidence", ...input.evidence_ids);
  if (input.calculation_ids?.length) argv.push("--calc", ...input.calculation_ids);
  let proc;
  try {
    proc = spawnSync(ctx.python, argv, { cwd: ctx.runDir, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } finally {
    try { fs.unlinkSync(argsFile); } catch { /* best effort */ }
  }
  if (proc.error) throw new RunToolsError("calc_start_failed", `计算器无法启动:${proc.error.message}`);
  let record: Record<string, unknown>;
  try { record = JSON.parse(proc.stdout || "") as Record<string, unknown>; }
  catch { throw new RunToolsError("calc_bad_output", `计算器未返回合法 JSON(退出码 ${proc.status ?? "unknown"})`); }
  // ⚠️ **刻意不按退出码拒收**:calc/cli.py 对 `not_meaningful` 退 2、对 error/bad_args 退 3,
  //    但这两种情况都会打印结构完整的记录。它们**应该**落盘 —— 那是审计痕迹,
  //    而 validator 负责不把它们当有效计算(validator.ts:279 起:"只收没有失败的;
  //    output.status=error 的记录也带着合法 calculation_id 与函数名")。
  //    ⇒ 在这里加退出码拦截,反而会让失败的计算在账本上凭空消失。改这段前先读那一段。
  atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`);
  owners[input.output_file] = stage;
  writeJson(ownersFile, owners);
  return record;
}

export function writeStageOutput(ctx: RunToolsContext, stageOutput: Record<string, unknown>): { written: string; stage: string } {
  const stage = currentStage(ctx);
  if (stageOutput.stage !== stage) throw new RunToolsError("wrong_stage", `当前阶段是 ${stage}，不能写 ${String(stageOutput.stage)}`);
  const errors = validateStageOutput(stage, stageOutput);
  if (errors.length) throw new RunToolsError("stage_schema_invalid", errors.slice(0, 8).join("; "));
  const rel = `stages/${stage}.json`;
  writeJson(path.join(ctx.runDir, ...rel.split("/")), stageOutput);
  return { written: rel, stage };
}

export function writeReport(ctx: RunToolsContext, markdown: string, stageOutput?: Record<string, unknown>): { written: string[] } {
  const stage = currentStage(ctx);
  // 报告阶段由契约给,Core 不写死阶段名(与 orchestrate.ts 同一条规矩,全审 r4)
  const reportStage = currentPlugin().reportStage;
  if (stage !== reportStage) throw new RunToolsError("wrong_stage", `只有 ${reportStage} 阶段可以写报告`);
  if (!markdown.trim() || markdown.length > 2_000_000) throw new RunToolsError("bad_report", "报告为空或超过 2,000,000 字符");
  const stageRel = `stages/${reportStage}.json`;
  if (stageOutput) writeStageOutput(ctx, stageOutput);
  else if (!readJsonIfExists(path.join(ctx.runDir, ...stageRel.split("/")))) throw new RunToolsError("report_stage_missing", "首次写报告必须同时提交 stage_output");
  atomicWrite(path.join(ctx.runDir, "report.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { written: ["report.md", stageRel] };
}

// ─────────────────────────── 工具 registry ───────────────────────────

export interface RunToolDef {
  name: string;
  title: string;
  description: string;
  /** 入参 schema:**唯一真理源**。MCP 直接用它注册,直连用 z.toJSONSchema 转成 function calling 的参数表。 */
  inputShape: z.ZodRawShape;
  /**
   * 并发策略。
   * `exclusive` = 同一运行内必须串行执行。
   * ⚠️ 当前实现全是**同步**的(spawnSync + 同步 fs),JS 单线程下不可能交错,所以此刻它是声明而非机制。
   *    但 `calculate` 的 owner 表是"读—检查—写目标—写 owner"四步,**一旦有人把它改成异步就会真的竞态**。
   *    改成 async 之前必须先在这里加锁 —— 别以为现在没事就永远没事。
   */
  concurrency: "exclusive" | "parallel_safe";
  run: (ctx: RunToolsContext, args: Record<string, unknown>) => unknown;
}

// 先标成 RunToolDef[] 再冻结:直接 `Object.freeze([...])` 会让 TS 把各条目的 inputShape
// 推成"所有键的可选联合",于是每个 shape 都不再满足 ZodRawShape。
const TOOL_DEFS: RunToolDef[] = [
  {
    name: "list_run_files",
    title: "列出本次运行文件",
    description: "列出本次运行可读的 fetch/calcs/stages JSON、冲突集和报告。",
    inputShape: {},
    concurrency: "parallel_safe",
    run: (ctx: RunToolsContext) => listRunFiles(ctx),
  },
  {
    name: "read_run_file",
    title: "读取本次运行文件",
    description: "只读本次运行的净化 JSON 或报告；大文件可用 offset/limit_chars 分段。",
    inputShape: { path: z.string(), offset: z.number().int().min(0).optional(), limit_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional() },
    concurrency: "parallel_safe",
    run: (ctx: RunToolsContext, a: Record<string, unknown>) => readRunFile(ctx, a.path as string, a.offset as number | undefined, a.limit_chars as number | undefined),
  },
  {
    name: "calculate",
    title: "确定性计算",
    description: "调用产品 calc 纯函数并把结果写入 calcs/。所有输入证据和上游 calculation id 必须完整列出。",
    inputShape: {
      function: z.string(), args: z.record(z.string(), z.unknown()),
      evidence_ids: z.array(referenceIdSchema("evidence")).optional(),
      calculation_ids: z.array(referenceIdSchema("calculation")).optional(), output_file: z.string(),
    },
    concurrency: "exclusive",
    run: (ctx: RunToolsContext, a: Record<string, unknown>) => runCalculation(ctx, a as unknown as Parameters<typeof runCalculation>[1]),
  },
  {
    name: "write_stage",
    title: "写当前阶段产物",
    description: "按当前阶段 schema 写 stages/<stage>.json；不能写别的阶段。",
    inputShape: { stage_output: z.record(z.string(), z.unknown()) },
    concurrency: "exclusive",
    run: (ctx: RunToolsContext, a: Record<string, unknown>) => writeStageOutput(ctx, a.stage_output as Record<string, unknown>),
  },
  {
    name: "write_report",
    title: "写研究报告",
    description: "只在 report 阶段写 report.md；首次调用同时提交 report 阶段 JSON，合规重写时可只传 markdown。",
    inputShape: { markdown: z.string(), stage_output: z.record(z.string(), z.unknown()).optional() },
    concurrency: "exclusive",
    run: (ctx: RunToolsContext, a: Record<string, unknown>) => writeReport(ctx, a.markdown as string, a.stage_output as Record<string, unknown> | undefined),
  },
];

export const RUN_TOOLS: readonly RunToolDef[] = Object.freeze(TOOL_DEFS);

export function runToolByName(name: string): RunToolDef {
  const def = RUN_TOOLS.find((t) => t.name === name);
  if (!def) throw new RunToolsError("unknown_tool", `没有这个工具:${name}(可用:${RUN_TOOLS.map((t) => t.name).join(", ")})`);
  return def;
}

/**
 * **两个引擎共用的唯一调用入口**。
 * 先按 registry 里那份 schema 校验入参,再执行 —— 谁也别想绕开校验自己去调实现函数。
 */
export function callRunTool(ctx: RunToolsContext, name: string, rawArgs: unknown): unknown {
  const def = runToolByName(name);
  const parsed = z.object(def.inputShape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("; ");
    throw new RunToolsError("bad_arguments", `${name} 的参数不合法:${detail}`);
  }
  return def.run(ctx, parsed.data as Record<string, unknown>);
}

/** 直连引擎用:把 registry 转成 function calling 的工具表(schema 仍出自同一份 inputShape) */
export function runToolsAsFunctionSpecs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return RUN_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(z.object(t.inputShape)) as Record<string, unknown>,
  }));
}
