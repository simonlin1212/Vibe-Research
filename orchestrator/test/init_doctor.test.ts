import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cmpVersion, isPrerelease, parseCodexVersion, resolveBundledCodex, runDoctor, scanSecrets, type Exec } from "../src/doctor.ts";
import { assertDataRootInside, detectPython, gitignoreCovers, runInit } from "../src/init.ts";
import { installProjectRootMarkers } from "../src/instructions_root.ts";
import { installSkillsIsolation } from "../src/skills_isolation.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** doctor 的 skills 隔离检查按 env.HOME 找用户级 skill:测试用空的假 HOME,不依赖开发者机器上的 ~/.agents/skills */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-home-"));

function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-init-"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# c\n");
  fs.writeFileSync(path.join(repo, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: ".local" } }));
  return repo;
}

function tmpDoctorRepo(): string {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, ".vibe-research-root"), "");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".local/\n");
  fs.copyFileSync(path.join(REPO, "codex-version.json"), path.join(repo, "codex-version.json"));
  fs.mkdirSync(path.join(repo, "datasources"), { recursive: true });
  for (const file of ["registry.json", "CATALOG.md"]) {
    fs.copyFileSync(path.join(REPO, "datasources", file), path.join(repo, "datasources", file));
  }
  fs.mkdirSync(path.join(repo, "providers"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "providers", "deepseek.json"), path.join(repo, "providers", "deepseek.json"));
  for (const skill of ["data-access", "company-research"]) {
    const target = path.join(repo, ".agents", "skills", skill);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(REPO, ".agents", "skills", skill, "SKILL.md"), path.join(target, "SKILL.md"));
  }
  return repo;
}

