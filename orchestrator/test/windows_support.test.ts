import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { codexEnvFor, interpreterRoot, makeConfig, normalizeInterpreter } from "../src/config.ts";
import { writeHookContext } from "../src/hooks.ts";
import { privateFilePermissions, restrictPrivateFile, sha256File, writeJson } from "../src/fsutil.ts";
import { executableInvocation, findExecutable, LocalAgentError, runLocalAgent } from "../src/local_agent_runtime.ts";
import { CodexRunner, codexOptionsFor, mcpIsolationOverride, sdkCodexVersion } from "../src/runner.ts";
import { RunToolsError, listRunFiles, readRunFile, runCalculation, writeStageOutput } from "../src/finance/run_tools_mcp.ts";
import { loadRun, validateFetchIntegrity } from "../src/validator.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = (prefix = "vra-win-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("Windows 安装脚本:优先 3.12 但允许其他受支持 Python 3；doctor 警告不伪装成安装失败", () => {
  const setup = fs.readFileSync(path.join(REPO, "scripts", "setup-windows.ps1"), "utf8");
  assert.match(setup, /py -3\.12 -c/);
  assert.match(setup, /else \{ & py -3 -m venv/);
  assert.match(setup, /sys\.version_info >= \(3, 11\)/);
  assert.match(setup, /\$doctorExit -notin @\(0, 2\)/);
  assert.doesNotMatch(setup, /Assert-NativeSuccess "运行产品体检"/);
});

test("Windows 路径与环境:Scripts venv、反斜杠、用户目录和 PATHEXT 都被保留", async () => {
  assert.equal(normalizeInterpreter(" C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe "), "C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe");
  assert.equal(interpreterRoot("C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe"), "C:\\Users\\Simon\\VRA\\.venv");
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp("vra windows data "), executionMode: "controlled_mcp" });
  const env = codexEnvFor(cfg, { PATH: "X", USERPROFILE: "C:\\Users\\Simon", PATHEXT: ".EXE;.CMD", SYSTEMROOT: "C:\\Windows" });
  assert.equal(env.USERPROFILE, "C:\\Users\\Simon");
  assert.equal(env.PATHEXT, ".EXE;.CMD");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(cfg.hooksEnabled, false, "Windows 受控模式不依赖 lifecycle hooks");
  assert.doesNotThrow(() => makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp("vra more spaces "), executionMode: "controlled_mcp" }));
  const npmBin = temp();
  const cmd = path.join(npmBin, "claude.cmd");
  const ps1 = path.join(npmBin, "claude.ps1");
  fs.writeFileSync(cmd, "@echo off\r\n");
  fs.writeFileSync(ps1, '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe" "$basedir/cli.cjs" $args\nexit $LASTEXITCODE\n');
  const cli = path.join(npmBin, "cli.cjs");
  fs.writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  assert.equal(findExecutable("claude", { PATH: npmBin, PATHEXT: ".EXE;.CMD" }, "win32"), ps1);
  const launch = executableInvocation(ps1, ["--system-prompt", "A&B%PATH%"], { SYSTEMROOT: "C:\\Windows" }, "win32");
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args.slice(-2), ["--system-prompt", "A&B%PATH%"], "提示词必须作为独立 argv，不经 cmd.exe 拼接展开");
  const values = ["--tools", "", "--mcp-config", '{"name":"测试","path":"C:\\\\a\\\\b"}', 'a "quoted" value', "A&B%PATH%", "line1\nline2", "trailing\\"];
  const exact = executableInvocation(ps1, values, process.env, "win32");
  const result = spawnSync(exact.file, exact.args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values, "真实子进程必须逐字收到空参数、JSON、中文与元字符");
  fs.writeFileSync(ps1, '& node "custom.js" @args\n');
  assert.throws(() => executableInvocation(ps1, values, process.env, "win32"), /标准 npm|原生/,
    "未知 PowerShell 包装器不得悄悄回退到会吞参数的执行路径");
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i += 1) await assert.rejects(runLocalAgent("claude", {
      systemPrompt: "规则", userPrompt: "测试", env: { ...process.env, CLAUDE_BIN: ps1 },
    }), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_windows_wrapper_unsupported",
    "拒绝未知启动器不能泄漏并发槽位并在第五次变成 busy");
  }
});

