import { useEffect, useState } from "react";
import { api, type BacktestProgress } from "@/lib/api";

export function useBacktestJob(active: boolean) {
  const [job, setJob] = useState<BacktestProgress | null>(null);

  useEffect(() => {
    if (!active) {
      setJob(null);
      return;
    }
    let stop = false;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void api.backtestProgress().then((row) => {
        if (!stop) setJob(row);
      }).catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, 400);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active]);

  return job;
}

export function jobText(job: BacktestProgress | null, fallback: string) {
  if (!job || job.state === "idle") return fallback;
  if (job.state === "done") return "收尾…";
  const frac = job.total > 0 ? ` ${job.done}/${job.total}` : "";
  const cur = job.current ? ` · ${job.current}` : "";
  return `${job.label || job.step || fallback}${frac}${cur}`;
}

export function jobPct(job: BacktestProgress | null) {
  if (!job || job.total <= 0) return 0;
  return Math.min(100, Math.round((job.done / job.total) * 100));
}
