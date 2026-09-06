import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codexEnvFor, makeConfig } from "../src/config.ts";
import { loadProductConfig } from "../src/productConfig.ts";
import { assertAuth, codexProviderConfig, listProviderIds, loadProviderProfile, providerEnv, structuredOutputMode, validateProfile, withOutputSchema } from "../src/providers.ts";
import { codexOptionsFor } from "../src/runner.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 把模板里留给用户填的占位符换成一个合法值 —— 只用于"模板本身是否自洽"的校验 */
const fillPlaceholders = (raw: string): string => raw.replace(/[{<][A-Za-z_][A-Za-z0-9_]*[}>]/g, "filled-by-user");

test("providers:产品模板全部通过 schema;openai 为 responses 原生;国产模板 responses + api_key + requires_openai_auth=false;不含密钥", () => {
  const ids = listProviderIds(REPO, path.join(REPO, ".local"));
  assert.ok(ids.includes("openai") && ids.includes("deepseek") && ids.includes("qwen") && ids.includes("glm") && ids.includes("kimi"), ids.join(","));
  for (const id of ids) {
    const raw = fs.readFileSync(path.join(REPO, "providers", `${id}.json`), "utf8");
    // 带占位符的模板 loadProviderProfile 会按设计拒绝(下一个 test 验),所以这里补上占位再校验模板本身是否自洽
    const profile = validateProfile(JSON.parse(fillPlaceholders(raw)), `模板 ${id}`);
    assert.equal(profile.id, id);
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw) && !/Bearer\s+\S{8,}/.test(raw), `${id} 模板含密钥样式`);
    if (id === "openai") { assert.equal(profile.wire_api, "responses"); assert.equal(profile.base_url, null); assert.ok(profile.auth_modes.includes("chatgpt_login")); }
    else {
      // 🔴 2026-08-26 起:引擎硬拒 wire_api="chat",所以**没有任何模板**还能是 chat。
      //    国产厂商这边的现状(当日核实):DeepSeek 官方已原生支持 Responses;
      //    Qwen / Kimi / GLM 走阿里云百炼的 compatible-mode;智谱官方无原生 /responses。
      assert.equal(profile.wire_api, "responses", `${id} 不能再用 chat 协议(引擎已移除)`);
      assert.equal(profile.requires_openai_auth, false);
      assert.deepEqual(profile.auth_modes, ["api_key"]);
      assert.ok(profile.base_url!.startsWith(id === "selfhosted" ? "http://localhost:" : "https://"));
    }
  }
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "nope"), /未知 provider/);
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "../x"), /非法 provider id/);
});

test("providers:带占位符的模板不能直接用 —— 选用时当场拒,而不是发一个坏 URL 出去", () => {
  const dir = path.join(REPO, "providers");
  const withPh: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { base_url: string | null };
    if (raw.base_url && /[{<][A-Za-z_]/.test(raw.base_url)) withPh.push(path.basename(f, ".json"));
  }
  // 百炼那三个模板的 base_url 里带 {WorkspaceId} —— 用户不填就用不了,这是事实不是缺陷
  assert.ok(withPh.length >= 1, "至少有一个模板需要用户填占位符");
  for (const id of withPh) {
    assert.throws(
      () => loadProviderProfile(REPO, path.join(REPO, ".local"), id),
      /占位符/,
      `${id} 应在选用时因占位符被拒`,
    );
  }
});

