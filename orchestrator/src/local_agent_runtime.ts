/**
 * 本机 Agent CLI 适配层。
 *
 * 来源与边界：参考 nexu-io/open-design 0.21.0 的 runtime registry / detection，
 * 但这里只收下本工作台当前能安全证明的最小能力：Claude Code、CodeBuddy 与 Codex CLI 的订阅登录。
 * 三家都用用户自己在本机完成的登录；产品不代管登录、不复制登录凭据。
 * 普通 Agent 对话与 Deep 研究使用各自的产品 MCP；连接探针等内部任务不挂载工具。
 * 所有路径都关闭会话落盘与用户配置；没有等价隔离参数的 CLI 不能把按钮点亮。
 */
import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settleOwnedProcessGroup } from "./research_process.ts";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE_LOCAL_AGENTS = 4;
let activeLocalAgents = 0;
const activeLocalAgentProcesses = new Set<ChildProcess>();
type ParentSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
const parentSignalHandlers = new Map<ParentSignal, () => void>();
let parentExitHookInstalled = false;

export type LocalAgentId = "claude" | "codebuddy" | "codex";

export interface LocalAgentStatus {
  provider: "cli-codex" | "cli-claude" | "cli-codebuddy";
  name: "Codex" | "Claude Code" | "WorkBuddy / CodeBuddy";
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  version: string | null;
  status: "ready" | "not_installed" | "not_authenticated" | "probe_failed";
  detail: string;
  /** 正在用设置页里手动指定的位置(只有 WorkBuddy / CodeBuddy 有这一项) */
  custom_path?: boolean;
  /** 设置页存着一个手动指定的位置 —— 不管现在还找不找得到;页面据此给出「恢复自动检测」(环境变量锁定时为 false) */
  saved_path?: boolean;
}

/** Windows 没有 POSIX 进程组；taskkill /T 是对应的整棵进程树终止语义。 */
function signalProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): boolean {
  try {
    if (process.platform === "win32" && child.pid) {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      return !result.error && result.status === 0;
    } else if (child.pid) process.kill(-child.pid, signal);
    else return child.kill(signal);
    return true;
  } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

/**
 * 终止当前进程启动的所有订阅 CLI 进程树。供父进程退出钩子与产品关闭流程共用。
 * SIGKILL 直接打到父编排器本身时，任何进程内清理都不可能运行；其余正常退出与可捕获信号均在这里收口。
 */
export function terminateActiveLocalAgentProcesses(signal: NodeJS.Signals = "SIGKILL"): number {
  const children = [...activeLocalAgentProcesses];
  for (const child of children) signalProcessTree(child, signal);
  return children.length;
}

function removeParentShutdownHooks(): void {
  if (!parentExitHookInstalled) return;
  parentExitHookInstalled = false;
  process.removeListener("exit", onParentExit);
  for (const [signal, handler] of parentSignalHandlers) process.removeListener(signal, handler);
  parentSignalHandlers.clear();
}

function onParentExit(): void {
  terminateActiveLocalAgentProcesses("SIGKILL");
}

function installParentShutdownHooks(): void {
  if (parentExitHookInstalled) return;
  parentExitHookInstalled = true;
  process.once("exit", onParentExit);
  const signals: ParentSignal[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const handler = () => {
      // 父进程已经收到终止信号；此时不等 CLI 自行收尾，先同步杀整棵树，避免继续消耗订阅额度。
      terminateActiveLocalAgentProcesses("SIGKILL");
      removeParentShutdownHooks();
      // 恢复该信号的默认语义。延后一拍让同一轮中已有的其他监听器先完成同步清理。
      setImmediate(() => { try { process.kill(process.pid, signal); } catch { process.exit(1); } });
    };
    parentSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function trackLocalAgentProcess(child: ChildProcess): void {
  activeLocalAgentProcesses.add(child);
  installParentShutdownHooks();
}

function untrackLocalAgentProcess(child: ChildProcess): void {
  activeLocalAgentProcesses.delete(child);
  if (activeLocalAgentProcesses.size === 0) removeParentShutdownHooks();
}

/** setTimeout 可表达的范围内保留调用方配置；六阶段默认 30 分钟不得被适配器暗中缩短。 */
export function normalizeLocalAgentTimeoutMs(value: number | undefined): number {
  const requested = value ?? 180_000;
  if (!Number.isFinite(requested) || requested <= 0) throw new LocalAgentError("agent_bad_timeout", "本机 Agent 超时配置无效");
  return Math.max(1_000, Math.min(Math.trunc(requested), 2_147_000_000));
}

export class LocalAgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalAgentError";
    this.code = code;
  }
}

const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/usr/local/lib/node_modules/.bin",
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".bun/bin"),
  path.join(os.homedir(), "Library/pnpm"),
  path.join(os.homedir(), ".local/share/pnpm"),
];

function executableDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return [...(platform === "win32" ? [] : EXTRA_PATH_DIRS),
    env.APPDATA ? path.join(env.APPDATA, "npm") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : "",
    env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : "",
  ].filter(Boolean);
}

/** WorkBuddy 桌面版内置 CLI 的官方安装布局。Windows 内置的无扩展名文件是 Node 脚本。 */
export function workBuddyCliCandidates(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
      path.join(String(env.HOME || os.homedir()), "Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"),
    ];
  }
  if (platform !== "win32") return [];
  const p = path.win32;
  const roots = [
    env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, "Programs", "WorkBuddy") : "",
    env.ProgramFiles ? p.join(env.ProgramFiles, "WorkBuddy") : "C:\\Program Files\\WorkBuddy",
    env["ProgramFiles(x86)"] ? p.join(env["ProgramFiles(x86)"]!, "WorkBuddy") : "C:\\Program Files (x86)\\WorkBuddy",
    // 安装时把盘符改到 D: / E: 很常见(#50):安装器给的仍是「<盘>\Program Files\WorkBuddy」或「<盘>\WorkBuddy」。
    // 再偏的位置交给设置页手动指定(saveCodeBuddyLocation)。
    ...["C", "D", "E"].flatMap((drive) => [`${drive}:\\Program Files\\WorkBuddy`, `${drive}:\\WorkBuddy`]),
  ].filter(Boolean);
  return [...new Set(roots)].flatMap((root) => {
    const binDir = p.join(root, "resources", "app.asar.unpacked", "cli", "bin");
    // 新版可能附带可执行包装器；旧版 WorkBuddy 则只有无扩展名的 JS 入口。
    return ["codebuddy.exe", "codebuddy.cmd", "codebuddy"].map((name) => p.join(binDir, name));
  });
}

/** CodeBuddy Code 官方原生安装(不经 npm)在 Windows 的位置;macOS / Linux 的 ~/.local/bin 已在常见目录里。 */
export function codeBuddyNativeCandidates(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const p = path.win32;
  return [...new Set([
    env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, "codebuddy", "bin", "codebuddy.exe") : "",
    env.USERPROFILE ? p.join(env.USERPROFILE, "AppData", "Local", "codebuddy", "bin", "codebuddy.exe") : "",
  ].filter(Boolean))];
}

/** 设置页里手动指定的 CLI 位置存在 <数据根>/local-agents.json;每个入口启动时用 loadSavedAgentPaths 读进来。 */
export const AGENT_PATHS_FILE = "local-agents.json";
const MAX_AGENT_PATH = 1024;
let savedCodeBuddyBin: string | null = null;

/**
 * 读设置页保存的 CodeBuddy 位置。文件没有、读不懂或内容不合格一律当没设(回到自动检测):
 * 一个设置文件坏了不能拖垮后台、研究或体检的启动。
 */
export function loadSavedAgentPaths(dataRoot: string): void {
  savedCodeBuddyBin = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dataRoot, AGENT_PATHS_FILE), "utf8"));
    const bin = parsed && typeof parsed === "object" ? (parsed as { codebuddy_bin?: unknown }).codebuddy_bin : undefined;
    if (typeof bin === "string" && path.isAbsolute(bin) && bin.length <= MAX_AGENT_PATH && !/[\0\r\n]/.test(bin)) savedCodeBuddyBin = bin;
  } catch {
    // 没有或读不懂:按自动检测
  }
}

/**
 * 候选文件能否直接运行。npm 在 Windows 通常同时生成 claude.cmd 与 claude.ps1：
 * 换成可解析 Node 入口的 npm ps1，不把提示词送进 cmd.exe 或旧 PowerShell 的参数重解析。
 */
