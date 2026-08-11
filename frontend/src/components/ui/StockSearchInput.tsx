import { useEffect, useRef, useState } from "react";
import { api, type SearchSuggestion } from "@/lib/api";

const MKT_LABEL: Record<string, string> = {
  A: "A股", HK: "港股", US: "美股", KR: "韩股", FD: "场外基金",
};

interface StockSearchInputProps {
  value: string;
  onChange: (v: string) => void;
  onSelect: (item: SearchSuggestion) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** 股票搜索输入框：输入时 300ms 防抖调后端搜索，下拉显示候选，点击选中。 */
export function StockSearchInput({ value, onChange, onSelect, placeholder, className, disabled }: StockSearchInputProps) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖搜索
  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const q = value.trim();
    if (!q) { setSuggestions([]); setOpen(false); return; }
    timerRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.search(q);
        setSuggestions(data);
        setOpen(data.length > 0);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [value]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 20))}
        onFocus={() => { if (suggestions.length) setOpen(true); }}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
      {open && (
        <div className="absolute z-[9999] mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-popover shadow-lg">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">搜索中…</div>}
          {!loading && suggestions.map((s) => (
            <button
              key={`${s.market}:${s.code}`}
              type="button"
              onClick={() => { onSelect(s); onChange(s.code); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="font-mono">{s.code}</span>
              <span className="flex-1 truncate">{s.name}</span>
              <span className="text-xs text-muted-foreground">{MKT_LABEL[s.market] || s.market}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
