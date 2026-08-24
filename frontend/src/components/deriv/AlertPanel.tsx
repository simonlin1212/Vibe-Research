import { useEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import type { OvlabFlowAlert } from "@/lib/api";
import type { DerivData } from "@/hooks/useDerivData";
import { cn } from "@/lib/utils";
import { daysToExpiry, num } from "@/components/ovlab/shared";
import { storageGet, storageSet } from "@/lib/storage";
import { CellEmpty, alertOptionName, useAlertSeen } from "./derivShared";

/** OpenVlab flow-alert rule_id -> 异动类型. Aligns with openvlab.cn/flow/option-flow. */
export const FLOW_RULE_LABEL: Record<string, string> = {
  r001_single_trade: "成交异动",
  r002_1m_pct_move: "走势异动",
  r003_repeated_aggressive_burst: "连续成交",
};

const RULE_HINT: Record<string, string> = {
  r001_single_trade: "3秒内单笔: 区间成交额或手数达标",
  r002_1m_pct_move: "1分钟涨幅且成交额达标",
  r003_repeated_aggressive_burst: "2秒内连续同向成交额达标",
};

const RULE_TONE: Record<string, string> = {
  r001_single_trade: "text-amber-400",
  r002_1m_pct_move: "text-primary",
  r003_repeated_aggressive_burst: "text-fuchsia-400",
};

const THRESH_KEY = "deriv.alertThresh";
const THRESH_VER = 2;

type OnMap = { r001: boolean; r002: boolean; r003: boolean };
type Thresh = {
  on: OnMap;
  lots: number;
  tradePrem: number;
  pct: number;
  movePrem: number;
  burstPrem: number;
};

/** Hard floors. Defaults may sit above these; local filter cannot go below. */
const FLOOR: Omit<Thresh, "on"> = {
  lots: 50,
  tradePrem: 10_000,
  pct: 0,
  movePrem: 1_000,
  burstPrem: 50_000,
};

const DEFAULT_THRESH: Thresh = {
  on: { r001: true, r002: true, r003: true },
  lots: 100,
  tradePrem: 100_000,
  pct: 20,
  movePrem: 10_000,
  burstPrem: 50_000,
};

function cloneThresh(t: Thresh): Thresh {
  return { ...t, on: { ...t.on } };
}

export function clampThresh(t: Thresh): Thresh {
  const n = (v: unknown, floor: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(floor, x) : floor;
  };
  return {
    on: {
      r001: t.on?.r001 !== false,
      r002: t.on?.r002 !== false,
      r003: t.on?.r003 !== false,
    },
    lots: n(t.lots, FLOOR.lots),
    tradePrem: n(t.tradePrem, FLOOR.tradePrem),
    pct: n(t.pct, FLOOR.pct),
    movePrem: n(t.movePrem, FLOOR.movePrem),
    burstPrem: n(t.burstPrem, FLOOR.burstPrem),
  };
}

function loadThresh(): Thresh {
  try {
    const o = JSON.parse(storageGet(THRESH_KEY) ?? "null") as (Partial<Thresh> & { v?: number }) | null;
    if (!o || typeof o !== "object" || o.v !== THRESH_VER) return cloneThresh(DEFAULT_THRESH);
    return clampThresh({
      on: {
        r001: o.on?.r001 !== false,
        r002: o.on?.r002 !== false,
        r003: o.on?.r003 !== false,
      },
      lots: Number(o.lots),
      tradePrem: Number(o.tradePrem),
      pct: Number(o.pct),
      movePrem: Number(o.movePrem),
      burstPrem: Number(o.burstPrem),
    });
  } catch {
    return cloneThresh(DEFAULT_THRESH);
  }
}

function saveThresh(t: Thresh) {
  storageSet(THRESH_KEY, JSON.stringify({ v: THRESH_VER, ...t }));
}

function alertKey(a: Pick<OvlabFlowAlert, "contract_code" | "time" | "rule_id">): string {
  return `${a.contract_code ?? ""}|${a.time ?? ""}|${a.rule_id ?? ""}`;
}

/** Window pct (区间涨幅). pct_change is a percent string; fall back to start/end. */
export function intervalPct(a: OvlabFlowAlert): number | null {
  const p = num(String(a.pct_change ?? "").replace("%", ""));
  if (p !== null) return p;
  const s = num(a.price_start);
  const e = num(a.price_end);
  if (s != null && e != null && s !== 0) return ((e - s) / s) * 100;
  return null;
}

function fmtAmt(n: number): string {
  if (Math.abs(n) >= 10_000) {
    const wan = n / 10_000;
    const s = wan.toFixed(wan >= 10 || Number.isInteger(wan) ? 0 : 1);
    return `${s}万`;
  }
  return String(Math.round(n));
}

/** 1=主动买(ask/上行)  -1=主动卖(bid/下行)  0=分不清. r001 以 side 为准, 区间涨幅常为 0. */
export function tradeSide(a: OvlabFlowAlert): 1 | -1 | 0 {
  const s = String(a.side ?? "").toLowerCase();
  if (s === "ask" || s === "buy" || s === "b") return 1;
  if (s === "bid" || s === "sell" || s === "s") return -1;
  const ft = String(a.fill_type ?? "").toLowerCase();
  if (ft.includes("ascend")) return 1;
  if (ft.includes("descend")) return -1;
  const p = intervalPct(a);
  if (p != null && p > 0) return 1;
  if (p != null && p < 0) return -1;
  return 0;
}

/** Type cell: 成交异动 split by side. */
export function ruleLabelOf(a: OvlabFlowAlert): string {
  const rid = String(a.rule_id ?? "");
  const base = FLOW_RULE_LABEL[rid] ?? rid;
  if (rid !== "r001_single_trade") return base;
  const d = tradeSide(a);
  if (d > 0) return "成交异动⬆";
  if (d < 0) return "成交异动⬇";
  return base;
}

export function ruleToneOf(a: OvlabFlowAlert): string {
  const rid = String(a.rule_id ?? "");
  if (rid === "r001_single_trade") {
    const d = tradeSide(a);
    if (d > 0) return "text-red-400";
    if (d < 0) return "text-emerald-400";
  }
  return RULE_TONE[rid] ?? "text-slate-500";
}

function triggerHint(a: OvlabFlowAlert): string {
  const rid = String(a.rule_id ?? "");
  const base = RULE_HINT[rid] ?? "";
  const vol = num(a.window_volume);
  const prem = num(a.window_premium);
  const bits = [base];
  if (vol != null) bits.push(`${Math.round(vol)}手`);
  if (prem != null) bits.push(fmtAmt(prem));
  if (rid === "r001_single_trade") {
    const d = tradeSide(a);
    if (d > 0) bits.push("主动买");
    else if (d < 0) bits.push("主动卖");
  }
  if (rid === "r003_repeated_aggressive_burst") {
    const fill = a.fill_type === "descending_fill" ? "下行" : a.fill_type === "ascending_fill" ? "上行" : "";
    if (fill) bits.push(fill);
  }
  return bits.join(" ");
}

export function passesThresh(a: OvlabFlowAlert, t: Thresh): boolean {
  const rid = String(a.rule_id ?? "");
  const f = clampThresh(t);
  const vol = num(a.window_volume) ?? 0;
  const prem = num(a.window_premium) ?? 0;
  if (rid === "r001_single_trade") {
    if (!f.on.r001) return false;
    return prem >= f.tradePrem || vol >= f.lots;
  }
  if (rid === "r002_1m_pct_move") {
    if (!f.on.r002) return false;
    return Math.abs(intervalPct(a) ?? 0) >= f.pct && prem >= f.movePrem;
  }
  if (rid === "r003_repeated_aggressive_burst") {
    if (!f.on.r003) return false;
    return prem >= f.burstPrem;
  }
  return false;
}

function ThreshField({
  label, suffix, value, min, onChange,
}: {
  label: string; suffix: string; value: number; min: number; onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
      <span className="shrink-0">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          step="any"
          value={Number.isFinite(value) ? value : min}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : min);
          }}
          className="field-input w-[4.6rem] !px-1.5 !py-0.5 text-right text-[11px] tabular-nums"
        />
        <span className="w-4 text-slate-600">{suffix}</span>
      </span>
    </label>
  );
}