test("#34 selfhosted 覆盖流程保留未验证与远程 HTTPS 边界", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-selfhosted-"));
  try {
    assert.throws(() => loadProviderProfile(REPO, dataRoot, "selfhosted"), /占位符/);
    const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "providers/selfhosted.json"), "utf8"));
    assert.equal(tpl.matrix.status, "unverified");
    assert.equal(tpl.default_model, null);
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/selfhosted.json"), JSON.stringify({ ...tpl,
      base_url: "http://127.0.0.1:11434/v1", default_model: "test-model" }));
    const profile = loadProviderProfile(REPO, dataRoot, "selfhosted").profile;
    assert.equal(profile.base_url, "http://127.0.0.1:11434/v1");
    assert.equal(profile.default_model, "test-model");
    assert.throws(() => validateProfile({ ...profile, base_url: "http://192.168.1.10:8000/v1" }, "t"), /HTTPS/);
    assert.throws(() => validateProfile({ ...profile, base_url: "ftp://example.com/v1" }, "t"), /schema/);
    assert.doesNotThrow(() => validateProfile({ ...profile, base_url: "https://model.example.com/v1" }, "t"));
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("providers:validateProfile 拒绝密钥值 / 非 openai requires_openai_auth / openai 自定义 base_url / 非法 env_key", () => {
  const base = { id: "x", name: "X", wire_api: "responses", base_url: "https://x.example/v1", env_key: "X_API_KEY", auth_modes: ["api_key"], requires_openai_auth: false, default_model: "m", responses_support: "native" };
  // 引擎已移除 chat:契约层必须当场拒,并说清两条出路(换 Responses 端点 / 架网关)
  assert.throws(() => validateProfile({ ...base, wire_api: "chat", responses_support: "none" }, "t"), /不再支持 wire_api="chat"|不再支持 wire_api/);
  assert.equal(validateProfile(base, "t").id, "x");
  assert.throws(() => validateProfile({ ...base, http_headers: { Authorization: "Bearer sk-abcdefghijklmnop" } }, "t"), /密钥/);
  assert.throws(() => validateProfile({ ...base, query_params: { api_key: "0123456789abcdef" } }, "t"), /密钥/);
  assert.throws(() => validateProfile({ ...base, requires_openai_auth: true }, "t"), /requires_openai_auth/);
  assert.throws(() => validateProfile({ ...base, id: "openai", wire_api: "responses" }, "t"), /base_url 必须为 null/);
  assert.throws(() => validateProfile({ ...base, env_key: "PATH" }, "t"), /schema/);
  assert.throws(() => validateProfile({ ...base, base_url: "http://insecure" }, "t"), /HTTPS/);
  assert.throws(() => validateProfile({ ...base, extra: 1 }, "t"), /schema/);
});

