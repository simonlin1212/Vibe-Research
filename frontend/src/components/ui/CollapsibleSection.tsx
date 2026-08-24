import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSectionOpen } from "@/hooks/useExpandAll";

interface Props {
  title: string;
  icon?: ReactNode;
  hint?: string;
  /** One-line preview when collapsed */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** localStorage key under vr.glance. prefix */
  storageKey?: string;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** Glance-first detail block: title row toggles body; open state optional localStorage. */
export function CollapsibleSection({
  title,
  icon,
  hint,
  summary,
  defaultOpen = false,
  storageKey,
  actions,
  className,
  bodyClassName,
  children,
}: Props) {
  const [open, setOpen] = useSectionOpen(storageKey, defaultOpen);

  return (
    <section className={cn("mb-1", className)}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left hover:bg-[#1a1400]"
          aria-expanded={open}
        >
          <span className="inline-flex h-3.5 w-0.5 shrink-0 bg-primary" aria-hidden />
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {icon}
            {title}
          </h3>
          {hint && <span className="truncate text-[11px] text-muted-foreground/55">{hint}</span>}
          {!open && summary != null && summary !== "" && (
            <span className="ml-1 truncate text-[11px] text-muted-foreground/70">{summary}</span>
          )}
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        {actions && (
          <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div className={cn(bodyClassName)}>{children}</div>}
    </section>
  );
}
