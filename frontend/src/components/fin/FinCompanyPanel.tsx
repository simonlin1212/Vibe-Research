import { useFin } from "@/components/fin/FinContext";
import { fmtYiYuan, quarterLabel, TNUM } from "@/components/fin/utils";
import { pctColor } from "@/components/review/format";
import { SuggestHits, useSuggestSearch } from "@/hooks/useSuggestSearch";
import { cn } from "@/lib/utils";

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const yoy = sub ? Number.parseFloat(sub) : NaN;
  return (
    <div className="flex h-[32px] min-w-0 flex-col justify-between rounded bg-slate-800/40 px-1.5 py-1">
      <div className="text-[9px] leading-[10px] text-slate-500">{label}</div>
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[11px] font-semibold text-slate-200" style={TNUM}>{value}</span>
        {sub && (
          <span className={cn("shrink-0 text-[9px]", Number.isFinite(yoy) ? pctColor(yoy) : "text-slate-500")} style={TNUM}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

export function FinCompanyPanel() {
  const { company, recent, select, companyBundle: data, companyError: error } = useFin();
  const s = useSuggestSearch();
  const pick = (code: string, name: string) => {
    select(code, name);
    s.clear();
  };

  const main = data?.main;
  const r0 = main?.reports?.[0];
  const cash = main?.cash;
  const bal = main?.balance;
  const mainop = main?.mainop ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-1.5">
      <div ref={s.boxRef} className="relative shrink-0">
        <input
          value={s.q}
          onChange={(e) => s.type(e.target.value)}
          onFocus={() => s.hits.length && s.setOpen(true)}
          onKeyDown={(e) => s.onKeyDown(e, (h) => pick(h.code, h.name), (digits) => {
            const hit = s.hits.find((h) => h.code === digits || h.code.endsWith(digits));
            pick(digits, hit?.name || digits);
          })}
          placeholder="输入代码/名称"
          className="h-6 w-full rounded bg-slate-800/60 px-2 text-[11px] text-slate-200 placeholder:text-[9px] placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        {s.open && (
          <SuggestHits
            hits={s.hits}
            hi={s.hi}
            onPick={(h) => pick(h.code, h.name)}
            className="absolute left-0 right-0 top-7 z-20 overflow-hidden rounded border border-border bg-card"
          />
        )}
      </div>
      {recent.length > 0 && (
        <div className="flex h-[18px] shrink-0 flex-nowrap items-center gap-1 overflow-hidden">
          {recent.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => select(c.code, c.name)}
              className={cn(
                "shrink-0 rounded border px-1.5 text-[9px] leading-[14px]",
                c.code === company.code
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-slate-700/60 text-slate-400",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {company.code && !data && (
        <p className="py-6 text-center text-[11px] text-slate-600">{error ? "公司财报未接通" : "加载中…"}</p>
      )}
      {r0 && (
        <>
          <div className="flex shrink-0 items-center justify-between px-0.5 text-[9px] text-slate-500">
            <span>报告期 <span className="text-slate-400">{quarterLabel(r0.date) || r0.label}</span></span>
            <span>{(main?.name || company.name).slice(0, 8)}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-3 content-start gap-1">
              <Card label="营收" value={fmtYiYuan(r0.revenue)} sub={`${r0.revenue_yoy > 0 ? "+" : ""}${r0.revenue_yoy.toFixed(1)}%`} />
              <Card label="净利" value={fmtYiYuan(r0.net_profit)} sub={`${r0.profit_yoy > 0 ? "+" : ""}${r0.profit_yoy.toFixed(1)}%`} />
              <Card label="ROE" value={`${r0.roe.toFixed(1)}%`} />
              <Card label="EPS" value={r0.eps != null ? r0.eps.toFixed(2) : "—"} />
              <Card label="毛利率" value={`${r0.gross_margin.toFixed(0)}%`} />
              <Card label="净利率" value={`${r0.net_margin.toFixed(0)}%`} />
              <Card label="资产负债率" value={`${(r0.debt_ratio ?? 0).toFixed(1)}%`} />
              <Card label="ROIC" value={`${(r0.roic ?? 0).toFixed(1)}%`} />
              <Card label="每股OCF" value={(r0.ocf_ps ?? 0).toFixed(2)} />
              <Card label="经营现金流" value={fmtYiYuan(cash?.operate)} />
              <Card label="自由现金流" value={fmtYiYuan(cash?.free)} />
              <Card label="应收账款" value={fmtYiYuan(bal?.accounts_receivable)} />
            </div>
            {mainop.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-0.5 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-widest text-slate-500">
                  主营构成
                  <span className="flex items-center gap-1 text-[8px] normal-case tracking-normal text-slate-600">
                    <span className="inline-block h-[3px] w-2 rounded bg-primary/60" />收入
                    <span className="inline-block h-[3px] w-2 rounded bg-amber-500/60" />利润
                  </span>
                </div>
                {mainop.slice(0, 5).map((m) => (
                  <div key={m.name} className="flex h-[18px] items-center gap-1.5 px-0.5 text-[10px]">
                    <span className="w-[72px] shrink-0 truncate text-slate-300">{m.name}</span>
                    <span className="flex h-[8px] min-w-0 flex-1 items-center gap-[2px]">
                      <span className="h-[6px] rounded-sm bg-primary/50" style={{ width: `${Math.min(100, (m.income_ratio ?? 0) * 100)}%` }} />
                      <span className="h-[6px] rounded-sm bg-amber-500/50" style={{ width: `${Math.min(100, (m.profit_ratio ?? 0) * 100)}%` }} />
                    </span>
                    <span className="w-[52px] shrink-0 text-right text-slate-400" style={TNUM}>{fmtYiYuan(m.income)}</span>
                    <span className="hidden w-[40px] shrink-0 text-right text-[9px] text-amber-400/80 sm:block" style={TNUM}>
                      {((m.profit_ratio ?? 0) * 100).toFixed(0)}%
                    </span>
                    <span className="hidden w-[56px] shrink-0 text-right text-[9px] text-slate-500 sm:block" style={TNUM}>
                      毛利 {((m.margin ?? 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
