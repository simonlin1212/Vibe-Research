import { useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { usePolling } from "@/hooks/usePolling";
import { api, type ReviewArchiveDiff } from "@/lib/api";
import { cn } from "@/lib/utils";

function tone(status: ReviewArchiveDiff["status"] | undefined): string {
  if (status === "need_two_runs") return "text-amber-400";
  if (status === "unchanged") return "text-slate-400";
  if (status === "changed") return "text-slate-200";
  return "text-slate-500";
}

export function ReviewArchiveDiffBar({ tick }: { tick: number }) {
  const poll = usePolling(() => api.reviewArchiveDiff(), 180_000, [tick]);
  const [open, setOpen] = useState(false);
  const d = poll.data;
  const status = d?.status;
  const canOpen = status === "changed" && (d?.changes?.length ?? 0) > 0;

  return (
    <div className="shrink-0 border-b border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-1.5 text-left text-[11px]",
          canOpen ? "hover:text-primary" : "cursor-default",
          tone(status),
        )}
      >
        <GitCompareArrows className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1">
          {poll.error && !d ? poll.error : d?.message || "对照昨日档…"}
        </span>
      </button>
      {open && canOpen ? (
        <ul className="mt-1 space-y-1 pl-5 text-[10px] text-slate-500">
          {d?.changes?.map((c) => (
            <li key={c.name}>
              <span className="text-slate-300">{c.name}</span>
              {c.kind === "added" ? " 新有" : c.kind === "removed" ? " 没了" : ""}
              {c.before ? <div className="truncate text-slate-600">昨 {c.before}</div> : null}
              {c.after ? <div className="truncate text-slate-400">今 {c.after}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
