import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Minimal fixture environments still need Windows' OS/profile bootstrap values.
// Do not inherit API keys, OAuth tokens or model-provider configuration.
const PLATFORM_ENV: NodeJS.ProcessEnv = process.platform === "win32"
  ? Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|windir|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH)$/i.test(key)))
  : {};

import {
  LocalAgentError, claudeArgs, codeBuddyArgs, codexLoginProgress, findExecutable, parseClaudeOutput,
  executableInvocation, normalizeLocalAgentTimeoutMs, parseCodeBuddyOutput, probeClaude, probeCodeBuddy, probeCodex, runLocalAgent,
  startCodexLogin, terminateActiveLocalAgentProcesses, workBuddyCliCandidates,
  localAgentInput,
} from "../src/local_agent_runtime.ts";

test("六阶段订阅 Agent 保留显式 20 分钟超时，不被适配器暗中截短", () => {
  assert.equal(normalizeLocalAgentTimeoutMs(20 * 60_000), 20 * 60_000);
  assert.equal(normalizeLocalAgentTimeoutMs(undefined), 180_000);
  assert.throws(() => normalizeLocalAgentTimeoutMs(Number.NaN),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_timeout");
});

function fakeNodeExecutable(dir: string, name: string, source: string): string {
  if (process.platform !== "win32") {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return bin;
  }
  const script = path.join(dir, `${name}.cjs`);
  const bin = path.join(dir, `${name}.ps1`);
  fs.writeFileSync(script, `#!/usr/bin/env node\n${source}`);
  fs.writeFileSync(bin, `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe" "$basedir/${name}.cjs" $args\nexit $LASTEXITCODE\n`);
  return bin;
}

function fakeClaude(): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-claude-"));
  const bin = fakeNodeExecutable(dir, "claude", `
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.1.226 (Claude Code)');process.exit(0)}
if(a[0]==='--help'){console.log(process.env.FAKE_OLD_HELP==='1'?'--output-format':'--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema');process.exit(0)}
if(a[0]==='auth'&&a[1]==='status'){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_AUTH_METHOD||'claude.ai',apiProvider:process.env.FAKE_API_PROVIDER||'firstParty',email:'hidden@example.com'}));process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({result:input+'|keys='+Boolean(process.env.ANTHROPIC_API_KEY)+'|oauth='+Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)})));
`);
  return { dir, bin };
}

function fakeCodeBuddy(): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-codebuddy-"));
  const bin = fakeNodeExecutable(dir, "codebuddy", `
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.143.1 (CodeBuddy Code)');process.exit(0)}
if(a[0]==='--help'){
  if(process.env.FAKE_COLD_HELP==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
  const required='--tools --strict-mcp-config --mcp-config --setting-sources --input-format --output-format --system-prompt --json-schema --max-turns --agent --permission-mode --subagent-permission-mode';
  console.log(process.env.FAKE_OLD_HELP==='1'?'--output-format':required+(process.env.FAKE_LEGACY_HELP==='1'?'':' --no-session-persistence'));
  process.exit(0)
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  if(a.includes('--input-format=stream-json')){
    if(process.env.FAKE_COLD_AUTH==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
    const req=JSON.parse(input.trim());
    const account=process.env.FAKE_NOT_LOGGED==='1'?null:{userId:'secret-user',token:'secret-token',userName:'hidden@example.com'};
    console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{account}}}));
    return;
  }
  if(process.env.FAKE_EXEC_NOT_LOGGED==='1'){console.log('Authentication required. Please use /login command to sign in to your account');return}
  const profiles=['HOME','USERPROFILE','APPDATA','LOCALAPPDATA'].every(k=>!process.env['FAKE_BASE_'+k]||process.env[k]!==process.env['FAKE_BASE_'+k]);
  const result={result:input+'|api='+Boolean(process.env.CODEBUDDY_API_KEY)+'|token='+Boolean(process.env.CODEBUDDY_AUTH_TOKEN)+'|base='+Boolean(process.env.CODEBUDDY_BASE_URL)+'|tools='+a.slice(a.indexOf('--tools'),a.indexOf('--tools')+2).join(':')+'|memory='+process.env.CODEBUDDY_DISABLE_AUTO_MEMORY+'|ephemeral='+Boolean(process.env.FAKE_BASE_HOME&&process.env.HOME!==process.env.FAKE_BASE_HOME)+'|profiles='+profiles+'|noSession='+a.includes('--no-session-persistence')+'|permission='+a[a.indexOf('--permission-mode')+1]};
  if(process.env.FAKE_ECHO_MCP_ENV==='1') result.result+='|wait='+process.env.CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED+'|prewait='+process.env.CODEBUDDY_FIRST_RUN_MCP_PREWAIT_TIMEOUT_MS;
  if(process.env.FAKE_IMAGE_INPUT==='1') result.result+='|input_format='+a[a.indexOf('--input-format')+1]+'|builtin_tools='+a[a.indexOf('--tools')+1]+'|model_override='+a.includes('--model');
  console.log(JSON.stringify(process.env.FAKE_LEGACY_HELP==='1'?[{type:'message'},result]:result));
});
`);
  return { dir, bin };
}