function usableExecutable(candidate: string, platform: NodeJS.Platform): string | null {
  try {
    const ext = path.extname(candidate).toLowerCase();
    const file = platform === "win32" && [".cmd", ".bat"].includes(ext) ? candidate.slice(0, -ext.length) + ".ps1" : candidate;
    fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * findExecutable 依次尝试的位置。GUI 启动时 PATH 往往比终端短；按 OD 的做法补常见全局安装目录。
 * 顺序:环境变量 *_BIN(设了就只认它)→ 设置页手动指定的位置 → PATH 与常见目录 → 官方原生安装 → WorkBuddy 桌面版内置。
 */
export function executableCandidates(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const overrideKey = bin === "claude" ? "CLAUDE_BIN" : bin === "codebuddy" ? "CODEBUDDY_BIN" : bin === "codex" ? "CODEX_BIN" : "";
  const override = overrideKey ? String(env[overrideKey] ?? "").trim() : "";
  const extensions = platform === "win32"
    ? [...new Set([".exe", ".ps1", ".cmd", ".bat", "", ...String(env.PATHEXT ?? "").split(";").map((x) => x.toLowerCase()).filter(Boolean)])]
    : [""];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const codeBuddy = bin === "codebuddy";
  return override ? [override] : [
    ...(codeBuddy && savedCodeBuddyBin ? [savedCodeBuddyBin] : []),
    ...[...new Set(String(env.PATH ?? "").split(delimiter).concat(executableDirs(env, platform)).filter(Boolean))]
      .flatMap((dir) => extensions.map((ext) => path.join(dir, `${bin}${ext}`))),
    ...(codeBuddy ? [...codeBuddyNativeCandidates(env, platform), ...workBuddyCliCandidates(env, platform)] : []),
  ];
}

export function findExecutable(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  for (const candidate of executableCandidates(bin, env, platform)) {
    const usable = usableExecutable(candidate, platform);
    if (usable) return usable;
    // 继续找下一处；设置页会把“未安装”说清楚。
  }
  return null;
}

/**
 * Windows 上 WorkBuddy 装在自定义位置(如 D:\软件\WorkBuddy)时,上面那几个固定位置找不到。
 * 再问系统两处:「已安装的程序」登记(卸载信息里的安装目录 / 图标 / 卸载程序)和正在运行的 WorkBuddy.exe。
 * 只读这两类信息,输出按 UTF-8 转 base64 再交回来,中文路径不受控制台代码页影响。
 */
const WORKBUDDY_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$out = New-Object System.Collections.Generic.List[string]",
  "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  "foreach ($e in @(Get-ItemProperty -Path $keys)) {",
  // 名字可能只有中文,所以安装目录 / 图标路径里带 WorkBuddy 也算
  "  if (([string]$e.DisplayName + '|' + [string]$e.InstallLocation + '|' + [string]$e.DisplayIcon) -match 'WorkBuddy') {",
  "    foreach ($n in @('InstallLocation', 'DisplayIcon', 'UninstallString')) {",
  "      $v = [string]$e.$n",
  "      if ($v) { $out.Add($n + [char]9 + $v) }",
  "    }",
  "  }",
  "}",
  // 只看当前登录会话里的进程:别的 Windows 用户开的同名程序不算(否则以管理员身份运行时会去跑别人文件夹里的程序)
  "$session = (Get-Process -Id $PID).SessionId",
  "foreach ($p in @(Get-Process -Name 'WorkBuddy' | Where-Object { $_.SessionId -eq $session })) { if ($p.Path) { $out.Add('Process' + [char]9 + $p.Path) } }",
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out -join [string][char]10)))",
].join("\n");
/** 冷启动加杀毒软件扫描时 PowerShell 可能要好几秒;GitHub 的 Windows 机器在并行跑测试时实测超过过 15 秒 */
const WORKBUDDY_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * 跑上面的只读脚本,返回「类别<TAB>值」每行一条。用系统自带 PowerShell 的绝对路径,不经 PATH。
 * 脚本用 -Command 明文传(和 fsutil 收紧文件权限一样),不用 -EncodedCommand:后者常被杀毒软件当成可疑行为拦下。
 */
async function discoverWorkBuddyWindows(env: NodeJS.ProcessEnv): Promise<string> {
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // 从 PowerShell 7 里启动时会继承它的模块路径,Windows PowerShell 5.1 加载不了那些模块,连 Get-ItemProperty 都会找不到
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WORKBUDDY_DISCOVERY_SCRIPT], {
    env: childEnv, windowsHide: true, timeout: WORKBUDDY_DISCOVERY_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
  });
  return Buffer.from(String(stdout).trim(), "base64").toString("utf8");
}

/**
 * 把系统给的线索整理成 WorkBuddy 安装文件夹(纯函数,便于在任何平台单测)。
 * 安装目录直接用;图标、卸载程序、进程给的是 exe,用它所在的文件夹。
 * 只收以盘符开头的本机路径(不收网络共享),去掉引号和图标序号,去重。
 */
export function workBuddyRootsFromDiscovery(output: string): string[] {
  const p = path.win32;
  const roots: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kind = line.slice(0, tab);
    const value = line.slice(tab + 1).trim();
    const unquoted = (v: string) => v.replace(/^"(.*)"$/s, "$1").trim();
    let dir: string | null = null;
    if (kind === "InstallLocation") dir = unquoted(value);
    else if (kind === "DisplayIcon") {
      const file = unquoted(value.replace(/,\s*-?\d+$/, ""));
      dir = /\.exe$/i.test(file) ? p.dirname(file) : null;
    } else if (kind === "UninstallString") {
      const file = /^"([^"]+)"/.exec(value)?.[1] ?? /^(.+?\.exe)(?=\s|$)/i.exec(value)?.[1] ?? null;
      dir = file ? p.dirname(file) : null;
    } else if (kind === "Process") dir = /\.exe$/i.test(value) ? p.dirname(value) : null;
    if (!dir || dir.length > MAX_AGENT_PATH || /[\0-\x1f]/.test(dir)) continue;
    let root = p.normalize(dir);
    if (!/^[A-Za-z]:\\/.test(root.length === 2 ? `${root}\\` : root)) continue;
    if (root.length > 3) root = root.replace(/\\+$/, "");
    if (!roots.some((r) => r.toLowerCase() === root.toLowerCase())) roots.push(root);
  }
  return roots;
}

/** 这些安装文件夹里 WorkBuddy 内置 CLI 可能在的位置;Squirrel 式安装的程序在 app-<版本> 子文件夹里(新版本在前) */
export function workBuddyBundledCandidates(roots: readonly string[], listDir: (dir: string) => string[] = safeListDir): string[] {
  const p = path.win32;
  const versionOf = (name: string) => name.slice(4).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const newerFirst = (a: string, b: string) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  };
  return roots.flatMap((root) => {
    const appDirs = listDir(root).filter((name) => /^app-\d+(\.\d+)*$/i.test(name)).sort(newerFirst).map((name) => p.join(root, name));
    return [root, ...appDirs].flatMap((dir) =>
      ["codebuddy.exe", "codebuddy.cmd", "codebuddy"].map((name) => p.join(dir, "resources", "app.asar.unpacked", "cli", "bin", name)));
  });
}

function safeListDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** 第一个能直接运行、且有安全启动方式的候选 */
function firstLaunchable(candidates: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  for (const candidate of candidates) {
    const usable = usableExecutable(candidate, platform);
    if (!usable) continue;
    try { executableInvocation(usable, [], env, platform); } catch { continue; }
    return usable;
  }
  return null;
}

/** 系统登记里找到的位置记在后台进程里:找到了且文件还在就一直用;没找到时,发起对话 30 秒内不重复问系统(设置页检测每次都重新问) */
const WORKBUDDY_DISCOVERY_MISS_TTL_MS = 30_000;
let workBuddyDiscovered: { bin: string | null; at: number } | null = null;
let workBuddyDiscovery: Promise<string | null> | null = null;

/** 测试用:清掉上面的记忆 */
export function resetWorkBuddyDiscoveryForTest(): void {
  workBuddyDiscovered = null;
  workBuddyDiscovery = null;
}

/**
 * 找 CodeBuddy CLI:先按 findExecutable 的固定顺序;Windows 上都没有、又没用环境变量锁定时,再问系统 WorkBuddy 装在哪。
 * 问系统要起一次 PowerShell(通常一两秒,冷启动可能更久),所以结果会记住;同一时间的多次查找只问一次。
 * retryMiss:设置页的检测 / 「重新检测」用,不认「刚才没找到」的记忆——用户可能刚装好或刚打开 WorkBuddy。
 */
export async function locateCodeBuddy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  discover: (env: NodeJS.ProcessEnv) => Promise<string> = discoverWorkBuddyWindows,
  opts: { retryMiss?: boolean } = {},
): Promise<string | null> {
  const found = findExecutable("codebuddy", env, platform);
  if (found || platform !== "win32" || String(env.CODEBUDDY_BIN ?? "").trim()) return found;
  const cached = workBuddyDiscovered;
  if (cached?.bin && usableExecutable(cached.bin, platform) === cached.bin) return cached.bin;
  if (cached && cached.bin === null && !opts.retryMiss && Date.now() - cached.at < WORKBUDDY_DISCOVERY_MISS_TTL_MS) return null;
  workBuddyDiscovery ??= (async () => {
    let bin: string | null = null;
    try {
      bin = firstLaunchable(workBuddyBundledCandidates(workBuddyRootsFromDiscovery(await discover(env))), env, platform);
    } catch {
      // PowerShell 不可用、超时或被拦:当没找到,设置页仍可手动指定位置
    }
    workBuddyDiscovered = { bin, at: Date.now() };
    return bin;
  })().finally(() => { workBuddyDiscovery = null; });
  return await workBuddyDiscovery;
}

/**
 * 设置页填的位置 → 依次尝试的 CLI 文件(纯函数,便于按 Windows 布局单测)。可以填:
 *  - WorkBuddy 安装文件夹(如 D:\Program Files\WorkBuddy),或 macOS 的 WorkBuddy.app;
 *  - WorkBuddy.exe 本身(用它所在的文件夹);
 *  - codebuddy 程序本身,或它所在的文件夹。
 * 其它文件返回空列表:页面只能指定 CodeBuddy,不能让后台去运行任意程序。
 */
