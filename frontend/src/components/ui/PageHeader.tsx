import { type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5 border-b border-[#2a2a2a] pb-1.5">
      <div className="min-w-0">
        <h1 className="text-[13px] font-semibold tracking-wide text-[#ffcc00]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[11px] text-[#888]">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