test("Codex 订阅登录只写产品 CODEX_HOME，并合并重复启动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-codex-login-"));
  const codexHome = path.join(dir, "product-home");
  const launchFile = path.join(dir, "launch.json");
  const bin = fakeNodeExecutable(dir, "codex", `
const fs=require('node:fs');
const path=require('node:path');
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.149.0');process.exit(0)}
if(a[0]==='login'&&a[1]==='status'){process.exit(fs.existsSync(path.join(process.env.CODEX_HOME,'auth.ok'))?0:1)}
if(a[0]==='login'){
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
  fs.writeFileSync(process.env.TEST_LAUNCH_FILE,JSON.stringify({home:process.env.CODEX_HOME,args:a}));
  setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.ok'),'ok');process.exit(0)},120);
}
`);
  try {
    const before = await probeCodex(bin, codexHome, { ...PLATFORM_ENV, TEST_LAUNCH_FILE: launchFile });
    assert.equal(before.status, "not_authenticated");

    const first = startCodexLogin(bin, codexHome, { ...PLATFORM_ENV, TEST_LAUNCH_FILE: launchFile });
    const duplicate = startCodexLogin(bin, codexHome, { ...PLATFORM_ENV, TEST_LAUNCH_FILE: launchFile });
    assert.equal(first.state, "started");
    assert.equal(duplicate.state, "pending", "同一个产品 home 不能同时弹出两个登录流程");
    assert.equal(codexLoginProgress(codexHome)?.state, "pending");

    for (let i = 0; i < 30 && !fs.existsSync(path.join(codexHome, "auth.ok")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const launched = JSON.parse(fs.readFileSync(launchFile, "utf8")) as { home: string; args: string[] };
    assert.equal(launched.home, codexHome);
    assert.deepEqual(launched.args, ["login"]);
    const after = await probeCodex(bin, codexHome, { ...PLATFORM_ENV, TEST_LAUNCH_FILE: launchFile });
    assert.equal(after.status, "ready");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex 登录超时后必须杀掉整组进程，父进程先退但子进程活着时仍不允许重开", { skip: process.platform === "win32" ? "中间态断言只适用于 POSIX 进程组；Windows 由 taskkill /T 直接终止树" : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stubborn-codex-login-"));
  const codexHome = path.join(dir, "product-home");
  const parentPidFile = path.join(dir, "parent-pid");
  const childPidFile = path.join(dir, "child-pid");
  const bin = fakeNodeExecutable(dir, "codex", `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
if(process.env.TEST_IS_CHILD==='1'){
  process.on('SIGTERM',()=>{});
  fs.writeFileSync(process.env.TEST_CHILD_PID_FILE,String(process.pid));
  setInterval(()=>{},1000);
}else if(process.argv[2]==='login'){
  fs.writeFileSync(process.env.TEST_PARENT_PID_FILE,String(process.pid));
  spawn(process.execPath,[__filename],{env:{...process.env,TEST_IS_CHILD:'1'},stdio:'ignore'});
  setInterval(()=>{},1000);
}
`);
  try {
    const env = { ...PLATFORM_ENV, TEST_PARENT_PID_FILE: parentPidFile, TEST_CHILD_PID_FILE: childPidFile };
    const started = Date.now();
    assert.equal(startCodexLogin(bin, codexHome, env, { timeoutMs: 6_000 }).state, "started");
    for (let i = 0; i < 500 && (!fs.existsSync(parentPidFile) || !fs.existsSync(childPidFile)); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(fs.existsSync(parentPidFile) && fs.existsSync(childPidFile), "父子进程都应真实启动");
    await new Promise((r) => setTimeout(r, Math.max(0, 6_100 - (Date.now() - started))));
    const parentPid = Number(fs.readFileSync(parentPidFile, "utf8"));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.throws(() => process.kill(parentPid, 0), /ESRCH/, "父进程应先响应 TERM 退出");
    assert.doesNotThrow(() => process.kill(childPid, 0), "顽固子进程仍活着时 job 必须保持 pending");
    assert.equal(startCodexLogin(bin, codexHome, env, { timeoutMs: 1_500 }).state, "pending");
    for (let i = 0; i < 80; i += 1) {
      let alive = true;
      try { process.kill(childPid, 0); } catch { alive = false; }
      if (!alive && codexLoginProgress(codexHome)?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 75));
    }
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    assert.equal(codexLoginProgress(codexHome)?.state, "failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude 参数强制无工具、无 MCP、无会话落盘，正文不进 argv", () => {
  const args = claudeArgs("SYSTEM", { type: "object" });
  assert.ok(args.includes("--safe-mode"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(!args.join(" ").includes("USER_SECRET_PROMPT"));
});

test("Claude Deep 只开显式 MCP 白名单，不开内建工具", () => {
  const controlledMcp = { serverName: "vra", command: process.execPath, args: ["/app/run_tools_mcp.ts"],
    env: { VRA_RUN_DIR: "/data/runs/r1" }, allowedTools: ["mcp__vra__read_run_file", "mcp__vra__write_stage"] };
  const args = claudeArgs("SYSTEM", { type: "object" }, controlledMcp);
  assert.ok(!args.includes("--safe-mode"), "safe-mode 会把显式 MCP 也关掉");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", ""]);
  assert.ok(args.includes("mcp__vra__read_run_file") && args.includes("mcp__vra__write_stage"));
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: { vra: { command: string } } };
  assert.equal(config.mcpServers.vra.command, process.execPath);
});

test("本机 Claude 探针只返回版本与登录布尔，不泄露账号", async () => {
  const f = fakeClaude();
  try {
    assert.equal(findExecutable("claude", { CLAUDE_BIN: f.bin, PATH: "" }), f.bin);
    const status = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: "" });
    assert.equal(status.status, "ready");
    assert.equal(status.version, "2.1.226 (Claude Code)");
    assert.ok(!JSON.stringify(status).includes("hidden@example.com"));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude 探针不把 API/云平台认证冒充订阅，旧版 CLI 也不点亮", async () => {
  const f = fakeClaude();
  try {
    const api = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: "", FAKE_AUTH_METHOD: "api_key" });
    assert.equal(api.status, "not_authenticated");
    const bedrock = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: "", FAKE_API_PROVIDER: "bedrock" });
    assert.equal(bedrock.status, "not_authenticated");
    const old = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: "", FAKE_OLD_HELP: "1" });
    assert.equal(old.status, "probe_failed");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude 订阅调用走 stdin，并移除会静默改计费方的 Anthropic API 环境变量", async () => {
  const f = fakeClaude();
  try {
    const out = await runLocalAgent("claude", {
      systemPrompt: "规则", userPrompt: "USER_SECRET_PROMPT",
      env: { ...PLATFORM_ENV,
        CLAUDE_BIN: f.bin, PATH: process.env.PATH, ANTHROPIC_API_KEY: "must-not-forward",
        CLAUDE_CODE_OAUTH_TOKEN: "official-subscription-token",
      },
    });
    assert.equal(out, "USER_SECRET_PROMPT|keys=false|oauth=true");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude JSON 输出优先 structured_output，坏输出明确失败", () => {
  assert.equal(parseClaudeOutput('{"result":"普通回答"}'), "普通回答");
  assert.equal(parseClaudeOutput('{"result":"忽略","structured_output":{"ok":true}}'), '{"ok":true}');
  assert.throws(() => parseClaudeOutput("not json"), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_output");
});

