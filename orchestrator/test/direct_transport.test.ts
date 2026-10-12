import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DirectTransportError, chatCompletion, publicApiFailure, scrubSecrets } from "../src/engines/direct_transport.ts";
import { apiCapabilityOf, type ProviderProfileFile } from "../src/providers.ts";
import { resolveDirectProvider } from "../src/runtime_provider.ts";

/**
 * **直连传输层**的故障矩阵。
 *
 * 用本地假服务器而不是真实端点:真实 API 造不出"200 却带 error 体""返回半截 JSON""choices 为空"
 * 这些故障,而它们恰恰是兼容网关最常见的毛病 —— 也是最容易被当成"模型没话说"而静默吞掉的那类。
 *
 * 🔴 每条断言都盯着同一件事:**失败必须说得清是什么失败,并且不能把密钥带出来**。
 */

const FAKE_KEY = "sk-test-1234567890abcdefghij";

/** 起一个一次性假端点;返回 baseURL 与关闭函数 */
async function fakeEndpoint(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function ok(body: unknown) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const baseReq = { apiKey: FAKE_KEY, model: "m", messages: [{ role: "user" as const, content: "hi" }], timeoutMs: 5_000 };

for (const cancel of [false, true]) test(`响应头之后仍可${cancel ? "取消" : "超时"}`, async () => {
  const ac = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const ep = await fakeEndpoint((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders();
    // 兜底关闭让旧实现失败而不无限挂住。
    timers.push(setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "late" } }] })), 1800));
    if (cancel) timers.push(setTimeout(() => ac.abort(), 50));
  });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 1000, signal: ac.signal }),
      (e: unknown) => e instanceof DirectTransportError && e.code === (cancel ? "cancelled" : "timeout"));
  } finally { timers.forEach(clearTimeout); await ep.close(); }
});

