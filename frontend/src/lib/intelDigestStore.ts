import { useSyncExternalStore } from "react";
import { ApiError, type Industry } from "@/lib/api";
import { chatStream, hasLlm } from "@/lib/llm";

export interface Digest {
  loading?: boolean;
  text?: string;
  err?: string;
  needKey?: boolean;
}

export interface BulkDigestState {
  running: boolean;
  done: number;
  total: number;
}

interface IntelDigestSnapshot {
  digests: Record<string, Digest>;
  bulk: BulkDigestState;
}

const idleBulk: BulkDigestState = { running: false, done: 0, total: 0 };
let snapshot: IntelDigestSnapshot = { digests: {}, bulk: idleBulk };
let bulkJob: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * 订阅资讯提炼状态变化。
 *
 * Args:
 *   listener: React 外部 store 更新监听函数。
 *
 * Returns:
 *   取消订阅函数。
 */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 获取当前资讯提炼快照。
 *
 * Returns:
 *   当前的赛道要点和批量任务进度。
 */
function getSnapshot() {
  return snapshot;
}

/**
 * 写入新的资讯提炼快照并通知页面。
 *
 * Args:
 *   next: 下一个提炼状态快照。
 */
function commit(next: IntelDigestSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/**
 * 更新单个赛道的提炼结果。
 *
 * Args:
 *   key: 赛道唯一标识。
 *   digest: 该赛道当前的提炼状态。
 */
function setDigest(key: string, digest: Digest) {
  commit({ ...snapshot, digests: { ...snapshot.digests, [key]: digest } });
}

/**
 * 更新一键提炼的整体进度。
 *
 * Args:
 *   bulk: 新的批量提炼状态。
 */
function setBulk(bulk: BulkDigestState) {
  commit({ ...snapshot, bulk });
}

/**
 * 拼出赛道资讯提炼提示词。
 *
 * Args:
 *   industry: 当前要提炼的赛道资讯。
 *
 * Returns:
 *   可直接发送给 AI 的用户提示词。
 */
function buildPrompt(industry: Industry) {
  const ctx = industry.items.slice(0, 25).map((item) => `[${item.time}] ${item.source}｜${item.zh || item.title}`).join("\n");
  return (
    `以下是「${industry.name}」赛道近期资讯。请提炼「今日要点」3-5 条：每条一句话（≤40 字），` +
    `只客观陈述重要事件 / 趋势，不推荐标的、不预测涨跌、不构成建议。直接用「- 」列点，不要多余前后缀。\n\n${ctx}`
  );
}

/**
 * 在组件外执行单个赛道要点提炼。
 *
 * Args:
 *   industry: 当前要提炼的赛道。
 */
export async function generateIndustryDigest(industry: Industry) {
  if (!hasLlm()) {
    setDigest(industry.key, { needKey: true });
    return;
  }

  setDigest(industry.key, { loading: true });
  const prompt = buildPrompt(industry);
  let acc = "";
  try {
    await chatStream([{ role: "user", content: prompt }], `${industry.name}赛道资讯`, {
      onDelta: (text) => {
        acc += text;
        setDigest(industry.key, { text: acc });
      },
    });
    if (!acc) setDigest(industry.key, { err: "生成结果为空" });
  } catch (error) {
    setDigest(industry.key, { err: error instanceof ApiError ? error.message : "生成失败" });
  }
}

/**
 * 在组件外串行执行全部赛道要点提炼。
 *
 * Args:
 *   industries: 当前资讯雷达返回的全部赛道。
 *   currentIndustry: 未配置 AI 时用于展示接入提示的当前赛道。
 */
export function generateAllIndustryDigests(industries: Industry[], currentIndustry?: Industry) {
  if (!hasLlm()) {
    if (currentIndustry) setDigest(currentIndustry.key, { needKey: true });
    return Promise.resolve();
  }
  if (bulkJob) return bulkJob;

  const targets = industries.filter((industry) => industry.items.length > 0);
  setBulk({ running: true, done: 0, total: targets.length });
  bulkJob = (async () => {
    try {
      for (const industry of targets) {
        await generateIndustryDigest(industry);
        setBulk({ ...snapshot.bulk, done: snapshot.bulk.done + 1 });
      }
    } finally {
      setBulk({ ...snapshot.bulk, running: false });
      bulkJob = null;
    }
  })();
  return bulkJob;
}

/**
 * 在 React 组件中读取资讯提炼状态。
 *
 * Returns:
 *   当前的赛道要点和批量任务进度。
 */
export function useIntelDigestStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
