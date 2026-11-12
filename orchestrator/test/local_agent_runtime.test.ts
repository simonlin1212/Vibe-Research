import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

// Minimal fixture environments still need Windows' OS/profile bootstrap values.
// Do not inherit API keys, OAuth tokens or model-provider configuration.
const PLATFORM_ENV: NodeJS.ProcessEnv = process.platform === "win32"
  ? Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|windir|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH)$/i.test(key)))
  : {};

import {
  CodexEventStream, LocalAgentError, claudeArgs, codeBuddyArgs, codexArgs, codexVersionSupported, findExecutable, parseClaudeOutput,
  executableInvocation, normalizeLocalAgentTimeoutMs, parseCodeBuddyOutput, parseCodexLoginStatus, parseCodexVersion,
  probeClaude as realProbeClaude, probeCodeBuddy as realProbeCodeBuddy, probeCodex as realProbeCodex, runLocalAgent as realRunLocalAgent,
  terminateActiveLocalAgentProcesses, tomlString, workBuddyCliCandidates, workBuddyFallbackCandidates,
  localAgentInput, localSubscriptionEnv,
  AGENT_PATHS_FILE, codeBuddyLocationCandidates, codeBuddyNativeCandidates, codeBuddyPathFlags, executableCandidates, loadSavedAgentPaths, resolveCodeBuddyLocation, saveCodeBuddyLocation,
  codeBuddyProbeFailure, isWorkBuddyBundledCli, locateCodeBuddy, resetWorkBuddyDiscoveryForTest, workBuddyBundledCandidates, workBuddyRootsFromDiscovery,
} from "../src/local_agent_runtime.ts";

// Fixture switches use a private sidecar, not the production child environment.
// A strict allowlist must not gain a FAKE_* bypass just to keep tests passing.
function fixtureConfig(env: NodeJS.ProcessEnv): void {
  const bin = env.CLAUDE_BIN ?? env.CODEBUDDY_BIN ?? env.CODEX_BIN;
  if (!bin || !path.resolve(bin).startsWith(path.resolve(os.tmpdir()) + path.sep)) return;
  fs.writeFileSync(path.join(path.dirname(bin), "fixture-flags.json"), JSON.stringify(
    Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("FAKE_")))));
}
const probeClaude: typeof realProbeClaude = env => { fixtureConfig(env ?? process.env); return realProbeClaude(env); };
const probeCodeBuddy: typeof realProbeCodeBuddy = env => { fixtureConfig(env ?? process.env); return realProbeCodeBuddy(env); };
const probeCodex: typeof realProbeCodex = env => { fixtureConfig(env ?? process.env); return realProbeCodex(env); };
const runLocalAgent: typeof realRunLocalAgent = (agent, opts) => { fixtureConfig(opts.env ?? process.env); return realRunLocalAgent(agent, opts); };

test("订阅子进程只继承运行必需变量，不继承其它服务密钥或 Node 注入参数", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-env-privacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { ...PLATFORM_ENV, PATH: process.env.PATH, HTTPS_PROXY: "http://proxy.invalid:80",
    OPENAI_API_KEY: "unrelated-openai-marker", AWS_SECRET_ACCESS_KEY: "unrelated-cloud-marker",
    GITHUB_TOKEN: "unrelated-github-marker", MIMO_API_KEY: "unrelated-mimo-marker", NODE_OPTIONS: "--trace-warnings",
    CLAUDE_CODE_OAUTH_TOKEN: "official-subscription-marker", CLAUDE_CONFIG_DIR: dir };
  for (const agent of ["claude", "codebuddy", "codex"] as const) {
    const env = localSubscriptionEnv(base, agent);
    for (const key of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "MIMO_API_KEY", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
    assert.equal(env.HTTPS_PROXY, base.HTTPS_PROXY);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, agent === "claude" ? base.CLAUDE_CODE_OAUTH_TOKEN : undefined);
  }
  const bin = fakeNodeExecutable(dir, "claude", `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:JSON.stringify({leak:process.env.AWS_SECRET_ACCESS_KEY??null,oauth:!!process.env.CLAUDE_CODE_OAUTH_TOKEN})})));`);
  assert.deepEqual(JSON.parse(await runLocalAgent("claude", { systemPrompt: "test", userPrompt: "test", env: { ...base, CLAUDE_BIN: bin } })), { leak: null, oauth: true });
});

test("六阶段订阅 Agent 保留显式 20 分钟超时，不被适配器暗中截短", () => {
  assert.equal(normalizeLocalAgentTimeoutMs(20 * 60_000), 20 * 60_000);
  assert.equal(normalizeLocalAgentTimeoutMs(undefined), 180_000);
  assert.throws(() => normalizeLocalAgentTimeoutMs(Number.NaN),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_timeout");
});

// 运行时每次调用 Claude 前都会先查能力参数与登录方式;假 Claude 默认应答“订阅登录、参数齐全”。
// 要测这两步检查本身的替身(源码里自己处理 'auth')不加这段。
const CLAUDE_CHECKS_PASS = "if(process.argv[2]==='--help'){console.log('--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema');process.exit(0)}\n" +
  "if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0)}\n";

function fakeNodeExecutable(dir: string, name: string, source: string): string {
  const flags = path.join(dir, "fixture-flags.json");
  if (name === "claude" && !source.includes("'auth'")) source = CLAUDE_CHECKS_PASS + source;
  source = `if(require('node:fs').existsSync(${JSON.stringify(flags)})) Object.assign(process.env,JSON.parse(require('node:fs').readFileSync(${JSON.stringify(flags)},'utf8')));\n` + source;
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
if(a[0]==='auth'&&a[1]==='status'){
  if(process.env.FAKE_AUTH_FAILURE==='1'){console.error('EACCES secret-account@example.com');process.exit(2)}
  if(process.env.FAKE_AUTH_MALFORMED==='1'){console.log('{}');process.exit(0)}
  console.log(JSON.stringify({loggedIn:process.env.FAKE_AUTH_LOGGED_OUT!=='1',authMethod:process.env.FAKE_AUTH_METHOD||'claude.ai',apiProvider:process.env.FAKE_API_PROVIDER||'firstParty',email:'hidden@example.com'}));process.exit(process.env.FAKE_AUTH_LOGGED_OUT==='1'?1:0)
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({result:input+'|keys='+Boolean(process.env.ANTHROPIC_API_KEY)+'|oauth='+Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)})));
`);
  return { dir, bin };
}

test("Claude 检测失败不是退出登录，只有明确的登录结果才判断认证状态", async () => {
  const f = fakeClaude();
  try {
    for (const flag of ['FAKE_AUTH_FAILURE', 'FAKE_AUTH_MALFORMED']) {
      const result = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: '', [flag]: '1' });
      assert.equal(result.status, 'probe_failed');
      assert.equal(result.available, false);
      assert.doesNotMatch(JSON.stringify(result), /secret-account|EACCES/);
    }
    const loggedOut = await probeClaude({ ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: '', FAKE_AUTH_LOGGED_OUT: '1' });
    assert.equal(loggedOut.status, 'not_authenticated');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

function fakeCodeBuddy(dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-codebuddy-"))): { dir: string; bin: string } {
  const bin = fakeNodeExecutable(dir, "codebuddy", `
