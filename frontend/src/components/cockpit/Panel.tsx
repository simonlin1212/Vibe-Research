import { type ReactNode } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PanelZoomProps {
  panelId?: string;
  isZoomed?: boolean;
  onToggleZoom?: (id: string) => void;
}

interface PanelProps extends PanelZoomProps {
  title: string;
  hint?: string;
  icon?: ReactNode;
  accent?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** Terminal-style cockpit panel with optional zoom. */
export function Panel({
  title,
  hint,
  icon,
  accent,
  right,
  children,
  className = "",
  bodyClassName = "",
  panelId,
  isZoomed = false,
  onToggleZoom,
}: PanelProps) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col border bg-black transition-colors duration-150",
        isZoomed
          ? "border-primary"
          : "border-[#2a2a2a]",
        className,
      )}
    >
      <header className="flex h-6 shrink-0 items-center gap-1.5 border-b border-[#2a2a2a] bg-[#0d0d0d] px-1.5">
        <span
          className="inline-block h-3 w-0.5 shrink-0 bg-primary"
          style={accent ? { background: accent } : undefined}
        />
        {icon && (
          <span className="inline-flex shrink-0 items-center text-primary" style={accent ? { color: accent } : undefined}>
            {icon}
          </span>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-wide text-[#ffcc00]">
          {title}
          {hint && (
            <span className="ml-1.5 font-normal text-[10px] text-[#888]">{hint}</span>
          )}
        </h2>
        <div className="flex min-w-0 max-w-[min(240px,48vw)] shrink items-center justify-end gap-1 overflow-x-auto sm:max-w-none sm:shrink-0 sm:gap-1.5">
          {right}
          {panelId && onToggleZoom && (
            <button
              type="button"
              onClick={() => onToggleZoom(panelId)}
              title={isZoomed ? "缩小" : "放大"}
              className={cn(
                "flex h-[18px] w-[18px] items-center justify-center border transition-colors",
                isZoomed
                  ? "border-primary/70 bg-primary/10 text-primary"
                  : "border-[#333] bg-[#111] text-[#888] hover:border-primary/70 hover:text-primary",
              )}
            >
              {isZoomed ? <ZoomOut size={12} /> : <ZoomIn size={12} />}
            </button>
          )}
        </div>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-auto", bodyClassName)}>{children}</div>
    </section>
  );
}