test("本机 HTTP 模型配置通过真实解析后能完成直连请求", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-http-"));
  let requested = "";
  const ep = await fakeEndpoint((req, res) => {
    requested = req.url ?? "";
    ok({ choices: [{ message: { role: "assistant", content: "local-ready" }, finish_reason: "stop" }] })(req, res);
  });
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/local-fixture.json"), JSON.stringify({
      id: "local-fixture", name: "Fixture only", base_url: ep.baseURL,
      env_key: "LOCAL_TEST_KEY", default_model: "local-model",
      direct: { supported: true, base_url: ep.baseURL, structured_output: "prompt" },
    }));
    const config = resolveDirectProvider(repo, dataRoot, {
      provider: "local-fixture", apiKey: FAKE_KEY, model: "local-model",
    });
    const result = await chatCompletion({ ...baseReq, ...config });
    assert.equal(result.message.content, "local-ready");
    assert.equal(requested, "/v1/chat/completions");
  } finally { await ep.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("Base URL 已经写到完整端点(带 /chat/completions)时不再重复拼接", async () => {
  // 用户常把服务商文档里的完整地址整条贴进 Base URL;再拼一次就成了 …/chat/completions/chat/completions,服务端只会回 404。
  const paths: string[] = [];
  const ep = await fakeEndpoint((req, res) => {
    paths.push(req.url ?? "");
    ok({ choices: [{ message: { role: "assistant", content: "ok" } }] })(req, res);
  });
  try {
    for (const baseURL of [`${ep.baseURL}/chat/completions`, `${ep.baseURL}/chat/completions/`]) {
      const r = await chatCompletion({ ...baseReq, baseURL });
      assert.equal(r.message.content, "ok");
    }
    assert.deepEqual(paths, ["/v1/chat/completions", "/v1/chat/completions"],
      "已经带 /chat/completions 的 Base URL 不该再接一段,否则一定 404");
  } finally { await ep.close(); }
});

test("HTTP 404 的文案指向 Base URL,不再把锅甩给模型名 / 上下文", () => {
  const f = publicApiFailure(new DirectTransportError("http_error", "模型端点返回 404:404 page not found", 404, false),
    "模型名不对、上下文过长，或这个模型不支持工具调用");
  assert.equal(f.code, "api_request_rejected");
  assert.match(f.message, /Base URL/, `404 要指向 Base URL:${f.message}`);
  assert.ok(!/模型名不对/.test(f.message), `404 不该再提模型名:${f.message}`);
  // 桌面端会把含 http(s):// 的文案吞成"连接失败" —— 后端自己写的文案不能带 URL
  assert.ok(!/https?:\/\//i.test(f.message), `文案不能带 URL:${f.message}`);
});

test("正常回复:解析出消息、finish_reason 与 usage", async () => {
  const ep = await fakeEndpoint(ok({
    choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { total_tokens: 12 },
  }));
  try {
    const r = await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.equal(r.message.content, "你好");
    assert.equal(r.finishReason, "stop");
    assert.deepEqual(r.usage, { total_tokens: 12 });
    assert.ok(r.durationMs >= 0);
  } finally { await ep.close(); }
});

test("工具调用:tool_calls 原样带回(id 与 arguments 一个字符都不能丢)", async () => {
  const call = { id: "call_x", type: "function", function: { name: "list_run_files", arguments: '{"a":1}' } };
  const ep = await fakeEndpoint(ok({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] }));
  try {
    const r = await chatCompletion({ ...baseReq, baseURL: ep.baseURL, tools: [{ name: "list_run_files", description: "d", parameters: { type: "object", properties: {} } }] });
    assert.equal(r.finishReason, "tool_calls");
    assert.deepEqual(r.message.tool_calls, [call]);
  } finally { await ep.close(); }
});

test("请求体:声明了工具就必须带 tools 与 tool_choice,没声明就一个都不许出现", async () => {
  let seen: Record<string, unknown> = {};
  const ep = await fakeEndpoint((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  try {
    await chatCompletion({ ...baseReq, baseURL: ep.baseURL, tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] });
    assert.equal((seen.tools as unknown[]).length, 1);
    assert.equal(seen.tool_choice, "auto");
    assert.equal(((seen.tools as { type: string }[])[0]).type, "function", "工具必须包成 {type:'function', function:{...}}");

    await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.equal(seen.tools, undefined, "没声明工具时不该发 tools");
    assert.equal(seen.tool_choice, undefined, "没声明工具时不该发 tool_choice");

    await chatCompletion({ ...baseReq, baseURL: ep.baseURL, responseFormat: { type: "json_object" } });
    assert.deepEqual(seen.response_format, { type: "json_object" }, "结构化输出约束不能被静默丢掉");
  } finally { await ep.close(); }
});

test("200 却带 error 体:必须报错,不能当成空回复", async () => {
  const ep = await fakeEndpoint(ok({ error: { message: "quota exhausted", type: "insufficient_quota" } }));
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "upstream_error" && /quota exhausted/.test(e.message));
  } finally { await ep.close(); }
});

test("choices 为空:报 empty_choice,不许悄悄返回空字符串", async () => {
  const ep = await fakeEndpoint(ok({ choices: [] }));
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "empty_choice");
  } finally { await ep.close(); }
});

test("返回半截 JSON:报 bad_json 且可重试", async () => {
  const ep = await fakeEndpoint((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"choices":[{'); });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "bad_json" && e.retryable);
  } finally { await ep.close(); }
});

test("HTTP 错误:429 / 5xx 判可重试,4xx 判不可重试(重试 4xx 只是重复烧钱)", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false], [401, false]] as [number, boolean][]) {
    const ep = await fakeEndpoint((_req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: "nope" })); });
    try {
      await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
        (e: unknown) => e instanceof DirectTransportError && e.code === "http_error" && e.status === status && e.retryable === retryable,
        `${status} 的可重试判定不对`);
    } finally { await ep.close(); }
  }
});

test("超时:报 timeout 而不是卡死,且判可重试", async () => {
  const ep = await fakeEndpoint(() => { /* 故意不回应 */ });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 1_000 }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "timeout" && e.retryable);
  } finally { await ep.close(); }
});

test("外部取消:与超时区分开,且**不**判可重试(用户叫停就是叫停)", async () => {
  const ep = await fakeEndpoint(() => { /* 故意不回应 */ });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 30_000, signal: ac.signal }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "cancelled" && !e.retryable);
  } finally { await ep.close(); }
});