const a=process.argv.slice(2);
if(process.env.FAKE_CALLS_FILE) require('node:fs').appendFileSync(process.env.FAKE_CALLS_FILE,a[0]+'\\n');
if(process.env.FAKE_REQUIRE_LITE_BUNDLE==='1'&&process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE!=='1'){console.error("Cannot find module '../dist/codebuddy'");process.exit(1)}
if(process.env.FAKE_REJECT_LITE_BUNDLE==='1'&&process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE==='1'){console.error("lite bundle forced on standalone CLI");process.exit(1)}
if(a[0]==='--version'){console.log(process.env.FAKE_VERSION||'2.143.1 (CodeBuddy Code)');process.exit(0)}
if(a[0]==='--help'){
  if(process.env.FAKE_COLD_HELP==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
  const required='--tools --strict-mcp-config --mcp-config --setting-sources --input-format --output-format --system-prompt --json-schema --max-turns --agent --permission-mode --subagent-permission-mode';
  console.log(process.env.FAKE_OLD_HELP==='1'?'--output-format':required+(process.env.FAKE_LEGACY_HELP==='1'?'':' --no-session-persistence')+(process.env.FAKE_HELP_PORT==='1'?'\\n  --port <number>  HTTP listen port':''));
  process.exit(0)
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  if(a.includes('--input-format=stream-json')){
    if(process.env.FAKE_COLD_AUTH==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
    const req=JSON.parse(input.trim());
    const account=process.env.FAKE_NOT_LOGGED==='1'?null:process.env.FAKE_ACCOUNT?JSON.parse(process.env.FAKE_ACCOUNT):{userId:'secret-user',token:'secret-token',userName:'hidden@example.com'};
    console.log(JSON.stringify({type:'control_response',response:{subtype:process.env.FAKE_CONTROL_FAILURE==='1'?'error':'success',request_id:req.request_id,response:{account}}}));
    if(process.env.FAKE_PROBE_EXIT_CODE) process.exitCode=Number(process.env.FAKE_PROBE_EXIT_CODE);
    return;
  }
  if(process.env.FAKE_EXEC_MARKER) require('node:fs').writeFileSync(process.env.FAKE_EXEC_MARKER,'executed');
  if(process.env.FAKE_EXEC_NOT_LOGGED==='1'){console.log('Authentication required. Please use /login command to sign in to your account');return}
  const profiles=['HOME','USERPROFILE','APPDATA','LOCALAPPDATA'].every(k=>!process.env['FAKE_BASE_'+k]||process.env[k]!==process.env['FAKE_BASE_'+k]);
  const result={result:input+'|api='+Boolean(process.env.CODEBUDDY_API_KEY)+'|token='+Boolean(process.env.CODEBUDDY_AUTH_TOKEN)+'|base='+Boolean(process.env.CODEBUDDY_BASE_URL)+'|tools='+a.slice(a.indexOf('--tools'),a.indexOf('--tools')+2).join(':')+'|memory='+process.env.CODEBUDDY_DISABLE_AUTO_MEMORY+'|ephemeral='+Boolean(process.env.FAKE_BASE_HOME&&process.env.HOME!==process.env.FAKE_BASE_HOME)+'|profiles='+profiles+'|noSession='+a.includes('--no-session-persistence')+'|permission='+a[a.indexOf('--permission-mode')+1]};
  if(process.env.FAKE_ECHO_MCP_ENV==='1') result.result+='|wait='+process.env.CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED+'|prewait='+process.env.CODEBUDDY_FIRST_RUN_MCP_PREWAIT_TIMEOUT_MS;
  if(process.env.FAKE_IMAGE_INPUT==='1') result.result+='|input_format='+a[a.indexOf('--input-format')+1]+'|builtin_tools='+a[a.indexOf('--tools')+1]+'|model_override='+a.includes('--model');
  if(process.env.FAKE_REQUIRE_LITE_BUNDLE==='1') result.result+='|lite='+process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE+'|headless='+Boolean(process.env.CODEBUDDY_FORCE_HEADLESS_BUNDLE)+'|host='+Boolean(process.env.WORKBUDDY_AUTH_TOKEN);
  if(process.env.FAKE_ECHO_PORT==='1') result.result+='|port='+(a.includes('--port')?a[a.indexOf('--port')+1]:'none');
  if(process.env.FAKE_BIG_OUTPUT) result.result+='|'+'x'.repeat(Number(process.env.FAKE_BIG_OUTPUT))+'|end';
  const out=JSON.stringify(process.env.FAKE_LEGACY_HELP==='1'?[{type:'message'},result]:result);
  // 照真实 CLI 的收尾：一次写完整份结果，紧接着 process.exit()。
  if(process.env.FAKE_EXIT_AFTER_WRITE==='1'){process.stdout.write(out+'\\n');process.exit(0)}
  console.log(out);
});
`);
  return { dir, bin };
}

function fakeCodex(): { dir: string; bin: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-codex-"));
  const home = path.join(dir, "user-codex-home");
  fs.mkdirSync(home);
  const bin = fakeNodeExecutable(dir, "codex", `
const fs=require('node:fs');
const path=require('node:path');
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli '+(process.env.FAKE_CODEX_VERSION||'0.160.0'));process.exit(0)}
if(a[0]==='login'&&a[1]==='status'){
  const mode=process.env.FAKE_CODEX_LOGIN||'chatgpt';
  if(mode==='chatgpt'){console.error('Logged in using ChatGPT');process.exit(0)}
  if(mode==='api_key'){console.error('Logged in using an API key - sk-proj-***SECRET');process.exit(0)}
  if(mode==='logged_out'){console.error('Not logged in');process.exit(1)}
  console.error('Error checking login status: private-diagnostic');process.exit(1)
}
if(a[0]!=='exec'){process.exit(2)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  const ev=(o)=>console.log(JSON.stringify(o));
  ev({type:'thread.started',thread_id:'t1'});
  ev({type:'item.completed',item:{id:'item_0',type:'error',message:'Code Mode is unavailable because code-mode host is disabled.'}});
  ev({type:'turn.started'});
  if(process.env.FAKE_CODEX_TURN_FAILED){ev({type:'turn.failed',error:{message:process.env.FAKE_CODEX_TURN_FAILED}});process.exit(1)}
  if(process.env.FAKE_CODEX_SHELL==='1'){
    ev({type:'item.started',item:{id:'item_1',type:'command_execution',command:'cat ~/.ssh/id_rsa',status:'in_progress'}});
    setInterval(()=>{},1000);return;
  }
  if(process.env.FAKE_CODEX_TOOL){ev({type:'item.started',item:{id:'item_t',type:'mcp_tool_call',server:process.env.FAKE_CODEX_TOOL.split(':')[0],tool:process.env.FAKE_CODEX_TOOL.split(':')[1],arguments:{},status:'in_progress'}});}
  ev({type:'item.completed',item:{id:'item_2',type:'agent_message',text:'先说一句过程话'}});
  const schemaAt=a.indexOf('--output-schema');
  const images=a.filter(x=>x.startsWith('--image=')).map(x=>x.slice(8));
  const report={
    input,
    apiKey:Boolean(process.env.CODEX_API_KEY||process.env.OPENAI_API_KEY),
    home:process.env.CODEX_HOME||null,
    cwdIsC:fs.realpathSync(a[a.indexOf('-C')+1])===fs.realpathSync(process.cwd()),
    schema:schemaAt>=0?JSON.parse(fs.readFileSync(a[schemaAt+1],'utf8')):null,
    images:images.map(f=>({ext:path.extname(f),bytes:fs.readFileSync(f).length})),
    noPromptInArgv:!a.join(' ').includes('USER_SECRET_PROMPT'),
  };
  ev({type:'item.completed',item:{id:'item_3',type:'agent_message',text:JSON.stringify(report)}});
  ev({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
});
`);
  return { dir, bin, home };
}

test("Codex 探针只认用户自己的 ChatGPT 登录：API key 登录、未登录、读取失败、版本过旧各有结论且不外泄原文", async () => {
  const f = fakeCodex();
  try {
    const env = { ...PLATFORM_ENV, CODEX_BIN: f.bin, PATH: "", CODEX_HOME: f.home };
    const ready = await probeCodex(env);
    assert.equal(ready.status, "ready");
    assert.equal(ready.version, "0.160.0");
    const apiKey = await probeCodex({ ...env, FAKE_CODEX_LOGIN: "api_key" });
    assert.equal(apiKey.status, "not_authenticated");
    assert.match(apiKey.detail, /API key/);
    assert.doesNotMatch(JSON.stringify(apiKey), /SECRET|sk-proj/);
    assert.equal((await probeCodex({ ...env, FAKE_CODEX_LOGIN: "logged_out" })).status, "not_authenticated");
    const broken = await probeCodex({ ...env, FAKE_CODEX_LOGIN: "broken" });
    assert.equal(broken.status, "probe_failed", "同为 exit 1，读取失败不能当成未登录");
    assert.doesNotMatch(JSON.stringify(broken), /private-diagnostic/);
    const old = await probeCodex({ ...env, FAKE_CODEX_VERSION: "0.159.9" });
    assert.equal(old.status, "probe_failed");
    assert.equal(old.version, "0.159.9");
    assert.match(old.detail, /0\.160\.0/);
    assert.equal((await probeCodex({ ...PLATFORM_ENV, PATH: "", CODEX_BIN: path.join(f.dir, "missing-codex") })).status, "not_installed");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Codex 版本号解析与最低版本比较按数值逐段比，不按字符串比", () => {
  assert.equal(parseCodexVersion("codex-cli 0.160.0\n"), "0.160.0");
  assert.equal(parseCodexVersion("codex-cli 1.2.3-alpha.4"), "1.2.3");
  assert.equal(parseCodexVersion("unknown"), null);
  assert.equal(codexVersionSupported("0.160.0"), true);
  assert.equal(codexVersionSupported("0.161.0"), true);
  assert.equal(codexVersionSupported("1.0.0"), true);
  assert.equal(codexVersionSupported("0.99.0"), false, "字符串比较会把 0.99 判成比 0.160 新");
  assert.equal(codexVersionSupported(null), false);
  assert.equal(parseCodexLoginStatus("", "Logged in using ChatGPT\n", 0), "chatgpt");
  assert.equal(parseCodexLoginStatus("", "Not logged in", 1), "logged_out");
  assert.equal(parseCodexLoginStatus("", "Not logged in", 0), null);
  assert.equal(parseCodexLoginStatus("", "Logged in using ChatGPT", 1), null);
});

test("Codex 参数：关闭用户配置、会话落盘、内建工具与子代理，正文只走 stdin，系统指令按 TOML 字符串转义", () => {
  const system = '规则 "引号" \\ 反斜杠\n换行\u007f' + "\ud800";
  const args = codexArgs(system, "/tmp/work");
  assert.deepEqual(args.slice(0, 3), ["exec", "-", "--json"]);
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2), ["-s", "read-only"]);
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", "/tmp/work"]);
  for (const feature of ["shell_tool", "unified_exec", "multi_agent", "apps", "plugins", "memories", "hooks", "standalone_web_search"]) {
    assert.ok(args.some((x, i) => x === feature && args[i - 1] === "--disable"), feature);
  }
  assert.ok(args.includes("agents.enabled=false"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("features.code_mode={enabled=false,direct_only_tool_namespaces=[]}"));
  const dev = args.find((x) => x.startsWith("developer_instructions="))!;
  assert.equal(dev, `developer_instructions="规则 \\"引号\\" \\\\ 反斜杠\\n换行\\u007f�"`);
  assert.equal(tomlString("\u0000\t"), '"\\u0000\\t"');
  assert.ok(!args.some((x) => x.startsWith("mcp_servers.")), "普通对话不挂任何 MCP");
});

test("Codex Deep 只挂一个受控 MCP，工具白名单与 direct-only 命名空间一致", () => {
  const controlledMcp = { serverName: "vra", command: "/usr/bin/node", args: ["/app/run_tools_mcp.ts", 'x"y'],
    env: { VRA_RUN_DIR: "/data/runs/r1" }, allowedTools: ["mcp__vra__read_run_file", "mcp__vra__write_stage"] };
  const args = codexArgs("SYSTEM", "/tmp/work", { controlledMcp, outputSchemaFile: "/tmp/work/output-schema.json", imageFiles: ["/tmp/work/image-1.png"] });
  assert.ok(args.includes('features.code_mode={enabled=false,direct_only_tool_namespaces=["mcp__vra"]}'));
  assert.ok(args.includes('mcp_servers.vra.command="/usr/bin/node"'));
  assert.ok(args.includes('mcp_servers.vra.args=["/app/run_tools_mcp.ts","x\\"y"]'));
  assert.ok(args.includes('mcp_servers.vra.env={"VRA_RUN_DIR"="/data/runs/r1"}'));
  assert.ok(args.includes('mcp_servers.vra.enabled_tools=["read_run_file","write_stage"]'));
  assert.ok(args.includes("mcp_servers.vra.required=true"));
  assert.deepEqual(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2), ["--output-schema", "/tmp/work/output-schema.json"]);
  assert.ok(args.includes("--image=/tmp/work/image-1.png"));
  assert.throws(() => codexArgs("S", "/tmp", { controlledMcp: { ...controlledMcp, serverName: "a.b=c" } }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_mcp");
});

test("Codex 事件白名单：只放行回答、推理、指定服务的白名单工具；越界立即给出终止理由", () => {
  const mcp = { serverName: "vra", command: "node", args: [], env: {}, allowedTools: ["mcp__vra__read_run_file"] };
  const ok = new CodexEventStream(mcp);
  for (const line of [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"id":"e0","type":"error","message":"Code Mode is unavailable"}}',
    "not json diagnostics",
    '{"type":"item.started","item":{"id":"c1","type":"mcp_tool_call","server":"vra","tool":"read_run_file"}}',
    '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"过程"}}',
    '{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"想"}}',
    '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"最终回答"}}',
    '{"type":"turn.completed","usage":{}}',
  ]) assert.equal(ok.push(line), null, line);
  assert.equal(ok.result(), "最终回答");
  assert.equal(ok.diagnostics(), "", "启动提示类的条目级 error 不参与失败分类");

  for (const item of [
    { id: "x", type: "command_execution", command: "ls" },
    { id: "x", type: "file_change", changes: [] },
    { id: "x", type: "web_search", query: "q" },
    { id: "x", type: "collab_tool_call", tool: "spawn_agent" },
    { id: "x", type: "mcp_tool_call", server: "other", tool: "read_run_file" },
    { id: "x", type: "mcp_tool_call", server: "vra", tool: "write_stage" },
  ]) {
    const stream = new CodexEventStream(mcp);
    assert.ok(stream.push(JSON.stringify({ type: "item.started", item })), JSON.stringify(item));
  }
  assert.ok(new CodexEventStream().push('{"type":"item.started","item":{"id":"c","type":"mcp_tool_call","server":"vra","tool":"read_run_file"}}'),
    "没有挂受控 MCP 的普通对话出现任何工具调用都算越界");

  const capped = new CodexEventStream({ ...mcp, maxTurns: 1 });
  let violation: string | null = null;
  for (let i = 0; i < 40 && !violation; i += 1) {
    violation = capped.push(JSON.stringify({ type: "item.started", item: { id: `c${i}`, type: "mcp_tool_call", server: "vra", tool: "read_run_file" } }));
  }
  assert.match(violation ?? "", /超过 32 次/);

  const failed = new CodexEventStream();
  failed.push('{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}');
  assert.match(failed.diagnostics(), /usage limit/);
  assert.throws(() => failed.result(), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_failed");
  const truncated = new CodexEventStream();
  truncated.push('{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"半截"}}');
  assert.throws(() => truncated.result(), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_failed", "没有 turn.completed 不能当成功");
});

test("Codex 执行：正文走 stdin，API key 进不了子进程，用户 CODEX_HOME 保留，结构化 schema 与图片写进一次性工作区", async () => {
  const f = fakeCodex();
  try {
    const env = { ...PLATFORM_ENV, CODEX_BIN: f.bin, PATH: "", CODEX_HOME: f.home, CODEX_API_KEY: "leak-marker", OPENAI_API_KEY: "leak-marker" };
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const raw = await runLocalAgent("codex", { systemPrompt: "SYSTEM", userPrompt: "USER_SECRET_PROMPT", env,
      outputSchema: { type: "object", properties: { a: { type: "string" } } },
      userImages: [{ name: "截图.png", data: png, mimeType: "image/png" }] });
    const report = JSON.parse(raw) as { input: string; apiKey: boolean; home: string; cwdIsC: boolean; schema: unknown; images: { ext: string; bytes: number }[]; noPromptInArgv: boolean };
    assert.match(report.input, /^USER_SECRET_PROMPT/);
    assert.match(report.input, /附图 1：source_file="截图\.png"/);
    assert.equal(report.apiKey, false);
    assert.equal(report.home, f.home);
    assert.equal(report.cwdIsC, true);
    assert.deepEqual(report.schema, { type: "object", properties: { a: { type: "string" } } });
    assert.deepEqual(report.images, [{ ext: ".png", bytes: 8 }]);
    assert.equal(report.noPromptInArgv, true);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Codex 执行前复核登录方式：API key 登录或版本过旧时不启动 exec", async () => {
  const f = fakeCodex();
  try {
    const env = { ...PLATFORM_ENV, CODEX_BIN: f.bin, PATH: "", CODEX_HOME: f.home };
    await assert.rejects(runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_LOGIN: "api_key" } }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated" && !/SECRET/.test(e.message));
    await assert.rejects(runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_VERSION: "0.150.0" } }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cli_too_old");
    await assert.rejects(runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_TURN_FAILED: "You've hit your usage limit." } }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_quota");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Codex 越出白名单（尝试执行命令、调用未授权工具）立即杀掉进程树并报策略违规", async () => {
  const f = fakeCodex();
  try {
    const env = { ...PLATFORM_ENV, CODEX_BIN: f.bin, PATH: "", CODEX_HOME: f.home };
    const started = Date.now();
    await assert.rejects(runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_SHELL: "1" }, timeoutMs: 60_000 }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_policy_violation");
    assert.ok(Date.now() - started < 20_000, "越界后不能等到超时才收尾");
    const mcp = { serverName: "vra", command: process.execPath, args: [], env: {}, allowedTools: ["mcp__vra__read_run_file"] };
    await assert.rejects(runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_TOOL: "vra:write_stage" }, controlledMcp: mcp }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_policy_violation");
    const allowed = await runLocalAgent("codex", { systemPrompt: "S", userPrompt: "U", env: { ...env, FAKE_CODEX_TOOL: "vra:read_run_file" }, controlledMcp: mcp });
    assert.match(allowed, /"input":"U"/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
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

test("Claude 每次调用前都核对能力与订阅登录:API key / Bedrock / 未登录 / 旧版都不启动,检测失败不冒充退出登录", async () => {
  const f = fakeClaude();
  try {
    const call = (extra: Record<string, string>) => runLocalAgent("claude", { systemPrompt: "规则", userPrompt: "测试",
      env: { ...PLATFORM_ENV, CLAUDE_BIN: f.bin, PATH: process.env.PATH, ...extra } });
    const notSubscription: Record<string, string>[] = [{ FAKE_AUTH_METHOD: "api_key" }, { FAKE_API_PROVIDER: "bedrock" }, { FAKE_AUTH_LOGGED_OUT: "1" }];
    for (const extra of notSubscription) {
      await assert.rejects(call(extra), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated", JSON.stringify(extra));
    }
    await assert.rejects(call({ FAKE_OLD_HELP: "1" }), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cli_too_old");
    for (const flag of ["FAKE_AUTH_FAILURE", "FAKE_AUTH_MALFORMED"]) {
      await assert.rejects(call({ [flag]: "1" }), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_probe_failed" &&
        !/secret-account|EACCES|hidden@/.test(e.message), flag);
    }
    assert.equal(await call({}), "测试|keys=false|oauth=false");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("探针进行中取消:不再启动研究进程,如实报取消(Claude / Codex 探针随取消停下,CodeBuddy 等探针结束后不再启动)", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-probe-cancel-"));
  // 盯住真正的研究进程:spawn 参数里带着本次系统提示词的就是它(探针进程不带)。
  // 研究进程一启动就会被立刻终止,来不及在磁盘上留记号,只能在启动那一刻看。
  const PROMPT = "PROBE-CANCEL-RULES";
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const realSpawn = childProcess.spawn;
  let researchSpawns = 0;
  childProcess.spawn = function (this: unknown, ...a: unknown[]) {
    if (Array.isArray(a[1]) && a[1].some((x) => String(x).includes(PROMPT))) researchSpawns += 1;
    return (realSpawn as (...x: unknown[]) => unknown).apply(this, a);
  } as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = realSpawn; syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  const wait = (ms: number) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms});`;
  const claude = fakeNodeExecutable(dir, "claude", `
const a=process.argv.slice(2);
if(a[0]==='--help'){${wait(3000)}console.log('--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema');process.exit(0)}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:'ran'})));
`);
  const codex = fakeNodeExecutable(dir, "codex", `
const a=process.argv.slice(2);
if(a[0]==='--version'){${wait(3000)}console.log('codex-cli 0.160.0');process.exit(0)}
if(a[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}
process.exit(0);
`);
  for (const [agent, env] of [["claude", { CLAUDE_BIN: claude }], ["codex", { CODEX_BIN: codex }]] as const) {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(runLocalAgent(agent, { systemPrompt: PROMPT, userPrompt: "测试", signal: ac.signal,
      env: { ...PLATFORM_ENV, PATH: process.env.PATH, ...env } }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cancelled", agent);
    assert.ok(Date.now() - started < 2_500, `${agent} 的探针应随取消立即停下`);
  }
  const codebuddy = fakeNodeExecutable(dir, "codebuddy", `
const a=process.argv.slice(2);
if(a[0]==='--version'){${wait(1500)}console.log('2.143.1 (CodeBuddy Code)');process.exit(0)}
if(a[0]==='--help'){console.log('--tools --strict-mcp-config --mcp-config --setting-sources --input-format --output-format --system-prompt --json-schema --max-turns --agent --permission-mode --subagent-permission-mode --no-session-persistence');process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  if(a.includes('--input-format=stream-json')){const req=JSON.parse(input.trim());console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{account:{userId:'u',token:'t'}}}}));return}
  console.log(JSON.stringify({result:'ran'}));
});
`);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: PROMPT, userPrompt: "测试", signal: ac.signal,
    env: { ...PLATFORM_ENV, PATH: process.env.PATH, CODEBUDDY_BIN: codebuddy } }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cancelled", "codebuddy");
  assert.equal(researchSpawns, 0, "取消之后不许再启动研究进程");
  // 对照:没取消时同一个监视看得到研究进程启动 —— 证明上面的 0 不是监视失灵
  const quickDir = path.join(dir, "quick");
  fs.mkdirSync(quickDir);
  const quick = fakeNodeExecutable(quickDir, "claude", `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:'ok'})));`);
  assert.equal(await runLocalAgent("claude", { systemPrompt: PROMPT, userPrompt: "测试", env: { ...PLATFORM_ENV, PATH: process.env.PATH, CLAUDE_BIN: quick } }), "ok");
  assert.equal(researchSpawns, 1);
});

test("Claude 正常返回也清理 stdio 独立的存活后代", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-success-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pid");
  const bin = fakeNodeExecutable(dir, "claude", `
const c=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'ignore'});
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:'done'})));
`);
  assert.equal(await runLocalAgent("claude", { systemPrompt: "test", userPrompt: "test", env: { ...PLATFORM_ENV, CLAUDE_BIN: bin } }), "done");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("参数无效或同步启动失败都不占住并发槽位:失败多次后仍能同时跑满 4 个,第 5 个才被拒", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-claude-slots-"));
  const go = path.join(dir, "go");
  const bin = fakeNodeExecutable(dir, "claude", `
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.1.226 (Claude Code)');process.exit(0)}
const fs=require('node:fs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  const wait=()=>fs.existsSync(${JSON.stringify(go)})?console.log(JSON.stringify({result:'ok'})):setTimeout(wait,20);wait();
});
`);
  const env = { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH };
  const code = (expected: string) => (e: unknown) => e instanceof LocalAgentError && e.code === expected;
  try {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(runLocalAgent("claude", { systemPrompt: "s", userPrompt: "u", env, timeoutMs: Number.NaN }), code("agent_bad_timeout"));
      await assert.rejects(runLocalAgent("claude", { systemPrompt: "bad\u0000prompt", userPrompt: "u", env }), code("agent_launch_failed"));
    }
    const running = [1, 2, 3, 4].map(() => runLocalAgent("claude", { systemPrompt: "s", userPrompt: "u", env, timeoutMs: 60_000 }));
    await assert.rejects(runLocalAgent("claude", { systemPrompt: "s", userPrompt: "u", env }), code("agent_busy"));
    fs.writeFileSync(go, "");
    assert.deepEqual(await Promise.all(running), ["ok", "ok", "ok", "ok"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Claude JSON 输出优先 structured_output，坏输出明确失败", () => {
  assert.equal(parseClaudeOutput('{"result":"普通回答"}'), "普通回答");
  assert.equal(parseClaudeOutput('{"result":"忽略","structured_output":{"ok":true}}'), '{"ok":true}');
  assert.throws(() => parseClaudeOutput("not json"), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_output");
});

test("Claude 管道分割中文和 emoji 字节时不损坏回答", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-utf8-"));
  const answer = "中文🦊测试";
  const bin = fakeNodeExecutable(dir, "claude", `
process.stdin.resume(); process.stdin.on('end', () => {
 const b=Buffer.from(JSON.stringify({result:${JSON.stringify(answer)}})); let i=0;
 const t=setInterval(()=>{ if(i===b.length){clearInterval(t);return;} process.stdout.write(b.subarray(i,i+1)); i++; },5);
});`);
  try {
    assert.equal(await runLocalAgent("claude", { systemPrompt: "规则", userPrompt: "测试",
      env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH } }), answer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  assert.ok(!args.includes("--port"), "老版本不认识的参数默认不传");
  const withPort = codeBuddyArgs("SYSTEM", { type: "object" }, false, undefined, true);
  assert.deepEqual(withPort.slice(0, 3), ["-p", "--port", "0"]);
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

test("Windows 自动检测补上改了盘符的 WorkBuddy 与 CodeBuddy 官方原生安装(#50)", () => {
  const app = workBuddyCliCandidates({ LOCALAPPDATA: "C:\\Users\\Simon\\AppData\\Local" }, "win32");
  for (const root of ["D:\\Program Files\\WorkBuddy", "D:\\WorkBuddy", "E:\\Program Files\\WorkBuddy", "E:\\WorkBuddy", "C:\\WorkBuddy"]) {
    assert.ok(app.includes(`${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`), root);
  }
  assert.equal(new Set(app).size, app.length, "同一位置不重复检测");
  assert.deepEqual(codeBuddyNativeCandidates({ LOCALAPPDATA: "C:\\Users\\Simon\\AppData\\Local", USERPROFILE: "C:\\Users\\Simon" }, "win32"),
    ["C:\\Users\\Simon\\AppData\\Local\\codebuddy\\bin\\codebuddy.exe"]);
  assert.deepEqual(codeBuddyNativeCandidates({ USERPROFILE: "C:\\Users\\Simon" }, "win32"),
    ["C:\\Users\\Simon\\AppData\\Local\\codebuddy\\bin\\codebuddy.exe"]);
  assert.deepEqual(codeBuddyNativeCandidates({ LOCALAPPDATA: "C:\\Users\\Simon\\AppData\\Local" }, "darwin"), []);
  // 真正去找的顺序:PATH → 官方原生安装 → WorkBuddy 桌面版内置;只有 codebuddy 才找这两类
  const winEnv = { LOCALAPPDATA: "C:\\Users\\Simon\\AppData\\Local", PATH: "C:\\Tools" };
  const order = executableCandidates("codebuddy", winEnv, "win32");
  const native = order.indexOf("C:\\Users\\Simon\\AppData\\Local\\codebuddy\\bin\\codebuddy.exe");
  const onPath = order.findIndex((c) => c.startsWith("C:\\Tools"));
  const dDrive = order.indexOf("D:\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy");
  assert.ok(onPath >= 0 && native > onPath && dDrive > native, JSON.stringify({ onPath, native, dDrive }));
  assert.ok(!executableCandidates("claude", winEnv, "win32").some((c) => /codebuddy|WorkBuddy/i.test(c)));
  assert.deepEqual(executableCandidates("codebuddy", { ...winEnv, CODEBUDDY_BIN: " D:\\x\\codebuddy.exe " }, "win32"), ["D:\\x\\codebuddy.exe"],
    "环境变量指定了就只认它");
});

test("手动指定位置:Windows 可填安装文件夹 / WorkBuddy.exe / codebuddy 本身,别的程序与网络路径一律不收", () => {
  const binDir = "D:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin";
  const dir = codeBuddyLocationCandidates("D:\\Apps\\WorkBuddy", "dir", "win32");
  assert.ok(dir.includes(`${binDir}\\codebuddy`) && dir.includes(`${binDir}\\codebuddy.exe`));
  assert.ok(dir.includes("D:\\Apps\\WorkBuddy\\codebuddy.exe"), "也可以直接填 codebuddy 所在的文件夹");
  const exe = codeBuddyLocationCandidates("D:\\Apps\\WorkBuddy\\WorkBuddy.exe", "file", "win32");
  assert.ok(exe.includes(`${binDir}\\codebuddy`) && exe.every((c) => c.startsWith(`${binDir}\\`)), "填 WorkBuddy.exe = 用它所在的安装文件夹");
  assert.deepEqual(codeBuddyLocationCandidates("D:\\Tools\\CodeBuddy.EXE", "file", "win32"), ["D:\\Tools\\CodeBuddy.EXE"]);
  for (const other of ["C:\\Windows\\System32\\cmd.exe", "D:\\Apps\\WorkBuddy\\Uninstall WorkBuddy.exe", "D:\\x\\codebuddy.bat", "D:\\x\\codebuddy-evil.exe"]) {
    assert.deepEqual(codeBuddyLocationCandidates(other, "file", "win32"), [], other);
  }
  assert.ok(codeBuddyLocationCandidates("/Volumes/Apps/WorkBuddy.app", "dir", "darwin")
    .includes("/Volumes/Apps/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"));
  const code = (input: string, env: NodeJS.ProcessEnv = {}) => {
    try { resolveCodeBuddyLocation(input, env, "win32"); return "ok"; }
    catch (e) { return e instanceof LocalAgentError ? e.code : String(e); }
  };
  for (const bad of ["", "   ", "WorkBuddy", "\\WorkBuddy", "\\\\server\\share\\WorkBuddy", "\\\\?\\D:\\WorkBuddy", "D:\\a\nb", `D:\\${"x".repeat(1100)}`, "%NOPE%\\WorkBuddy"]) {
    assert.equal(code(bad), "bad_agent_path", JSON.stringify(bad));
  }
  // %变量% 展开后成了盘符路径:过了格式这关,只是这台机器上没有这个位置
  assert.equal(code("%LOCALAPPDATA%\\Programs\\WorkBuddy", { localappdata: "C:\\vra-nonexistent-test\\Local" }), "agent_path_not_found");
  assert.equal(code("\"D:/vra-nonexistent-test/WorkBuddy\""), "agent_path_not_found", "引号与正斜杠都认");
});

test("手动指定位置:按真实目录解析,引号 / ~ / .app 都认,找不到或不能运行就说清楚", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-wb-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, "My Apps", "WorkBuddy");
  const binDir = path.join(install, "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const cli = path.join(binDir, "codebuddy");
  fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(resolveCodeBuddyLocation(install), cli);
  assert.equal(resolveCodeBuddyLocation(`  "${install}"  `), cli, "复制来的路径两头带引号");
  assert.equal(resolveCodeBuddyLocation(`'${install}/'`), cli);
  assert.equal(resolveCodeBuddyLocation(binDir), cli, "直接填 codebuddy 所在文件夹");
  assert.equal(resolveCodeBuddyLocation(cli), cli);
  assert.equal(resolveCodeBuddyLocation("~/My Apps/WorkBuddy", { HOME: root }), cli);
  const appBin = path.join(root, "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(appBin, { recursive: true });
  fs.writeFileSync(path.join(appBin, "codebuddy"), "#!/bin/sh\n", { mode: 0o700 });
  if (process.platform === "darwin") assert.equal(resolveCodeBuddyLocation(path.join(root, "WorkBuddy.app")), path.join(appBin, "codebuddy"));
  const code = (input: string) => {
    try { resolveCodeBuddyLocation(input, { HOME: root }); return "ok"; }
    catch (e) { return e instanceof LocalAgentError ? e.code : String(e); }
  };
  assert.equal(code("My Apps/WorkBuddy"), "bad_agent_path", "相对路径不收");
  assert.equal(code(path.join(root, "nope")), "agent_path_not_found");
  assert.equal(code(root), "agent_path_no_cli", "文件夹里没有 CLI");
  const other = path.join(root, "evil");
  fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(code(other), "bad_agent_path", "别的程序不收");
  fs.chmodSync(cli, 0o600);
  assert.equal(code(install), "agent_path_no_cli", "没有执行权限的不算");
});

test("手动指定位置:保存后各入口都按它找;清除回到自动检测;环境变量优先;不收数据目录里的程序;坏文件不拖垮启动", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-wb-save-"));
  const dataRoot = path.join(root, "data");
  const file = path.join(dataRoot, AGENT_PATHS_FILE);
  const other = fakeCodeBuddy();
  t.after(() => {
    loadSavedAgentPaths(path.join(root, "absent"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  });
  const binDir = path.join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const { bin } = fakeCodeBuddy(binDir);
  const env = { ...PLATFORM_ENV, PATH: "" };

  const status = await saveCodeBuddyLocation(dataRoot, path.join(root, "WorkBuddy"), env);
  assert.equal(status.status, "ready");
  assert.equal(status.custom_path, true);
  assert.ok(!JSON.stringify(status).includes(root), "状态里不回传路径");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).codebuddy_bin, bin);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(findExecutable("codebuddy", env), bin);
  assert.equal(executableCandidates("codebuddy", env)[0], bin, "保存的位置排在 PATH 与自动检测前面");

  // 研究子进程 / 体检是另起的进程:启动时从同一个数据根读进来
  loadSavedAgentPaths(path.join(root, "absent"));
  assert.notEqual(findExecutable("codebuddy", env), bin);
  loadSavedAgentPaths(dataRoot);
  assert.equal(findExecutable("codebuddy", env), bin);

  // 环境变量 CODEBUDDY_BIN 设了就只认它,页面改不了;哪怕指向同一个文件,状态也不标「你指定的位置」
  assert.equal(findExecutable("codebuddy", { ...env, CODEBUDDY_BIN: other.bin }), other.bin);
  await assert.rejects(saveCodeBuddyLocation(dataRoot, other.dir, { ...env, CODEBUDDY_BIN: other.bin }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_path_env_locked");
  assert.notEqual((await probeCodeBuddy({ ...env, CODEBUDDY_BIN: bin })).custom_path, true);

  // 数据目录里的程序不收:页面能往那里写文件
  const planted = path.join(dataRoot, "uploads", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(planted, { recursive: true });
  fakeNodeExecutable(planted, "codebuddy", "process.exit(0)");
  await assert.rejects(saveCodeBuddyLocation(dataRoot, path.join(dataRoot, "uploads", "WorkBuddy"), env),
    (e: unknown) => e instanceof LocalAgentError && e.code === "bad_agent_path");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).codebuddy_bin, bin, "拒绝时不动已保存的位置");
  if (process.platform !== "win32") {
    // 绕一道符号链接也不行:按真实路径判断
    fs.symlinkSync(path.join(dataRoot, "uploads", "WorkBuddy"), path.join(root, "innocent"));
    await assert.rejects(saveCodeBuddyLocation(dataRoot, path.join(root, "innocent"), env),
      (e: unknown) => e instanceof LocalAgentError && e.code === "bad_agent_path");
  }
  await assert.rejects(saveCodeBuddyLocation(dataRoot, path.join(root, "nope"), env),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_path_not_found");
  assert.equal(findExecutable("codebuddy", env), bin);

  // 清除:删文件、回到自动检测(替身探针:不去跑这台机器上真装的 WorkBuddy)
  let probed = 0;
  const stub = async () => { probed += 1; return status; };
  await saveCodeBuddyLocation(dataRoot, "  ", env, stub);
  assert.equal(probed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.notEqual(findExecutable("codebuddy", env), bin);
  await saveCodeBuddyLocation(dataRoot, null, env, stub);
  assert.equal(probed, 2, "没有保存过也能清除");

  // 坏文件 / 不合格内容 / 已失效的位置:当没设,回到自动检测,不抛错
  fs.mkdirSync(dataRoot, { recursive: true });
  const autoOnly = executableCandidates("codebuddy", env);
  for (const content of ["{not json", "null", JSON.stringify({ codebuddy_bin: 42 }), JSON.stringify({ codebuddy_bin: "codebuddy" }),
    JSON.stringify({ codebuddy_bin: `${bin}\n` })]) {
    fs.writeFileSync(file, content);
    loadSavedAgentPaths(dataRoot);
    assert.deepEqual(executableCandidates("codebuddy", env), autoOnly, `${content}:相对路径会按当前目录去找,不能当真`);
  }
  fs.writeFileSync(file, JSON.stringify({ codebuddy_bin: path.join(root, "moved", "codebuddy") }));
  loadSavedAgentPaths(dataRoot);
  assert.notEqual(findExecutable("codebuddy", env), path.join(root, "moved", "codebuddy"), "WorkBuddy 搬走后照常自动检测");
});

test("#50 保存过的位置失效后(WorkBuddy 搬走 / 卸载)仍标记 saved_path,页面才能给出「恢复自动检测」;环境变量锁定时两项都是 false", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-wb-flags-"));
  t.after(() => { loadSavedAgentPaths(path.join(root, "absent")); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...PLATFORM_ENV, PATH: "" };
  loadSavedAgentPaths(path.join(root, "absent"));
  assert.deepEqual(codeBuddyPathFlags(null, env), { custom_path: false, saved_path: false });
  assert.deepEqual(codeBuddyPathFlags(path.join(root, "x"), env), { custom_path: false, saved_path: false });

  const moved = path.join(root, "moved", "codebuddy");
  fs.writeFileSync(path.join(root, AGENT_PATHS_FILE), JSON.stringify({ codebuddy_bin: moved }));
  loadSavedAgentPaths(root);
  assert.deepEqual(codeBuddyPathFlags(null, env), { custom_path: false, saved_path: true }, "找不到程序也要能清掉这条失效记录");
  assert.deepEqual(codeBuddyPathFlags(path.join(root, "auto", "codebuddy"), env), { custom_path: false, saved_path: true });
  assert.deepEqual(codeBuddyPathFlags(moved, env), { custom_path: true, saved_path: true });
  assert.deepEqual(codeBuddyPathFlags(moved, { ...env, CODEBUDDY_BIN: moved }), { custom_path: false, saved_path: false }, "环境变量优先,页面改不了");
  // 探针的「未安装」分支也带上这一项
  const source = fs.readFileSync(new URL("../src/local_agent_runtime.ts", import.meta.url), "utf8");
  assert.match(source, /status: "not_installed",\s*detail: process\.platform === "win32"[\s\S]{0,200}?"本机未检测到 CodeBuddy Code CLI",\s*saved_path: codeBuddyPathFlags\(null, env\)\.saved_path/);
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

function codeBuddyFallbackFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-wb-fallback-"));
  t.after(() => { loadSavedAgentPaths(path.join(root, "absent")); fs.rmSync(root, { recursive: true, force: true }); });
  const standaloneDir = path.join(root, "standalone");
  const bundledDir = path.join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.mkdirSync(bundledDir, { recursive: true });
  const standalone = fakeCodeBuddy(standaloneDir);
  const bundled = fakeCodeBuddy(bundledDir);
  const configure = (cli: typeof standalone, flags: NodeJS.ProcessEnv) => fixtureConfig({
    CODEBUDDY_BIN: cli.bin, FAKE_CALLS_FILE: path.join(cli.dir, "calls"),
    FAKE_EXEC_MARKER: path.join(cli.dir, "executed"), ...flags,
  });
  configure(standalone, { FAKE_NOT_LOGGED: "1" });
  // 能借到登录的 WorkBuddy 内置版带 token；只回 uid / userId 的是借不到（#56），见下面专门的用例。
  configure(bundled, { FAKE_VERSION: "2.161.0 (CodeBuddy Code)" });
  const calls = (cli: typeof standalone) => fs.existsSync(path.join(cli.dir, "calls"))
    ? fs.readFileSync(path.join(cli.dir, "calls"), "utf8").trim().split("\n") : [];
  // Linux 没有固定候选；macOS 的 /Applications 可能有真实登录。注入候选，三平台都只运行临时替身。
  // 放入已选路径，顺便验证回退会跳过它，不能重复探测独立版。
  const candidates = async () => [standalone.bin, path.join(root, "missing"), bundled.bin];
  const env = { ...PLATFORM_ENV, PATH: standalone.dir };
  return { root, standalone, bundled, configure, calls, candidates, env };
}

test("#56 自动找到未登录独立版时，卡片与调用都选择已登录的 WorkBuddy 内置 CLI", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  assert.equal(findExecutable("codebuddy", f.env), f.standalone.bin);
  const status = await realProbeCodeBuddy(f.env, f.candidates);
  assert.equal(status.status, "ready");
  assert.equal(status.version, "2.161.0 (CodeBuddy Code)");
  assert.equal(status.custom_path, false);
  assert.equal(status.saved_path, false);
  assert.doesNotMatch(JSON.stringify(status), /secret-user|secret-token/);
  const probes = ["--version", "--help", "--input-format=stream-json"];
  assert.deepEqual(f.calls(f.standalone), probes);
  assert.deepEqual(f.calls(f.bundled), probes, "卡片检测的是内置版");
  assert.match(await realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, f.candidates), /^hello\|/);
  assert.deepEqual(f.calls(f.standalone), [...probes, ...probes]);
  assert.deepEqual(f.calls(f.bundled), [...probes, ...probes, "-p"], "实际回答仍由卡片检测的内置版执行");
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "executed")), true);
  assert.equal(fs.existsSync(path.join(f.standalone.dir, "executed")), false);
});

test("#56 Windows 固定候选未登录后才查询系统登记，卡片与调用选择已登录的自定义安装", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  const oldDir = path.join(f.root, "old-WorkBuddy");
  fs.mkdirSync(oldDir);
  const old = fakeCodeBuddy(oldDir);
  f.configure(old, { FAKE_NOT_LOGGED: "1" });
  let discoveries = 0;
  const candidates = () => workBuddyFallbackCandidates(f.env, {}, {
    platform: "win32", fixed: [f.standalone.bin, old.bin, old.bin],
    discover: async () => {
      discoveries += 1;
      assert.equal(f.calls(old).length, discoveries * 3, "问系统前已检查固定位置，重复候选只探测一次");
      return [old.bin, f.bundled.bin];
    },
  });
  const status = await realProbeCodeBuddy(f.env, candidates);
  assert.equal(status.status, "ready");
  assert.equal(status.version, "2.161.0 (CodeBuddy Code)");
  assert.match(await realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, candidates), /^hello\|/);
  assert.equal(discoveries, 2);
  assert.equal(f.calls(old).length, 6, "系统登记中重复的固定候选不再探测");
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "executed")), true);
  assert.equal(fs.existsSync(path.join(old.dir, "executed")), false);
  assert.equal(fs.existsSync(path.join(f.standalone.dir, "executed")), false);
  // 固定位置已登录时不查询系统登记，也不触及本机真实的 WorkBuddy。
  f.configure(old, {});
  assert.equal((await realProbeCodeBuddy(f.env, candidates)).status, "ready");
  assert.equal(discoveries, 2);
});