export function codeBuddyLocationCandidates(target: string, kind: "dir" | "file", platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["codebuddy.exe", "codebuddy.ps1", "codebuddy.cmd", "codebuddy"] : ["codebuddy"];
  const bundled = (root: string) => [
    ...names.map((name) => p.join(root, "resources", "app.asar.unpacked", "cli", "bin", name)),
    ...(platform === "darwin" ? [p.join(root, "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy")] : []),
  ];
  if (kind === "dir") return [...bundled(target), ...names.map((name) => p.join(target, name))];
  const base = p.basename(target).toLowerCase();
  if (platform === "win32" ? base === "workbuddy.exe" : base === "workbuddy") return bundled(p.dirname(target));
  if (platform === "win32" ? /^codebuddy(\.exe|\.cmd|\.ps1)?$/.test(base) : base === "codebuddy") return [target];
  return [];
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** 把设置页填的位置解析成能运行的 CodeBuddy CLI 绝对路径;不行就抛 LocalAgentError,原因直接给使用者看。 */
export function resolveCodeBuddyLocation(input: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  let target = String(input ?? "").trim();
  // 资源管理器「复制文件地址」会带上两头的引号
  if (/^(["']).+\1$/s.test(target)) target = target.slice(1, -1).trim();
  if (!target || target.length > MAX_AGENT_PATH || /[\0\r\n]/.test(target)) {
    throw new LocalAgentError("bad_agent_path", "请填 WorkBuddy 的安装文件夹(完整路径)");
  }
  if (platform === "win32") target = target.replace(/%([^%\\/]+)%/g, (whole, name: string) => envValue(env, name) ?? whole);
  else if (target === "~" || target.startsWith("~/")) target = p.join(String(env.HOME || os.homedir()), target.slice(1));
  target = p.normalize(target);
  // Windows 只接受以盘符开头的本机路径:网络共享(\\server\...)上的程序不该被后台拿来运行
  if (platform === "win32" ? !/^[A-Za-z]:\\/.test(target) : !p.isAbsolute(target)) {
    throw new LocalAgentError("bad_agent_path", "请填完整路径(Windows 从盘符开始,如 D:\\Program Files\\WorkBuddy;不支持网络共享路径)");
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(target); }
  catch { throw new LocalAgentError("agent_path_not_found", "这个位置不存在，请检查路径有没有填错"); }
  const candidates = codeBuddyLocationCandidates(target, stat.isDirectory() ? "dir" : "file", platform);
  // Windows 填的是安装文件夹时,也看 Squirrel 式的 app-<版本> 子文件夹
  if (platform === "win32" && stat.isDirectory()) candidates.push(...workBuddyBundledCandidates([target]).filter((c) => !candidates.includes(c)));
  if (!candidates.length) throw new LocalAgentError("bad_agent_path", "请填 WorkBuddy 的安装文件夹，或 codebuddy 程序本身");
  const usable = firstLaunchable(candidates, env, platform);
  if (usable) return usable;
  throw new LocalAgentError("agent_path_no_cli", "这个位置里没有找到 WorkBuddy 内置的 CodeBuddy 程序；请填 WorkBuddy 的安装文件夹");
}

const insideDir = (child: string, parent: string) => {
  const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const [c, d] = [norm(child), norm(parent)];
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
};
const realpathOr = (value: string) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };

/**
 * 设置页「指定 WorkBuddy 位置」:解析 → 写 <数据根>/local-agents.json → 重新检测并返回状态。
 * input 为 null / 空 = 清除,回到自动检测。检测不通过也照样保存:状态卡会如实显示卡在哪一步。
 * 环境变量 CODEBUDDY_BIN 设了就以它为准,页面不能改。
 */
export async function saveCodeBuddyLocation(dataRoot: string, input: string | null, env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => Promise<LocalAgentStatus> = probeCodeBuddy): Promise<LocalAgentStatus> {
  if (String(env.CODEBUDDY_BIN ?? "").trim()) {
    throw new LocalAgentError("agent_path_env_locked", "CodeBuddy 的位置已由环境变量 CODEBUDDY_BIN 指定；要改请改这个变量");
  }
  const file = path.join(dataRoot, AGENT_PATHS_FILE);
  if (input === null || !String(input).trim()) {
    fs.rmSync(file, { force: true });
    savedCodeBuddyBin = null;
    return probe(env);
  }
  const bin = resolveCodeBuddyLocation(input, env);
  // 数据根是页面能往里写文件的地方:指向那里面的程序,等于让页面决定后台运行什么
  if (insideDir(realpathOr(bin), realpathOr(dataRoot))) {
    throw new LocalAgentError("bad_agent_path", "不能指定到产品数据目录里的程序");
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ codebuddy_bin: bin, saved_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); }
  catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  savedCodeBuddyBin = bin;
  return probe(env);
}

/** Mirrors npm read-cmd-shim's $basedir target lookup, restricted to Node shims.
 * The chosen installed CLI is trusted executable code, not a sandbox boundary.
 * Bypass PowerShell 5.1's native-argument rewriting (empty args / JSON quotes).
 */
function npmNodeEntry(bin: string): string | null {
  try {
    const stat = fs.statSync(bin);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const source = fs.readFileSync(bin, "utf8").replace(/\r\n/g, "\n");
    if (!source.startsWith("#!/usr/bin/env pwsh\n") ||
      !source.includes("$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n")) return null;
    const targets = [...source.matchAll(/&\s+"(?:\$basedir\/)?node\$exe"\s+"\$basedir\/([^"\r\n]+)"\s+\$args\b/g)].map((m) => m[1]!);
    if (!targets.length || new Set(targets).size !== 1 || /[$`]/.test(targets[0]!) || !/\.[cm]?js$/i.test(targets[0]!)) return null;
    const entry = path.resolve(path.dirname(bin), targets[0]!);
    if (!fs.statSync(entry).isFile()) return null;
    return entry;
  } catch { return null; }
}

export function executableInvocation(
  bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform !== "win32") return { file: bin, args };
  const ext = path.win32.extname(bin).toLowerCase();
  if (!ext && path.win32.basename(bin).toLowerCase() === "codebuddy" &&
      bin.toLowerCase().includes("app.asar.unpacked")) {
    // Windows 不执行 shebang；用当前后端的 Node 运行 WorkBuddy 内置 JS 入口。
    return { file: process.execPath, args: [bin, ...args] };
  }
  if (ext !== ".ps1") {
    if ([".cmd", ".bat"].includes(ext)) throw new LocalAgentError("agent_start_failed", "Windows CLI 缺少安全的 PowerShell 启动器");
    return { file: bin, args };
  }
  const entry = npmNodeEntry(bin);
  if (!entry) throw new LocalAgentError("agent_windows_wrapper_unsupported", "Windows 仅支持原生 CLI 或标准 npm Node 启动器，请重新安装官方 CLI");
  return { file: process.execPath, args: [entry, ...args] };
}

function oneLine(value: unknown): string | null {
  const line = String(value ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return line ? line.slice(0, 80) : null;
}

function parseAuthStatus(stdout: string): boolean {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !("loggedIn" in parsed) || typeof parsed.loggedIn !== "boolean") throw new Error("Invalid auth status");
  if (!parsed.loggedIn) return false;
  if (!("authMethod" in parsed) || typeof parsed.authMethod !== "string" ||
      !("apiProvider" in parsed) || typeof parsed.apiProvider !== "string") throw new Error("Invalid auth status");
  // 这一张卡片承诺的是 claude.ai 订阅，不是“Claude CLI 随便能调通”。
  // Bedrock / Vertex / API key 即使可用，也不能在这里冒充订阅额度。
  return parsed.authMethod === "claude.ai" && parsed.apiProvider === "firstParty";
}

const REQUIRED_CLAUDE_FLAGS = [
  "--safe-mode", "--tools", "--strict-mcp-config", "--no-session-persistence",
  "--output-format", "--system-prompt", "--json-schema",
] as const;
/** 每次调用前的能力与登录检查;比界面探针宽一些,免得机器一忙就把整次研究判成检测失败 */
const CLAUDE_RUN_PROBE_TIMEOUT_MS = 10_000;

async function claudeHasRequiredFlags(bin: string, runEnv: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const helpCall = executableInvocation(bin, ["--help"], runEnv);
  const h = await execFileAsync(helpCall.file, helpCall.args, { env: runEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 128 * 1024, signal });
  const help = String(h.stdout);
  return REQUIRED_CLAUDE_FLAGS.every((flag) => help.includes(flag));
}

/**
 * `claude auth status`:true = claude.ai 订阅登录;false = 明确未登录,或登录方式不是订阅(API key / Bedrock / Vertex 等)。
 * Claude 对“未登录”以退出码 1 输出一段 JSON,只认这一种失败形态;
 * 超时、权限问题、输出读不懂都不能证明登录失效 ⇒ 抛错,由调用方当“检测未完成”。
 */
async function claudeSubscriptionLogin(bin: string, runEnv: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const authCall = executableInvocation(bin, ["auth", "status"], runEnv);
  try {
    const a = await execFileAsync(authCall.file, authCall.args, { env: runEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal });
    return parseAuthStatus(String(a.stdout));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean; signal?: unknown };
    if (failure.code === 1 && !failure.killed && !failure.signal && typeof failure.stdout === "string") {
      let loggedIn: boolean | null = null;
      try { loggedIn = parseAuthStatus(failure.stdout); } catch { /* 状态不明,照样抛 */ }
      if (loggedIn === false) return false;
    }
    throw error;
  }
}

/** 只返回版本与“是否已登录”，绝不把账号、组织或 CLI 原始输出送到浏览器。 */
export async function probeClaude(env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus> {
  const bin = findExecutable("claude", env);
  if (!bin) {
    return {
      provider: "cli-claude", name: "Claude Code", installed: false, authenticated: false,
      available: false, version: null, status: "not_installed", detail: "本机未检测到 Claude Code",
    };
  }
  const runEnv = subscriptionEnv(env);
  let version: string | null = null;
  try {
    const versionCall = executableInvocation(bin, ["--version"], runEnv);
    const v = await execFileAsync(versionCall.file, versionCall.args, { env: runEnv, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    version = oneLine(v.stdout);
    if (!(await claudeHasRequiredFlags(bin, runEnv, 5_000))) {
      return {
        provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
        available: false, version, status: "probe_failed", detail: "Claude Code 版本过旧，缺少受限对话所需的安全参数",
      };
    }
  } catch {
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
      available: false, version: null, status: "probe_failed", detail: "Claude Code 已安装，但版本检测失败",
    };
  }
  let authenticated: boolean;
  try {
    authenticated = await claudeSubscriptionLogin(bin, runEnv, 5_000);
  } catch {
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
      available: false, version, status: "probe_failed",
      detail: "Claude Code 登录状态检测未完成，请重试；若持续失败，请检查系统访问权限。现有登录不会被清除。",
    };
  }
  return {
    provider: "cli-claude", name: "Claude Code", installed: true, authenticated,
    available: authenticated, version, status: authenticated ? "ready" : "not_authenticated",
    detail: authenticated ? "已安装并登录，可使用本机 Claude 订阅" : "已安装；请先运行 claude 并完成 /login",
  };
}

const REQUIRED_CODEBUDDY_FLAGS = [
  "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources",
  "--input-format", "--output-format", "--system-prompt", "--json-schema", "--max-turns", "--agent",
  "--permission-mode", "--subagent-permission-mode",
] as const;

// WorkBuddy's bundled CLI cold start can exceed five seconds even for --help.
// Give each read-only probe a bounded startup window; timeout is not logout.
const CODEBUDDY_PROBE_TIMEOUT_MS = 15_000;

interface CodeBuddyAccount {
  userId: string;
  token: string;
}

/** Only OS, network transport and explicit subscription login context enter a CLI process. */
export function localSubscriptionEnv(base: NodeJS.ProcessEnv, agent: LocalAgentId): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TMPDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE"];
  if (agent === "claude") keys.push("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN");
  // Codex 的 ChatGPT 登录在用户自己的 CODEX_HOME（缺省 ~/.codex）。CODEX_API_KEY / OPENAI_API_KEY
  // 不在白名单里：exec 模式认 CODEX_API_KEY，漏进来就会静默改成按 API 计费。
  if (agent === "codex") keys.push("CODEX_HOME");
  const allowed = new Set(keys);
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined &&
    allowed.has(process.platform === "win32" ? key.toUpperCase() : key)));
}

interface CodeBuddyRuntime {
  account: CodeBuddyAccount | null;
  legacyEphemeralHome: boolean;
}

function codeBuddySubscriptionEnv(
  base: NodeJS.ProcessEnv,
  options: { account?: CodeBuddyAccount | null; ephemeralHome?: string } = {},
): NodeJS.ProcessEnv {
  const env = localSubscriptionEnv(base, "codebuddy");
  // 这一张卡承诺复用本机登录账号。API key、临时 OAuth token、自定义端点和模型覆盖
  // 都可能让非交互调用静默换成另一套计费来源，因此在探针与执行两条路径同时移除。
  for (const key of [
    "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_BASE_URL", "CODEBUDDY_CUSTOM_HEADERS",
    "CODEBUDDY_MODEL", "CODEBUDDY_SMALL_FAST_MODEL", "CODEBUDDY_BIG_SLOW_MODEL",
    "CODEBUDDY_CODE_SUBAGENT_MODEL", "MAX_THINKING_TOKENS",
  ]) delete env[key];
  const isolated: NodeJS.ProcessEnv = {
    ...env,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CODEBUDDY_DISABLE_IDE: "1",
    CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
    CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1",
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CODEBUDDY_DISABLE_FORK_SUBAGENT: "1",
    CODEBUDDY_REPL_ENABLED: "0",
    CODEBUDDY_COMPUTER_USE_ENABLED: "0",
    CODEBUDDY_ARTIFACT_ENABLED: "0",
    CODEBUDDY_PUSH_NOTIFICATION_ENABLED: "0",
    CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED: "0",
  };
  if (options.ephemeralHome) {
    isolated.HOME = options.ephemeralHome;
    isolated.USERPROFILE = options.ephemeralHome;
    isolated.APPDATA = path.join(options.ephemeralHome, "AppData", "Roaming");
    isolated.LOCALAPPDATA = path.join(options.ephemeralHome, "AppData", "Local");
    isolated.XDG_CONFIG_HOME = path.join(options.ephemeralHome, ".config");
    isolated.XDG_CACHE_HOME = path.join(options.ephemeralHome, ".cache");
    isolated.XDG_DATA_HOME = path.join(options.ephemeralHome, ".local", "share");
    isolated.XDG_STATE_HOME = path.join(options.ephemeralHome, ".local", "state");
  }
  // WorkBuddy 桌面端自带的旧 CLI 与新版独立 CLI 使用不同的登录存储。旧版缺少
  // --no-session-persistence 时，只把桌面端 initialize 返回的订阅凭据注入一次性 HOME；
  // 既不写回用户目录，也不把 token 暴露到状态、日志或 argv。
  if (options.account) {
    isolated.CODEBUDDY_AUTH_TOKEN = options.account.token;
    isolated.CODEBUDDY_USER_ID = options.account.userId;
  }
  return isolated;
}

const codeBuddyIsolationArgs = (legacyEphemeralHome = false): string[] => [
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--setting-sources", "none",
  ...(legacyEphemeralHome ? [] : ["--no-session-persistence"]),
];

/**
 * CodeBuddy 没有公开的 `auth status` 子命令。官方 Agent SDK 也是启动 stream-json
 * 进程并发送 initialize 控制请求；这里复刻这一个只读探针，不引入会捆绑整套 CLI 的 SDK 依赖。
 * 响应里的账号和 token 只转成布尔值，既不返回也不落日志。
 */
async function codeBuddyAccount(bin: string, env: NodeJS.ProcessEnv, legacyEphemeralHome = false): Promise<CodeBuddyAccount | null> {
  return await new Promise<CodeBuddyAccount | null>((resolve, reject) => {
    const args = [
      "--input-format=stream-json", "--output-format=stream-json", "--verbose",
      ...codeBuddyIsolationArgs(legacyEphemeralHome),
    ];
    const launch = executableInvocation(bin, args, env);
    const child = spawn(launch.file, launch.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const requestId = `vra_probe_${process.pid}_${Date.now()}`;
    let stdout = "";
    let stderr = "";
    let account: CodeBuddyAccount | null | undefined;
    let settled = false;
    let terminationError: Error | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let killFallbackTimer: NodeJS.Timeout | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      fn();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      try { child.stdin.destroy(); } catch { /* 已关闭 */ }
      signalProcessTree(child, "SIGTERM");
      hardKillTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        killFallbackTimer = setTimeout(() => finish(() => reject(terminationError!)), 2_000);
        // Keep shutdown acknowledgement alive even after the child closes its pipes.
      }, 500);
      // This bounded timer owns the still-pending probe promise.
    };
    const timer = setTimeout(() => {
      terminate(new Error("CodeBuddy auth probe timed out"));
    }, CODEBUDDY_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 512 * 1024) {
        return terminate(new Error("CodeBuddy auth probe output too large"));
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as {
            type?: unknown;
            response?: { subtype?: unknown; request_id?: unknown; response?: { account?: { userId?: unknown; token?: unknown } | null } };
          };
          if (message.type !== "control_response" || message.response?.request_id !== requestId) continue;
          const value = message.response.subtype === "success" ? message.response.response?.account : null;
          account = value && typeof value.userId === "string" && value.userId &&
            typeof value.token === "string" && value.token
            ? { userId: value.userId, token: value.token }
            : null;
        } catch { /* 非 JSON 诊断行不参与判定 */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 64 * 1024) stderr += chunk;
    });
    child.once("error", (error) => {
      if (terminationError) return finish(() => reject(terminationError!));
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      if (terminationError) return finish(() => reject(terminationError!));
      if (account !== undefined) return finish(() => resolve(account!));
      finish(() => reject(new Error(`CodeBuddy auth probe failed (${code ?? "unknown"}):${stderr.slice(-200)}`)));
    });
    child.stdin.on("error", () => { /* 提前退出时由 close 统一处理 */ });
    child.stdin.end(JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize" },
    }) + "\n", "utf8");
  });
}

async function inspectCodeBuddy(bin: string, env: NodeJS.ProcessEnv): Promise<{ version: string | null; runtime: CodeBuddyRuntime }> {
  const runEnv = codeBuddySubscriptionEnv(env);
  const versionCall = executableInvocation(bin, ["--version"], runEnv);
  // These read-only CLI probes have no graceful shutdown work. WorkBuddy's embedded
  // CLI can ignore SIGTERM even for --help; execFile would then never settle on timeout.
  const v = await execFileAsync(versionCall.file, versionCall.args, { env: runEnv, timeout: CODEBUDDY_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  const version = oneLine(v.stdout);
  const helpCall = executableInvocation(bin, ["--help"], runEnv);
  const h = await execFileAsync(helpCall.file, helpCall.args, { env: runEnv, timeout: CODEBUDDY_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 192 * 1024 });
  const help = String(h.stdout);
  if (!REQUIRED_CODEBUDDY_FLAGS.every((flag) => help.includes(flag))) {
    throw new LocalAgentError("agent_cli_too_old", "CodeBuddy 版本过旧，缺少受限对话所需的安全参数");
  }
  const legacyEphemeralHome = !help.includes("--no-session-persistence");
  const account = await codeBuddyAccount(bin, runEnv, legacyEphemeralHome);
  return { version, runtime: { account, legacyEphemeralHome } };
}

/**
 * 设置页指定位置的两个状态:`custom_path` = 这次用的就是保存的那个;`saved_path` = 存着一个(哪怕它已经被移走、卸载)。
 * 只看路径字符串,不运行任何程序。环境变量 CODEBUDDY_BIN 设了就以它为准,两者都是 false。
 */
export function codeBuddyPathFlags(bin: string | null, env: NodeJS.ProcessEnv = process.env): { custom_path: boolean; saved_path: boolean } {
  const locked = Boolean(String(env.CODEBUDDY_BIN ?? "").trim());
  return { custom_path: !locked && bin !== null && bin === savedCodeBuddyBin, saved_path: !locked && savedCodeBuddyBin !== null };
}

/** 只公开 CodeBuddy 版本与登录布尔；控制响应中的账号和 token 不离开本进程。 */
export async function probeCodeBuddy(env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus> {
  const bin = await locateCodeBuddy(env, process.platform, undefined, { retryMiss: true });
  if (!bin) {
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: false, authenticated: false,
      available: false, version: null, status: "not_installed",
      detail: process.platform === "win32"
        ? "本机未检测到 WorkBuddy / CodeBuddy。已经装了 WorkBuddy：先打开它再点「重新检测」，或在下面填它的安装文件夹"
        : "本机未检测到 CodeBuddy Code CLI",
      saved_path: codeBuddyPathFlags(null, env).saved_path,
    };
  }
  const { custom_path, saved_path } = codeBuddyPathFlags(bin, env);
  let version: string | null = null;
  try {
    const inspected = await inspectCodeBuddy(bin, env);
    version = inspected.version;
    const authenticated = inspected.runtime.account !== null;
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: true, authenticated, custom_path, saved_path,
      available: authenticated, version, status: authenticated ? "ready" : "not_authenticated",
      detail: authenticated
        ? "CodeBuddy CLI 已登录，可使用本机 WorkBuddy / CodeBuddy 账号"
        : "已安装；请先运行 codebuddy 并完成登录",
    };
  } catch (error) {
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: true, authenticated: false, custom_path, saved_path,
      available: false, version, status: "probe_failed", detail: codeBuddyProbeFailure(error),
    };
  }
}

/**
 * 检测失败时告诉使用者大概卡在哪:超时、程序起不来、还是退出码不对。
 * 不带 CLI 自己的输出 —— 那里可能有账号信息。
 */
export function codeBuddyProbeFailure(error: unknown): string {
  if (error instanceof LocalAgentError) return error.message;
  const e = error as { killed?: boolean; signal?: unknown; code?: unknown; message?: unknown } | null;
  const message = String(e?.message ?? "");
  if (e?.killed || /timed out/i.test(message)) {
    return "CodeBuddy 检测超时：WorkBuddy 内置程序第一次启动可能比较慢（杀毒软件扫描时更慢），稍后点「重新检测」再试";
  }
  if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) return `CodeBuddy 程序启动不了（${e.code}）`;
  if (typeof e?.code === "number") return `CodeBuddy 登录状态检测失败（程序退出码 ${e.code}）`;
  const exit = /auth probe failed \((-?\d+)\)/.exec(message)?.[1];
  return exit ? `CodeBuddy 登录状态检测失败（程序退出码 ${exit}）` : "CodeBuddy 登录状态检测失败";
}

/** 隔离参数（`--ignore-user-config`、`agents.enabled` 等）在 0.160.0 实测过；更早的版本不放行。 */
export const MIN_CODEX_CLI_VERSION = "0.160.0";
const CODEX_PROBE_TIMEOUT_MS = 10_000;

/** `codex-cli 0.160.0` → `0.160.0`；读不出三段版本号时返回 null。 */
export function parseCodexVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(output ?? ""));
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

export function codexVersionSupported(version: string | null): boolean {
  if (!version) return false;
  const have = version.split(".").map(Number);
  const need = MIN_CODEX_CLI_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (have[i] !== need[i]) return (have[i] ?? 0) > (need[i] ?? 0);
  return true;
}

export type CodexLoginKind = "chatgpt" | "api_key" | "logged_out";

/**
 * `codex login status` 的结论行（0.160.0 写在 stderr）。只认整行开头的固定措辞，
 * 读不懂的一律返回 null 交给调用方当“检测未完成”，不回传任何原文（可能含账号或打码的 key）。
 */
export function parseCodexLoginStatus(stdout: string, stderr: string, exitCode: number): CodexLoginKind | null {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim());
  if (exitCode === 0 && lines.some((line) => line.startsWith("Logged in using ChatGPT"))) return "chatgpt";
  if (exitCode === 0 && lines.some((line) => line.startsWith("Logged in using an API key"))) return "api_key";
  if (exitCode === 1 && lines.some((line) => line === "Not logged in")) return "logged_out";
  return null;
}

function codexSubscriptionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return localSubscriptionEnv(base, "codex");
}

async function codexVersion(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  const call = executableInvocation(bin, ["--version"], env);
  const v = await execFileAsync(call.file, call.args, { env, timeout: CODEX_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal });
  return parseCodexVersion(String(v.stdout));
}

async function codexLogin(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CodexLoginKind> {
  const call = executableInvocation(bin, ["login", "status"], env);
  try {
    const s = await execFileAsync(call.file, call.args, { env, timeout: CODEX_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal });
    const login = parseCodexLoginStatus(String(s.stdout), String(s.stderr), 0);
    if (login) return login;
  } catch (error) {
    // 上游 login.rs 对“没登录”和“读取失败”都退出 1；只有明确的 Not logged in 才算未登录。
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean; signal?: unknown };
    if (failure.code === 1 && !failure.killed && !failure.signal &&
        parseCodexLoginStatus(String(failure.stdout ?? ""), String(failure.stderr ?? ""), 1) === "logged_out") return "logged_out";
  }
  throw new LocalAgentError("agent_probe_failed", "Codex 登录状态检测未完成，请重试；现有登录不会被清除。");
}

const CODEX_LOGIN_HINT: Record<Exclude<CodexLoginKind, "chatgpt">, string> = {
  api_key: "Codex 当前用 API key 登录；这张卡片只走 ChatGPT 订阅，请在终端运行 codex login 改用 ChatGPT 登录",
  logged_out: "已安装；请先在终端运行 codex login 完成 ChatGPT 登录",
};

/** 用户自己装的 Codex CLI：只公开版本与“是否用 ChatGPT 登录”，不读 auth.json、不返回账号。 */
export async function probeCodex(env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus> {
  const base = { provider: "cli-codex", name: "Codex" } as const;
  const bin = findExecutable("codex", env);
  if (!bin) {
    return { ...base, installed: false, authenticated: false, available: false, version: null,
      status: "not_installed", detail: "本机未检测到 Codex CLI；安装官方 Codex CLI 后运行 codex login" };
  }
  const runEnv = codexSubscriptionEnv(env);
  let version: string | null = null;
  try {
    version = await codexVersion(bin, runEnv);
  } catch {
    return { ...base, installed: true, authenticated: false, available: false, version: null,
      status: "probe_failed", detail: "Codex 已安装，但版本检测失败" };
  }
  if (!codexVersionSupported(version)) {
    return { ...base, installed: true, authenticated: false, available: false, version,
      status: "probe_failed", detail: `Codex CLI 版本过旧，需要 ${MIN_CODEX_CLI_VERSION} 或更新` };
  }
  try {
    const login = await codexLogin(bin, runEnv);
    if (login === "chatgpt") {
      return { ...base, installed: true, authenticated: true, available: true, version,
        status: "ready", detail: "已安装并用 ChatGPT 登录，可使用本机 Codex 订阅" };
    }
    return { ...base, installed: true, authenticated: false, available: false, version,
      status: "not_authenticated", detail: CODEX_LOGIN_HINT[login] };
  } catch (error) {
    return { ...base, installed: true, authenticated: false, available: false, version,
      status: "probe_failed", detail: error instanceof LocalAgentError ? error.message : "Codex 登录状态检测失败" };
  }
}

/**
 * Codex 自带的工具开关。0.160.0 实测：关掉这些之后模型只剩产品 MCP、一个因 code-mode host
 * 关闭而必然失败的 exec 入口，以及 exec 模式下不可用的提问工具。这只是第一道门；
 * 真正的兜底是下面的事件白名单 —— 出现任何白名单外的动作就杀掉整棵进程树。
 */
const CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "js_repl", "code_mode_host", "apps", "plugins", "memories", "hooks",
  "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "computer_use", "in_app_browser",
  "image_generation", "view_image", "tool_suggest", "skill_mcp_dependency_install", "standalone_web_search",
  "worktrees", "goals", "sleep_tool", "undo", "default_mode_request_user_input", "request_permissions_tool",
  "send_async_message", "send_message_to_user_async",
] as const;

const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `-c key=value` 的 value 按 TOML 解析。JSON 字符串转义基本就是 TOML basic string 的转义，
 * 差别只有两处：TOML 不收孤立代理项（换成 U+FFFD），也不收裸 DEL（补 \u007f）。
 */
export function tomlString(value: string): string {
  const clean = String(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return JSON.stringify(clean).replace(/\u007f/g, "\\u007f");
}
const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(",")}]`;
const tomlTable = (values: Record<string, string>): string =>
  `{${Object.entries(values).map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(",")}}`;

/**
 * 可单测的 Codex 参数生成器。提示词走 stdin（`exec -`），系统指令放 developer_instructions：
 * 用户全局的 `$CODEX_HOME/AGENTS.md` 无法通过参数关掉，只能靠更高优先级的产品指令压住。
 * `--ignore-user-config` 不读用户 config.toml，但登录仍取自用户的 CODEX_HOME。
 */
export function codexArgs(systemPrompt: string, cwd: string, options: {
  controlledMcp?: RunLocalAgentOptions["controlledMcp"];
  outputSchemaFile?: string;
  imageFiles?: string[];
} = {}): string[] {
  const mcp = options.controlledMcp;
  if (mcp && !MCP_SERVER_NAME_RE.test(mcp.serverName)) throw new LocalAgentError("agent_bad_mcp", "受控工具服务名不合法");
  const args = [
    "exec", "-", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral",
    "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-C", cwd,
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    // 不关这一项，collaboration.spawn_agent 等派生子代理的工具仍会出现在工具表里。
    "-c", "agents.enabled=false",
    // 该模型强制 code mode；产品 MCP 必须列成 direct-only，否则会被藏到（已关闭的）exec 入口后面。
    "-c", `features.code_mode={enabled=false,direct_only_tool_namespaces=${tomlArray(mcp ? [`mcp__${mcp.serverName}`] : [])}}`,
    "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
    "-c", "include_permissions_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", `developer_instructions=${tomlString(systemPrompt)}`,
  ];
  if (mcp) {
    const key = `mcp_servers.${mcp.serverName}`;
    const prefix = `mcp__${mcp.serverName}__`;
    args.push(
      "-c", `${key}.command=${tomlString(mcp.command)}`,
      "-c", `${key}.args=${tomlArray(mcp.args)}`,
      "-c", `${key}.env=${tomlTable(mcp.env)}`,
      "-c", `${key}.enabled_tools=${tomlArray(mcp.allowedTools.map((name) => name.startsWith(prefix) ? name.slice(prefix.length) : name))}`,
      "-c", `${key}.required=true`,
      "-c", `${key}.startup_timeout_sec=60`,
      "-c", `${key}.tool_timeout_sec=600`,
      "-c", `${key}.default_tools_approval_mode="approve"`,
    );
  }
  if (options.outputSchemaFile) args.push("--output-schema", options.outputSchemaFile);
  for (const file of options.imageFiles ?? []) args.push(`--image=${file}`);
  return args;
}

/** exec `--json` 里允许出现的条目类型。命令执行、改文件、联网搜索、子代理等一律不在其中。 */
const CODEX_ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);

const textOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return null;
};

/**
 * 逐行消费 `codex exec --json`，不在内存里攒整份输出（工具结果会原样回显，长阶段可达数 MB）。
 * `push` 返回非空字符串表示越出白名单，调用方必须立刻终止进程树。
 */
export class CodexEventStream {
  readonly #server: string | null;
  readonly #tools: Set<string> | null;
  readonly #maxToolCalls: number;
  readonly #toolCalls = new Set<string>();
  #message: string | null = null;
  #completed = false;
  #failure: string | null = null;
  readonly #errors: string[] = [];

  constructor(controlledMcp?: RunLocalAgentOptions["controlledMcp"]) {
    this.#server = controlledMcp?.serverName ?? null;
    const prefix = controlledMcp ? `mcp__${controlledMcp.serverName}__` : "";
    this.#tools = controlledMcp
      ? new Set(controlledMcp.allowedTools.map((name) => name.startsWith(prefix) ? name.slice(prefix.length) : name))
      : null;
    // 防失控上限：一次调用内工具调用次数。正常阶段远低于此。
    this.#maxToolCalls = Math.max(32, (controlledMcp?.maxTurns ?? 32) * 8);
  }

  push(line: string): string | null {
    const text = line.trim();
    if (!text) return null;
    let event: { type?: unknown; item?: unknown; error?: unknown; message?: unknown };
    try { event = JSON.parse(text) as typeof event; } catch { return null; }
    if (!event || typeof event !== "object") return null;
    switch (event.type) {
      case "turn.completed": this.#completed = true; return null;
      case "turn.failed": this.#failure = (textOf(event.error) ?? "turn failed").slice(0, 2_000); return null;
      case "error": this.#errors.push((textOf(event) ?? "error").slice(0, 2_000)); return null;
      case "item.started": case "item.updated": case "item.completed": return this.#item(event.type, event.item);
      default: return null;
    }
  }

  #item(phase: string, raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as { id?: unknown; type?: unknown; text?: unknown; server?: unknown; tool?: unknown };
    const type = typeof item.type === "string" ? item.type : "";
    if (!CODEX_ALLOWED_ITEMS.has(type)) return `Codex 尝试了产品未开放的动作（${type.slice(0, 40) || "未知"}），已终止`;
    if (type === "mcp_tool_call") {
      if (!this.#server || item.server !== this.#server || !this.#tools?.has(String(item.tool ?? ""))) {
        return "Codex 调用了未授权的工具，已终止";
      }
      this.#toolCalls.add(typeof item.id === "string" ? item.id : `#${this.#toolCalls.size}`);
      if (this.#toolCalls.size > this.#maxToolCalls) return `Codex 本轮工具调用超过 ${this.#maxToolCalls} 次，已终止`;
    }
    if (type === "agent_message" && phase === "item.completed" && typeof item.text === "string") this.#message = item.text;
    return null;
  }

  /** 失败分类只看终止原因与流级错误；条目级 error 是启动提示（如 code-mode host 已关闭），不参与。 */
  diagnostics(): string {
    return [this.#failure, ...this.#errors].filter(Boolean).join("\n");
  }

  result(): string {
    if (this.#failure || !this.#completed) throw new LocalAgentError("agent_failed", "Codex 本轮没有正常结束");
    if (!this.#message?.trim()) throw new LocalAgentError("agent_empty_output", "Codex 没有返回可见回答");
    return this.#message;
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export interface RunLocalAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  /**
   * 资料转写的图片附件；字节已由导入边界校验。WorkBuddy 走原生上传块，Codex 由适配器写进
   * 一次性工作区再用 --image 附上。调用方永远不传本机路径。
   */
  userImages?: Array<{ name: string; data: string; mimeType: string }>;
  outputSchema?: unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Deep 研究或资料转写：关掉所有内建工具，只开放这一个显式 MCP 白名单。
   * 配置只含本地可执行文件与运行目录，不得放密钥。
   */
  controlledMcp?: {
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    allowedTools: string[];
    maxTurns?: number;
  };
}

export function localAgentInput(agent: LocalAgentId, prompt: string, images?: RunLocalAgentOptions["userImages"]): string {
  if (!images?.length) return prompt;
  if (agent === "claude" || images.length > 10 || images.some((im) =>
    typeof im.name !== "string" || !im.name || im.name.length > 200 ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(im.mimeType) ||
    typeof im.data !== "string" || !im.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) ||
    images.reduce((sum, im) => sum + im.data.length, 0) > 32 * 1024 * 1024) {
    throw new LocalAgentError("agent_bad_image", "图片附件格式或大小不受支持");
  }
  if (agent === "codex") {
    // 图片按顺序随 --image 附在提示词后面；这里只补上与之对应的原文件名，供证据引用。
    return `${prompt}\n\n${images.map((im, i) => `附图 ${i + 1}：source_file=${JSON.stringify(im.name)}`).join("\n")}`;
  }
  return JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "text", text: prompt },
    ...images.flatMap((im) => [{ type: "text", text: `上传图片 source_file=${JSON.stringify(im.name)}` },
      { type: "image", source: { type: "base64", media_type: im.mimeType, data: im.data } }]),
  ] } }) + "\n";
}

/** 可单测的参数生成器。普通对话无工具；Deep 只开放显式受控 MCP。 */
export function claudeArgs(systemPrompt: string, outputSchema?: unknown,
  controlledMcp?: RunLocalAgentOptions["controlledMcp"]): string[] {
  const mcpConfig = controlledMcp ? JSON.stringify({ mcpServers: {
    [controlledMcp.serverName]: { type: "stdio", command: controlledMcp.command,
      args: controlledMcp.args, env: controlledMcp.env },
  } }) : '{"mcpServers":{}}';
  const args = [
    "-p",
    // safe-mode 会把**显式传入**的 MCP 也关掉，所以工具路径用临时 cwd + 空 setting sources
    // 隔离自动发现；无工具对话仍用 safe-mode。安全边界是下面的内建工具全关 + 严格 MCP 白名单。
    ...(controlledMcp ? ["--setting-sources", ""] : ["--safe-mode"]),
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--tools", "",
    ...(controlledMcp ? ["--allowedTools", ...controlledMcp.allowedTools] : []),
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
  ];
  if (outputSchema !== undefined) args.push("--json-schema", JSON.stringify(outputSchema));
  return args;
}

/** CodeBuddy 的 `--print` 不携位置 prompt，因此只从 stdin 取用户正文，不进 argv / 进程列表。 */
export function codeBuddyArgs(systemPrompt: string, outputSchema?: unknown, legacyEphemeralHome = false,
  controlledMcp?: RunLocalAgentOptions["controlledMcp"]): string[] {
  const isolation = codeBuddyIsolationArgs(legacyEphemeralHome);
  if (controlledMcp) {
    isolation[isolation.indexOf("--tools") + 1] = `NoDefer(mcp__${controlledMcp.serverName}__*)`;
    const i = isolation.indexOf("--mcp-config");
    isolation[i + 1] = JSON.stringify({ mcpServers: {
      [controlledMcp.serverName]: { type: "stdio", command: controlledMcp.command,
        args: controlledMcp.args, env: controlledMcp.env, alwaysLoad: true, defer_loading: false },
    } });
  }
  const args = [
    "-p",
    "--agent", "cli",
    ...isolation,
    ...(controlledMcp ? ["--allowedTools", ...controlledMcp.allowedTools] : []),
    // WorkBuddy 桌面端内置的旧 CLI 在非交互模式下会拒绝 MCP 确认，
    // `--allowedTools` 并不足以让它真正执行。Deep 路径可以用 bypassPermissions，
    // 因为同一组 argv 已经把内建工具全关，并用 strict-mcp-config 只留一个本产品 MCP。
    "--permission-mode", controlledMcp ? "bypassPermissions" : legacyEphemeralHome ? "default" : "dontAsk",
    "--subagent-permission-mode", legacyEphemeralHome ? "default" : "dontAsk",
    "--max-turns", String(controlledMcp?.maxTurns ?? 1),
    "--output-format", "json",
    "--system-prompt", systemPrompt,
  ];
  if (outputSchema !== undefined) args.push("--json-schema", JSON.stringify(outputSchema));
  return args;
}

function subscriptionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = localSubscriptionEnv(base, "claude");
  // 用户明确选择“Claude 订阅”时，让 Claude Code 自己的 claude.ai 登录态胜出。
  // 否则外壳进程里遗留的 API key / 第三方网关可能静默改掉计费方。
  // `CLAUDE_CODE_OAUTH_TOKEN` 是 `claude setup-token` 生成的官方订阅认证，必须保留；
  // 探针若靠它判 ready、执行时却删掉，会造成“界面可用、实际未登录”的假绿。
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ]) delete env[key];
  return env;
}

