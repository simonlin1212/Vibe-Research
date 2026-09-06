/**
 * 产品层 Deep 适配器。
 *
 * 本文件不实现研究状态机：它只把已路由的 ResearchTask 绑定到现有 startResearch / researchStatus /
 * getReport 三个端口，并把六阶段运行状态投影为统一 TaskEvent。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { atomicWrite, readJsonIfExists, restrictPrivateFile } from "../fsutil.ts";
import { getReport, researchStatus, safePath, startResearch, ServiceError, type RunStatus, type ServiceContext,
  type StartResult } from "../service.ts";
import { isTrustedRouteDecision, type ExecutionEngine, type ExecutionResumeRef, type RouteDecision,
  type AgentEngineFamily, type TaskEvent } from "../task_router.ts";
import type { LlmOverride } from "../runtime_provider.ts";

export interface DeepResearchTarget {
  readonly symbol: string;
  readonly market: string;
  readonly reportIds: readonly string[];
  readonly reportRevisions: Readonly<Record<string, string>>;
}

export interface DeepTargetResolver {
  resolveDeepTarget(route: RouteDecision): DeepResearchTarget;
}

export interface DeepResearchBackend {
  start(request: Parameters<typeof startResearch>[1], internal?: Parameters<typeof startResearch>[2]): StartResult;
  status(runId: string, lastEvents?: number): RunStatus;
  report(runId: string): ReturnType<typeof getReport>;
}

export interface CodexDeepEngineOptions {
  readonly ctx: ServiceContext;
  readonly materials: DeepTargetResolver;
  readonly backend?: DeepResearchBackend;
  /** 本次请求的 AI 来源；只在内存中交给子进程，不写任务绑定。 */
  readonly runtimeLlm?: LlmOverride;
  readonly now?: () => Date;
  /** 实际执行 Deep turn 的 Agent 家族；默认保留 Codex 兼容路径。 */
  readonly engineFamily?: AgentEngineFamily;
}

interface DeepRunBinding {
  schema_version: 1;
  run_id: string;
  task_id: string;
  route_fingerprint: string;
  symbol: string;
  market: string;
  report_ids: string[];
  created_at: string;
}

export class DeepExecutionError extends Error {
  readonly code: "invalid_route" | "deep_entity_required" | "deep_multiple_entities" |
    "deep_unsupported_entity" | "resume_not_found" | "resume_mismatch" | "deep_start_failed";

  constructor(code: DeepExecutionError["code"], message: string) {
    super(message);
    this.name = "DeepExecutionError";
    this.code = code;
  }
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const REPORT_ID_RE = /^[0-9a-f]{32}$/;
// startResearch 的子进程会在初始化最前段建立运行目录；一分钟仍不存在即可判定启动链已丢失。
// 设硬上限而不是永久 queued，避免配置/宪法错误发生在 prepareRunDir 前时前端无限轮询。
const STARTUP_GRACE_MS = 60_000;

function bindingPath(ctx: Pick<ServiceContext, "dataRoot">, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new DeepExecutionError("resume_not_found", "Deep 运行编号无效");
  return safePath(ctx, "task-runs", `${runId}.json`);
}

function validBinding(value: unknown, runId: string): value is DeepRunBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if (keys !== "created_at,market,report_ids,route_fingerprint,run_id,schema_version,symbol,task_id") return false;
  return item.schema_version === 1 && item.run_id === runId && typeof item.task_id === "string" &&
    FINGERPRINT_RE.test(String(item.route_fingerprint ?? "")) && typeof item.symbol === "string" && item.symbol.length > 0 && item.symbol.length <= 64 &&
    typeof item.market === "string" && /^[A-Za-z0-9._-]{1,16}$/.test(item.market) &&
    Array.isArray(item.report_ids) && item.report_ids.every((id) => typeof id === "string" && REPORT_ID_RE.test(id)) &&
    typeof item.created_at === "string" && Number.isFinite(Date.parse(item.created_at));
}

function readBinding(ctx: Pick<ServiceContext, "dataRoot">, runId: string): DeepRunBinding {
  const value = readJsonIfExists<unknown>(bindingPath(ctx, runId));
  if (!validBinding(value, runId)) throw new DeepExecutionError("resume_not_found", "找不到可恢复的 Deep 任务绑定");
  return value;
}

function saveBinding(ctx: Pick<ServiceContext, "dataRoot">, binding: DeepRunBinding): void {
  const file = bindingPath(ctx, binding.run_id);
  atomicWrite(file, JSON.stringify(binding, null, 2) + "\n");
  restrictPrivateFile(file);
}

function event(runId: string, taskId: string, sequence: number, type: TaskEvent["type"],
  payload?: Record<string, unknown>): TaskEvent {
  return Object.freeze({ runId, taskId, sequence, type,
    ...(payload ? { payload: Object.freeze(payload) } : {}) });
}

function safeStartMessage(error: unknown): string {
  if (error instanceof DeepExecutionError) return error.message;
  if (error instanceof ServiceError && error.code === "invalid_task_context") {
    return "Deep 任务关注点或圈选资料格式无效，请检查输入后重新创建研究";
  }
  return "Deep 长流程未能启动，请检查本地 Agent 连接与研究配置";
}

export class CodexDeepEngine implements ExecutionEngine {
  readonly id: string;
  readonly target = "deep" as const;
  readonly #ctx: ServiceContext;
  readonly #resolveTarget: DeepTargetResolver["resolveDeepTarget"];
  readonly #backend: DeepResearchBackend;
  readonly #now: () => Date;
  readonly #runtimeLlm?: LlmOverride;
  readonly #engineFamily: AgentEngineFamily;

