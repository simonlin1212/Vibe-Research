import { Sparkles } from "lucide-react";
import { Panel, type PanelZoomProps } from "@/components/cockpit/Panel";
import { RankList, RankTabs, useRankTab } from "@/components/event/EventRankPanel";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";

const AH_PREFER = ["主题", "全部", "热点", "精选"];

/** Same event_rank/aihot fill as /event. part=aihot, no second family. */
export function AihotPanel({ className, panelId, isZoomed, onToggleZoom }: PanelZoomProps & { className?: string }) {
  const poll = usePolling(() => api.eventRanks("aihot"), 180_000);
  const tabs = poll.data?.aihot?.tabs;
  const ah = useRankTab(tabs, AH_PREFER);
  return (
    <Panel
      title="AIHOT"
      hint="与资讯页同一口 · aihot.virxact.com"
      icon={<Sparkles size={14} />}
      accent="#ffcc00"
      className={className}
      bodyClassName="overflow-hidden"
      panelId={panelId}
      isZoomed={isZoomed}
      onToggleZoom={onToggleZoom}
      right={(
        <RankTabs
          tabs={(tabs ?? []).map((t) => ({ id: t.id, name: t.name }))}
          value={ah.id}
          onChange={ah.setId}
        />
      )}
    >
      <RankList
        items={ah.items}
        loading={!poll.data && !poll.error}
        error={poll.error}
      />
    </Panel>
  );
}
