import type { RunListItem, ResearchStatus } from "../lib/backend";
import { Loader2, Trash2 } from "lucide-react";

const STATUS: Record<string, string> = {
  complete: "完成", failed: "失败", incomplete: "资料不完整", unvalidated: "未通过校验", stale: "资料过期",
  running: "进行中", cancelled: "已取消", cancelling: "正在取消", finalizing: "归档收尾中", pending: "待跑",
};

export function ResearchRunItem({ run, onOpen, onDelete, deleting }: {
  run: RunListItem; onOpen: (id: string) => void;
  onDelete?: (id: string) => void; deleting?: boolean;
}) {
  const date = run.started_at ? new Date(run.started_at) : null;
  const validDate = date && Number.isFinite(date.getTime());
  const running = run.status === "running";
  return (
    <div className="group relative flex w-full items-center rounded-md border-b border-border/30 last:border-0 hover:bg-muted/30">
      <button type="button" onClick={() => onOpen(run.run_id)} title={`运行标识：${run.run_id}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 pr-9 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="font-medium">{run.name ?? "个股"}</span>
        <span className="font-mono text-xs text-muted-foreground">{run.symbol ?? "—"}</span>
        <span className="rounded bg-muted/50 px-2 py-0.5 text-xs">{STATUS[run.status ?? ""] ?? "状态未知"}</span>
        <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">
          {validDate ? <>开始 <time dateTime={run.started_at!} title={run.started_at!}>{date.toLocaleString("zh-CN", { hour12: false })}</time></> : "时间未记录"}
        </span>
      </button>
      {onDelete && (
        <button type="button" onClick={() => onDelete(run.run_id)}
          disabled={running || deleting}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 focus-visible:opacity-100"
          title={running ? "研究进行中,跑完才能删" : "删除这次研究归档"} aria-label="删除">
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}

export function ResearchFailureNotice({ failure }: { failure: NonNullable<ResearchStatus["failure"]> }) {
  return <div role="status" className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
    <p className="font-medium">{failure.message}</p>
    <p className="mt-1 text-muted-foreground">{failure.action}</p>
    <p className="mt-1 text-xs text-muted-foreground">已落盘资料保留在本次运行中；重新发起会建立新运行，不是从断点续跑。</p>
    <a href="/settings" className="mt-2 inline-block text-primary underline underline-offset-4">检查 AI 接入设置</a>
  </div>;
}
