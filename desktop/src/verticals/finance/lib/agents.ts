/**
 * 多 agent 能力(多空辩论 + 反思审计)—— **接我们的底座**。
 *
 * 上游走它自己后端的 NDJSON 流,并把用户的 key 一起发过去。
 * 我们的底座:辩论是 `POST /debate` 开场 + 逐阶段 `POST /debate/:id/advance`,
 * 密钥留在后端。**对外的 handler 事件与上游保持一致**,所以 `Debate.tsx` / `Notes.tsx`
 * 一行不用改。
 *
 * 🔴 我们的辩论有一条上游没有的性质:**资料包在开场那一刻现拉,五个角色共用同一份**
 *    —— 谁也不能靠编数字赢。资料包为空(取数全挂)时**直接拒开**,
 *    因为没有共同事实的"辩论"只是两段作文,而它看着像做过功课。
 */
import { ApiError, backend, type DebateNumberAudit, type DebateState } from "./backend.ts";
import { newAnalysisSession } from "./analysisSession.ts";

export type DebateStage = "bull" | "bear" | "bull_rebut" | "bear_rebut" | "referee";

export interface DebateHandlers {
  onStatus?: (message: string) => void;
  onDossierProgress?: (title: string, ok: boolean, loaded: number, total: number) => void;
  onDossierReady?: (sections: { title: string; tool: string }[], missing: string[]) => void;
  onStageStart?: (stage: DebateStage, label: string) => void;
  onDelta?: (stage: DebateStage, text: string, audit?: DebateNumberAudit) => void;
  onStageDone?: (stage: DebateStage, label: string, content: string) => void;
  onError?: (message: string, stage?: DebateStage) => void;
}

/**
 * 跑一场多空辩论。
 * ⚠️ `rounds` 上游用来加轮次;我们的阶段由**后端契约**声明(`Plugin.debate.stages`),
 *    前端说了不算 —— 收下这个参数只为签名兼容,不假装它起作用。
 * ⚠️ 我们的后端不流式:每个阶段跑完一次性给全文,所以 `onDelta` 每阶段只吐一次。
 */
export async function debateStream(
  code: string,
  /**
   * 深度档位。🔴 原来这里叫 `_rounds` —— 下划线前缀声明「我不用它」,
   *    于是界面上那个"一轮 / 两轮"**选了没有任何效果**,永远跑完整五阶段,
   *    而旁边的耗时提示还跟着档位变:告诉你 100 秒 / 3 次调用,实际 6 分钟 / 5 次。
   *    控件说一套、系统做一套,比没有这个控件更糟。
   */
  rounds: number,
  handlers: DebateHandlers = {},
  signal?: AbortSignal,
): Promise<DebateState | undefined> {
  // 每个事件只发一次 —— 我们是轮询式推进,不去重的话每轮都会把已完成的阶段重发一遍
  const emitted = new Set<string>();
  const push = (st: DebateState) => {
    for (const s of st.stages) {
      if (s.status === "running" && !emitted.has(`start:${s.id}`)) {
        emitted.add(`start:${s.id}`);
        handlers.onStageStart?.(s.id as DebateStage, s.label);
      }
      if (s.status === "done" && !emitted.has(`done:${s.id}`)) {
        emitted.add(`done:${s.id}`);
        if (!emitted.has(`start:${s.id}`)) {
          emitted.add(`start:${s.id}`);
          handlers.onStageStart?.(s.id as DebateStage, s.label);
        }
        handlers.onDelta?.(s.id as DebateStage, s.text, s.audit);
        handlers.onStageDone?.(s.id as DebateStage, s.label, s.text);
      }
      if (s.status === "failed" && !emitted.has(`fail:${s.id}`)) {
        emitted.add(`fail:${s.id}`);
        // 单个阶段挂掉不废整场,但要说清是哪一环没打上
        handlers.onError?.(s.error ?? "这一环没打上", s.id as DebateStage);
      }
    }
  };

  try {
    if (signal?.aborted) return undefined;
    handlers.onStatus?.("正在现拉资料包(五个角色共用同一份)…");
    if (signal?.aborted) return undefined;
    let st = await backend.debateStart(code, String(rounds), signal);
    if (signal?.aborted) return undefined;
    handlers.onDossierReady?.([{ title: `资料包 ${st.evidence_count} 条证据`, tool: "取数层" }], st.gaps);
    handlers.onStatus?.(st.gaps.length ? "资料包就绪(有缺口,已告知双方),辩论开始" : "资料包就绪,辩论开始");
    push(st);

    while (!st.done) {
      if (signal?.aborted) return undefined;
      st = await backend.debateAdvance(st.id, signal);
      if (signal?.aborted) return undefined;
      push(st);
    }
    // 🔴 全挂了要说全挂了 —— 只看 done 会把"五段全空"读成"辩论正常完成"
    const shutdownFailure = st.stages.find(s => s.error?.startsWith("agent_shutdown_failed:"))?.error;
    if (shutdownFailure) handlers.onError?.(shutdownFailure);
    else if (st.outcome === "cancelled") handlers.onStatus?.("辩论已中止");
    else if (st.outcome === "failed") handlers.onError?.(st.stages.some(s => s.status === "done")
      ? "辩论未能完成，已完成部分保留；请检查阶段错误"
      : "所有阶段都失败了:不是「没有分歧」,是根本没跑起来");
    else handlers.onStatus?.(st.outcome === "completed_with_errors" ? "跑完了,但有环节没打上" : "辩论结束");
    return st;
  } catch (e) {
    if (signal?.aborted) return undefined;
    handlers.onError?.(e instanceof ApiError ? e.message : String(e));
    return undefined;
  }
}

export interface ReflectHandlers {
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
  onDone?: (content: string, truncated: boolean) => void;
  onError?: (message: string) => void;
}

/**
 * 对一段已写好的分析做**推理审计**:哪些有数据撑着、哪些是脑补、最脆弱的一环在哪。
 * ⚠️ 明确要求它**只审不建议** —— 审计一旦滑成"那你应该怎么做",就越过产出红线了。
 */
export async function reflectStream(
  source: string,
  title: string,
  handlers: ReflectHandlers = {},
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    handlers.onStatus?.("审计中…");
    const msg = [
      "回头审下面这段我自己写的推理,逐条标出:哪些结论有数据撑着、哪些是脑补、最脆弱的一环在哪。",
      "**只做审计,不要给我任何操作建议。**",
      "",
      `标题:${title}`,
      "",
      source || "(没有正文)",
    ].join("\n");
    const r = await backend.chat(msg, newAnalysisSession("note-reflection"), signal);
    if (signal?.aborted) return;
    handlers.onDelta?.(r.reply);
    handlers.onDone?.(r.reply, false);
  } catch (e) {
    if (signal?.aborted) return;
    handlers.onError?.(e instanceof ApiError ? e.message : String(e));
  }
}
