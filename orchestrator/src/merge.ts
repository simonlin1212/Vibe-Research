/**
 * 合并与 provenance:fetch/*.json → evidence.json;calcs/*.json → calculations.json;raw/ → raw_hashes;manifest.json。
 * 跨源冲突:按事实键 {symbol, market, field, period, adjustment} 聚类,同单位下值不一致即记冲突(AGENTS.md §1 数据源冲突必须显式报告)。
 */
import fs from "node:fs";
import path from "node:path";

import type { RunConfig, RunStatus, Stage, StageStatus } from "./config.ts";
import { listFiles, readJsonIfExists, sha256File, writeJson } from "./fsutil.ts";

export interface FetchEnvelope {
  script: string;
  symbol: string;
  market: string;
  status: "ok" | "partial" | "failed";
  primary_source?: string | null;
  used_sources: string[];
  evidence: EvidenceItem[];
  extra: Record<string, unknown>;
  errors: unknown[];
  missing?: unknown[];
}

export interface EvidenceItem {
  id: string;
  symbol: string;
  market: string;
  field: string;
  value: unknown;
  unit: string;
  currency: string;
  period: string;
  as_of: string;
  source: string;
  endpoint: string;
  fetched_at: string;
  adjustment: string;
  raw_ref: string | null;
  note?: string;
  record_key?: string;
}

export interface CalcRecord {
  calculation_id: string | null;
  function: string;
  calc_version: string;
  inputs: Record<string, unknown> | null;
  inputs_resolved: Record<string, unknown>;
  inputs_refs: { ref_type: "evidence" | "calculation"; ref_id: string }[];
  output: { status: "ok" | "not_meaningful" | "error"; value: number | null; unit: string; reason: string; details: Record<string, unknown> };
}

export interface SourceConflict {
  key: string;
  field: string;
  period: string;
  unit: string;
  values: { id: string; source: string; script: string; value: unknown }[];
}

export function loadFetch(runDir: string): Record<string, FetchEnvelope> {
  const out: Record<string, FetchEnvelope> = {};
  for (const f of listFiles(path.join(runDir, "fetch"), ".json")) {
    if (path.basename(f).startsWith("_")) continue; // 账本等内部文件
    const env = readJsonIfExists<FetchEnvelope>(f);
    if (env && env.script) out[env.script] = env;
  }
  return out;
}

export function loadCalcs(runDir: string): { file: string; record: CalcRecord | null }[] {
  return listFiles(path.join(runDir, "calcs"), ".json")
    .filter((f) => {
      // agent 会往 calcs/ 里写临时参数文件(args_*/sq_* 之类,绕过 shell 长参数),
      // 它们没有 calculation_id —— 不是计算记录,收进 run.calcs 会让下游
      // validateStage 读 record.output 时崩(2026-09-05 茅台 run:TypeError 判死整个 run)。
      const r = readJsonIfExists<CalcRecord>(f);
      return r != null && typeof (r as unknown as { calculation_id?: unknown }).calculation_id === "string";
    })
    .map((f) => ({ file: f, record: readJsonIfExists<CalcRecord>(f) }));
}

/** 合并证据:按 id 去重;同 id 不同 value 记 id 冲突(完整性错误) */
export function mergeEvidence(fetch: Record<string, FetchEnvelope>): { evidence: EvidenceItem[]; idConflicts: string[] } {
  const byId = new Map<string, EvidenceItem>();
  const idConflicts: string[] = [];
  for (const script of Object.keys(fetch).sort()) {
    for (const e of fetch[script].evidence ?? []) {
      const prev = byId.get(e.id);
      if (!prev) { byId.set(e.id, e); continue; }
      // 🔴 只比 value 会**静默折叠**两条不同的事实(全审 r1-P2-6):证据 id 的生成口径不含
      //    market / unit / currency / adjustment,于是同一字段值为 10 的两条(口径 A 与口径 B)
      //    会拿到同一个 id、数值又相同 ⇒ 不报冲突、丢掉后来那条。「1 元」与「1 亿元」同理。
      //    ⚠️ 不做整条逐字段相等:`fetched_at` / `raw_ref` / `note` 在多个信封里携带同一证据时
      //    本来就会不同,那样会把正常情况全判成冲突。只比**决定事实语义**的字段 ——
      //    与冲突检测自己用的事实键口径对齐。
      const factKey = (x: EvidenceItem) => JSON.stringify([x.symbol, x.market, x.field, x.period, x.unit, x.currency, x.adjustment, x.record_key ?? null, x.value]);
      if (factKey(prev) !== factKey(e)) {
        idConflicts.push(`${e.id} (${e.field}) 同 id 但事实不一致:${factKey(prev)} vs ${factKey(e)}`);
      }
    }
  }
  return { evidence: [...byId.values()], idConflicts };
}

