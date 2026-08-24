import { useEffect, useState, type ReactNode } from "react";
import { BoardFlowChart } from "@/components/cockpit/BoardFlowChart";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";

const POLL_MS = 10_000;
const DURATION_MS = 12_000;
const STEP_MS = 100;

function RefreshCountdown({ resetKey, seconds }: { resetKey: number; seconds: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
  }, [resetKey, seconds]);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return <span className="font-mono text-[10px] tabular-nums text-slate-500">{left}s</span>;
}

export function BoardFlowLivePanel({
  selected,
  onSelect,
  onRight,
  curvesEnabled = true,
}: {
  selected?: { code: string; name: string } | null;
  onSelect?: (sel: { code: string; name: string } | null) => void;
  onRight?: (node: ReactNode) => void;
  curvesEnabled?: boolean;
}) {
  const { data: ranks, error, updated } = usePolling(() => api.boardFlowIntraday(20, false), POLL_MS, []);
  const { data: full } = usePolling(
    () => api.boardFlowIntraday(20, true),
    POLL_MS,
    [],
    curvesEnabled,
  );
  const data = full?.some((f) => (f.points?.length ?? 0) > 2) ? full : ranks;
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        const next = p + STEP_MS / DURATION_MS;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const label = playing ? "暂停" : progress < 1 ? "继续" : "重放";

  useEffect(() => {
    if (!onRight) return;
    onRight(
      <span className="flex items-center gap-1.5">
        <RefreshCountdown resetKey={updated} seconds={POLL_MS / 1000} />
        <button
          type="button"
          onClick={() => {
            setProgress((p) => (p >= 1 ? 0 : p));
            setPlaying((v) => !v);
          }}
          className="border border-[#333] px-1.5 py-0.5 text-[10px] text-[#aaa] hover:border-primary/50 hover:text-primary"
        >
          {label}
        </button>
      </span>,
    );
  }, [onRight, updated, label]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {data && data.length ? (
          <BoardFlowChart
            flows={data}
            progress={progress}
            selected={selected?.code ?? null}
            onSelect={onSelect}
          />
        ) : (
          <p className="py-8 text-center text-[11px] text-slate-600">
            {error ? "分钟资金流未接通, 自动重试中" : "加载中…"}
          </p>
        )}
      </div>
    </div>
  );
}
