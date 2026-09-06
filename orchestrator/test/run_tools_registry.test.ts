import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册(writeReport 要读 reportStage)
import { RUN_TOOLS, RunToolsError, callRunTool, runToolsAsFunctionSpecs, type RunToolsContext } from "../src/run_tools.ts";
import { calcRecordSchema } from "../src/schemas.ts";

/**
 * **工具 registry 的一致性棘轮**(双引擎方案 v2 第 3 步)。
 *
 * 受控工具是模型在一次运行里能做的**全部**动作。Codex 走 MCP、直连走 function calling ——
 * 两条路如果各自维护一份工具表,迟早有一边漏掉入参校验,而**漏掉的那边不会报错**,
 * 只会开始接受本该被拒的参数。
 *
 * 🔴 所以这里钉的不是"两个分发器碰巧调了同一个函数"(那挡不住 schema 分叉),
 *    而是**两条路都必须从同一份 registry 生成、经同一个 callRunTool 入口执行**。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(HERE, "..", "src", "finance", "run_tools_mcp.ts");
/** 产品根:calc/cli.py 在它下面 */
const REPO = path.resolve(HERE, "..", "..");

/** 不碰磁盘:参数校验发生在触碰文件系统之前 */
const fakeCtx: RunToolsContext = { runDir: path.join(HERE, "__no_such_run__"), repoRoot: HERE, python: "python3" };

