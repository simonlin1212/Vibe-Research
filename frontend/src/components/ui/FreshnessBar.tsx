import { type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAge, formatClock } from "@/lib/freshness";
import { SessionChip } from "@/components/ui/SessionChip";
import type { AShareSession } from "@/lib/ashareSession";

interface Props {
  updatedAt?: Date | number | string | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  auto?: boolean;
  onAutoChange?: (next: boolean) => void;
  /** Tooltip / title for auto toggle, e.g. "约 30 秒" */
  autoHint?: string;
  session?: AShareSession;
  showSessionHint?: boolean;
  className?: string;
  /** Extra actions after refresh (Ask AI, etc.) */
  actions?: ReactNode;
}

/**
 * Unified freshness chrome for market boards:
 * session chip · auto toggle · clock · age · refresh.
 */
export function FreshnessBar({
  updatedAt,
  refreshing,
  onRefresh,
  auto,
  onAutoChange,
  autoHint,
  session,
  showSessionHint,
  className,
  actions,
}: Props) {
  const showClock = updatedAt != null || !!refreshing;
  const clock = formatClock(updatedAt, { refreshing: !!refreshing });
  const age = updatedAt instanceof Date || typeof updatedAt === "number"
    ? formatAge(updatedAt)
    : updatedAt
      ? formatAge(new Date(updatedAt))
      : null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-[11px]", className)}>
      {session && <SessionChip session={session} showHint={showSessionHint} />}

      {onAutoChange != null && auto != null && (
        <button
          type="button"
          onClick={() => onAutoChange(!auto)}
          className={cn(
            "btn-press inline-flex items-center gap-1 border px-1.5 py-0.5",
            auto
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground",
          )}
          title={auto ? `自动刷新开启${autoHint ? `（${autoHint}）` : ""}，点击关闭` : `点击开启自动刷新${autoHint ? `（${autoHint}）` : ""}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", auto ? "bg-primary animate-pulse" : "bg-muted-foreground/40")} />
          {auto ? "自动" : "手动"}
        </button>
      )}

      {showClock && (
        <span
          className="inline-flex items-center gap-1 font-mono tabular-nums text-muted-foreground/70"
          title={age ? `更新于 ${clock}（${age}）` : `更新于 ${clock}`}
        >
          <span className="text-muted-foreground/45">更新</span>
          {clock}
          {age && !refreshing && (
            <span className="text-muted-foreground/45">· {age}</span>
          )}
        </span>
      )}

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="btn-press inline-flex items-center gap-1 border border-[#333] px-1.5 py-0.5 text-[#aaa] hover:border-primary/50 hover:text-primary disabled:opacity-50"
          title="立即刷新"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          {refreshing ? "刷新中" : "刷新"}
        </button>
      )}

      {actions}
    </div>
  );
}