test("providers:Codex 配置映射与环境注入(密钥只按 env_key 名透传;openai 另加 CODEX_API_KEY;chatgpt_login 不注入)", () => {
  const ds = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const cfg = codexProviderConfig(ds) as { model_provider: string; model_providers: Record<string, Record<string, unknown>> };
  assert.equal(cfg.model_provider, "deepseek");
  assert.deepEqual(cfg.model_providers.deepseek, { name: ds.name, base_url: "https://api.deepseek.com", env_key: "DEEPSEEK_API_KEY", wire_api: "responses", requires_openai_auth: false });
  assert.deepEqual(codexProviderConfig(loadProviderProfile(REPO, path.join(REPO, ".local"), "openai").profile), {});
  assert.deepEqual(providerEnv(ds, "api_key", { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2", OTHER_TOKEN: "x" }), { DEEPSEEK_API_KEY: "k1" });
  assert.throws(() => providerEnv(ds, "api_key", {}), /DEEPSEEK_API_KEY/);
  assert.throws(() => providerEnv(ds, "chatgpt_login", {}), /不支持 chatgpt_login/);
  assert.throws(() => providerEnv(ds, "typo" as never, { DEEPSEEK_API_KEY: "k" }), /只能是 chatgpt_login 或 api_key/, "乱值不得静默落入登录分支");
  assert.equal(assertAuth("api_key", "x"), "api_key"); assert.throws(() => assertAuth("basic", "--auth"), /--auth 只能是/);
  const oa = loadProviderProfile(REPO, path.join(REPO, ".local"), "openai").profile;
  assert.deepEqual(providerEnv(oa, "api_key", { OPENAI_API_KEY: "k" }), { OPENAI_API_KEY: "k", CODEX_API_KEY: "k" });
  assert.deepEqual(providerEnv(oa, "chatgpt_login", { OPENAI_API_KEY: "k" }), {});
});

test("productConfig:profile=deepseek + 环境变量 → provider 字段由模板决定;缺变量 / 未知 profile / 不支持的 auth → 报错;CLI --provider 覆盖;openai 默认不变", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-pc-"));
  fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
  fs.cpSync(path.join(REPO, "providers"), path.join(repo, "providers"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "#\n");
  const a = loadProductConfig(repo, { env: {} });
  assert.equal(a.provider.name, "openai"); assert.equal(a.providerProfile?.id, "openai"); assert.equal(a.provider.auth, "chatgpt_login");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "deepseek", auth: "api_key" }, defaults: { model: "deepseek-v4-flash" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /DEEPSEEK_API_KEY/);
  const b = loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k" } });
  assert.equal(b.provider.name, "deepseek"); assert.equal(b.provider.wire_api, "responses"); assert.equal(b.provider.base_url, "https://api.deepseek.com"); assert.equal(b.provider.env_key, "DEEPSEEK_API_KEY"); assert.equal(b.providerProfile?.id, "deepseek");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "deepseek", auth: "chatgpt_login" } }));
  assert.throws(() => loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k" } }), /不支持 auth=chatgpt_login/);
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "nope", auth: "api_key" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /未知 provider/);
  fs.rmSync(path.join(repo, ".local", "config.json"));
  // 🔑 kimi 模板的 base_url 带 {WorkspaceId} 占位符,直接选用会被拒 —— 这里走**真实用户流程**:
  //    把填好的副本放进 <数据根>/providers/,用户覆盖优先于产品模板
  fs.mkdirSync(path.join(repo, ".local", "providers"), { recursive: true });
  {
    const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "providers", "kimi.json"), "utf8")) as { base_url: string };
    assert.ok(/[{<][A-Za-z_]/.test(tpl.base_url), "前提:kimi 模板确实带占位符(不带了就该改这段测试)");
    tpl.base_url = tpl.base_url.replace(/[{<][A-Za-z_][A-Za-z0-9_]*[}>]/g, "ws-123");
    fs.writeFileSync(path.join(repo, ".local", "providers", "kimi.json"), JSON.stringify(tpl));
  }
  assert.throws(() => loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "qwen" }), /占位符/, "没填占位符的模板不许静默用一个坏 URL 去发密钥");
  // CLI / 环境变量切换 profile 且 auth 未显式写过 → 自动用模板唯一支持的 api_key(缺密钥仍报错);显式写了 chatgpt_login 则明确报错,不覆盖用户设置
  const k1 = loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi" });
  assert.equal(k1.provider.name, "kimi"); assert.equal(k1.provider.auth, "api_key"); assert.equal(k1.provider.env_key, "DASHSCOPE_API_KEY"); assert.ok(k1.sources.includes("cli"));
  assert.equal(loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k", VRA_PROVIDER: "kimi" } }).provider.auth, "api_key");
  assert.throws(() => loadProductConfig(repo, { env: {}, providerOverride: "kimi" }), /DASHSCOPE_API_KEY/);
  assert.throws(() => loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k", VRA_PROVIDER: "kimi", VRA_PROVIDER_AUTH: "chatgpt_login" } }), /不支持 auth=chatgpt_login/);
  assert.throws(() => loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi", authOverride: "chatgpt_login" }), /不支持 auth=chatgpt_login/);
  assert.throws(() => loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi", authOverride: "basic" }), /--auth 只能是/);
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { auth: "chatgpt_login" } }));
  assert.throws(() => loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi" }), /不支持 auth=chatgpt_login/, "用户显式写的 auth 不被覆盖");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { auth: "api_key" } }));
  const c = loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi" });
  assert.equal(c.provider.name, "kimi"); assert.equal(c.provider.env_key, "DASHSCOPE_API_KEY"); assert.ok(c.sources.includes("cli"));
  // 产品配置(vibe-research.config.json)写了 auth 只是产品默认,不算用户显式 → 切第三方仍自动选 api_key
  fs.rmSync(path.join(repo, ".local", "config.json"));
  fs.writeFileSync(path.join(repo, "vibe-research.config.json"), JSON.stringify({ provider: { auth: "chatgpt_login" } }));
  assert.equal(loadProductConfig(repo, { env: { DASHSCOPE_API_KEY: "k" }, providerOverride: "kimi" }).provider.auth, "api_key");
  fs.rmSync(path.join(repo, "vibe-research.config.json"));
  // 环境变量层整体生效:VRA_PROVIDER 与 VRA_CODEX_HOME / VRA_CODEX_PATH / VRA_PYTHON 同时存在时一个都不丢
  const e = loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k", VRA_PROVIDER: "deepseek", VRA_CODEX_HOME: "/tmp/ch", VRA_CODEX_PATH: "/tmp/codex-bin", VRA_PYTHON: "/tmp/py" } });
  assert.equal(e.provider.name, "deepseek"); assert.equal(e.engine.codex_home, "/tmp/ch"); assert.equal(e.engine.codex_path, "/tmp/codex-bin"); assert.equal(e.python, "/tmp/py");
  // 无 providers/ 目录的假仓库:openai 走内置模板
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bare-"));
  assert.equal(loadProductConfig(bare, { env: {} }).providerProfile?.id, "openai");
});

