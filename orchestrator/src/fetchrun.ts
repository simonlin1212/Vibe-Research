/**
 * 取数由编排器执行(取数与解释分阶段,AGENTS.md §5):干净最小环境(无 Codex 凭据)、超时、账本。
 * 权威账本保存在编排器内存(Ledger 对象),同时落盘 fetch/_ledger.json 仅供审计;validator 只信内存账本。
 * 每个脚本执行前后快照 raw/ 目录,新增文件的 sha256 记入账本,使 raw/ 同样受认证。支持故障注入(Scenario)。
 */
import { runResearchProcess } from "./research_process.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fetchEnv, gatePatterns, type RunConfig, type Scenario } from "./config.ts";
import { fetchArgv } from "./registry.ts";
import { listFiles, nowIso, readJsonIfExists, sha256File, writeJson } from "./fsutil.ts";
import { currentPlugin } from "./plugin.ts";

export interface LedgerEntry {
  script: string;
  argv: string[];
  exit_code: number | null;
  duration_ms: number;
  status: "ok" | "partial" | "failed" | "timeout" | "error";
  file: string | null;
  sha256: string | null;
  /** 本次执行新增的 raw 文件 → sha256 */
  raw_files: Record<string, string>;
  started_at: string;
  finished_at: string;
  /** 整个信封由 scenario 伪造(timeout_scripts 等)→ validator 跳过退出码 ↔ status 不变量 */
  injected?: string;
  /** 真实信封上叠加了合成证据(inject_voice):信封与账本仍是真实的,不变量照常生效 */
  synthetic_overlay?: string;
  stage: string;
}

export type Ledger = Record<string, LedgerEntry>;

export const LEDGER_REL = path.join("fetch", "_ledger.json");

/** 只用于审计 / --no-agent 复核已有目录;正式运行中 validator 使用编排器内存账本 */
export function loadLedgerFromDisk(runDir: string): Ledger {
  return readJsonIfExists<Ledger>(path.join(runDir, LEDGER_REL)) ?? {};
}

export function saveLedger(runDir: string, ledger: Ledger): void {
  writeJson(path.join(runDir, LEDGER_REL), ledger);
}

export interface FetchExecutor {
  (cfg: RunConfig, stage: string, scripts: string[], log: (type: string, payload: Record<string, unknown>) => void, ledger: Ledger, signal?: AbortSignal): Ledger | Promise<Ledger>;
}

function failedEnvelope(cfg: RunConfig, script: string, reason: string, injected?: string) {
  return { script, symbol: cfg.symbol, market: cfg.market || "", status: "failed", fetched_at: nowIso(), primary_source: null,
    used_sources: [], evidence: [], extra: { degraded: reason, injected: injected ?? null }, errors: [{ source: "orchestrator", endpoint: script, error: reason, at: nowIso() }], missing: [] };
}

function rawSnapshot(runDir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of listFiles(path.join(runDir, "raw"))) if (!fs.lstatSync(f).isSymbolicLink()) m.set(path.basename(f), sha256File(f));
  return m;
}

function newRawFiles(before: Map<string, string>, after: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of after) if (!before.has(k)) out[k] = v;
  return out;
}


