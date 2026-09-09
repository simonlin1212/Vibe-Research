import assert from "node:assert/strict";
import test from "node:test";
import { apiPresetForSaved } from "../src/verticals/finance/lib/ai-models.ts";
import { loadUserLlm, saveUserLlm } from "../src/verticals/finance/lib/llmStore.ts";

test("自定义端点保存重读后保留来源、模型及密钥，预设不按模型名串台 (#48)", () => {
  let stored: string | null = null;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; },
  } });
  for (const [provider, model, preset] of [
    ["openai-compatible", "my-model", "custom"],
    ["openai-compatible", "gpt-4o", "custom"],
    ["openrouter", "my-model", "openai/gpt-4o"],
    ["deepseek", "deepseek-v4-pro", "deepseek-v4-pro"],
  ]) {
    const cfg = { provider, model, apiKey: "fixture-key", baseURL: "https://example.com/v1" };
    saveUserLlm(cfg);
    assert.deepEqual(loadUserLlm(), cfg);
    assert.equal(apiPresetForSaved(loadUserLlm()), preset);
    assert.deepEqual(loadUserLlm(), cfg, "显示预设不得覆盖实际模型或凭据");
  }
});

test("浏览器静默丢弃写入时保存必须报错，不显示成功", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null, setItem: () => {},
  } });
  assert.throws(() => saveUserLlm({ provider: "openai-compatible", model: "test", apiKey: "fixture-key", baseURL: "https://example.com" }), /保存/);
});
