#!/usr/bin/env node
/**
 * 变化提醒(Phase 1 M3):同一主体两次运行的证据按事实键(field | period | unit | adjustment | record_key)对齐,列出 新增 / 消失 / 数值变化 的事实。
 * 只并列两次的值(不算变化率 / 不解读);供定时任务(cron / launchd 由用户自配)产出 .local/alerts/<symbol>/<new-run>.md。
 * 用法:node orchestrator/src/alerts.ts --symbol 300308 [--market SZ] [--base <run-id>] [--new <run-id>] [--fields <字段1,字段2,...>]
 * 缺省:new = 该主体最新 complete 运行,base = 其前一次。
 */
import { currentPlugin } from "./plugin.ts";
import fs from "node:fs";
import path from "node:path";

import { RUN_ID_RE } from "./config.ts";
import { readJsonIfExists, writeJson } from "./fsutil.ts";
import { parseArgs } from "./run.ts";
import { repoRootFromHere, serviceContext, safePath } from "./service.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export interface EvidenceLite { id: string; field: string; value: unknown; unit: string; period: string; adjustment?: string; record_key?: string; source: string; script?: string }
/** 对齐键含 source:只比较同一来源前后两次的值(跨源差异属"数据源冲突",由各运行 conflicts.json 显式报告,这里不做静默取舍) */
export const alignKey = (e: EvidenceLite) => [e.field, e.period, e.unit, e.adjustment ?? "", e.record_key ?? "", e.source ?? ""].join("|");
export interface AlertDiff { key: string; field: string; period: string; unit: string; kind: "changed" | "added" | "removed"; base?: EvidenceLite; next?: EvidenceLite }

/** 变化提醒默认盯的字段**由插件提供** */
const defaultFields = (): readonly string[] => currentPlugin().alertFields;

export function loadRunEvidence(runDir: string): EvidenceLite[] {
  const merged = readJsonIfExists<EvidenceLite[] | { evidence: EvidenceLite[] }>(path.join(runDir, "evidence.json"));
  const items = Array.isArray(merged) ? merged : merged?.evidence ?? [];
  return items;
}

export function diffEvidence(base: EvidenceLite[], next: EvidenceLite[], fields: string[] = [...defaultFields()]): AlertDiff[] {
  const want = new Set(fields);
  const key = alignKey;
  const b = new Map<string, EvidenceLite>();
  const n = new Map<string, EvidenceLite>();
  // 同一运行内同源同键:值相同(两个端点报同一事实)→ 去重保留先出现者;值不同 → 同源自相矛盾,拒绝静默取舍
  const dup: string[] = [];
  const put = (m: Map<string, EvidenceLite>, e: EvidenceLite) => {
    const k = key(e);
    const o = m.get(k);
    if (!o) { m.set(k, e); return; }
    if (JSON.stringify(o.value) !== JSON.stringify(e.value)) dup.push(`${k}:${String(o.value).slice(0, 20)}≠${String(e.value).slice(0, 20)}`);
  };
  for (const e of base) if (want.has(e.field)) put(b, e);
  for (const e of next) if (want.has(e.field)) put(n, e);
  if (dup.length) throw new Error(`同一运行内同源同键但值不同(同源自相矛盾),拒绝静默取舍:${dup.slice(0, 3).join(" ; ")}`);
  // Only declared observation fields may cross days. Financial/reporting periods
  // retain their identity. Detect ALL same-day conflicts above before selecting latest.
  const observationFields = new Set(currentPlugin().alertObservationFields ?? []);
  const latest = (items: Map<string, EvidenceLite>): Map<string, EvidenceLite> => {
    const selected = new Map<string, EvidenceLite>();
    for (const [originalKey, e] of items) {
      const validDay = /^\d{4}-\d{2}-\d{2}$/.test(e.period)
        && Number.isFinite(Date.parse(e.period)) && new Date(e.period).toISOString().slice(0, 10) === e.period;
      const observational = observationFields.has(e.field) && validDay;
      const k = observational ? `observation:${JSON.stringify([e.field, e.unit, e.adjustment ?? "", e.record_key ?? "", e.source])}` : originalKey;
      const old = selected.get(k);
      if (!old || (observational && old.period < e.period)) selected.set(k, e);
    }
    return selected;
  };
  const baseLatest = latest(b), nextLatest = latest(n);
  const out: AlertDiff[] = [];
  for (const [k, e] of nextLatest) {
    const o = baseLatest.get(k);
    if (!o) out.push({ key: k, field: e.field, period: e.period, unit: e.unit, kind: "added", next: e });
    else if (JSON.stringify(o.value) !== JSON.stringify(e.value)) out.push({ key: k, field: e.field, period: e.period, unit: e.unit, kind: "changed", base: o, next: e });
  }
  for (const [k, e] of baseLatest) if (!nextLatest.has(k)) out.push({ key: k, field: e.field, period: e.period, unit: e.unit, kind: "removed", base: e });
  return out.sort((x, y) => x.field.localeCompare(y.field) || x.period.localeCompare(y.period));
}

