import { AiGrid } from "@/components/ai-watch/AiGrid";
import { AihotPanel } from "@/components/ai-watch/AihotPanel";
import { OpenRouterPanel } from "@/components/ai-watch/OpenRouterPanel";
import { EventPanel, ModelPricePanel, TtsiTrendPanel, ValueScatterPanel } from "@/components/ai-watch/ModelCostPanel";
import { InfraRoiPanel } from "@/components/ai-watch/InfraRoiPanel";

const CELLS = [
  {
    id: "openrouter",
    component: OpenRouterPanel,
    area: "lg:col-start-1 lg:row-start-1 lg:col-span-2 lg:row-span-2",
    mobileH: "h-[360px]",
  },
  { id: "ttsi-trend", component: TtsiTrendPanel, area: "lg:col-start-3 lg:row-start-1", mobileH: "h-[380px]" },
  { id: "price-events", component: EventPanel, area: "lg:col-start-3 lg:row-start-2", mobileH: "h-[380px]" },
  {
    id: "ai-infra",
    component: InfraRoiPanel,
    area: "lg:col-start-1 lg:row-start-3 lg:col-span-2 lg:row-span-2",
    mobileH: "h-[340px]",
  },
  { id: "price-table", component: ModelPricePanel, area: "lg:col-start-3 lg:row-start-3", mobileH: "h-[380px]" },
  { id: "value-scatter", component: ValueScatterPanel, area: "lg:col-start-3 lg:row-start-4", mobileH: "h-[380px]" },
  {
    id: "aihot",
    component: AihotPanel,
    area: "lg:col-start-1 lg:row-start-5 lg:col-span-3",
    mobileH: "h-[52vh]",
  },
];

export function AiWatch() {
  return (
    <div className="flex flex-col lg:h-full lg:min-h-0 lg:flex-1">
      <AiGrid cells={CELLS} />
    </div>
  );
}
