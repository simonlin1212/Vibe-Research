import { memo, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { Panel, type PanelZoomProps } from "@/components/cockpit/Panel";
import { useAsyncPoll } from "@/hooks/useAiWatch";
import { api } from "@/lib/api";
import { seriesPath } from "./infra-chart-math";

const fmtM = (v: number) => (v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v >= 100 ? `${Math.round(v)}` : v >= 1 ? `${v.toFixed(1)}` : v.toFixed(3));

export const InfraRoiPanel = memo(function InfraRoiPanel({ className, panelId, isZoomed, onToggleZoom }: PanelZoomProps & { className?: string }) {
  const { data, error, loading, retry } = useAsyncPoll(() => api.aiInfra(), 86_400_000);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 400, h: 240 });
  const [hover, setHover] = useState<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const observe = (el: HTMLDivElement | null) => {
    if (!el) return;
    if (ro.current) ro.current.disconnect();
    ro.current = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      if (r.width > 60 && r.height > 60) setSize({ w: r.width, h: r.height });
    });
    ro.current.observe(el);
  };

  const chart = useMemo(() => {
    if (!data?.series?.length || size.w < 120 || size.h < 60) return null;
    const pts = data.series;
    const n = pts.length;
    const leftVals = pts.flatMap((p) => [p.costPerM, p.pricePerM]).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
    const leftLo = Math.min(...leftVals) * 0.5;
    const leftHi = Math.max(...leftVals) * 1.2;
    const roiVals = pts.map((p) => p.roiPct);
    const rightLo = Math.min(-90, Math.min(...roiVals) * 1.1);
    const rightHi = Math.max(10, Math.min(100, Math.max(...roiVals) * 1.1));
    const PL = 40, PR = 44, PT = 8, PB = 22;
    const iw = size.w - PL - PR;
    const ih = size.h - PT - PB;
    const X = (i: number) => PL + (i / Math.max(n - 1, 1)) * iw;
    const lY = (v: number) => PT + ih - ((Math.log(Math.max(v, leftLo)) - Math.log(leftLo)) / (Math.log(leftHi) - Math.log(leftLo))) * ih;
    const rY = (v: number) => {
      const raw = PT + ih - ((v - rightLo) / (rightHi - rightLo)) * ih;
      return Math.max(PT - 1, Math.min(PT + ih + 1, raw));
    };
    const lTicks: number[] = [];
    for (let m = 0.001; m <= leftHi * 1.1; m *= 10) {
      for (const s of [1, 2, 5]) {
        const v = m * s;
        if (v >= leftLo && v <= leftHi) lTicks.push(v);
      }
    }
    const rTicks: number[] = [];
    for (let i = 0; i <= 4; i++) rTicks.push(+(rightLo + ((rightHi - rightLo) / 4) * i).toFixed(1));
    const costPath = seriesPath(pts, "costPerM", X, lY);
    const pricePath = seriesPath(pts, "pricePerM", X, lY);
    const roiPath = seriesPath(pts, "roiPct", X, rY);
    const capVals = pts.map((p) => p.capexB);
    const capLo = Math.min(...capVals) * 0.9;
    const capHi = Math.max(...capVals) * 1.05;
    const capY = (v: number) => PT + ih - ((v - capLo) / (capHi - capLo)) * ih;
    const gridVals = pts.map((p) => p.grid);
    const gridLo = Math.min(...gridVals) * 0.9;
    const gridHi = Math.max(...gridVals) * 1.05;
    const gridY = (v: number) => PT + ih - ((v - gridLo) / (gridHi - gridLo)) * ih;
    const capexPath = seriesPath(pts, "capexB", X, capY);
    const gridPath = seriesPath(pts, "grid", X, gridY);
    const xLabels: { label: string; x: number }[] = [];
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 8))) xLabels.push({ label: String(pts[i].year), x: X(i) });
    return { pts, PL, PR, PT, PB, X, lY, rY, lTicks, rTicks, costPath, pricePath, roiPath, capexPath, gridPath, xLabels };
  }, [data, size]);

  if (loading) {
    return (
      <Panel title="AI 基础设施资本出清与复合 ROI" icon={<Activity size={14} />} className={className} panelId={panelId} isZoomed={isZoomed} onToggleZoom={onToggleZoom}>
        <div className="flex h-full items-center justify-center text-[11px] text-slate-600">加载中…</div>
      </Panel>
    );
  }
  if (error) {
    return (
      <Panel title="AI 基础设施资本出清与复合 ROI" icon={<Activity size={14} />} className={className} panelId={panelId} isZoomed={isZoomed} onToggleZoom={onToggleZoom}>
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-red-400">
          <span>数据异常: {error}</span>
          <button type="button" onClick={retry} className="rounded border border-slate-600 px-2 py-0.5 text-slate-300">重试</button>
        </div>
      </Panel>
    );
  }

  const last = chart ? chart.pts[chart.pts.length - 1] : null;

  return (
    <Panel title="AI 基础设施资本出清与复合 ROI" icon={<Activity size={14} />} className={className} panelId={panelId} isZoomed={isZoomed} onToggleZoom={onToggleZoom}>
      <div className="flex h-full flex-col p-2 pt-1">
        <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 pb-1 text-[9px]">
          <span className="flex items-center gap-1"><span className="inline-block h-[3px] w-3.5 rounded bg-[#ffcc00]" />售价</span>
          <span className="flex items-center gap-1"><span className="inline-block h-[3px] w-3.5 rounded bg-[#fb7185]" />生产成本</span>
          <span className="flex items-center gap-1"><span className="inline-block h-[3px] w-3.5 rounded bg-[#a78bfa]" />AI专项ROI</span>
          <span className="flex items-center gap-1"><span className="inline-block h-[3px] w-3.5 rounded bg-[#fbbf24]" />CapEx</span>
          <span className="flex items-center gap-1"><span className="inline-block h-[3px] w-3.5 rounded bg-[#34d399]" />电网</span>
          <span className="ml-auto text-slate-600">历史 2022-2026 · 预测 2027-2035</span>
        </div>
        <div ref={observe} className="relative min-h-0 flex-1">
          {chart && (
            <svg
              ref={svgRef}
              width={size.w}
              height={size.h}
              className="block"
              style={{ overflow: "visible" }}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const rect = svgRef.current?.getBoundingClientRect();
                if (!rect) return;
                const n = chart.pts.length;
                const i = Math.round(((e.clientX - rect.left - chart.PL) / (size.w - chart.PL - chart.PR)) * (n - 1));
                setHover(i >= 0 && i < n ? i : null);
              }}
            >
              {chart.lTicks.map((t) => <line key={`l${t}`} x1={chart.PL} y1={chart.lY(t)} x2={size.w - chart.PR} y2={chart.lY(t)} stroke="#1e293b" strokeWidth={0.5} />)}
              <line x1={chart.X(4.5)} y1={chart.PT} x2={chart.X(4.5)} y2={size.h - chart.PB} stroke="rgba(251,191,36,0.35)" strokeWidth={0.8} strokeDasharray="4 3" />
              <text x={chart.X(5)} y={chart.PT + 7} fill="#fbbf24" fontSize={8} fontFamily="monospace" opacity={0.7}>预测→</text>
              {hover != null && <line x1={chart.X(hover)} y1={chart.PT} x2={chart.X(hover)} y2={size.h - chart.PB} stroke="rgba(148,163,184,0.5)" strokeWidth={0.8} />}
              <path d={chart.costPath.forecast} fill="none" stroke="#fb7185" strokeWidth={1.4} strokeDasharray="4 3" opacity={0.8} />
              <path d={chart.pricePath.forecast} fill="none" stroke="#ffcc00" strokeWidth={1.4} strokeDasharray="4 3" opacity={0.8} />
              <path d={chart.roiPath.forecast} fill="none" stroke="#a78bfa" strokeWidth={1.2} strokeDasharray="4 3" opacity={0.8} />
              <path d={chart.capexPath.forecast} fill="none" stroke="#fbbf24" strokeWidth={1.1} strokeDasharray="4 3" opacity={0.8} />
              <path d={chart.gridPath.forecast} fill="none" stroke="#34d399" strokeWidth={1.1} strokeDasharray="4 3" opacity={0.8} />
              <path d={chart.costPath.actual} fill="none" stroke="#fb7185" strokeWidth={1.6} />
              <path d={chart.pricePath.actual} fill="none" stroke="#ffcc00" strokeWidth={1.6} />
              <path d={chart.roiPath.actual} fill="none" stroke="#a78bfa" strokeWidth={1.4} />
              <path d={chart.capexPath.actual} fill="none" stroke="#fbbf24" strokeWidth={1.3} />
              <path d={chart.gridPath.actual} fill="none" stroke="#34d399" strokeWidth={1.3} />
              <path d={chart.costPath.bridge} fill="none" stroke="#fb7185" strokeWidth={1.2} strokeDasharray="2 2" />
              <path d={chart.pricePath.bridge} fill="none" stroke="#ffcc00" strokeWidth={1.2} strokeDasharray="2 2" />
              <path d={chart.roiPath.bridge} fill="none" stroke="#a78bfa" strokeWidth={1.1} strokeDasharray="2 2" />
              {chart.lTicks.map((t) => <text key={`lt${t}`} x={chart.PL - 4} y={chart.lY(t) + 3} textAnchor="end" fill="#64748b" fontSize={8} fontFamily="monospace">{fmtM(t)}</text>)}
              {chart.rTicks.map((t) => <text key={`rt${t}`} x={size.w - chart.PR + 4} y={chart.rY(t) + 3} textAnchor="start" fill="#475569" fontSize={8} fontFamily="monospace">{t}</text>)}
              {chart.xLabels.map((xl, i) => <text key={`x${i}`} x={xl.x} y={size.h - 8} textAnchor="middle" fill="#94a3b8" fontSize={9} fontFamily="monospace">{xl.label}</text>)}
              {hover != null && <circle cx={chart.X(hover)} cy={chart.lY(chart.pts[hover].pricePerM)} r={2.5} fill="#ffcc00" />}
            </svg>
          )}
          {hover != null && chart && (
            <div className="pointer-events-none absolute z-10 min-w-[150px] rounded border border-border bg-card/95 p-1.5" style={{ left: Math.min(Math.max(chart.X(hover) - 75, 4), size.w - 165), top: 4 }}>
              <div className="mb-1 text-[10px] font-semibold text-slate-200">
                {chart.pts[hover].year}{!chart.pts[hover].actual && <span className="ml-1 text-[8px] text-amber-400">预测</span>}
              </div>
              <div className="space-y-px text-[9px] leading-3">
                <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#ffcc00]" /><span className="w-14 text-slate-400">售价</span><span className="ml-auto font-mono text-slate-200">${chart.pts[hover].pricePerM}/M</span></div>
                <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#fb7185]" /><span className="w-14 text-slate-400">成本</span><span className="ml-auto font-mono text-slate-200">${chart.pts[hover].costPerM}/M</span></div>
                <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#a78bfa]" /><span className="w-14 text-slate-400">ROI</span><span className={`ml-auto font-mono ${chart.pts[hover].roiPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{chart.pts[hover].roiPct}%</span></div>
                <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#fbbf24]" /><span className="w-14 text-slate-400">CapEx</span><span className="ml-auto font-mono text-slate-200">${chart.pts[hover].capexB}B</span></div>
                <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" /><span className="w-14 text-slate-400">电网</span><span className="ml-auto font-mono text-slate-200">{chart.pts[hover].grid}</span></div>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between pt-1 text-[9px] text-slate-600">
          <span>{last ? `ROI ${last.roiPct}% · CapEx $${last.capexB}B · 售价/成本 ${last.pricePerM}/${last.costPerM}$/M` : "—"}</span>
          <span>数据: SEC/OpenRouter/FRED · 预测=模型假设</span>
        </div>
      </div>
    </Panel>
  );
});