test("#56 初始探针后取消时不启动回退探针，并释放调用槽位", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  for (let i = 0; i < 5; i++) {
    const controller = new AbortController();
    const candidates = async () => {
      assert.equal(f.calls(f.standalone).length, (i + 1) * 3, "独立版初始化探针已完成");
      controller.abort();
      return [f.bundled.bin];
    };
    await assert.rejects(realRunLocalAgent("codebuddy", {
      systemPrompt: "规则", userPrompt: "hello", env: f.env, signal: controller.signal,
    }, candidates), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cancelled"
      && e.message === "CodeBuddy 请求已取消");
  }
  assert.deepEqual(f.calls(f.bundled), [], "取消后连回退探针也不能启动");
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "calls")), false);
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "executed")), false);
  assert.match(await realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, f.candidates), /^hello\|/);
});

test("#56 独立版与内置版都未登录时，保留原有未登录状态与错误文案", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  f.configure(f.bundled, { FAKE_ACCOUNT: "null" });
  const status = await realProbeCodeBuddy(f.env, f.candidates);
  assert.equal(status.status, "not_authenticated");
  assert.equal(status.version, "2.143.1 (CodeBuddy Code)");
  assert.equal(status.detail, "已安装；请先运行 codebuddy 并完成登录");
  await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, f.candidates),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated"
      && e.message === "CodeBuddy 登录已失效，请先运行 codebuddy 并完成登录");
  assert.equal(f.calls(f.bundled).length, 6, "两个入口都尝试过内置版");
});

