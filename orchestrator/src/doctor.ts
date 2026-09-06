#!/usr/bin/env node
/**
 * 体检(开发方案 v2.1 §5 / scripts/doctor):一次性检查"这台机器能不能跑研究",每项给 ok / warn / fail / skip + 中文修复提示;
 * 只读(除了写一份报告到 <data_root>/doctor/<时间>.json 和一个写权限探针文件;--net 会把那次取数的信封与 raw 写到 <data_root>/mcp/doctor/),**不读写用户全局 ~/.codex**,不联网(除非 --net)。
 * 报告里的路径以 <repo> 相对化、子进程输出经 redact 脱敏;数据根必须在产品根 realpath 之内且不是符号链接(同 init)。
 * 检查项:node 版本 · 产品配置链 · 引擎二进制(SDK 捆绑或 engine.codex_path;版本对照 codex-version.json)· 全局 codex CLI(login / mcp add 用)
 *        · 产品 CODEX_HOME 登录态(或 api_key 模式的环境变量)· 宪法 AGENTS.md · skills 可发现性 · Python 与取数依赖 · calc 自检 · 注册表与目录
 *        · 数据根写权限 · .gitignore 含 .local/ · 密钥扫描(产品文件,测试目录除外)· api.token 权限 · [--net] 数据源连通(取一个端点)
 * 退出码:0 全部 ok / 2 只有 warn / 3 有 fail。用法:node orchestrator/src/doctor.ts [--net] [--json] [--python P](--net 取注册表端点 tx_quote 一次)
 */
import { currentPlugin } from "./plugin.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { NOFOLLOW_FLAG, nowIso, privateFilePermissions, readJsonIfExists, sha256File, writeJson } from "./fsutil.ts";
import { assertDataRootInside, detectPython, gitignoreCovers, resolveDataRoot } from "./init.ts";
import { loadProductConfig, type LoadedProductConfig } from "./productConfig.ts";
import { parseArgs } from "./run.ts";
import { fetchEndpoint, redact, repoRootFromHere, safePath, serviceContext } from "./service.ts";
import { SKILLS_MAX_SCAN_DEPTH, installCommandFor, listForeignSkillPaths, resolveHomeDir, skillsIsolationStatus } from "./skills_isolation.ts";
import { preflightInstructions } from "./instructions_root.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export interface Check { id: string; title: string; status: CheckStatus; detail: string; fix?: string }
export interface ExecResult { status: number | null; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number }) => ExecResult;
export interface DoctorResult { generated_at: string; repoRoot: string; dataRoot: string; checks: Check[]; tally: Record<CheckStatus, number>; exit_code: 0 | 2 | 3; report: string | null }

const MIN_NODE = [22, 18] as const;
const REQUIRED_SKILLS = ["data-access", "company-research"];
const PY_IMPORTS = "requests, pandas, lxml, akshare, baostock, mootdx.quotes";
const NET_PROBE_ENDPOINT = "tx_quote";
/**
 * 不扫的目录。
 * 🔴 `payload` / `release` 是**桌面外壳的构建产物**(装配好的载荷、打好的 App)。
 *    它们里面是三万多个文件(整棵 Python + 引擎二进制),不排掉就会把 SCAN_MAX_FILES 的
 *    额度吃光 —— 表现是"密钥扫描 warn:文件数超过 5000,已截断未全扫",**真正的源码反而没扫到**。
 *    ⚠️ 跳过它们不降低覆盖:`payload/app` 是按清单从仓库源文件拷过去的副本,原件本来就在扫描范围内;
 *    另外两块(Python 依赖、引擎二进制)是第三方产物,不是我们的产品文件。
 */
const SCAN_SKIP_DIRS = new Set([".local", "node_modules", ".venv", ".git", "assets", "__pycache__", ".pytest_cache", "test", "tests", "dist", "htmlcov", "payload", "release"]);
const SCAN_SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".ico", ".woff", ".woff2", ".zip", ".gz", ".lock"]);
const SCAN_MAX_BYTES = 2 * 1024 * 1024;
const SCAN_MAX_FILES = 5000;
/** 高置信形态:任何目录(含测试目录)都查 */
const SECRET_PATTERNS_STRICT: { name: string; re: RegExp }[] = [
  { name: "PEM 私钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: "Slack token", re: /\b(xox[abper]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];
/** 普通形态:测试目录跳过(测试夹具常放假密钥) */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "sk-… 形态密钥", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Bearer token", re: /bearer\s+[A-Za-z0-9._-]{20,}/i },
  // 字面赋值:只认 api_key / secret / password(token 太泛,测试约定词会误报),值 ≥ 20 位且同时含字母与数字
  { name: "api_key/secret/password 字面赋值", re: /\b(api[_-]?key|secret|password)\b\s*[:=]\s*["'](?=[^"']*[A-Za-z])(?=[^"']*\d)[A-Za-z0-9_\-./+]{20,}["']/i },
];
const TEST_DIRS = new Set(["test", "tests"]);

const TRIPLES: Record<string, string> = { "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "android-x64": "x86_64-unknown-linux-musl", "android-arm64": "aarch64-unknown-linux-musl", "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };
const PLATFORM_PKG: Record<string, string> = { "x86_64-unknown-linux-musl": "@openai/codex-linux-x64", "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64", "x86_64-apple-darwin": "@openai/codex-darwin-x64", "aarch64-apple-darwin": "@openai/codex-darwin-arm64", "x86_64-pc-windows-msvc": "@openai/codex-win32-x64", "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64" };

/** 子进程最小环境:基础 + 代理 + 证书(不透传任何密钥类变量);需要的变量(CODEX_HOME)由调用处显式加 */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) if (base[k]) out[k] = base[k] as string;
  return out;
}

