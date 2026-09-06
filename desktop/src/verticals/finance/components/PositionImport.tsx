import { useEffect, useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { backend } from "@/lib/backend";
import { encodeImportFiles, positionValues, type ImportResult, type PositionValues } from "@/lib/importPositions";
import { GlassCard } from "@/components/ui/GlassCard";

export function PositionImport({ onFill, existingCodes }: { onFill: (values: PositionValues) => void; existingCodes: readonly string[] }) {
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewed, setReviewed] = useState<Record<number, boolean>>({});
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  const transcribe = async () => {
    if (active.current) return;
    const ac = new AbortController(); active.current = ac;
    setBusy(true); setError(""); setResult(null); setNotice(""); setReviewed({});
    try {
      const encoded = await encodeImportFiles(files, ac.signal);
      const next = await backend.importPositions(encoded, ac.signal);
      if (active.current === ac && !ac.signal.aborted) setResult(next);
    } catch (e) {
      if (active.current === ac && !ac.signal.aborted) setError(e instanceof Error ? e.message : "转写失败，请重试。");
    } finally {
      if (active.current === ac) { active.current = null; setBusy(false); }
    }
  };
  const cancel = () => {
    active.current?.abort(); active.current = null; setBusy(false);
    setNotice("已停止等待并请求中止转写；没有写入持仓。后台确认停止前，重新开始可能提示任务仍忙。");
  };
  const fill = (index: number) => {
    if (!result || !reviewed[index]) return;
    try {
      const values = positionValues(result.drafts[index]!.fields);
      if (existingCodes.includes(values.symbol)) throw new Error("该代码已有持仓。截图可能是总持仓，不能直接叠加；请先核对现有记录，再手动调整。");
      onFill(values);
      setError(""); setNotice("草稿已带入下方「添加持仓」表单。填入本身不会保存，点击「添加」才会写入；最终记录以「持仓明细」为准。");
    } catch (e) { setError(e instanceof Error ? e.message : "草稿无效，请手动录入。"); }
  };

  return <GlassCard className="mb-4">
    <h3 className="text-sm font-semibold">截图／表格导入</h3>
    <p className="mt-1 text-xs text-muted-foreground">沿用已连接的 AI。文件内容会交给所选模型转写，仅生成草稿；不会自动写入或覆盖持仓。</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <label className="min-w-0 flex-1 text-xs">选择截图或文本表格
        <input aria-label="选择持仓导入文件" type="file" multiple disabled={busy}
          accept=".png,.jpg,.jpeg,.webp,.gif,.csv,.tsv,.txt,.md,.json"
          onChange={e => { setFiles(Array.from(e.target.files ?? [])); setResult(null); setError(""); setNotice(""); }}
          className="mt-1 block w-full min-w-0 rounded border border-border p-2 text-xs" />
      </label>
      <button type="button" disabled={busy || !files.length} onClick={transcribe}
        className="inline-flex items-center gap-2 rounded-lg bg-primary/15 px-4 py-2 text-sm text-primary disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {busy ? "正在转写" : "生成核对草稿"}
      </button>
      {busy && <button type="button" onClick={cancel} className="rounded border border-border px-3 py-2 text-sm">取消转写</button>}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">每批最多 10 份，单份 8 MB、合计 20 MB。Excel 请先导出为 CSV；PDF 资料归档请使用「我的研报」。</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {result && <div className="mt-4 space-y-3" aria-live="polite">
      {result.warnings.map((w, i) => <p key={i} className="text-sm text-muted-foreground">转写提示：{w}</p>)}
      {!result.drafts.length && <p className="text-sm">没有可用草稿。请换一份清晰文件，或在下方手动填写。</p>}
      {result.drafts.map((draft, i) => <div key={`${result.batch}-${i}`} className="rounded-lg border border-border p-3">
        <p className="break-all text-xs text-muted-foreground">草稿 {i + 1} · 来源：{draft.source_file}</p>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {[["symbol", "代码"], ["shares", "数量"], ["cost", "成本"]].map(([key, label]) => <div key={key}>
            <dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all font-mono">{draft.fields[key!] == null ? "未识别" : String(draft.fields[key!])}</dd>
          </div>)}
        </dl>
        {draft.uncertain.length > 0 && <p className="mt-2 text-sm">待核对：{draft.uncertain.join("；")}</p>}
        {draft.missing_required.length > 0 && <p className="mt-2 text-sm">缺少必填项：{draft.missing_required.join("、")}。请在下方手动补齐。</p>}
        <p className="mt-2 text-xs text-muted-foreground">只带入代码、数量、成本；名称、账户、日期、备注不会从草稿写入。</p>
        <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={!!reviewed[i]}
          onChange={e => setReviewed(old => ({ ...old, [i]: e.target.checked }))} />已对照原文件核对这三个值</label>
        <button type="button" disabled={!reviewed[i] || !!draft.missing_required.length}
          onClick={() => fill(i)} className="mt-2 rounded border border-border px-3 py-2 text-sm disabled:opacity-50">填入下方表单（尚不保存）</button>
      </div>)}
    </div>}
  </GlassCard>;
}
