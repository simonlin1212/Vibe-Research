import { type ReactNode } from "react";
import { Panel } from "@/components/cockpit/Panel";
import { usePanelZoom, type ZoomRowDef } from "@/hooks/usePanelZoom";

export type CockpitCell = {
  id: string;
  title: string;
  hint?: string;
  defaultW: number;
  mobileH: string;
  maxZoomW?: number;
  icon?: ReactNode;
  accent?: string;
  right?: ReactNode;
  bodyClassName?: string;
  body: ReactNode;
};

export type CockpitRow = {
  defaultH: number;
  panels: CockpitCell[];
};

/** Desktop: one-screen rows. Mobile: stack full-height cards and scroll. */
export function CockpitLayout({ rows }: { rows: CockpitRow[] }) {
  const zoomRows: ZoomRowDef[] = rows.map((r) => ({
    defaultH: r.defaultH,
    panels: r.panels.map((p) => ({ id: p.id, defaultW: p.defaultW, maxZoomW: p.maxZoomW })),
  }));
  const { isZoomed, toggle, layout } = usePanelZoom(zoomRows);

  return (
    <div className="flex flex-col gap-px bg-[#2a2a2a] lg:h-full lg:min-h-0 lg:flex-1">
      {rows.map((row, rowIdx) => (
        <div
          key={row.panels.map((p) => p.id).join("-")}
          className="flex flex-col gap-px transition-all duration-300 lg:h-[var(--row-h)] lg:min-h-0 lg:flex-row"
          style={{ "--row-h": `${layout.rowHeights[rowIdx] * 100}%` } as React.CSSProperties}
        >
          {row.panels.map((panel, panelIdx) => (
            <div
              id={`cockpit-${panel.id}`}
              key={panel.id}
              className={`min-w-0 w-full shrink-0 transition-all duration-300 lg:h-full lg:min-h-0 lg:w-[var(--panel-w)] lg:shrink ${
                isZoomed(panel.id) ? "h-[70vh] lg:h-full" : panel.mobileH
              }`}
              style={{ "--panel-w": `${layout.rowWidths[rowIdx][panelIdx] * 100}%` } as React.CSSProperties}
            >
              <Panel
                className="h-full"
                title={panel.title}
                hint={panel.hint}
                icon={panel.icon}
                accent={panel.accent}
                right={panel.right}
                bodyClassName={panel.bodyClassName}
                panelId={panel.id}
                isZoomed={isZoomed(panel.id)}
                onToggleZoom={toggle}
              >
                {panel.body}
              </Panel>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