test("MCP 入口不得自己写死工具名 —— 必须遍历 registry 生成", () => {
  const code = fs.readFileSync(MCP_ENTRY, "utf8");
  // 写死的注册长这样:registerTool("list_run_files", {...})。允许的只有 registerTool(def.name, ...)。
  const hardcoded = [...code.matchAll(/registerTool\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [],
    `run_tools_mcp.ts 里出现了写死工具名的注册:${hardcoded.join(", ")}。\n` +
    "这会让 MCP 与直连各有一份 schema —— 请改成遍历 RUN_TOOLS。");
  assert.match(code, /for\s*\(\s*const\s+\w+\s+of\s+RUN_TOOLS\s*\)/, "MCP 入口没有从 RUN_TOOLS 生成工具");
  assert.match(code, /callRunTool\(/, "MCP handler 没走 callRunTool —— 那就绕开了两条路共用的那次校验");
});

test("registry 的每份 schema 都能转成 function calling 参数表(直连要用)", () => {
  const specs = runToolsAsFunctionSpecs();
  assert.equal(specs.length, RUN_TOOLS.length, "转换后工具数量对不上");
  for (const s of specs) {
    assert.ok(s.name && s.description, `${s.name}:缺名称或描述`);
    assert.equal((s.parameters as { type?: string }).type, "object", `${s.name}:参数表不是 object`);
  }
  // 抽一个有约束的:read_run_file 的 path 必填、offset 是整数
  const read = specs.find((s) => s.name === "read_run_file");
  assert.ok(read, "registry 里没有 read_run_file");
  const p = read.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
  assert.deepEqual(p.required, ["path"], "read_run_file 的必填项应当只有 path");
  assert.equal(p.properties?.offset?.type, "integer", "offset 应当是整数(约束必须一起带过去,不能只剩键名)");
});

test("callRunTool 按 registry 的 schema 校验参数(谁也别想绕开这次校验)", () => {
  // 类型错:必须在碰磁盘之前就被拒
  assert.throws(() => callRunTool(fakeCtx, "read_run_file", { path: 123 }),
    (e: unknown) => e instanceof RunToolsError && e.code === "bad_arguments",
    "path 传了数字却没被 schema 拦下");
  // 缺必填项
  assert.throws(() => callRunTool(fakeCtx, "read_run_file", {}),
    (e: unknown) => e instanceof RunToolsError && e.code === "bad_arguments");
  // 越界:limit_chars 超上限
  assert.throws(() => callRunTool(fakeCtx, "read_run_file", { path: "fetch/a.json", limit_chars: 999_999_999 }),
    (e: unknown) => e instanceof RunToolsError && e.code === "bad_arguments");
  // 未知工具名要明确报错,不能静默当成别的工具
  assert.throws(() => callRunTool(fakeCtx, "rm_rf", {}),
    (e: unknown) => e instanceof RunToolsError && e.code === "unknown_tool");
  // 参数合法则放行到实现层(这里因为路径不在白名单里被实现层拒 —— 说明确实走过了 schema 这一关)
  assert.throws(() => callRunTool(fakeCtx, "read_run_file", { path: "../../etc/passwd" }),
    (e: unknown) => e instanceof RunToolsError && e.code === "path_not_allowed");
});

test("calculate 引用格式必须在访问运行目录或启动计算器前校验", () => {
  const base = { function: "ratio", args: { numerator: 1, denominator: 4 }, output_file: "01_ratio.json" };
  for (const field of ["evidence_ids", "calculation_ids"] as const) {
    const valid = field === "evidence_ids" ? "ev-abcdef" : "calc-0123456789abcdef";
    const wrongKind = field === "evidence_ids" ? "calc-0123456789abcdef" : "ev-abcdef";
    for (const invalid of ["", "19_tech.json", "--help", " ev-abcdef", "ev-ABCDEf", "calc-0123456789abcde", wrongKind]) {
      assert.throws(() => callRunTool(fakeCtx, "calculate", { ...base, [field]: [valid, invalid] }),
        (e: unknown) => e instanceof RunToolsError && e.code === "bad_arguments" && e.message.includes(field),
        `${field} 中的 ${JSON.stringify(invalid)} 应在触碰文件系统前被拒绝`);
    }
  }
  for (const refs of [{}, { evidence_ids: [], calculation_ids: [] },
    { evidence_ids: ["ev-abcdef", "ev-0123456789ab"], calculation_ids: ["calc-0123456789abcdef"] }]) {
    assert.throws(() => callRunTool(fakeCtx, "calculate", { ...base, ...refs }),
      (e: unknown) => e instanceof RunToolsError && e.code === "turn_context_missing",
      "合法或省略的引用应通过参数校验，才进入运行上下文检查；这里不声明引用已经存在");
  }
  const specs = runToolsAsFunctionSpecs().find(s => s.name === "calculate")!;
  const properties = specs.parameters.properties as Record<string, { items: { pattern: string } }>;
  for (const variant of calcRecordSchema.properties.inputs_refs.items.oneOf) {
    const field = variant.properties.ref_type.const === "evidence" ? "evidence_ids" : "calculation_ids";
    assert.equal(properties[field].items.pattern, variant.properties.ref_id.pattern,
      "MCP/直连共用的输入 schema 必须与落盘计算契约同一口径");
  }
});

test("🔴 calculate 的 function=list 要被拒,并把可用函数清单告诉模型", () => {
  // 2026-09-04 真踩:模型想知道有哪些计算函数,就把 function 传成了 "list"。
  // calc/cli.py 对 list 打印的是**函数清单**(合法 JSON、退出码 0),于是那份"不是计算记录"的
  // 东西被写进 calcs/,validator 读到它直接崩。模型的意图是正当的,缺口在我们这边 ——
  // 所以不是简单拒绝,而是**把清单给它**,只是不写盘。
  const runDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vra-calclist-"));
  fs.mkdirSync(path.join(runDir, ".vibe"), { recursive: true });
  fs.writeFileSync(path.join(runDir, ".vibe", "hook-context.json"), JSON.stringify({
    stage: "profile", attempt: 1, run_id: "t", repo_root: REPO, data_root: runDir, run_dir: runDir,
    python: "python3", scripts_rel: "scripts", forbidden_path_patterns: [], allowed_path_prefixes: [], written_at: new Date().toISOString(),
  }));
  try {
    const ctx = { runDir, repoRoot: REPO, python: process.env.VRA_PYTHON ?? "python3" };
    assert.throws(
      () => callRunTool(ctx, "calculate", { function: "list", args: {}, output_file: "00_list.json" }),
      (e: unknown) => e instanceof RunToolsError && e.code === "not_a_calculation" && /可用的计算函数/.test(e.message),
      "list 不是计算函数,必须拒绝并给出可用清单");
    assert.ok(!fs.existsSync(path.join(runDir, "calcs", "00_list.json")),
      "被拒的调用不许留下文件 —— 那份文件正是让 validator 崩掉的元凶");
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});

test("工具集稳定:名字唯一,且只有这五件事", () => {
  const names = RUN_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "工具名有重复 —— 后注册的会静默覆盖前一个");
  assert.deepEqual([...names].sort(),
    ["calculate", "list_run_files", "read_run_file", "write_report", "write_stage"],
    "受控工具集变了。这是模型在一次运行里能做的**全部**动作,增删都要先想清楚边界。");
  // 写类工具必须声明为独占:它们都是"读—检查—写"多步,异步化之后会真的竞态
  for (const t of RUN_TOOLS) {
    const isWriter = t.name.startsWith("write_") || t.name === "calculate";
    if (isWriter) assert.equal(t.concurrency, "exclusive", `${t.name} 是写类工具,必须声明 exclusive`);
  }
});