function RuleCheck({
  on, label, tone, onToggle,
}: {
  on: boolean; label: string; tone: string; onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={on}
        onChange={onToggle}
        className="accent-primary"
      />
      <span className={cn("text-[11px] font-medium", on ? tone : "text-slate-600")}>{label}</span>
    </label>
  );
}

function mqttStatusHint(m: DerivData["alertMqtt"]): { text: string; cls: string; title: string; on: boolean } {
  if (!m) return { text: "MQTT…", cls: "text-slate-600", title: "正在读连接状态", on: false };
  if (!m.enabled) return { text: "MQTT关", cls: "text-slate-600", title: "VR_OVLAB_MQTT=0, 异动走 REST", on: false };
  if (m.connected) return { text: "已连接", cls: "text-emerald-400", title: "optionflow 实时叠在表上", on: true };
  return { text: "MQTT未连", cls: "text-slate-500", title: m.error || "未连上 broker, 异动走 REST", on: false };
}

function MqttMark({ hint }: { hint: ReturnType<typeof mqttStatusHint> }) {
  return (
    <span className={cn("inline-flex items-center gap-1", hint.cls)} title={hint.title}>
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", hint.on ? "bg-emerald-400" : "bg-slate-600")} />
      {hint.text}
    </span>
  );
}

