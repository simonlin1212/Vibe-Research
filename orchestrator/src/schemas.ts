/**
 * JSON Schema(契约的机器形态):取数信封 / evidence / calculation / 阶段产物 / manifest。
 * 字段口径以 AGENTS.md §4 为唯一来源;这里只是它的可执行镜像。全部 additionalProperties:false。
 */
import AjvModule, { type ValidateFunction } from "ajv";

import { applyCoreFormats } from "./formats.ts";
import { GAP_REASON_CODES, stages, type Stage } from "./config.ts";
import { currentPlugin } from "./plugin.ts";
import { FAILURE_CODES } from "./research_failure.ts";

/**
 * 🔴 **带垂类枚举的 schema 一律做成函数,不能是模块级常量。**
 * 市场代码、数据口径、阶段名、标准列、议题都来自 `Plugin`,而包是在 import **之后**才注册的;
 * 写成 `const` 会在模块求值时就去读包 → 抛"未注入 Plugin"。
 * `validateWith` 按 key 缓存编译结果,所以每次调用重建对象字面量并不会重复编译 schema。
 */

// Node ESM 导入 CJS 包:默认导入是 module.exports(ajv 同时挂了 .default = Ajv 类);类型取 ajv 的 default 导出
type AjvCtor = (typeof import("ajv"))["default"];
const Ajv: AjvCtor = (AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor);
// 🔴 运行期这份 ajv 也要装上 Core 的 format:注册期认了、运行期不认,等于"注册时通过、跑起来不校验"
//    —— 两处口径不同,而不一致的那一半永远是静默的那一半。
const ajv = applyCoreFormats(new Ajv({ allErrors: true, strict: false }));

const ISO_TS = "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2})?([.+\\-Z].*)?$";
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

export const evidenceItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["id", "symbol", "market", "field", "value", "unit", "currency", "period", "as_of", "source", "endpoint",
    "fetched_at", "adjustment", "raw_ref"],
  properties: {
    id: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" },
    symbol: { type: "string", minLength: 1 },
    market: { type: "string", enum: [...currentPlugin().evidence.markets] },
    field: { type: "string", minLength: 1 },
    value: { type: ["number", "string", "boolean", "null"] },
    unit: { type: "string" },
    currency: { type: "string" },
    period: { type: "string", minLength: 1 },
    as_of: { type: "string", pattern: DATE },
    source: { type: "string", minLength: 1 },
    endpoint: { type: "string", minLength: 1 },
    fetched_at: { type: "string", pattern: ISO_TS },
    adjustment: { type: "string", enum: [...currentPlugin().evidence.adjustments] },
    raw_ref: { type: ["string", "null"] },
    note: { type: "string" },
    record_key: { type: "string" },
  },
} as const);

export const fetchEnvelopeSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["script", "symbol", "market", "status", "fetched_at", "used_sources", "evidence", "extra", "errors"],
  properties: {
    script: { type: "string", minLength: 1 },
    symbol: { type: "string" },
    market: { type: "string", enum: [...currentPlugin().evidence.markets, ""] },
    status: { type: "string", enum: ["ok", "partial", "failed"] },
    fetched_at: { type: "string", pattern: ISO_TS },
    primary_source: { type: ["string", "null"] },
    used_sources: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: evidenceItemSchema() },
    extra: { type: "object" },
    errors: { type: "array" },
    missing: { type: "array" },
  },
} as const);

export const calcRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["calculation_id", "function", "calc_version", "inputs", "inputs_resolved", "inputs_refs", "output"],
  properties: {
    calculation_id: { type: ["string", "null"], pattern: "^calc-[0-9a-f]{16}$" },
    function: { type: "string", minLength: 1 },
    calc_version: { type: "string" },
    inputs: { type: ["object", "null"] },
    inputs_resolved: { type: "object" },
    inputs_refs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref_type", "ref_id"],
        properties: { ref_type: { type: "string", enum: ["evidence", "calculation"] }, ref_id: { type: "string" } },
        oneOf: [
          { properties: { ref_type: { const: "evidence" }, ref_id: { pattern: "^ev-[0-9a-f]{6,}$" } } },
          { properties: { ref_type: { const: "calculation" }, ref_id: { pattern: "^calc-[0-9a-f]{16}$" } } },
        ],
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["status", "value", "unit", "reason", "details"],
      properties: {
        status: { type: "string", enum: ["ok", "not_meaningful", "error"] },
        value: { type: ["number", "null"] },
        unit: { type: "string" },
        reason: { type: "string" },
        details: { type: "object" },
        // calc 0.3.2:展示层字符串(cli 层附加;旧记录可无)
        display: { type: ["string", "null"] },
      },
    },
  },
} as const;

