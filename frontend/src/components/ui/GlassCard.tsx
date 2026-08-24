import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  frosted?: boolean;
  onClick?: () => void;
}

/** Cockpit surface. glow / frosted kept as no-op flags so old call sites still typecheck. */
export function GlassCard({ children, className, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "border border-[#2a2a2a] bg-black p-2",
        onClick && "cursor-pointer transition-colors hover:border-primary/50",
        className,
      )}
    >
      {children}
    </div>
  );
}
