import type { backend } from "../lib/backend";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useId, useMemo, useRef } from "react";
import type { Components } from "react-markdown";
import { appendixIds, citationPlugin } from "../lib/reportCitations";

// Do not execute HTML or load remote images from untrusted report text.
const markdownComponents = {
  img: ({ alt }: { alt?: string }) => <span className="text-muted-foreground">[图片未加载：{alt || "报告图片"}]</span>,
};

export function ResearchReport({ result }: { result: Awaited<ReturnType<typeof backend.report>> }) {
  const prefix = `reference-${useId()}-${encodeURIComponent(result.run_id)}-`;
  const panel = useRef<HTMLDetailsElement>(null);
  const ids = useMemo(() => appendixIds(result.appendix ?? ""), [result.appendix]);
  const components: Components = {
    ...markdownComponents,
    a: ({ node: _node, href, children, ...props }) => <a {...props} href={href} onClick={event => {
      if (!href?.startsWith(`#${prefix}`)) return;
      const target = [...(panel.current?.querySelectorAll<HTMLElement>("[id]") ?? [])]
        .find(element => `#${element.id}` === href);
      if (!target || !panel.current) return;
      event.preventDefault();
      panel.current.open = true;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }}>{children}</a>,
  };
  if (result.availability === "missing") return <p className="text-sm text-muted-foreground">这次运行尚无报告文件，请查看上方运行状态。</p>;
  if (result.availability !== "ready" || result.report === null) return <p role="status" className="text-sm text-muted-foreground">报告尚未通过最终校验，正文暂不可用。本地草稿保留供排查；研究结束后可从归档重新打开。</p>;
  return <>
    {result.run_status === "incomplete" && <p role="status" className="mb-2 text-sm text-muted-foreground">这份报告资料不完整，请先查看报告中的数据缺口。</p>}
    <div className={result.appendix ? "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,.65fr)]" : "min-w-0"}>
      <article className="research-paper rounded border border-border" aria-label="已校验研究报告">
        <p className="workspace-kicker mb-6 border-b border-border pb-4">Vibe Research / Research Note</p>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm, citationPlugin(ids, prefix)]} components={components}>{result.report}</ReactMarkdown>
        </div>
      </article>
      {result.appendix && <details ref={panel} className="research-evidence rounded" open>
        <summary className="cursor-pointer text-sm font-semibold">证据附录</summary>
        <p className="mb-4 mt-2 text-xs leading-6 text-muted-foreground">点击正文引用可定位到同一次运行的证据或计算记录；计算的输入引用也可继续追溯。没有对应记录的编号保留为普通文字，不推断缺失出处。</p>
        <div className="prose prose-sm dark:prose-invert max-h-[70vh] max-w-none overflow-auto break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm, citationPlugin(ids, prefix, true)]} components={components}>{result.appendix}</ReactMarkdown>
        </div>
      </details>}
    </div>
  </>;
}
