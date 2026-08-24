import { Chip, ChipGroup } from "@/components/ui/SectionHeader";
import { useFin } from "@/components/fin/FinContext";

export function IndustryModeTabs() {
  const { industryMode, setIndustryMode } = useFin();
  return (
    <ChipGroup>
      <Chip active={industryMode === "bar"} onClick={() => setIndustryMode("bar")}>条形</Chip>
      <Chip active={industryMode === "tree"} onClick={() => setIndustryMode("tree")}>树状</Chip>
    </ChipGroup>
  );
}

export function StockRankTabs() {
  const { stockTab, setStockTab } = useFin();
  return (
    <ChipGroup>
      <Chip active={stockTab === "profit"} onClick={() => setStockTab("profit")}>净利额</Chip>
      <Chip active={stockTab === "growth"} onClick={() => setStockTab("growth")}>增速</Chip>
    </ChipGroup>
  );
}

export function TrendTabs() {
  const { trendTab, setTrendTab } = useFin();
  return (
    <ChipGroup>
      <Chip active={trendTab === "perf"} onClick={() => setTrendTab("perf")}>业绩</Chip>
      <Chip active={trendTab === "quality"} onClick={() => setTrendTab("quality")}>质量</Chip>
      <Chip active={trendTab === "leverage"} onClick={() => setTrendTab("leverage")}>杠杆与回报</Chip>
    </ChipGroup>
  );
}

export function PeerModeTabs() {
  const { peerMode, setPeerMode } = useFin();
  return (
    <ChipGroup>
      <Chip active={peerMode === "radar"} onClick={() => setPeerMode("radar")}>雷达</Chip>
      <Chip active={peerMode === "table"} onClick={() => setPeerMode("table")}>表格</Chip>
    </ChipGroup>
  );
}