// 状态和报错里不放安装命令：「@」会被当成账号拦下，命令由页面给。
const WORKBUDDY_LOCKED = /^借不到 WorkBuddy 的登录。[^@]*独立命令行 CodeBuddy Code[^@]*改用 API 接入/;

test("#56 WorkBuddy 内置 CLI 只回账号编号、没有 token 时（新版加密登录）按未登录处理，卡片与调用都说清原因", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  const candidates = async () => { assert.fail("明确指定的位置不得触发回退"); };
  const env = { ...f.env, CODEBUDDY_BIN: f.bundled.bin };
  for (const account of [{ uid: "secret-user", type: "personal", userId: "secret-user" }, null]) {
    f.configure(f.bundled, { FAKE_VERSION: "2.161.0 (CodeBuddy Code)", FAKE_ACCOUNT: JSON.stringify(account) });
    const status = await realProbeCodeBuddy(env, candidates);
    assert.equal(status.status, "not_authenticated", JSON.stringify(account));
    assert.equal(status.available, false);
    assert.equal(status.version, "2.161.0 (CodeBuddy Code)");
    assert.match(status.detail, WORKBUDDY_LOCKED);
    assert.match(status.detail, /CODEBUDDY_BIN 指定程序.*再重启/, "指定的位置不会被自动检测换掉，要说怎么撤掉");
    assert.doesNotMatch(JSON.stringify(status), /secret-user|@/);
    await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }, candidates),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated" && WORKBUDDY_LOCKED.test(e.message)
        && /CODEBUDDY_BIN/.test(e.message));
  }
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "executed")), false, "借不到登录时不启动回答");

  // 设置页指定了内置版的位置：提示先点「恢复自动检测」。
  fs.writeFileSync(path.join(f.root, AGENT_PATHS_FILE), JSON.stringify({ codebuddy_bin: f.bundled.bin }));
  loadSavedAgentPaths(f.root);
  const saved = await realProbeCodeBuddy(f.env, candidates);
  assert.equal(saved.status, "not_authenticated");
  assert.equal(saved.custom_path, true);
  assert.match(saved.detail, WORKBUDDY_LOCKED);
  assert.match(saved.detail, /设置页指定了 WorkBuddy 的位置.*「恢复自动检测」$/);
  await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, candidates),
    (e: unknown) => e instanceof LocalAgentError && /「恢复自动检测」$/.test(e.message));
  loadSavedAgentPaths(path.join(f.root, "absent"));

  // 旧 CLI 缺会话隔离参数时也一样：不是版本问题，升级也借不到。
  f.configure(f.bundled, { FAKE_LEGACY_HELP: "1", FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }) });
  const legacy = await realProbeCodeBuddy(env, candidates);
  assert.equal(legacy.status, "not_authenticated");
  assert.match(legacy.detail, WORKBUDDY_LOCKED);

  // 软链接到内置 CLI 的也认得出来。
  if (process.platform !== "win32") {
    const link = path.join(f.root, "linked", "codebuddy");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(f.bundled.bin, link);
    f.configure(f.bundled, { FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }) });
    const linked = await realProbeCodeBuddy({ ...f.env, CODEBUDDY_BIN: link }, candidates);
    assert.equal(linked.status, "not_authenticated");
    assert.match(linked.detail, WORKBUDDY_LOCKED);
  }
});