/** Claude `--output-format json` 的脱敏解析；结构化任务优先取 structured_output。 */
export function parseClaudeOutput(stdout: string): string {
  let parsed: { result?: unknown; structured_output?: unknown; is_error?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new LocalAgentError("agent_bad_output", "Claude Code 返回了无法解析的结果");
  }
  if (parsed.is_error === true) throw new LocalAgentError("agent_failed", "Claude Code 本轮执行失败");
  if (parsed.structured_output !== undefined) return JSON.stringify(parsed.structured_output);
  if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result;
  throw new LocalAgentError("agent_empty_output", "Claude Code 没有返回可见回答");
}

/** CodeBuddy 当前 JSON 输出兼容 result / response，并优先返回结构化产物。 */
export function parseCodeBuddyOutput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LocalAgentError("agent_bad_output", "CodeBuddy 返回了无法解析的结果");
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of [...candidates].reverse()) {
    if (!item || typeof item !== "object") continue;
    const value = item as { result?: unknown; response?: unknown; structured_output?: unknown; is_error?: unknown };
    if (value.is_error === true) throw new LocalAgentError("agent_failed", "CodeBuddy 本轮执行失败");
    if (value.structured_output !== undefined) return JSON.stringify(value.structured_output);
    if (typeof value.result === "string" && value.result.trim()) return value.result;
    if (typeof value.response === "string" && value.response.trim()) return value.response;
  }
  throw new LocalAgentError("agent_empty_output", "CodeBuddy 没有返回可见回答");
}