test("runner/config:非 openai provider 注入 model_provider + model_providers;codexEnvFor 透传 env_key;默认模型来自模板;openai 不注入", () => {
  const ds = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, runId: "t-prov", provider: { name: "deepseek", wire_api: "responses", base_url: ds.base_url, env_key: ds.env_key, auth: "api_key", profile: "deepseek" }, providerProfile: ds });
  const env = { PATH: "/bin", DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" };
  const opts = codexOptionsFor(cfg, env) as { config: Record<string, unknown>; env: Record<string, string> };
  assert.equal(opts.config.model_provider, "deepseek");
  assert.ok((opts.config.model_providers as Record<string, unknown>).deepseek);
  assert.ok(opts.config.shell_environment_policy, "工具环境策略仍在");
  assert.equal(opts.env.DEEPSEEK_API_KEY, "k1"); assert.equal(opts.env.CODEX_API_KEY, undefined); assert.equal(opts.env.OPENAI_API_KEY, undefined); assert.equal(opts.env.CODEX_HOME, cfg.codexHome);
  const oa = makeConfig({ symbol: "300308", repoRoot: REPO, runId: "t-prov2" });
  const o2 = codexOptionsFor(oa, env) as { config: Record<string, unknown>; env: Record<string, string> };
  assert.equal(o2.config.model_provider, undefined); assert.equal(o2.env.DEEPSEEK_API_KEY, undefined);
  assert.deepEqual(Object.keys(codexEnvFor(cfg, env)).filter((k) => k.includes("KEY")), ["DEEPSEEK_API_KEY"]);
});

test("providers:组合约束——第三方 base_url 不得为空(Codex 会回退到 api.openai.com)/ 第三方不得声明 chatgpt_login / responses_support 与 wire_api 自洽 / auth_modes 去重 / context_limit ≥1", () => {
  const base = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const v = (patch: Record<string, unknown>) => () => validateProfile({ ...base, ...patch }, "t");
  assert.doesNotThrow(v({}));
  assert.throws(v({ base_url: null }), /必须显式给出 https base_url/);
  assert.throws(v({ auth_modes: ["api_key", "chatgpt_login"] }), /只能 auth_modes=\["api_key"\]/);
  assert.throws(v({ auth_modes: ["api_key", "api_key"] }), /schema/);
  // ⚠️ "responses_support=native 要求 wire_api=responses" 这条**现在够不到**:
  //    wire_api 只剩 responses 一个可用取值(chat 在它之前就被硬拒了)。不写一个假断言假装它被测了。
  assert.throws(v({ wire_api: "chat" }), /不再支持 wire_api/, "chat 在到达自洽校验之前就被拒");
  assert.throws(v({ wire_api: "responses", responses_support: "none" }), /wire_api=responses 要求 responses_support=native\|gateway/);
  assert.throws(v({ context_limit_tokens: 0 }), /schema/);
  assert.doesNotThrow(v({ verified_at: "2026-08-22" }));
  assert.throws(v({ verified_at: "yesterday" }), /schema/);
  assert.throws(v({ env_http_headers: { "X-Home": "HOME" } }), /schema|受保护环境变量/);
  assert.doesNotThrow(v({ wire_api: "responses", responses_support: "gateway" }), "responses 经网关转换是合法组合");
});

