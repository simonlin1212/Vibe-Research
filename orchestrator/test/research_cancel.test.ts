import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { reserveResearch, requestResearchCancellation, researchCancellationRequested, readResearchControl, updateResearchControl, watchResearchCancellation } from "../src/research_control.ts";
import { runResearchProcess } from "../src/research_process.ts";
import { runCodexSdkTurn } from "../src/codex_sdk_process.ts";
import { researchStatus, cancelResearch, startResearch, type ServiceContext } from "../src/service.ts";
import { runFetchScripts, type Ledger } from "../src/fetchrun.ts";
import { makeConfig } from "../src/config.ts";
import "../src/finance/register.ts";

const waitUntil = async (predicate: () => boolean, ms = 8000) => {
  const until = Date.now() + ms;
  while (!predicate()) { if (Date.now() > until) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 20)); }
};
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-cancel-"));

test("逐个取数在取消后不启动下一脚本，保留前一个真实账本", { skip: process.platform === "win32" }, async () => {
  const root = fresh();
  try {
    const bin = path.join(root, "fetcher");
    fs.writeFileSync(bin, `#!${process.execPath}\nprocess.exit(0);`, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "test");
    const cfg = makeConfig({ symbol: "300308", runId: "sequence", repoRoot: root, python: bin, endpointScope: "core" });
    for (const dir of ["raw", "fetch"]) fs.mkdirSync(path.join(cfg.runDir, dir), { recursive: true });
    const ledger: Ledger = {};
    const ac = new AbortController();
    await assert.rejects(async () => runFetchScripts(cfg, "profile", ["fetch_profile", "fetch_quote"], (type) => {
      if (type === "fetch.executed") ac.abort(new Error("stop sequence"));
    }, ledger, ac.signal), /stop sequence/);
    assert.deepEqual(Object.keys(ledger), ["fetch_profile"]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(cfg.runDir, "fetch/_ledger.json"), "utf8"))), ["fetch_profile"]);
    assert.equal(fs.existsSync(path.join(cfg.runDir, "fetch/fetch_quote.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("真实启动失败会收口状态；重用编号不启动第二个 worker", async () => {
  const root = fresh();
  try {
    const ctx: ServiceContext = { repoRoot: root, dataRoot: path.join(root, "data"), node: path.join(root, "missing-node"), python: "python3", providerEnvKey: null };
    const result = startResearch(ctx, { symbol: "300308", run_id: "spawn-failed", endpoints: "core" });
    assert.equal(result.pid, undefined);
    await waitUntil(() => !!readResearchControl(ctx.dataRoot, result.run_id)?.finished_at);
    assert.equal(researchStatus(ctx, result.run_id).status, "failed");
    assert.throws(() => startResearch(ctx, { symbol: "300308", run_id: result.run_id, endpoints: "core", overwrite: true }), /编号已使用/);
    const oldRun = path.join(ctx.dataRoot, "runs/legacy");
    fs.mkdirSync(oldRun);
    fs.writeFileSync(path.join(oldRun, "manifest.json"), JSON.stringify({ finished_at: "yesterday", status: "complete" }));
    assert.throws(() => startResearch(ctx, { symbol: "300308", run_id: "legacy", overwrite: true }), /编号已使用/);
    assert.equal(readResearchControl(ctx.dataRoot, "legacy"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("取消与最终归档有原子先后边界，不依赖轮询计时器", () => {
  const root = fresh();
  try {
    const first = reserveResearch(root, "cancel-first");
    const watch = watchResearchCancellation(root, "cancel-first", first.token);
    try {
      requestResearchCancellation(root, "cancel-first");
      assert.equal(watch.signal.aborted, false, "同步期间计时器尚未执行");
      assert.throws(watch.finalize, /用户取消/);
    } finally { watch.close(); }
    const second = reserveResearch(root, "finalize-first");
    const finishing = watchResearchCancellation(root, "finalize-first", second.token);
    try {
      finishing.finalize();
      assert.equal(cancelResearch({ dataRoot: root } as ServiceContext, "finalize-first").status, "finalizing");
      finishing.checkpoint();
      assert.equal(finishing.signal.aborted, false);
      assert.equal(researchCancellationRequested(root, "finalize-first"), false);
    } finally { finishing.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("官方 SDK 独立进程传输保留事件与续聊，并强制停止忽略 SIGTERM 的引擎及子进程", { skip: process.platform === "win32" }, async () => {
  const root = fresh();
  const binary = path.join(root, "codex-fixture");
  const pidFile = path.join(root, "descendant.pid");
  const opts = { options: { codexPathOverride: binary, env: {} }, threadOptions: { workingDirectory: root, skipGitRepoCheck: true }, threadId: null, prompt: "test" };
  try {
    fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'中文完整回复'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));});require('fs').writeFileSync(${JSON.stringify(path.join(root, "args.json"))},JSON.stringify(process.argv));`, { mode: 0o700 });
    const events: unknown[] = [];
    await runCodexSdkTurn(opts, new AbortController().signal, 5000, (e) => events.push(e));
    assert.equal((events[1] as { item: { text: string } }).item.text, "中文完整回复");
    await runCodexSdkTurn({ ...opts, threadId: "thread-1" }, new AbortController().signal, 5000, () => {});
    assert.match(fs.readFileSync(path.join(root, "args.json"), "utf8"), /resume.*thread-1/);
    fs.writeFileSync(binary, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});const p=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},100);`, { mode: 0o700 });
    const ac = new AbortController();
    const turn = runCodexSdkTurn(opts, ac.signal, 40000, () => {});
    const rejected = assert.rejects(turn, /stop-sdk-tree/);
    await waitUntil(() => fs.existsSync(pidFile), 30000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    ac.abort(new Error("stop-sdk-tree"));
    await rejected;
    await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("取消请求可跨服务上下文恢复，只有 worker 确认后才显示已取消", async () => {
  const root = fresh();
  try {
    const ctx = { dataRoot: root } as ServiceContext;
    const control = reserveResearch(root, "r1");
    assert.equal(researchStatus(ctx, "r1").status, "running");
    assert.equal(researchStatus(ctx, "r1").exists, true);
    const requested = cancelResearch({ ...ctx }, "r1");
    assert.equal(requested.status, "cancelling");
    assert.equal(requested.finished_at, null);
    const watch = watchResearchCancellation(root, "r1", control.token);
    assert.equal(watch.signal.aborted, true);
    watch.close();
    updateResearchControl(root, "r1", control.token, "cancelled");
    assert.equal(cancelResearch({ ...ctx }, "r1").status, "cancelled");
    assert.ok(researchStatus(ctx, "r1").finished_at);
    assert.throws(() => reserveResearch(root, "r1"), /编号已使用/);
    assert.throws(() => watchResearchCancellation(root, "r1", control.token), /身份不匹配/);
    assert.throws(() => cancelResearch(ctx, "../r1"), /run-id/);
    assert.throws(() => cancelResearch(ctx, "unmanaged"), /无法安全取消/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("控制链接、损坏记录与旧身份拒绝；取消不会覆盖已完成状态", () => {
  const root = fresh();
  try {
    const control = reserveResearch(root, "done");
    assert.throws(() => watchResearchCancellation(root, "done", "wrong"), /身份不匹配/);
    updateResearchControl(root, "done", control.token, "complete");
    requestResearchCancellation(root, "done");
    assert.equal(researchCancellationRequested(root, "done"), false);
    assert.equal(readResearchControl(root, "done")?.state, "complete");
    reserveResearch(root, "broken");
    fs.writeFileSync(path.join(root, "research-control/broken/owner.json"), "{}");
    assert.throws(() => readResearchControl(root, "broken"), /损坏/);
    if (process.platform !== "win32") {
      fs.symlinkSync(root, path.join(root, "research-control/link"));
      assert.throws(() => readResearchControl(root, "link"), /链接/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("真实取数进程传输：成功、启动失败、超时、输出超限与预取消", async () => {
  const root = fresh();
  const opts = { cwd: root, env: {}, timeout: 2000 };
  try {
    assert.equal((await runResearchProcess(process.execPath, ["-e", "console.error('ok')"], opts)).stderr.trim(), "ok");
    assert.equal((await runResearchProcess(path.join(root, "absent"), [], opts)).error?.code, "ENOENT");
    assert.equal((await runResearchProcess(process.execPath, ["-e", "setInterval(()=>{},100)"], { ...opts, timeout: 100 })).error?.code, "ETIMEDOUT");
    assert.equal((await runResearchProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { ...opts, maxBuffer: 100 })).error?.code, "ENOBUFS");
    await assert.rejects(runResearchProcess(process.execPath, ["-e", "require('fs').writeFileSync('spawned','x')"], { ...opts, signal: AbortSignal.abort(new Error("pre-cancel")) }), /pre-cancel/);
    assert.equal(fs.existsSync(path.join(root, "spawned")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("真实跨进程请求停止取数进程树，并在停止后回写确认", { skip: process.platform === "win32" }, async () => {
  const root = fresh();
  const control = reserveResearch(root, "tree");
  const src = (name: string) => pathToFileURL(fileURLToPath(new URL(`../src/${name}`, import.meta.url))).href;
  const worker = path.join(root, "worker.mjs");
  const pidFile = path.join(root, "descendant.pid");
  const childCode = `const{spawn}=require('child_process');const f=require('fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});f.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},100);`;
  fs.writeFileSync(worker, `import {watchResearchCancellation,updateResearchControl} from ${JSON.stringify(src("research_control.ts"))};
import {runResearchProcess} from ${JSON.stringify(src("research_process.ts"))};
const root=${JSON.stringify(root)}, token=${JSON.stringify(control.token)};
const watch=watchResearchCancellation(root,'tree',token);
try { await runResearchProcess(process.execPath,['-e',${JSON.stringify(childCode)}],{cwd:root,env:{},timeout:20000,signal:watch.signal}); }
catch(e) { if(e!==watch.signal.reason) throw e; updateResearchControl(root,'tree',token,'cancelled'); }
finally{watch.close();}`);
  const child = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr += b; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    await waitUntil(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    requestResearchCancellation(root, "tree");
    await waitUntil(() => readResearchControl(root, "tree")?.state === "cancelled");
    assert.equal(await closed, 0, stderr);
    await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); }
});
