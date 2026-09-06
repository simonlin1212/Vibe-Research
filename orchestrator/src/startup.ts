#!/usr/bin/env node
/**
 * macOS / Linux 产品启动器：预检 → 同时启动本机 API 与浏览器界面 → 等待两端真实可用 → 打开浏览器。
 *
 * 这里属于分发 Core，只负责进程、端口与健康检查，不知道任何垂类业务。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readConfiguredDataRoot, resolveDataRoot } from "./data_root.ts";

export interface StartupArgs {
  openBrowser: boolean;
  help: boolean;
}

export function parseStartupArgs(args: readonly string[]): StartupArgs {
  const allowed = new Set(["--no-open", "--help", "-h"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`未知参数:${unknown.join(", ")}（可用:--no-open、--help）`);
  return { openBrowser: !args.includes("--no-open"), help: args.includes("--help") || args.includes("-h") };
}

export function repoRootFromStartup(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 启动前只查会让两棵进程必然失败的条件；业务配置完整性由 doctor 负责。 */
export function startupMissingFiles(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = readConfiguredDataRoot(repoRoot);
  const dataRoot = resolveDataRoot(repoRoot, configured, env);
  const required = [
    [path.join(repoRoot, "orchestrator", "node_modules", "@openai", "codex-sdk", "package.json"), "orchestrator 依赖"],
    [path.join(repoRoot, "desktop", "node_modules", "vite", "package.json"), "界面依赖"],
    [path.join(dataRoot, "config.json"), "产品初始化配置"],
  ] as const;
  return required.filter(([file]) => !fs.existsSync(file)).map(([, label]) => label);
}

