import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import "../src/finance/register.ts";
import { DirectTransportError, apiFailureDetail, guardListedModels, listModels, modelListUrl, parseModelList } from "../src/engines/direct_transport.ts";
import { ChatError, chatSend, llmProbe, resetChatSessions } from "../src/chat.ts";

const KEY = "sk-model-list-secret-123456";

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test("modelListUrl:根地址、完整 chat/completions 端点、已带 /models 都拼成同一个列表地址", () => {
  assert.equal(modelListUrl("https://api.deepseek.com"), "https://api.deepseek.com/models");
  assert.equal(modelListUrl("https://x.test/v1/"), "https://x.test/v1/models");
  assert.equal(modelListUrl("https://x.test/v1/chat/completions"), "https://x.test/v1/models");
  assert.equal(modelListUrl("https://x.test/v1/models"), "https://x.test/v1/models");
});

test("parseModelList:data 数组 / models 对象 / 坏行跳过 / 去重;读不懂的结构明确报错", () => {
  assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "b", name: "B", context_length: 1000 }, {}, { id: "a" }] }),
    [{ id: "a", name: "a" }, { id: "b", name: "B", contextWindow: 1000 }]);
  assert.deepEqual(parseModelList({ models: { alias: { id: "canon", display_name: "Alias" }, skip: 1 } }),
    [{ id: "alias", name: "Alias" }]);
  assert.throws(() => parseModelList({ hello: 1 }), (e: unknown) => e instanceof DirectTransportError && e.code === "bad_listing");
});

test("listModels:带 Bearer 请求 /models 并解析", async () => {
  let auth = "", url = "";
  await withServer((req, res) => { auth = String(req.headers.authorization); url = req.url ?? ""; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] })); },
    async (base) => {
      const { models, hidden } = await listModels({ baseURL: `${base}/v1/chat/completions`, apiKey: KEY, timeoutMs: 5000, publicOnly: false });
      assert.deepEqual(models.map((m) => m.id), ["m1", "m2"]);
      assert.equal(hidden, 0);
      assert.equal(auth, `Bearer ${KEY}`);
      assert.equal(url, "/v1/models");
    });
});

test("🔴 成功的模型列表也守住 key:id 回显 key 的整行丢弃(不改写成另一个可选模型),名称回显 key 的脱敏后保留", async () => {
  const escaped = `${KEY}"q`;   // 带引号的 key:网关回显的是 JSON 转义形态
  const fake = {
    data: [
      { id: "good-model", name: "Good" },
      { id: `invalid_${KEY}`, name: "id 里拼了 key" },                // 原样回显在 id
      { id: KEY },                                                       // id 就是 key
      { id: "named-leak", name: `Echo ${KEY} back` },                    // 名称回显
      { id: "sk-abcdefghijklmnopqrstu", name: "通用密钥形态的 id" },      // 别的密钥形态也不放行
      { id: "display-leak", display_name: `Bearer ${KEY}` },
    ],
  };
  await withServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(fake)); },
    async (base) => {
      const { models, hidden } = await listModels({ baseURL: base, apiKey: KEY, timeoutMs: 5000, publicOnly: false });
      assert.deepEqual(models.map((m) => m.id), ["good-model", "named-leak", "display-leak"], "含密钥的 id 整行丢弃,不出现被抹过的替身 id");
      assert.equal(hidden, 3);
      const all = JSON.stringify(models);
      assert.ok(!all.includes(KEY), `返回里还有 key:${all}`);
      assert.ok(!models.some((m) => m.id.includes("***")), "不许把抹掉后的字符串当成可选模型 id");
      assert.equal(models.find((m) => m.id === "named-leak")?.name, "Echo *** back");
    });
  // JSON 转义形态
  const g = guardListedModels([{ id: `x-${JSON.stringify(escaped).slice(1, -1)}`, name: "n" }, { id: "ok", name: JSON.stringify(escaped) }], escaped);
  assert.deepEqual(g.models.map((m) => m.id), ["ok"]);
  assert.equal(g.hidden, 1);
  assert.ok(!g.models[0]!.name.includes(KEY));
});

test("listModels 失败:401 / 404 / 非 JSON / 跳转 / 连不上,都带状态码与上游原文,且抹掉 key", async () => {
  const cases: [number, string, string, string][] = [
    [401, `{"error":"bad key ${KEY}"}`, "http_error", "HTTP 401"],
    [404, "404 page not found", "http_error", "HTTP 404"],
    [200, "<html>gateway</html>", "bad_json", "<html>gateway</html>"],
    [302, "", "redirect", "HTTP 302"],
  ];
  for (const [status, body, code, shown] of cases) {
    await withServer((_req, res) => { res.statusCode = status; if (status === 302) res.setHeader("location", "http://127.0.0.1:1/"); res.end(body); },
      async (base) => {
        await assert.rejects(listModels({ baseURL: base, apiKey: KEY, timeoutMs: 5000, publicOnly: false }), (e: unknown) => {
          assert.ok(e instanceof DirectTransportError);
          assert.equal(e.code, code);
          const detail = apiFailureDetail(e, KEY);
          assert.ok(detail.includes(shown), `${detail} 应含 ${shown}`);
          assert.ok(!detail.includes(KEY), "detail 不得含 key");
          return true;
        });
      });
  }
  await assert.rejects(listModels({ baseURL: "http://127.0.0.1:9", apiKey: KEY, timeoutMs: 5000, publicOnly: false }),
    (e: unknown) => e instanceof DirectTransportError && e.code === "network_error" && /127\.0\.0\.1:9\/models/.test(e.message));
});

test("连接探针失败时 ChatError 带排查明细(状态码 + 上游原文),且不含 key;message 仍是固定文案", async () => {
  resetChatSessions();
  const err = new DirectTransportError("http_error", `模型端点返回 400:{"error":"model not found ${KEY}"}`, 400, false);
  await assert.rejects(
    llmProbe({ repoRoot: process.cwd().replace(/orchestrator$/, ""), apiComplete: async () => { throw err; } },
      { llm: { provider: "openai-compatible", baseURL: "https://x.test/v1", apiKey: KEY, model: "m" } }),
    (e: unknown) => e instanceof ChatError && e.code === "api_request_rejected"
      && /HTTP 400/.test(e.detail ?? "") && /model not found/.test(e.detail ?? "") && !(e.detail ?? "").includes(KEY)
      && !e.message.includes("model not found"),
  );
  void chatSend;
});
