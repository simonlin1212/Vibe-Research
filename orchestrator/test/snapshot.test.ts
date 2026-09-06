import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SNAPSHOT_SCHEMA, listSnapshots, readSnapshot, resetSnapshotMemory, snapshotKey, snapshotUsable, writeSnapshot } from "../src/snapshot.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-snap-"));
const ok = () => true;
const META = { endpoint: "fetch_quote", symbol: "300308" };

test("快照内存按数据根隔离，等价根路径仍使用同一份缓存", () => {
  resetSnapshotMemory();
  const a = tmp(), b = tmp(), k = snapshotKey("ep", "s");
  try {
    writeSnapshot(a, k, META, { owner: "a" }, ok);
    assert.equal(readSnapshot(b, k), null, "空 B 根不能读到 A 的内存快照");
    writeSnapshot(b, k, META, { owner: "b" }, ok);
    assert.equal(readSnapshot<{ owner: string }>(a, k)?.payload.owner, "a");
    assert.equal(readSnapshot<{ owner: string }>(path.join(a, "unused", ".."), k)?.payload.owner, "a");
    assert.equal(readSnapshot<{ owner: string }>(b, k)?.payload.owner, "b");
    resetSnapshotMemory();
    assert.equal(readSnapshot<{ owner: string }>(b, k)?.payload.owner, "b");
    assert.equal(readSnapshot<{ owner: string }>(a, k)?.payload.owner, "a", "磁盘回填内存也必须隔离");
  } finally {
    resetSnapshotMemory();
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("🔴 默认读上次的快照 —— 页面打开不该把依赖的端点全跑一遍(慢且费钱)", () => {
  resetSnapshotMemory();
  const root = tmp();
  const k = snapshotKey("fetch_quote", "300308", { limit: 1 });
  assert.equal(readSnapshot(root, k), null, "还没存过 → null,调用方去真取");
  writeSnapshot(root, k, META, { v: 1 }, ok);
  resetSnapshotMemory(); // 清掉内存层,证明**跨重启**也在
  const hit = readSnapshot<{ v: number }>(root, k);
  assert.equal(hit?.payload.v, 1);
  assert.ok(hit?.fetched_at, "必须带取数时刻 —— 拿旧数据不说是旧的等于骗人");
});

test("🔴 失败与空结果不写快照 —— 一次网络抖动被记住就再也不会自愈", () => {
  resetSnapshotMemory();
  const root = tmp();
  const k = snapshotKey("fetch_quote", "300308");
  const valid = (p: { evidence: unknown[] }) => p.evidence.length > 0;
  assert.equal(writeSnapshot(root, k, META, { evidence: [] }, valid), null, "空结果不该被写下来");
  assert.equal(readSnapshot(root, k), null);
  assert.ok(writeSnapshot(root, k, META, { evidence: [1] }, valid), "真取到了才写");
  assert.ok(readSnapshot(root, k));
});

test("🔴 参数进键:同一端点取不同参数是不同的数据,不能共用一把键", () => {
  const a = snapshotKey("ep", "300308", { limit: 10 });
  const b = snapshotKey("ep", "300308", { limit: 20 });
  const c = snapshotKey("ep", "000001", { limit: 10 });
  assert.notEqual(a, b, "参数不同 → 不同键");
  assert.notEqual(a, c, "主体不同 → 不同键");
  // 键名顺序不该影响结果,否则 {a,b} 与 {b,a} 各存一份、互相看不见
  assert.equal(snapshotKey("ep", "s", { a: 1, b: 2 }), snapshotKey("ep", "s", { b: 2, a: 1 }));
  assert.match(a, /^ep-[0-9a-f]{12}$/, "前缀留可读端点名,便于人工翻目录");
});

test("结构版本变了旧快照自动作废(不会拿新代码读旧形状)", () => {
  resetSnapshotMemory();
  const root = tmp();
  const k = snapshotKey("ep", "s");
  writeSnapshot(root, k, META, { v: 1 }, ok);
  const f = path.join(root, "snapshots", `${k}.json`);
  const d = JSON.parse(fs.readFileSync(f, "utf8")) as { schema: number };
  d.schema = SNAPSHOT_SCHEMA + 1;
  fs.writeFileSync(f, JSON.stringify(d));
  resetSnapshotMemory();
  assert.equal(readSnapshot(root, k), null, "版本对不上就当没有,重新取");
});

test("手改坏的快照文件不许当成数据用", () => {
  resetSnapshotMemory();
  const root = tmp();
  const k = snapshotKey("ep", "s");
  writeSnapshot(root, k, META, { v: 1 }, ok);
  const f = path.join(root, "snapshots", `${k}.json`);
  for (const bad of ["{ 不是 JSON", "[]", '{"schema":1}']) {
    fs.writeFileSync(f, bad);
    resetSnapshotMemory();
    assert.equal(readSnapshot(root, k), null, `坏内容不该被当数据:${bad}`);
  }
});

test("非法快照键拼不出目录穿越", () => {
  const root = tmp();
  for (const k of ["../evil", "a/b", "/abs", "../../etc/passwd"]) {
    assert.throws(() => readSnapshot(root, k), /非法快照键/, `应拒 ${k}`);
  }
  // ⚠️ `".."` **不在**拒绝之列,而且这是对的:拼上 `.json` 后是目录里一个叫 `...json` 的普通文件,
  //    不构成穿越。(我第一版把它列进去了 —— 是**预期写错**不是代码错,实测后改的测试。)
  assert.equal(readSnapshot(root, ".."), null);
});

test("列出快照:按时间倒序,带端点与取数时刻(界面要显示'这页的数据是什么时候的')", () => {
  resetSnapshotMemory();
  const root = tmp();
  writeSnapshot(root, snapshotKey("a", "s"), { endpoint: "a", symbol: "s" }, { v: 1 }, ok);
  writeSnapshot(root, snapshotKey("b", "s"), { endpoint: "b", symbol: "s" }, { v: 2 }, ok);
  const list = listSnapshots(root);
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.fetched_at && x.endpoint));
  assert.ok(list[0]!.fetched_at >= list[1]!.fetched_at, "倒序");
  assert.deepEqual(listSnapshots(tmp()), [], "没有快照目录时返回空表,不抛错");
});

test("🔴 一致性策略:光有 refresh 布尔不够 —— MCP / 体检会被永久旧快照坑", () => {
  const fresh = { schema: 1, key: "k", endpoint: "e", symbol: "s", fetched_at: new Date().toISOString(), payload: 1 };
  const old = { ...fresh, fetched_at: new Date(Date.now() - 3600_000).toISOString() };

  // prefer_cache 不给上限 = 任意年代都收(界面默认:打开就是上次的)
  assert.equal(snapshotUsable(old, { mode: "prefer_cache" }), true);
  // 给了上限就按上限
  assert.equal(snapshotUsable(old, { mode: "prefer_cache", max_age_ms: 60_000 }), false);
  assert.equal(snapshotUsable(fresh, { mode: "prefer_cache", max_age_ms: 60_000 }), true);
  // fresh 一律不收 —— 体检的网络探针必须走这条,否则会把历史上的一次成功报成"当前网络健康"
  assert.equal(snapshotUsable(fresh, { mode: "fresh" }), false);
  // cache_only:有就用
  assert.equal(snapshotUsable(old, { mode: "cache_only" }), true);
  assert.equal(snapshotUsable(null, { mode: "cache_only" }), false);
});

test("🔴 端点声明的上限调用方放宽不了 —— 那是数据本身的性质,不是调用方的偏好", () => {
  const old = { schema: 1, key: "k", endpoint: "e", symbol: "s", fetched_at: new Date(Date.now() - 3600_000).toISOString(), payload: 1 };
  // 端点说"从不缓存"(0):调用方就算不给上限也不能用
  assert.equal(snapshotUsable(old, { mode: "prefer_cache" }, 0), false);
  // 端点说 5 分钟:调用方想放宽到 1 天也没用 —— 取两者更严的
  assert.equal(snapshotUsable(old, { mode: "prefer_cache", max_age_ms: 86_400_000 }, 300_000), false);
  // 反过来,调用方要求更严时按调用方的
  const recent = { ...old, fetched_at: new Date(Date.now() - 120_000).toISOString() };
  assert.equal(snapshotUsable(recent, { mode: "prefer_cache" }, 300_000), true);
  assert.equal(snapshotUsable(recent, { mode: "prefer_cache", max_age_ms: 60_000 }, 300_000), false);
});

test("🔴 快照键要**递归**规范化:嵌套对象键序不同是同一个查询,不能各存一份", () => {
  assert.equal(
    snapshotKey("ep", "s", { a: { x: 1, y: 2 }, b: [1, 2] }),
    snapshotKey("ep", "s", { b: [1, 2], a: { y: 2, x: 1 } }),
    "嵌套键序不该影响结果(第一版只排了第一层)",
  );
  // 数组顺序是语义的一部分,不能一起排掉
  assert.notEqual(snapshotKey("ep", "s", { a: [1, 2] }), snapshotKey("ep", "s", { a: [2, 1] }));
});
