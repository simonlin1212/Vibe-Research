/**
 * **取数快照层**(Core):页面打开时读上次的结果,不重新取数。
 *
 * 为什么要有它:每打开一个页面就把它依赖的端点全跑一遍,既慢又费钱,而绝大多数时候
 * 用户只是想再看一眼**上次看到的东西**。⇒ 默认读快照,要新数据由用户显式点刷新。
 *
 * 三层(照搬 Vibe Research 原版已经跑通的那套,不自己发明):
 *   ① 内存 TTL —— 同一次会话里连点几下不重复读盘
 *   ② 磁盘快照 —— **跨重启存活**,"上次打开是什么就是什么"
 *   ③ 显式刷新 —— 只有用户点了才真去取数,取到才覆盖快照
 *
 * 🔴 **拿旧数据必须说是旧的**。每份快照都带 `fetched_at`,调用方要把它显示出来 ——
 *    这个产品的全部信用建立在"每个数字都挂着资料期"上,拿三天前的数据冒充实时是自毁根基。
 * 🔴 **失败与空结果不写快照**。否则一次网络抖动会被记住,用户下次打开看到的是那次失败,
 *    而且再也不会自己好 —— 原版 `_cached` 的 `valid()` 就是干这个的。
 * ⚠️ `SNAPSHOT_SCHEMA` 是结构版本:信封结构变了就 +1,旧快照自动作废重取,
 *    不会拿新代码去读旧形状。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { atomicWrite, nowIso, readJsonIfExists } from "./fsutil.ts";

/** 快照结构版本。**改了信封形状就 +1** —— 旧快照会被当成过期,重新取一次 */
export const SNAPSHOT_SCHEMA = 1;

/** 内存层存活时间:同一次会话里连点几下不重复读盘。磁盘层没有过期概念(那是用户点刷新的事) */
const MEM_TTL_MS = 60_000;

/**
 * 取数一致性策略。**不能只有一个 `refresh: boolean`** ——
 * 那等于说"不刷新就接受任意年代的快照",对界面尚可,对 MCP / doctor / agent 都不成立:
 *  · MCP 的 schema 里没暴露刷新 ⇒ **它永远只能拿到旧快照**;
 *  · doctor 的网络探针读快照 ⇒ **把历史上的一次成功报成"当前网络健康"**。
 * (Codex 架构评审 arch-r1 §A)
 */
export type Consistency =
  | { mode: "cache_only" }                              // 只读快照,没有就没有(离线 / 绝不联网)
  | { mode: "prefer_cache"; max_age_ms?: number }       // 有就用,可给时效上限
  | { mode: "fresh" };                                  // 必须真取(刷新 / 体检 / 正式研究运行)

export const DEFAULT_CONSISTENCY: Consistency = { mode: "prefer_cache" };

export interface Snapshot<T = unknown> {
  schema: number;
  key: string;
  endpoint: string;
  symbol: string;
  /** 取到这份数据的时刻。**必须显示给用户** */
  fetched_at: string;
  payload: T;
}

const mem = new Map<string, { at: number; snap: Snapshot }>();

/**
 * 递归规范化:对象按键名排序,数组保序(数组的顺序是语义的一部分)。
 * 🔴 只排第一层不够 —— `{a:{x:1,y:2}}` 与 `{a:{y:2,x:1}}` 是**同一个查询**,
 *    却会算出两把键、各存一份、互相看不见(Codex 架构评审 arch-r1 §A-2)。
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canonical(o[k]); return acc; }, {});
  }
  return v;
}

/**
 * 快照键:端点 + 主体 + 参数。
 * 🔴 参数要进键 —— 同一个端点取不同参数是**不同的数据**,共用一把键会让用户看到别的查询的结果。
 */