test("🔴 密钥绝不进错误消息(错误会写进事件流、日志和界面)", async () => {
  // 上游把 Authorization 回显到错误体里 —— 兼容网关真的会这么干
  const ep = await fakeEndpoint((_req, res) => {
    res.writeHead(401);
    res.end(JSON.stringify({ error: `invalid key: ${FAKE_KEY}; header was Bearer ${FAKE_KEY}` }));
  });
  try {
    await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.fail("应当抛错");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes(FAKE_KEY), `密钥泄漏进了错误消息:${msg}`);
    assert.match(msg, /\*\*\*/, "应当留下被抹掉的痕迹,而不是整段删掉(否则看不出这里原本有东西)");
  } finally { await ep.close(); }
});

test("scrubSecrets:已知值与通用形态都要抹(只抹一种都会漏)", () => {
  assert.ok(!scrubSecrets(`key=${FAKE_KEY}`, FAKE_KEY).includes(FAKE_KEY));
  // 不长成 sk- 的密钥,靠"已知值"这条抹掉
  assert.equal(scrubSecrets("token=abcdefghijklmnop", "abcdefghijklmnop"), "token=***");
  // 不知道具体值时,靠形态抹掉
  assert.ok(!scrubSecrets("leak sk-abcdefghijklmnopqrstuvwx here").includes("abcdefghijklmnopqrstuvwx"));
  assert.equal(scrubSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer ***");
});

test("短密钥也不进错误消息;先脱敏再截断,截在密钥中间也不留半截", async () => {
  // 自建端点常用短占位密钥。这里只处理上游诊断,宁可多抹:被拼进 invalid_<key> 这类标识也要抹,不讲整词边界
  assert.equal(scrubSecrets("invalid key: k9x (header Bearer k9x)", "k9x"), "invalid key: *** (header Bearer ***)");
  assert.equal(scrubSecrets("invalid_k9x_token", "k9x"), "invalid_***_token");
  assert.equal(scrubSecrets("k9xy 也一并抹掉", "k9x"), "***y 也一并抹掉");
  // 截断恰好切开密钥:它不像 sk- 也不跟在 Bearer 后,只能靠已知值抹 —— 截断后再抹就对不上了。
  // 四个出口各测一次:HTTP 错误体 / 不是 JSON / 200 + error 体(序列化后多一个引号)/ choices 为空(只留 200 字)
  const key = "zq-" + "A".repeat(30);
  const bodies: [number, string][] = [
    [400, "x".repeat(590) + key],
    [200, "x".repeat(590) + key],
    [200, JSON.stringify({ error: "x".repeat(589) + key })],
    [200, JSON.stringify({ choices: [], pad: "x".repeat(170) + key })],
  ];
  for (const [status, body] of bodies) {
    const ep = await fakeEndpoint((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    try {
      await assert.rejects(chatCompletion({ ...baseReq, apiKey: key, baseURL: ep.baseURL }),
        (e: unknown) => e instanceof DirectTransportError && !(e as Error).message.includes(key.slice(0, 6)), body.slice(0, 30));
    } finally { await ep.close(); }
  }
});

test("含引号 / 反斜杠的密钥在 JSON 错误体里是转义形态,四个出口都不能漏(原样、转义形态、尾段都不许出现)", async () => {
  const key = 'ab"cd\\ef-' + "Q".repeat(24);
  const escaped = JSON.stringify(key).slice(1, -1);
  assert.equal(scrubSecrets(`{"message":"${escaped}"}`, key), '{"message":"***"}');
  const bodies: [number, string][] = [
    [401, JSON.stringify({ error: { message: "Incorrect API key provided: " + key } })],
    [200, JSON.stringify({ error: { message: "invalid_" + key + "_token" } })],
    [200, `not json "${escaped}"`],
    [200, JSON.stringify({ choices: [], echo: key })],
  ];
  for (const [status, body] of bodies) {
    const ep = await fakeEndpoint((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    try {
      await assert.rejects(chatCompletion({ ...baseReq, apiKey: key, baseURL: ep.baseURL }), (e: unknown) => {
        const message = (e as Error).message;
        return e instanceof DirectTransportError && !message.includes(key) && !message.includes(escaped) && !message.includes("QQQQ");
      }, body.slice(0, 40));
    } finally { await ep.close(); }
  }
});

for (const status of [302, 307, 308]) test(`端点返回 ${status} 跳转:不跟随(远程分享页只校验填写的那一跳),明确报错`, async () => {
  const paths: string[] = [];
  const ep = await fakeEndpoint((req, res) => {
    paths.push(req.url ?? "");
    if (req.url === "/v1/chat/completions") { res.writeHead(status, { location: "/elsewhere/chat/completions" }); res.end(); return; }
    ok({ choices: [{ message: { role: "assistant", content: "不该到这里" }, finish_reason: "stop" }] })(req, res);
  });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "redirect" && /跳转/.test(e.message) && !e.retryable);
    assert.deepEqual(paths, ["/v1/chat/completions"], "跳转目标一次都不能被请求");
  } finally { await ep.close(); }
});

// 不量墙钟(慢机器调度会误报,Codex 复审 R4-4):若实现先读响应体,这里要等到 10 秒请求超时、报成 timeout,
// 下面"code === redirect"那条就会红。整体超时只防挂死。
test("跳转的响应体挂住:拿到响应头就按跳转报错(不可重试),不等到超时、也不报成网络错误", { timeout: 60_000 }, async (t) => {
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "/elsewhere/chat/completions", "content-length": "1000" });
    res.write("partial");   // 故意不写完:响应体永远读不完
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // 清理挂在 t.after、不放 finally:整体超时只把测试判失败,不会打断下面的 await,finally 根本不执行,
  // 还在监听的 server 会让测试进程一直挂着(Codex 复审 R5-1,Node 26 实测)
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => { server.close(() => r()); });
  });
  await assert.rejects(chatCompletion({ ...baseReq, baseURL: `http://127.0.0.1:${port}/v1`, timeoutMs: 10_000 }),
    (e: unknown) => e instanceof DirectTransportError && e.code === "redirect" && e.status === 302 && !e.retryable && /最终/.test(e.message));
});