test("providers:providers 目录是符号链接 / 解析到根之外 → 拒绝(即使 id 合法)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-plink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-outside-"));
  fs.cpSync(path.join(REPO, "providers"), outside, { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "providers"));
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "deepseek"), /符号链接|根目录之外/);
  // 用户目录 .local/providers 同样受限
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-plink2-"));
  fs.mkdirSync(path.join(repo2, ".local"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo2, ".local", "providers"));
  assert.throws(() => loadProviderProfile(repo2, path.join(repo2, ".local"), "deepseek"), /符号链接|根目录之外/);
  // 正常目录照常
  fs.cpSync(path.join(REPO, "providers"), path.join(repo2, "providers"), { recursive: true });
  fs.rmSync(path.join(repo2, ".local", "providers"));
  assert.equal(loadProviderProfile(repo2, path.join(repo2, ".local"), "deepseek").profile.id, "deepseek");
  // 枚举也不穿过符号链接目录:repo 的 providers 是 symlink → 列表为空;未知 id 的报错只列 openai
  assert.deepEqual(listProviderIds(repo, path.join(repo, ".local")), []);
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "nope"), /可用:openai$/);
});

test("🔴 provider 不认服务端 schema 时降级到提示词 —— 硬传会被整轮拒掉,阶段直接 failed", () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "integer" } } };
  // 默认(没声明)= json_schema:照常硬传,提示词一个字不动
  const a = withOutputSchema("原提示词", schema, structuredOutputMode(null));
  assert.equal(a.prompt, "原提示词");
  assert.deepEqual(a.outputSchema, schema);

  // 声明 prompt 的:不传 outputSchema,schema 写进提示词
  const mimo = loadProviderProfile(REPO, path.join(REPO, ".local"), "mimo").profile;
  assert.equal(structuredOutputMode(mimo), "prompt", "mimo 实测不支持 json_schema(2026-08-26)");
  const b = withOutputSchema("原提示词", schema, "prompt");
  assert.equal(b.outputSchema, undefined, "不能再硬传 —— 传了整轮被拒");
  assert.ok(b.prompt.startsWith("原提示词"), "原提示词要留在前面");
  assert.ok(b.prompt.includes('"integer"'), "schema 本体要进提示词,不能只说一句'请输出 JSON'");

  // 没有 schema 的回合两种模式都不加东西
  for (const m of ["json_schema", "prompt"] as const) {
    assert.deepEqual(withOutputSchema("x", undefined, m), { prompt: "x" });
    assert.deepEqual(withOutputSchema("x", null, m), { prompt: "x" });
  }
});

test("每个模板都要显式声明或默认 structured_output,且值合法", () => {
  for (const id of listProviderIds(REPO, path.join(REPO, ".local"))) {
    const raw = JSON.parse(fillPlaceholders(fs.readFileSync(path.join(REPO, "providers", `${id}.json`), "utf8"))) as Record<string, unknown>;
    const prof = validateProfile(raw, `模板 ${id}`);
    assert.ok(["json_schema", "prompt"].includes(structuredOutputMode(prof)), id);
  }
  // schema 层拒乱值(否则拼错会静默落到默认分支)
  const base = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  assert.throws(() => validateProfile({ ...base, structured_output: "jsonschema" }, "t"), /schema/);
});