export function alertsMarkdown(symbol: string, baseId: string, newId: string, diffs: AlertDiff[]): string {
  const L = [`# 变化提醒 · ${symbol} · ${baseId} → ${newId}`, "", "> 同源同口径对齐两次运行：插件声明的观测字段取各次最新观测日，其余字段仍按资料期分别对齐；只并列两值，不计算变化率、不解读。", "",
    `- 变化 ${diffs.filter((d) => d.kind === "changed").length} · 新增 ${diffs.filter((d) => d.kind === "added").length} · 消失 ${diffs.filter((d) => d.kind === "removed").length}`, "",
    "| 类型 | 字段 | 期间 | 单位 | 旧值(id) | 新值(id) | 来源 |", "|---|---|---|---|---|---|---|"];
  // 按来源对齐:同一字段不同来源各成一行;跨源差异见各运行 conflicts.json
  for (const d of diffs) {
    const period = d.base && d.next && d.base.period !== d.next.period ? `${d.base.period} → ${d.next.period}` : d.period;
    L.push(`| ${d.kind} | ${d.field} | ${period}${d.base?.record_key || d.next?.record_key ? ` · ${(d.base ?? d.next)!.record_key}` : ""} | ${d.unit} | ${d.base ? `${String(d.base.value).slice(0, 60)}(${d.base.id})` : "-"} | ${d.next ? `${String(d.next.value).slice(0, 60)}(${d.next.id})` : "-"} | ${(d.next ?? d.base)!.source} |`);
  }
  if (!diffs.length) L.push("", "(所关注字段无变化)");
  return L.join("\n") + "\n";
}

export function pickRuns(runsRoot: string, symbol: string, market?: string): string[] {
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot).filter((d) => RUN_ID_RE.test(d) && !fs.lstatSync(path.join(runsRoot, d)).isSymbolicLink()).map((d) => ({ d, m: readJsonIfExists<{ symbol?: string; market?: string; status?: string; finished_at?: string }>(safePath({ dataRoot: runsRoot }, d, "manifest.json")) }))
    .filter((x) => x.m?.symbol === symbol && (!market || (x.m?.market ?? "") === market) && x.m?.status && x.m.status !== "failed" && x.m.finished_at).sort((a, b) => String(a.m!.finished_at).localeCompare(String(b.m!.finished_at))).map((x) => x.d);
}

