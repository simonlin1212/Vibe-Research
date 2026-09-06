import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyResearchFailure, researchFailure } from "../src/research_failure.ts";

test("只从执行错误识别额度、登录、限流、超时，未知错误不猜", () => {
  for (const [text, expected] of [
    ["You've hit your usage limit for GPT-5.3-Codex-Spark", "quota"],
    ["insufficient_quota", "quota"], ["agent_quota: 当前额度或频率受限", "quota"],
    ["agent_quota: 429 Too Many Requests", "rate_limit"],
    ["429 insufficient_quota", "quota"],
    ["token_revoked", "authentication"], ["401 Unauthorized", "authentication"],
    ["agent_not_authenticated: 请登录", "authentication"],
    ["429 Too Many Requests", "rate_limit"], ["turn 超时(180000 ms)", "timeout"],
    ["agent_timeout: CLI timed out", "timeout"],
    ["Codex SDK worker exited 1", null], ["network connection closed", null],
  ] as const) assert.equal(classifyResearchFailure(text), expected, text);
  assert.equal(researchFailure("unknown"), null);
  assert.equal(researchFailure("quota")?.retryable, false);
  assert.equal(researchFailure("timeout")?.retryable, true);
});