export function snapshotKey(endpoint: string, symbol: string, args?: Record<string, unknown>): string {
  const stable = JSON.stringify(canonical(args ?? {}));
  const h = crypto.createHash("sha256").update(`${endpoint}\u0000${symbol}\u0000${stable}`).digest("hex").slice(0, 12);
  // 前缀留可读的端点名,便于人工翻 .local/snapshots/ 时认得出来
  return `${endpoint.replace(/[^\w.-]/g, "_").slice(0, 40)}-${h}`;
}

function fileOf(dataRoot: string, key: string): string {
  const dir = path.resolve(dataRoot, "snapshots");
  const abs = path.resolve(dir, `${key}.json`);
  // key 由 snapshotKey 生成(只含 \w.- 与短哈希);这里是第二道:别人换个方式造 key 也拼不出穿越
  if (path.dirname(abs) !== dir) throw new Error(`非法快照键:${JSON.stringify(key)}`);
  return abs;
}

/**
 * 这份快照按给定策略还能不能用。
 * @param maxAgeMs 端点自己声明的上限(注册表 `cache_max_age_sec`)。`0` = 从不缓存。
 */
export function snapshotUsable(snap: Snapshot | null, c: Consistency, endpointMaxAgeMs?: number | null): boolean {
  if (!snap || c.mode === "fresh") return false;
  // 端点声明的上限**永远生效**,调用方放宽不了 —— 它是数据本身的性质(如 session_phase 随分钟变)
  const limits = [endpointMaxAgeMs, c.mode === "prefer_cache" ? c.max_age_ms : undefined]
    .filter((x): x is number => typeof x === "number");
  if (limits.length === 0) return true;
  const age = Date.now() - Date.parse(snap.fetched_at);
  return age <= Math.min(...limits);
}

/** 读快照。没有 / 结构版本对不上 → null(调用方去真取) */
export function readSnapshot<T = unknown>(dataRoot: string, key: string): Snapshot<T> | null {
  const file = fileOf(dataRoot, key);
  const hit = mem.get(file);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.snap as Snapshot<T>;
  const raw = readJsonIfExists<Snapshot<T>>(file);
  // ⚠️ 读的是产品自己写的文件,但仍要查形状:用户可能手改过,也可能是上一个版本写的
  if (!raw || typeof raw !== "object" || raw.schema !== SNAPSHOT_SCHEMA || typeof raw.fetched_at !== "string") return null;
  mem.set(file, { at: Date.now(), snap: raw as Snapshot });
  return raw;
}

/**
 * 写快照。**只在这次真取到东西时调**。
 * @param valid 判断这次结果算不算"取到了"。返回 false 就不写 —— 一次失败不该被记住。
 */
export function writeSnapshot<T>(
  dataRoot: string,
  key: string,
  meta: { endpoint: string; symbol: string },
  payload: T,
  valid: (p: T) => boolean,
): Snapshot<T> | null {
  if (!valid(payload)) return null;
  const snap: Snapshot<T> = {
    schema: SNAPSHOT_SCHEMA,
    key,
    endpoint: meta.endpoint,
    symbol: meta.symbol,
    fetched_at: nowIso(),
    payload,
  };
  const file = fileOf(dataRoot, key);
  atomicWrite(file, `${JSON.stringify(snap, null, 2)}\n`);
  mem.set(file, { at: Date.now(), snap: snap as Snapshot });
  return snap;
}

/** 列出现有快照(诊断 / 让界面显示"这一页的数据是什么时候的") */
export function listSnapshots(dataRoot: string): { key: string; endpoint: string; symbol: string; fetched_at: string }[] {
  const dir = path.resolve(dataRoot, "snapshots");
  if (!fs.existsSync(dir)) return [];
  const out: { key: string; endpoint: string; symbol: string; fetched_at: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const s = readJsonIfExists<Snapshot>(path.join(dir, f));
    if (s && s.schema === SNAPSHOT_SCHEMA) out.push({ key: s.key, endpoint: s.endpoint, symbol: s.symbol, fetched_at: s.fetched_at });
  }
  return out.sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1));
}

/** 测试用:清空内存层(磁盘层不动) */
export function resetSnapshotMemory(): void {
  mem.clear();
}
