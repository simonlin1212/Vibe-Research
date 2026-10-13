#!/usr/bin/env node
/**
 * 体检(scripts/doctor):一次性检查"这台机器能不能跑研究",每项给 ok / warn / fail / skip + 中文修复提示;
 * 只读(除了写一份报告到 <data_root>/doctor/<时间>.json 和一个写权限探针文件;--net 会把那次取数的信封与 raw 写到 <data_root>/mcp/doctor/),
 * 不读写任何 Agent 的全局配置与登录态(本机订阅 Agent 只问版本与"是否已登录"),不联网(除非 --net)。
 * 报告里的路径以 <repo> 相对化、子进程输出经 redact 脱敏;数据根必须在产品根 realpath 之内且不是符号链接(同 init)。
 * 检查项:node 版本 · 产品配置链 · v1 旧配置残留 · 本机订阅 Agent(Claude Code / Codex / WorkBuddy)· 后台默认 AI 来源
 *        · 方法论宪法 · 研究技能 · Python 与取数依赖 · calc 自检 · 注册表与目录
 *        · 数据根写权限 · .gitignore 含 .local/ · 密钥扫描(产品文件,测试目录除外)· 代理 · api.token 权限 · [--net] 数据源连通(取一个端点)
 * 退出码:0 全部 ok / 2 只有 warn / 3 有 fail。用法:node orchestrator/src/doctor.ts [--net] [--json] [--python P](--net 取注册表端点 tx_quote 一次)
 */
import { currentPlugin } from "./plugin.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CONSTITUTION_REL } from "./config.ts";
import { NOFOLLOW_FLAG, nowIso, privateFilePermissions, readJsonIfExists, sha256File, writeJson } from "./fsutil.ts";
import { assertDataRootInside, detectPython, gitignoreCovers, resolveDataRoot } from "./init.ts";
import { loadSavedAgentPaths, probeClaude, probeCodeBuddy, probeCodex, type LocalAgentStatus } from "./local_agent_runtime.ts";
import { loadProductConfig, type LoadedProductConfig } from "./productConfig.ts";
import { parseArgs } from "./run.ts";
import { isCliProvider, resolveSelectedRuntime, RuntimeProviderError } from "./runtime_provider.ts";
import { fetchEndpoint, redact, repoRootFromHere, safePath, serviceContext } from "./service.ts";


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
/** 只在产品根下跳过:免安装包自带的 Node / Python 运行时(第三方产物,文件上万,会把额度吃光;别处同名目录照扫) */
const SCAN_SKIP_ROOT_DIRS = new Set(["runtime"]);
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

/** 本机订阅 Agent 没就绪时怎么办(登录一律在用户自己的终端里做,产品不经手) */
const AGENT_FIX: Record<LocalAgentStatus["provider"], string> = {
  "cli-claude": "安装 Claude Code 后在终端运行 claude 并完成 /login",
  "cli-codex": "安装 Codex CLI(npm install -g @openai/codex)后在终端运行 codex login",
  "cli-codebuddy": "安装 WorkBuddy(或 CodeBuddy CLI)并在其中登录",
};

/** 子进程最小环境:基础 + 代理 + 证书(不透传任何密钥类变量) */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) if (base[k]) out[k] = base[k] as string;
  return out;
}

export const defaultExec: Exec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: opts.env ?? minimalEnv(), cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? ` ${r.error.message}` : "") };
};

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
      if (ent.isDirectory()) { if (dir === root && SCAN_SKIP_ROOT_DIRS.has(ent.name)) continue; if (TEST_DIRS.has(ent.name)) rec(p, true); else if (!SCAN_SKIP_DIRS.has(ent.name)) rec(p, inTest); }
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