const AGENT_LABEL: Record<LocalAgentId, string> = { claude: "Claude Code", codebuddy: "CodeBuddy", codex: "Codex" };
const AGENT_LOGIN_COMMAND: Record<LocalAgentId, string> = { claude: "claude", codebuddy: "codebuddy", codex: "codex login" };

function failureMessage(agent: LocalAgentId, stdout: string, stderr: string, code: number | null): LocalAgentError {
  const label = AGENT_LABEL[agent];
  const command = AGENT_LOGIN_COMMAND[agent];
  const text = `${stderr}\n${stdout}`.slice(0, 16_000);
  if (/not logged in|login required|authentication|oauth|unauthori[sz]ed|\b401\b/i.test(text)) {
    return new LocalAgentError("agent_not_authenticated", `${label} 登录已失效，请先运行 ${command} 并完成登录`);
  }
  if (/rate.?limit|quota|usage limit|too many requests|\b429\b/i.test(text)) {
    return new LocalAgentError("agent_quota", `${label} 当前额度或频率受限，请稍后再试`);
  }
  return new LocalAgentError("agent_failed", `${label} 调用失败（退出码 ${code ?? "未知"}）`);
}

/**
 * 运行一次本机 Agent 请求。普通对话无工具；Deep 研究只开放调用方给出的受控 MCP。
 * 提示词走 stdin，避免把用户正文放进 argv / 进程列表。
 * stdout / stderr 都有限额；超时或取消后先 TERM，再 KILL，避免 CLI 留在后台继续消耗额度。
 */