export async function assertPortAvailable(port: number, host = "127.0.0.1"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new Error(`端口 ${port} 已被占用，请先关闭旧的 Vibe Research 窗口或进程。`));
      else reject(error);
    });
    server.listen(port, host, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

export interface WaitReadyOptions {
  probe: () => Promise<boolean>;
  failure?: () => string | null;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 可测试的就绪循环：重试网络瞬断，同时在子进程提前退出时立即停止等待。 */
export async function waitUntilReady(options: WaitReadyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  while (now() - started < timeoutMs) {
    const failed = options.failure?.();
    if (failed) throw new Error(failed);
    if (await options.probe()) return;
    await sleep(intervalMs);
  }
  throw new Error(`启动等待超过 ${Math.ceil(timeoutMs / 1000)} 秒，请查看上方日志。`);
}

function tokenFile(repoRoot: string, env: NodeJS.ProcessEnv): string {
  const configured = readConfiguredDataRoot(repoRoot);
  return path.join(resolveDataRoot(repoRoot, configured, env), "api.token");
}

function apiToken(repoRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.VRA_API_TOKEN && env.VRA_API_TOKEN.length >= 16) return env.VRA_API_TOKEN;
  try {
    const token = fs.readFileSync(tokenFile(repoRoot, env), "utf8").trim();
    return token.length >= 16 ? token : "";
  } catch {
    return "";
  }
}

async function reachable(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function childFailure(label: string, child: ChildProcess, launchError: Error | null): string | null {
  if (launchError) return `${label}无法启动:${launchError.message}`;
  if (child.exitCode !== null) return `${label}启动失败（退出码 ${child.exitCode}）。`;
  if (child.signalCode !== null) return `${label}启动失败（信号 ${child.signalCode}）。`;
  return null;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return;
  const opener = spawn(command, [url], { detached: true, stdio: "ignore" });
  opener.once("error", () => { /* 没有 opener 时终端里仍有可点击地址 */ });
  opener.unref();
}

type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ShutdownOutcome {
  kind: "signal" | "child_exit";
  message?: string;
  signal?: StopSignal;
}

export interface ShutdownMonitor {
  wait: Promise<ShutdownOutcome>;
  dispose: () => void;
}

/**
 * 信号监听必须在首个异步健康检查前装好；否则启动窗口内 Ctrl+C/关闭终端会绕过 finally，
 * 留下 detached 的 API 与界面进程组。
 */
export function createShutdownMonitor(
  api: ChildProcess,
  ui: ChildProcess,
  signalSource: NodeJS.Process = process,
): ShutdownMonitor {
  let settled = false;
  let resolveOutcome: (outcome: ShutdownOutcome) => void = () => {};
  const wait = new Promise<ShutdownOutcome>((resolve) => { resolveOutcome = resolve; });
  const finish = (outcome: ShutdownOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(outcome);
  };
  const signalHandlers = new Map<StopSignal, () => void>([
    ["SIGINT", () => finish({ kind: "signal", signal: "SIGINT" })],
    ["SIGTERM", () => finish({ kind: "signal", signal: "SIGTERM" })],
    ["SIGHUP", () => finish({ kind: "signal", signal: "SIGHUP" })],
  ]);
  const exited = (label: string, code: number | null, signal: NodeJS.Signals | null) => {
    finish({
      kind: "child_exit",
      message: `${label}已停止（${code === null ? `信号 ${signal ?? "未知"}` : `退出码 ${code}`}），另一进程将同步关闭。`,
    });
  };
  const apiExit = (code: number | null, signal: NodeJS.Signals | null) => exited("本机 API", code, signal);
  const uiExit = (code: number | null, signal: NodeJS.Signals | null) => exited("浏览器界面", code, signal);
  for (const [signal, handler] of signalHandlers) signalSource.once(signal, handler);
  api.once("exit", apiExit);
  ui.once("exit", uiExit);

  return {
    wait,
    dispose: () => {
      for (const [signal, handler] of signalHandlers) signalSource.removeListener(signal, handler);
      api.removeListener("exit", apiExit);
      ui.removeListener("exit", uiExit);
    },
  };
}

export async function runStartup(
  args: StartupArgs,
  repoRoot = repoRootFromStartup(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (args.help) {
    console.log("用法: scripts/start [--no-open]\n  --no-open  启动后不自动打开浏览器");
    return;
  }
  if (process.platform === "win32") throw new Error("Windows 请运行 scripts\\start.cmd。");

  const missing = startupMissingFiles(repoRoot, env);
  if (missing.length > 0) throw new Error(`还没有完成安装（缺少:${missing.join("、")}）。请先运行 scripts/setup。`);
  await assertPortAvailable(8765);
  await assertPortAvailable(5930);

  const detached = true;
  const api = spawn(process.execPath, ["orchestrator/src/api.ts", "--port", "8765", "--host", "127.0.0.1"], {
    cwd: repoRoot, env, detached, stdio: "inherit",
  });
  // 绑定策略交给 Vite：默认回环；用户显式 VRA_LAN=1 时才开放 UI，API 仍绑回环。
  const ui = spawn("npm", ["run", "dev", "--prefix", "desktop"], {
    cwd: repoRoot, env, detached, stdio: "inherit",
  });
  let apiLaunchError: Error | null = null;
  let uiLaunchError: Error | null = null;
  api.once("error", (error) => { apiLaunchError = error; });
  ui.once("error", (error) => { uiLaunchError = error; });
  const shutdown = createShutdownMonitor(api, ui);

  try {
    const startupOutcome = await Promise.race([
      waitUntilReady({
        failure: () => childFailure("本机 API", api, apiLaunchError) ?? childFailure("浏览器界面", ui, uiLaunchError),
        probe: async () => {
          const token = apiToken(repoRoot, env);
          if (!token) return false;
          const [apiOk, uiOk] = await Promise.all([
            reachable("http://127.0.0.1:8765/health", { Authorization: `Bearer ${token}` }),
            reachable("http://127.0.0.1:5930"),
          ]);
          return apiOk && uiOk;
        },
      }).then(() => ({ kind: "ready" as const })),
      shutdown.wait,
    ]);
    if (startupOutcome.kind === "signal") return;
    if (startupOutcome.kind === "child_exit") throw new Error(startupOutcome.message);

    const url = "http://127.0.0.1:5930";
    console.log(`\nVibe Research 已启动:${url}\n按 Ctrl+C 关闭。`);
    if (args.openBrowser) openBrowser(url);
    const stopOutcome = await shutdown.wait;
    if (stopOutcome.kind === "child_exit") throw new Error(stopOutcome.message);
  } finally {
    shutdown.dispose();
    stopChild(ui);
    stopChild(api);
  }
}

function isEntryPath(argv1: string | undefined): boolean {
  return /[\\/]startup\.(ts|js|mjs|cjs)$/.test(argv1 ?? "");
}

if (isEntryPath(process.argv[1])) {
  let args: StartupArgs;
  try {
    args = parseStartupArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  runStartup(args).catch((error) => {
    console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