/** 异动: REST flow-alert seed, MQTT optionflow overlay from useDerivData. Local thresh. */
export function AlertPanel({ d }: { d: DerivData }) {
  const [thresh, setThresh] = useState<Thresh>(loadThresh);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [autoTop, setAutoTop] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const cfgRef = useRef<HTMLDivElement>(null);

  const setAndSave = (next: Thresh) => {
    const clamped = clampThresh(next);
    setThresh(clamped);
    saveThresh(clamped);
  };
  const toggleOn = (k: keyof OnMap) => setAndSave({ ...thresh, on: { ...thresh.on, [k]: !thresh.on[k] } });

  const alerts = useMemo(() => {
    const raw = d.alerts ?? [];
    return raw.filter((a) => passesThresh(a, thresh)).slice(0, 80);
  }, [d.alerts, thresh]);
  const keys = useMemo(() => alerts.map(alertKey), [alerts]);
  const seen = useAlertSeen(keys);

  const firstKey = keys[0] ?? "";
  useEffect(() => {
    if (autoTop && listRef.current) listRef.current.scrollTop = 0;
  }, [firstKey, autoTop]);

  useEffect(() => {
    if (!cfgOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (cfgRef.current && !cfgRef.current.contains(e.target as Node)) setCfgOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [cfgOpen]);

  const mqttHint = mqttStatusHint(d.alertMqtt);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex shrink-0 items-center justify-end gap-2 border-b border-slate-800/60 px-2 py-0.5">
        <span className="mr-auto flex items-center gap-1.5 tabular-nums text-[11px] text-slate-500">
          <MqttMark hint={mqttHint} />
          {d.alerts ? `${alerts.length}条` : "…"}
        </span>
        <div ref={cfgRef} className="relative">
          <button
            type="button"
            onClick={() => setCfgOpen((v) => !v)}
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px]",
              cfgOpen ? "text-amber-400" : "text-slate-500 hover:text-slate-300",
            )}
            title="自定义阈值"
          >
            <Settings className="h-3 w-3" strokeWidth={2} />
            阈值
          </button>
          {cfgOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-[17.5rem] space-y-2 rounded border border-slate-700/80 bg-slate-900 p-2 shadow-lg">
              <div className="space-y-1 border-b border-slate-800 pb-1.5">
                <RuleCheck
                  on={thresh.on.r001}
                  label="成交异动"
                  tone="text-amber-400"
                  onToggle={() => toggleOn("r001")}
                />
                <ThreshField
                  label="区间成交额"
                  suffix="元"
                  min={FLOOR.tradePrem}
                  value={thresh.tradePrem}
                  onChange={(tradePrem) => setAndSave({ ...thresh, tradePrem })}
                />
                <ThreshField
                  label="或 成交量"
                  suffix="手"
                  min={FLOOR.lots}
                  value={thresh.lots}
                  onChange={(lots) => setAndSave({ ...thresh, lots })}
                />
              </div>
              <div className="space-y-1 border-b border-slate-800 pb-1.5">
                <RuleCheck
                  on={thresh.on.r002}
                  label="走势异动"
                  tone="text-primary"
                  onToggle={() => toggleOn("r002")}
                />
                <ThreshField
                  label="1分钟涨幅"
                  suffix="%"
                  min={FLOOR.pct}
                  value={thresh.pct}
                  onChange={(pct) => setAndSave({ ...thresh, pct })}
                />
                <ThreshField
                  label="1分钟成交额"
                  suffix="元"
                  min={FLOOR.movePrem}
                  value={thresh.movePrem}
                  onChange={(movePrem) => setAndSave({ ...thresh, movePrem })}
                />
              </div>
              <div className="space-y-1">
                <RuleCheck
                  on={thresh.on.r003}
                  label="连续成交"
                  tone="text-fuchsia-400"
                  onToggle={() => toggleOn("r003")}
                />
                <ThreshField
                  label="2秒成交额"
                  suffix="元"
                  min={FLOOR.burstPrem}
                  value={thresh.burstPrem}
                  onChange={(burstPrem) => setAndSave({ ...thresh, burstPrem })}
                />
              </div>
              <button
                type="button"
                onClick={() => setAndSave(cloneThresh(DEFAULT_THRESH))}
                className="w-full text-left text-[10px] text-slate-600 hover:text-slate-400"
              >
                恢复默认 10万/100手 · 20%/1万 · 5万
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setAutoTop((v) => !v)}
          className={cn("text-[11px]", autoTop ? "text-primary" : "text-slate-600 hover:text-slate-400")}
          title="新异动自动滚到顶"
        >
          滚顶{autoTop ? "开" : "关"}
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {!d.alerts && <CellEmpty text="更新中…" />}
        {d.alerts && alerts.length === 0 && (
          <CellEmpty text={thresh.on.r001 || thresh.on.r002 || thresh.on.r003 ? "暂无异动" : "未勾选类型"} />
        )}
        {d.alerts && alerts.length > 0 && (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-slate-400">
                <th className="sticky top-0 z-[1] bg-card px-1.5 py-1 text-left font-semibold">时间</th>
                <th className="sticky top-0 z-[1] bg-card px-1 py-1 text-left font-semibold">合约</th>
                <th className="sticky top-0 z-[1] bg-card px-1 py-1 text-left font-semibold" title="异动类型">类型</th>
                <th className="sticky top-0 z-[1] bg-card px-1 py-1 text-right font-semibold" title="剩余天数">剩余</th>
                <th className="sticky top-0 z-[1] bg-card px-1.5 py-1 text-right font-semibold" title="区间涨幅">区间</th>
                <th className="sticky top-0 z-[1] bg-card px-1.5 py-1 text-right font-semibold" title="区间成交量">量</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => {
                const k = alertKey(a);
                const isNew = !seen.has(k);
                const pct = intervalPct(a);
                const dte = daysToExpiry(a.exp_date);
                const vol = num(a.window_volume);
                return (
                  <tr
                    key={k}
                    className={cn(
                      "border-b border-slate-800/40",
                      isNew && "bg-primary/[0.04] shadow-[inset_2px_0_0_#ffcc00]",
                    )}
                    title={triggerHint(a)}
                  >
                    <td className="px-1.5 py-0.5 tabular-nums text-slate-500">
                      {String(a.time ?? "").slice(11, 16)}
                    </td>
                    <td
                      className="max-w-[8rem] truncate px-1 py-0.5 text-slate-300"
                      title={`${String(a.instrument ?? "")} ${String(a.contract_code ?? "")}`.trim()}
                    >
                      {alertOptionName(a)}
                    </td>
                    <td className={cn("whitespace-nowrap px-1 py-0.5", ruleToneOf(a))}>
                      {ruleLabelOf(a)}
                    </td>
                    <td className={cn(
                      "px-1 py-0.5 text-right tabular-nums",
                      dte != null && dte <= 7 ? "text-amber-400" : "text-slate-400",
                    )}>
                      {dte == null ? "-" : dte}
                    </td>
                    <td className={cn(
                      "px-1.5 py-0.5 text-right tabular-nums",
                      pct == null ? "text-slate-600" : pct > 0 ? "text-red-400" : pct < 0 ? "text-emerald-400" : "text-slate-500",
                    )}>
                      {pct == null ? "-" : `${pct > 0 ? "+" : ""}${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`}
                    </td>
                    <td
                      className="px-1.5 py-0.5 text-right tabular-nums text-slate-300"
                      title={vol != null ? `${Math.round(vol)}手` : undefined}
                    >
                      {vol == null ? "-" : fmtAmt(vol)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