test("init:幂等建 .local 目录 + 配置骨架 + .gitignore;已有配置不改;--force 先备份;provider 非 openai 默认 api_key;不碰产品根之外", async () => {
  const repo = tmpRepo();
  const r1 = runInit({ repoRoot: repo });
  assert.equal(r1.dataRoot, path.join(repo, ".local"));
  for (const sub of ["codex-home", "runs", "knowledge", "providers", "mcp"]) assert.ok(fs.existsSync(path.join(repo, ".local", sub)), sub);
  assert.ok(r1.steps.filter((s) => s.id.startsWith("dir:")).every((s) => s.action === "created"));
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"));
  assert.equal(cfg.python, null); assert.deepEqual(cfg.provider, { profile: "openai" }, "骨架不写 auth(写了会被当成用户显式指定)");
  assert.ok(fs.readFileSync(path.join(repo, ".gitignore"), "utf8").split("\n").includes(".local/"));
  assert.ok(r1.next.some((n) => n.includes("scripts/start")) && r1.next.some((n) => n.includes("接入 AI")));
  assert.ok(r1.next.every((n) => !n.includes("codex login") && !n.includes("~/.codex")));
  // 第二次:全部 exists / kept,文件不变
  const before = fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8");
  const r2 = runInit({ repoRoot: repo });
  assert.ok(r2.steps.filter((s) => s.id.startsWith("dir:")).every((s) => s.action === "exists"));
  assert.equal(r2.steps.find((s) => s.id === "config")?.action, "kept");
  assert.equal(r2.steps.find((s) => s.id === "gitignore")?.action, "exists");
  assert.equal(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"), before);
  // --force:备份后重写;provider=deepseek → api_key;python 显式
  const r3 = runInit({ repoRoot: repo, force: true, provider: "deepseek", python: "/x/python" });
  assert.equal(r3.steps.find((s) => s.id === "config:backup")?.action, "backed_up");
  assert.ok(fs.readdirSync(path.join(repo, ".local")).some((f) => f.startsWith("config.json.bak-")));
  const cfg3 = JSON.parse(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"));
  assert.equal(cfg3.python, "/x/python"); assert.deepEqual(cfg3.provider, { profile: "deepseek" });
  assert.throws(() => runInit({ repoRoot: repo, provider: "../evil" }), /非法 provider id/);
  // python 自动探测 .venv
  const pyRel = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
  fs.mkdirSync(path.dirname(path.join(repo, pyRel)), { recursive: true }); fs.writeFileSync(path.join(repo, pyRel), "");
  assert.equal(detectPython(repo), path.join(repo, pyRel));
  assert.equal(detectPython(repo, "/explicit"), "/explicit");
  // 数据根逃出产品根 → 拒绝(词法 / 符号链接 / realpath 三种)
  const repo2 = tmpRepo(); fs.writeFileSync(path.join(repo2, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: "../outside" } }));
  assert.throws(() => runInit({ repoRoot: repo2 }), /不在产品根/);
  const repo3 = tmpRepo(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out-")); fs.symlinkSync(outside, path.join(repo3, ".local"));
  assert.throws(() => runInit({ repoRoot: repo3 }), /符号链接|产品根之外/);
  assert.ok(!fs.existsSync(path.join(outside, "config.json")), "不得写到符号链接指向的仓库外目录");
  const repo4 = tmpRepo(); fs.mkdirSync(path.join(repo4, "data")); fs.symlinkSync(outside, path.join(repo4, "data", "link"));
  fs.writeFileSync(path.join(repo4, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: "data/link/.local" } }));
  assert.throws(() => assertDataRootInside(repo4, path.join(repo4, "data", "link", ".local")), /产品根之外/, "祖先是符号链接也拒绝");
  // 悬空符号链接:.gitignore → 拒绝且不在仓库外创建文件;.local → 拒绝;子目录是(悬空)符号链接 → 拒绝
  const repo6 = tmpRepo(); const dangling = path.join(os.tmpdir(), `vra-dangling-${process.pid}`, "nope");
  fs.symlinkSync(dangling, path.join(repo6, ".gitignore"));
  assert.throws(() => runInit({ repoRoot: repo6 }), /符号链接/); assert.ok(!fs.existsSync(dangling));
  const repo7 = tmpRepo(); fs.symlinkSync(dangling, path.join(repo7, ".local"));
  assert.throws(() => runInit({ repoRoot: repo7 }), /符号链接/); assert.ok(!fs.existsSync(dangling));
  const repo8 = tmpRepo(); fs.mkdirSync(path.join(repo8, ".local")); fs.symlinkSync(dangling, path.join(repo8, ".local", "runs"));
  assert.throws(() => runInit({ repoRoot: repo8 }), /不是目录/); assert.ok(!fs.existsSync(dangling));
  // --force 同秒两次:备份不覆盖
  const repo5 = tmpRepo(); runInit({ repoRoot: repo5 }); runInit({ repoRoot: repo5, force: true }); runInit({ repoRoot: repo5, force: true });
  assert.equal(fs.readdirSync(path.join(repo5, ".local")).filter((f) => f.startsWith("config.json.bak-")).length, 2);
  // .gitignore 等价规则识别
  for (const t of [".local/", "/.local/", ".local", "/.local", ".local/**", "# x\r\n/.local/**\r\n"]) assert.ok(gitignoreCovers(t, ".local/"), t);
  assert.ok(!gitignoreCovers(".local2/\n.locale/", ".local/"));
});

