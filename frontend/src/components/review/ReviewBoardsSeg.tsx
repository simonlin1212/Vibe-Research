import { KlineLink } from "@/components/cockpit/QuoteLine";
import { PctChip } from "@/components/review/PctChip";
import { fmt, pctColor } from "@/components/review/format";
import { reviewPending } from "@/components/review/reviewPending";
import type { DailyDragonTiger } from "@/lib/api";
import { cn } from "@/lib/utils";

const box = "overflow-hidden rounded-md border border-border/60 bg-card/80";

interface Props {
  lhb: DailyDragonTiger | null;
  lhbDone: boolean;
}

export function ReviewBoardsSeg({ lhb, lhbDone }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] text-slate-500">
          {lhb?.date ? `${lhb.date} · ${lhb.total_records} 条 · 按席位净买额` : (lhbDone ? "暂无" : "加载中…")}
        </span>
      </div>
      <div className={box}>
        {!lhb || lhb.stocks.length === 0 ? (
          <div className="p-5">{reviewPending(lhbDone)}</div>
        ) : (
          <div className="overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {["#", "名称", "涨跌%", "净买(万)", "买入(万)", "卖出(万)", "换手%", "上榜原因"].map((h) => (
                    <th key={h} className={h !== "名称" && h !== "上榜原因" ? "num" : ""}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lhb.stocks.map((s, i) => (
                  <tr key={`${s.code}-${s.reason}-${i}`}>
                    <td className="num text-muted-foreground/50">{i + 1}</td>
                    <td>
                      <KlineLink code={s.code} className="hover:text-primary">
                        <span className="font-medium">{s.name}</span>{" "}
                        <span className="text-slate-500">{s.code}</span>
                      </KlineLink>
                    </td>
                    <td className="num"><PctChip pct={s.change_pct} /></td>
                    <td className={cn("num font-mono", pctColor(s.net_buy_wan))}>
                      {s.net_buy_wan > 0 ? "+" : ""}{fmt(s.net_buy_wan)}
                    </td>
                    <td className="num text-muted-foreground">{fmt(s.buy_wan)}</td>
                    <td className="num text-muted-foreground">{fmt(s.sell_wan)}</td>
                    <td className="num text-muted-foreground">{s.turnover_pct}</td>
                    <td className="max-w-[220px] truncate text-muted-foreground" title={s.reason}>
                      {s.reason || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
