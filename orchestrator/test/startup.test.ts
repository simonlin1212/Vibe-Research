import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertPortAvailable, createShutdownMonitor, parseStartupArgs, startupMissingFiles, waitUntilReady } from "../src/startup.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("#34 两种启动器不覆盖 Vite 的 LAN 开关，API 继续只绑定回环", () => {
  const posix = fs.readFileSync(path.join(REPO, "orchestrator/src/startup.ts"), "utf8");
  const windows = fs.readFileSync(path.join(REPO, "scripts/start.ps1"), "utf8");
  for (const source of [posix, windows]) {
    const ui = source.split("\n").find((line) => /(?:const ui =|\$ui = Start-Process)/.test(line));
    assert.ok(ui);
    assert.doesNotMatch(ui, /--host/);
    const api = source.split("\n").find((line) => /(?:const api =|\$api = Start-Process)/.test(line));
    assert.ok(api);
    assert.match(api, /"--host", "127\.0\.0\.1"/);
  }
});

test("POSIX 安装入口在包目录内执行 npm ci，避免首次安装的绝对 prefix 兼容问题", () => {
  const source = fs.readFileSync(path.join(REPO, "scripts", "setup"), "utf8");
  assert.match(source, /cd "\$ROOT\/orchestrator" && npm ci --no-audit --no-fund/);
  assert.match(source, /cd "\$ROOT\/desktop" && npm ci --no-audit --no-fund/);
  assert.doesNotMatch(source, /npm ci --prefix/);
});

test("各平台安装入口不把 npm 审计网络当成首次启动阻塞", () => {
  const posix = fs.readFileSync(path.join(REPO, "scripts", "setup"), "utf8");
  const windows = fs.readFileSync(path.join(REPO, "scripts", "setup-windows.ps1"), "utf8");
  for (const source of [posix, windows]) {
    assert.equal((source.match(/npm ci/g) ?? []).length, 2);
    assert.equal((source.match(/--no-audit --no-fund/g) ?? []).length, 2);
  }
});

test("启动参数只接受帮助与禁止自动打开浏览器", () => {
  assert.deepEqual(parseStartupArgs([]), { openBrowser: true, help: false });
  assert.deepEqual(parseStartupArgs(["--no-open"]), { openBrowser: false, help: false });
  assert.deepEqual(parseStartupArgs(["-h"]), { openBrowser: true, help: true });
  assert.throws(() => parseStartupArgs(["--port", "9000"]), /未知参数/);
});

test("启动预检同时覆盖两端依赖与实际数据根", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-startup-"));
  const dataRoot = path.join(root, "private-data");
  fs.writeFileSync(path.join(root, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: ".local" } }));
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }), [
    "orchestrator 依赖", "界面依赖", "产品初始化配置",
  ]);

  for (const file of [
    path.join(root, "orchestrator/node_modules/@openai/codex-sdk/package.json"),
    path.join(root, "desktop/node_modules/vite/package.json"),
    path.join(dataRoot, "config.json"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
  }
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }), []);
});

test("端口预检会拒绝已经被占用的固定端口", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(assertPortAvailable(address.port), /已被占用/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("就绪检查会重试暂时失败的探针", async () => {
  let attempts = 0;
  let clock = 0;
  await waitUntilReady({
    probe: async () => ++attempts === 3,
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(attempts, 3);
});

test("就绪检查会在子进程提前失败或超时时停止", async () => {
  await assert.rejects(waitUntilReady({ probe: async () => false, failure: () => "界面已退出" }), /界面已退出/);

  let clock = 0;
  await assert.rejects(waitUntilReady({
    probe: async () => false,
    timeoutMs: 20,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }), /超过 1 秒/);
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 12345,
  }) as unknown as ChildProcess;
}

test("启动健康检查前即可响应 Ctrl+C、终止与关闭终端信号", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const api = fakeChild();
    const ui = fakeChild();
    const signals = new EventEmitter();
    const monitor = createShutdownMonitor(api, ui, signals as unknown as NodeJS.Process);

    assert.equal(signals.listenerCount(signal), 1);
    signals.emit(signal);
    assert.deepEqual(await monitor.wait, { kind: "signal", signal });
    monitor.dispose();
    assert.equal(signals.listenerCount(signal), 0);
    assert.equal(api.listenerCount("exit"), 0);
    assert.equal(ui.listenerCount("exit"), 0);
  }
});

test("任一子进程退出会要求同步关闭另一进程", async () => {
  const api = fakeChild();
  const ui = fakeChild();
  const signals = new EventEmitter();
  const monitor = createShutdownMonitor(api, ui, signals as unknown as NodeJS.Process);

  api.emit("exit", 7, null);
  assert.deepEqual(await monitor.wait, {
    kind: "child_exit",
    message: "本机 API已停止（退出码 7），另一进程将同步关闭。",
  });
  monitor.dispose();
});