test("doctor:版本解析 / 比较;密钥扫描命中 sk-… / Bearer / 环境密钥值,跳过 .local 与测试目录", async () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.149.0\n"), [0, 149, 0]); assert.equal(parseCodexVersion("nope"), null);
  assert.equal(cmpVersion([0, 149, 0], [0, 149, 0]), 0); assert.equal(cmpVersion([0, 150, 0], [0, 149, 9]), 1); assert.equal(cmpVersion([22, 18], [22, 18, 0]), 0); assert.equal(cmpVersion([22, 6], [22, 18]), -1);
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, "src")); fs.mkdirSync(path.join(repo, "test")); fs.mkdirSync(path.join(repo, ".local"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), 'const k = "sk-" + "ABCDEFGHIJKLMNOPQRSTUVWX0123";\nconst h = "Bearer abcdefghijklmnopqrstuvwxyz";\nconst v = "SUPERSECRETVALUE1234567890";\n');
  fs.writeFileSync(path.join(repo, "test", "t.ts"), '"sk-ABCDEFGHIJKLMNOPQRSTUVWX0123"');
  fs.writeFileSync(path.join(repo, ".local", "x.json"), '"sk-ABCDEFGHIJKLMNOPQRSTUVWX0123"');
  // 第一行被 "sk-" + 拼接打散,不应命中;第二行 Bearer 命中;第三行经环境变量值命中;测试目录里的 sk- 与 .local 不命中
  const r1 = scanSecrets(repo, { MY_API_KEY: "SUPERSECRETVALUE1234567890", SHORT_KEY: "abc" });
  assert.deepEqual(r1.hits.map((h) => `${h.file}:${h.line}:${h.what}`).sort(), ["src/a.ts:2:Bearer token", "src/a.ts:3:环境变量 MY_API_KEY 的值"]);
  assert.equal(r1.truncated, false); assert.ok(r1.scanned >= 3);
  fs.writeFileSync(path.join(repo, "src", "b.md"), "token sk-ABCDEFGHIJKLMNOPQRSTUVWX0123 here\n");
  assert.ok(scanSecrets(repo, {}).hits.some((h) => h.file === "src/b.md" && h.what.startsWith("sk-")));
  // 高置信形态在测试目录也命中:PEM / AWS / GitHub / JWT;字面赋值形态在源码命中
  // 夹具用拼接构造,避免本测试源码自己被扫描命中
  fs.writeFileSync(path.join(repo, "test", "pem.txt"), "-----BEGIN RSA " + "PRIVATE KEY-----\n" + "AKIA" + "ABCDEFGHIJKLMNOP" + "\nghp_" + "a".repeat(36) + "\n");
  fs.writeFileSync(path.join(repo, "src", "c.py"), 'api_key = "' + "abcdefghij" + "0123456789" + 'xyz"\n');
  fs.writeFileSync(path.join(repo, "test", "more.txt"), "ASIA" + "ABCDEFGHIJKLMNOP" + "\ngithub_pat_" + "A1".repeat(12) + "\nxapp-" + "1-A2B3C4D5E6" + "\nxoxe-" + "1234567890-abc" + "\n");
  const r2 = scanSecrets(repo, {});
  const whats = new Set(r2.hits.filter((h) => h.file === "test/pem.txt").map((h) => h.what));
  assert.ok(whats.has("PEM 私钥") && whats.has("AWS access key") && whats.has("GitHub token"), [...whats].join(","));
  const more = r2.hits.filter((h) => h.file === "test/more.txt").map((h) => h.what);
  assert.deepEqual(more, ["AWS access key", "GitHub token", "Slack token", "Slack token"], more.join(","));
  assert.ok(r2.hits.some((h) => h.file === "src/c.py" && /字面赋值/.test(h.what)));
  // 版本:预发布
  assert.ok(isPrerelease("codex-cli 0.150.0-alpha.1")); assert.ok(!isPrerelease("codex-cli 0.149.0"));
  // 引擎定位与 SDK 一致:真实 node_modules 下能找到,且 bin/codex 旁有 codex-package.json
  const eng = resolveBundledCodex(REPO);
  assert.ok(eng.path && /vendor\/[^/]+\/(bin|codex)\/codex$/.test(eng.path), eng.detail);
  assert.equal(resolveBundledCodex(fs.mkdtempSync(path.join(os.tmpdir(), "vra-noeng-"))).path, null);
});