  constructor(options: CodexDeepEngineOptions) {
    if (!options || typeof options.materials?.resolveDeepTarget !== "function") {
      throw new TypeError("CodexDeepEngine 缺少 Deep 对象解析器");
    }
    this.#ctx = options.ctx;
    this.#resolveTarget = options.materials.resolveDeepTarget.bind(options.materials);
    this.#backend = options.backend ?? {
      start: (request, internal) => startResearch(options.ctx, request, internal),
      status: (runId, lastEvents) => researchStatus(options.ctx, runId, lastEvents),
      report: (runId) => getReport(options.ctx, runId),
    };
    this.#now = options.now ?? (() => new Date());
    this.#runtimeLlm = options.runtimeLlm;
    this.#engineFamily = options.engineFamily ?? "codex_harness";
    this.id = this.#engineFamily === "local_agent" ? "local-agent-deep-v1" : "codex-deep-v1";
  }

  async *run(route: RouteDecision, signal?: AbortSignal): AsyncIterable<TaskEvent> {
    const runId = `task-${this.#now().getTime().toString(36)}-${randomUUID().slice(0, 12)}`;
    let sequence = 0;
    try {
      if (!isTrustedRouteDecision(route) || route.target !== "deep" || route.engineFamily !== this.#engineFamily) {
        throw new DeepExecutionError("invalid_route", "Deep 执行器只接受已路由并绑定真实 Agent 家族的任务");
      }
      if (signal?.aborted) throw new DeepExecutionError("deep_start_failed", "Deep 任务已取消，未启动长流程");
      const target = this.#resolveTarget(route);
      const binding: DeepRunBinding = {
        schema_version: 1, run_id: runId, task_id: route.task.id,
        route_fingerprint: route.routeFingerprint, symbol: target.symbol, market: target.market,
        report_ids: [...target.reportIds], created_at: this.#now().toISOString(),
      };
      saveBinding(this.#ctx, binding);
      try {
        this.#backend.start({ symbol: target.symbol, market: target.market, endpoints: "full", knowledge: "on",
          run_id: runId }, { taskObjective: route.task.objective, reportIds: target.reportIds,
          reportRevisions: target.reportRevisions, ...(this.#runtimeLlm ? { runtimeLlm: this.#runtimeLlm } : {}) });
      } catch (error) {
        try { fs.unlinkSync(bindingPath(this.#ctx, runId)); } catch { /* 启动失败清理尽力而为；原错误优先 */ }
        throw error;
      }
      yield event(runId, route.task.id, ++sequence, "started", {
        routeFingerprint: route.routeFingerprint, routeReason: route.reason, executor: this.id,
        researchStatus: "running", symbol: target.symbol, market: target.market,
      });
    } catch (error) {
      yield event(runId, route.task.id, ++sequence, "failed", {
        code: error instanceof DeepExecutionError ? error.code : "deep_start_failed",
        message: safeStartMessage(error),
      });
    }
  }

  async *resume(run: ExecutionResumeRef, signal?: AbortSignal): AsyncIterable<TaskEvent> {
    if (signal?.aborted) throw new DeepExecutionError("deep_start_failed", "Deep 状态读取已取消");
    const binding = readBinding(this.#ctx, run.runId);
    if (run.routeFingerprint !== binding.route_fingerprint) {
      throw new DeepExecutionError("resume_mismatch", "恢复指纹与 Deep 运行创建时不一致");
    }
    const status = this.#backend.status(run.runId, 50);
    if (!status.exists) {
      const queuedForMs = this.#now().getTime() - Date.parse(binding.created_at);
      if (queuedForMs >= STARTUP_GRACE_MS) {
        yield event(run.runId, binding.task_id, 2, "failed", {
          code: "deep_start_lost",
          message: "Deep 长流程未建立运行目录，请检查本地 Agent 配置后重新发起任务",
          researchStatus: "failed",
          routeFingerprint: binding.route_fingerprint,
        });
        return;
      }
      yield event(run.runId, binding.task_id, 2, "progress", { researchStatus: "queued", completedStages: 0 });
      return;
    }
    for (let index = 0; index < status.stages.length; index += 1) {
      const stage = status.stages[index]!;
      yield event(run.runId, binding.task_id, index + 2, "progress", {
        researchStatus: status.status ?? "running", stage: stage.stage, stageStatus: stage.status,
        attempts: stage.attempts,
      });
    }
    // manifest 在运行刚开始时就带占位 exit_code=2；它不是终态信号。
    // finished_at 才由既有编排器在最终收口时写入，运行中必须继续轮询。
    if (status.finished_at === null) return;
    if (status.report && status.status !== "cancelled") {
      const artifact = this.#backend.report(run.runId);
      yield event(run.runId, binding.task_id, 8, "artifact", {
        artifactType: "deep_research_report", format: "document", report: artifact.report,
        appendix: artifact.appendix, viewer: status.viewer, evidenceCount: status.evidence_count,
        calculationCount: status.calculation_count,
      });
    }
    // 六阶段可能以 incomplete / stale 等非成功状态结束；只有 complete + exit 0 才能向统一入口报告完成。
    const terminalType: TaskEvent["type"] = status.status === "complete" && status.exit_code === 0 ? "completed" : "failed";
    yield event(run.runId, binding.task_id, 9, terminalType, {
      ...(terminalType === "failed" ? status.status === "cancelled"
        ? { code: "research_cancelled", message: "研究已取消，未完成的报告没有归档" }
        : { code: "deep_research_failed", message: "Deep 六阶段研究未完整通过最终校验" } : {}),
      researchStatus: status.status, exitCode: status.exit_code, finishedAt: status.finished_at,
      routeFingerprint: binding.route_fingerprint,
    });
  }
}