test("#56 自动找到的只有借不到登录的内置版时，提示不提指定位置", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  f.configure(f.bundled, { FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }) });
  // PATH 只放内置版所在目录：自动查找直接找到它，不经 CODEBUDDY_BIN 或设置页。
  const env = { ...PLATFORM_ENV, PATH: f.bundled.dir };
  assert.equal(findExecutable("codebuddy", env), f.bundled.bin);
  const status = await realProbeCodeBuddy(env, f.candidates);
  assert.equal(status.status, "not_authenticated");
  assert.equal(status.custom_path, false);
  assert.match(status.detail, WORKBUDDY_LOCKED);
  assert.doesNotMatch(status.detail, /CODEBUDDY_BIN|恢复自动检测|@/);
});

test("#56 独立版未登录、内置版借不到登录时，不回退到内置版，提示仍是独立版去登录", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  f.configure(f.bundled, { FAKE_VERSION: "2.161.0 (CodeBuddy Code)",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }) });
  const status = await realProbeCodeBuddy(f.env, f.candidates);
  assert.equal(status.status, "not_authenticated");
  assert.equal(status.version, "2.143.1 (CodeBuddy Code)", "卡片显示的是独立版");
  assert.equal(status.detail, "已安装；请先运行 codebuddy 并完成登录");
  await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, f.candidates),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated"
      && e.message === "CodeBuddy 登录已失效，请先运行 codebuddy 并完成登录");
  assert.equal(fs.existsSync(path.join(f.bundled.dir, "executed")), false);
  assert.equal(fs.existsSync(path.join(f.standalone.dir, "executed")), false);
});

