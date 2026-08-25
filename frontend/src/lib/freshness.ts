/** Shared clock formatting for market dashboard freshness labels. */

export function formatClock(
  at: Date | number | string | null | undefined,
  opts: { withSeconds?: boolean; refreshing?: boolean; empty?: string } = {},
): string {
  const { withSeconds = true, refreshing = false, empty = "—" } = opts;
  if (refreshing && (at == null || at === "")) return "更新中…";
  if (at == null || at === "") return empty;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return empty;
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  });
}

/** Upstream quote stamp: "YYYY-MM-DD HH:MM:SS" or YYYYMMDDHHMMSS. */
export function formatQuoteClock(raw?: string | null): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const clock = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (clock) return `${clock[1].padStart(2, "0")}:${clock[2]}:${clock[3] ?? "00"}`;
  if (/^\d{14}$/.test(s)) return `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  return "";
}

function sessionClock(raw?: string | null): string {
  const c = formatQuoteClock(raw);
  // Daily bars are dated 00:00; that must not beat a live 16:32/17:03 stamp.
  return !c || c === "00:00:00" ? "" : c;
}

/** Prefer the later clock on the same session. Persist 16:32 must not beat a 17:03 bar. */
export function laterQuoteClock(a?: string | null, b?: string | null): string {
  const ca = sessionClock(a);
  const cb = sessionClock(b);
  if (!ca) return cb;
  if (!cb) return ca;
  return ca >= cb ? ca : cb;
}

/** Relative age hint for scanability (e.g. "12s 前"). */
export function formatAge(at: Date | number | null | undefined, now: Date = new Date()): string | null {
  if (at == null) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const sec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  return formatClock(d, { withSeconds: false });
}
