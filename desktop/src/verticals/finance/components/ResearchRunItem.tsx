import type { RunListItem, ResearchStatus } from "../lib/backend";

const STATUS: Record<string, string> = {
  complete: "完成", failed: "失败", incomplete: "资料不完整", stale: "资料过期",
  running: "进行中", cancelled: "已取消", cancelling: "正在取消", finalizing: "归档收尾中", pending: "待跑",
};

export function ResearchRunItem({ run, onOpen }: { run: RunListItem; onOpen: (id: string) => void }) {
  const date = run.started_at ? new Date(run.started_at) : null;
  const validDate = date && Number.isFinite(date.getTime());
  return (
    <button type="button" onClick={() => onOpen(run.run_id)} title={`运行标识：${run.run_id}`}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-b border-border/30 px-1 py-2.5 text-left text-sm last:border-0 hover:bg-muted/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <span className="font-medium">{run.name ?? "个股"}</span>
      <span className="font-mono text-xs text-muted-foreground">{run.symbol ?? "—"}</span>
      <span className="rounded bg-muted/50 px-2 py-0.5 text-xs">{STATUS[run.status ?? ""] ?? "状态未知"}</span>
      <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">
        {validDate ? <>开始 <time dateTime={run.started_at!} title={run.started_at!}>{date.toLocaleString("zh-CN", { hour12: false })}</time></> : "时间未记录"}
      </span>
    </button>
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
