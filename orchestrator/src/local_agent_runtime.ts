/**
 * 本机 Agent CLI 适配层。
 *
 * 来源与边界：参考 nexu-io/open-design 0.21.0 的 runtime registry / detection，
 * 但这里只收下金融工作台当前能安全证明的最小能力：Claude Code 与 CodeBuddy 的订阅登录。
 * 普通对话关闭全部工具与 MCP；Deep 研究关闭全部内建工具，只开放本产品显式受控 MCP。
 * 两条路径都关闭会话落盘与用户配置；没有等价隔离参数的 CLI 不能把按钮点亮。
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE_LOCAL_AGENTS = 4;
let activeLocalAgents = 0;
const activeLocalAgentProcesses = new Set<ChildProcess>();
type ParentSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
const parentSignalHandlers = new Map<ParentSignal, () => void>();
let parentExitHookInstalled = false;

export type LocalAgentId = "claude" | "codebuddy";

export interface LocalAgentStatus {
  provider: "cli-codex" | "cli-claude" | "cli-codebuddy";
  name: "Codex" | "Claude Code" | "WorkBuddy / CodeBuddy";
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  version: string | null;
  status: "ready" | "not_installed" | "not_authenticated" | "login_pending" | "login_failed" | "probe_failed";
  detail: string;
}

export interface CodexLoginProgress {
  state: "pending" | "failed";
  startedAt: number;
  finishedAt?: number;
}

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const CODEX_LOGIN_FAILURE_TTL_MS = 60 * 1_000;
const codexLoginJobs = new Map<string, CodexLoginProgress>();

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

function codexHomeKey(codexHome: string): string {
  return path.resolve(codexHome);
}

/** 只暴露产品需要的登录进度，不暴露 CLI 输出、账号或认证内容。 */
export function codexLoginProgress(codexHome: string): CodexLoginProgress | null {
  const key = codexHomeKey(codexHome);
  const progress = codexLoginJobs.get(key) ?? null;
  if (progress?.state === "failed" && Date.now() - (progress.finishedAt ?? 0) > CODEX_LOGIN_FAILURE_TTL_MS) {
    codexLoginJobs.delete(key);
    return null;
  }
  return progress;
}

/**
 * 启动官方 `codex login` 浏览器登录流程。登录态严格写入产品自己的 CODEX_HOME，
 * 同一个产品 home 同时只允许一条登录流程，避免重复弹浏览器窗口。
 */
export function startCodexLogin(
  bin: string | null, codexHome: string, env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): { state: "started" | "pending" } {
  if (!bin || !fs.existsSync(bin)) {
    throw new LocalAgentError("agent_not_installed", "产品自带的 Codex 引擎不存在");
  }
  try {
    fs.accessSync(bin, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
  } catch {
    throw new LocalAgentError("agent_start_failed", "产品自带的 Codex 引擎无法启动");
  }

  const key = codexHomeKey(codexHome);
  if (codexLoginJobs.get(key)?.state === "pending") return { state: "pending" };
  fs.mkdirSync(key, { recursive: true, mode: 0o700 });
  const progress: CodexLoginProgress = { state: "pending", startedAt: Date.now() };
  codexLoginJobs.set(key, progress);

  const runEnv = { ...env, CODEX_HOME: key };
  const launch = executableInvocation(bin, ["login"], runEnv);
  const child = spawn(launch.file, launch.args, {
    env: runEnv,
    stdio: "ignore",
    shell: false,
    detached: process.platform !== "win32",
  });
  let settled = false;
  let timedOut = false;
  let hardKillTimer: NodeJS.Timeout | null = null;
  let exitPollTimer: NodeJS.Timeout | null = null;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (exitPollTimer) clearTimeout(exitPollTimer);
    codexLoginJobs.set(key, { ...progress, state: "failed", finishedAt: Date.now() });
  };
  const signalTree = (signal: NodeJS.Signals) => {
    signalProcessTree(child, signal);
  };
  const processTreeAlive = (): boolean => {
    if (process.platform === "win32") return child.exitCode === null;
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };
  const failWhenTreeExited = () => {
    if (!processTreeAlive()) return fail();
    exitPollTimer = setTimeout(failWhenTreeExited, 50);
    exitPollTimer.unref();
  };
  const timeoutMs = Math.max(50, options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS);
  const timer = setTimeout(() => {
    // 仍保持 pending，直到 close 或 KILL 收尾完成；否则用户能在旧进程仍活着时启动第二条登录。
    timedOut = true;
    signalTree("SIGTERM");
    hardKillTimer = setTimeout(() => {
      signalTree("SIGKILL");
      failWhenTreeExited();
    }, 2_000);
    hardKillTimer.unref();
  }, timeoutMs);
  timer.unref();
  child.once("error", fail);
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut && processTreeAlive()) {
      // 直接 child 已关不代表同组派生进程已关；保留 KILL timer 与 pending 状态。
      settled = false;
      return;
    }
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (exitPollTimer) clearTimeout(exitPollTimer);
    if (code === 0) codexLoginJobs.delete(key);
    else codexLoginJobs.set(key, { ...progress, state: "failed", finishedAt: Date.now() });
  });
  return { state: "started" };
}

