import { storageGet, storageSet } from "@/lib/storage";

const KEY = "event.pm.watch";
export const PM_WATCH_MAX = 20;

export function loadPmWatch(): string[] {
  try {
    const arr = JSON.parse(storageGet(KEY) ?? "[]");
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const x of arr) {
      const s = String(x || "").trim().toLowerCase();
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= PM_WATCH_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function save(slugs: string[]): string[] {
  const out = slugs.filter(Boolean).slice(0, PM_WATCH_MAX);
  storageSet(KEY, JSON.stringify(out));
  return out;
}

export function addPmWatch(slug: string, prev = loadPmWatch()): string[] {
  const s = slug.trim().toLowerCase();
  if (!s) return prev;
  if (prev.includes(s)) return prev;
  return save([s, ...prev]);
}

export function addPmWatchMany(slugs: string[], prev = loadPmWatch()): string[] {
  let next = prev;
  for (const s of [...slugs].reverse()) next = addPmWatch(s, next);
  return next;
}

export function removePmWatch(slug: string, prev = loadPmWatch()): string[] {
  return save(prev.filter((x) => x !== slug.trim().toLowerCase()));
}