/** 跨源冲突:同事实键、同单位、不同值(数值相对容差 1e-6;非数严格相等) */
export function detectSourceConflicts(fetch: Record<string, FetchEnvelope>): SourceConflict[] {
  const groups = new Map<string, { unit: string; items: { id: string; source: string; script: string; value: unknown }[] }>();
  const seenIds = new Set<string>();
  for (const script of Object.keys(fetch).sort()) {
    for (const e of fetch[script].evidence ?? []) {
      if (seenIds.has(e.id)) continue; // 同一证据被多个信封重复携带只算一次(id 冲突另行检查)
      seenIds.add(e.id);
      // 事实键:同 symbol / market / field / period / adjustment / unit / record_key(公告等"多条记录同一天"靠 record_key 区分,不算冲突)
      const key = [e.symbol, e.market, e.field, e.period, e.adjustment, e.unit, e.record_key ?? ""].join("|");
      const g = groups.get(key) ?? { unit: e.unit, items: [] };
      g.items.push({ id: e.id, source: e.source, script, value: e.value });
      groups.set(key, g);
    }
  }
  const out: SourceConflict[] = [];
  for (const [key, g] of groups) {
    const distinct = new Set<string>();
    for (const it of g.items) distinct.add(canon(it.value));
    if (distinct.size <= 1) continue;
    if (new Set(g.items.map((i) => i.source)).size < 2) continue; // 跨源冲突必须来自 ≥2 个数据源;同源重复由 id 冲突 / 脚本自身负责
    if (g.items.every((i) => typeof i.value === "number") && numericallyClose(g.items.map((i) => i.value as number))) continue;
    const [symbol, market, field, period] = key.split("|");
    out.push({ key: `${symbol}|${market}|${field}|${period}`, field, period, unit: g.unit, values: g.items });
  }
  return out;
}

function canon(v: unknown): string {
  return typeof v === "number" ? String(Number(v.toPrecision(12))) : JSON.stringify(v);
}

function numericallyClose(vals: number[]): boolean {
  const max = Math.max(...vals.map(Math.abs), 1);
  return Math.max(...vals) - Math.min(...vals) <= 1e-6 * max;
}

export function rawHashes(runDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listFiles(path.join(runDir, "raw"))) {
    if (fs.lstatSync(f).isSymbolicLink()) continue; // 不跟随符号链接
    out[path.basename(f)] = sha256File(f);
  }
  return out;
}

export interface StageRecord { stage: Stage; status: StageStatus; attempts: number; errors: string[]; validator_ok: boolean }

