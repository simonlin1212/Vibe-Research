import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  icon?: ReactNode;
  title: string;
  hint?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** A股复盘等长页的区块标题: 左侧标题 + 弱提示, 右侧 meta / 操作 */
export function SectionHeader({ icon, title, hint, meta, actions, className }: Props) {
  return (
    <div className={cn("mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-3.5 w-0.5 shrink-0 bg-primary" aria-hidden />
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-slate-200">
          {icon}
          {title}
        </h3>
        {hint && <span className="truncate text-[11px] text-muted-foreground/55">{hint}</span>}
      </div>
      {(meta || actions) && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {meta && <span className="text-[11px] text-muted-foreground/50">{meta}</span>}
          {actions}
        </div>
      )}
    </div>
  );
}

interface ChipGroupProps {
  children: ReactNode;
  className?: string;
}

export function ChipGroup({ children, className }: ChipGroupProps) {
  return (
    <div className={cn("inline-flex flex-wrap items-center gap-px border border-[#2a2a2a] bg-black p-px", className)}>
      {children}
    </div>
  );
}

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  accent?: "cyan" | "amber" | "violet";
}

export function Chip({ active, onClick, children, accent = "cyan" }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-[10px]",
        active
          ? accent === "amber"
            ? "bg-amber-500/20 font-medium text-amber-300"
            : accent === "violet"
              ? "bg-violet-500/20 font-medium text-violet-300"
              : "bg-primary/15 font-medium text-primary"
          : "text-slate-500 hover:text-slate-200",
      )}
    >
      {children}
    </button>
  );
}
