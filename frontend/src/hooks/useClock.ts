import { useEffect, useState } from "react";

/** Tick the current time every `ms` (default 1s). Hidden tab pauses. */
export function useClock(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const beat = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNow(new Date());
    };
    const t = window.setInterval(beat, ms);
    const onVis = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ms]);
  return now;
}