test("#56 WorkBuddy 内置 CLI 检测时带 token、对话时被要求重新登录，报错同样说清借不到登录", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  f.configure(f.bundled, { FAKE_EXEC_NOT_LOGGED: "1" });
  const env = { ...f.env, CODEBUDDY_BIN: f.bundled.bin };
  assert.equal((await realProbeCodeBuddy(env, f.candidates)).status, "ready");
  await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }, f.candidates),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated" && WORKBUDDY_LOCKED.test(e.message));
  // 独立版碰到同样的输出，仍提示运行 codebuddy 登录。
  f.configure(f.standalone, { FAKE_EXEC_NOT_LOGGED: "1" });
  await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello",
    env: { ...f.env, CODEBUDDY_BIN: f.standalone.bin } }, f.candidates),
    (e: unknown) => e instanceof LocalAgentError && e.message === "CodeBuddy 登录已失效，请先运行 codebuddy 并完成登录");
});

test("isWorkBuddyBundledCli 只认 WorkBuddy 安装包里的 CLI（两种分隔符、不分大小写），独立安装不算", () => {
  for (const bin of [
    "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
    "D:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy.exe",
    "C:\\USERS\\A\\APPDATA\\LOCAL\\PROGRAMS\\WORKBUDDY\\RESOURCES\\APP.ASAR.UNPACKED\\CLI\\BIN\\CODEBUDDY",
  ]) assert.equal(isWorkBuddyBundledCli(bin), true, bin);
  // 反例只用临时目录里的普通文件和不存在的 Windows 路径：软链接会被解析，不能拿本机真实安装位置当反例。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-standalone-codebuddy-"));
  try {
    const npmBin = path.join(dir, "lib", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    fs.mkdirSync(path.dirname(npmBin), { recursive: true });
    fs.writeFileSync(npmBin, "");
    for (const bin of [
      npmBin,
      path.join(dir, "missing", "codebuddy"),
      "C:\\Users\\a\\AppData\\Roaming\\npm\\codebuddy.ps1",
      "C:\\Users\\a\\AppData\\Local\\codebuddy\\bin\\codebuddy.exe",
    ]) assert.equal(isWorkBuddyBundledCli(bin), false, bin);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("#56 CODEBUDDY_BIN 或设置页指定未登录程序时，卡片与调用都不回退", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  const candidates = async () => { assert.fail("明确指定的位置不得触发回退"); };
  for (const source of ["env", "saved"]) {
    if (source === "saved") {
      fs.writeFileSync(path.join(f.root, AGENT_PATHS_FILE), JSON.stringify({ codebuddy_bin: f.standalone.bin }));
      loadSavedAgentPaths(f.root);
    }
    const env = source === "env" ? { ...f.env, CODEBUDDY_BIN: f.standalone.bin } : f.env;
    const status = await realProbeCodeBuddy(env, candidates);
    assert.equal(status.status, "not_authenticated");
    assert.equal(status.custom_path, source === "saved");
    assert.equal(status.saved_path, source === "saved");
    await assert.rejects(realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }, candidates),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated");
  }
  assert.deepEqual(f.calls(f.bundled), []);
});

test("#56 已登录、检测失败或版本过旧时不触发 WorkBuddy 回退", async (t) => {
  const f = codeBuddyFallbackFixture(t);
  const candidates = async () => { assert.fail("只有明确未登录才能触发回退"); };
  for (const [flags, expected, error] of [
    [{}, "ready", null],
    [{ FAKE_PROBE_EXIT_CODE: "1" }, "probe_failed", "agent_probe_failed"],
    [{ FAKE_OLD_HELP: "1" }, "probe_failed", "agent_cli_too_old"],
  ] as const) {
    f.configure(f.standalone, flags);
    assert.equal((await realProbeCodeBuddy(f.env, candidates)).status, expected);
    const result = realRunLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: f.env }, candidates);
    if (error) await assert.rejects(result, (e: unknown) => e instanceof LocalAgentError && e.code === error);
    else assert.match(await result, /^hello\|/);
  }
  assert.deepEqual(f.calls(f.bundled), []);
});

test("独立 CodeBuddy CLI 2.161.0 的无 token 账号可检测与调用，保留本机登录及环境隔离", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const home = path.join(f.dir, "user-home");
  fs.mkdirSync(home);
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", HOME: home, FAKE_BASE_HOME: home,
    FAKE_VERSION: "2.161.0 (CodeBuddy Code)",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }),
    CODEBUDDY_API_KEY: "must-not-forward", CODEBUDDY_AUTH_TOKEN: "must-not-forward", CODEBUDDY_BASE_URL: "https://custom.invalid" };
  for (const type of ["personal", "future-account-kind"]) {
    const accountEnv = { ...env, FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type, userId: "secret-user" }) };
    const status = await probeCodeBuddy(accountEnv);
    assert.equal(status.version, "2.161.0 (CodeBuddy Code)");
    assert.equal(status.status, "ready", "账号种类不是 API / 订阅认证方式，不猜未穷举的类型");
    assert.equal(status.authenticated, true);
    assert.equal(status.available, true);
    assert.doesNotMatch(JSON.stringify(status), /secret-user|must-not-forward/);
    const result = await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: accountEnv });
    assert.match(result, /^hello\|api=false\|token=false\|base=false\|/);
    assert.match(result, /\|ephemeral=false\|.*\|noSession=true\|permission=dontAsk$/);
  }
  assert.deepEqual(fs.readdirSync(home), []);

  const marker = path.join(f.dir, "execution-marker");
  await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello",
    env: { ...env, FAKE_ACCOUNT: "null", FAKE_EXEC_MARKER: marker } }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated");
  assert.equal(fs.existsSync(marker), false, "探针通过后登录失效，下一次调用仍须重新检查");
});

test("WorkBuddy 2.161.0 精简包在检测与调用中固定选择 lite bundle，保持宿主环境隔离", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-workbuddy-lite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const f = fakeCodeBuddy(binDir);
  assert.equal(isWorkBuddyBundledCli(f.bin), true);
  for (const override of [undefined, "0"]) {
    const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_VERSION: "2.161.0 (CodeBuddy Code)",
      FAKE_REQUIRE_LITE_BUNDLE: "1", CODEBUDDY_FORCE_LITE_WB_BUNDLE: override, CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
      FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }),
      WORKBUDDY_AUTH_TOKEN: "must-not-forward", CODEBUDDY_API_KEY: "must-not-forward", CODEBUDDY_AUTH_TOKEN: "must-not-forward",
      CODEBUDDY_BASE_URL: "https://custom.invalid" };
    assert.equal(localSubscriptionEnv(env, "codebuddy").CODEBUDDY_FORCE_LITE_WB_BUNDLE, undefined,
      "bundle 选择由专用环境固定，不把宿主变量加入公共白名单");
    const status = await probeCodeBuddy(env);
    assert.equal(status.status, "ready");
    assert.equal(status.version, "2.161.0 (CodeBuddy Code)");
    assert.doesNotMatch(JSON.stringify(status), /secret-user|secret-token|must-not-forward/);
    const result = await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env });
    assert.match(result, /^hello\|api=false\|token=false\|base=false\|/);
    assert.match(result, /\|noSession=true\|permission=dontAsk\|lite=1\|headless=false\|host=false$/);
  }
});

test("#59 独立安装的 CodeBuddy CLI 检测与调用都不强加 WorkBuddy 精简包", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  assert.equal(isWorkBuddyBundledCli(f.bin), false);
  // 强加了精简包，假 CLI 就报错退出：检测与调用都通过，说明两处都没加。
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_VERSION: "2.179.2 (CodeBuddy Code)", FAKE_REJECT_LITE_BUNDLE: "1",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }) };
  const status = await probeCodeBuddy(env);
  assert.equal(status.status, "ready");
  const result = await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env });
  assert.match(result, /^hello\|api=false\|/);
});

test("#59 CodeBuddy 一次写出超过 64 KB 的结果后立刻 process.exit()，产品仍拿到完整回答", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const size = 300 * 1024;
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_BIG_OUTPUT: String(size), FAKE_EXIT_AFTER_WRITE: "1",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }) };
  const result = await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env });
  assert.ok(result.startsWith("hello|api=false|"));
  assert.ok(result.endsWith("x".repeat(64) + "|end"), "回答末尾要完整");
  assert.ok(result.length > size);
});

test("#59 写文件后输出上限照样生效：超过 4 MB 按输出过大处理", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_BIG_OUTPUT: String(5 * 1024 * 1024), FAKE_EXIT_AFTER_WRITE: "1",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }) };
  await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_output_too_large");
});

test("Claude 一次写出超过 64 KB 的结果后立刻 process.exit()，产品仍拿到完整回答", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-claude-big-"));
  const answer = "y".repeat(300 * 1024) + "|end";
  const bin = fakeNodeExecutable(dir, "claude", `
if(process.argv[2]==='--version'){console.log('2.1.226 (Claude Code)');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({result:${JSON.stringify(answer)}})+'\\n');process.exit(0)});`);
  try {
    assert.equal(await runLocalAgent("claude", { systemPrompt: "规则", userPrompt: "测试",
      env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH } }), answer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("vibe-astock #28 帮助里列出 --port 才传 --port 0，不去抢交互会话占着的固定端口", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const base = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_ECHO_PORT: "1",
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }) };
  assert.match(await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: { ...base, FAKE_HELP_PORT: "1" } }), /\|port=0$/);
  assert.match(await runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env: base }), /\|port=none$/);
});

