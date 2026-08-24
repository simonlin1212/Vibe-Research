import { cn } from "@/lib/utils";
import type { AShareSession } from "@/lib/ashareSession";

interface Props {
  session: AShareSession;
  className?: string;
  /** Show hint text beside the chip */
  showHint?: boolean;
}

/** Compact A-share session badge for market dashboard headers. */
export function SessionChip({ session, className, showHint = false }: Props) {
  const tone =
    session.kind === "open"
      ? "border-primary/40 bg-primary/10 text-primary"
      : session.kind === "closed"
        ? "border-border/50 bg-muted/30 text-muted-foreground"
        : "border-border/40 bg-muted/20 text-muted-foreground/80";

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium",
          tone,
        )}
        title={session.hint}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            session.kind === "open" ? "bg-primary animate-pulse" : "bg-muted-foreground/45",
          )}
        />
        {session.label}
      </span>
      {showHint && (
        <span className="truncate text-[11px] text-muted-foreground/65">{session.hint}</span>
      )}
    </span>
  );
}
