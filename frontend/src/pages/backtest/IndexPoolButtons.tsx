import { useState } from "react";
import { api, ApiError, type BacktestIndexPoolDef } from "@/lib/api";

export const FALLBACK_INDEX_POOLS: BacktestIndexPoolDef[] = [
  { id: "sh000300", label: "沪深300" },
  { id: "sh000905", label: "中证500" },
  { id: "sh000688", label: "科创50" },
  { id: "sz399006", label: "创业板指" },
];

export function IndexPoolButtons({
  pools,
  cap,
  onFill,
  onError,
}: {
  pools: BacktestIndexPoolDef[];
  cap: number;
  onFill: (codes: string, note: string, indexId: string) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState("");
  return (
    <span className="flex flex-wrap gap-2">
      {pools.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={!!busy}
          className="text-primary hover:text-primary disabled:opacity-50"
          onClick={() => {
            setBusy(p.id);
            void api.backtestIndexPool(p.id, false, true).then((row) => {
              const got = (row.codes || []).slice(0, cap);
              if (!got.length) {
                onError(row.note || `${p.label} 成分没取到`);
                return;
              }
              const head = row.n > cap
                ? `${row.label} 最新 ${row.n} 只, 已填前 ${cap} (上限). `
                : `${row.label} ${got.length} 只 (${row.asof}). `;
              onFill(got.join(" "), head + (row.note || ""), p.id);
            }).catch((e) => {
              onError(e instanceof ApiError ? e.message : `${p.label} 没取到`);
            }).finally(() => setBusy(""));
          }}
        >
          {busy === p.id ? "…" : p.label}
        </button>
      ))}
    </span>
  );
}