/** 与 sources/textsafe.py 同样的动作词脱敏(硬测试注入用:注入文本要长得像 mapper 产出) */
export function neutralizeActions(text: string): string {
  let t = text;
  for (const w of [...gatePatterns()].sort((a, b) => b.length - a.length)) t = t.split(w).join("〔动作词〕");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * 市场声音注入(硬测试第 7 组):把 scenario.inject_voice 里属于本脚本的伪造条目追加进真实信封的 evidence(在账本计算 sha256 之前,文件与账本一致)。
 * 条目形状与 mapper 一致(field web_result / forum_post,unit text,currency n/a,note 带 link / injected 标记);source=injected(与 inject_evidence 同口径,validator 的 raw_ref 豁免键)、raw_ref=null:
 * 合成证据不冒充真实来源、不借用与内容无关的 raw 文件(Codex 审查 voice-r1)。只在 scenario.inject_voice 非空时生效;凡带 scenario 的运行不进知识层归档。
 * 返回追加的 id 列表(空 = 本脚本没有注入项或信封读不到)。
 */
/** 硬测试第 9 组:往公告 / 新闻信封追加伪造标题(field announcement_title / news_title;source=injected、raw_ref=null、note 带 injected 标记)。动作措辞同样脱敏。 */
export function applyAnnouncementInjection(cfg: Pick<RunConfig, "symbol" | "market">, scenario: Scenario, script: string, file: string): string[] {
  const items = (scenario.inject_announcements ?? []).filter((x) => (x.script ?? "fetch_announcements") === script);
  if (!items.length || !fs.existsSync(file)) return [];
  const env = readJsonIfExists<{ status?: string; evidence?: Record<string, unknown>[]; extra?: Record<string, unknown> }>(file);
  // 只叠加到真实成功(ok / partial)的信封:真实端点失败时不能靠合成条目把硬测试撑绿(Codex choke-r1)
  if (!env || !Array.isArray(env.evidence) || !["ok", "partial"].includes(String(env.status))) return [];
  const day = nowIso().slice(0, 10);
  const field = script === "em_stock_news" ? "news_title" : "announcement_title";
  const ids: string[] = [];
  for (const it of items) {
    const title = neutralizeActions(it.title).slice(0, 200);
    const url = it.url ?? `https://injected.invalid/ann-${ids.length + 1}`;
    const d = it.date ?? day;
    const id = `ev-${crypto.createHash("sha256").update(`inject_announcements|${script}|${url}|${title}`).digest("hex").slice(0, 12)}`;
    env.evidence.push({ id, symbol: cfg.symbol, market: cfg.market || "", field, value: title, unit: "text", currency: "n/a", period: d, as_of: d,
      source: "injected", endpoint: "hardtest.inject_announcements", fetched_at: nowIso(), adjustment: "not_applicable", raw_ref: null, record_key: "u:" + crypto.createHash("sha256").update(url).digest("hex").slice(0, 24),
      note: `url=${url};injected=hardtest.inject_announcements` });
    ids.push(id);
  }
  env.extra = { ...(env.extra ?? {}), injected_announcements: ids };
  writeJson(file, env);
  return ids;
}

export function applyVoiceInjection(cfg: Pick<RunConfig, "symbol" | "market">, scenario: Scenario, script: string, file: string): string[] {
  const items = (scenario.inject_voice ?? []).filter((x) => (x.script ?? "exa_market_voice") === script);
  if (!items.length || !fs.existsSync(file)) return [];
  const env = readJsonIfExists<{ status?: string; evidence?: Record<string, unknown>[]; extra?: Record<string, unknown> }>(file);
  if (!env || !Array.isArray(env.evidence) || !["ok", "partial"].includes(String(env.status))) return [];
  const day = nowIso().slice(0, 10);
  const field = script === "exa_forum_voice" ? "forum_post" : "web_result";
  const ids: string[] = [];
  for (const it of items) {
    const title = neutralizeActions(it.title).slice(0, 200);
    const hl = it.highlights ? neutralizeActions(it.highlights).slice(0, 240) : "";
    const url = it.url ?? `https://injected.invalid/${ids.length + 1}`;
    const d = it.published ?? day;
    const id = `ev-${crypto.createHash("sha256").update(`inject_voice|${script}|${url}|${title}`).digest("hex").slice(0, 12)}`;
    env.evidence.push({ id, symbol: cfg.symbol, market: cfg.market || "", field, value: title, unit: "text", currency: "n/a", period: d, as_of: d,
      source: "injected", endpoint: "hardtest.inject_voice", fetched_at: nowIso(), adjustment: "not_applicable", raw_ref: null, record_key: "u:" + crypto.createHash("sha256").update(url).digest("hex").slice(0, 24),
      note: `topic=注入;kind=${field === "forum_post" ? "forum" : "web"};domain=${url.replace(/^https?:\/\/([^/]+).*/, "$1")};author=N/A;published=${d};recent=true;link=${url}${hl ? ";highlights=" + hl : ""};untrusted_text=sanitized;injected=hardtest.inject_voice` });
    ids.push(id);
  }
  env.extra = { ...(env.extra ?? {}), injected: "inject_voice", injected_ids: ids };
  writeJson(file, env);
  return ids;
}

/**
 * 顺序执行脚本(内存账本里已执行过的不重复);返回(并就地更新)账本。
 *
 * 🔴 **"顺序"是承重的,不要改成并发**。下面每个脚本前后各拍一次 raw 目录快照
 *    (`rawSnapshot` before/after),用差集把新增的 raw 文件**归属到这个脚本**。
 *    并行跑的话,两个脚本同时落 raw 文件,差集就会张冠李戴 —— 而 `raw_ref` 是整条
 *    证据链可复算的根:归错了**不会报错**,只会让"这个数字来自哪次抓取"从此对不上。
 *    ⇒ 想提速要先换一套归属机制(比如让每个脚本写进自己的子目录),而不是直接并发。
 * ⚠️ 也别拿它跟 `service.fetchEndpoint` 比:那条是**看板按需取数**、彼此独立、已是真并发
 *    (实测同时在途 5);这条是**研究运行**的取数,产物要进证据账本。两者约束不同。
 */
export const runFetchScripts: FetchExecutor = async (cfg, stage, scripts, log, ledger, signal) => {
  const scenario: Scenario = cfg.scenario ?? {};
  for (const script of scripts) {
    signal?.throwIfAborted();
    if (ledger[script]) continue; // 本次运行已由编排器执行
    const file = path.join(cfg.runDir, "fetch", `${script}.json`);
    const argv = fetchArgv(cfg.endpoints?.[script], script, { scriptsDir: path.join(cfg.repoRoot, cfg.scriptsRel), symbol: cfg.symbol, runDir: cfg.runDir });
    const started = nowIso();
    const t0 = Date.now();
    const before = rawSnapshot(cfg.runDir);
    let entry: LedgerEntry;
    if (scenario.fail_scripts?.includes(script)) {
      writeJson(file, failedEnvelope(cfg, script, "注入:端点不可用", "fail"));
      entry = { script, argv: [], exit_code: 3, duration_ms: 0, status: "failed", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), injected: "fail_scripts", stage };
    } else {
      // 超时注入:确定性——换成一个必然睡过时限的 fixture 进程(不跑真脚本,不依赖调度竞态),仍走真实的 spawn 超时路径
      const injectTimeout = scenario.timeout_scripts?.includes(script) ?? false;
      const timeout = injectTimeout ? 300 : cfg.fetchTimeoutMs;
      const realArgv = injectTimeout ? ["-c", "import time; time.sleep(30)"] : argv;
      let p;
      try { p = await runResearchProcess(cfg.python, realArgv, { cwd: cfg.repoRoot, env: fetchEnv(), timeout, signal }); }
      catch (e) {
        // Preserve partial raw ownership; cancellation is not an upstream gap.
        writeJson(file, failedEnvelope(cfg, script, "研究已中止，取数未完成"));
        ledger[script] = { script, argv, exit_code: null, duration_ms: Date.now() - t0, status: "error",
          file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: newRawFiles(before, rawSnapshot(cfg.runDir)),
          started_at: started, finished_at: nowIso(), stage };
        saveLedger(cfg.runDir, ledger);
        log("fetch.cancelled", { script });
        throw e;
      }
      const dur = Date.now() - t0;
      const injected = scenario.timeout_scripts?.includes(script) ? "timeout_scripts" : undefined;
      if (p.error && (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        writeJson(file, failedEnvelope(cfg, script, `脚本超时(${timeout} ms)`, injected));
        entry = { script, argv, exit_code: null, duration_ms: dur, status: "timeout", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage, ...(injected ? { injected } : {}) };
      } else if (p.error) {
        writeJson(file, failedEnvelope(cfg, script, `脚本无法启动:${p.error.message}`));
        entry = { script, argv, exit_code: null, duration_ms: dur, status: "error", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage };
      } else {
        if (!fs.existsSync(file)) writeJson(file, failedEnvelope(cfg, script, `脚本退出码 ${p.status} 且未落盘:${(p.stderr || "").slice(-300)}`));
        const injV = applyVoiceInjection(cfg, scenario, script, file), injA = applyAnnouncementInjection(cfg, scenario, script, file);  // 硬测试第 7 / 9 组:在账本算 sha256 之前追加,文件与账本一致
        const injectedVoice = [...injV, ...injA];
        const overlayKinds = [...(injV.length ? ["inject_voice"] : []), ...(injA.length ? ["inject_announcements"] : [])];
        const st = p.status === 0 ? "ok" : p.status === 2 ? "partial" : "failed";
        entry = { script, argv, exit_code: p.status, duration_ms: dur, status: st, file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage, ...(overlayKinds.length ? { synthetic_overlay: overlayKinds.join("+") } : {}) };
        if (injV.length) log("fetch.injected", { kind: "inject_voice", script, injected_ids: injV });
        if (injA.length) log("fetch.injected", { kind: "inject_announcements", script, injected_ids: injA });
      }
    }
    entry.raw_files = newRawFiles(before, rawSnapshot(cfg.runDir));
    ledger[script] = entry;
    log("fetch.executed", { script, status: entry.status, exit_code: entry.exit_code, duration_ms: entry.duration_ms, sha256: entry.sha256, raw_files: Object.keys(entry.raw_files).length, injected: entry.injected ?? null });
    saveLedger(cfg.runDir, ledger);
  }
  signal?.throwIfAborted();
  // 温度计历史比较(第 13 层时间维度):本阶段带 history_fields 的信封取完后,从用户数据区序列(或 scenario 注入)确定性生成 thermo_history 信封 + raw
  currentPlugin().transformFetch?.(cfg, stage, ledger, log);
  // 动态冲突注入:在已取到的真实证据里找该 field 的最新一条,克隆其完整事实键(symbol/market/field/period/unit/adjustment/record_key),只改 id / source / value
  if (scenario.inject_conflict && !ledger["fetch_injected"]) {
    const { field, factor } = scenario.inject_conflict;
    const candidates: Record<string, unknown>[] = [];
    for (const f of listFiles(path.join(cfg.runDir, "fetch"), ".json")) {
      if (path.basename(f).startsWith("_")) continue;
      const env = readJsonIfExists<{ evidence?: Record<string, unknown>[] }>(f);
      for (const e of env?.evidence ?? []) if (e.field === field && typeof e.value === "number") candidates.push(e);
    }
    candidates.sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const base = candidates[0];
    if (base) {
      const clone = { ...base, id: `ev-${crypto.createHash("sha256").update(`injected|${String(base.id)}`).digest("hex").slice(0, 12)}`, source: "injected", endpoint: "hardtest.inject_conflict", value: Number((Number(base.value) * factor).toFixed(2)), raw_ref: null, note: `硬测试注入:克隆 ${String(base.id)} 的事实键,值 ×${factor}` };
      const file = path.join(cfg.runDir, "fetch", "fetch_injected.json");
      writeJson(file, { script: "fetch_injected", symbol: cfg.symbol, market: cfg.market || "", status: "ok", fetched_at: nowIso(), primary_source: "injected", used_sources: ["injected"], evidence: [clone], extra: { injected: "inject_conflict", base_id: base.id }, errors: [], missing: [] });
      ledger["fetch_injected"] = { script: "fetch_injected", argv: [], exit_code: 0, duration_ms: 0, status: "ok", file: "fetch/fetch_injected.json", sha256: sha256File(file), raw_files: {}, started_at: nowIso(), finished_at: nowIso(), injected: "inject_conflict", stage };
      log("fetch.injected", { kind: "inject_conflict", field, base_id: base.id, injected_id: clone.id });
    } else {
      log("fetch.inject_skipped", { kind: "inject_conflict", field, reason: "本阶段尚无该 field 的真实证据,待后续阶段" });
    }
  }
  if (scenario.inject_evidence?.length && !ledger["fetch_injected"]) {
    const file = path.join(cfg.runDir, "fetch", "fetch_injected.json");
    writeJson(file, { script: "fetch_injected", symbol: cfg.symbol, market: cfg.market || "", status: "ok", fetched_at: nowIso(), primary_source: "injected",
      used_sources: ["injected"], evidence: scenario.inject_evidence, extra: { injected: "inject_evidence" }, errors: [], missing: [] });
    ledger["fetch_injected"] = { script: "fetch_injected", argv: [], exit_code: 0, duration_ms: 0, status: "ok", file: "fetch/fetch_injected.json", sha256: sha256File(file), raw_files: {}, started_at: nowIso(), finished_at: nowIso(), injected: "inject_evidence", stage };
    log("fetch.injected", { count: scenario.inject_evidence.length });
  }
  saveLedger(cfg.runDir, ledger);
  return ledger;
};

/** 账本摘要(写入 manifest) */
export function ledgerSummary(ledger: Ledger): Record<string, { status: string; exit_code: number | null; sha256: string | null; raw_files: number; injected?: string; synthetic_overlay?: string }> {
  const out: Record<string, { status: string; exit_code: number | null; sha256: string | null; raw_files: number; injected?: string; synthetic_overlay?: string }> = {};
  // synthetic_overlay 也要进 manifest 摘要:审计 / 硬测试判定要能从 manifest 看出"真实信封上叠了合成证据"(ht17 真踩:判定读 manifest 看不到标记)
  for (const [k, v] of Object.entries(ledger)) out[k] = { status: v.status, exit_code: v.exit_code, sha256: v.sha256, raw_files: Object.keys(v.raw_files ?? {}).length, ...(v.injected ? { injected: v.injected } : {}), ...(v.synthetic_overlay ? { synthetic_overlay: v.synthetic_overlay } : {}) };
  return out;
}
