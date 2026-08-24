import { useMemo, useState, type CSSProperties } from "react";
import { useFin } from "@/components/fin/FinContext";
import {
  AXIS, CHART_BG, CROSSHAIR, GRID, SEG_COLORS, SERIES, TOOLTIP_BG, ZERO,
  computeChart, type ChartTab,
} from "@/components/fin/chart-math";
import { fmtPct, fmtYiYuan, quarterLabel, TNUM } from "@/components/fin/utils";
import { pctColor } from "@/components/review/format";
import { useElementSize } from "@/hooks/useElementSize";
import type { FinMain, FinReportRow } from "@/lib/api";

function TrendChart({
  reports,
  tab,
  mainopHistory,
}: {
  reports: FinReportRow[];
  tab: ChartTab;
  mainopHistory: FinMain["mainop_history"];
}) {
  const { ref: boxRef, size } = useElementSize();
  const [hover, setHover] = useState(-1);
  const chart = useMemo(() => computeChart(reports, tab, mainopHistory, size), [reports, tab, mainopHistory, size]);
  if (!chart) return <div ref={boxRef} className="h-full min-h-0" />;
  const { W, H, L } = chart;
  const plotBottom = H - chart.B;
  const hovIdx = hover >= 0 ? Math.min(hover, chart.n - 1) : -1;
  const hov = hovIdx >= 0 ? chart.rows[hovIdx] : null;

  const legend: { label: string; cls: string; style?: CSSProperties }[] =
    chart.mode === "perf"
      ? [
          ...chart.segNames.map((name, i) => ({
            label: name,
            cls: "h-[7px] w-3 rounded-sm",
            style: { background: SEG_COLORS[i] },
          })),
          ...(chart.hasFallback
            ? [{ label: "全量(未披露主营)", cls: "h-[7px] w-3 rounded-sm", style: { background: "repeating-linear-gradient(45deg, #94a3b8 0 1px, #475569 1px 3px)" } }]
            : []),
          { label: "营收同比", cls: "w-4 border-t-2 border-dashed border-sky-400" },
          { label: "净利同比", cls: "w-4 border-t-2 border-rose-400" },
          { label: "合计净利", cls: "h-[6px] w-[6px] rotate-45 rounded-[1px] bg-primary" },
        ]
      : chart.mode === "quality"
        ? chart.series.map((s) => ({
            label: s.key === "roe" ? "ROE" : s.key === "gross_margin" ? "毛利率" : "净利率",
            cls: "w-4 border-t-2",
            style: { borderColor: s.color, borderStyle: s.dash ? "dashed" : "solid" },
          }))
        : [
            { label: "资产负债率", cls: "h-[7px] w-3 rounded-sm bg-amber-400/60" },
            { label: "ROIC", cls: "w-4 border-t-2 border-primary" },
            { label: "每股OCF", cls: "w-4 border-t-2 border-dashed border-emerald-400" },
          ];

  const hovLines = hov
    ? chart.mode === "perf"
      ? (() => {
          if (!("segs" in hov)) return null;
          const p = hov;
          return [
            ...(p.fallback
              ? [
                  <span key="full" className="flex items-center gap-1.5 text-slate-400" style={TNUM}>
                    <span className="inline-block h-[6px] w-2 rounded-sm" style={{ background: "repeating-linear-gradient(45deg, #94a3b8 0 1px, #475569 1px 3px)" }} />
                    全量营收 <b className="text-slate-200">{fmtYiYuan(p.fullRev ?? 0)}</b>
                    <span className="text-slate-500">全量净利 {fmtYiYuan(p.fullNet ?? 0)}</span>
                    <i className="not-italic text-[8px] text-slate-500">未披露主营构成</i>
                  </span>,
                ]
              : []),
            ...(p.fallback ? [] : p.segs.map((s, si) => (
              <span key={s.name} className="flex items-center gap-1.5 text-slate-400" style={TNUM}>
                <span className="inline-block h-[6px] w-2 rounded-sm" style={{ background: SEG_COLORS[si] }} />
                {s.name} <b className="text-slate-200">{fmtYiYuan(s.income)}</b>
                {p.yoy[si] != null && <i className={`not-italic ${pctColor(p.yoy[si]!)}`}>{fmtPct(p.yoy[si]!)}</i>}
                <span className="text-slate-500">利 {fmtYiYuan(s.profit)}</span>
              </span>
            ))),
            ...(p.fallback ? [] : [
              <span key="other" className="flex items-center gap-1.5 text-slate-400" style={TNUM}>
                <span className="inline-block h-[6px] w-2 rounded-sm" style={{ background: SEG_COLORS[SEG_COLORS.length - 1] }} />
                其他 <b className="text-slate-200">{fmtYiYuan(p.other.income)}</b>
                <span className="text-slate-500">利 {fmtYiYuan(p.other.profit)}</span>
              </span>,
            ]),
            ...(p.totalNet != null
              ? [
                  <span key="total" className="flex items-center gap-1.5 text-slate-400" style={TNUM}>
                    合计净利
                    <b className={p.totalNet >= 0 ? "text-primary" : "text-rose-400"}>{fmtYiYuan(p.totalNet)}</b>
                    {p.totalNet < 0 && <i className="not-italic text-[8px] text-slate-500">主营外亏空</i>}
                  </span>,
                ]
              : []),
          ];
        })()
      : (() => {
          if (!("roe" in hov)) return null;
          const f = hov;
          return chart.mode === "quality"
            ? [
                <span key="r" className="text-slate-400" style={TNUM}>ROE <b className="text-slate-200">{f.roe.toFixed(1)}%</b></span>,
                <span key="g" className="text-slate-400" style={TNUM}>毛利率 <b className="text-slate-200">{f.gross_margin.toFixed(1)}%</b></span>,
                <span key="n" className="text-slate-400" style={TNUM}>净利率 <b className="text-slate-200">{f.net_margin.toFixed(1)}%</b></span>,
              ]
            : [
                <span key="d" className="text-slate-400" style={TNUM}>资产负债率 <b className="text-slate-200">{(f.debt_ratio ?? 0).toFixed(1)}%</b></span>,
                <span key="r" className="text-slate-400" style={TNUM}>ROIC <b className="text-slate-200">{(f.roic ?? 0).toFixed(1)}%</b></span>,
                <span key="o" className="text-slate-400" style={TNUM}>每股OCF <b className="text-slate-200">{(f.ocf_ps ?? 0).toFixed(2)}</b></span>,
              ];
        })()
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-0.5 pb-0.5 text-[9px] text-slate-500">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-1">
            <span className={l.cls} style={l.style} />
            {l.label}
          </span>
        ))}
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1">
        <svg
          width={W}
          height={H}
          className="block"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            setHover(Math.max(0, Math.min(chart.n - 1, Math.floor((x - chart.L) / chart.slot))));
          }}
          onMouseLeave={() => setHover(-1)}
        >
          {chart.mode === "perf" && chart.hasFallback && (
            <defs>
              <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="4" fill="#475569" />
                <line x1="0" y1="0" x2="0" y2="4" stroke="#94a3b8" strokeWidth="1.5" />
              </pattern>
            </defs>
          )}
          {chart.mode === "perf"
            ? chart.ticks.map((t, i) => (
                <g key={i}>
                  <line x1={L} y1={t.y} x2={W - chart.R} y2={t.y} stroke={GRID} strokeWidth={1} />
                  <text x={L - 3} y={t.y + 3} fontSize={9} fill={CROSSHAIR} textAnchor="end" style={TNUM}>
                    {(t.m / 1e8).toFixed(0)}亿
                  </text>
                </g>
              ))
            : chart.mode === "leverage"
              ? chart.ticks.map((t, i) => (
                  <g key={i}>
                    <line x1={L} y1={t.y} x2={W - chart.R} y2={t.y} stroke={GRID} strokeWidth={1} />
                    <text x={L - 3} y={t.y + 3} fontSize={9} fill={CROSSHAIR} textAnchor="end" style={TNUM}>
                      {t.l.toFixed(0)}%
                    </text>
                    <text x={W - chart.R + 3} y={t.y + 3} fontSize={9} fill={CROSSHAIR} style={TNUM}>
                      {t.r.toFixed(1)}
                    </text>
                  </g>
                ))
              : chart.ticks.map((t, i) => (
                  <g key={i}>
                    <line x1={L} y1={t.y} x2={W - chart.R} y2={t.y} stroke={GRID} strokeWidth={1} />
                    <text x={L - 3} y={t.y + 3} fontSize={9} fill={CROSSHAIR} textAnchor="end" style={TNUM}>
                      {t.v.toFixed(0)}%
                    </text>
                  </g>
                ))}
          {(chart.mode === "perf" || chart.mode === "leverage") && (
            <line
              x1={L}
              y1={chart.mode === "perf" ? chart.zeroY : chart.zeroL}
              x2={W - chart.R}
              y2={chart.mode === "perf" ? chart.zeroY : chart.zeroL}
              stroke={ZERO}
              strokeWidth={1.5}
            />
          )}
          {chart.rows.map((r, i) =>
            i % 2 === 0 ? (
              <text key={r.date} x={chart.cx(i)} y={H - 4} fontSize={9} fill={AXIS} textAnchor="middle" style={TNUM}>
                {quarterLabel(r.date)}
              </text>
            ) : null,
          )}
          {chart.mode === "perf" ? (
            <>
              {chart.rows.map((r, i) => {
                const bw = chart.slot * 0.22;
                const revX = chart.cx(i) - bw - 2;
                const npX = chart.cx(i) + 2;
                const color = (si: number) => SEG_COLORS[Math.min(si, SEG_COLORS.length - 1)];
                const stack = (x: number, items: { name: string; v: number }[]) => {
                  let accPos = 0;
                  let accNeg = 0;
                  return items.map((it, si) => {
                    if (it.v >= 0) {
                      const y = chart.Ym(accPos + it.v);
                      const h = Math.max(chart.Ym(accPos) - y, 1);
                      accPos += it.v;
                      return <rect key={`${r.date}-${si}`} x={x} y={y} width={bw} height={h} fill={color(si)} opacity={0.85} />;
                    }
                    const y = chart.Ym(accNeg);
                    const h = Math.max(chart.Ym(accNeg + it.v) - chart.Ym(accNeg), 1);
                    accNeg += it.v;
                    return <rect key={`${r.date}-${si}`} x={x} y={y} width={bw} height={h} fill={color(si)} opacity={0.85} />;
                  });
                };
                return (
                  <g key={r.date}>
                    {stack(revX, [...r.segs.map((s) => ({ name: s.name, v: s.income })), { name: "其他", v: r.other.income }])}
                    {stack(npX, [...r.segs.map((s) => ({ name: s.name, v: s.profit })), { name: "其他", v: r.other.profit }])}
                    {r.totalNet != null && (
                      <rect
                        x={npX + bw / 2 - 2.5}
                        y={chart.Ym(r.totalNet) - 2.5}
                        width={5}
                        height={5}
                        transform={`rotate(45 ${npX + bw / 2} ${chart.Ym(r.totalNet)})`}
                        fill={r.totalNet >= 0 ? SERIES[0] : SERIES[1]}
                        stroke={CHART_BG}
                        strokeWidth={0.5}
                      />
                    )}
                    {r.fallback && (
                      <>
                        <rect x={revX} y={r.fullRev >= 0 ? chart.Ym(r.fullRev) : chart.Ym(0)} width={bw} height={Math.max(Math.abs(chart.Ym(r.fullRev) - chart.Ym(0)), 1)} fill="url(#hatch)" stroke="#94a3b8" strokeWidth={0.4} />
                        <rect x={npX} y={r.fullNet >= 0 ? chart.Ym(r.fullNet) : chart.Ym(0)} width={bw} height={Math.max(Math.abs(chart.Ym(r.fullNet) - chart.Ym(0)), 1)} fill="url(#hatch)" stroke="#94a3b8" strokeWidth={0.4} />
                      </>
                    )}
                  </g>
                );
              })}
              <path d={chart.line("revYoy")} fill="none" stroke={SERIES[2]} strokeWidth={1.2} strokeDasharray="3 2" strokeLinejoin="round" />
              <path d={chart.line("netYoy")} fill="none" stroke={SERIES[1]} strokeWidth={1.4} strokeLinejoin="round" />
              {chart.pctTicks.map((t) => (
                <text key={t.label} x={W - chart.R + 3} y={t.y + 3} fontSize={9} fill={CROSSHAIR} style={TNUM}>
                  {t.label}
                </text>
              ))}
            </>
          ) : chart.mode === "quality" ? (
            <>
              {chart.series.map((s) => (
                <polyline
                  key={s.key}
                  points={s.pts}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.4}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                />
              ))}
              {chart.labels.map((l) => (
                <g key={l.s.key}>
                  <line x1={W - chart.R - 4} y1={l.s.lastY} x2={W - chart.R + 2} y2={l.labelY} stroke={l.s.color} strokeWidth={0.6} strokeOpacity={0.5} />
                  <text x={W - chart.R + 4} y={l.labelY + 3} fontSize={10} fill={l.s.color} style={TNUM}>
                    {l.s.name} {l.s.lastV.toFixed(1)}
                  </text>
                </g>
              ))}
            </>
          ) : null}
          {chart.mode === "leverage" && (
            <>
              {chart.debtBars.map((b, i) => {
                const top = Math.min(b.y, chart.zeroL);
                const h = Math.max(Math.abs(chart.zeroL - b.y), b.v > 0 ? 1 : 0);
                return (
                  <rect key={`debt-${i}`} x={b.x} y={top} width={b.w} height={h} rx={1} fill={SERIES[4]} opacity={0.55} />
                );
              })}
              <polyline points={chart.roicLine} fill="none" stroke={SERIES[0]} strokeWidth={1.4} strokeLinejoin="round" />
              <polyline points={chart.ocfLine} fill="none" stroke={SERIES[3]} strokeWidth={1.2} strokeDasharray="3 2" strokeLinejoin="round" />
              {(() => {
                const last = chart.rows[chart.n - 1];
                const roicY = chart.Yl(last.roic ?? 0);
                const ocfY = chart.Yl(last.ocf_ps ?? 0);
                return (
                  <>
                    <text x={W - chart.R + 4} y={roicY + 3} fontSize={9} fill={SERIES[0]} style={TNUM}>
                      ROIC {(last.roic ?? 0).toFixed(1)}%
                    </text>
                    <text x={W - chart.R + 4} y={ocfY + 3} fontSize={9} fill={SERIES[3]} style={TNUM}>
                      OCF {(last.ocf_ps ?? 0).toFixed(2)}
                    </text>
                  </>
                );
              })()}
            </>
          )}
          <line x1={L} y1={plotBottom} x2={W - chart.R} y2={plotBottom} stroke={GRID} strokeWidth={1} />
          {hovIdx >= 0 && (
            <line x1={chart.cx(hovIdx)} y1={chart.T} x2={chart.cx(hovIdx)} y2={plotBottom} stroke={AXIS} strokeWidth={1} strokeDasharray="3 3" />
          )}
        </svg>
        {hov && hovLines && (
          <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 rounded border border-slate-700/60 px-2 py-1 text-[9px] leading-4 shadow" style={{ background: `${TOOLTIP_BG}F2` }}>
            <div className="font-semibold text-slate-200">{quarterLabel(hov.date)}</div>
            <div className={chart.mode === "perf" ? "flex flex-col gap-0.5" : "flex items-center gap-2"}>{hovLines}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FinTrendPanel() {
  const { company, companyBundle: data, companyError: error, trendTab } = useFin();
  const reports = data?.main?.reports ?? [];

  if (!company.code) {
    return (
      <div className="relative h-full p-3">
        <div className="flex h-full items-end gap-2 opacity-40">
          {[40, 55, 38, 62, 48, 70, 58, 76, 66, 82, 74, 90].map((h, i) => (
            <div key={i} className="flex-1 rounded-sm bg-slate-700/50" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-600">
          先在左侧选择公司
        </div>
      </div>
    );
  }
  if (!data) {
    return <p className="py-8 text-center text-[11px] text-slate-600">{error ? "趋势未接通" : "加载中…"}</p>;
  }
  if (reports.length === 0) {
    return <p className="py-8 text-center text-[11px] text-slate-600">暂无财报数据</p>;
  }
  return <TrendChart reports={reports} mainopHistory={data.main.mainop_history} tab={trendTab} />;
}