export interface Manifest {
  run_id: string;
  symbol: string;
  market: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus | "running";
  stages: StageRecord[];
  codex_version: string;
  model: string | null;
  model_note: string;
  calc_version: string;
  repo_version: string;
  config_hash: string;
  raw_hashes: Record<string, string>;
  execution_scope: string[];
  partial_run: boolean;
  thread_id: string | null;
  fetch_ledger: Record<string, unknown>;
  endpoint_scope?: string;
  registry_version?: string | null;
  /** M2:召回的知识档案(null = 无 / 关闭)与归档 / 查看器产物路径 */
  knowledge_recalled?: { path: string; as_of: string; status: string; truncated: boolean } | null;
  /** 本次运行实际注入的用户资料片段；最终报告的资料引用据此做机器校验。 */
  user_reports?: { id: string; name: string; page: number | null }[];
  knowledge_archived?: { latest: string; run_file: string; gate_removed: number } | null;
  /** 温度计历史序列归档结果(null = 未归档:scenario / failed / 未开 archive) */
  thermo_archived?: { endpoints: string[]; appended: number; skipped: number; corrupt_moved: number } | null;
  /** 带 scenario(硬测试旋钮)的运行:产物含合成数据,不进知识层归档 */
  test_scenario?: boolean;
  /** 夹具播种运行:哪几个阶段的产物来自别次运行(见 fixture.ts)。非 null 即**不是**一次完整的真实研究 */
  seeded_from?: { fixture_data_day: string; source_run_id: string; stages: string[]; stale: boolean } | null;
  /** 产业温度计门控结果(第 13 层):命中的产业标签、依据、被跳过的端点 */
  industry_tags?: { tags: string[]; matched: Record<string, string[]>; skipped: string[]; signals: number };
  /** 卡口事件分类结果(确定性筛子):扫描条数 / 命中数 / 各类别计数 */
  chokepoints?: { scanned: number; hits: number; by_category: Record<string, number> };
  viewer?: { html: string; appendix: string } | null;
  evidence_count: number;
  calculation_count: number;
  evidence_conflicts: unknown[];
  gate: { ok: boolean; hits: unknown[] };
  exit_code: number;
  quote_decision?: string | null;
  final_errors?: string[];
  provider: { name: string; wire_api: string; base_url: string | null; env_key: string; auth: string ; profile?: string | null; matrix_status?: string | null };
  engine: { codex_path: string | null; codex_home: string; binary: string | null };
  constitution: { path: string; sha256: string };
  hooks: { enabled: boolean; installed: boolean; hooks_json: string | null; invocations: number; stop_blocks: number; stop_terminations: number; pre_tool_use_blocks: number; errors: number; log_trust: "diagnostic_untrusted" };
  /** 指令发现链(instructions_root.ts):宪法与项目技能所在的根、以及分离安装时同步了多少文件;noAgent 运行不写 */
  instructions_root?: { root: string; mode: "product" | "data"; marker_created: boolean; synced_files: number };
  /** skills 隔离(skills_isolation.ts):运行开始时写入产品 CODEX_HOME/config.toml 的禁用清单摘要;noAgent 运行不写 */
  skills_isolation?: { installed: boolean; config_toml: string; disabled_user_skills: number; bundled_disabled: boolean; max_context_tokens: number; /** 枚举触及 Codex 截断边界,清单可能不完整 */ truncated?: boolean };
}

export function writeMergedArtifacts(cfg: RunConfig): { evidence: EvidenceItem[]; calcs: CalcRecord[]; idConflicts: string[]; sourceConflicts: SourceConflict[] } {
  const fetch = loadFetch(cfg.runDir);
  const { evidence, idConflicts } = mergeEvidence(fetch);
  const sourceConflicts = detectSourceConflicts(fetch);
  writeJson(path.join(cfg.runDir, "evidence.json"), evidence);
  const calcs = loadCalcs(cfg.runDir).map((c) => c.record).filter((r): r is CalcRecord => !!r);
  writeJson(path.join(cfg.runDir, "calculations.json"), calcs);
  writeJson(path.join(cfg.runDir, "conflicts.json"), { id_conflicts: idConflicts, source_conflicts: sourceConflicts });
  return { evidence, calcs, idConflicts, sourceConflicts };
}

/** 权威冲突集(每阶段取数后刷新,供 risk / report 引用与 validator 核对) */
export function writeConflicts(cfg: RunConfig): { idConflicts: string[]; sourceConflicts: SourceConflict[] } {
  const fetch = loadFetch(cfg.runDir);
  const idConflicts = mergeEvidence(fetch).idConflicts;
  const sourceConflicts = detectSourceConflicts(fetch);
  writeJson(path.join(cfg.runDir, "conflicts.json"), { id_conflicts: idConflicts, source_conflicts: sourceConflicts });
  return { idConflicts, sourceConflicts };
}

export function writeManifest(cfg: RunConfig, m: Manifest): void {
  writeJson(path.join(cfg.runDir, "manifest.json"), m);
}

export function readManifest(cfg: RunConfig): Manifest | null {
  return readJsonIfExists<Manifest>(path.join(cfg.runDir, "manifest.json"));
}
