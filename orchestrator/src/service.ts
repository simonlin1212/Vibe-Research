/**
 * 服务层(Phase 1 M3):把数据层与研究运行以纯函数 / 薄封装暴露给 MCP server 与 HTTP API。
 * 约束:输入全部闭合校验(代码白名单 / 市场枚举 / run_id · session 正则 / args 只允许注册表声明的键与原始类型);
 * 路径全部经 safePath()(词法前缀 + realpath + 逐级禁符号链接,只在用户数据区 .local 内);取数仍由子进程 fetch_endpoint.py 执行(最小环境 + 该端点 auth_env);
 * 研究运行 detached 拉起 run.ts(最小环境:基础 + VRA_* + provider env_key);返回值只含相对路径,错误信息脱敏;不碰 ~/.codex;不返回任何密钥。
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readResearchControl, reserveResearch, updateResearchControl, requestResearchCancellation, researchDecision, ResearchControlError } from "./research_control.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FETCH_ENV_KEYS, RUN_ID_RE, stages as packStages, fetchEnv } from "./config.ts";
import { researchFailure } from "./research_failure.ts";
import { runAlerts, type AlertDiff } from "./alerts.ts";
import { NOFOLLOW_FLAG, nowIso, readJsonIfExists } from "./fsutil.ts";
import { ChatError, applyGate, chatSend as chatSendCore, llmProbe as llmProbeCore, parseHeadlineTranslationReply, prepareHeadlineTranslation, translateHeadlines as translateHeadlinesCore, type ChatTurnResult, type HeadlineTranslationResult, type LlmProbeResult } from "./chat.ts";
import { DirectTransportError, chatCompletion } from "./engines/direct_transport.ts";
import { assertExecutionMode, resolveDirectProvider, resolveRuntimeProvider, resolveSelectedRuntime, runtimeSourceFingerprint, RuntimeProviderError, templateMatrix, type LlmOverride } from "./runtime_provider.ts";
import { DebateError, MAX_DEBATE_MESSAGE, DEBATE_TURN_TIMEOUT_MS, advanceDebate, startDebate, type DebateState } from "./debate.ts";
import { IngestError, MAX_TOTAL_BYTES, ingestFiles as ingestFilesCore, type IngestFileInput, type IngestResult } from "./ingest.ts";
import { LedgerError, kinds as ledgerKindDefs, labels as ledgerLabelDefs, listRecordsChecked, listRecords as listRecordsOf, removeRecord as removeLedgerRecord, upsertRecord as upsertLedgerRecord, type LedgerIssue, type LedgerRecord } from "./ledger.ts";
import { recallKnowledge, type KnowledgeRecall } from "./knowledge.ts";
import { loadProductConfig } from "./productConfig.ts";
import { REGISTRY_REL, buildStagePlan, fetchArgv, loadRegistry, type EndpointDef } from "./registry.ts";
import { productVersion } from "./version.ts";
import { DEFAULT_CONSISTENCY, readSnapshot, snapshotKey, snapshotUsable, writeSnapshot, type Consistency } from "./snapshot.ts";
import { currentPlugin } from "./plugin.ts";
import { ReportLibraryError, addReport, listReports as listStoredReports, removeReport, reportCitationErrors, reportCitations, reportContextAsync, reportFile, reportRecallPlan, type ReportRecord } from "./report_library.ts";
import { GuidedToolError, guidedToolTurn as guidedToolTurnCore, type GuidedToolReply } from "./guided_tool.ts";
import { LocalAgentError, probeClaude, probeCodeBuddy, probeCodex, startCodexLogin, type LocalAgentStatus } from "./local_agent_runtime.ts";
import { sdkCodexVersion } from "./runner.ts";
import { redact } from "./service_redact.ts";

export { redact } from "./service_redact.ts";


export interface ServiceContext { repoRoot: string; dataRoot: string; python: string; node: string; providerEnvKey: string | null }

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 从产品配置链解析服务上下文(与 run.ts 同源:vibe-research.config.json ← .local/config.json ← VRA_*);VRA_REPO_ROOT 可指定仓库(测试 / 多副本) */
export function serviceContext(opts: { repoRoot?: string; python?: string; env?: NodeJS.ProcessEnv } = {}): ServiceContext {
  const env = opts.env ?? process.env;
  const repoRoot = path.resolve(opts.repoRoot ?? env.VRA_REPO_ROOT ?? repoRootFromHere());
  const pc = loadProductConfig(repoRoot, { env });
  return { repoRoot, dataRoot: pc.resolved.dataRoot, python: opts.python ?? pc.python ?? "python3", node: process.execPath, providerEnvKey: pc.provider?.env_key ?? null };
}

export class ServiceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/;       // 主体代码:数字 / 字母 / 点 / 连字符,长度 1-12
const SYMBOL_FREE_RE = /^[^\s\/\\]{1,40}$/;       // raw 类端点(关键词 / 指数)允许中文,但不允许路径分隔符与空白
/** 合法市场取值由契约给(Plugin.evidence.markets)+ 空串;Core 不写死垂类代码(全审 r4) */
const markets = (): Set<string> => new Set(["", ...currentPlugin().evidence.markets]);
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 注册表未声明、但 mapper 通用读取的参数键 */
const GLOBAL_ARG_KEYS = new Set(["limit", "date"]);
const MAX_ARG_KEYS = 20;
const MAX_ARG_STR = 200;
const MAX_ARG_ARR = 50;

const show = (v: unknown) => JSON.stringify(String(v ?? "")).slice(0, 48);

export function assertSymbol(symbol: unknown, kind: string | undefined): string {
  const s = String(symbol ?? "").trim();
  const re = kind === "raw" || kind === "none" ? SYMBOL_FREE_RE : SYMBOL_RE;
  if (!re.test(s)) throw new ServiceError("bad_symbol", `非法代码 ${show(symbol)}`);
  return s;
}

export function assertMarket(market: unknown): string {
  const m = String(market ?? "").toUpperCase();
  if (!markets().has(m)) throw new ServiceError("bad_market", `非法市场 ${show(market)}(只接受 SH/SZ/BJ/CN/US/HK 或空)`);
  return m;
}

export function assertRunId(runId: unknown): string {
  const s = String(runId ?? "");
  if (!RUN_ID_RE.test(s)) throw new ServiceError("bad_run_id", `非法 run-id ${show(runId)}`);
  return s;
}

export function assertScope(v: unknown): "full" | "core" {
  if (v === undefined || v === "full") return "full";
  if (v === "core") return "core";
  throw new ServiceError("bad_scope", `endpoints 只能是 full|core,收到 ${show(v)}`);
}

export function assertKnowledgeFlag(v: unknown): "on" | "off" {
  if (v === undefined || v === "on") return "on";
  if (v === "off") return "off";
  throw new ServiceError("bad_knowledge", `knowledge 只能是 on|off,收到 ${show(v)}`);
}

/** args 闭合校验:键 ⊆ 注册表 args 声明 ∪ {limit, date};值只允许 原始类型 / 原始类型数组;限长限量 */
export function assertArgs(ep: EndpointDef, args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ServiceError("bad_args", "args 必须是对象");
  const allowed = new Set([...Object.keys(ep.args ?? {}), ...GLOBAL_ARG_KEYS]);
  const out: Record<string, unknown> = {};
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length > MAX_ARG_KEYS) throw new ServiceError("bad_args", `args 键过多(> ${MAX_ARG_KEYS})`);
  const prim = (v: unknown, k: string) => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new ServiceError("bad_args", `args.${k} 不是有限数`); return v; }
    if (typeof v === "string") { if (v.length > MAX_ARG_STR) throw new ServiceError("bad_args", `args.${k} 过长(> ${MAX_ARG_STR})`); return v; }
    throw new ServiceError("bad_args", `args.${k} 只允许 字符串 / 数字 / 布尔 / null 或其数组`);
  };
  for (const [k, v] of entries) {
    if (!allowed.has(k)) throw new ServiceError("bad_args", `端点 ${ep.id} 不接受参数 ${show(k)}(允许:${[...allowed].join(", ") || "无"})`);
    if (Array.isArray(v)) { if (v.length > MAX_ARG_ARR) throw new ServiceError("bad_args", `args.${k} 数组过长`); out[k] = v.map((x) => prim(x, k)); }
    else out[k] = prim(v, k);
  }
  return out;
}

/** 用户数据区内的安全路径:词法前缀 + 已存在的每一级都不得是符号链接 + 最深存在祖先的 realpath 仍在 dataRoot 的 realpath 内 */
export function safePath(ctx: Pick<ServiceContext, "dataRoot">, ...segments: string[]): string {
  const rootAbs = path.resolve(ctx.dataRoot);
  const abs = path.resolve(rootAbs, ...segments);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new ServiceError("path_escape", `路径越出用户数据区`);
  let cur = abs;
  const chain: string[] = [];
  while (cur !== rootAbs && cur.startsWith(rootAbs + path.sep)) { chain.unshift(cur); cur = path.dirname(cur); }
  for (const p of chain) {
    if (!fs.existsSync(p)) break;
    if (fs.lstatSync(p).isSymbolicLink()) throw new ServiceError("path_symlink", `用户数据区内存在符号链接,拒绝访问:${path.relative(rootAbs, p)}`);
  }
  const deepest = chain.filter((p) => fs.existsSync(p)).pop() ?? rootAbs;
  if (fs.existsSync(rootAbs)) {
    const realRoot = fs.realpathSync(rootAbs);
    const realDeep = fs.realpathSync(deepest);
    if (realDeep !== realRoot && !realDeep.startsWith(realRoot + path.sep)) throw new ServiceError("path_escape", "路径 realpath 越出用户数据区");
  }
  return abs;
}

const rel = (ctx: Pick<ServiceContext, "dataRoot">, p: string) => path.relative(path.resolve(ctx.dataRoot), p).split(path.sep).join("/");

/** 研究子进程 / 批量子进程的最小环境:基础 + VRA_* + provider 的 env_key(若设置);不透传其它 *KEY* / *TOKEN* */
export function researchEnv(ctx: Pick<ServiceContext, "providerEnvKey">, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FETCH_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k] as string;
  const requestScoped = new Set(["VRA_TASK_OBJECTIVE", "VRA_TASK_REPORT_IDS", "VRA_TASK_REPORT_REVISIONS", "VRA_RESEARCH_CONTROL_TOKEN"]);
  for (const [k, v] of Object.entries(env)) if (k.startsWith("VRA_") && !requestScoped.has(k) && v !== undefined) out[k] = v;
  if (ctx.providerEnvKey && env[ctx.providerEnvKey]) out[ctx.providerEnvKey] = env[ctx.providerEnvKey] as string;
  return out;
}

// ---------------- 注册表 ----------------
export interface EndpointSummary { id: string; title?: string; layer?: string; market: string[]; source?: string; compliance?: string; symbol_kind?: string; stages: Record<string, string>; enabled: boolean; auth_env?: string; computed?: boolean; notes?: string; args?: Record<string, unknown> }

/**
 * 列端点。
 * 🔴 `for_ui: true` 时**只给 `exposure=ui` 的**。有些端点是给 agent 用的、不该出现在界面上
 *    (管制与准入、名单核查这类):它们对分析有用,但摆在界面上只是噪音。
 *    ⚠️ **光靠"某个页面不去渲染它"守不住** —— 以后任何一个通用端点列表组件都会把它列出来。
 *    所以过滤放在这里,而不是让每个消费方自己记得。
 */
