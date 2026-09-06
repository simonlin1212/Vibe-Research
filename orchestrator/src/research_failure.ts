/** 只分类执行器的错误通道；不要用于报告、来源文本或模型正常回答。 */
export const FAILURE_CODES = ["quota", "authentication", "rate_limit", "timeout"] as const;
export type ResearchFailureCode = typeof FAILURE_CODES[number];
export interface ResearchFailure { code: ResearchFailureCode; message: string; action: string; retryable: boolean }

export function classifyResearchFailure(error: string): ResearchFailureCode | null {
  if (/agent_not_authenticated|token_revoked|token_expired|invalid_api_key|not logged in|login required|unauthori[sz]ed|\b401\b/i.test(error)) return "authentication";
  // CLI 旧契约 agent_quota 合并了额度与限流；不把它伪装成精确余额判断。
  if (/insufficient_quota|quota[ _-]?(?:exceeded|exhausted)|exceeded your current quota|usage limit|额度(?:耗尽|不足)/i.test(error)) return "quota";
  if (/rate[ _-]?limit|too many requests|\b429\b/i.test(error)) return "rate_limit";
  if (/agent_quota|额度或频率受限/i.test(error)) return "quota";
  if (/agent_timeout|\btimed? out\b|\btimeout\b|超时/i.test(error)) return "timeout";
  return null;
}

/** 固定文案，不向界面转发供应商错误中的凭据、路径或自由文本。 */
export function researchFailure(code: unknown): ResearchFailure | null {
  switch (code) {
    case "quota": return { code, retryable: false, message: "模型额度或使用限额已用尽，本次研究已停止。", action: "等待额度恢复，或在 AI 接入设置中选择其他模型后重新发起研究。不会自动切换模型。" };
    case "authentication": return { code, retryable: false, message: "模型登录或 API 凭据已失效，本次研究已停止。", action: "在 AI 接入设置中重新登录或检查 API 密钥，测试连接成功后重新发起研究。" };
    case "rate_limit": return { code, retryable: true, message: "模型请求持续受到限流，本次研究已停止。", action: "稍后重新发起研究；不会自动切换供应商或模型。" };
    case "timeout": return { code, retryable: true, message: "模型响应超时，本次研究已停止。", action: "检查连接或在 AI 接入设置中选择其他模型，再重新发起研究。" };
    default: return null;
  }
}