test("对话 MCP 隔离要让真实 Codex 解析通过：未启用 profile 不得被投影成无 transport 的根配置", () => {
  const codexHome = temp();
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.active]",
    'url = "https://active.invalid/mcp"',
    "[profiles.legacy.mcp_servers.codex_app]",
    'url = "https://inactive.invalid/mcp"',
    "",
  ].join("\n"));
  const dataRoot = temp();
  const python = process.env.VRA_PYTHON?.trim()
    || (process.platform === "win32" ? "python" : path.resolve(REPO, "..", ".venv", "bin", "python"));
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot, codexHome, python, runId: "mcp-parse", executionMode: "shell_hooks" });

  const isolation = mcpIsolationOverride(cfg, undefined, codexEnvFor(cfg));
  fs.mkdirSync(cfg.runDir, { recursive: true });
  const codex = sdkCodexVersion(cfg.codexPath).binary;
  assert.ok(codex, "回归必须使用产品捆绑的真实 Codex 引擎");
  const parsed = spawnSync(codex!, ["-c", isolation.override, "mcp", "list", "--json"], {
    cwd: cfg.runDir,
    env: codexEnvFor(cfg),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(parsed.status, 0, String(parsed.stderr || parsed.error?.message || "Codex 配置解析失败"));
  const servers = JSON.parse(String(parsed.stdout || "[]")) as { name?: string; enabled?: boolean }[];
  assert.deepEqual(servers.map((x) => [x.name, x.enabled]), [["active", false]]);
});

test("Windows 研究线程:Shell / unified exec 全关、只读沙箱、只挂受控 MCP", async () => {
  const codexHome = temp();
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.evil]",
    'url = "https://evil.invalid/mcp"',
    "[profiles.legacy.mcp_servers.\"dotted.name\"]",
    'command = "evil.exe"',
    "",
  ].join("\n"));
  const python = process.env.VRA_PYTHON?.trim()
    || (process.platform === "win32" ? "python" : path.resolve(REPO, "..", ".venv", "bin", "python"));
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp(), codexHome, python, runId: "controlled", executionMode: "controlled_mcp" });
  const options = codexOptionsFor(cfg) as { config: Record<string, unknown>; configOverrides: string[] };
  const features = options.config.features as Record<string, unknown>;
  assert.equal(features.shell_tool, false);
  assert.equal(features.unified_exec, false);
  const mcpOverride = options.configOverrides.at(-1) ?? "";
  assert.match(mcpOverride, /"evil"\s*=\s*\{\s*"enabled"\s*=\s*false\s*\}/);
  assert.doesNotMatch(mcpOverride, /dotted\.name/, "未激活 profile 不得被投影到根配置，否则会因缺 transport 让引擎启动失败");
  assert.match(mcpOverride, /"vra_run_[a-f0-9]{12}"\s*=/, "受控 MCP 用本轮专属名称，不与旧配置合并");
  assert.match(mcpOverride, /run_tools_mcp\.ts/);
  for (const tool of ["list_run_files", "read_run_file", "calculate", "write_stage", "write_report"]) assert.ok(mcpOverride.includes(tool));

  let threadOptions: Record<string, unknown> | null = null;
  const fake = () => ({ startThread: (o: Record<string, unknown>) => {
    threadOptions = o;
    return { id: "t", runStreamed: () => Promise.resolve({ events: (async function* () { yield { type: "turn.completed" }; })() }) };
  } }) as never;
  await new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), fake).runTurn("profile", 0, "x");
  assert.equal(threadOptions!.sandboxMode, "read-only");
  assert.equal(threadOptions!.networkAccessEnabled, false);
});

