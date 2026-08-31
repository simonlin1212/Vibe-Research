import { lazy, Suspense } from "react";

const Body = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ]);
  return {
    default: function MdBody({ children }: { children: string }) {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
    },
  };
});

/** Markdown for AI replies. Loaded when a reply is shown, not on first paint. */
export function Md({ children }: { children: string }) {
  return (
    <Suspense fallback={null}>
      <Body>{children}</Body>
    </Suspense>
  );
}
