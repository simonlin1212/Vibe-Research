import { useFin } from "@/components/fin/FinContext";

/** Shared report-period pills. Same as marketingdashboard PeriodTabs. */
export function PeriodTabs() {
  const { period, setPeriod, periods } = useFin();
  return (
    <div className="flex items-center gap-1 text-[10px]">
      {periods.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => setPeriod(p.value)}
          className={`flex h-[22px] items-center rounded px-2 ${
            period === p.value ? "bg-primary/20 text-primary" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
