import { QuoteLine } from "@/components/cockpit/QuoteLine";
import { pctColor } from "@/components/review/format";
import type { MacroBoard } from "@/lib/api";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { sparkSessionForRegion } from "@/lib/sparkAxis";
import { cn } from "@/lib/utils";

const FX_CODE = "whUSDCNY";

function fmtNum(v: number | null | undefined, digits: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function FxPanel({ data, err }: { data: MacroBoard | null; err: string | null }) {
  const hub = useQuotes([FX_CODE]);
  const minutes = useMinutes([FX_CODE]);
  const q = hub[FX_CODE];
  const kl = minutes[FX_CODE];
  const closes = (kl?.bars || []).map((b) => b.close).filter((n) => Number.isFinite(n));
  const times = (kl?.bars || []).map((b) => b.datetime);
  const us = data?.us?.items ?? [];
  const us10 = us.find((it) => it.key === "us10y");
  const dxy = us.find((it) => it.key === "dxy");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-2">
      <div className="min-h-7">
        <QuoteLine
          variant="index"
          name={q?.name || "美元/人民币"}
          unit={FX_CODE}
          badge="FX"
          price={q?.price}
          pct={q?.pct}
          closes={closes}
          times={times}
          session={sparkSessionForRegion("FX")}
          prevClose={kl?.prev_close}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5">
          <p className="text-[10px] text-slate-500">美债 10Y</p>
          <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
            {us10?.value != null ? `${us10.value.toFixed(2)}%` : "—"}
          </p>
          <p className="text-[10px] text-slate-600">{us10?.date || "FRED DGS10"}</p>
        </div>
        <div className="rounded border border-slate-700/40 bg-slate-900/40 px-2 py-1.5">
          <p className="text-[10px] text-slate-500">美元指数</p>
          <p className={cn("mt-0.5 font-mono text-sm font-semibold tabular-nums", pctColor(dxy?.pct ?? 0))}>
            {fmtNum(dxy?.value, 2)}
          </p>
          <p className={cn("text-[10px] tabular-nums", pctColor(dxy?.pct ?? 0))}>
            {dxy?.pct != null ? `${dxy.pct > 0 ? "+" : ""}${dxy.pct.toFixed(2)}%` : "东财 UDI"}
          </p>
        </div>
      </div>
      {err && !us.length ? <p className="mt-2 text-[10px] text-slate-500">{err}</p> : null}
      <p className="mt-2 text-[10px] text-slate-600">
        美元人民币走报价中心 · 美债/美指不进指数目录 · 只呈现
      </p>
    </div>
  );
}