test("WorkBuddy 旧 CLI 的无 token 账号不能绕过临时 HOME 所需凭据", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const marker = path.join(f.dir, "execution-marker");
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_LEGACY_HELP: "1", FAKE_EXEC_MARKER: marker,
    FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user" }) };
  const status = await probeCodeBuddy(env);
  assert.equal(status.status, "probe_failed");
  assert.equal(status.available, false);
  assert.match(status.detail, /升级/);
  assert.doesNotMatch(JSON.stringify(status), /secret-user/);
  await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_cli_too_old");
  assert.equal(fs.existsSync(marker), false);
});

test("CodeBuddy 登录探针拒绝失效账号、不完整新版响应及失败控制响应", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const invalidAccounts = [null, {}, { userId: "secret-user" }, { token: "secret-token" },
    { userId: "", token: "secret-token" }, { userId: "secret-user", token: "" },
    { userId: " ", token: "secret-token" }, { userId: "secret-user", token: " " },
    { type: "personal", userId: "secret-user" },
    { uid: "", type: "personal", userId: "secret-user" },
    { uid: " ", type: "personal", userId: "secret-user" },
    { uid: 42, type: "personal", userId: "secret-user" },
    { uid: "different-user", type: "personal", userId: "secret-user" },
    { uid: "secret-user", type: null, userId: "secret-user" },
    { uid: "secret-user", type: 42, userId: "secret-user" },
    { uid: "secret-user", type: " ", userId: "secret-user" },
    { uid: "secret-user", type: "personal", userId: 42 },
    { uid: "secret-user", type: "personal", userId: " " },
    { uid: "secret-user", type: "personal", userId: "secret-user", token: "" }];
  const marker = path.join(f.dir, "execution-marker");
  for (const account of invalidAccounts) {
    const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_ACCOUNT: JSON.stringify(account), FAKE_EXEC_MARKER: marker };
    const status = await probeCodeBuddy(env);
    assert.equal(status.status, "not_authenticated", JSON.stringify(account));
    assert.equal(status.available, false);
    assert.doesNotMatch(JSON.stringify(status), /secret-user|secret-token|secret-uid/);
    await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_not_authenticated");
  }
  const rejected = await probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_CONTROL_FAILURE: "1" });
  assert.equal(rejected.status, "not_authenticated");
  assert.equal(fs.existsSync(marker), false, "登录未确认时不得启动回答进程");
});

