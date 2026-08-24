import { lazy, Suspense, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { PageFallback } from "@/components/ui/PageFallback";
import type { AShareChartSeg } from "@/pages/AShareLightChart";

const DailyReview = lazy(() =>
  import("@/pages/DailyReview").then((m) => ({ default: m.DailyReview })),
);
const AShareLightChart = lazy(() =>
  import("@/pages/AShareLightChart").then((m) => ({ default: m.AShareLightChart })),
);

function parseOverlay(raw: string | null): AShareChartSeg | null {
  if (raw === "detail" || raw === "feed") return raw;
  return null;
}

export function AShare() {
  const [params, setParams] = useSearchParams();
  const overlay = parseOverlay(params.get("tab"));

  useEffect(() => {
    void import("@/pages/FinWindow");
  }, []);

  useEffect(() => {
    const raw = params.get("tab");
    if (raw === "kline" || raw === "chart" || raw === "stock") {
      const p = new URLSearchParams(params);
      p.delete("tab");
      setParams(p, { replace: true });
    }
  }, [params, setParams]);

  const switchSeg = (next: AShareChartSeg) => {
    const p = new URLSearchParams(params);
    if (next === "kline") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  };

  if (overlay) {
    return (
      <Suspense fallback={<PageFallback />}>
        <AShareLightChart seg={overlay} onSegChange={switchSeg} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <DailyReview />
    </Suspense>
  );
}
