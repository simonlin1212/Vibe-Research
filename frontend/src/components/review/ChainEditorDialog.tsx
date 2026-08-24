import { useEffect } from "react";
import { createPortal } from "react-dom";

export type ChainEditorState = { mode: "add" | "update"; name: string; content: string };
export type ChainParseState = { loading: boolean; error: string; warnings: string[] };

const PLACEHOLDER =
  "粘贴问财结论, 或点「从问财获取」\n\n格式示例:\n固态电池产业链\n\n上游 · 材料:\n天齐锂业（002466）、赣锋锂业（002460）\n\n中游 · 电池:\n宁德时代（300750）、亿纬锂能（300014）\n\n下游 · 整车:\n比亚迪（002594）";

/** Add / update chain from pasted 问财 text. Esc closes. */
export function ChainEditorDialog({
  editor,
  parseState,
  onChange,
  onClose,
  onAutoFetch,
  onSubmit,
}: {
  editor: ChainEditorState;
  parseState: ChainParseState;
  onChange: (e: ChainEditorState) => void;
  onClose: () => void;
  onAutoFetch: () => void;
  onSubmit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-[640px] max-w-[96vw] flex-col border border-[#2a2a2a] bg-black">
        <div className="flex items-center justify-between border-b border-slate-700/45 px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold text-slate-100">
              {editor.mode === "add" ? "添加自定义产业链" : "更新产业链股票"}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              粘贴问财结论, 或点「从问财获取」。名单只存本机, 客观呈现不附推荐。
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[13px] text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-slate-300">产业链名称</span>
            <input
              value={editor.name}
              onChange={(e) => onChange({ ...editor, name: e.target.value })}
              readOnly={editor.mode === "update"}
              placeholder="例如: 固态电池"
              className="h-8 w-full rounded border border-slate-700 bg-slate-950/80 px-3 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-primary/70"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onAutoFetch}
              disabled={parseState.loading}
              className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {parseState.loading ? "查询中..." : "从问财获取"}
            </button>
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-slate-300">问财结论 / 股票名单</span>
            <textarea
              value={editor.content}
              onChange={(e) => onChange({ ...editor, content: e.target.value })}
              placeholder={PLACEHOLDER}
              className="h-[220px] w-full resize-none rounded border border-slate-700 bg-slate-950/80 px-3 py-2 text-[12px] leading-6 text-slate-200 outline-none placeholder:text-slate-600 focus:border-primary/70"
            />
          </label>
          {parseState.error && (
            <div className="rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
              {parseState.error}
            </div>
          )}
          {parseState.warnings.map((w) => (
            <div key={w} className="rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              {w}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-700/45 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={parseState.loading}
            className="rounded border border-primary/50 bg-primary/15 px-3 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary/25 disabled:opacity-50"
          >
            {parseState.loading ? "处理中..." : editor.mode === "add" ? "创建并保存" : "整理并保存"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