test("CodeBuddy 参数关闭工具、MCP、配置、记忆与子代理，正文不进 argv", () => {
  const args = codeBuddyArgs("SYSTEM", { type: "object" });
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", "none"]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "1"]);
  assert.deepEqual(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2), ["--agent", "cli"]);
  assert.equal(args[0], "-p");
  assert.ok(args[1]?.startsWith("--"), "-p 后不得带位置 prompt，否则官方 CLI 会忽略 stdin 里的用户正文");
  assert.ok(args.includes("--json-schema"));
  assert.ok(!args.join(" ").includes("USER_SECRET_PROMPT"));
});

test("CodeBuddy Deep 只开显式 MCP 白名单，并允许多轮工具调用", () => {
  const controlledMcp = { serverName: "vra", command: process.execPath, args: ["/app/run_tools_mcp.ts"],
    env: { VRA_RUN_DIR: "/data/runs/r1" }, allowedTools: ["mcp__vra__calculate"], maxTurns: 32 };
  const args = codeBuddyArgs("SYSTEM", { type: "object" }, false, controlledMcp);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "NoDefer(mcp__vra__*)"]);
  assert.ok(args.includes("mcp__vra__calculate"));
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "32"]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as {
    mcpServers: { vra: { command: string; alwaysLoad: boolean; defer_loading: boolean } };
  };
  assert.equal(config.mcpServers.vra.command, process.execPath);
  assert.equal(config.mcpServers.vra.alwaysLoad, true);
  assert.equal(config.mcpServers.vra.defer_loading, false);
});