// ───────────── 模板的 API 能力声明 ─────────────

const baseProfile: ProviderProfileFile = {
  id: "x", name: "X", base_url: "https://api.example.com/v1", env_key: "X_API_KEY", default_model: "x-1",
};

test("没有 direct 段 = **没测过**:照样能用,但必须如实标未实测,而不是「已验证的保守选择」", () => {
  const cap = apiCapabilityOf(baseProfile);
  assert.equal(cap.usable, true);
  if (!cap.usable) return;
  assert.equal(cap.verified, false, "必须标成未实测 —— 否则界面会把'我们不知道'显示成'产品的结论'");
  assert.equal(cap.structuredOutput, "prompt", "没测过就按最保守的走");
  assert.match(cap.reason, /还没实测过/);
});

test("模板声明实测不可用:拒绝接入(api_unsupported),和'没测过'不是一回事", () => {
  const cap = apiCapabilityOf({ ...baseProfile, direct: { supported: false, structured_output: "prompt", verified_at: "2026-09-04" } });
  assert.equal(cap.usable, false);
  if (cap.usable) return;
  assert.equal(cap.code, "api_unsupported");
  assert.match(cap.reason, /2026-09-04/);
});

test("模板与实测段都没给地址 → needs_base_url(要用户填),不拿空地址去发请求", () => {
  const cap = apiCapabilityOf({ ...baseProfile, base_url: null });
  assert.equal(cap.usable, false);
  if (!cap.usable) assert.equal(cap.code, "needs_base_url");
});

test("🔴 结构化能力只认 direct 段,不退回去读 v1 留下的顶层 structured_output(那是旧 Responses 端点的口径)", () => {
  const legacy = {
    ...baseProfile,
    structured_output: "prompt",                                   // ← v1 旧覆盖模板里的 Responses 口径
    direct: { supported: true, structured_output: "server_schema", verified_at: "2026-09-04" },
  } as ProviderProfileFile;
  const cap = apiCapabilityOf(legacy);
  assert.equal(cap.usable, true);
  if (!cap.usable) return;
  assert.equal(cap.structuredOutput, "server_schema",
    "读成了顶层那个字段 —— 会白白降级成提示词模式,而这家其实支持服务端 schema");
  assert.equal(cap.verified, true);
});