export const defaultExec: Exec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: opts.env ?? minimalEnv(), cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? ` ${r.error.message}` : "") };
};

/** 复刻 SDK 的引擎定位(@openai/codex → 平台包 vendor/<triple>/bin/codex,旧布局 codex/codex);找不到 → null + 原因 */
export function resolveBundledCodex(repoRoot: string): { path: string | null; detail: string } {
  const triple = TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) return { path: null, detail: `不支持的平台 ${process.platform}/${process.arch}` };
  try {
    const req = createRequire(path.join(repoRoot, "orchestrator", "package.json"));
    const codexPkgJson = req.resolve("@openai/codex/package.json");
    const platJson = createRequire(codexPkgJson).resolve(`${PLATFORM_PKG[triple]}/package.json`);
    const vendor = path.join(path.dirname(platJson), "vendor", triple);
    const bin = process.platform === "win32" ? "codex.exe" : "codex";
    const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    // 与 SDK 同口径:新布局 bin/codex 必须伴随 codex-package.json;旧布局 codex/codex
    const modern = path.join(vendor, "bin", bin);
    if (isFile(modern) && isFile(path.join(vendor, "codex-package.json"))) return { path: modern, detail: modern };
    const legacy = path.join(vendor, "codex", bin);
    if (isFile(legacy)) return { path: legacy, detail: legacy };
    return { path: null, detail: `平台包 ${PLATFORM_PKG[triple]} 里没有 codex 二进制(${vendor})` };
  } catch (e) {
    return { path: null, detail: `未找到 @openai/codex 平台包(${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
  }
}

/** "codex-cli 0.149.0" → [0,149,0];解析不到 → null。预发布后缀(0.150.0-alpha.1)由 isPrerelease 单独判 */
export function parseCodexVersion(s: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function isPrerelease(s: string): boolean { return /\d+\.\d+\.\d+-[0-9A-Za-z.]+/.test(s); }
export function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** 遍历产品文件(跳过 .local / node_modules / .venv / 二进制 / 符号链接);测试目录单独标记;最多 SCAN_MAX_FILES 个(超出 → truncated=true,不静默) */
function walkFiles(root: string): { files: { p: string; inTest: boolean }[]; truncated: boolean } {
  const out: { p: string; inTest: boolean }[] = [];
  let truncated = false;
  const rec = (dir: string, inTest: boolean) => {
    if (truncated) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= SCAN_MAX_FILES) { truncated = true; return; }
      if (ent.isSymbolicLink()) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (TEST_DIRS.has(ent.name)) rec(p, true); else if (!SCAN_SKIP_DIRS.has(ent.name)) rec(p, inTest); }
      else if (ent.isFile() && !SCAN_SKIP_EXT.has(path.extname(ent.name).toLowerCase())) out.push({ p, inTest });
    }
  };
  rec(root, false);
  return { files: out, truncated };
}

/** 密钥扫描:高置信形态(PEM / AWS / GitHub / Slack / JWT)全树查;sk-… / Bearer / 字面赋值 / 当前环境密钥值只查非测试目录 */
export function scanSecrets(repoRoot: string, env: NodeJS.ProcessEnv): { hits: { file: string; line: number; what: string }[]; scanned: number; truncated: boolean } {
  const envVals = Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && typeof v === "string" && v.length >= 16).map(([k, v]) => ({ k, v: v as string }));
  const hits: { file: string; line: number; what: string }[] = [];
  const { files, truncated } = walkFiles(repoRoot);
  for (const { p: f, inTest } of files) {
    let text: string;
    try { if (fs.statSync(f).size > SCAN_MAX_BYTES) continue; text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const rel = path.relative(repoRoot, f);
    text.split("\n").forEach((l, i) => {
      for (const pat of SECRET_PATTERNS_STRICT) if (pat.re.test(l)) hits.push({ file: rel, line: i + 1, what: pat.name });
      if (inTest) return;
      for (const pat of SECRET_PATTERNS) if (pat.re.test(l)) hits.push({ file: rel, line: i + 1, what: pat.name });
      for (const { k, v } of envVals) if (l.includes(v)) hits.push({ file: rel, line: i + 1, what: `环境变量 ${k} 的值` });
    });
  }
  return { hits, scanned: files.length, truncated };
}


/** 探测这几个取数主机是否被代理接管(解析到保留网段) */
const PROXY_PROBE_HOSTS = ["www.swsresearch.com", "push2delay.eastmoney.com", "qt.gtimg.cn"];

/**
 * 域名是否被解析到「不可能是公网服务器」的保留网段 —— fake-IP 代理的典型特征。
 * 198.18.0.0/15 是 RFC 2544 基准测试段(Clash 默认用它);其余按 RFC 1918 / 环回 / 链路本地判。
 * ⚠️ 只用**同步**的 DNS 缓存查询,拿不到就当没检测到 —— doctor 不该因为一次 DNS 卡住而卡住。
 */
function probeFakeIp(hosts: readonly string[]): string[] {
  const hit: string[] = [];
  for (const h of hosts) {
    let ips: string[] = [];
    try {
      // lookup 是异步 API;这里用 spawnSync 调系统解析器,避免把 runDoctor 变成依赖网络的慢函数
      if (process.platform === "darwin") {
        const r = spawnSync("dscacheutil", ["-q", "host", "-a", "name", h], { encoding: "utf8", timeout: 3_000 });
        ips = [...(r.stdout || "").matchAll(/ip_address:\s*([0-9.]+)/g)].map((m) => m[1] as string);
      } else if (process.platform === "win32") {
        const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Resolve-DnsName -Type A '${h}' -ErrorAction SilentlyContinue).IPAddress`], { encoding: "utf8", timeout: 3_000, windowsHide: true });
        ips = (r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter((x) => /^\d+(?:\.\d+){3}$/.test(x));
      } else {
        const r = spawnSync("getent", ["ahostsv4", h], { encoding: "utf8", timeout: 3_000 });
        ips = [...(r.stdout || "").matchAll(/^(\d+(?:\.\d+){3})\s/gm)].map((m) => m[1] as string);
      }
    } catch { /* 解析不了就跳过这个主机 */ }
    if (ips.some(isReservedIp)) hit.push(h);
  }
  return hit;
}