export const gapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "reason_code", "detail"],
  properties: {
    operation: { type: "string", minLength: 1 },
    reason_code: { type: "string", enum: [...GAP_REASON_CODES] },
    detail: { type: "string", minLength: 1 },
    attempted_sources: { type: "array", items: { type: "string" } },
  },
} as const;

/** 批量摘要的标准列 —— 由插件提供 */
export const standardColumns = (): readonly string[] => currentPlugin().standardColumns;

/** 各阶段 extra_findings 允许的 topic —— 由插件提供(schema 与 validator 双重约束) */
export const extraTopics = (): Readonly<Record<Stage, readonly string[]>> => currentPlugin().extraTopics;

/** 阶段产物 stages/<stage>.json 的通用骨架;各阶段再加专属必填项 */
export function stageOutputSchema(stage: Stage): Record<string, unknown> {
  const props: Record<string, unknown> = {
    stage: { type: "string", enum: [stage] },
    status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] },
    summary: { type: "string", minLength: 1 },
    evidence_ids: { type: "array", items: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" } },
    calculation_ids: { type: "array", items: { type: "string", pattern: "^calc-[0-9a-f]{16}$" } },
    gaps: { type: "array", items: gapSchema },
    notes: { type: "string" },
    // 知识层档案裁决(任何阶段都可写;claim 原话 / 反证或"无法裁决:原因" / 对口 ev- 或 calc- id)
    knowledge_conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["claim", "refuted_by"], properties: { claim: { type: "string", minLength: 1 }, refuted_by: { type: "string", minLength: 1 }, evidence_ids: { type: "array", items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } } },
    // Phase 1 M2:扩展数据发现(可选;每条必须引用 evidence / calc id;只报事实与数值,不得含交易信号)
    // ⚠️ 该阶段没有议题时**直接不允许**写扩展发现(maxItems: 0),而不是留一个空 enum ——
    //    空 enum 的报错是"topic 不在允许值里",看不出根因是"这个阶段本来就没有议题"。
    //    契约那边因此可以允许 extraTopics 某阶段为空(第二个垂类真的会有这种阶段)。
    extra_findings: { type: "array", maxItems: (extraTopics()[stage] ?? []).length ? 12 : 0, items: { type: "object", additionalProperties: false, required: ["topic", "summary", "evidence_ids"], properties: { topic: { type: "string", enum: [...(extraTopics()[stage] ?? [])] }, summary: { type: "string", minLength: 1, maxLength: 600 }, evidence_ids: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } } },
  };
  const required = ["stage", "status", "summary", "evidence_ids", "calculation_ids", "gaps"];
  // 阶段专属字段由**插件贡献**(Plugin.stageSchemas):Core 只合并,不认识任何具体字段名。
  // 🔴 这里原本是 `if (stage === "profile")` / `if (stage === "risk")` 两大段金融字段定义 ——
  //    换个垂类既拿不到自己该有的约束、又被强塞金融概念(全审 r4-P1)。
  const ext = currentPlugin().stageSchemas[stage];
  if (ext) {
    Object.assign(props, ext.properties);
    required.push(...ext.required);
  }
  // 契约已声明 standardColumnsStage,这里却写死字面量 —— 插件把标准列放别处时,
  // 那个阶段的 schema 不允许该字段(additionalProperties:false),不写又完全没有完整性约束(全审 r1-P2-5)。
  if (stage === currentPlugin().standardColumnsStage) {
    props.standard_columns = {
      type: "object", additionalProperties: false, required: [...standardColumns()],
      properties: Object.fromEntries(standardColumns().map((k) => [k, { type: "string", pattern: "^(calc-[0-9a-f]{16}|未获取[::].+)$" }])),
    };
    required.push("standard_columns");
  }
  return { type: "object", additionalProperties: false, required, properties: props };
}

/** 阶段最终回复(outputSchema)——极简,只用于机器判读 */
export const turnReplySchema = {
  type: "object",
  properties: {
    stage_file_written: { type: "boolean" },
    status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] },
    notes: { type: "string" },
  },
  required: ["stage_file_written", "status", "notes"],
  additionalProperties: false,
} as const;