test("doctor:真实仓库 + 假 exec → 全绿(除 api_token / net skip);引擎失败 / 未登录 / Python 导入失败 → fail / warn 与修复提示;退出码 0 / 2 / 3", async (t) => {
  const calcOut = JSON.stringify({ calc_version: "0.3.2", output: { status: "ok", value: 20, display: "20.00 倍" } });
  const good: Exec = (cmd, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.149.0\n", stderr: "" };
    if (args[0] === "login") return { status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
    if (args[0] === "-c") return { status: 0, stdout: "3.12.4\n", stderr: "" };
    if (String(args[0]).endsWith("cli.py")) return { status: 0, stdout: calcOut, stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  // 真实仓库在 CI 中没有开发者的 .local。为这条测试安装一份最小、隔离且可回收的
  // CODEX_HOME，避免测试结果取决于执行机器之前有没有跑过 init / login。
  const doctorRepo = tmpDoctorRepo();
  t.after(() => fs.rmSync(doctorRepo, { recursive: true, force: true }));
  const doctorDataRoot = path.join(doctorRepo, ".local");
  fs.mkdirSync(doctorDataRoot, { recursive: true });
  const doctorCodexHome = fs.mkdtempSync(path.join(doctorDataRoot, "doctor-home-"));
  installSkillsIsolation({ codexHome: doctorCodexHome, repoRoot: doctorRepo, python: null }, { homeDir: FAKE_HOME });
  installProjectRootMarkers({ codexHome: doctorCodexHome });
  const doctorPaths = { VRA_DATA_ROOT: doctorDataRoot, VRA_CODEX_HOME: doctorCodexHome, VRA_CODEX_PATH: process.execPath };
  // provider 也在假环境里钉死:测的是 doctor 行为，不随开发者本地 provider 配置变化。
  const fakeEnv: Record<string, string> = { PATH: "/usr/bin", HOME: FAKE_HOME, ...doctorPaths, VRA_PROVIDER: "openai", VRA_PROVIDER_AUTH: "chatgpt_login" };
  const r = await runDoctor({ repoRoot: doctorRepo, env: fakeEnv, exec: good, python: "/fake/python", writeReport: false });
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  for (const id of ["node", "config", "engine", "codex_cli", "auth", "constitution", "skills", "python", "calc", "registry", "data_root", "gitignore", "secrets", "skills_isolation"]) assert.equal(by[id].status, "ok", `${id}: ${by[id].detail}`);
  assert.equal(by.net.status, "skip"); assert.ok(by.api_token.status === "skip" || by.api_token.status === "ok");
  assert.equal(r.exit_code, 0); assert.equal(r.report, null);
  assert.ok(by.engine.detail.includes("0.149.0") && /已测区间/.test(by.engine.detail));
  // 引擎版本超出区间 → warn;未登录 → warn;退出码 2
  const warnExec: Exec = (cmd, args) => args[0] === "--version" ? { status: 0, stdout: "codex-cli 0.200.0", stderr: "" } : args[0] === "login" ? { status: 1, stdout: "Not logged in\n", stderr: "" } : good(cmd, args);
  const w = await runDoctor({ repoRoot: doctorRepo, env: fakeEnv, exec: warnExec, python: "/fake/python", writeReport: false });
  const wb = Object.fromEntries(w.checks.map((c) => [c.id, c]));
  assert.equal(wb.engine.status, "warn"); assert.equal(wb.auth.status, "warn"); assert.match(wb.auth.fix ?? "", /codex login/); assert.equal(w.exit_code, 2);
  // Python 导入失败 → fail + pip 提示;calc skip;退出码 3
  const badPy: Exec = (cmd, args) => args[0] === "-c" ? { status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'akshare'" } : good(cmd, args);
  const f = await runDoctor({ repoRoot: doctorRepo, env: fakeEnv, exec: badPy, python: "/fake/python", writeReport: false });
  const fb = Object.fromEntries(f.checks.map((c) => [c.id, c]));
  assert.equal(fb.python.status, "fail"); assert.match(fb.python.fix ?? "", /pip install -r/); assert.equal(fb.calc.status, "skip"); assert.equal(f.exit_code, 3);
  // 安装清单与体检都必须覆盖已注册的 mootdx 源，不能“初始化正常、五个端点全缺包”。
  const requirements = fs.readFileSync(path.join(REPO, ".agents/skills/data-access/scripts/requirements.txt"), "utf8");
  assert.match(requirements, /^mootdx==0\.11\.7$/m);
  const noMootdx: Exec = (cmd, args) => args[0] === "-c" && String(args[1]).includes("mootdx")
    ? { status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'mootdx'" } : good(cmd, args);
  const missingTdx = await runDoctor({ repoRoot: doctorRepo, env: fakeEnv, exec: noMootdx, python: "/fake/python", writeReport: false });
  assert.equal(missingTdx.checks.find(c => c.id === "python")?.status, "fail");
  // 受控 MCP 与 skills 配置隔离使用标准库 tomllib；3.10 即使取数依赖都能导入，也不能标成可用。
  const oldPy: Exec = (cmd, args) => args[0] === "-c" ? { status: 0, stdout: "3.10.14\n", stderr: "" } : good(cmd, args);
  const old = await runDoctor({ repoRoot: doctorRepo, env: fakeEnv, exec: oldPy, python: "/fake/python", writeReport: false });
  const oldBy = Object.fromEntries(old.checks.map((c) => [c.id, c]));
  assert.equal(oldBy.python.status, "fail");
  assert.match(oldBy.python.detail, /3\.11/);
  assert.equal(oldBy.calc.status, "skip");
  assert.equal(old.exit_code, 3);
  // api_key 模式:环境变量缺失 → fail;有 → ok(不再查登录态)
  const keyEnv = { PATH: "/usr/bin", HOME: FAKE_HOME, ...doctorPaths, VRA_PROVIDER: "deepseek", VRA_PROVIDER_AUTH: "api_key" };  // 显式 auth:不依赖本机 .local/config.json 里有没有写 auth
  const k1 = await runDoctor({ repoRoot: doctorRepo, env: keyEnv, exec: good, python: "/fake/python", writeReport: false });
  const k1b = Object.fromEntries(k1.checks.map((c) => [c.id, c]));
  // 🔴 缺密钥**单独报一条**,不再把配置链整条判死。
  //    旧行为是 config=fail ⇒ 后面所有靠配置的检查跟着 skip 或**报出假原因** ——
  //    实测:配了 MiMo 还没导 key 时,体检说"未找到 Python",而 Python 明明配着、venv 也在。
  //    一个不相干的问题让产品对用户说了错误的诊断,而这正是第一次配国产模型的常态。
  assert.equal(k1b.config.status, "ok", "配置本身是好的,缺的只是密钥");
  assert.equal(k1b.provider_key.status, "fail");
  assert.match(k1b.provider_key.detail, /DEEPSEEK_API_KEY/);
  // ⭐ 这条才是这次改动的要害:**不相干的检查不受牵连**
  assert.equal(k1b.python.status, "ok", "缺模型密钥不该让 Python 检查跟着倒");
  assert.equal(k1b.calc.status, "ok");
  const k2 = await runDoctor({ repoRoot: doctorRepo, env: { ...keyEnv, DEEPSEEK_API_KEY: "k".repeat(20) }, exec: good, python: "/fake/python", writeReport: false });
  const k2b = Object.fromEntries(k2.checks.map((c) => [c.id, c]));
  assert.equal(k2b.config.status, "ok"); assert.equal(k2b.auth.status, "ok"); assert.match(k2b.auth.detail, /api_key 模式/);
  // auth 仍如实报 fail(而不是用默认模式误判成 ok):缺 key 就是跑不起来
  assert.equal(k1b.auth.status, "fail");
  assert.match(k1b.auth.detail, /DEEPSEEK_API_KEY/);
  assert.equal(k1.exit_code, 3, "有 fail → 退出码 3");
  // 报告落盘:路径相对化为 <repo>、detail 经 redact;写到临时数据根(用 --force 的临时仓库)
  const repoR = tmpRepo(); fs.mkdirSync(path.join(repoR, ".local"), { recursive: true });
  const rr = await runDoctor({ repoRoot: repoR, env: { PATH: "/usr/bin", HOME: FAKE_HOME }, exec: (cmd, args) => args[0] === "login" ? { status: 1, stdout: "", stderr: "Error: token=abcdefghijklmnop1234 rejected" } : good(cmd, args), python: "/fake/python", writeReport: true });
  assert.ok(rr.report && fs.existsSync(rr.report));
  const rep = fs.readFileSync(rr.report!, "utf8");
  assert.ok(!rep.includes(repoR), "报告里不出现绝对产品根"); assert.ok(rep.includes("<repo>"));
  // 数据根是符号链接 → data_root_boundary fail,且不写报告 / 探针
  const repoS = tmpRepo(); const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out2-")); fs.symlinkSync(out2, path.join(repoS, ".local"));
  const rs = await runDoctor({ repoRoot: repoS, env: { PATH: "/usr/bin", HOME: FAKE_HOME }, exec: good, python: "/fake/python", writeReport: true });
  const rsb = Object.fromEntries(rs.checks.map((c) => [c.id, c]));
  assert.equal(rsb.data_root_boundary.status, "fail"); assert.equal(rsb.data_root.status, "skip"); assert.equal(rs.report, null); assert.equal(rs.exit_code, 3);
  assert.deepEqual(fs.readdirSync(out2), [], "符号链接指向的目录里不得有任何写入");
  // 数据根本身正常,但 .local/doctor 是指向仓库外的符号链接 → 报告不写(warn),探针叶子是符号链接 → data_root fail;仓库外仍空
  const repoD = tmpRepo(); const out3 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out3-")); fs.mkdirSync(path.join(repoD, ".local"));
  fs.symlinkSync(out3, path.join(repoD, ".local", "doctor"));
  fs.symlinkSync(path.join(out3, "probe-target"), path.join(repoD, ".local", `.doctor-write-${process.pid}`));
  const rd = await runDoctor({ repoRoot: repoD, env: { PATH: "/usr/bin", HOME: FAKE_HOME }, exec: good, python: "/fake/python", writeReport: true });
  const rdb = Object.fromEntries(rd.checks.map((c) => [c.id, c]));
  assert.equal(rd.report, null); assert.equal(rdb.report?.status, "warn"); assert.equal(rdb.data_root.status, "fail");
  assert.deepEqual(fs.readdirSync(out3), [], "doctor/ 或探针是符号链接时仓库外不得有任何写入");
  assert.ok(rd.tally.warn >= 1 && rd.exit_code === 3, "报告落盘 warn 计入 tally");
  // 子进程不该拿到密钥:good exec 的 env 参数里没有 DEEPSEEK_API_KEY(login status 的 env 只含最小环境 + CODEX_HOME)
  let seenEnv: Record<string, string> | undefined;
  const spy: Exec = (cmd, args, opts) => { if (args[0] === "login") seenEnv = opts?.env; return good(cmd, args); };
  // 钉死 chatgpt_login:doctor 只在这个模式下才去查登录态,而本条要看的正是那次子进程调用的 env。
  // (不钉死的话,本机配成 api_key 类 provider 时 login 压根不会被调,seenEnv 恒为 undefined。)
  await runDoctor({ repoRoot: doctorRepo, env: { PATH: "/usr/bin", ...doctorPaths, OPENAI_API_KEY: "x".repeat(20), VRA_PROVIDER: "openai", VRA_PROVIDER_AUTH: "chatgpt_login" }, exec: spy, python: "/fake/python", writeReport: false });
  assert.ok(seenEnv && seenEnv.CODEX_HOME && !("OPENAI_API_KEY" in seenEnv));
});