export function listEndpoints(ctx: ServiceContext, filter: { layer?: string; market?: string; q?: string; enabled_only?: boolean; for_ui?: boolean } = {}): EndpointSummary[] {
  const reg = loadRegistry(ctx.repoRoot);
  if (!reg) throw new ServiceError("no_registry", `注册表不存在:${REGISTRY_REL}`);
  const q = String(filter.q ?? "").toLowerCase().slice(0, 80);
  const layer = String(filter.layer ?? "").slice(0, 40);
  const market = String(filter.market ?? "").toUpperCase().slice(0, 4);
  return reg.endpoints
    .filter((e) => (!layer || String(e.layer ?? "").startsWith(layer)) && (!market || e.market.includes(market)) && (!filter.enabled_only || e.enabled !== false)
      && (!q || `${e.id} ${e.title ?? ""} ${e.source ?? ""} ${e.layer ?? ""}`.toLowerCase().includes(q))
      // 缺省视为 ui:绝大多数端点本来就是给人看的,只有显式标了别的才被挡
      && (!filter.for_ui || (e.exposure ?? "ui") === "ui"))
    .map((e) => ({ id: e.id, title: e.title, layer: e.layer, market: e.market, source: e.source, compliance: e.compliance, symbol_kind: e.symbol_kind, stages: e.stages ?? {}, enabled: e.enabled !== false, auth_env: e.auth_env, computed: e.computed === true, notes: e.notes, args: e.args }));
}

export function endpointDef(ctx: ServiceContext, id: unknown): EndpointDef {
  const sid = String(id ?? "");
  const reg = loadRegistry(ctx.repoRoot);
  const ep = reg?.endpoints.find((e) => e.id === sid);
  if (!ep) throw new ServiceError("unknown_endpoint", `注册表无端点 ${show(id)}`);
  return ep;
}

// ---------------- 取数(子进程,落 .local/mcp/<session>/) ----------------
export interface FetchResult {
  envelope: Record<string, unknown>;
  exit_code: number | null;
  out_dir: string;
  duration_ms: number;
  stderr_tail: string;
  /** true = 这份是**上次取的快照**,没有重新取数 */
  cached: boolean;
  /** 这份数据是什么时候取到的。**界面必须显示它** —— 拿旧数据不说是旧的等于骗人 */
  fetched_at: string;
}

/**
 * 取数。**默认读上次的快照,不重新取** —— 页面打开一次就把依赖的端点全跑一遍,
 * 既慢又费钱,而多数时候用户只是想再看一眼上次看到的东西。要新数据传 `refresh: true`。
 *
 * 🔴 失败 / 空信封**不写快照**:否则一次网络抖动会被记住,下次打开还是那次失败,而且永远不会自愈。
 */