/** 显式指定的 run 必须存在、同主体、同市场(给了 market 时)、非 failed */
function assertComparable(runsRoot: string, id: string, symbol: string, market?: string): void {
  if (!RUN_ID_RE.test(id)) throw new Error(`非法 run-id ${id}`);
  const m = readJsonIfExists<{ symbol?: string; market?: string; status?: string }>(path.join(runsRoot, id, "manifest.json"));
  if (!m) throw new Error(`运行 ${id} 不存在或无 manifest`);
  if (m.symbol !== symbol) throw new Error(`运行 ${id} 的主体是 ${m.symbol},与请求 ${symbol} 不符`);
  if (market !== undefined && (m.market ?? "") !== market) throw new Error(`运行 ${id} 的市场是 ${m.market || "(空)"},与 ${market || "(空)"} 不符`);
  if (m.status === "failed") throw new Error(`运行 ${id} 状态 failed,不可比较`);
}

export function runAlerts(opts: { symbol: string; market?: string; base?: string; next?: string; fields?: string[]; repoRoot?: string; dataRoot?: string; persist?: boolean }): { file: string; diffs: AlertDiff[]; base: string; next: string } {
  const ctx = opts.dataRoot !== undefined ? { dataRoot: opts.dataRoot } : serviceContext({ repoRoot: opts.repoRoot });
  if (!/^[A-Za-z0-9.\-]{1,12}$/.test(opts.symbol)) throw new Error(`非法代码 ${opts.symbol}`);
  const market = opts.market ? String(opts.market).toUpperCase() : undefined;
  // 合法市场取值由契约给(Plugin.evidence.markets),Core 不写死垂类代码(全审 r4)
  if (market && !currentPlugin().evidence.markets.includes(market)) throw new Error(`非法市场 ${opts.market}`);
  const runsRoot = safePath(ctx, "runs");
  const cand = pickRuns(runsRoot, opts.symbol, market);
  const next = opts.next ?? cand[cand.length - 1];
  const base = opts.base ?? cand[cand.length - 2];
  if (!next || !base) throw new Error(`该主体可比较的运行不足两个(找到 ${cand.length} 个):${cand.join(", ")}`);
  if (next === base) throw new Error("base 与 new 不能是同一运行");
  for (const id of [base, next]) {
    if (!RUN_ID_RE.test(id)) throw new Error(`非法 run-id ${id}`);
    safePath(ctx, "runs", id, "manifest.json");
    safePath(ctx, "runs", id, "evidence.json");
  }
  // 省略 market 时以 base 运行的市场为准(两次必须同市场;同代码不同市场不是时间序列)
  const baseMarket = (readJsonIfExists<{ market?: string }>(path.join(runsRoot, base, "manifest.json"))?.market ?? "");
  const mk = market ?? baseMarket;
  for (const id of [base, next]) assertComparable(runsRoot, id, opts.symbol, mk);
  const diffs = diffEvidence(loadRunEvidence(path.join(runsRoot, base)), loadRunEvidence(path.join(runsRoot, next)), opts.fields);
  const dir = safePath(ctx, "alerts", `${mk || "XX"}_${opts.symbol}`);
  const file = safePath(ctx, "alerts", `${mk || "XX"}_${opts.symbol}`, `${next}.md`);
  if (opts.persist !== false) {
    const jsonFile = safePath(ctx, "alerts", `${mk || "XX"}_${opts.symbol}`, `${next}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, alertsMarkdown(opts.symbol, base, next, diffs));
    writeJson(jsonFile, { symbol: opts.symbol, base, next, diffs });
  }
  return { file, diffs, base, next };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (!str(a.symbol)) { console.error("用法:node orchestrator/src/alerts.ts --symbol 300308 [--market SZ] [--base run] [--new run] [--fields a,b]"); process.exit(2); }
  const r = runAlerts({ symbol: str(a.symbol)!, market: str(a.market), base: str(a.base), next: str(a.new), fields: str(a.fields)?.split(",").map((s) => s.trim()).filter(Boolean), repoRoot: str(a["repo-root"]) ?? repoRootFromHere() });
  console.error(`[alerts] ${r.base} → ${r.next}:${r.diffs.length} 条 → ${r.file}`);
}

if (process.argv[1] && process.argv[1].endsWith("alerts.ts")) main().catch((e) => { console.error(`[alerts] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
