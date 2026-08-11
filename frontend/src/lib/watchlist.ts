// 关注股票（自选股）—— 只存本地 localStorage，不上传、不进仓库。
// 行情复用 /api/quote；复盘时把关注股行情一并喂给用户自己的 AI。

const KEY = "vr-watchlist";

export interface WatchItem {
  code: string;
  market: string;  // "A" / "HK" / "US" / "KR"
}

export function loadWatch(): WatchItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(v)) return [];
    // 兼容旧格式 string[]：纯字符串（旧版只存 6 位 A 股代码）→ {code, market:"A"}
    return v
      .map((x) => (typeof x === "string" ? { code: x, market: "A" } : x))
      .filter((x) => x && typeof x.code === "string" && x.code);
  } catch {
    return [];
  }
}

export function saveWatch(items: WatchItem[]) {
  // localStorage 在隐私模式 / 嵌入式浏览器 / 配额写满时会抛异常。
  // 存不下就算了——自选丢失总好过整页崩掉（读取侧同样是 try/catch 兜底）。
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 存储不可用：本次会话内仍可正常使用，只是关掉页面后不保留 */
  }
}