export async function fetchEndpoint(
  ctx: ServiceContext,
  req: {
    endpoint: string; symbol?: string; args?: Record<string, unknown>; session?: string; timeout_ms?: number;
    /** 兼容写法:`true` 等价于 `consistency: {mode:"fresh"}` */
    refresh?: boolean;
    consistency?: Consistency;
    signal?: AbortSignal;
  },
): Promise<FetchResult> {
  if (req.signal?.aborted) throw new ServiceError("cancelled", "取数已取消");
  const ep = endpointDef(ctx, req.endpoint);
  const session = String(req.session ?? "default");
  if (!SESSION_RE.test(session)) throw new ServiceError("bad_session", `非法 session ${show(session)}`);
  const outDir = safePath(ctx, "mcp", session);
  fs.mkdirSync(path.join(outDir, "fetch"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  safePath(ctx, "mcp", session, "fetch");  // 创建后再查一次(防 mkdir 途中被替换成链接)
  const scriptsDir = path.join(ctx.repoRoot, ".agents", "skills", "data-access", "scripts");
  // 🔴 命令构造只有一处真相:registry.ts 的 fetchArgv(legacy → 脚本自身;其余 → fetch_endpoint.py)。
  //    这里原先手写了第二份、漏掉 legacy 分支 —— 结果 8 个 legacy 端点经 POST /fetch 一律返回
  //    "ModuleNotFoundError: No module named 'sources.legacy'"(编排器走 fetchArgv 所以一直是好的,
  //    两条路径行为分叉、只有一条坏,最难发现)。同一件事别写两遍。
  //    legacy 脚本的 base_parser 把 --symbol 设成 required(symbol_kind=none 的也一样,只校验格式后忽略),
  //    所以这类端点必须由调用方给一个 —— 不在这里悄悄编个占位代码顶上,
  //    那会让"没给 symbol"和"给了这个 symbol"在落盘与日志里长得一模一样。
  const needSymbol = ep.symbol_kind !== "none" || ep.module === "legacy";
  let symbol = "";
  if (needSymbol) {
    if (req.symbol === undefined) throw new ServiceError("missing_symbol", `端点 ${ep.id} 需要 symbol`);
    symbol = assertSymbol(req.symbol, ep.symbol_kind === "none" ? "cn6" : ep.symbol_kind);
  }
  const args = assertArgs(ep, req.args);
  // 快照键在**参数校验之后**算:用校验过的 args,免得同一份查询因为写法不同算出两把键
  const snapKey = snapshotKey(ep.id, symbol, args);
  const consistency: Consistency = req.consistency ?? (req.refresh ? { mode: "fresh" } : DEFAULT_CONSISTENCY);
  // 端点自己声明的缓存上限(秒)。**调用方放宽不了** —— 它是数据本身的性质:
  // 产出里含"按此刻算出来"的字段时,缓存住就会被永久冻结(上午算的状态晚上还在读)。
  const epMaxAge = typeof ep.cache_max_age_sec === "number" ? ep.cache_max_age_sec * 1000 : null;
  const hit = readSnapshot<FetchResult>(ctx.dataRoot, snapKey);
  if (snapshotUsable(hit, consistency, epMaxAge)) {
    return { ...(hit as NonNullable<typeof hit>).payload, cached: true, fetched_at: (hit as NonNullable<typeof hit>).fetched_at };
  }
  if (consistency.mode === "cache_only") {
    throw new ServiceError("no_snapshot", `端点 ${ep.id} 没有可用快照,而本次要求只读缓存(不联网)`);
  }
  // 🔴 single-flight:同一份查询并发进来时只真取一次。
  //    没有它,一屏五个卡片指向同一端点就会打五次上游;更糟的是**先发后回**的慢请求
  //    会把新结果覆盖成旧的(Codex 架构评审 arch-r1 §F-6)。
  const flightKey = `${ctx.dataRoot}\u0000${snapKey}`;
  const flying = inFlight.get(flightKey);
  if (flying) return subscribeFlight(flying, req.signal);
  const controller = new AbortController();
  const run = (async (): Promise<FetchResult> => {
    const argv = fetchArgv(ep, ep.id, { scriptsDir, symbol, runDir: outDir });
    if (Object.keys(args).length) {
      if (ep.module === "legacy") throw new ServiceError("args_unsupported", `端点 ${ep.id} 是 legacy 脚本,不接受 args`);
      argv.push("--args", JSON.stringify(args));
    }
    // 取数进程:最小环境 + 该端点声明的 auth_env(只此一个)+ 用户显式的 TLS 降级开关
    const extra: Record<string, string> = {};
    if (ep.auth_env && process.env[ep.auth_env]) extra[ep.auth_env] = process.env[ep.auth_env] as string;
    if (process.env.VRA_ALLOW_INSECURE_TLS) extra.VRA_ALLOW_INSECURE_TLS = process.env.VRA_ALLOW_INSECURE_TLS;
    const timeout = Math.min(Math.max(Number(req.timeout_ms) || 180_000, 1_000), 600_000);
    const t0 = Date.now();
    // 🔴 **必须是异步 spawn,不能用 spawnSync** —— spawnSync 会阻塞整个 Node 事件循环,
    //    HTTP 服务在取数期间连别的请求都收不下:实测 3 个并发请求墙钟 ≈ 串行合计,
    //    某个自报 132ms 的请求实际等了 1.83s(全在排队)。看板一屏要打五六个端点,这是致命的。
    //    并发安全性已核实:取数器把信封原子写到 fetch/<script>.json,raw 文件名带时间戳+pid+随机,
    //    且调用方拿的是 stdout 不是文件 —— 同端点并发不会互相污染。
    const p = await runFetchProcess(ctx.python, argv, { cwd: ctx.repoRoot, env: fetchEnv(extra), timeout, signal: controller.signal });
    const dur = Date.now() - t0;
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(p.stdout) as Record<string, unknown>; }
    catch { throw new ServiceError("bad_envelope", `取数器未输出合法 JSON(退出码 ${p.status}):${redact(p.stderr || "", 200)}`); }
    const result: FetchResult = { envelope, exit_code: p.status, out_dir: rel(ctx, outDir), duration_ms: dur, stderr_tail: redact(p.stderr || "", 300), cached: false, fetched_at: nowIso() };
    // 🔴 只有"真取到了"才写快照。判据取信封自己的 status 与证据条数 ——
    //    `failed` 或一条证据都没有,就是这次没取到,别让它变成用户下次打开看到的东西。
    const snap = writeSnapshot(ctx.dataRoot, snapKey, { endpoint: ep.id, symbol }, result, (r) => {
      const env = r.envelope as { status?: unknown; evidence?: unknown };
      return r.exit_code === 0 && env.status !== "failed" && Array.isArray(env.evidence) && env.evidence.length > 0;
    });
    return snap ? { ...result, fetched_at: snap.fetched_at } : result;
  })();
  const flight: FetchFlight = { promise: run, controller, subscribers: 0, remove: () => {
    if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
  } };
  inFlight.set(flightKey, flight);
  void run.then(flight.remove, flight.remove);
  return subscribeFlight(flight, req.signal);
}

/**
 * 正在飞的取数:同一份查询并发进来时只真取一次,大家共用同一个 Promise。
 * 🔴 没有它:一屏五个卡片指向同一端点会打五次上游;更糟的是**先发后回**的慢请求会把
 *    新结果覆盖成旧的(Codex 架构评审 arch-r1 §F-6)。
 */
interface FetchFlight { promise: Promise<FetchResult>; controller: AbortController; subscribers: number; remove: () => void }
const inFlight = new Map<string, FetchFlight>();

/** 每个等待者独立取消;最后一个离开才停共享子进程,并立即允许新请求。 */
function subscribeFlight(flight: FetchFlight, signal?: AbortSignal): Promise<FetchResult> {
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error: unknown, result?: FetchResult) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      flight.subscribers--;
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => {
      finish(new ServiceError("cancelled", "取数已取消"));
      if (flight.subscribers === 0) { flight.remove(); flight.controller.abort(); }
    };
    flight.promise.then(result => finish(null, result), error => finish(error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const FETCH_MAX_BUFFER = 64 * 1024 * 1024;
/** 超时后给 SIGTERM 留的收尾时间,过了再 SIGKILL */
const KILL_GRACE_MS = 2_000;

/**
 * 跑取数子进程。等价于原来的 `spawnSync`,但**不阻塞事件循环**。
 * spawnSync 的三条语义都得手工复刻,漏一条就是"看着一样、行为不同":
 * ① `timeout` 到点杀进程 ② `maxBuffer` 超了要中止(否则一个疯狂输出的脚本能把内存吃光)
 * ③ 起不来(ENOENT / EACCES)要报 spawn_failed —— 与旧的 `p.error` 分支同一个错误码。
 * ⚠️ 用 `close` 而不是 `exit`:`exit` 时 stdout 可能还没读完,会拿到截断的 JSON。
 */
function runFetchProcess(
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; timeout: number; input?: string; signal?: AbortSignal },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // stdin 只在**真要喂东西**时才开管道:取数那条路一直是 "ignore",
    // 改成无条件 "pipe" 会让不读 stdin 的脚本在管道满时挂住。
    const child = spawn(cmd, argv, {
      cwd: opts.cwd, env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (opts.input !== undefined) {
      // EPIPE:子进程没读完就退了 —— 交给下面的退出码分支去报,不要在这里炸掉整个 Promise
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.input);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let aborted: "timeout" | "overflow" | "cancelled" | null = null;
    let hardKill: NodeJS.Timeout | null = null;

    const stop = (why: "timeout" | "overflow" | "cancelled") => {
      if (aborted) return;
      aborted = why;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      hardKill.unref();
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeout);
    timer.unref();
    const abort = () => stop("cancelled");
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) stop("cancelled");

    const take = (buf: Buffer[], chunk: Buffer, len: number): number => {
      const next = len + chunk.length;
      if (next > FETCH_MAX_BUFFER) { stop("overflow"); return next; }
      buf.push(chunk);
      return next;
    };
    child.stdout?.on("data", (c: Buffer) => { outLen = take(out, c, outLen); });
    child.stderr?.on("data", (c: Buffer) => { errLen = take(err, c, errLen); });

    const done = () => { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); opts.signal?.removeEventListener("abort", abort); };
    child.on("error", (e) => {
      done();
      reject(new ServiceError("spawn_failed", `取数进程失败:${redact(e.message, 120)}`));
    });
    child.on("close", (code) => {
      done();
      if (aborted === "timeout") {
        return reject(new ServiceError("spawn_failed", `取数进程超时(${Math.round(opts.timeout / 1000)} 秒)已终止`));
      }
      if (aborted === "overflow") {
        return reject(new ServiceError("spawn_failed", `取数进程输出超过 ${FETCH_MAX_BUFFER / 1024 / 1024} MB 已终止`));
      }
      if (aborted === "cancelled") return reject(new ServiceError("cancelled", "取数已取消"));
      resolve({ status: code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

// ---------------- 研究运行 ----------------
export interface StartResult { run_id: string; run_dir: string; log: string; pid: number | undefined }
export interface ResearchTaskContext {
  /** 统一任务层传入的本次研究关注点；只进当前子进程，不写公开启动参数。 */
  taskObjective?: string;
  /** Deep 只能召回用户明确圈选的资料，不能按同代码扩到整库。 */
  reportIds?: readonly string[];
  /** 与 reportIds 一一对应的路由时正文 sha256。 */
  reportRevisions?: Readonly<Record<string, string>>;
  /** 请求级 AI 来源；密钥只进子进程 env，不进 argv / binding / manifest。 */
  runtimeLlm?: LlmOverride;
}

/** 认不出的引擎名一律拒绝 —— 静默落回默认会让用户以为在用自己选的那个,而产出与账单来自另一个 */
function assertEngine(v: unknown): "codex" | "direct" | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "codex") return v;
  if (v === "direct") {
    throw new ServiceError(
      "experimental_engine_not_public",
      "Direct 六阶段仍是开发实验适配器；公开研究请开启 Vibe Research Agent，由系统内部选择执行路径",
    );
  }
  throw new ServiceError("bad_engine", `engine 只能是 codex 或 direct,收到 ${show(String(v))}`);
}

export function startResearch(ctx: ServiceContext, req: { symbol: string; company_name?: string; market?: string; stages?: string[]; endpoints?: "full" | "core"; knowledge?: "on" | "off"; run_id?: string; overwrite?: boolean; no_agent?: boolean; engine?: "codex" | "direct"; executionMode?: unknown; llm?: unknown }, internal: ResearchTaskContext = {}): StartResult {
  let executionMode: "agent" | "direct";
  try { executionMode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  if (executionMode === "direct") {
    throw new ServiceError("agent_required", "六阶段深度研究需要 Agent，请先开启 Vibe Research Agent");
  }
  const requestLlm = checkLlmShape(req.llm);
  const runtimeLlm = internal.runtimeLlm ?? requestLlm;
  const symbol = assertSymbol(req.symbol, "cn6");
  const market = assertMarket(req.market);
  const companyName = typeof req.company_name === "string" ? req.company_name.trim() : "";
  if (companyName.length > 80 || /[\u0000-\u001f\u007f]/.test(companyName)) {
    throw new ServiceError("bad_company_name", "主体名称格式无效");
  }
  const stages = Array.isArray(req.stages) ? req.stages.map(String) : [];
  for (const s of stages) if (!packStages().includes(s)) throw new ServiceError("bad_stage", `未知阶段 ${show(s)}`);
  const scope = assertScope(req.endpoints);
  const kn = assertKnowledgeFlag(req.knowledge);
  // 用户入口不能启动一条“六个阶段都在、实际一个必需取数端点都没有”的空研究。
  // 这不是按市场名写死：换垂类后仍按它自己的注册表与阶段计划判断。
  const reg = loadRegistry(ctx.repoRoot);
  if (reg) {
    const selected = stages.length ? stages : packStages();
    const plan = buildStagePlan(reg, selected, { market, scope });
    const required = selected.reduce((n, stage) => n + (plan[stage]?.required.length ?? 0), 0);
    if (required === 0) {
      throw new ServiceError(
        "unsupported_market",
        "当前研究底座还没有这个市场的完整取数链；已上传资料仍可在 Agent 对话中检索，但不会启动空研究消耗模型额度",
      );
    }
  }
  const runId = req.run_id !== undefined ? assertRunId(req.run_id) : `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${symbol}-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = safePath(ctx, "runs", runId);
  fs.mkdirSync(safePath(ctx, "logs"), { recursive: true });
  const log = safePath(ctx, "logs", `${runId}.log`);  // 最终文件也经 safePath(已存在且为链接 → 拒绝)
  const argv = [path.join(ctx.repoRoot, "orchestrator", "src", "run.ts"), "--symbol", symbol, "--run-id", runId, "--python", ctx.python, "--endpoints", scope, "--knowledge", kn];
  if (companyName) argv.push("--company-name", companyName);
  if (market) argv.push("--market", market);
  if (stages.length) argv.push("--stages", stages.join(","));
  if (req.overwrite === true) argv.push("--overwrite");
  if (req.no_agent === true) argv.push("--no-agent");
  // Direct 六阶段没有加载完整宪法 / 专用 skills，只保留在 CLI 实验开关后。
  // 本机订阅 Agent 不从公开 engine 参数进入，只能由下面的已校验 runtimeLlm 内部选中。
  const engine = assertEngine(req.engine);
  if (engine) argv.push("--engine", engine);
  const taskObjective = String(internal.taskObjective ?? "").trim();
  if (taskObjective.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskObjective)) {
    throw new ServiceError("invalid_task_context", "Deep 任务关注点格式无效");
  }
  const reportIds = internal.reportIds === undefined ? [] : [...internal.reportIds];
  if (reportIds.length > 16 || new Set(reportIds).size !== reportIds.length ||
      reportIds.some((id) => !/^[0-9a-f]{32}$/.test(id))) {
    throw new ServiceError("invalid_task_context", "Deep 圈选资料范围无效");
  }
  const reportRevisions = internal.reportRevisions === undefined ? {} : { ...internal.reportRevisions };
  if (Object.keys(reportRevisions).length !== reportIds.length ||
      reportIds.some((id) => !Object.hasOwn(reportRevisions, id) || !/^[a-f0-9]{64}$/.test(String(reportRevisions[id] ?? ""))) ||
      Object.keys(reportRevisions).some((id) => !reportIds.includes(id))) {
    throw new ServiceError("invalid_task_context", "Deep 资料版本范围无效");
  }
  const childEnv = researchEnv(ctx);
  childEnv.VRA_DATA_ROOT = path.resolve(ctx.dataRoot);
  if (runtimeLlm) {
    let runtime: ReturnType<typeof resolveRuntimeProvider>;
    try { runtime = resolveRuntimeProvider(ctx.repoRoot, ctx.dataRoot, runtimeLlm, childEnv); }
    catch (error) {
      throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_llm", error instanceof Error ? error.message : String(error));
    }
    Object.assign(childEnv, runtime.env);
    childEnv.VRA_REQUEST_LLM_META = JSON.stringify(runtime.runtime === "local-agent"
      ? { provider: runtimeLlm.provider }
      : { provider: runtimeLlm.provider,
          ...(runtimeLlm.baseURL !== undefined ? { baseURL: runtimeLlm.baseURL } : {}),
          ...(runtimeLlm.model !== undefined ? { model: runtimeLlm.model } : {}),
          envKey: runtime.profile.env_key });
  }
  if (taskObjective) childEnv.VRA_TASK_OBJECTIVE = taskObjective;
  if (reportIds.length) childEnv.VRA_TASK_REPORT_IDS = reportIds.join(",");
  if (reportIds.length) childEnv.VRA_TASK_REPORT_REVISIONS = JSON.stringify(reportRevisions);
  const out = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW_FLAG, 0o600);
  let control: ReturnType<typeof reserveResearch> | undefined;
  try {
    if (fs.existsSync(runDir) && fs.readdirSync(runDir).length) throw new ServiceError("run_exists", "研究编号已使用，请创建新的研究");
    control = reserveResearch(ctx.dataRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    childEnv.VRA_RESEARCH_CONTROL_TOKEN = control.token;
    const child = spawn(ctx.node, argv, { cwd: ctx.repoRoot, detached: true, windowsHide: true, stdio: ["ignore", out, out], env: childEnv });
    const failed = () => {
      try { updateResearchControl(ctx.dataRoot, runId, control!.token, "failed"); }
      catch (e) { console.error(`[research] 无法记录进程退出:${redact(String(e), 160)}`); }
    };
    child.once("error", failed);
    child.once("close", failed);
    child.unref();
    return { run_id: runId, run_dir: rel(ctx, runDir), log: rel(ctx, log), pid: child.pid };
  } catch (e) {
    if (control) updateResearchControl(ctx.dataRoot, runId, control.token, "failed");
    if (e instanceof ResearchControlError) throw new ServiceError(e.code, e.message);
    throw e;
  } finally {
    fs.closeSync(out);
  }
}

export interface RunStatus { run_id: string; exists: boolean; status: string | null; exit_code: number | null; stages: { stage: string; status: string; attempts: number }[]; evidence_count: number | null; calculation_count: number | null; finished_at: string | null; last_events: Record<string, unknown>[]; report: boolean; viewer: string | null; failure?: ReturnType<typeof researchFailure> }

function runDirOf(ctx: ServiceContext, runId: unknown): { id: string; dir: string } {
  const id = assertRunId(runId);
  return { id, dir: safePath(ctx, "runs", id) };
}

export function researchStatus(ctx: ServiceContext, runId: string, lastEvents = 8): RunStatus {
  const { id, dir: runDir } = runDirOf(ctx, runId);
  const control = readResearchControl(ctx.dataRoot, id);
  const decision = control && !control.finished_at ? researchDecision(ctx.dataRoot, id) : null;
  const controlStatus = control?.finished_at ? control.state : decision === "cancel" ? "cancelling" : decision === "finalize" ? "finalizing" : control ? "running" : null;
  if (!fs.existsSync(runDir)) return { run_id: id, exists: !!control, status: controlStatus, exit_code: control?.finished_at ? 3 : null, stages: [], evidence_count: null, calculation_count: null, finished_at: control?.finished_at ?? null, last_events: [], report: false, viewer: null };
  const m = readJsonIfExists<Record<string, unknown>>(safePath(ctx, "runs", id, "manifest.json"));
  const evPath = safePath(ctx, "runs", id, "events.jsonl");
  let events: Record<string, unknown>[] = [];
  if (fs.existsSync(evPath)) {
    const n = Math.min(Math.max(Number(lastEvents) || 8, 1), 50);
    const lines = fs.readFileSync(evPath, "utf8").trim().split("\n").filter(Boolean);
    events = lines.slice(-n).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l.slice(0, 200) }; } });
  }
  const stages = ((m?.stages as { stage: string; status: string; attempts: number }[] | undefined) ?? []).map((s) => ({ stage: s.stage, status: s.status, attempts: s.attempts }));
  const viewer = fs.existsSync(safePath(ctx, "runs", id, "viewer.html")) ? `runs/${id}/viewer.html` : null;
  const status = m?.finished_at ? (m.cancelled ? "cancelled" : String(m.status)) : controlStatus ?? (m?.status as string) ?? null;
  return { run_id: id, exists: true, status, exit_code: m?.finished_at ? (m.exit_code as number) : control?.finished_at ? 3 : null, stages, evidence_count: (m?.evidence_count as number) ?? null, calculation_count: (m?.calculation_count as number) ?? null,
    finished_at: (m?.finished_at as string) ?? control?.finished_at ?? null, last_events: events, report: fs.existsSync(safePath(ctx, "runs", id, "report.md")), viewer,
    failure: status === "failed" ? researchFailure(m?.failure_code) : null };
}

export function cancelResearch(ctx: ServiceContext, runId: unknown): RunStatus {
  const id = assertRunId(runId);
  const status = researchStatus(ctx, id);
  if (status.finished_at) return status;
  try { requestResearchCancellation(ctx.dataRoot, id); }
  catch (e) { if (e instanceof ResearchControlError) throw new ServiceError(e.code, e.message); throw e; }
  return researchStatus(ctx, id);
}

export function readRunFile(ctx: ServiceContext, runId: string, name: "manifest.json" | "report.md" | "report_appendix.md" | "viewer.html"): string | null {
  const { id } = runDirOf(ctx, runId);
  const p = safePath(ctx, "runs", id, name);
  if (!fs.existsSync(p) || !fs.lstatSync(p).isFile()) return null;
  // The viewer embeds the report too. Keep rejected drafts on disk for diagnosis,
  // but never expose them through any public report-reading entry point.
  if (name !== "manifest.json" && !reportCompletion(ctx, id).ready) return null;
  return fs.readFileSync(p, "utf8");
}

/** Trust the orchestrator's terminal record, not the mere existence of a draft.
 * Legacy manifests may omit gate/final_errors. This is not a tamper-proof seal.
 */
function reportCompletion(ctx: ServiceContext, id: string): { ready: boolean; status: string | null } {
  const m = readJsonIfExists<Record<string, unknown>>(safePath(ctx, "runs", id, "manifest.json"));
  const status = m?.cancelled ? "cancelled" : typeof m?.status === "string" ? m.status : null;
  const gate = m?.gate as { ok?: unknown } | undefined;
  const ready = typeof m?.finished_at === "string" && Number.isFinite(Date.parse(m.finished_at)) &&
    ((status === "complete" && m.exit_code === 0) || (status === "incomplete" && m.exit_code === 2)) &&
    (m.gate === undefined || gate?.ok === true) &&
    (m.final_errors === undefined || (Array.isArray(m.final_errors) && m.final_errors.length === 0));
  return { ready, status };
}

export function getReport(ctx: ServiceContext, runId: string): { run_id: string; report: string | null; appendix: string | null; availability: "ready" | "unvalidated" | "missing"; run_status: string | null } {
  const { id } = runDirOf(ctx, runId);
  const completion = reportCompletion(ctx, id);
  const p = safePath(ctx, "runs", id, "report.md");
  const exists = fs.existsSync(p) && fs.lstatSync(p).isFile();
  const report = exists && completion.ready ? readRunFile(ctx, id, "report.md") : null;
  return { run_id: id, report, appendix: report !== null ? readRunFile(ctx, id, "report_appendix.md") : null,
    availability: report !== null ? "ready" : exists ? "unvalidated" : "missing", run_status: completion.status };
}

export function getEvidence(ctx: ServiceContext, runId: string, filter: { field?: string; source?: string; q?: string; limit?: number } = {}): { run_id: string; total: number; items: Record<string, unknown>[] } {
  const { id } = runDirOf(ctx, runId);
  const merged = readJsonIfExists<Record<string, unknown>[] | { evidence: Record<string, unknown>[] }>(safePath(ctx, "runs", id, "evidence.json"));
  const items: Record<string, unknown>[] = Array.isArray(merged) ? merged : (merged?.evidence ?? []);
  if (!items.length) {
    const fdir = safePath(ctx, "runs", id, "fetch");
    if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      const env = readJsonIfExists<{ evidence?: Record<string, unknown>[] }>(safePath(ctx, "runs", id, "fetch", f));
      items.push(...(env?.evidence ?? []));
    }
  }
  const q = String(filter.q ?? "").toLowerCase().slice(0, 80);
  const field = filter.field === undefined ? undefined : String(filter.field).slice(0, 80);
  const source = filter.source === undefined ? undefined : String(filter.source).slice(0, 80);
  const out = items.filter((e) => (!field || e.field === field) && (!source || e.source === source) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
  const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 2000);
  return { run_id: id, total: out.length, items: out.slice(0, limit) };
}

/**
 * 运行清单。
 *
 * 🔴 除了状态,还要给出**跑了几个阶段** —— 否则一次单阶段冒烟测试与一次完整研究
 *    在列表里长得一模一样(都是 `complete`),用户看到的是"这产品跑出来的东西怎么这么薄"。
 *    阶段数是判断"这是不是一次真研究"的唯一可见依据。
 * ⚠️ `test_scenario` 是**注入了合成数据**的运行:它的结论不能当真实研究看,必须标出来。
 */
/**
 * 「昨天以来变了什么」—— 对齐同一对象最近两次研究，报出**变了 / 新增 / 消失**的事实。
 *
 * 🔴 这条能力 `alerts.ts` 一直都有（对齐口径、期间、来源，同源矛盾拒绝静默取舍），
 *    但**从没暴露成接口**，界面自然也没有入口。而它恰恰是"用户明天还要回来"的那一条：
 *    没有人每天重读一遍静态资料，但每天都会想知道**昨天以来变了什么**。
 *
 * ⚠️ 不足两次运行时**抛错，不返回空列表** —— 空列表会被读成"什么都没变"，
 *    而真相是"还没有可比较的第二次"。这两件事完全不同。
 */
export function evidenceAlerts(
  ctx: ServiceContext,
  req: { symbol: string; market?: string; base?: string; next?: string },
): { symbol: string; base: string; next: string; diffs: AlertDiff[] } {
  const symbol = String(req.symbol ?? "").trim();
  if (!symbol) throw new ServiceError("bad_symbol", "要给一个代码");
  try {
    const r = runAlerts({
      symbol,
      ...(req.market ? { market: req.market } : {}),
      ...(req.base ? { base: req.base } : {}),
      ...(req.next ? { next: req.next } : {}),
      repoRoot: ctx.repoRoot,
      dataRoot: ctx.dataRoot,
      persist: false,
    });
    return { symbol, base: r.base, next: r.next, diffs: r.diffs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 「可比较的运行不足两个」是**正常状态**不是故障，给一个调用方能分辨的错误码
    if (/不足两个/.test(msg)) throw new ServiceError("need_two_runs", msg);
    throw new ServiceError("alerts_failed", msg);
  }
}

/**
 * 从已落盘的公司画像证据取简称。归档不为了显示名称再发网络请求，
 * 也不从 agent 写的 summary 里用正则猜。坏文件 / 链接 / 异常形状一律降级为 null。
 */
function runCompanyName(ctx: ServiceContext, runId: string): string | null {
  try {
    const file = safePath(ctx, "runs", runId, "fetch", "fetch_profile.json");
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
    const envelope = readJsonIfExists<{ evidence?: unknown }>(file);
    if (!Array.isArray(envelope?.evidence)) return null;
    const hit = (envelope.evidence as { field?: unknown; value?: unknown }[])
      .find((e) => e?.field === "security_name" && typeof e.value === "string");
    const name = typeof hit?.value === "string" ? hit.value.trim() : "";
    return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function listRuns(ctx: ServiceContext, limit = 50): { run_id: string; status: string | null; symbol: string | null; name: string | null; market: string | null; started_at: string | null; finished_at: string | null; stages_done: number | null; stages_total: number | null; test_scenario: boolean }[] {
  const root = path.join(path.resolve(ctx.dataRoot), "runs");
  if (!fs.existsSync(root)) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return fs.readdirSync(root).filter((d) => RUN_ID_RE.test(d) && fs.lstatSync(path.join(root, d)).isDirectory()).sort().reverse().slice(0, n).map((d) => {
    let m: Record<string, unknown> | null = null;
    try { const mp = safePath(ctx, "runs", d, "manifest.json"); if (fs.existsSync(mp) && fs.lstatSync(mp).isFile()) m = readJsonIfExists<Record<string, unknown>>(mp); } catch { m = null; }  // manifest 是链接 → 当作不可读
    // 阶段明细读不出来时给 null,**不给 0** —— 0 会被读成"一个阶段都没跑",而真相是"不知道"
    const st = Array.isArray(m?.stages) ? (m.stages as { status?: unknown }[]) : null;
    let controlStatus: string | null = null;
    let controlFinished: string | null = null;
    try {
      const control = readResearchControl(ctx.dataRoot, d);
      const decision = control && !control.finished_at ? researchDecision(ctx.dataRoot, d) : null;
      controlStatus = control ? (control.finished_at ? control.state : decision === "cancel" ? "cancelling" : decision === "finalize" ? "finalizing" : "running") : null;
      controlFinished = control?.finished_at ?? null;
    } catch { controlStatus = "unknown"; }
    return {
      run_id: d,
      status: m?.finished_at ? (m.cancelled ? "cancelled" : String(m.status)) : controlStatus ?? (m?.status as string) ?? null,
      symbol: (m?.symbol as string) ?? null,
      name: runCompanyName(ctx, d),
      // 🔴 市场要一起给：同一代码不同市场**不是时间序列**，比较两次运行必须同市场
      //    （alerts 那条链路会为此报错）。前端猜不出来，只能由这里下发。
      market: (m?.market as string) ?? null,
      started_at: (m?.started_at as string) ?? null,
      finished_at: (m?.finished_at as string) ?? controlFinished,
      stages_done: st ? st.filter((s) => s?.status === "complete").length : null,
      stages_total: st ? st.length : null,
      test_scenario: m?.test_scenario === true,
    };
  });
}

export function knowledgeRecall(ctx: ServiceContext, symbol: string, market: string): (Omit<KnowledgeRecall, "path"> & { path: string }) | null {
  const sym = assertSymbol(symbol, "cn6");
  const mk = assertMarket(market);
  safePath(ctx, "knowledge", "companies", `${mk || "XX"}_${sym}`, "latest.md");
  const k = recallKnowledge({ dataRoot: ctx.dataRoot, symbol: sym, market: mk });
  return k ? { ...k, path: rel(ctx, k.path) } : null;
}

// ---------------- 用户自有台账 ----------------
// 存储与校验都在 Core 的 ledger.ts;这一层只做两件事:
// ① 把 LedgerError 翻译成 ServiceError(HTTP 层只认后者,否则 500 而不是 400)
// ② 走一次 safePath —— ledger.ts 已按白名单挡住 kind,这里是**第二道**,
//    专门挡"用户数据区里被人塞了符号链接"这类与 kind 无关的情形。

/** 台账的记录种类(界面据此渲染表单);垂类没声明台账就是空表 */
/* ---------------- 界面查询(BFF):按名字要一屏数据 ---------------- */

export interface PageBlockResult {
  id: string; title: string; note?: string;
  /** 默认收起(界面的事;数据照常取回) */
  collapsed?: boolean;
  /**
   * 🔴 **跟着信封走,不是"调用没抛异常"就算 ok**。
   *    取数器可以正常退出却在信封里写 `status:"failed"`(如上游改了签名、参数不被接受),
   *    此前这里一律记成 ok ⇒ 一个证据 0 条、带 traceback 的块在界面上显示成正常,
   *    而调用方按 status 做的"缺口保护"永远不会触发 —— **看着在保护,其实一条都匹配不上**。
   *  missing = 取数调用本身失败(抛异常);failed / partial = 取数器跑了但自报没取全。
   */
  status: "ok" | "partial" | "failed" | "missing";
  /** 取不到时说清是什么问题(界面要显示,不能只留空白) */
  error?: string;
  fetched_at?: string; cached?: boolean;
  /**
   * 这一块允许用户改的参数键 + 当前生效值。
   * 🔴 界面**照它渲染选择器**,不自己写死一份可选项 —— 写死的那份迟早与后端对不上,
   *    而对不上的表现是"选了没反应"或"选项里没有真实存在的那个"。
   */
  user_args?: readonly string[];
  applied_args?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
}

export interface PageResult {
  query: string; title: string; intent: string;
  /** 业务日期上下文(这一页在看哪一天、为什么)。不需要解析的页面为 null */
  context: Record<string, unknown> | null;
  blocks: PageBlockResult[];
  /** 整屏最旧的取数时刻。**整页的新鲜度不能好过它最差的那一块** */
  oldest_fetched_at: string | null;
  /**
   * 各块的取数时刻是否跨了不同的天。
   * 🔴 只在每块标"X 分钟前"不够:一屏并排的几块可能差好几天,而用户会把它们当成同一时刻的快照
   *    (Codex 架构评审 arch-r1 §F-1)。
   */
  mixed_ages: boolean;
}

/**
 * 取一屏数据。**页面只说自己要哪个查询,不点名物理端点**。
 * 端点改名 / 换源在这里吸收;界面上也就不会再印出 `em_limit_up_sentiment` 这种东西。
 */
/**
 * 从调用方传来的参数里,**只挑出这一块允许用户改的那几个键**。
 *
 * 🔴 白名单是唯一的门:没声明 `userArgs` 的块,调用方传什么都不生效。
 *    反过来做(黑名单 / 只挡几个危险键)迟早漏 —— 而漏掉的表现是
 *    "这一块回答的问题被悄悄换掉了",页面上完全看不出来。
 * ⚠️ 只挑键,不判值:值合不合法由端点自己的 `assertArgs` 判(两道各管一件事)。
 */
function pickUserArgs(b: { userArgs?: readonly string[] }, given: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!b.userArgs?.length || !given || typeof given !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of b.userArgs) {
    if (Object.prototype.hasOwnProperty.call(given, k) && given[k] !== undefined) out[k] = given[k];
  }
  return out;
}

/**
 * 信封状态 → 块状态。**"取数调用没抛异常"不等于 ok** ——
 * 取数器可以正常退出却在信封里写 `status:"failed"`(上游改了签名、参数不被接受…)。
 * 信封没说 / 说了个没见过的值 → 保守当 failed:**不许把"不知道"渲染成正常**。
 * (抽成纯函数是为了能直接测这条映射;生产路径调的就是它。)
 */
export function blockStatusFromEnvelope(envelope: unknown): PageBlockResult["status"] {
  const es = (envelope as { status?: unknown } | null)?.status;
  return es === "ok" ? "ok" : es === "partial" ? "partial" : "failed";
}

/**
 * 按块声明的 `injectAs` **选取并改名**上下文参数。
 * **必须声明**(注册期强制);声明了就**只注入列出的键**,并改成端点认的名字。
 *
 * 🔴 "只注入列出的" 这条是必须的:上下文会同时产出同一概念的多种写法
 *    (如日期的 `YYYY-MM-DD` 与 `YYYYMMDD`),整包塞给端点,多出来的那个键会被
 *    参数白名单当场拒掉 —— 一屏的块会成片 missing。
 * 🔴 声明了却**取不到**那个源键 → 抛错,**不许静默跳过**:跳过之后端点会按自己的默认值
 *    (通常是"最近一期")取数,结果看着完全正常、其实不是你要的那一期 —— 又是一次
 *    "把配置错误伪装成正常数据"。(源键拼错、或上下文改名后块没同步,都会走到这。)
 */
function selectInject(src: Record<string, unknown>, map?: Readonly<Record<string, string>>): Record<string, unknown> {
  // 注册期已强制"吃上下文就必须声明 injectAs" —— 到这里还没有,说明校验被绕过了,不许静默整包塞
  if (!map) throw new ServiceError("bad_plugin", "块声明了 injectContext 却没有 injectAs(注册期校验应已拦下)");
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(map)) {
    if (!Object.prototype.hasOwnProperty.call(src, from))
      throw new ServiceError("bad_plugin", `injectAs 要的上下文键 ${show(from)} 不存在(上下文实际给出:${Object.keys(src).join(", ") || "无"})`);
    out[to] = src[from];
  }
  return out;
}

export async function pageQuery(
  ctx: ServiceContext,
  req: { query: string; symbol?: string; refresh?: boolean; blockArgs?: Record<string, Record<string, unknown>>; signal?: AbortSignal },
): Promise<PageResult> {
  const defs = currentPlugin().pageQueries ?? {};
  const name = String(req.query ?? "");
  if (!Object.prototype.hasOwnProperty.call(defs, name)) {
    throw new ServiceError("unknown_query", `没有这个界面查询:${show(req.query)};可用:${Object.keys(defs).join(", ") || "(垂类没声明)"}`);
  }
  const def = defs[name]!;
  const consistency: Consistency = req.refresh ? { mode: "fresh" } : DEFAULT_CONSISTENCY;

  // ① 先解析业务日期(如果这一页要)。日历端点自己声明了"从不缓存",所以这里拿到的是当下的时段。
  let context: Record<string, unknown> | null = null;
  let injected: Record<string, unknown> = {};
  /** 上下文没解析出来 —— 吃上下文的块要如实失败,不许按上游默认值取数 */
  let ctxUnavailable = false;
  const ctxDef = currentPlugin().pageContext;
  if (def.needsContext && ctxDef) {
    // 🔴 解析上下文的那次取数**必须 fresh**:它算的是"此刻"(如当前时段),缓存住会被永久冻结。
    //    端点自己也声明了从不缓存,这里是第二道 —— 同一个不变量两边都守,不指望另一边。
    const probe = await fetchEndpoint(ctx, {
      endpoint: ctxDef.endpoint,
      ...(ctxDef.symbol ?? req.symbol ? { symbol: ctxDef.symbol ?? req.symbol } : {}),
      consistency: { mode: "fresh" },
      signal: req.signal,
    });
    const resolved = ctxDef.resolve(probe.envelope);
    if (resolved) {
      context = resolved.values;
      injected = resolved.inject;
    } else {
      // 🔴 拿不到就**说出来**,别默默按默认值取 —— 那会让整页显示错误的业务日期且看不出来
      ctxUnavailable = true;
      context = { error: ctxDef.unavailable };
    }
  }

  // ② 各块并发取(single-flight 会把指向同一端点的块合并成一次真取数)
  const blocks = await Promise.all(
    def.blocks.map(async (b): Promise<PageBlockResult> => {
      const used = pickUserArgs(b, req.blockArgs?.[b.id]);
      try {
        /**
         * 🔴 上下文没解析出来(如日历取不到)时,吃上下文的块**不许照常取**:
         *    端点会按自己的默认值(通常是"最近一期")给数,页面上那一屏顶着
         *    "拿不到上下文"的横幅、下面却是一屏看着正常的数字 —— 用户会照着它做判断。
         *    ⇒ 如实标成失败,把原因原样说出来。
         */
        if (b.injectContext && ctxUnavailable)
          throw new ServiceError("context_unavailable", ctxDef?.unavailable ?? "拿不到这一屏的上下文");
        const r = await fetchEndpoint(ctx, {
          endpoint: b.endpoint,
          ...(b.symbol ?? req.symbol ? { symbol: b.symbol ?? req.symbol } : {}),
          // 只有声明了 injectContext 的块才吃上下文参数 —— 不吃的端点会被参数校验当场拒
          // 🔴 用户改的参数**只认白名单里的键**:调用方传来的任何其它键一律丢掉。
          //    白名单是垂类声明的(`userArgs`),没声明就是一个都不许改。
          // 注入前先按块声明的改名表改键(端点之间同一概念参数名不同 —— 见 injectAs)
          args: { ...(b.args ?? {}), ...(b.injectContext ? selectInject(injected, b.injectAs) : {}), ...used },
          consistency,
          signal: req.signal,
        });
        const userArgs = b.userArgs?.length ? { user_args: b.userArgs, applied_args: { ...(b.args ?? {}), ...used } } : {};
        const st = blockStatusFromEnvelope(r.envelope);
        return { id: b.id, title: b.title, ...(b.note ? { note: b.note } : {}), ...(b.collapsed ? { collapsed: true } : {}), ...userArgs, status: st, fetched_at: r.fetched_at, cached: r.cached, envelope: r.envelope };
      } catch (e) {
        // 一块取不到不该让整屏空白 —— 但也**不能装作没事**:如实标出来
        return { id: b.id, title: b.title, ...(b.note ? { note: b.note } : {}), status: "missing", error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const times = blocks.map((b) => b.fetched_at).filter((t): t is string => Boolean(t));
  const days = new Set(times.map((t) => t.slice(0, 10)));
  return {
    query: name, title: def.title, intent: def.intent, context, blocks,
    oldest_fetched_at: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
    mixed_ages: days.size > 1,
  };
}

export function ledgerKinds(_ctx: ServiceContext): Record<string, { label: string; properties: Record<string, unknown>; required: string[] }> {
  const out: Record<string, { label: string; properties: Record<string, unknown>; required: string[] }> = {};
  for (const [k, def] of Object.entries(ledgerKindDefs())) {
    out[k] = { label: def.label, properties: { ...def.properties }, required: [...def.required] };
  }
  return out;
}

/**
 * 字段 / 枚举的显示名。**Core 一个都不认识** —— 原样透传给界面。
 * 没声明的字段界面退回原键名,所以这里不做补全、也不报缺。
 */
export function ledgerLabels(_ctx: ServiceContext): { fields: Record<string, string>; enums: Record<string, string> } {
  const l = ledgerLabelDefs();
  return { fields: { ...l.fields }, enums: { ...l.enums } };
}

/**
 * 产品当前的有效配置(给"设置"页看)。
 *
 * 🔴🔴 **绝不返回任何密钥值**。这里只给:
 *    · `env_key` —— 环境变量的**名字**(如 `MIMO_API_KEY`),不是它的值;
 *    · `key_present` —— 那个变量**有没有被设**,一个布尔。
 *    密钥只从环境变量读、不进配置文件、更不进浏览器 —— 这条是产品红线,
 *    所以"设置"页在我们这儿**是只读的**:改 provider 要动配置文件 + 环境变量,
 *    不给一个"把 key 粘进来"的输入框。
 * ⚠️ 宽松模式加载:缺密钥时**照常返回配置**并把问题放在 `auth_error` 里 ——
 *    严格模式会直接抛,那样设置页在"配置有问题"时反而什么都显示不出来,
 *    而那恰恰是最需要看它的时候。
 */
/**
 * 供展示的 URL:**剥掉用户名 / 密码 / 查询串 / 片段**。
 * 🔴 主密钥确实只在环境变量里,但 `base_url` 是用户可以自己编辑的 ——
 *    `https://user:secret@host/v1` 或 `https://host/v1?api_key=…` 会**原样**回到界面。
 *    (审计 pages-r1-P1:实测"响应里没有 key 全文"只证明当前这条成功路径安全,
 *     证明不了别的 provider 配法。)
 * ⚠️ 解析不了就返回一个说明,**不回原串** —— 回原串等于"解析失败时反而全暴露"。
 */
export function displayUrl(raw: string | null): string | null {
  if (!raw) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "(这个 base_url 解析不了,为安全起见不显示原文)";
  }
  // 🔴 **只放行 http(s)**。`data:` / `blob:` 之类整段内容都在 path 里,剥 query 剥不掉它;
  //    自定义 scheme 也可能把凭据塞在别处(审计 pages-r2-P1)。
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `(base_url 不是 http(s):${u.protocol} —— 为安全起见不显示原文)`;
  }
  // 🔴 **只回 origin**。正着拼、不反着剥 —— "把已知的几处清空"是黑名单思路,漏一处就全暴露。
  //    ⚠️ 连 pathname 都不回:有些供应商把密钥放在**路径段**里
  //    (`https://host/v1/sk-…/chat`),剥 query 剥不掉它(审计 pages-r3)。
  //    也不去猜"哪一段像密钥" —— 按关键词判断迟早看走眼。
  //    这一页要回答的是"我现在连的是谁",origin 已经够;要精确 URL 就去看自己的配置文件。
  const segs = u.pathname.split("/").filter(Boolean).length;
  const hidden = [segs ? `${segs} 段路径` : "", u.username || u.password ? "凭据" : "", u.search ? "查询串" : ""].filter(Boolean);
  return u.origin + (hidden.length ? `  (已隐藏:${hidden.join(" / ")})` : "");
}

export function productInfo(ctx: ServiceContext): Record<string, unknown> {
  const pc = loadProductConfig(ctx.repoRoot, { requireAuth: false });
  const envKey = pc.provider.env_key;
  return {
    version: productVersion(),
    provider: {
      name: pc.provider.name,
      profile: pc.provider.profile ?? null,
      wire_api: pc.provider.wire_api,
      base_url: displayUrl(pc.provider.base_url),
      auth: pc.provider.auth,
      env_key: envKey,
      // 只报"有没有",不报是什么
      key_present: pc.provider.auth !== "api_key" || Boolean(envKey && process.env[envKey]),
    },
    defaults: { ...pc.defaults },
    /**
     * 产品自带的 provider 模板 —— 界面据此标「已实测 / 有模板未实测」。
     * 🔴 由后端下发,前端不写死一份:写死的那份迟早与 `providers/` 目录对不上,
     *    而对不上的表现是「选了没反应」或「真实存在的选项不在列表里」,两种都看不出是配置漂移。
     * 🔴 下发的是**每份模板自己声明的矩阵状态**,不是"目录里有这个文件"——
     *    6 份模板里只有 2 份真跑过,按文件存在来标会在界面上造出 4 条假的「已实测」。
     */
    provider_templates: templateMatrix(ctx.repoRoot, pc.resolved.dataRoot),
    paths: { data_root: pc.resolved.dataRoot, codex_home: pc.resolved.codexHome, python: ctx.python },
    /** 这份配置是由哪几层合出来的(产品默认 ← 用户配置 ← 环境变量) */
    sources: [...pc.sources],
    // 当前它是我们自己的固定措辞(只含变量**名**),过一遍 redact 是纵深防御:
    // 哪天有别的分支往里塞异常原文,这里不至于直接外传。
    auth_error: pc.authError ? redact(pc.authError, 300) : null,
  };
}

/** 设置页的真实本机运行时状态。只返回可公开的版本与布尔状态，不返回路径、账号或组织。 */
export async function localAgents(ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus[]> {
  const pc = loadProductConfig(ctx.repoRoot, { requireAuth: false, env });
  const codexBin = pc.resolved.codexPath ?? sdkCodexVersion().binary;
  return await Promise.all([
    probeCodex(codexBin, pc.resolved.codexHome, env),
    probeClaude(env),
    probeCodeBuddy(env),
  ]);
}

/** 启动产品隔离 CODEX_HOME 的官方浏览器登录；绝不复用或改写用户全局 ~/.codex。 */
export function startCodexSubscriptionLogin(
  ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env,
): { state: "started" | "pending" } {
  const pc = loadProductConfig(ctx.repoRoot, { requireAuth: false, env });
  const codexBin = pc.resolved.codexPath ?? sdkCodexVersion().binary;
  try {
    return startCodexLogin(codexBin, pc.resolved.codexHome, env);
  } catch (e) {
    if (e instanceof LocalAgentError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

/**
 * 开一场多空辩论:**现在**把资料包拉一次,之后所有角色共用这一份。
 *
 * 🔴 资料包一律 `fresh` 取 —— 辩论要在"此刻的事实"上打。读上次的快照会出现
 *    "双方在昨天的数字上吵今天的事",而页面上完全看不出来。
 * ⚠️ 单个端点取失败**不中止**:记进 gaps 一起交给双方("这些没取到,别当它们不存在")。
 *    全部失败才拒开(见 debate.startDebate)。
 */
export async function debateStart(ctx: ServiceContext, req: { symbol: string; session?: string; depth?: string; llm?: unknown; executionMode?: unknown }, signal?: AbortSignal): Promise<DebateState> {
  if (signal?.aborted) throw new ServiceError("cancelled", "辩论请求已取消");
  let mode: "agent" | "direct";
  try { mode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  if (mode === "direct") throw new ServiceError("agent_required", "多空辩论需要 Agent，请先开启 Vibe Research Agent");
  const llm = checkLlmShape(req.llm);
  assertAgentRuntime(ctx, llm);
  const sourceFingerprint = sourceFingerprintOf(ctx, llm);
  const def = currentPlugin().debate;
  if (!def) throw new ServiceError("not_supported", "这个垂类没有声明辩论");
  const symbol = assertSymbol(req.symbol, "cn6");
  // ⚠️ 加随机量:只用毫秒时间戳的话,同一毫秒开两场会拿到同一个 id,
  //    第二场直接覆盖第一场(审计 pages-r1-P3)。
  const id = String(req.session ?? "").trim() || `d${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  if (!SESSION_RE.test(id)) throw new ServiceError("bad_session", `非法辩论 id ${show(req.session)}`);

  const envelopes: { script?: string; evidence?: unknown[] }[] = [];
  const gaps: string[] = [];
  for (const ep of def.dossierEndpoints) {
    if (signal?.aborted) throw new ServiceError("cancelled", "辩论请求已取消");
    try {
      const r = await fetchEndpoint(ctx, { endpoint: ep, symbol, consistency: { mode: "fresh" }, signal });
      envelopes.push(r.envelope as { script?: string; evidence?: unknown[] });
      const env = r.envelope as { status?: unknown; degraded?: unknown };
      if (env.status !== "ok") gaps.push(`${ep}:${String(env.status)}${env.degraded ? ` — ${String(env.degraded)}` : ""}`);
    } catch (e) {
      if (signal?.aborted) throw new ServiceError("cancelled", "辩论请求已取消");
      gaps.push(`${ep}:取数失败 — ${redact(e instanceof Error ? e.message : String(e), 120)}`);
    }
  }
  try {
    if (signal?.aborted) throw new ServiceError("cancelled", "辩论请求已取消");
    return startDebate({ id, symbol, envelopes, gaps, sourceFingerprint, ...(req.depth ? { depth: req.depth } : {}) });
  } catch (e) {
    if (e instanceof DebateError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

/** 跑下一个待跑的阶段(一次一个,界面据此逐段显示) */
export async function debateAdvance(ctx: ServiceContext, req: { id: string; llm?: unknown; executionMode?: unknown }, signal?: AbortSignal): Promise<DebateState> {
  let mode: "agent" | "direct";
  try { mode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  if (mode === "direct") throw new ServiceError("agent_required", "多空辩论需要 Agent，请先开启 Vibe Research Agent");
  const llm = checkLlmShape(req.llm);
  assertAgentRuntime(ctx, llm);
  const sourceFingerprint = sourceFingerprintOf(ctx, llm);
  try {
    return await advanceDebate(
      { repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, signal },
      { id: String(req.id), sourceFingerprint },
      llm ? async (message, session, signal) => (await chatSendCore(
        { repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, persistent: false, maxMessage: MAX_DEBATE_MESSAGE, timeoutMs: DEBATE_TURN_TIMEOUT_MS, signal },
        { message, session, llm },
      )).reply : undefined,
    );
  } catch (e) {
    if (e instanceof DebateError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

function asServiceError(e: unknown): never {
  if (e instanceof LedgerError) throw new ServiceError(e.code, e.message);
  throw e;
}

function ledgerGuard(ctx: ServiceContext, kind: unknown): string {
  const k = String(kind ?? "");
  if (!Object.prototype.hasOwnProperty.call(ledgerKindDefs(), k)) throw new ServiceError("unknown_kind", `台账没有这个种类 ${show(kind)}`);
  safePath(ctx, "ledger", `${k}.json`);
  return k;
}

export function ledgerList(ctx: ServiceContext, kind?: string): Record<string, LedgerRecord[]> {
  try {
    if (kind === undefined) {
      // 🔴 全量读取也要逐种类过一遍 safePath。原来这里直接调 listAll ——
      //    于是"单个种类走第二道防线、全量入口不走",而全量恰恰是界面的主入口:
      //    ledger 目录里若被放了指向数据区外的符号链接,单查挡得住、全查挡不住。
      //    **防线只在次要入口生效 = 没有防线。**
      return ledgerSnapshot(ctx).records;
    }
    const k = ledgerGuard(ctx, kind);
    return { [k]: listRecordsOf(ctx.dataRoot, k) };
  } catch (e) { asServiceError(e); }
}

/**
 * 界面的主入口:**一次读盘**同时给出记录与问题清单。
 *
 * 🔴 不要分两次调(先 list 再 issues)。两次之间文件可能被改 ⇒ 响应里 records 是旧版本、
 *    issues 是新版本:界面会显示"这几条都合规",而它展示的恰恰是那几条坏的;
 *    反过来也可能出现 issue 指向一个响应里根本不存在的 id。
 *    **同一个响应里的两半必须来自同一次读取。**
 */
/**
 * 温度计历史序列(只读)。
 *
 * 🔴 端点 id 只接受**注册表里真实存在**的那些 —— 它会被拼进文件路径,
 *    直接拿用户给的字符串去拼路径就是目录穿越。用白名单比做路径清洗可靠:
 *    清洗规则总有想不到的编码形式,而"不在注册表里就拒绝"没有想不到的情形。
 * ⚠️ 序列**只在完整研究运行时才追加**。手动点看板不写序列 ⇒ 观测很稀疏是正常的,
 *    不是坏了。给出 `observations` 的真实条数,让界面自己说清楚。
 */
export function thermoSeries(ctx: ServiceContext, endpoint: string): {
  endpoint: string; observations: unknown[]; exists: boolean; unreadable: boolean; dropped: number;
} {
  const known = listEndpoints(ctx, { for_ui: false }).some((e) => e.id === endpoint);
  if (!known) throw new ServiceError("unknown_endpoint", `未知端点:${endpoint}`);
  const read = currentPlugin().seriesFor;
  // 垂类没有序列这回事 ⇒ 明说"这个垂类不提供",不要返回空数组冒充"没有观测"
  if (!read) throw new ServiceError("no_series", "当前垂类不提供观测序列");
  const r = read(ctx.dataRoot, endpoint);
  return { endpoint, observations: r.observations, exists: r.exists, unreadable: r.unreadable, dropped: r.dropped };
}

export function ledgerSnapshot(ctx: ServiceContext): {
  records: Record<string, LedgerRecord[]>;
  issues: Record<string, LedgerIssue[]>;
} {
  try {
    const records: Record<string, LedgerRecord[]> = Object.create(null);
    const issues: Record<string, LedgerIssue[]> = Object.create(null);
    for (const k of Object.keys(ledgerKindDefs())) {
      ledgerGuard(ctx, k); // 每个种类都过第二道 safePath(与单查同口径)
      const r = listRecordsChecked(ctx.dataRoot, k);
      records[k] = r.records;
      if (r.issues.length) issues[k] = r.issues;
    }
    return { records, issues };
  } catch (e) { asServiceError(e); }
}

export function ledgerUpsert(ctx: ServiceContext, req: { kind: string; record: Record<string, unknown> }): LedgerRecord {
  const k = ledgerGuard(ctx, req.kind);
  const rec = req.record;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new ServiceError("bad_record", "record 必须是对象");
  try { return upsertLedgerRecord(ctx.dataRoot, k, rec as Record<string, unknown>); } catch (e) { asServiceError(e); }
}

export function ledgerRemove(ctx: ServiceContext, req: { kind: string; id: string }): { removed: boolean } {
  const k = ledgerGuard(ctx, req.kind);
  try { return { removed: removeLedgerRecord(ctx.dataRoot, k, String(req.id ?? "")) }; } catch (e) { asServiceError(e); }
}

// ---------------- 自由对话 ----------------
// 薄封装:只做错误翻译(HTTP 层只认 ServiceError,否则 500 而不是 400)。
// 沙箱 / 不联网 / 合规 gate 三条硬约束都在 chat.ts 里,这一层不许放宽。

/**
 * 边界上校验 `llm` 的**形状**。
 *
 * 🔴 HTTP 入口的 body 是 `as never` 进来的：`LlmOverride` 只是编译期类型，**运行时不拦任何东西**。
 *    `{"llm":"x"}` 或 `{"llm":{"provider":{}}}` 会一路走到下游，轻则 500（对用户是"坏了"不是"填错了"），
 *    重则被隐式字符串化成 `[object Object]` 当 provider / URL / key 用（Codex 审计 r2 P3）。
 * ⚠️ 这里**只查形状不查语义**：provider 认不认识、key 缺不缺，由 `resolveRuntimeProvider` 给
 *    可行动的错误码 —— 两处各查一半才是漂移的来源。
 */
function checkLlmShape(llm: unknown): LlmOverride | undefined {
  // 🔴 只有**没传**才算没传。把显式的 `null` 也当没传，等于给"静默换一家去打"留了条后门 ——
  //    上面那条"传了就必须解析"的规矩会被 `{"llm":null}` 原样绕过（Codex 复审 r3）。
  if (llm === undefined) return undefined;
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) {
    throw new ServiceError("bad_llm", "llm 必须是一个对象");
  }
  const o = llm as Record<string, unknown>;
  const allowed = ["provider", "baseURL", "apiKey", "model"];
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ServiceError("bad_llm", `llm 里有不认识的字段 ${k}（只接受 ${allowed.join(" / ")}）`);
    if (o[k] !== undefined && typeof o[k] !== "string") throw new ServiceError("bad_llm", `llm.${k} 必须是字符串`);
  }
  return o as unknown as LlmOverride;
}

function selectedRuntimeOf(ctx: ServiceContext, llm?: LlmOverride) {
  try {
    return resolveSelectedRuntime(ctx.repoRoot, ctx.dataRoot, llm);
  } catch (error) {
    if (error instanceof RuntimeProviderError) throw new ServiceError(error.code, error.message);
    throw new ServiceError("bad_llm", error instanceof Error ? error.message : String(error));
  }
}

/** Validate source before side effects. Actual execution must retain this source; no fallback. */
function assertAgentRuntime(ctx: ServiceContext, llm?: LlmOverride): void { selectedRuntimeOf(ctx, llm); }

function sourceFingerprintOf(ctx: ServiceContext, llm?: LlmOverride): string {
  try {
    return runtimeSourceFingerprint(ctx.repoRoot, ctx.dataRoot, llm);
  } catch (error) {
    if (error instanceof RuntimeProviderError) throw new ServiceError(error.code, error.message);
    throw new ServiceError("bad_llm", error instanceof Error ? error.message : String(error));
  }
}

export interface ChatServiceResult extends ChatTurnResult {
  report_sources: { id: string; name: string; page: number | null }[];
}

export async function chatSend(
  ctx: ServiceContext,
  req: { session?: string; message: string; llm?: LlmOverride; executionMode?: unknown },
  signal?: AbortSignal,
): Promise<ChatServiceResult> {
  const llm = checkLlmShape(req.llm);
  let executionMode: "agent" | "direct";
  try { executionMode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  try {
    const message = String(req.message ?? "");
    // 🔴 不再对每条消息全库检索：泛词会误召回无关报告并把资料发给模型（#39，判据见 reportRecallPlan）。
    // 不做「跟进沿用上一轮范围」(理由见 reportRecallPlan 文档):不带目标、只是跟进的句子不召回,线程按既有设计随召回集合变化重开。
    const plan = reportRecallPlan(ctx.dataRoot, message, currentPlugin().reportRecall ?? {});
    const reports = plan
      // 明确选中了几份就给几份的位置与字数:「比较这六份报告」选中六份却只注入五份、或 12k 字上限在第六份处停住,
      //   模型会把不完整的比较当成功交出去(Codex r17 / r18 P2)。仍放不下时在上下文末尾明说,让回答带上「比较不完整」。
      ? await reportContextAsync(ctx.dataRoot, plan.query, {
        limit: Math.max(5, plan.reportIds?.length ?? 0),
        ...(plan.reportIds ? { reportIds: plan.reportIds, maxChars: Math.min(40_000, Math.max(12_000, plan.reportIds.length * 4_000)) } : {}),
        // 「所有报告」= 计划已圈定全库:选中的不再按相关性过滤,打 0 分的也注入(Codex r24 P1)
        ...(plan.wantsAll ? { mustInclude: true } : {}),
      }, signal)
      : null;
    // 不完整的几种情形都要明说:字数上限中途停住(truncated);选中份数超过检索的 20 份硬上限 / 有几份没进来
    //   —— 后者 truncated 仍是 false,只看它会把「看了 20 份」当成「看全了 25 份」(Codex r19 / r24)。
    const selected = plan?.reportIds?.length ?? 0;
    const incomplete = reports ? (reports.truncated || (selected > 0 && reports.hits.length < selected)) : false;
    const contextText = reports
      ? (incomplete
        ? `${reports.text}\n\n⚠️ 本轮只放进了 ${reports.hits.length} 份资料${selected ? `(明确选中 ${selected} 份)` : ""};回答里要明确说明比较 / 汇总不完整,不要装作看全了。`
        : reports.text)
      : undefined;
    if (executionMode === "direct") {
      if (!llm) throw new ServiceError("direct_provider_unsupported", "直连模式需要已验证的 API 配置");
      let provider: ReturnType<typeof resolveDirectProvider>;
      try { provider = resolveDirectProvider(ctx.repoRoot, ctx.dataRoot, llm); }
      catch (error) {
        throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "direct_provider_unsupported",
          error instanceof Error ? error.message : String(error));
      }
      let raw: Awaited<ReturnType<typeof chatCompletion>>;
      try {
        raw = await chatCompletion({
          baseURL: provider.baseURL, apiKey: provider.apiKey, model: provider.model, timeoutMs: 120_000, signal,
          messages: [
            { role: "system", content: [
              "你在 Vibe Research 的模型直连模式中回答一次性问题。",
              "不得声称调用了 Agent、工具、网络或持久记忆；只能根据本请求给出的内容作答。",
              "若提供了本地资料，使用资料时保留 [资料:<id> p.<页码>] 引用；没有页码写 p.-，没看到的不猜。",
              "只报可核实信息、分析框架与概率，不给操作建议。",
            ].join("\n") },
            { role: "user", content: contextText ? `${contextText}\n\n---\n\n【问题】\n${message}` : message },
          ],
        });
      } catch (error) {
        if (error instanceof DirectTransportError) {
          const msg = error.code === "cancelled" ? "直连请求已取消"
            : error.code === "timeout" ? "直连模型请求超时"
              : error.status !== null ? `直连模型返回 ${error.status}` : "无法连接直连模型";
          throw new ServiceError(error.code, msg);
        }
        throw error;
      }
      const gated = applyGate(String(raw.message.content ?? ""));
      const citationErrors = reportCitationErrors(gated.reply, reports?.hits ?? []);
      if (citationErrors.length) {
        throw new ServiceError("report_citation_invalid", citationErrors.join("；"));
      }
      const citations = reportCitations(gated.reply);
      const used = new Set(citations.map((x) => `${x.id}\u0000${x.page ?? "-"}`));
      return {
        session: String(req.session ?? "direct"), reply: gated.reply, redacted: gated.redacted,
        duration_ms: raw.durationMs,
        report_sources: reports?.hits.filter((x) => used.has(`${x.id}\u0000${x.page ?? "-"}`))
          .map((x) => ({ id: x.id, name: x.name, page: x.page })) ?? [],
      };
    }
    const turn = await chatSendCore(
      {
        repoRoot: ctx.repoRoot,
        dataRoot: ctx.dataRoot,
        python: ctx.python,
        signal,
        ...(reports && contextText ? {
          contextText,
          reportSources: reports.hits.map((x) => ({ id: x.id, name: x.name, page: x.page })),
        } : {}),
      },
      { ...req, ...(llm ? { llm } : {}) },
    );
    const used = new Set(reportCitations(turn.reply).map((x) => `${x.id}\u0000${x.page ?? "-"}`));
    return {
      ...turn,
      report_sources: reports?.hits
        .filter((x) => used.has(`${x.id}\u0000${x.page ?? "-"}`))
        .map((x) => ({ id: x.id, name: x.name, page: x.page })) ?? [],
    };
  } catch (e) {
    if (e instanceof ChatError) throw new ServiceError(e.code, e.message);
    if (e instanceof ReportLibraryError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

// ---------------- 用户资料库 ----------------
// 原文件与提取文本都在用户数据根；API 只返回展示字段，不回传 sha256 / 磁盘路径。
export interface ReportSummary {
  id: string; name: string; size: number; ext: string; ts: number; uploaded_at: string;
  chars: number; pages: number | null; truncated: boolean; symbols: string[];
}

const reportSummary = (r: ReportRecord): ReportSummary => ({
  id: r.id, name: r.name, size: r.size, ext: r.ext.replace(/^\./, "").toUpperCase(), ts: r.ts, uploaded_at: r.uploaded_at,
  chars: r.chars, pages: r.pages, truncated: r.truncated, symbols: [...r.symbols],
});

export function reportsList(ctx: ServiceContext): ReportSummary[] {
  try { return listStoredReports(ctx.dataRoot).map(reportSummary); }
  catch (e) { if (e instanceof ReportLibraryError) throw new ServiceError(e.code, e.message); throw e; }
}

export async function reportUpload(ctx: ServiceContext, req: { name?: unknown; content?: unknown }): Promise<ReportSummary> {
  try { return reportSummary(await addReport(ctx.dataRoot, { name: req?.name, content: req?.content })); }
  catch (e) { if (e instanceof ReportLibraryError) throw new ServiceError(e.code, e.message); throw e; }
}

export async function reportDelete(ctx: ServiceContext, req: { id?: unknown }): Promise<{ removed: boolean }> {
  try { return { removed: await removeReport(ctx.dataRoot, req?.id) }; }
  catch (e) { if (e instanceof ReportLibraryError) throw new ServiceError(e.code, e.message); throw e; }
}

export function reportDownload(ctx: ServiceContext, id: unknown): { report: ReportSummary; path: string } | null {
  try { const found = reportFile(ctx.dataRoot, id); return found ? { report: reportSummary(found.record), path: found.path } : null; }
  catch (e) { if (e instanceof ReportLibraryError) throw new ServiceError(e.code, e.message); throw e; }
}

/** 标题翻译专用入口：固定 developer 指令 + schema + 一次性线程，不能退化成普通对话。 */
export async function translateHeadlines(
  ctx: ServiceContext,
  req: { items: { id: string; title: string }[]; llm?: LlmOverride; executionMode?: unknown },
  signal?: AbortSignal,
): Promise<HeadlineTranslationResult> {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new ServiceError("bad_translation_items", "标题翻译请求必须是对象");
  const llm = checkLlmShape(req.llm);
  let executionMode: "agent" | "direct";
  try { executionMode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  try {
    if (executionMode === "direct") {
      if (!llm) throw new ServiceError("direct_provider_unsupported", "直连翻译需要已验证的 API 配置");
      const provider = resolveDirectProvider(ctx.repoRoot, ctx.dataRoot, llm);
      const prepared = prepareHeadlineTranslation(req.items);
      const reply = await chatCompletion({
        baseURL: provider.baseURL, apiKey: provider.apiKey, model: provider.model,
        timeoutMs: 120_000, signal,
        messages: [
          { role: "system", content: prepared.developerInstructions },
          { role: "user", content: JSON.stringify({ items: prepared.items }) },
        ],
        responseFormat: provider.structuredOutput === "server_schema"
          ? { type: "json_schema", json_schema: { name: "headline_translation", strict: true, schema: prepared.schema } }
          : undefined,
      });
      return parseHeadlineTranslationReply(String(reply.message.content ?? ""), prepared.items, reply.durationMs);
    }
    return await translateHeadlinesCore(
      { repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, signal },
      { items: req.items, ...(llm ? { llm } : {}) },
    );
  } catch (e) {
    if (e instanceof ChatError || e instanceof RuntimeProviderError) throw new ServiceError(e.code, e.message);
    if (e instanceof DirectTransportError) {
      const message = e.code === "cancelled" ? "直连翻译已取消" : e.code === "timeout" ? "直连翻译超时" : "直连翻译失败";
      throw new ServiceError(e.code, message);
    }
    throw e;
  }
}

/**
 * 连接探针（设置页「测试并保存」专用）。与 /chat 分开：固定令牌、不召回资料、一次性线程。
 * 不接收客户端任意 message —— 否则它就成了绕开资料纪律的第二个聊天入口。
 */
export async function llmProbe(ctx: ServiceContext, req: { llm?: LlmOverride }, signal?: AbortSignal): Promise<LlmProbeResult> {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new ServiceError("bad_probe_request", "连接检测请求必须是对象");
  const llm = checkLlmShape(req.llm);
  try {
    const result = await llmProbeCore(
      { repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, signal },
      llm ? { llm } : {},
    );
    if (!llm) return { ...result, direct_supported: false, direct_reason: "当前没有请求级 API 配置" };
    try {
      resolveDirectProvider(ctx.repoRoot, ctx.dataRoot, llm);
      return { ...result, direct_supported: true, direct_reason: "该 API 已通过直连能力契约" };
    } catch (error) {
      return { ...result, direct_supported: false,
        direct_reason: error instanceof RuntimeProviderError ? error.message : "该 AI 来源只支持 Agent 模式" };
    }
  } catch (e) {
    if (e instanceof ChatError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

// ---------------- 资料导入 ----------------
// 薄封装:只做错误翻译。转写只产**草稿**,落库仍走正常的台账写入(同一套校验与锁)。

export { MAX_TOTAL_BYTES as IMPORT_MAX_TOTAL_BYTES };

export async function ingestFiles(ctx: ServiceContext, req: { kind: string; files: IngestFileInput[]; note?: string; llm?: unknown; executionMode?: unknown }, signal?: AbortSignal): Promise<IngestResult> {
  let executionMode: "agent" | "direct";
  try { executionMode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  if (executionMode === "direct") throw new ServiceError("agent_required", "资料转写需要 Agent 读取文件，请先开启 Vibe Research Agent");
  const llm = checkLlmShape(req.llm);
  assertAgentRuntime(ctx, llm);
  // 与台账同一把尺子:kind 先过 guard(白名单 + safePath),再进转写
  ledgerGuard(ctx, req.kind);
  safePath(ctx, "import");
  try {
    return await ingestFilesCore({ repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, signal, ...(llm ? { llm } : {}) }, req);
  } catch (e) {
    if (e instanceof IngestError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

/** 工具默认超时:这类工具要先取数再算,比单次取数慢得多 */
const TOOL_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * 跑一个**垂类声明的工具**(`Plugin.tools`)。JSON 进 / JSON 出。
 *
 * 🔴 Core 不知道这些工具各自是干什么的 —— 它只负责起进程、喂 stdin、把 stdout 当 JSON 读回来。
 * ⚠️ 工具**自己**要把"业务上不成立"与"出错了"分开表达(它的 JSON 里怎么写由垂类定);
 *    这里只区分"进程跑起来了没有"。把两者混成一个 HTTP 错误的话,
 *    界面就只能显示"失败了",而用户真正需要看到的往往是那句"为什么不成立"。
 */
export async function runTool(
  ctx: ServiceContext,
  name: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const tools = currentPlugin().tools ?? {};
  const spec = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
  if (!spec) throw new ServiceError("not_found", `没有这个工具:${name}`);

  const input = JSON.stringify(body ?? {});
  const r = await runFetchProcess(ctx.python, ["-m", spec.module], {
    cwd: ctx.repoRoot,
    // 普通工具不调用模型；沿用取数基础白名单，不继承 provider key 或 VRA_* 私密配置。
    env: fetchEnv(),
    timeout: spec.timeoutMs ?? TOOL_DEFAULT_TIMEOUT_MS,
    input,
    signal,
  });
  if (r.status !== 0) {
    const tail = (r.stderr || "").trim().split("\n").slice(-2).join(" / ");
    throw new ServiceError("tool_failed", `${spec.label}没跑起来(退出码 ${r.status}):${redact(tail, 200)}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    // 输出不是 JSON = 工具坏了或者往 stdout 打了别的东西。**把前几百字带出去**,
    // 只说"解析失败"的话没人查得动。
    throw new ServiceError("tool_failed", `${spec.label}的输出不是 JSON:${redact(r.stdout.slice(0, 300), 300)}`);
  }
}

/** HTTP 的原始工具入口也必须带全局执行上下文；不能让旧页面绕过 Agent 开关直接起脚本。 */
export async function runToolRequest(
  ctx: ServiceContext,
  name: string,
  request: unknown,
): Promise<unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ServiceError("bad_tool_request", "工具请求必须是对象");
  }
  const req = request as { input?: unknown; llm?: unknown; executionMode?: unknown };
  const extras = Object.keys(request).filter((key) => !["input", "llm", "executionMode"].includes(key));
  if (extras.length || !Object.prototype.hasOwnProperty.call(request, "input")) {
    throw new ServiceError("bad_tool_request", "工具请求必须只包含 input、executionMode 和可选 llm");
  }
  // 旧客户端只发送工具参数，没有任何全局模式信息。把它默认为 Agent 会让直连页面静默绕过开关。
  if (req.executionMode === undefined) throw new ServiceError("bad_execution_mode", "工具请求必须明确提供 executionMode");
  let mode: "agent" | "direct";
  try { mode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  const llm = checkLlmShape(req.llm);
  const spec = Object.prototype.hasOwnProperty.call(currentPlugin().tools ?? {}, name)
    ? currentPlugin().tools?.[name]
    : undefined;
  if (!spec) throw new ServiceError("not_found", `没有这个工具:${name}`);
  if (spec.requiresAgent !== false) {
    if (mode === "direct") {
      throw new ServiceError("agent_required", "这个工具需要 Agent，请先开启 Vibe Research Agent");
    }
    assertAgentRuntime(ctx, llm);
  }
  return await runTool(ctx, name, req.input);
}

/** 界面要用的工具清单(名字 + 显示名),由垂类下发 —— 前端不写死一份 */
export function listTools(): { name: string; label: string }[] {
  return Object.entries(currentPlugin().tools ?? {}).map(([name, t]) => ({ name, label: t.label }));
}

/** 对话引导 → 参数齐备 → 跑垂类工具 → 生成报告。Core 不认识具体工具参数。 */
export async function guidedToolTurn(
  ctx: ServiceContext,
  name: string,
  req: { session?: unknown; message?: unknown; llm?: unknown; executionMode?: unknown },
  signal?: AbortSignal,
): Promise<GuidedToolReply> {
  const spec = Object.prototype.hasOwnProperty.call(currentPlugin().tools ?? {}, name)
    ? currentPlugin().tools?.[name]
    : undefined;
  if (!spec) throw new ServiceError("not_found", `没有这个工具:${name}`);
  let mode: "agent" | "direct";
  try { mode = assertExecutionMode(req.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  if (mode === "direct") {
    throw new ServiceError("agent_required", "这个功能需要 Agent 调用工具并维持任务状态，请先开启 Vibe Research Agent");
  }
  const llm = checkLlmShape(req.llm);
  assertAgentRuntime(ctx, llm);
  try {
    return await guidedToolTurnCore(
      { repoRoot: ctx.repoRoot, dataRoot: ctx.dataRoot, python: ctx.python, signal },
      {
        name,
        label: spec.label,
        session: String(req.session ?? ""),
        message: String(req.message ?? ""),
        ...(llm ? { llm } : {}),
      },
      { chat: chatSendCore, runTool: (tool, body) => runTool(ctx, tool, body, signal) },
    );
  } catch (e) {
    if (e instanceof GuidedToolError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}