function isReservedIp(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return a === 198 && (b === 18 || b === 19); // RFC 2544:fake-IP 代理最常用
}

export async function runDoctor(opts: { repoRoot?: string; env?: NodeJS.ProcessEnv; exec?: Exec; net?: boolean; python?: string; writeReport?: boolean } = {}): Promise<DoctorResult> {
  const repoRoot = path.resolve(opts.repoRoot ?? repoRootFromHere());
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const checks: Check[] = [];
  const add = (c: Check) => { checks.push(c); return c; };
  const SUB_MAX = 160;  // 子进程输出进 detail 的最长截断(并经 redact)
  const sub = (x: string) => redact(x.trim().replace(/\s+/g, " "), SUB_MAX);

  // 1. node
  const nv = process.versions.node.split(".").map(Number);
  add({ id: "node", title: "Node.js 版本", status: cmpVersion(nv, [...MIN_NODE]) >= 0 ? "ok" : "fail", detail: `v${process.versions.node}(需 ≥ ${MIN_NODE.join(".")},直接运行 .ts)`, fix: "安装 Node 24 LTS(或 ≥ 22.18)" });

  // 2. 产品配置链
  let pc: LoadedProductConfig | null = null;
  // 🔴 宽松模式:缺密钥**单独报一条**,不让它把配置链整条判死 ——
  //    否则后面所有靠 pc 的检查(Python、CODEX_HOME、skills 隔离)都会跟着 skip 或**报出假原因**
  //    (实测:配了 MiMo 还没导 key 时,体检说"未找到 Python",而 Python 明明配着)。
  try {
    pc = loadProductConfig(repoRoot, { env, requireAuth: false });
    add({ id: "config", title: "产品配置链", status: "ok", detail: `来源:${pc.sources.join(" ← ")};provider=${pc.provider.name}/${pc.provider.auth}` });
    if (pc.authError) {
      add({ id: "provider_key", title: "模型密钥", status: "fail", detail: `${pc.authError}。先 export 再跑研究;其余检查不受此影响。` });
    }
  }
  catch (e) { add({ id: "config", title: "产品配置链", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: "检查 .local/config.json / 环境变量 VRA_* / provider 密钥变量;或先 node orchestrator/src/init.ts" }); }
  const dataRoot = pc?.resolved.dataRoot ?? resolveDataRoot(repoRoot);
  const codexHome = pc?.resolved.codexHome ?? path.join(dataRoot, "codex-home");
  // 数据根边界(同 init):不在产品根 realpath 内或是符号链接 → 直接 fail 并且后续不再往里写任何东西。
  // ⚠️ 与上面的「指令发现链」不同:那条支持分离安装,这条是 init / doctor 面向仓库内布局的策略(见 init.ts)。
  let dataRootOk = true;
  try { assertDataRootInside(repoRoot, dataRoot); } catch (e) { dataRootOk = false; add({ id: "data_root_boundary", title: "数据根边界", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: "把 .local 改回产品根内的普通目录(不要用符号链接指向仓库外)" }); }

  // 3. 引擎二进制 + 版本锚定
  const anchor = readJsonIfExists<{ codex_cli?: { min_tested?: string; max_tested?: string } }>(path.join(repoRoot, "codex-version.json"));
  const bundled = pc?.resolved.codexPath ? { path: pc.resolved.codexPath, detail: `engine.codex_path=${pc.resolved.codexPath}` } : resolveBundledCodex(repoRoot);
  let engineVersion: number[] | null = null;
  if (!bundled.path) add({ id: "engine", title: "Codex 引擎二进制", status: "fail", detail: bundled.detail, fix: "cd orchestrator && npm install(SDK 会带平台包);或在配置 engine.codex_path 指向官方 codex 二进制" });
  else {
    const r = exec(bundled.path, ["--version"], { timeoutMs: 20_000 });
    engineVersion = r.status === 0 ? parseCodexVersion(r.stdout + r.stderr) : null;
    if (!engineVersion) add({ id: "engine", title: "Codex 引擎二进制", status: "fail", detail: `${bundled.detail} 无法执行 --version(exit=${r.status};${sub(r.stderr || r.stdout)})`, fix: "重新 npm install;macOS 可能需要放行二进制" });
    else {
      const min = anchor?.codex_cli?.min_tested ? parseCodexVersion(anchor.codex_cli.min_tested) : null, max = anchor?.codex_cli?.max_tested ? parseCodexVersion(anchor.codex_cli.max_tested) : null;
      const pre = isPrerelease(r.stdout + r.stderr);
      const inRange = !pre && (!min || cmpVersion(engineVersion, min) >= 0) && (!max || cmpVersion(engineVersion, max) <= 0);
      add({ id: "engine", title: "Codex 引擎二进制", status: inRange ? "ok" : "warn", detail: `${bundled.path} → ${engineVersion.join(".")}${pre ? "(预发布版)" : ""}(已测区间 ${anchor?.codex_cli?.min_tested ?? "?"}–${anchor?.codex_cli?.max_tested ?? "?"})`, fix: inRange ? undefined : "版本不在已测区间(或为预发布版):先跑 orchestrator 测试与一次研究运行确认,再更新 codex-version.json" });
    }
  }

  // 4. 全局 codex CLI(login / mcp add 用;非必需)
  { const r = exec("codex", ["--version"], { timeoutMs: 20_000 }); const v = r.status === 0 ? parseCodexVersion(r.stdout + r.stderr) : null;
    add({ id: "codex_cli", title: "全局 codex CLI", status: v ? "ok" : "warn", detail: v ? `codex ${v.join(".")}` : "PATH 上没有 codex(只影响 codex login / codex mcp add 的便利;研究运行用 SDK 捆绑引擎)", fix: v ? undefined : "npm install -g @openai/codex@0.149.0" }); }

  // 5. 产品 CODEX_HOME 与鉴权(配置链失败时不能确定模式 → skip,避免用默认值给出误导结论)
  if (!pc) add({ id: "auth", title: "产品 CODEX_HOME / 鉴权", status: "skip", detail: "产品配置链未通过,无法确定鉴权模式(先修上面的配置问题)" });
  else if (!fs.existsSync(codexHome)) add({ id: "auth", title: "产品 CODEX_HOME / 鉴权", status: "warn", detail: `${codexHome} 不存在(尚未初始化)`, fix: "node orchestrator/src/init.ts 后:CODEX_HOME=<上述目录> codex login" });
  else if (pc?.provider.auth === "api_key") add({ id: "auth", title: "产品 CODEX_HOME / 鉴权", status: env[pc.provider.env_key] ? "ok" : "fail", detail: `api_key 模式:环境变量 ${pc.provider.env_key} ${env[pc.provider.env_key] ? "已设置" : "未设置"}`, fix: env[pc.provider.env_key] ? undefined : `export ${pc.provider.env_key}=...(密钥只从环境变量读)` });
  else if (bundled.path) {
    const r = exec(bundled.path, ["login", "status"], { env: { ...minimalEnv(env), CODEX_HOME: codexHome }, timeoutMs: 30_000 });
    const txt = (r.stdout + r.stderr).trim();
    const loggedIn = r.status === 0 && /logged in/i.test(txt) && !/not logged in/i.test(txt);
    add({ id: "auth", title: "产品 CODEX_HOME / 鉴权", status: loggedIn ? "ok" : "warn", detail: `${codexHome}:${sub(txt.split("\n")[0]) || "(无输出)"}`, fix: loggedIn ? undefined : `CODEX_HOME="${codexHome}" codex login(ChatGPT 订阅);或改 api_key 模式并 export OPENAI_API_KEY` });
  } else add({ id: "auth", title: "产品 CODEX_HOME / 鉴权", status: "skip", detail: "引擎不可用,无法查询登录态" });

  // 6. 宪法
  const agents = path.join(repoRoot, "AGENTS.md");
  add(fs.existsSync(agents) ? { id: "constitution", title: "宪法 AGENTS.md", status: "ok", detail: `sha256 ${sha256File(agents).slice(0, 12)}…` } : { id: "constitution", title: "宪法 AGENTS.md", status: "fail", detail: "产品根缺少 AGENTS.md(Codex 自动加载的项目指令)", fix: "恢复仓库文件" });

  // 7. skills 可发现性
  const skillsDir = path.join(repoRoot, ".agents", "skills");
  const found = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md"))) : [];
  const missing = REQUIRED_SKILLS.filter((s) => !found.includes(s));
  add({ id: "skills", title: "skills 可发现性(.agents/skills/<名>/SKILL.md)", status: missing.length ? "fail" : fs.existsSync(path.join(repoRoot, "skills")) ? "warn" : "ok", detail: `${found.length} 个:${found.join(", ") || "(无)"}${missing.length ? `;缺 ${missing.join(", ")}` : ""}${fs.existsSync(path.join(repoRoot, "skills")) ? ";根目录存在 skills/(Codex 不会加载该路径)" : ""}`, fix: missing.length ? "恢复 .agents/skills/" : undefined });

  // 7a2. 指令发现链(instructions_root.ts):引擎只收集 project root → cwd 之间的 AGENTS.md 与 .agents/skills。
  //      失效是**静默**的:不报错,只是宪法与技能不在提示词里,报告照样产出 —— 所以这条必须体检。
  if (!pc || !codexHome) add({ id: "instructions_root", title: "指令发现链(宪法 / 项目技能)", status: "skip", detail: "产品配置不可用,无法定位 CODEX_HOME" });
  else {
    const probeRun = path.join(dataRoot, "runs", "__doctor__");
    const pre = preflightInstructions({ repoRoot, dataRoot, runDir: probeRun, codexHome });
    add({
      id: "instructions_root", title: "指令发现链(宪法 / 项目技能)",
      status: pre.problems.length ? "fail" : "ok",
      detail: pre.problems.length
        ? pre.problems.map((x) => sub(x)).join(" / ")
        : `指令根 ${sub(pre.root)}(${pre.mode === "product" ? "产品根" : "数据根,指令资产已同步"});链上 ${pre.chain.length} 层无多余宪法 / 技能`,
      fix: pre.problems.length ? "scripts/init(幂等)会补 marker 与 project_root_markers;链上多余的 AGENTS.md / AGENTS.override.md / .agents/skills 需手动删除" : undefined,
    });
  }

  // 7b. 用户级 / 捆绑 skills 隔离(Codex 还会从 ~/.agents/skills 与 $CODEX_HOME/skills/.system 发现 skill,与 CODEX_HOME 无关;编排器每次运行开始时写禁用块,这里只读报告)
  if (!pc || !codexHome) add({ id: "skills_isolation", title: "用户级 / 捆绑 skills 隔离", status: "skip", detail: "产品配置不可用,无法定位 CODEX_HOME" });
  else {
    // 主目录按 resolveHomeDir(env)(与 Codex dirs::home_dir() + 绝对路径检查同语义;测试可注入 HOME);枚举失败(权限 / I/O)直接 fail
    let foreign: string[] | null = null, enumErr = "";
    try { foreign = listForeignSkillPaths({ codexHome, homeDir: resolveHomeDir(env), productRoots: [repoRoot] }); } catch (e) { enumErr = e instanceof Error ? e.message : String(e); }
    const tomlPath = path.join(codexHome, "config.toml");
    const st = skillsIsolationStatus(fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "", foreign ?? []);
    // 无隔离块一律 warn(即使当前没有用户级 skill,捆绑系统 skills 仍会进 catalog);有块但未完整生效也 warn
    const status: CheckStatus = foreign === null ? "fail" : st.covered ? "ok" : "warn";
    const fixCmd = `scripts/init(幂等)或 ${installCommandFor(repoRoot, codexHome)};每次研究运行开始时也会自动刷新`;
    add({
      id: "skills_isolation", title: "用户级 / 捆绑 skills 隔离",
      status,
      detail: foreign === null ? `枚举用户级 skill 失败:${sub(enumErr)}` :
        `用户级 skill ${foreign.length} 个(~/.agents/skills 与 $CODEX_HOME/skills,递归 ≤ ${SKILLS_MAX_SCAN_DEPTH} 层);隔离块${st.hasBlock ? `已写(禁用 ${st.disabled.length} 个;捆绑 skills ${st.bundledDisabled ? "已关" : "未关"};max_context_tokens=${st.maxContextTokens ?? "未设或非法"})` : "未写"}${st.missing.length ? `;未覆盖 ${st.missing.length} 个` : ""}${st.malformed.length ? `;块内 ${st.malformed.length} 条不是 enabled = false(被手改?)` : ""}`,
      fix: status === "ok" ? undefined : status === "fail" ? "修复该目录的读取权限后重跑;或临时移走无法读取的 skill 目录" : fixCmd,
    });
  }

  // 8. Python 与取数依赖
  const python = opts.python ?? pc?.python ?? detectPython(repoRoot);
  let pyOk = false;
  if (!python) add({ id: "python", title: "Python 与取数依赖", status: "fail", detail: "未找到 Python(配置 python 为空且无 .venv)", fix: process.platform === "win32" ? "py -3.12 -m venv .venv; .\\.venv\\Scripts\\python.exe -m pip install -r .agents\\skills\\data-access\\scripts\\requirements.txt" : "python3 -m venv .venv && .venv/bin/pip install -r .agents/skills/data-access/scripts/requirements.txt;或在 .local/config.json 填 python" });
  else {
    const r = exec(python, ["-c", `import sys, ${PY_IMPORTS}; print(sys.version.split()[0])`], { timeoutMs: 60_000 });
    const ver = r.status === 0 ? r.stdout.trim() : "";
    const importsOk = r.status === 0;
    const vnum = ver ? ver.split(".").map(Number) : null;
    const versionOk = Boolean(vnum && cmpVersion(vnum, [3, 11]) >= 0);
    pyOk = importsOk && versionOk;
    const detail = !importsOk
      ? `${python} 导入失败:${sub((r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? "")}`
      : !versionOk
        ? `${python} → ${ver};受控配置隔离需要 Python ≥ 3.11(tomllib 标准库)`
        : `${python} → ${ver}(${PY_IMPORTS} 可导入)`;
    const fix = !importsOk
      ? `${python} -m pip install -r .agents/skills/data-access/scripts/requirements.txt`
      : !versionOk
        ? "安装 Python 3.12 并重建 .venv，再重新运行初始化"
        : undefined;
    add({ id: "python", title: "Python 与取数依赖", status: pyOk ? "ok" : "fail", detail, fix });
  }

  // 9. calc 自检
  const selfTest = currentPlugin().selfTestCalc;
  if (python && pyOk && selfTest) {
    // 自检用哪个计算、期望值多少,**由插件提供** —— Core 只负责"跑一次、比一下";
    // 垂类没有确定性计算库时 selfTestCalc 为 null,这一项直接跳过(不是错)
    const st = selfTest;
    const r = exec(python, [path.join(repoRoot, "calc", "cli.py"), st.fn, "--args", JSON.stringify(st.args)], { cwd: repoRoot, timeoutMs: 60_000 });
    let ok = false, detail = "";
    try { const j = JSON.parse(r.stdout) as { output?: { status?: string; value?: number }; calc_version?: string }; ok = j.output?.status === "ok" && j.output?.value === st.expect; detail = `calc ${j.calc_version ?? "?"}:${st.fn} → ${j.output?.value}(期望 ${st.expect})`; } catch { detail = `calc CLI 输出不可解析(exit=${r.status};${sub(r.stderr || r.stdout)})`; }
    add({ id: "calc", title: "calc 自检", status: ok ? "ok" : "fail", detail, fix: ok ? undefined : "检查 calc/ 完整性:python -m pytest calc/tests -q" });
  } else add({ id: "calc", title: "calc 自检", status: "skip", detail: "Python 不可用" });

  // 10. 注册表与目录
  const reg = readJsonIfExists<{ version?: string; endpoints?: unknown[] }>(path.join(repoRoot, "datasources", "registry.json"));
  add(reg?.endpoints ? { id: "registry", title: "数据源注册表", status: fs.existsSync(path.join(repoRoot, "datasources", "CATALOG.md")) ? "ok" : "warn", detail: `registry ${reg.version ?? "?"},${reg.endpoints.length} 个端点${fs.existsSync(path.join(repoRoot, "datasources", "CATALOG.md")) ? "" : ";CATALOG.md 缺失"}`, fix: fs.existsSync(path.join(repoRoot, "datasources", "CATALOG.md")) ? undefined : "python datasources/gen_catalog.py" } : { id: "registry", title: "数据源注册表", status: "fail", detail: "datasources/registry.json 缺失或无 endpoints", fix: "恢复仓库文件" });

  // 11. 数据根写权限(边界不通过时不探针;探针路径经 safePath 逐级禁符号链接,O_EXCL|O_NOFOLLOW 创建——叶子是符号链接也不会写出去)
  if (!dataRootOk) add({ id: "data_root", title: "数据根写权限", status: "skip", detail: "数据根边界未通过,不写探针" });
  else {
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
      const probe = safePath({ dataRoot }, `.doctor-write-${process.pid}`);
      const fd = fs.openSync(probe, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG, 0o600);
      try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); fs.unlinkSync(probe); }
      add({ id: "data_root", title: "数据根写权限", status: "ok", detail: dataRoot });
    } catch (e) { add({ id: "data_root", title: "数据根写权限", status: "fail", detail: `${dataRoot}:${e instanceof Error ? e.message : String(e)}`, fix: "检查目录权限;数据根内不得有符号链接" }); }
  }

  // 11.5 垂类自己的体检项:由插件贡献,Core 只负责并进报告(原本这里直接 import 金融的温度计模块)
  if (!dataRootOk) add({ id: "plugin_checks", title: "垂类体检项", status: "skip", detail: "数据根边界未通过" });
  else {
    try {
      for (const c of currentPlugin().doctorChecks?.({ dataRoot, repoRoot }) ?? []) add(c as never);
    } catch (e) { add({ id: "plugin_checks", title: "垂类体检项", status: "warn", detail: sub(e instanceof Error ? e.message : String(e)) }); }
  }

  // 12. .gitignore
  const gi = path.join(repoRoot, ".gitignore");
  const relLocal = path.relative(repoRoot, dataRoot).split(path.sep).join("/") + "/";
  const giOk = fs.existsSync(gi) && gitignoreCovers(fs.readFileSync(gi, "utf8"), relLocal);
  add({ id: "gitignore", title: ".gitignore 含用户私有层", status: giOk ? "ok" : "fail", detail: giOk ? `${relLocal} 已忽略` : `${relLocal} 未在 .gitignore(用户私有数据可能被提交)`, fix: giOk ? undefined : "node orchestrator/src/init.ts 会追加;或手动加一行 .local/" });

  // 13. 密钥扫描
  const scan = scanSecrets(repoRoot, env);
  const hits = scan.hits;
  add({ id: "secrets", title: "密钥扫描(产品文件)", status: hits.length ? "fail" : scan.truncated ? "warn" : "ok", detail: (hits.length ? hits.slice(0, 5).map((h) => `${h.file}:${h.line} ${h.what}`).join(";") + (hits.length > 5 ? ` …共 ${hits.length}` : "") : `扫描 ${scan.scanned} 个文件,未发现 PEM / AWS / GitHub / Slack / JWT / sk-… / Bearer / 字面赋值 / 环境密钥值(测试目录只查高置信形态;.local 与 node_modules 不扫)`) + (scan.truncated ? `;文件数超过 ${SCAN_MAX_FILES},已截断未全扫` : ""), fix: hits.length ? "把密钥移到环境变量;轮换已泄露的密钥" : scan.truncated ? "仓库过大,缩小范围后再扫或用专门工具" : undefined });

  // 13.5 代理拦截检测
  // 🔴 为什么值得单开一项:国内用户装代理是常态,而**代理是取数失败的头号根因**,
  //    症状却是五花八门的 TLS / 超时 / 空响应 —— 用户根本猜不到是代理。
  //    实测本机:所有取数主机都解析到 198.18.x.x(RFC 2544 基准段 = Clash 这类的 fake-IP),
  //    某个域名 50% 概率握手失败,而错误消息只会建议"关掉证书校验" —— 那是拿安全换环境问题。
  //    ⇒ 这里只**如实报告**,不替用户决定关不关代理(很多人必须挂着才能上网)。
  {
    const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
      .filter((k) => (env[k] ?? "").trim() !== "");
    // fake-IP:代理把域名解析到保留网段,真实 IP 由代理内部持有
    const fake = probeFakeIp(PROXY_PROBE_HOSTS);
    const on = proxyVars.length > 0 || fake.length > 0;
    add({
      // ⚠️ 有代理**不算故障**,所以是 ok 不是 warn:国内用户常年挂代理、很多是必须挂,
      //    永久黄字只会把 doctor 训练成"总有警告,忽略它"。这一项的价值是**取数出问题时的第一条线索**,
      //    detail 写清楚就够了,不该抬高退出码。
      id: "net_proxy", title: "代理拦截", status: "ok",
      detail: on
        ? `检测到本机流量可能经代理(${proxyVars.length ? `环境变量 ${proxyVars.join(" / ")}` : "无 *_proxy 变量"}` +
          `${fake.length ? `;${fake.join("、")} 解析到保留网段 fake-IP` : ""})。` +
          "取数失败(TLS 校验失败 / 超时 / 空响应)时**先查这里**,不要直接关掉证书校验。"
        : "未发现代理迹象(无 *_proxy 变量;探测主机解析到公网地址)",
      fix: on ? "取数异常时先临时关代理复测;确认是代理规则问题就改规则,别用 VRA_ALLOW_INSECURE_TLS 绕" : undefined,
    });
  }

  // 14. api.token 权限
  const tok = path.join(dataRoot, "api.token");
  if (fs.existsSync(tok)) {
    const permission = privateFilePermissions(tok);
    add({ id: "api_token", title: ".local/api.token 权限", status: permission.secure ? "ok" : "warn", detail: permission.detail,
      fix: permission.secure ? undefined : (process.platform === "win32" ? "重启 API，产品会断开 ACL 继承并只授权当前 Windows 用户" : `chmod 600 ${tok}`) });
  }
  else add({ id: "api_token", title: ".local/api.token 权限", status: "skip", detail: "尚未生成(首次起 HTTP API 时自动生成)" });

  // 15. 数据源连通(可选;会把取数信封与 raw 写到 <data_root>/mcp/doctor/)
  if (!opts.net) add({ id: "net", title: "数据源连通", status: "skip", detail: "未指定 --net(会真实访问一个行情端点,结果写 .local/mcp/doctor/)" });
  else if (!python || !pyOk || !dataRootOk) add({ id: "net", title: "数据源连通", status: "skip", detail: !dataRootOk ? "数据根边界未通过" : "Python 不可用" });
  else {
    try {
      const ctx = serviceContext({ repoRoot, python, env });
      // 用注册表里的零鉴权行情端点 tx_quote(腾讯)探一次;legacy 脚本端点不经 fetch_endpoint.py,不能用在这里
      // 🔴 **必须 fresh**:探针要回答的是"此刻能不能连上",读快照会把历史上的一次成功
      //    报成"当前网络健康" —— 一条彻头彻尾的假诊断(Codex 架构评审 arch-r1 §A)。
      const r = await fetchEndpoint(ctx, { endpoint: NET_PROBE_ENDPOINT, symbol: "300308", session: "doctor", timeout_ms: 60_000, consistency: { mode: "fresh" } });
      const st = String(r.envelope.status ?? "?");
      const err = Array.isArray(r.envelope.errors) && r.envelope.errors.length ? String((r.envelope.errors[0] as { message?: string })?.message ?? "").slice(0, 120) : "";
      add({ id: "net", title: "数据源连通", status: st === "ok" || st === "partial" ? "ok" : "warn", detail: `${NET_PROBE_ENDPOINT} 300308 → ${st}(${Math.round(r.duration_ms / 1000)}s${err ? `;${err}` : ""};结果只反映此刻网络与源状态)`, fix: st === "ok" || st === "partial" ? undefined : "检查网络 / 代理;python datasources/health.py 看全量" });
    } catch (e) { add({ id: "net", title: "数据源连通", status: "warn", detail: sub(e instanceof Error ? e.message : String(e)), fix: "检查网络 / 代理;python datasources/health.py 看全量" }); }
  }

  /**
   * 16. 上下文注入的**取值写法**(仅 --net)。
   *
   * 🔴 这条是别处都查不出来的一类:注入键的**名字**有棘轮核(比对函数签名),
   *    但**取值写法**没有 —— 同一个概念,有的端点要紧凑写法、有的要带分隔符的写法,
   *    **写错不报错**:上游返回空集,端点如实报"没有数据" —— 读起来像真实状况,
   *    不像格式不对。实测某一块本有 77 条,因写法不对被显示成 0,而界面上看不出异常。
   *
   * 判据 = **同一个块,把上下文能产出的每种写法都试一遍,你声明的那个不能明显更差**。
   * ⚠️ 刻意**不拿"不注入"当基准** —— 不注入走的是端点自己的默认(通常是"最近一期"),
   *    可能落在另一个周期上,条数本来就该不一样;拿它比会两头出错(对的判错、错的放过)。
   */
  const injBlocks = Object.entries(currentPlugin().pageQueries ?? {})
    .flatMap(([q, def]) => def.blocks.filter((b) => b.injectContext).map((b) => ({ q, b })));
  if (!opts.net) add({ id: "inject_format", title: "上下文注入的取值写法", status: "skip", detail: "未指定 --net(会真实取数)" });
  else if (!python || !pyOk || !dataRootOk) add({ id: "inject_format", title: "上下文注入的取值写法", status: "skip", detail: "Python 或数据根不可用" });
  else if (!injBlocks.length) add({ id: "inject_format", title: "上下文注入的取值写法", status: "skip", detail: "垂类没有吃上下文的块" });
  else {
    const ctx = serviceContext({ repoRoot, python, env });
    const pc = currentPlugin().pageContext;
    let injected: Record<string, unknown> = {};
    try {
      if (pc) {
        const probe = await fetchEndpoint(ctx, { endpoint: pc.endpoint, ...(pc.symbol ? { symbol: pc.symbol } : {}), session: "doctor", timeout_ms: 60_000, consistency: { mode: "fresh" } });
        injected = pc.resolve(probe.envelope)?.inject ?? {};
      }
    } catch { /* 下面按"拿不到上下文"报 */ }
    if (!Object.keys(injected).length) add({ id: "inject_format", title: "上下文注入的取值写法", status: "warn", detail: "拿不到上下文,没法核写法", fix: "先看「数据源连通」那项" });
    else {
      const bad: string[] = [];
      const seen: string[] = [];
      for (const { q, b } of injBlocks) {
        /**
         * 取回**证据条数**;`null` = 这次取数本身没成功(信封 failed / 抛异常)。
         * 🔴 `null` 与 `0` 必须分开:把"没取到"折算成 0,后面任何"条数比较"都会
         *    把故障读成"确实没有" —— 正是这轮在修的那一类洞。
         */
        const evCount = async (args: Record<string, unknown>): Promise<number | null> => {
          try {
            const r = await fetchEndpoint(ctx, { endpoint: b.endpoint, ...(b.symbol ? { symbol: b.symbol } : {}), args, session: "doctor", timeout_ms: 60_000, consistency: { mode: "fresh" } });
            const st = String((r.envelope as { status?: unknown }).status ?? "");
            if (st !== "ok" && st !== "partial") return null;
            return Array.isArray(r.envelope.evidence) ? r.envelope.evidence.length : 0;
          } catch { return null; }
        };
        const declared = Object.entries(b.injectAs ?? {});
        // 声明的源键上下文根本不产出 → **直接判失败**,不许静默跳过:
        // 跳过之后这一块与"没注入"完全一样,条数当然相等,检查会报 ok —— 恰好放过最该发现的拼写错误
        const missing = declared.filter(([from]) => !(from in injected)).map(([from]) => from);
        if (missing.length) { bad.push(`${q}.${b.id}:injectAs 的源键 ${missing.join(", ")} 上下文根本不产出(有:${Object.keys(injected).join(", ")})`); continue; }

        for (const [from, to] of declared) {
          const mine = await evCount({ ...(b.args ?? {}), [to]: injected[from] });
          // 同一个目标参数名,换上下文里**其它每一种写法**再试
          const rivals: { key: string; n: number | null }[] = [];
          for (const k of Object.keys(injected)) {
            if (k === from) continue;
            rivals.push({ key: k, n: await evCount({ ...(b.args ?? {}), [to]: injected[k] }) });
          }
          seen.push(`${q}.${b.id}[${from}] ${mine ?? "取数失败"}${rivals.length ? `(其它写法:${rivals.map((r) => `${r.key}=${r.n ?? "取数失败"}`).join("、")})` : ""}`);
          if (mine === null) { bad.push(`${q}.${b.id}:按声明的 ${from} 取数没成功,核不了写法`); continue; }
          // 其它写法**明显更多**(留一倍余量防日内抖动)⇒ 说明选错了写法
          const better = rivals.filter((r) => r.n !== null && r.n > Math.max(1, mine * 2));
          if (better.length) bad.push(`${q}.${b.id}(${b.endpoint}):按声明的 ${from} 只拿到 ${mine} 条,而换成 ${better.map((r) => `${r.key} 有 ${r.n} 条`).join("、")} —— 写法多半选错了,而端点会把它报成"没有数据"`);
        }
      }
      add({ id: "inject_format", title: "上下文注入的取值写法", status: bad.length ? "fail" : "ok",
            detail: bad.length ? bad.join(";") : `${injBlocks.length} 块:${seen.join("、")}`,
            fix: bad.length ? "在该块的 injectAs 里换一个源键(上下文可产出同一概念的多种写法)" : undefined });
    }
  }

  const tallyOf = () => { const t: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 }; for (const c of checks) t[c.status] += 1; return t; };
  const exitOf = (t: Record<CheckStatus, number>): 0 | 2 | 3 => (t.fail ? 3 : t.warn ? 2 : 0);
  let tally = tallyOf(); let exit_code = exitOf(tally);
  let report: string | null = null;
  if (opts.writeReport !== false && dataRootOk) {
    // 报告落盘:目标路径经 safePath(doctor/ 目录或文件是符号链接 → 拒绝,记 warn 不写);路径以 <repo> 相对化、detail 经 redact(报告可能被用户贴出去)
    const rel = (x: string) => redact(x.split(repoRoot).join("<repo>"), 600);
    const safeChecks = checks.map((c) => ({ ...c, detail: rel(c.detail), ...(c.fix ? { fix: rel(c.fix) } : {}) }));
    try {
      report = safePath({ dataRoot }, "doctor", `${nowIso().replace(/[-:]/g, "").slice(0, 15)}.json`);
      writeJson(report, { generated_at: nowIso(), repoRoot: "<repo>", checks: safeChecks, tally, exit_code });
    } catch (e) { report = null; add({ id: "report", title: "体检报告落盘", status: "warn", detail: `未写报告:${e instanceof Error ? e.message : String(e)}`, fix: "数据根内 doctor/ 不得是符号链接" }); }
  }
  tally = tallyOf(); exit_code = exitOf(tally);  // 报告落盘失败的 warn 也计入
  return { generated_at: nowIso(), repoRoot, dataRoot, checks, tally, exit_code, report };
}

export function formatDoctor(r: DoctorResult): string {
  const mark: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = [`[doctor] 产品根 ${r.repoRoot}`, `[doctor] 数据根 ${r.dataRoot}`, ""];
  for (const c of r.checks) { lines.push(`${mark[c.status]}  ${c.title}:${c.detail}`); if (c.fix && c.status !== "ok") lines.push(`      修复:${c.fix}`); }
  lines.push("", `合计:ok ${r.tally.ok} · warn ${r.tally.warn} · fail ${r.tally.fail} · skip ${r.tally.skip} → 退出码 ${r.exit_code}${r.report ? `;报告 ${r.report}` : ""}`);
  return lines.join("\n");
}

if (process.argv[1] && (process.argv[1].endsWith("/doctor.ts") || process.argv[1].endsWith("\\doctor.ts"))) {
  const a = parseArgs(process.argv.slice(2));
  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  await (async () => {
  try {
    const r = await runDoctor({ net: a.net === true, python: str(a.python) });
    console.log(a.json === true ? JSON.stringify(r, null, 2) : formatDoctor(r));
    process.exit(r.exit_code);
  } catch (e) { console.error(`[doctor] ${e instanceof Error ? e.message : String(e)}`); process.exit(3); }
  })();
}
