/** 页面分析、记录反思是独立请求，不续写全局聊天历史。 */
export function newAnalysisSession(scope: "page-analysis" | "note-reflection" | "report"): string {
  // 与 core/ai/threads 的 UI ID 惯例一致：非安全 HTTP 下也可用，不承担鉴权职责。
  return `${scope}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