test("受控 MCP:只能读净化产物、计算用 argv 调 Python、只能写当前阶段", () => {
  const dataRoot = temp();
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot, runId: "tools", executionMode: "controlled_mcp", python: process.platform === "win32" ? "python" : "python3" });
  fs.mkdirSync(path.join(cfg.runDir, "fetch"), { recursive: true });
  fs.mkdirSync(path.join(cfg.runDir, "raw"), { recursive: true });
  fs.writeFileSync(path.join(cfg.runDir, "fetch", "sample.json"), '{"status":"ok"}\n');
  fs.writeFileSync(path.join(cfg.runDir, "raw", "secret.json"), "{}\n");
  writeHookContext(cfg, "profile", 0);
  const ctx = { runDir: cfg.runDir, repoRoot: cfg.repoRoot, python: cfg.python };

  assert.ok(listRunFiles(ctx).files.some((x) => x.path === "fetch/sample.json"));
  assert.equal(readRunFile(ctx, "fetch/sample.json").text, '{"status":"ok"}\n');
  assert.throws(() => readRunFile(ctx, "raw/secret.json"), (e: unknown) => e instanceof RunToolsError && e.code === "path_not_allowed");

  const record = runCalculation(ctx, { function: "ratio", args: { numerator: 1, denominator: 4 }, output_file: "01_ratio.json" });
  assert.equal((record.output as Record<string, unknown>).status, "ok");
  assert.equal((record.output as Record<string, unknown>).value, 0.25);
  assert.ok(fs.existsSync(path.join(cfg.runDir, "calcs", "01_ratio.json")));
  assert.equal((runCalculation(ctx, { function: "ratio", args: { numerator: 2, denominator: 4 }, output_file: "01_ratio.json" }).output as Record<string, unknown>).value, 0.5, "同阶段补跑可覆盖自己的计算");

  writeHookContext(cfg, "financials", 1);
  assert.throws(
    () => runCalculation(ctx, { function: "ratio", args: { numerator: 3, denominator: 4 }, output_file: "01_ratio.json" }),
    (e: unknown) => e instanceof RunToolsError && e.code === "calc_owned_by_other_stage",
  );

  writeHookContext(cfg, "profile", 2);
  assert.throws(() => writeStageOutput(ctx, { stage: "financials" }), (e: unknown) => e instanceof RunToolsError && e.code === "wrong_stage");
  assert.throws(() => writeStageOutput(ctx, { stage: "profile" }), (e: unknown) => e instanceof RunToolsError && e.code === "stage_schema_invalid");
});

test("Windows 账本路径按 JSON 契约使用正斜杠，不随宿主路径分隔符漂移", () => {
  const runDir = temp();
  for (const dir of ["raw", "fetch", "calcs", "stages"]) fs.mkdirSync(path.join(runDir, dir), { recursive: true });
  const file = path.join(runDir, "fetch", "fetch_quote.json");
  writeJson(file, {
    script: "fetch_quote", symbol: "300308", market: "SZ", status: "ok", fetched_at: "2026-08-30T00:00:00Z",
    primary_source: "fixture", used_sources: ["fixture"], evidence: [], extra: {}, errors: [], missing: [],
  });
  const ledger = {
    fetch_quote: {
      script: "fetch_quote", argv: [], exit_code: 0, duration_ms: 1, status: "ok" as const,
      file: "fetch/fetch_quote.json", sha256: sha256File(file), raw_files: {},
      started_at: "2026-08-30T00:00:00Z", finished_at: "2026-08-30T00:00:01Z", stage: "profile",
    },
  };
  assert.deepEqual(validateFetchIntegrity(loadRun(runDir, ledger)).errors, []);
});

test("Windows 私密文件权限不用 Unix mode 冒充 ACL 验证", { skip: process.platform !== "win32" }, () => {
  const dir = temp();
  const file = path.join(dir, "private.txt");
  fs.writeFileSync(file, "secret", { mode: 0o600 });
  restrictPrivateFile(file);
  assert.equal(privateFilePermissions(file).secure, true, "收紧后必须断开继承且只留当前用户 SID");
});