export async function runDoctor(opts: {
  repoRoot?: string; env?: NodeJS.ProcessEnv; exec?: Exec; net?: boolean; python?: string; writeReport?: boolean;
  /** 本机订阅 Agent 探测(测试注入;缺省真的去问三个 CLI 的版本与登录状态) */
  probeAgents?: (env: NodeJS.ProcessEnv) => Promise<LocalAgentStatus[]>;
} = {}): Promise<DoctorResult> {
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
  try {
    pc = loadProductConfig(repoRoot, { env });
    add({ id: "config", title: "产品配置链", status: "ok", detail: `来源:${pc.sources.join(" ← ")}` });
  }
  catch (e) { add({ id: "config", title: "产品配置链", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: "检查 .local/config.json / 环境变量 VRA_*;或先 node orchestrator/src/init.ts" }); }
  const dataRoot = pc?.resolved.dataRoot ?? resolveDataRoot(repoRoot);
  // 数据根边界(同 init):不在产品根 realpath 内或是符号链接 → 直接 fail 并且后续不再往里写任何东西。
  let dataRootOk = true;
  try { assertDataRootInside(repoRoot, dataRoot); } catch (e) { dataRootOk = false; add({ id: "data_root_boundary", title: "数据根边界", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: "把 .local 改回产品根内的普通目录(不要用符号链接指向仓库外)" }); }

  // 2b. v1 旧配置:读得懂但已不生效。不报出来,用户会以为自己配的引擎 / 登录方式还在起作用
  const legacy = [...new Set(pc?.ignoredLegacy ?? [])];
  if (legacy.length) add({ id: "legacy_config", title: "v1 旧配置残留", status: "warn",
    detail: `这些字段 / 环境变量 v2 已不再使用:${legacy.join(", ")}`,
    fix: "删掉它们即可(或 scripts/init --force 重写骨架,会先备份);v2 只认 provider.profile。产品专用 Codex 登录已移除,要用 Codex 订阅请选 cli-codex(用你自己在本机登录的 Codex CLI)" });

  // 3. AI 来源。本机订阅 Agent 用的是用户自己在本机 CLI 里的登录,这里只问版本与"是否已登录",不读不改登录文件
  let agents: LocalAgentStatus[] = [];
  let probeError = "";
  if (dataRootOk) loadSavedAgentPaths(dataRoot);  // 设置页手动指定的 WorkBuddy 位置也要算进体检
  try { agents = await (opts.probeAgents ?? ((e) => Promise.all([probeClaude(e), probeCodex(e), probeCodeBuddy(e)])))(env); }
  catch (e) { probeError = sub(e instanceof Error ? e.message : String(e)); }
  // 3a. 后台默认 AI 来源(命令行研究 / 批量运行用;页面每次请求自带所选来源,不依赖它)
  let defaultUsable = false;
  const profile = pc?.provider.profile ?? null;
  if (!pc) add({ id: "ai_default", title: "后台默认 AI 来源", status: "skip", detail: "产品配置链未通过,无法确定后台默认" });
  else if (!profile) add({ id: "ai_default", title: "后台默认 AI 来源", status: "skip", detail: "未设。页面每次请求自带所选来源,不受影响;命令行研究 / 批量运行需要 --provider,或在 .local/config.json 写 provider.profile" });
  else if (isCliProvider(profile)) {
    const a = agents.find((x) => x.provider === profile);
    if (!a) add({ id: "ai_default", title: "后台默认 AI 来源", status: "fail", detail: probeError ? `${profile}:登录状态检测失败(${probeError})` : `${profile} 不是支持的本机订阅 Agent(只支持 cli-claude / cli-codex / cli-codebuddy)`, fix: "改成支持的来源,或换成 providers/ 里的模型 API 模板" });
    else {
      defaultUsable = a.available;
      add({ id: "ai_default", title: "后台默认 AI 来源", status: a.available ? "ok" : "fail", detail: `${profile}(${a.name}${a.version ? ` ${a.version}` : ""}):${a.detail}`, fix: a.available ? undefined : AGENT_FIX[a.provider] });
    }
  } else {
    try {
      const rt = resolveSelectedRuntime(repoRoot, dataRoot, undefined, env);
      if (rt.runtime !== "api") throw new RuntimeProviderError("bad_provider", `${profile} 解析成了本机 Agent`);
      defaultUsable = true;
      add({ id: "ai_default", title: "后台默认 AI 来源", status: "ok",
        detail: `模型 API ${rt.api.label}(${new URL(rt.api.baseURL).host},模型 ${rt.api.model});密钥变量 ${rt.api.envKey} 已设置${rt.api.verified ? "" : `;${rt.api.reason ?? "产品没有实测过这个模板"}`}` });
    } catch (e) {
      const code = e instanceof RuntimeProviderError ? e.code : "";
      const msg = e instanceof Error ? e.message : String(e);
      add({ id: "ai_default", title: "后台默认 AI 来源", status: "fail", detail: sub(msg),
        fix: code === "provider_renamed"
          ? "把 provider.profile(或环境变量 VRA_PROVIDER)改成 cli-codex(ChatGPT 订阅,用你自己登录的 Codex CLI)或 openai-api(OpenAI 官方 API,按量计费)"
          : code === "missing_key"
          ? `在启动产品的终端里 export 上面提到的环境变量(密钥只从环境变量读,不写进配置文件)${profile === "openai-api" ? ";想用 ChatGPT 订阅请把 provider.profile 改成 cli-codex" : ""}`
          : "检查 provider.profile 是否为 providers/ 里的模板 id,以及模板内容" });
    }
  }
  // 3b. 本机订阅 Agent 清单:有一个就绪,或后台默认的模型 API 可用,这台机器就有大脑可用
  const ready = agents.filter((a) => a.available);
  add({
    id: "local_agents", title: "本机订阅 Agent",
    status: probeError ? "warn" : ready.length || defaultUsable ? "ok" : "warn",
    detail: probeError ? `检测失败:${probeError}` : agents.map((a) => `${a.name}:${a.status === "ready" ? `已登录${a.version ? `(${a.version})` : ""}` : a.detail}`).join(" · "),
    fix: ready.length || defaultUsable ? undefined : "安装并登录 Claude Code / Codex CLI / WorkBuddy 任一;或在页面「接入 AI」里填模型 API 的 key",
  });

  // 4. 方法论宪法(产品在每个研究阶段把它放进提示词;根目录 AGENTS.md 是给来部署的 coding agent 看的指南)
  const constitution = path.join(repoRoot, CONSTITUTION_REL);
  add(fs.existsSync(constitution)
    ? { id: "constitution", title: "方法论宪法", status: "ok", detail: `${CONSTITUTION_REL} sha256 ${sha256File(constitution).slice(0, 12)}…` }
    : { id: "constitution", title: "方法论宪法", status: "fail", detail: `产品根缺少 ${CONSTITUTION_REL}(研究阶段的方法论约束)`, fix: "恢复仓库文件" });

  // 5. 研究技能(产品按阶段读取并放进提示词)
  const skillsDir = path.join(repoRoot, ".agents", "skills");
  const found = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md"))) : [];
  const missing = REQUIRED_SKILLS.filter((s) => !found.includes(s));
  add({ id: "skills", title: "研究技能(.agents/skills/<名>/SKILL.md)", status: missing.length ? "fail" : "ok", detail: `${found.length} 个:${found.join(", ") || "(无)"}${missing.length ? `;缺 ${missing.join(", ")}` : ""}`, fix: missing.length ? "恢复 .agents/skills/" : undefined });

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
        ? `${python} → ${ver};产品要求 Python ≥ 3.11`
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

  // 11.5 垂类自己的体检项:由插件贡献,Core 只负责并进报告(原本这里直接 import finance 包的温度计模块)
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
  if (!opts.net) add({ id: "net", title: "数据源连通", status: "skip", detail: "未指定 --net(会真实访问一个数据端点,结果写 .local/mcp/doctor/)" });
  else if (!python || !pyOk || !dataRootOk) add({ id: "net", title: "数据源连通", status: "skip", detail: !dataRootOk ? "数据根边界未通过" : "Python 不可用" });
  else {
    try {
      const ctx = serviceContext({ repoRoot, python, env });
      // 用注册表里的零鉴权端点 tx_quote(腾讯)探一次;legacy 脚本端点不经 fetch_endpoint.py,不能用在这里
      // 🔴 **必须 fresh**:探针要回答的是"此刻能不能连上",读快照会把历史上的一次成功
      //    报成"当前网络健康" —— 一条彻头彻尾的假诊断(架构评审 arch-r1 §A)。
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
