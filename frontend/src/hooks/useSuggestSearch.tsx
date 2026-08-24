import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type SuggestHit = { code: string; name: string };

const CODE_RE = /^(?:sh|sz|bj)?\d{6}$/i;

/** Debounced finSuggest + arrow-key highlight. skipCode: 6-digit input does not query. */
export function useSuggestSearch(opts: { skipCode?: boolean } = {}) {
  const skipCode = opts.skipCode === true;
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SuggestHit[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.clearTimeout(timer.current);
    };
  }, []);

  const type = (v: string) => {
    setQ(v);
    setHi(-1);
    window.clearTimeout(timer.current);
    const t = v.trim();
    if (!t || (skipCode && CODE_RE.test(t))) {
      setHits([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(() => {
      void api.finSuggest(t, 8).then((rows) => {
        setHits(rows);
        setOpen(rows.length > 0);
        setHi(-1);
      }).catch(() => setHits([]));
    }, 280);
  };

  const clear = () => {
    setQ("");
    setHits([]);
    setOpen(false);
    setHi(-1);
  };

  const onKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    onPick: (hit: SuggestHit) => void,
    onCode?: (digits: string) => void,
  ) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hits.length) {
        setOpen(true);
        setHi((i) => (i + 1) % hits.length);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) {
        setOpen(true);
        setHi((i) => (i <= 0 ? hits.length - 1 : i - 1));
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key !== "Enter") return;
    const digits = q.trim().replace(/^(sh|sz|bj)/i, "");
    if (onCode && /^\d{6}$/.test(digits)) {
      onCode(digits);
      return;
    }
    const hit = hi >= 0 ? hits[hi] : hits[0];
    if (hit) onPick(hit);
  };

  return { q, hits, open, hi, boxRef, type, clear, onKeyDown, setOpen };
}

export function SuggestHits({
  hits,
  hi,
  onPick,
  className,
}: {
  hits: SuggestHit[];
  hi: number;
  onPick: (hit: SuggestHit) => void;
  className?: string;
}) {
  if (!hits.length) return null;
  return (
    <div className={className}>
      {hits.map((s, i) => (
        <button
          key={s.code}
          type="button"
          onClick={() => onPick(s)}
          className={cn(
            "flex h-6 w-full items-center gap-2 px-2 text-left",
            i === hi ? "bg-primary/15" : "hover:bg-slate-800/50",
          )}
        >
          <span className="w-14 font-mono text-[10px] text-slate-500">{s.code}</span>
          <span className="truncate text-[11px] text-slate-200">{s.name}</span>
        </button>
      ))}
    </div>
  );
}
