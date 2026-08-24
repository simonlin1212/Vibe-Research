import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

/** Shown when a lazy page chunk fails or a route render throws. Keeps the header. */
export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err)
    ? `${err.status} ${err.statusText}`.trim()
    : err instanceof Error
      ? err.message
      : "页面加载失败";

  return (
    <div className="m-4 flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <p>{msg || "页面加载失败"}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[12px] text-primary"
        >
          刷新重试
        </button>
        <Link
          to="/a-share"
          className="rounded border border-slate-700/60 px-2 py-1 text-[12px] text-slate-300"
        >
          回 A股
        </Link>
      </div>
    </div>
  );
}