test("Windows 能发现 WorkBuddy 桌面版内置 CLI，并用 Node 启动无扩展名脚本", () => {
  const candidates = workBuddyCliCandidates({
    LOCALAPPDATA: "C:\\Users\\Simon\\AppData\\Local",
    ProgramFiles: "D:\\Program Files",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
  }, "win32");
  const embedded = "C:\\Users\\Simon\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
  assert.ok(candidates.includes(embedded));
  assert.ok(candidates.includes("D:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy.exe"));
  const launch = executableInvocation(embedded, ["--version"], {}, "win32");
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, [embedded, "--version"]);
});

test("CodeBuddy 官方控制探针只返回版本与登录布尔，不泄露账号或 token", async () => {
  const f = fakeCodeBuddy();
  try {
    assert.equal(findExecutable("codebuddy", { CODEBUDDY_BIN: f.bin, PATH: "" }), f.bin);
    const status = await probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "" });
    assert.equal(status.status, "ready");
    assert.equal(status.version, "2.143.1 (CodeBuddy Code)");
    assert.ok(!JSON.stringify(status).includes("hidden@example.com"));
    assert.ok(!JSON.stringify(status).includes("secret-token"));

    const loggedOut = await probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_NOT_LOGGED: "1" });
    assert.equal(loggedOut.status, "not_authenticated");
    const old = await probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_OLD_HELP: "1" });
    assert.equal(old.status, "probe_failed");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("CodeBuddy 冷启动超过五秒不应误报登录检测失败", async () => {
  const f = fakeCodeBuddy();
  try {
    for (const flag of ["FAKE_COLD_HELP", "FAKE_COLD_AUTH"]) {
      const status = await probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", [flag]: "1" });
      assert.equal(status.status, "ready", flag);
      assert.equal(status.authenticated, true);
      assert.doesNotMatch(JSON.stringify(status), /secret-user|secret-token|hidden@example/);
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("CodeBuddy 订阅调用走 stdin，移除 API / token / 自定义端点并关闭自动记忆", async () => {
  const f = fakeCodeBuddy();
  try {
    const out = await runLocalAgent("codebuddy", {
      systemPrompt: "规则", userPrompt: "USER_SECRET_PROMPT",
      env: { ...PLATFORM_ENV,
        CODEBUDDY_BIN: f.bin, PATH: process.env.PATH,
        CODEBUDDY_API_KEY: "must-not-forward", CODEBUDDY_AUTH_TOKEN: "must-not-forward",
        CODEBUDDY_BASE_URL: "https://custom.invalid", CODEBUDDY_MODEL: "other-model",
      },
    });
    assert.equal(out, "USER_SECRET_PROMPT|api=false|token=false|base=false|tools=--tools:|memory=1|ephemeral=false|profiles=true|noSession=true|permission=dontAsk");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("CodeBuddy Deep 首轮等待唯一 MCP，并维持订阅环境隔离", async () => {
  const f = fakeCodeBuddy();
  try {
    const out = await runLocalAgent("codebuddy", {
      systemPrompt: "规则", userPrompt: "读取运行文件",
      env: { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: process.env.PATH, FAKE_ECHO_MCP_ENV: "1" },
      controlledMcp: {
        serverName: "vra", command: process.execPath, args: ["/app/run_tools_mcp.ts"],
        env: { VRA_RUN_DIR: "/data/runs/r1" }, allowedTools: ["mcp__vra__list_run_files"], maxTurns: 8,
      },
    });
    assert.match(out, /tools=--tools:NoDefer\(mcp__vra__\*\)/);
    assert.match(out, /permission=bypassPermissions/);
    assert.match(out, /wait=1\|prewait=30000/);
    assert.match(out, /api=false\|token=false\|base=false/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("WorkBuddy 桌面端旧 CLI 复用现有订阅登录，但回答只在一次性 HOME 中运行", async () => {
  const f = fakeCodeBuddy();
  try {
    const baseHome = path.join(f.dir, "workbuddy-user-home");
    const baseProfile = path.join(f.dir, "workbuddy-user-profile");
    const baseAppData = path.join(baseProfile, "AppData", "Roaming");
    const baseLocalAppData = path.join(baseProfile, "AppData", "Local");
    fs.mkdirSync(baseHome);
    const status = await probeCodeBuddy({ ...PLATFORM_ENV,
      CODEBUDDY_BIN: f.bin, PATH: process.env.PATH, HOME: baseHome,
      FAKE_BASE_HOME: baseHome, FAKE_LEGACY_HELP: "1",
    });
    assert.equal(status.status, "ready");
    const out = await runLocalAgent("codebuddy", {
      systemPrompt: "规则", userPrompt: "USER_SECRET_PROMPT",
      env: { ...PLATFORM_ENV,
        CODEBUDDY_BIN: f.bin, PATH: process.env.PATH, HOME: baseHome,
        USERPROFILE: baseProfile, APPDATA: baseAppData, LOCALAPPDATA: baseLocalAppData,
        FAKE_BASE_HOME: baseHome, FAKE_BASE_USERPROFILE: baseProfile,
        FAKE_BASE_APPDATA: baseAppData, FAKE_BASE_LOCALAPPDATA: baseLocalAppData,
        FAKE_LEGACY_HELP: "1",
      },
    });
    assert.equal(out, "USER_SECRET_PROMPT|api=false|token=true|base=false|tools=--tools:|memory=1|ephemeral=true|profiles=true|noSession=false|permission=default");
    assert.deepEqual(fs.readdirSync(baseHome), [], "真实 WorkBuddy 用户目录不得写入运行会话");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("CodeBuddy JSON 输出兼容 result / response / structured_output 与数组", () => {
  assert.equal(parseCodeBuddyOutput('{"result":"普通回答"}'), "普通回答");
  assert.equal(parseCodeBuddyOutput('{"response":"新版回答"}'), "新版回答");
  assert.equal(parseCodeBuddyOutput('{"structured_output":{"ok":true}}'), '{"ok":true}');
  assert.equal(parseCodeBuddyOutput('[{"response":"第一条"},{"result":"最后一条"}]'), "最后一条");
  assert.throws(() => parseCodeBuddyOutput("not json"), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_output");
});

test("WorkBuddy 原生图片仅进入 stdin 用户消息，不当文件路径或切换模型", async () => {
  const f = fakeCodeBuddy();
  try {
    const images = [{ name: "01_测试.png", data: "aW1hZ2U=", mimeType: "image/png" }];
    const packet = JSON.parse(localAgentInput("codebuddy", "转写", images));
    assert.equal(packet.type, "user");
    assert.deepEqual(packet.message.content[2], { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } });
    const output = await runLocalAgent("codebuddy", { systemPrompt: "转写", userPrompt: "转写", userImages: images,
      env: { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_IMAGE_INPUT: "1" } });
    assert.match(output, /aW1hZ2U=/);
    assert.match(output, /\|input_format=stream-json\|builtin_tools=\|model_override=false/);
    assert.equal(localAgentInput("codebuddy", "plain"), "plain");
    assert.throws(() => localAgentInput("claude", "x", images), /图片附件/);
    assert.throws(() => localAgentInput("codebuddy", "x", [{ ...images[0]!, data: "file:///private" }]), /图片附件/);
    assert.throws(() => localAgentInput("codebuddy", "x", [{ ...images[0]!, mimeType: "text/plain" }]), /图片附件/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("CodeBuddy 未登录即使 CLI 以 exit 0 返回纯文本，也要归类为登录失效", async () => {
  const f = fakeCodeBuddy();
  try {
    await assert.rejects(
      () => runLocalAgent("codebuddy", {
        systemPrompt: "规则", userPrompt: "hello",
        env: { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: process.env.PATH, FAKE_EXEC_NOT_LOGGED: "1" },
      }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated",
    );
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude 超时后会清掉忽略 TERM 的整个派生进程组，再返回错误", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stubborn-claude-"));
  const parentPidFile = path.join(dir, "parent-pid");
  const childPidFile = path.join(dir, "child-pid");
  const bin = fakeNodeExecutable(dir, "claude", `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
if(process.env.TEST_IS_CHILD==='1'){
  fs.writeFileSync(process.env.TEST_CHILD_PID_FILE,String(process.pid));
}else{
  fs.writeFileSync(process.env.TEST_PARENT_PID_FILE,String(process.pid));
  spawn(process.execPath,[__filename],{env:{...process.env,TEST_IS_CHILD:'1'}});
}
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
  try {
    await assert.rejects(
      () => runLocalAgent("claude", {
        // 全量测试并行启动大量 Node 子进程；1 秒可能在假进程真正获得调度前就到期，
        // 那只测到了机器负载，不是“已启动的顽固进程树能否被清理”。
        systemPrompt: "规则", userPrompt: "等待", timeoutMs: 5_000,
        env: { ...PLATFORM_ENV,
          CLAUDE_BIN: bin, PATH: process.env.PATH,
          TEST_PARENT_PID_FILE: parentPidFile, TEST_CHILD_PID_FILE: childPidFile,
        },
      }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_timeout",
    );
    const parentPid = Number(fs.readFileSync(parentPidFile, "utf8"));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.throws(() => process.kill(parentPid, 0), /ESRCH/);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("产品退出清理入口会终止仍在运行的订阅 CLI 进程树", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-shutdown-claude-"));
  const pidFile = path.join(dir, "pid");
  const bin = fakeNodeExecutable(dir, "claude", `
const fs=require('node:fs');
fs.writeFileSync(process.env.TEST_PID_FILE,String(process.pid));
setInterval(()=>{},1000);
`);
  const running = runLocalAgent("claude", {
    systemPrompt: "规则", userPrompt: "等待", timeoutMs: 60_000,
    env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH, TEST_PID_FILE: pidFile },
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(pidFile), "假 CLI 应已启动");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(terminateActiveLocalAgentProcesses("SIGKILL"), 1);
    await assert.rejects(running, (e: unknown) => e instanceof LocalAgentError && e.code === "agent_failed");
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("临时目录清理失败应拒绝请求，不抛出未捕获异常或把任务悬空", async () => {
  const f = fakeClaude();
  const original = fs.rmSync;
  let retained: fs.PathLike | undefined;
  fs.rmSync = ((target, options) => {
    if (String(target).includes(`${path.sep}vra-claude-`)) {
      retained = target;
      throw Object.assign(new Error("synthetic permission failure"), { code: "EPERM" });
    }
    return original(target, options);
  }) as typeof fs.rmSync;
  try {
    await assert.rejects(runLocalAgent("claude", {
      systemPrompt: "规则", userPrompt: "测试", env: { ...process.env, CLAUDE_BIN: f.bin },
    }), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cleanup_failed");
  } finally {
    fs.rmSync = original;
    if (retained) original(retained, { recursive: true, force: true, maxRetries: 5 });
    original(f.dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("一次性任务也受本机 Agent 全局并发上限约束，不能绕过会话表无限启动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-busy-claude-"));
  const bin = fakeNodeExecutable(dir, "claude", `setInterval(()=>{},1000);\n`);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const runs = controllers.map((ac) => runLocalAgent("claude", {
    systemPrompt: "规则", userPrompt: "等待", signal: ac.signal,
    env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH },
  }));
  try {
    await assert.rejects(
      () => runLocalAgent("claude", {
        systemPrompt: "规则", userPrompt: "第五个", env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH },
      }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_busy",
    );
  } finally {
    controllers.forEach((ac) => ac.abort());
    const done = await Promise.allSettled(runs);
    assert.ok(done.every((x) => x.status === "rejected"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