test("CodeBuddy 登录响应后异常退出仍视为检测失败，不泄露账号或启动回答", async (t) => {
  const f = fakeCodeBuddy();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const marker = path.join(f.dir, "execution-marker");
  const env = { ...PLATFORM_ENV, CODEBUDDY_BIN: f.bin, PATH: "", FAKE_PROBE_EXIT_CODE: "1", FAKE_EXEC_MARKER: marker };
  const status = await probeCodeBuddy(env);
  assert.equal(status.status, "probe_failed");
  assert.equal(status.authenticated, false);
  assert.equal(status.available, false);
  assert.doesNotMatch(JSON.stringify(status), /secret-user|secret-token|hidden@example/);
  await assert.rejects(runLocalAgent("codebuddy", { systemPrompt: "规则", userPrompt: "hello", env }),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_probe_failed");
  assert.equal(fs.existsSync(marker), false);
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

test("CodeBuddy 帮助探针忽略 SIGTERM 时仍须按期限退出", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-probe-hard-timeout-"));
  const pidFile = path.join(dir, "probe.pid");
  const bin = fakeNodeExecutable(dir, "codebuddy", `
const fs=require('node:fs');
if(process.argv[2]==='--version'){console.log('2.143.1');process.exit(0)}
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const status = await Promise.race([
      probeCodeBuddy({ ...PLATFORM_ENV, CODEBUDDY_BIN: bin, PATH: "" }),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("探针未在20秒内收尾")), 20_000); }),
    ]);
    assert.equal(status.status, "probe_failed");
    assert.equal(status.available, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    clearTimeout(watchdog);
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* 已退出 */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CodeBuddy 订阅调用走 stdin，移除 API / token / 自定义端点并关闭自动记忆", async () => {
  const f = fakeCodeBuddy();
  try {
    const out = await runLocalAgent("codebuddy", {
      systemPrompt: "规则", userPrompt: "USER_SECRET_PROMPT",
      env: { ...PLATFORM_ENV,
        CODEBUDDY_BIN: f.bin, PATH: process.env.PATH,
        FAKE_VERSION: "2.137.1 (CodeBuddy Code)",
        FAKE_ACCOUNT: JSON.stringify({ uid: "secret-user", type: "personal", userId: "secret-user", token: "secret-token" }),
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

test("CodeBuddy 回答里的 <think:…> 推理痕迹要清掉,只剩推理痕迹时按没有可见回答处理", () => {
  assert.equal(parseCodeBuddyOutput(JSON.stringify({ result: "<think:opensource>先想一想\n再想</think:opensource>\n结论在这" })), "结论在这");
  assert.equal(parseCodeBuddyOutput(JSON.stringify({ response: "前文<think:x>中间</think:x>后文" })), "前文后文");
  assert.equal(parseCodeBuddyOutput(JSON.stringify({ result: "落单的标签</think:x>也去掉" })), "落单的标签也去掉");
  assert.equal(parseCodeBuddyOutput(JSON.stringify({ result: "普通的 <think> 字样不是推理标签" })), "普通的 <think> 字样不是推理标签");
  assert.equal(parseCodeBuddyOutput(JSON.stringify([{ result: "上一条可见回答" }, { result: "<think:x>只有推理</think:x>" }])), "上一条可见回答");
  assert.throws(() => parseCodeBuddyOutput(JSON.stringify({ result: "<think:x>只有推理</think:x>  " })),
    (e: unknown) => e instanceof LocalAgentError && e.code === "agent_empty_output");
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
  fs.writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));
}else{
  fs.writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));
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
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
setInterval(()=>{},1000);
`);
  const running = runLocalAgent("claude", {
    systemPrompt: "规则", userPrompt: "等待", timeoutMs: 60_000,
    env: { ...PLATFORM_ENV, CLAUDE_BIN: bin, PATH: process.env.PATH },
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

test("父服务被 SIGTERM 停掉时，同步删掉还在跑的 Agent 的临时工作区", { skip: process.platform === "win32" }, async () => {
  // 正常收尾由 finish() 删临时工作区；父服务被信号停掉时来不及走到那一步，里面的回答原文不能留在系统临时目录。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-parent-exit-"));
  const tmpRoot = path.join(dir, "tmp");
  fs.mkdirSync(tmpRoot);
  const infoFile = path.join(dir, "agent.json");
  const bin = fakeNodeExecutable(dir, "claude", `
const fs=require('node:fs');
process.stdout.write('{"partial":');
fs.writeFileSync(${JSON.stringify(infoFile)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));
setInterval(()=>{},1000);
`);
  const parentScript = path.join(dir, "parent.mjs");
  fs.writeFileSync(parentScript, `
import fs from "node:fs";
import { runLocalAgent } from ${JSON.stringify(new URL("../src/local_agent_runtime.ts", import.meta.url).href)};
const [bin, infoFile] = process.argv.slice(2);
runLocalAgent("claude", { systemPrompt: "规则", userPrompt: "等待", timeoutMs: 60_000, env: { CLAUDE_BIN: bin, PATH: process.env.PATH } }).catch(() => {});
const poll = setInterval(() => { if (fs.existsSync(infoFile)) { clearInterval(poll); process.kill(process.pid, "SIGTERM"); } }, 20);
setTimeout(() => process.exit(3), 30_000);
`);
  try {
    const child = spawn(process.execPath, [parentScript, bin, infoFile], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpRoot }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (d) => { stderr += String(d); });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("exit", (c, s) => resolve([c, s])));
    assert.equal(signal, "SIGTERM", `父服务应按 SIGTERM 退出（code=${code}）：${stderr}`);
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8")) as { pid: number; cwd: string };
    assert.ok(info.cwd.startsWith(fs.realpathSync(tmpRoot) + path.sep), "假 CLI 应在父服务的临时目录里运行");
    assert.equal(fs.existsSync(info.cwd), false, "临时工作区应在父服务退出前删掉");
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((name) => name.startsWith("vra-")), []);
    for (let i = 0; i < 100; i += 1) {
      try { process.kill(info.pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(info.pid, 0), /ESRCH/);
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

test("Windows 系统登记里的 WorkBuddy 线索 → 安装文件夹:去引号、去图标序号、取 exe 所在文件夹、不收网络路径、去重", () => {
  const lines = [
    "InstallLocation\t\"D:\\软件\\WorkBuddy\\\"",
    "DisplayIcon\tD:\\软件\\WorkBuddy\\WorkBuddy.exe,0",
    "UninstallString\t\"D:\\软件\\WorkBuddy\\Uninstall WorkBuddy.exe\" /currentuser",
    "UninstallString\tC:\\Users\\张三\\AppData\\Local\\WorkBuddy\\Update.exe --uninstall",
    "Process\tE:\\Apps\\WB\\WorkBuddy.exe",
    "DisplayIcon\tD:\\软件\\WorkBuddy\\resources\\icon.ico",
    "InstallLocation\t\\\\server\\share\\WorkBuddy",
    "InstallLocation\tWorkBuddy",
    "Process\tD:\\a\u0007b\\WorkBuddy.exe",
    `InstallLocation\tD:\\${"x".repeat(1100)}`,
    "Unknown\tF:\\WorkBuddy",
    "no tab here",
    "",
  ].join("\r\n");
  assert.deepEqual(workBuddyRootsFromDiscovery(lines), [
    "D:\\软件\\WorkBuddy", "C:\\Users\\张三\\AppData\\Local\\WorkBuddy", "E:\\Apps\\WB",
  ]);
  assert.deepEqual(workBuddyRootsFromDiscovery("InstallLocation\td:\\软件\\workbuddy"), ["d:\\软件\\workbuddy"]);
  assert.deepEqual(workBuddyRootsFromDiscovery("InstallLocation\tD:\\软件\\WorkBuddy\nInstallLocation\td:\\软件\\workbuddy\\"), ["D:\\软件\\WorkBuddy"],
    "Windows 路径不分大小写,同一个只查一次");
  assert.deepEqual(workBuddyRootsFromDiscovery(""), []);
});

test("Windows 查找 WorkBuddy 的系统查询:只读、明文 -Command、去掉 PowerShell 7 的模块路径、只看当前会话的进程、名字不含 WorkBuddy 也认安装目录", () => {
  const source = fs.readFileSync(new URL("../src/local_agent_runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf("const WORKBUDDY_DISCOVERY_SCRIPT = [");
  const script = source.slice(start, source.indexOf('].join("\\n");', start));
  const run = source.slice(source.indexOf("async function discoverWorkBuddyWindows"), source.indexOf("export function workBuddyRootsFromDiscovery"));
  assert.ok(start > 0 && run.length > 0);
  // 杀毒软件常拦 -EncodedCommand;脚本里只有单引号,明文传不会被命令行引号拆坏
  assert.doesNotMatch(run, /EncodedCommand/);
  assert.match(run, /\["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WORKBUDDY_DISCOVERY_SCRIPT\]/);
  assert.doesNotMatch(script.replace(/^\s*\/\/.*$/gm, ""), /\\"/, "脚本里不能有双引号");
  assert.match(run, /if \(key\.toLowerCase\(\) === "psmodulepath"\) delete childEnv\[key\]/);
  assert.match(run, /env: childEnv,/);
  assert.match(run, /timeout: WORKBUDDY_DISCOVERY_TIMEOUT_MS/);
  assert.match(source, /const WORKBUDDY_DISCOVERY_TIMEOUT_MS = 30_000;/);
  assert.match(script, /Get-Process -Name 'WorkBuddy' \| Where-Object \{ \$_\.SessionId -eq \$session \}/);
  assert.match(script, /\$session = \(Get-Process -Id \$PID\)\.SessionId/);
  assert.match(script, /\(\[string\]\$e\.DisplayName \+ '\|' \+ \[string\]\$e\.InstallLocation \+ '\|' \+ \[string\]\$e\.DisplayIcon\) -match 'WorkBuddy'/);
  // 只读:不写注册表、不起别的程序、不改文件
  assert.doesNotMatch(script, /Set-Item|New-Item|Remove-Item|Start-Process|Invoke-|Set-Content|Out-File/);
});

test("安装文件夹 → 内置 CLI 候选:根目录先查,Squirrel 式 app-<版本> 子文件夹按版本从新到旧", () => {
  const list = (dir: string) => dir === "C:\\Users\\张三\\AppData\\Local\\WorkBuddy" ? ["app-1.9.0", "packages", "app-1.10.2", "app-x", "Update.exe"] : [];
  const c = workBuddyBundledCandidates(["D:\\软件\\WorkBuddy", "C:\\Users\\张三\\AppData\\Local\\WorkBuddy"], list);
  const bin = (root: string, name = "codebuddy") => `${root}\\resources\\app.asar.unpacked\\cli\\bin\\${name}`;
  assert.deepEqual(c.slice(0, 3), [bin("D:\\软件\\WorkBuddy", "codebuddy.exe"), bin("D:\\软件\\WorkBuddy", "codebuddy.cmd"), bin("D:\\软件\\WorkBuddy")]);
  const appOrder = c.filter((x) => x.includes("\\app-") && x.endsWith("\\codebuddy")).map((x) => x.split("\\")[6]);
  assert.deepEqual(appOrder, ["app-1.10.2", "app-1.9.0"], "1.10 比 1.9 新;不是版本号的 app-x 不算");
  assert.ok(c.every((x) => x.includes("\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy")), "只找 WorkBuddy 内置 CLI 这一个固定位置");
});

test("找 CodeBuddy:只在 Windows、没用环境变量锁定、固定位置都没有时才问系统;没找到时发起对话 30 秒内不重复问(检测页每次重问),同时多次查找只问一次", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vra-locate-"));
  loadSavedAgentPaths(empty);
  const env = { PATH: empty, LOCALAPPDATA: empty };
  let asked = 0;
  const discover = async () => { asked += 1; await new Promise((r) => setTimeout(r, 20)); return "InstallLocation\tZ:\\不存在\\WorkBuddy"; };
  try {
    resetWorkBuddyDiscoveryForTest();
    await locateCodeBuddy(env, "darwin", discover); // 这台机器上可能真装了 WorkBuddy,结果不论,只看问没问系统
    assert.equal(await locateCodeBuddy({ ...env, CODEBUDDY_BIN: "Z:\\x\\codebuddy.exe" }, "win32", discover), null);
    assert.equal(asked, 0, "非 Windows、环境变量锁定时不问系统");
    const both = await Promise.all([locateCodeBuddy(env, "win32", discover), locateCodeBuddy(env, "win32", discover)]);
    assert.deepEqual(both, [null, null]);
    assert.equal(asked, 1, "同时两次查找只问一次");
    assert.equal(await locateCodeBuddy(env, "win32", discover), null);
    assert.equal(asked, 1, "没找到的结论记 30 秒");
    assert.equal(await locateCodeBuddy(env, "win32", discover, { retryMiss: true }), null);
    assert.equal(asked, 2, "设置页检测 / 重新检测不认「刚才没找到」,重新问系统");
    resetWorkBuddyDiscoveryForTest();
    assert.equal(await locateCodeBuddy(env, "win32", async () => { asked += 1; throw new Error("powershell blocked"); }), null,
      "PowerShell 不可用当没找到,不报错");
    assert.equal(asked, 3);
  } finally {
    resetWorkBuddyDiscoveryForTest();
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("检测失败时说清楚卡在哪(超时 / 起不来 / 退出码),不带 CLI 自己的输出", () => {
  assert.match(codeBuddyProbeFailure(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" })), /检测超时.*重新检测/);
  assert.match(codeBuddyProbeFailure(new Error("CodeBuddy auth probe timed out")), /检测超时/);
  assert.equal(codeBuddyProbeFailure(Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" })), "CodeBuddy 程序启动不了（ENOENT）");
  assert.equal(codeBuddyProbeFailure(Object.assign(new Error("Command failed: secret-token"), { code: 3 })), "CodeBuddy 登录状态检测失败（程序退出码 3）");
  const leaked = codeBuddyProbeFailure(new Error("CodeBuddy auth probe failed (1):token=secret-token user=hidden@example.com"));
  assert.equal(leaked, "CodeBuddy 登录状态检测失败（程序退出码 1）");
  assert.equal(codeBuddyProbeFailure(new LocalAgentError("agent_cli_too_old", "CodeBuddy 版本过旧")), "CodeBuddy 版本过旧");
  assert.equal(codeBuddyProbeFailure("weird"), "CodeBuddy 登录状态检测失败");
});

/** 在临时目录里摆一个 WorkBuddy 安装布局,内置 CLI 是能回答版本 / 帮助 / 登录探针的假程序 */
function fakeWorkBuddyInstall(root: string): string {
  const binDir = path.join(root, "resources", "app.asar.unpacked", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "codebuddy");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.143.1 (CodeBuddy Code)');process.exit(0)}
if(a[0]==='--help'){console.log('--tools --strict-mcp-config --mcp-config --setting-sources --input-format --output-format --system-prompt --json-schema --max-turns --agent --permission-mode --subagent-permission-mode --no-session-persistence');process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
  const req=JSON.parse(input.trim());
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{account:{userId:'u',token:'t'}}}}));
});
`);
  return bin;
}

/** GitHub 的 Windows 机器上临时目录是 8.3 短名(RUNNER~1),系统登记 / 进程给的可能是长名;统一成真实长路径再比 */
const realTmp = () => fs.realpathSync.native(os.tmpdir());
const samePath = (p: string | null) => p === null ? null : fs.realpathSync.native(p).toLowerCase();

const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VibeResearchTest-WorkBuddy";
function reg(args: string[]): void {
  const r = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 && args[0] !== "delete") throw new Error(`reg ${args.join(" ")} 失败:${r.stderr}`);
}

test("Windows 实机:WorkBuddy 装在自定义的中文文件夹,从「已安装的程序」登记里找到,订阅卡片显示可用(#50)", { skip: process.platform !== "win32" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(realTmp(), "vra-wb-registry-"));
  const root = path.join(tmp, "软件", "WorkBuddy");
  const bin = fakeWorkBuddyInstall(root);
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty);
  t.after(() => { reg(["delete", UNINSTALL_KEY, "/f"]); resetWorkBuddyDiscoveryForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 登记的名字不含 WorkBuddy(如只有中文名),靠安装目录认出来
  reg(["add", UNINSTALL_KEY, "/v", "DisplayName", "/d", "工作助手 (test)", "/f"]);
  reg(["add", UNINSTALL_KEY, "/v", "InstallLocation", "/d", root, "/f"]);
  // 从 PowerShell 7 里启动本产品时会继承它的模块路径;查询要去掉它,否则 Windows PowerShell 5.1 加载不了自带命令
  const prevModulePath = process.env.PSModulePath;
  process.env.PSModulePath = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "Modules");
  t.after(() => { if (prevModulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = prevModulePath; });
  loadSavedAgentPaths(empty);
  resetWorkBuddyDiscoveryForTest();
  const env = { ...PLATFORM_ENV, PATH: empty, LOCALAPPDATA: empty, ProgramFiles: empty, "ProgramFiles(x86)": empty };
  assert.equal(findExecutable("codebuddy", env), null, "前提:固定位置里找不到");
  assert.equal(samePath(await locateCodeBuddy(env)), samePath(bin));
  resetWorkBuddyDiscoveryForTest();
  const status = await realProbeCodeBuddy(env);
  assert.equal(status.status, "ready", status.detail);
  assert.equal(status.installed, true);
});

test("Windows 实机:没有登记、但 WorkBuddy 正开着,从正在运行的 WorkBuddy.exe 找到安装文件夹", { skip: process.platform !== "win32" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(realTmp(), "vra-wb-process-"));
  const root = path.join(tmp, "工具", "WB");
  const bin = fakeWorkBuddyInstall(root);
  const exe = path.join(root, "WorkBuddy.exe");
  fs.copyFileSync(process.execPath, exe);
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty);
  reg(["delete", UNINSTALL_KEY, "/f"]);
  const child = spawn(exe, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    resetWorkBuddyDiscoveryForTest();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await new Promise((r) => setTimeout(r, 500));
  loadSavedAgentPaths(empty);
  resetWorkBuddyDiscoveryForTest();
  const env = { ...PLATFORM_ENV, PATH: empty, LOCALAPPDATA: empty, ProgramFiles: empty, "ProgramFiles(x86)": empty };
  assert.equal(samePath(await locateCodeBuddy(env)), samePath(bin));
});

test("Windows 实机:Squirrel 式安装(程序在 app-<版本> 子文件夹),登记里只有 Update.exe 卸载命令也能找到最新版本;手动填安装文件夹同样能找到", { skip: process.platform !== "win32" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(realTmp(), "vra-wb-squirrel-"));
  const root = path.join(tmp, "WorkBuddy");
  fakeWorkBuddyInstall(path.join(root, "app-1.9.0"));
  const newest = fakeWorkBuddyInstall(path.join(root, "app-1.10.2"));
  fs.writeFileSync(path.join(root, "Update.exe"), "");
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty);
  t.after(() => { reg(["delete", UNINSTALL_KEY, "/f"]); resetWorkBuddyDiscoveryForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });
  reg(["add", UNINSTALL_KEY, "/v", "DisplayName", "/d", "WorkBuddy", "/f"]);
  reg(["add", UNINSTALL_KEY, "/v", "UninstallString", "/d", `"${path.join(root, "Update.exe")}" --uninstall`, "/f"]);
  loadSavedAgentPaths(empty);
  resetWorkBuddyDiscoveryForTest();
  const env = { ...PLATFORM_ENV, PATH: empty, LOCALAPPDATA: empty, ProgramFiles: empty, "ProgramFiles(x86)": empty };
  assert.equal(samePath(await locateCodeBuddy(env)), samePath(newest));
  assert.equal(samePath(resolveCodeBuddyLocation(root, env)), samePath(newest));
});