/** 产品自带 Codex 的真实登录探针；只认命令退出码，不读取或返回 auth.json 内容。 */
export async function probeCodex(
  bin: string | null, codexHome: string, env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAgentStatus> {
  if (!bin || !fs.existsSync(bin)) {
    return { provider: "cli-codex", name: "Codex", installed: false, authenticated: false, available: false,
      version: null, status: "not_installed", detail: "产品自带的 Codex 引擎不存在" };
  }
  let version: string | null = null;
  try {
    const versionCall = executableInvocation(bin, ["--version"], env);
    const v = await execFileAsync(versionCall.file, versionCall.args, { env, timeout: 5_000, maxBuffer: 64 * 1024 });
    version = oneLine(v.stdout);
  } catch {
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
      version: null, status: "probe_failed", detail: "Codex 已安装，但版本检测失败" };
  }
  try {
    const statusCall = executableInvocation(bin, ["login", "status"], { ...env, CODEX_HOME: codexHome });
    await execFileAsync(statusCall.file, statusCall.args, {
      env: { ...env, CODEX_HOME: codexHome }, timeout: 5_000, maxBuffer: 64 * 1024,
    });
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: true, available: true,
      version, status: "ready", detail: "产品自带引擎已登录，可使用 ChatGPT 订阅" };
  } catch {
    const login = codexLoginProgress(codexHome);
    if (login?.state === "pending") {
      return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
        version, status: "login_pending", detail: "正在等待浏览器完成 Codex 登录" };
    }
    if (login?.state === "failed") {
      return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
        version, status: "login_failed", detail: "Codex 登录未完成，请重新登录" };
    }
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
      version, status: "not_authenticated", detail: "产品自带引擎尚未登录" };
  }
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
  ].filter(Boolean);
  return [...new Set(roots)].flatMap((root) => {
    const binDir = p.join(root, "resources", "app.asar.unpacked", "cli", "bin");
    // 新版可能附带可执行包装器；旧版 WorkBuddy 则只有无扩展名的 JS 入口。
    return ["codebuddy.exe", "codebuddy.cmd", "codebuddy"].map((name) => p.join(binDir, name));
  });
}

/** GUI 启动时 PATH 往往比终端短；按 OD 的做法补常见全局安装目录。 */
export function findExecutable(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const overrideKey = bin === "claude" ? "CLAUDE_BIN" : bin === "codebuddy" ? "CODEBUDDY_BIN" : "";
  const override = overrideKey ? String(env[overrideKey] ?? "").trim() : "";
  const extensions = platform === "win32"
    ? [...new Set([".exe", ".ps1", ".cmd", ".bat", "", ...String(env.PATHEXT ?? "").split(";").map((x) => x.toLowerCase()).filter(Boolean)])]
    : [""];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const workBuddyAppCandidates = bin === "codebuddy" ? workBuddyCliCandidates(env, platform) : [];
  const candidates = override ? [override] : [
    ...[...new Set(String(env.PATH ?? "").split(delimiter).concat(executableDirs(env, platform)).filter(Boolean))]
      .flatMap((dir) => extensions.map((ext) => path.join(dir, `${bin}${ext}`))),
    ...workBuddyAppCandidates,
  ];
  for (const candidate of candidates) {
    try {
      // npm 在 Windows 通常同时生成 claude.cmd 与 claude.ps1。优先返回可由
      // powershell.exe -File 安全传参的 ps1；不要把含提示词的 argv 拼进 cmd.exe 命令串。
      const ext = path.extname(candidate).toLowerCase();
      const ps1 = platform === "win32" && [".cmd", ".bat"].includes(ext) ? candidate.slice(0, -ext.length) + ".ps1" : candidate;
      fs.accessSync(ps1, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(ps1).isFile()) return ps1;
    } catch {
      // 继续找下一处；设置页会把“未安装”说清楚。
    }
  }
  return null;
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
  const windowsRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
  const powershell = windowsRoot
    ? path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return { file: powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bin, ...args] };
}

function oneLine(value: unknown): string | null {
  const line = String(value ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return line ? line.slice(0, 80) : null;
}

function parseAuthStatus(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
    // 这一张卡片承诺的是 claude.ai 订阅，不是“Claude CLI 随便能调通”。
    // Bedrock / Vertex / API key 即使可用，也不能在这里冒充订阅额度。
    return parsed.loggedIn === true && parsed.authMethod === "claude.ai" && parsed.apiProvider === "firstParty";
  } catch {
    return false;
  }
}