export async function runLocalAgent(agent: LocalAgentId, opts: RunLocalAgentOptions): Promise<string> {
  if (!Object.hasOwn(AGENT_LABEL, agent)) throw new LocalAgentError("unsupported_cli", `尚未安全接通本机 Agent:${agent}`);
  const label = AGENT_LABEL[agent];
  const command = agent;
  if (opts.signal?.aborted) throw new LocalAgentError("agent_cancelled", `${label} 请求已取消`);
  if (activeLocalAgents >= MAX_ACTIVE_LOCAL_AGENTS) {
    throw new LocalAgentError("agent_busy", `本机 Agent 已有 ${MAX_ACTIVE_LOCAL_AGENTS} 个任务在运行，请稍后再试`);
  }
  const baseEnv = opts.env ?? process.env;
  const input = localAgentInput(agent, opts.userPrompt, opts.userImages);
  const bin = agent === "codebuddy" ? await locateCodeBuddy(baseEnv) : findExecutable(command, baseEnv);
  // Windows 找 WorkBuddy 可能要等系统登记查询:等完再看一次取消和容量,占槽位前不能让别的请求挤过检查
  if (opts.signal?.aborted) throw new LocalAgentError("agent_cancelled", `${label} 请求已取消`);
  if (activeLocalAgents >= MAX_ACTIVE_LOCAL_AGENTS) {
    throw new LocalAgentError("agent_busy", `本机 Agent 已有 ${MAX_ACTIVE_LOCAL_AGENTS} 个任务在运行，请稍后再试`);
  }
  if (!bin) throw new LocalAgentError("agent_not_installed", `本机未安装 ${label}`);
  // Reject unsupported wrappers and invalid settings before reserving a slot or creating a workspace.
  executableInvocation(bin, [], baseEnv);
  const timeoutMs = normalizeLocalAgentTimeoutMs(opts.timeoutMs);
  // 能力与登录探针是异步的；先占槽位，避免多个请求同时通过上面的容量检查。
  activeLocalAgents += 1;
  const releaseSlot = () => { activeLocalAgents = Math.max(0, activeLocalAgents - 1); };
  // 探针失败时先看是不是用户取消了：取消会让探针进程被杀、读不到结论，那不是“检测失败”。
  const cancelled = () => new LocalAgentError("agent_cancelled", `${label} 请求已取消`);
  let codeBuddyRuntime: CodeBuddyRuntime | null = null;
  if (agent === "codebuddy") {
    try {
      codeBuddyRuntime = (await inspectCodeBuddy(bin, baseEnv)).runtime;
    } catch (error) {
      releaseSlot();
      if (opts.signal?.aborted) throw cancelled();
      if (error instanceof LocalAgentError) throw error;
      throw new LocalAgentError("agent_probe_failed", "CodeBuddy 登录状态检测失败");
    }
    if (!codeBuddyRuntime.account) {
      releaseSlot();
      throw new LocalAgentError("agent_not_authenticated", "CodeBuddy 登录已失效，请先运行 codebuddy 并完成登录");
    }
  }
  if (agent === "claude") {
    // 每次执行前都确认能力参数还在、且仍是 claude.ai 订阅登录。环境变量清理只挡得住外壳里的 API key，
    // 挡不住 CLI 自己保存的 API key / Bedrock 登录：用户在两次调用之间换了登录方式，同一张“订阅”卡片就会静默改成按量计费。
    let subscribed: boolean;
    try {
      const claudeEnv = subscriptionEnv(baseEnv);
      if (!(await claudeHasRequiredFlags(bin, claudeEnv, CLAUDE_RUN_PROBE_TIMEOUT_MS, opts.signal))) {
        throw new LocalAgentError("agent_cli_too_old", "Claude Code 版本过旧，缺少受限对话所需的安全参数");
      }
      subscribed = await claudeSubscriptionLogin(bin, claudeEnv, CLAUDE_RUN_PROBE_TIMEOUT_MS, opts.signal);
    } catch (error) {
      releaseSlot();
      if (opts.signal?.aborted) throw cancelled();
      if (error instanceof LocalAgentError) throw error;
      throw new LocalAgentError("agent_probe_failed", "Claude Code 版本或登录状态检测未完成，请重试；现有登录不会被清除。");
    }
    if (!subscribed) {
      releaseSlot();
      throw new LocalAgentError("agent_not_authenticated", "Claude Code 当前不是 claude.ai 订阅登录；请先运行 claude 并用订阅账号完成 /login");
    }
  }
  if (agent === "codex") {
    // 每次执行前都确认仍是 ChatGPT 登录：用户若在两次调用之间换成 API key 登录，
    // 同一张“订阅”卡片会静默改成按量计费。版本过旧时隔离参数不存在，也不能放行。
    try {
      const codexEnv = codexSubscriptionEnv(baseEnv);
      if (!codexVersionSupported(await codexVersion(bin, codexEnv, opts.signal))) {
        throw new LocalAgentError("agent_cli_too_old", `Codex CLI 版本过旧，需要 ${MIN_CODEX_CLI_VERSION} 或更新`);
      }
      const login = await codexLogin(bin, codexEnv, opts.signal);
      if (login !== "chatgpt") throw new LocalAgentError("agent_not_authenticated", CODEX_LOGIN_HINT[login]);
    } catch (error) {
      releaseSlot();
      if (opts.signal?.aborted) throw cancelled();
      if (error instanceof LocalAgentError) throw error;
      throw new LocalAgentError("agent_probe_failed", "Codex 版本或登录状态检测失败");
    }
  }
  // 探针期间已被取消（CodeBuddy 的探针不接取消信号，会等它自己结束）：不再创建研究进程。
  if (opts.signal?.aborted) {
    releaseSlot();
    throw cancelled();
  }

  const maxOut = 4 * 1024 * 1024;
  const maxErr = 64 * 1024;
  // Codex 的 JSONL 会原样回显每次工具结果；逐行消费、不攒全量，只给单行设上限。
  const maxCodexLine = 32 * 1024 * 1024;
  let tmpDir: string;
  let outputSchemaFile: string | undefined;
  const imageFiles: string[] = [];
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vra-${agent}-`));
  } catch (error) {
    activeLocalAgents = Math.max(0, activeLocalAgents - 1);
    throw error;
  }
  if (agent === "codex") {
    try {
      if (opts.outputSchema !== undefined) {
        outputSchemaFile = path.join(tmpDir, "output-schema.json");
        fs.writeFileSync(outputSchemaFile, JSON.stringify(opts.outputSchema), { mode: 0o600 });
      }
      for (const [i, image] of (opts.userImages ?? []).entries()) {
        const file = path.join(tmpDir, `image-${i + 1}${IMAGE_EXTENSIONS[image.mimeType] ?? ".bin"}`);
        fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
        imageFiles.push(file);
      }
    } catch (error) {
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
  }

  return await new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
    const runEnv = agent === "claude"
      ? subscriptionEnv(baseEnv)
      : agent === "codex"
      ? codexSubscriptionEnv(baseEnv)
      : codeBuddySubscriptionEnv(baseEnv, {
        account: codeBuddyRuntime!.legacyEphemeralHome ? codeBuddyRuntime!.account : null,
        ephemeralHome: codeBuddyRuntime!.legacyEphemeralHome ? tmpDir : undefined,
      });
    // M6 的无工具对话刻意不等 MCP；Deep 研究则必须反过来。
    // 否则真实 WorkBuddy 会在 stdio server 尚未初始化时就开始首轮，
    // 模型看到零工具仍正常退出，表现为“请求成功但阶段文件永远不写”。
    if (agent === "codebuddy" && opts.controlledMcp) {
      runEnv.CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED = "1";
      // CodeBuddy 默认把 MCP 延迟加载，除非配置 alwaysLoad/defer_loading；
      // 只开 `WAIT_FOR_MCP_SERVERS` 不会让它进入首轮等待清单。官方默认等 2 秒，本地 Node 冷启动留 30 秒。
      runEnv.CODEBUDDY_FIRST_RUN_MCP_PREWAIT_TIMEOUT_MS = "30000";
    }
    const args = agent === "claude"
      ? claudeArgs(opts.systemPrompt, opts.outputSchema, opts.controlledMcp)
      : agent === "codex"
      ? codexArgs(opts.systemPrompt, tmpDir, { controlledMcp: opts.controlledMcp, outputSchemaFile, imageFiles })
      : codeBuddyArgs(opts.systemPrompt, opts.outputSchema, codeBuddyRuntime!.legacyEphemeralHome, opts.controlledMcp);
    if (agent === "codebuddy" && opts.userImages?.length) args.push("--input-format", "stream-json");
    const launch = executableInvocation(bin, args, runEnv);
    child = spawn(launch.file, launch.args, {
      cwd: tmpDir,
      windowsHide: true,
      env: runEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX 下创建独立进程组。本机 Agent CLI 可能继续派生 node / shell 子进程；
      // 只杀直接 child 会让后代留在后台继续消耗订阅额度。
      detached: process.platform !== "win32",
    });
    } catch {
      // 参数拼装或 spawn 同步失败(如提示词里有 NUL):还没有子进程,当场释放槽位与工作区。
      releaseSlot();
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 尽力清理 */ }
      reject(new LocalAgentError("agent_launch_failed", `${label} 未能启动`));
      return;
    }
    trackLocalAgentProcess(child);
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let settled = false;
    let terminationError: LocalAgentError | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let killFallbackTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      // Windows may briefly retain a handle after process close. Retry within a
      // fixed bound; a persistent cleanup failure must never become success.
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      untrackLocalAgentProcess(child);
      try { cleanup(); }
      catch {
        reject(new LocalAgentError("agent_cleanup_failed", `${label} 临时工作区清理失败，请检查本机文件权限`));
        return;
      }
      fn();
    };
    let closed = false;
    let treeSignalled = false;
    const signalTree = (signal: NodeJS.Signals) => {
      // Windows：直接子进程已经自己退出时，taskkill 找不到它（退出码 128），它派生的进程也无从再按树查找。
      // 这时与正常退出路径同一判据（Windows 上只认直接子进程退出），报原本的原因，不报「退出未确认」。
      treeSignalled = signalProcessTree(child, signal) || treeSignalled || (process.platform === "win32" && child.exitCode !== null);
    };
    const processTreeAlive = (): boolean => {
      if (process.platform === "win32") return child.exitCode === null;
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const terminate = (error: LocalAgentError) => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try { child.stdin.destroy(); } catch { /* 已关闭 */ }
      signalTree("SIGTERM");
      // Promise 不能在 TERM 发出后立刻返回：那会清掉临时目录与监听器，
      // 却无法证明整个进程组已经退出。两秒后杀整组，再等 close。
      hardKillTimer = setTimeout(() => {
        signalTree("SIGKILL");
        killFallbackTimer = setTimeout(() => {
          const confirmed = closed && !processTreeAlive() && (process.platform !== "win32" || treeSignalled);
          finish(() => reject(confirmed ? terminationError! : new LocalAgentError("agent_shutdown_failed", `${label} 进程树退出未确认，不能视为已取消`)));
        }, 2_000);
        // Do not let Node exit while this shutdown acknowledgement is pending.
      }, 2_000);
      // The detached child may close before its descendants; keep the bounded wait alive.
    };
    const onAbort = () => {
      terminate(new LocalAgentError("agent_cancelled", `${label} 请求已取消`));
    };
    const timer = setTimeout(() => {
      terminate(new LocalAgentError("agent_timeout", `${label} 超时（>${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    child.stdin.on("error", () => { /* 提前退出时的 EPIPE 由 close 统一处理 */ });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const codexStream = agent === "codex" ? new CodexEventStream(opts.controlledMcp) : null;
    let pendingLine = "";
    child.stdout.on("data", (chunk: string) => {
      if (terminationError) return;
      if (codexStream) {
        const lines = (pendingLine + chunk).split("\n");
        pendingLine = lines.pop() ?? "";
        for (const line of lines) {
          const violation = codexStream.push(line);
          if (violation) return terminate(new LocalAgentError("agent_policy_violation", violation));
        }
        if (pendingLine.length > maxCodexLine) terminate(new LocalAgentError("agent_output_too_large", `${label} 输出超出上限，已终止`));
        return;
      }
      outBytes += Buffer.byteLength(chunk, "utf8");
      if (outBytes > maxOut) {
        terminate(new LocalAgentError("agent_output_too_large", `${label} 输出超出上限，已终止`));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < maxErr) stderr += chunk;
    });
    child.on("error", () => {
      if (terminationError) return; // close + tree verification owns acknowledgement
      finish(() => reject(new LocalAgentError("agent_start_failed", `${label} 启动失败`)));
    });
    child.on("close", (code) => {
      closed = true;
      if (terminationError) {
        // 直接 child 退出不代表它派生的进程也退出；组还活着就保留 KILL timer。
        if (processTreeAlive() || (process.platform === "win32" && !treeSignalled)) return;
        return finish(() => reject(terminationError!));
      }
      clearTimeout(timer);
      settleOwnedProcessGroup(child.pid).then(() => {
        if (terminationError) return finish(() => reject(terminationError!));
        const lastViolation = codexStream && pendingLine ? codexStream.push(pendingLine) : null;
        if (lastViolation) return finish(() => reject(new LocalAgentError("agent_policy_violation", lastViolation)));
        // Codex 的 stdout 是整段工具往来；分类只看它的终止原因，免得把研究正文里的 “401” 误判成掉登录。
        const diagnostics = codexStream ? codexStream.diagnostics() : stdout;
        if (code !== 0) return finish(() => reject(failureMessage(agent, diagnostics, stderr, code)));
        finish(() => {
        try {
          resolve(agent === "claude" ? parseClaudeOutput(stdout) : codexStream ? codexStream.result() : parseCodeBuddyOutput(stdout));
        } catch (error) {
          // CodeBuddy 2.143.1 在未登录时会以 exit 0 输出一行纯文本，而不是 JSON。
          // 只有解析已经失败时才把已知的登录 / 限流诊断升级为受控错误，避免误读正常模型回答。
          const classified = failureMessage(agent, diagnostics, stderr, code);
          reject(classified.code === "agent_failed" ? error : classified);
        }
        });
      }, () => finish(() => reject(new LocalAgentError("agent_shutdown_failed", `${label} 进程组退出未确认`))));
    });
    // 取消监听放在子进程的 error / close 监听之后：已取消时也要靠 close 确认整棵进程树退出，
    // 先返回就等不到 close，只能误报“退出未确认”。
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return onAbort();
    child.stdin.end(input, "utf8");
  });
}
