import { createPortal } from "react-dom";

/** Dark hover card, portaled so the left T pane does not clip it. */
export function IvHtmlTip({
  html,
  hostRef,
  pt,
}: {
  html: string | null;
  hostRef: { current: HTMLElement | null };
  pt: { x: number; y: number } | null;
}) {
  const host = hostRef.current;
  if (!html || !host || !pt || typeof document === "undefined") return null;
  const r = host.getBoundingClientRect();
  let left = r.left + pt.x + 14;
  let top = r.top + pt.y + 10;
  if (left + 240 > window.innerWidth - 8) left = r.left + pt.x - 250;
  if (top + 200 > window.innerHeight - 8) top = Math.max(8, r.top + pt.y - 170);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[80] border border-[#2a2a2a] bg-black px-2 py-1 font-mono text-[11px] text-slate-200"
      style={{ left, top }}
      dangerouslySetInnerHTML={{ __html: html }}
    />,
    document.body,
  );
}