test("实测段的地址与默认模型覆盖顶层", () => {
  const cap = apiCapabilityOf({ ...baseProfile, direct: { supported: true, base_url: "https://cc.example.com/v1", default_model: "x-cc", structured_output: "prompt" } });
  assert.equal(cap.usable, true);
  if (!cap.usable) return;
  assert.equal(cap.baseURL, "https://cc.example.com/v1");
  assert.equal(cap.model, "x-cc");
});

test("🔴 成功回复里回显的 key 被抹掉:正文、思考内容、工具参数;短 key 只抹独立整段(审计 A3)", async () => {
  const longKey = "fixture-secret-ABCDEFGH";
  const ep = await fakeEndpoint(ok({ choices: [{ message: {
    role: "assistant", content: `你的 key 是 ${longKey},再说一遍:${longKey}`, reasoning_content: `看到 ${longKey}`,
    tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: JSON.stringify({ q: longKey }) } }],
  } }] }));
  try {
    const r = await chatCompletion({ ...baseReq, apiKey: longKey, baseURL: ep.baseURL });
    const all = JSON.stringify(r.message);
    assert.equal(all.includes(longKey), false, all);
    assert.match(String(r.message.content), /\[已移除:你的 API key\]/);
    assert.deepEqual(JSON.parse(r.message.tool_calls![0]!.function.arguments), { q: "[已移除:你的 API key]" }, "工具参数仍是合法 JSON");
  } finally { await ep.close(); }

  const shortKey = "abcdefg";
  const ep2 = await fakeEndpoint(ok({ choices: [{ message: { role: "assistant", content: `key: ${shortKey}。另有单词 xabcdefgx 不动` } }] }));
  try {
    const r = await chatCompletion({ ...baseReq, apiKey: shortKey, baseURL: ep2.baseURL });
    assert.equal(r.message.content, "key: [已移除:你的 API key]。另有单词 xabcdefgx 不动");
  } finally { await ep2.close(); }
});

test("🔴 key 里带引号:工具参数先解码再抹,正文里的转义形态也抹;没有 key 的参数原样不改写(审计第三轮 A3)", async () => {
  const key = 'audit"secretabcdefgh';
  const escaped = JSON.stringify(key).slice(1, -1);
  const ep = await fakeEndpoint(ok({ choices: [{ message: {
    role: "assistant", content: `回显:${escaped}`,
    tool_calls: [
      { id: "t1", type: "function", function: { name: "f", arguments: JSON.stringify({ content: `key=${key}`, [key]: 1 }) } },
      { id: "t2", type: "function", function: { name: "g", arguments: '{ "q" : 1 }' } },
      // 引号写成 \u0022:按原文和 JSON 转义形态都找不到,解码后才是完整 key
      { id: "t3", type: "function", function: { name: "h", arguments: '{"content":"key=audit\\u0022secretabcdefgh"}' } },
    ],
  } }] }));
  try {
    const r = await chatCompletion({ ...baseReq, apiKey: key, baseURL: ep.baseURL });
    assert.equal(String(r.message.content).includes("secretabcdefgh"), false, String(r.message.content));
    const args = r.message.tool_calls![0]!.function.arguments;
    const parsed = JSON.parse(args) as Record<string, unknown>;
    assert.equal(JSON.stringify(parsed).includes("secretabcdefgh"), false, args);
    assert.equal(parsed.content, "key=[已移除:你的 API key]");
    assert.equal(r.message.tool_calls![1]!.function.arguments, '{ "q" : 1 }', "没有要抹的就一个字符都不改");
    assert.equal((JSON.parse(r.message.tool_calls![2]!.function.arguments) as { content: string }).content, "key=[已移除:你的 API key]");
  } finally { await ep.close(); }
});
