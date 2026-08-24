import { type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FreshnessBar } from "@/components/ui/FreshnessBar";
import type { AShareSession } from "@/lib/ashareSession";

export type GlanceTone = "up" | "down" | "flat" | "primary" | "muted";

export interface GlanceMetric {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: GlanceTone;
}

interface Props {
  metrics: GlanceMetric[];
  title?: string;
  subtitle?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  updatedAt?: Date | number | string | null;
  auto?: boolean;
  onAutoChange?: (next: boolean) => void;
  autoHint?: string;
  session?: AShareSession;
  showSessionHint?: boolean;
  allOpen?: boolean;
  onToggleAll?: () => void;
  actions?: ReactNode;
  className?: string;
}

const toneClass: Record<GlanceTone, string> = {
  up: "text-danger",
  down: "text-success",
  flat: "text-muted-foreground",
  primary: "text-primary",
  muted: "text-slate-100",
};

export function GlanceStrip({
  metrics,
  title,
  subtitle,
  onRefresh,
  refreshing,
  updatedAt,
  auto,
  onAutoChange,
  autoHint,
  session,
  showSessionHint,
  allOpen,
  onToggleAll,
  actions,
  className,
}: Props) {
  const showFreshness =
    session != null ||
    onRefresh != null ||
    onAutoChange != null ||
    updatedAt != null ||
    refreshing;

  const cols =
    metrics.length <= 4
      ? "grid-cols-2 sm:grid-cols-4"
      : metrics.length <= 6
        ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
        : "grid-cols-2 sm:grid-cols-4 xl:grid-cols-8";

  return (
    <div className={cn("mb-1 border border-[#2a2a2a] bg-black p-1.5", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title && <p className="text-[12px] font-semibold tracking-wide text-slate-200">{title}</p>}
          {subtitle && <p className="text-[10px] text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onToggleAll && (
            <button
              type="button"
              onClick={onToggleAll}
              className="inline-flex items-center gap-1 border border-[#333] px-1.5 py-0.5 text-[11px] text-[#aaa] hover:border-primary/50 hover:text-primary"
              title={allOpen ? "全部收起" : "全部展开"}
            >
              {allOpen ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
              {allOpen ? "全部收起" : "全部展开"}
            </button>
          )}
          {showFreshness && (
            <FreshnessBar
              session={session}
              showSessionHint={showSessionHint}
              updatedAt={updatedAt}
              refreshing={refreshing}
              onRefresh={onRefresh}
              auto={auto}
              onAutoChange={onAutoChange}
              autoHint={autoHint}
            />
          )}
          {actions}
        </div>
      </div>
      <div className={cn("grid gap-1.5", cols)}>
        {metrics.map((m) => (
          <div key={m.label} className="min-w-0 rounded border border-slate-700/30 bg-slate-900/40 px-2 py-1.5">
            <p className="truncate text-[10px] text-slate-500">{m.label}</p>
            <p className={cn("mt-0.5 truncate font-mono text-sm font-bold tabular-nums", toneClass[m.tone ?? "muted"])}>
              {m.value}
            </p>
            {m.sub != null && m.sub !== "" && (
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{m.sub}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
