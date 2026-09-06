import { useEffect, useRef } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";

/** Router-level recovery, separate from form errors and startup connection checks. */
export function RouteErrorPage() {
  const error = useRouteError();
  const heading = useRef<HTMLHeadingElement>(null);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <section role="alert" aria-labelledby="route-error-title" className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <AlertTriangle aria-hidden="true" className="mb-4 h-8 w-8 text-primary" />
        <h1 id="route-error-title" ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
          {notFound ? "没有找到这个页面" : "这个页面暂时无法显示"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {notFound ? "链接可能已经更改，可以返回首页继续使用。" : "页面遇到了异常，可以先重新加载；如果仍然出错，请返回首页。"}
        </p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          刷新或返回首页不会清空本机配置或已保存记录。尚未保存的输入可能丢失；运行中的研究请恢复后到研究页查看。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <RefreshCw aria-hidden="true" className="h-4 w-4" />重新加载页面
          </button>
          <a href="/" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">返回首页</a>
        </div>
      </section>
    </main>
  );
}
