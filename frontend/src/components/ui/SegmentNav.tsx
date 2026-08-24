import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface SegmentItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Optional badge / count */
  badge?: ReactNode;
}

interface Props {
  items: SegmentItem[];
  value: string;
  onChange: (key: string) => void;
  /** Sticky under page header */
  sticky?: boolean;
  className?: string;
  storageKey?: string;
}

const PREFIX = "vr.glance.seg.";

function readSeg(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  try {
    return localStorage.getItem(PREFIX + key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSeg(key: string | undefined, value: string) {
  if (!key) return;
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch { /* ignore */ }
}

/** Sticky horizontal segment switcher — show one panel at a time instead of scrolling a long page. */
export function SegmentNav({ items, value, onChange, sticky = true, className, storageKey }: Props) {
  return (
    <div
      className={cn(
        "mb-1 border border-[#2a2a2a] bg-black p-px",
        sticky && "sticky top-0 z-20",
        className,
      )}
    >
      <div className="flex gap-0.5 overflow-x-auto">
        {items.map((it) => {
          const active = it.key === value;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => {
                onChange(it.key);
                writeSeg(storageKey, it.key);
              }}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px]",
                active
                  ? "bg-primary/15 font-medium text-primary"
                  : "text-slate-500 hover:text-slate-200",
              )}
            >
              {it.icon}
              {it.label}
              {it.badge != null && it.badge !== "" && (
                <span className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                  active ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground",
                )}>
                  {it.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Persist + validate active segment against available keys. */
export function useSegment(storageKey: string, keys: string[], fallback: string) {
  const initial = (() => {
    const saved = readSeg(storageKey, fallback);
    return keys.includes(saved) ? saved : fallback;
  })();
  const [seg, setSeg] = useState(initial);

  useEffect(() => {
    if (!keys.includes(seg)) setSeg(keys.includes(fallback) ? fallback : keys[0] ?? fallback);
  }, [keys, seg, fallback]);

  const set = (key: string) => {
    setSeg(key);
    writeSeg(storageKey, key);
  };

  return [seg, set] as const;
}