const REQUIRED_CLAUDE_FLAGS = [
  "--safe-mode", "--tools", "--strict-mcp-config", "--no-session-persistence",
  "--output-format", "--system-prompt", "--json-schema",
] as const;

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
    const v = await execFileAsync(versionCall.file, versionCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 64 * 1024 });
    version = oneLine(v.stdout);
    const helpCall = executableInvocation(bin, ["--help"], runEnv);
    const h = await execFileAsync(helpCall.file, helpCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 128 * 1024 });
    const help = String(h.stdout);
    if (!REQUIRED_CLAUDE_FLAGS.every((flag) => help.includes(flag))) {
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
  try {
    const authCall = executableInvocation(bin, ["auth", "status"], runEnv);
    const a = await execFileAsync(authCall.file, authCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 64 * 1024 });
    const authenticated = parseAuthStatus(String(a.stdout));
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated,
      available: authenticated, version, status: authenticated ? "ready" : "not_authenticated",
      detail: authenticated ? "已安装并登录，可使用本机 Claude 订阅" : "已安装；请先运行 claude 并完成 /login",
    };
  } catch {
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
      available: false, version, status: "not_authenticated", detail: "已安装；请先运行 claude 并完成 /login",
    };
  }
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

interface CodeBuddyRuntime {
  account: CodeBuddyAccount | null;
  legacyEphemeralHome: boolean;
}

function codeBuddySubscriptionEnv(
  base: NodeJS.ProcessEnv,
  options: { account?: CodeBuddyAccount | null; ephemeralHome?: string } = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
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
        killFallbackTimer.unref();
      }, 500);
      hardKillTimer.unref();
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
  const v = await execFileAsync(versionCall.file, versionCall.args, { env: runEnv, timeout: CODEBUDDY_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 });
  const version = oneLine(v.stdout);
  const helpCall = executableInvocation(bin, ["--help"], runEnv);
  const h = await execFileAsync(helpCall.file, helpCall.args, { env: runEnv, timeout: CODEBUDDY_PROBE_TIMEOUT_MS, maxBuffer: 192 * 1024 });
  const help = String(h.stdout);
  if (!REQUIRED_CODEBUDDY_FLAGS.every((flag) => help.includes(flag))) {
    throw new LocalAgentError("agent_cli_too_old", "CodeBuddy 版本过旧，缺少受限对话所需的安全参数");
  }
  const legacyEphemeralHome = !help.includes("--no-session-persistence");
  const account = await codeBuddyAccount(bin, runEnv, legacyEphemeralHome);
  return { version, runtime: { account, legacyEphemeralHome } };
}

/** 只公开 CodeBuddy 版本与登录布尔；控制响应中的账号和 token 不离开本进程。 */
export async function probeCodeBuddy(env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus> {
  const bin = findExecutable("codebuddy", env);
  if (!bin) {
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: false, authenticated: false,
      available: false, version: null, status: "not_installed", detail: "本机未检测到 CodeBuddy Code CLI",
    };
  }
  let version: string | null = null;
  try {
    const inspected = await inspectCodeBuddy(bin, env);
    version = inspected.version;
    const authenticated = inspected.runtime.account !== null;
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: true, authenticated,
      available: authenticated, version, status: authenticated ? "ready" : "not_authenticated",
      detail: authenticated
        ? "CodeBuddy CLI 已登录，可使用本机 WorkBuddy / CodeBuddy 账号"
        : "已安装；请先运行 codebuddy 并完成登录",
    };
  } catch (error) {
    return {
      provider: "cli-codebuddy", name: "WorkBuddy / CodeBuddy", installed: true, authenticated: false,
      available: false, version, status: "probe_failed",
      detail: error instanceof LocalAgentError && error.code === "agent_cli_too_old"
        ? error.message
        : "CodeBuddy 登录状态检测失败",
    };
  }
}