export const manifestSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["run_id", "symbol", "market", "started_at", "finished_at", "status", "stages", "codex_version", "model", "model_note", "calc_version",
    "repo_version", "config_hash", "raw_hashes", "execution_scope", "partial_run", "thread_id", "fetch_ledger", "evidence_count", "calculation_count",
    "evidence_conflicts", "gate", "exit_code", "provider", "engine", "constitution", "hooks"],
  properties: {
    provider: { type: "object", additionalProperties: false, required: ["name", "wire_api", "base_url", "env_key", "auth"],
      properties: { name: { type: "string" }, wire_api: { type: "string", enum: ["responses", "chat"] }, base_url: { type: ["string", "null"] }, env_key: { type: "string" }, auth: { type: "string", enum: ["chatgpt_login", "api_key", "subscription_login"] },
        profile: { type: ["string", "null"] }, matrix_status: { type: ["string", "null"] } } },
    constitution: { type: "object", additionalProperties: false, required: ["path", "sha256"], properties: { path: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
    hooks: { type: "object", additionalProperties: false, required: ["enabled", "installed", "hooks_json", "invocations", "stop_blocks", "stop_terminations", "pre_tool_use_blocks", "errors", "log_trust"],
      properties: { enabled: { type: "boolean" }, installed: { type: "boolean" }, hooks_json: { type: ["string", "null"] }, invocations: { type: "integer" }, stop_blocks: { type: "integer" }, stop_terminations: { type: "integer" },
        pre_tool_use_blocks: { type: "integer" }, errors: { type: "integer" }, log_trust: { type: "string", enum: ["diagnostic_untrusted"] } } },
    // 指令发现链摘要(可选:noAgent 运行不写;见 instructions_root.ts)
    instructions_root: { type: "object", additionalProperties: false, required: ["root", "mode", "marker_created", "synced_files"],
      properties: { root: { type: "string" }, mode: { type: "string", enum: ["product", "data"] }, marker_created: { type: "boolean" }, synced_files: { type: "integer", minimum: 0 } } },
    // skills 隔离摘要(可选:noAgent 运行不写;见 skills_isolation.ts)
    skills_isolation: { type: "object", additionalProperties: false, required: ["installed", "config_toml", "disabled_user_skills", "bundled_disabled", "max_context_tokens"],
      properties: { installed: { type: "boolean" }, config_toml: { type: "string" }, disabled_user_skills: { type: "integer", minimum: 0 }, bundled_disabled: { type: "boolean" }, max_context_tokens: { type: "integer", minimum: 1, maximum: 10000 }, truncated: { type: "boolean" } } },
    engine: { type: "object", additionalProperties: false, required: ["codex_path", "codex_home", "binary"],
      properties: { codex_path: { type: ["string", "null"] }, codex_home: { type: ["string", "null"] }, binary: { type: ["string", "null"] },
        // 执行保障等级(engine.ts)。**不进 required**:旧运行的 manifest 里没有这段,viewer / 知识层仍要读得动。
        // 编排器则是无条件写入的,"忘了写"由 orchestrate 测试兜底 —— 光靠 schema 可选会让漏写变成静默的。
        capabilities: { type: "object", additionalProperties: false,
          required: ["kind", "protocol", "sandbox", "hooks", "contextStrategy", "structuredOutput", "auditLevel", "methodology"],
          properties: {
            kind: { type: "string", enum: ["codex", "direct", "local_agent"] },
            protocol: { type: "string", enum: ["responses", "chat_completions", "cli_subscription"] },
            sandbox: { type: "string", enum: ["seatbelt_readonly", "model_has_no_host_access"] },
            hooks: { type: "boolean" },
            contextStrategy: { type: "string", enum: ["thread", "per_stage_session"] },
            structuredOutput: { type: "string", enum: ["server_schema", "prompt"] },
            auditLevel: { type: "string", enum: ["engine_events", "host_events"] },
            methodology: { type: "string", enum: ["constitution_and_skills", "stage_prompt_only"] },
          } } } },
    run_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, symbol: { type: "string", minLength: 1 }, // ⚠️ 必须与 evidence / fetch 用同一份枚举。写死沪深四项时:插件声明支持 US/HK/TW,
    //    取数与每条证据都能过动态 schema、阶段全部完成,**收尾却因 manifest.market 不在旧枚举里整轮判 failed**
    //    (Codex 全审 r1 P1-3)。纯净度棘轮看不见这个——"SH"/"SZ" 不在垂类词表里。
    market: { type: "string", enum: [...currentPlugin().evidence.markets, ""] },
    started_at: { type: "string", pattern: ISO_TS }, finished_at: { type: ["string", "null"], pattern: ISO_TS },
    status: { type: "string", enum: ["complete", "incomplete", "failed", "stale", "running"] },
    cancelled: { type: "boolean" },
    stages: { type: "array", items: { type: "object", additionalProperties: false, required: ["stage", "status", "attempts", "errors", "validator_ok"],
      properties: { stage: { type: "string", enum: [...stages()] }, status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] }, attempts: { type: "integer" }, errors: { type: "array", items: { type: "string" } }, validator_ok: { type: "boolean" } } } },
    codex_version: { type: "string" }, model: { type: ["string", "null"] }, model_note: { type: "string" }, calc_version: { type: "string" },
    repo_version: { type: "string" }, config_hash: { type: "string" }, raw_hashes: { type: "object" },
    execution_scope: { type: "array", items: { type: "string" } }, partial_run: { type: "boolean" }, thread_id: { type: ["string", "null"] },
    fetch_ledger: { type: "object" }, evidence_count: { type: "integer" }, calculation_count: { type: "integer" },
    evidence_conflicts: { type: "array" }, gate: { type: "object" }, exit_code: { type: "integer", enum: [0, 2, 3] },
    quote_decision: { type: ["string", "null"] },
    endpoint_scope: { type: "string", enum: ["core", "full"] }, registry_version: { type: ["string", "null"] },
    knowledge_recalled: { type: ["object", "null"], additionalProperties: false, required: ["path", "as_of", "status", "truncated"], properties: { path: { type: "string" }, as_of: { type: "string" }, status: { type: "string" }, truncated: { type: "boolean" } } },
    user_reports: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["id", "name", "page"],
      properties: { id: { type: "string", pattern: "^[0-9a-f]{32}$" }, name: { type: "string", minLength: 1, maxLength: 240 }, page: { type: ["integer", "null"], minimum: 1 } } } },
    test_scenario: { type: "boolean" },
    // 夹具播种运行:非 null 即**不是**一次完整的真实研究(见 fixture.ts)
    seeded_from: { type: ["object", "null"], additionalProperties: false,
      required: ["fixture_data_day", "source_run_id", "stages", "stale"],
      properties: { fixture_data_day: { type: "string" }, source_run_id: { type: "string" },
        stages: { type: "array", items: { type: "string" } }, stale: { type: "boolean" } } },
    chokepoints: { type: "object", additionalProperties: false, required: ["scanned", "hits", "by_category"], properties: { scanned: { type: "integer" }, hits: { type: "integer" }, by_category: { type: "object", additionalProperties: { type: "integer" } } } },
    industry_tags: { type: "object", additionalProperties: false, required: ["tags", "matched", "skipped", "signals"], properties: { tags: { type: "array", items: { type: "string" } }, matched: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } }, skipped: { type: "array", items: { type: "string" } }, signals: { type: "integer" } } },
    knowledge_archived: { type: ["object", "null"], additionalProperties: false, required: ["latest", "run_file", "gate_removed"], properties: { latest: { type: "string" }, run_file: { type: "string" }, gate_removed: { type: "integer" } } },
    viewer: { type: ["object", "null"], additionalProperties: false, required: ["html", "appendix"], properties: { html: { type: "string" }, appendix: { type: "string" } } },
    thermo_archived: { type: ["object", "null"], additionalProperties: false, required: ["endpoints", "appended", "skipped", "corrupt_moved"], properties: { endpoints: { type: "array", items: { type: "string" } }, appended: { type: "integer" }, skipped: { type: "integer" }, corrupt_moved: { type: "integer" } } },
    final_errors: { type: "array", items: { type: "string" } },
    failure_code: { enum: [...FAILURE_CODES, null] },
  },
} as const);

const compiled = new Map<string, ValidateFunction>();
function compile(key: string, schema: object): ValidateFunction {
  const cached = compiled.get(key);
  if (cached) return cached;
  const v: ValidateFunction = ajv.compile(schema);
  compiled.set(key, v);
  return v;
}

export function validateWith(key: string, schema: object, data: unknown): string[] {
  const v = compile(key, schema);
  if (v(data)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.params ? " " + JSON.stringify(e.params) : ""}`);
}

export const validateFetchEnvelope = (d: unknown) => validateWith("fetch", fetchEnvelopeSchema(), d);
export const validateEvidenceItem = (d: unknown) => validateWith("evidence", evidenceItemSchema(), d);
export const validateCalcRecord = (d: unknown) => validateWith("calc", calcRecordSchema, d);
export const validateStageOutput = (stage: Stage, d: unknown) => validateWith(`stage:${stage}`, stageOutputSchema(stage), d);
export const validateManifest = (d: unknown) => validateWith("manifest", manifestSchema(), d);

export function isStage(s: string): s is Stage {
  return stages().includes(s);
}
