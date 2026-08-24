import { memo, useState, type ComponentType } from "react";
import { type PanelZoomProps } from "@/components/cockpit/Panel";

type PanelCompProps = { className?: string } & PanelZoomProps;

export interface AiCellDef {
  id: string;
  component: ComponentType<PanelCompProps>;
  area: string;
  mobileH: string;
}

const MemoCell = memo(function MemoCell({
  component: C,
  ...props
}: { component: ComponentType<PanelCompProps> } & PanelCompProps) {
  return <C {...props} />;
});

export function AiGrid({ cells }: { cells: AiCellDef[] }) {
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const toggle = (id: string) => setZoomedId((p) => (p === id ? null : id));
  const zoomed = zoomedId != null;

  return (
    <main className="grid grid-cols-1 gap-px bg-[#2a2a2a] lg:h-full lg:min-h-0 lg:flex-1 lg:grid-cols-3 lg:grid-rows-4 lg:overflow-hidden">
      {cells.map((c) => (
        <div
          key={c.id}
          className={`w-full shrink-0 transition-all duration-300 lg:h-full lg:min-h-0 ${c.mobileH} ${
            zoomed
              ? zoomedId === c.id
                ? "z-10 h-[70vh] lg:h-full lg:col-start-1 lg:row-start-1 lg:col-span-3 lg:row-span-4"
                : "hidden"
              : c.area
          }`}
        >
          <MemoCell
            component={c.component}
            className="h-full"
            panelId={c.id}
            isZoomed={zoomedId === c.id}
            onToggleZoom={toggle}
          />
        </div>
      ))}
    </main>
  );
}