export interface RunLocalAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  /** WorkBuddy native upload blocks; bytes already validated by the ingest boundary. Never file paths. */
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
  if (agent !== "codebuddy" || images.length > 10 || images.some((im) =>
    typeof im.name !== "string" || !im.name || im.name.length > 200 ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(im.mimeType) ||
    typeof im.data !== "string" || !im.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) ||
    images.reduce((sum, im) => sum + im.data.length, 0) > 32 * 1024 * 1024) {
    throw new LocalAgentError("agent_bad_image", "图片附件格式或大小不受支持");
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
    // safe-mode 会把**显式传入**的 MCP 也关掉，所以 Deep 路径用临时 cwd + 空 setting sources
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
  const env = { ...base };
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

function failureMessage(agent: LocalAgentId, stdout: string, stderr: string, code: number | null): LocalAgentError {
  const label = agent === "claude" ? "Claude Code" : "CodeBuddy";
  const command = agent === "claude" ? "claude" : "codebuddy";
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
  if (agent !== "claude" && agent !== "codebuddy") throw new LocalAgentError("unsupported_cli", `尚未安全接通本机 Agent:${agent}`);
  const label = agent === "claude" ? "Claude Code" : "CodeBuddy";
  const command = agent === "claude" ? "claude" : "codebuddy";
  if (opts.signal?.aborted) throw new LocalAgentError("agent_cancelled", `${label} 请求已取消`);
  if (activeLocalAgents >= MAX_ACTIVE_LOCAL_AGENTS) {
    throw new LocalAgentError("agent_busy", `本机 Agent 已有 ${MAX_ACTIVE_LOCAL_AGENTS} 个任务在运行，请稍后再试`);
  }
  const baseEnv = opts.env ?? process.env;
  const input = localAgentInput(agent, opts.userPrompt, opts.userImages);
  const bin = findExecutable(command, baseEnv);
  if (!bin) throw new LocalAgentError("agent_not_installed", `本机未安装 ${label}`);
  // CodeBuddy 能力与登录探针是异步的；先占槽位，避免多个请求同时通过上面的容量检查。
  activeLocalAgents += 1;
  let codeBuddyRuntime: CodeBuddyRuntime | null = null;
  if (agent === "codebuddy") {
    try {
      codeBuddyRuntime = (await inspectCodeBuddy(bin, baseEnv)).runtime;
    } catch (error) {
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      if (error instanceof LocalAgentError) throw error;
      throw new LocalAgentError("agent_probe_failed", "CodeBuddy 登录状态检测失败");
    }
    if (!codeBuddyRuntime.account) {
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      throw new LocalAgentError("agent_not_authenticated", "CodeBuddy 登录已失效，请先运行 codebuddy 并完成登录");
    }
  }

  const timeoutMs = normalizeLocalAgentTimeoutMs(opts.timeoutMs);
  const maxOut = 4 * 1024 * 1024;
  const maxErr = 64 * 1024;
  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vra-${agent}-`));
  } catch (error) {
    activeLocalAgents = Math.max(0, activeLocalAgents - 1);
    throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    const runEnv = agent === "claude"
      ? subscriptionEnv(baseEnv)
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
      : codeBuddyArgs(opts.systemPrompt, opts.outputSchema, codeBuddyRuntime!.legacyEphemeralHome, opts.controlledMcp);
    if (opts.userImages?.length) args.push("--input-format", "stream-json");
    const launch = executableInvocation(bin, args, runEnv);
    const child = spawn(launch.file, launch.args, {
      cwd: tmpDir,
      env: runEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX 下创建独立进程组。本机 Agent CLI 可能继续派生 node / shell 子进程；
      // 只杀直接 child 会让后代留在后台继续消耗订阅额度。
      detached: process.platform !== "win32",
    });
    trackLocalAgentProcess(child);
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let settled = false;
    let terminationError: LocalAgentError | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let killFallbackTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      untrackLocalAgentProcess(child);
      cleanup();
      fn();
    };
    let closed = false;
    let treeSignalled = false;
    const signalTree = (signal: NodeJS.Signals) => {
      treeSignalled = signalProcessTree(child, signal) || treeSignalled;
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
        killFallbackTimer.unref();
      }, 2_000);
      hardKillTimer.unref();
    };
    const onAbort = () => {
      terminate(new LocalAgentError("agent_cancelled", `${label} 请求已取消`));
    };
    const timer = setTimeout(() => {
      terminate(new LocalAgentError("agent_timeout", `${label} 超时（>${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return onAbort();
    child.stdin.on("error", () => { /* 提前退出时的 EPIPE 由 close 统一处理 */ });
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        terminate(new LocalAgentError("agent_output_too_large", `${label} 输出超出上限，已终止`));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < maxErr) stderr += chunk.toString("utf8");
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
      if (code !== 0) return finish(() => reject(failureMessage(agent, stdout, stderr, code)));
      finish(() => {
        try {
          resolve(agent === "claude" ? parseClaudeOutput(stdout) : parseCodeBuddyOutput(stdout));
        } catch (error) {
          // CodeBuddy 2.143.1 在未登录时会以 exit 0 输出一行纯文本，而不是 JSON。
          // 只有解析已经失败时才把已知的登录 / 限流诊断升级为受控错误，避免误读正常模型回答。
          const classified = failureMessage(agent, stdout, stderr, code);
          reject(classified.code === "agent_failed" ? error : classified);
        }
      });
    });
    child.stdin.end(input, "utf8");
  });
}
