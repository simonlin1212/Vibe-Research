/**
 * OpenVlab webpage MQTT client (same broker / topics as openvlab.cn).
 * Browser talks to wss://emqx.openvlab.cn/mqtt. Does not write REST cache.
 */
import mqtt, { type MqttClient } from "mqtt";
import type { OvlabDataviewTick, OvlabFlowAlert, OvlabMarketRow } from "@/lib/api";

export const BROKER_URL = "wss://emqx.openvlab.cn/mqtt";
export const TOPIC_PREFIX = "vlab/stream";
export const MQTT_TIER = "guest";
export const MQTT_SOURCES = ["optionflow", "ctamap", "dataview"] as const;

const SOURCES = new Set(["dataview", "fitterport", "optionstrat", "ctamap", "optionflow"]);
const BARE = new Set(["optionflow", "ctamap"]);
const CTA_PASS = new Set([
  "product", "prodUnd", "product_und", "price", "ctn",
  "atmv_current", "atmv_1dchg", "atmv_percentile", "carry",
  "skew_current", "skew_1dchg", "last_time", "exp",
]);
const OPT_RE = /^([A-Za-z]+)(\d{4})([CPcp])(\d+(?:\.\d+)?)$/;

export type MqttPatch = {
  source: string;
  optionflow?: OvlabFlowAlert[];
  ctamap?: OvlabMarketRow[];
  dataview?: OvlabDataviewTick[];
};

export function topicOf(source: string, instr?: string, tier = MQTT_TIER): string | null {
  const src = source.trim().toLowerCase();
  if (!SOURCES.has(src)) return null;
  const base = `${TOPIC_PREFIX}/${src}/${tier}`;
  if (BARE.has(src)) return base;
  if (src === "dataview") {
    const code = (instr ?? "").trim();
    return code ? `${base}/instr/${encodeURIComponent(code)}` : `${base}/instr/+`;
  }
  return null;
}

export function sourceFromTopic(topic: string): string | null {
  const head = `${TOPIC_PREFIX}/`;
  if (!topic.startsWith(head)) return null;
  const src = topic.slice(head.length).split("/")[0] ?? "";
  return SOURCES.has(src) ? src : null;
}

export function dvAliases(code: string): string[] {
  const c = (code || "").trim();
  if (!c) return [];
  const out: string[] = [];
  for (const v of [c, c.toUpperCase(), c.toLowerCase()]) {
    if (!out.includes(v)) out.push(v);
  }
  const m = OPT_RE.exec(c);
  if (m) {
    const mixed = `${m[1].toLowerCase()}${m[2]}${m[3].toUpperCase()}${m[4]}`;
    if (!out.includes(mixed)) out.push(mixed);
  }
  return out;
}

function instrFromTopic(topic: string): string {
  const parts = topic.split("/");
  const i = parts.indexOf("instr");
  if (i < 0 || i + 1 >= parts.length) return "";
  try {
    return decodeURIComponent(parts[i + 1] ?? "");
  } catch {
    return parts[i + 1] ?? "";
  }
}

function finite(v: unknown): number | null {
  if (typeof v === "boolean" || v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace("%", "").replace(/,/g, "");
    if (!s) return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function aliasFlow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.instrument === "string" && typeof out.instr !== "string") out.instr = out.instrument;
  if (typeof out.instr === "string" && typeof out.instrument !== "string") out.instrument = out.instr;
  if (typeof out.instrument === "string" && typeof out.contract_code !== "string") out.contract_code = out.instrument;
  if (typeof out.contract_code === "string" && typeof out.instrument !== "string") out.instrument = out.contract_code;
  if (typeof out.exch_time === "string" && typeof out.time !== "string") out.time = out.exch_time;
  if (typeof out.time === "string" && typeof out.exch_time !== "string") out.exch_time = out.time;
  return out;
}

function aliasCta(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.product_und === "string" && typeof out.prodUnd !== "string") out.prodUnd = out.product_und;
  if (typeof out.prodUnd === "string" && typeof out.product_und !== "string") out.product_und = out.prodUnd;
  return out;
}

function walk(data: unknown, fn: (r: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(data)) return data.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? fn(x as Record<string, unknown>) : x));
  if (data && typeof data === "object") return fn(data as Record<string, unknown>);
  return data;
}

function normalize(source: string, data: unknown): unknown {
  if (source === "optionflow") return walk(data, aliasFlow);
  if (source === "ctamap") return walk(data, aliasCta);
  return data;
}

export function parseDataviewKv(text: string): Record<string, unknown> | null {
  const pairs: [string, unknown][] = [];
  for (const part of text.split(/\s+/)) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    let raw = part.slice(i + 1).trim();
    if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && raw[0] === '"') raw = raw.slice(1, -1);
    let val: unknown = raw;
    const n = Number(raw);
    if (raw !== "" && Number.isFinite(n)) val = raw.includes(".") ? n : (Number.isInteger(n) ? n : raw);
    pairs.push([key, val]);
  }
  return pairs.length ? Object.fromEntries(pairs) : null;
}

export function asFlowRows(data: unknown): OvlabFlowAlert[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data.flatMap(asFlowRows);
  if (typeof data !== "object") return [];
  const row = data as Record<string, unknown>;
  for (const key of ["alerts", "list", "items", "rows", "result"]) {
    const nested = row[key];
    if (nested != null && nested !== data) {
      const got = asFlowRows(nested);
      if (got.length) return got;
    }
  }
  if (["rule_id", "instrument", "instr", "contract_code", "window_volume"].some((k) => row[k] != null && row[k] !== "")) {
    return [aliasFlow(row) as OvlabFlowAlert];
  }
  return [];
}

function ctaCtn(v: unknown): unknown {
  if (typeof v === "string" && v.includes("%")) {
    const n = finite(v);
    return n == null ? null : n / 100;
  }
  return v;
}

function slimCta(row: Record<string, unknown>): OvlabMarketRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!CTA_PASS.has(k) || v == null || v === "") continue;
    out[k] = k === "ctn" ? ctaCtn(v) : v;
  }
  const prod = String(out.product ?? "");
  if (!out.prodUnd && prod.toUpperCase().endsWith("_O")) out.prodUnd = prod.slice(0, -2);
  return out as OvlabMarketRow;
}

export function asCtaRows(data: unknown): OvlabMarketRow[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data.flatMap(asCtaRows);
  if (typeof data !== "object") return [];
  const row = data as Record<string, unknown>;
  for (const key of ["rows", "list", "items", "result"]) {
    const nested = row[key];
    if (nested != null && nested !== data) {
      const got = asCtaRows(nested);
      if (got.length) return got;
    }
  }
  if (["product", "prodUnd", "product_und"].some((k) => row[k] != null && row[k] !== "")) {
    return [slimCta(aliasCta(row))];
  }
  return [];
}

export function dvShortCode(code: string): string | null {
  const c = (code || "").trim();
  const fut = /^FUT_[A-Z]+_([A-Z0-9]+):(\d{6})$/i.exec(c);
  if (fut) return `${fut[1].toUpperCase()}${fut[2].slice(2)}`;
  const spot = /^(?:SHSE|SZSE)_(\d+)$/i.exec(c);
  return spot ? spot[1] : null;
}

function dvLast(row: Record<string, unknown>, code = ""): number | null {
  const keys = ["last_trade_price", "lastTradePrice", "last_price", "lastPrice", "last", "close", "price"];
  // value is the last on FUT_CFFEX_IF:202608; short commodity ticks use it for other crumbs.
  if (/^(FUT_|OPT_)/i.test(code)) keys.push("value");
  for (const k of keys) {
    const v = finite(row[k]);
    if (v != null && v > 0) return v;
  }
  return null;
}

function dvOi(row: Record<string, unknown>): number | null {
  for (const k of ["oi", "open_interest", "openInterest"]) {
    const v = finite(row[k]);
    if (v != null && v >= 0) return v;
  }
  return null;
}

export function asDvTicks(topic: string, data: unknown): OvlabDataviewTick[] {
  const rows = Array.isArray(data)
    ? data.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    : (data && typeof data === "object" ? [data as Record<string, unknown>] : []);
  const out: OvlabDataviewTick[] = [];
  const at = Date.now() / 1000;
  for (const row of rows) {
    const code = String(row.instr ?? row.symbol ?? instrFromTopic(topic) ?? "").trim();
    if (!code || code === "+") continue;
    const last = dvLast(row, code);
    const oi = dvOi(row);
    if (last == null && oi == null) continue;
    const tick: OvlabDataviewTick = { instr: code, at };
    if (last != null) tick.last = last;
    if (oi != null) tick.oi = oi;
    out.push(tick);
    const short = dvShortCode(code);
    if (short && short.toUpperCase() !== code.toUpperCase()) {
      out.push({ ...tick, instr: short });
    }
  }
  return out;
}

/** Parse decoded UTF-8 payload. Same envelopes as backend/ovlab_mqtt.py. */
export function ingestMqttText(topic: string, text: string): MqttPatch | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const src = sourceFromTopic(topic);
    if (src !== "dataview") return null;
    const kv = parseDataviewKv(text);
    if (!kv) return null;
    const dataview = asDvTicks(topic, kv);
    return dataview.length ? { source: src, dataview } : null;
  }
  let source: string | null = null;
  let data: unknown = obj;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const bag = obj as Record<string, unknown>;
    if (bag.t === "live" && typeof bag.s === "string" && SOURCES.has(bag.s)) {
      source = bag.s;
      data = normalize(source, bag.d);
    }
  }
  if (!source) {
    source = sourceFromTopic(topic);
    if (!source) return null;
    data = normalize(source, obj);
  }
  if (source === "optionflow") {
    const optionflow = asFlowRows(data);
    return optionflow.length ? { source, optionflow } : null;
  }
  if (source === "ctamap") {
    const ctamap = asCtaRows(data);
    return ctamap.length ? { source, ctamap } : null;
  }
  if (source === "dataview") {
    const dataview = asDvTicks(topic, data);
    return dataview.length ? { source, dataview } : null;
  }
  return null;
}

function toU8(payload: unknown): Uint8Array | null {
  if (payload == null) return null;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    const v = payload as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

async function gunzip(u8: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return u8;
  const stream = new Blob([u8.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeMqttBody(payload: unknown): Promise<string | null> {
  if (typeof payload === "string") return payload;
  const u8 = toU8(payload);
  if (!u8?.length) return null;
  let raw = u8;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = await gunzip(raw);
    } catch {
      return null;
    }
  }
  try {
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

export type MqttStatusEvt = { connected: boolean; error: string | null };

type PatchFn = (patch: MqttPatch) => void;
type StatusFn = (s: MqttStatusEvt) => void;

let client: MqttClient | null = null;
let refs = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let pinCodes: string[] = [];
const extraTopics = new Set<string>();
const patches = new Set<PatchFn>();
const statuses = new Set<StatusFn>();

function baseTopics(): string[] {
  return MQTT_SOURCES.map((s) => topicOf(s)).filter((t): t is string => !!t);
}

function emitStatus(connected: boolean, error: string | null = null): void {
  for (const fn of statuses) fn({ connected, error });
}

function emitPatch(patch: MqttPatch): void {
  for (const fn of patches) fn(patch);
}

function syncPins(c: MqttClient): void {
  const wanted = new Set<string>();
  for (const raw of pinCodes) {
    for (const a of dvAliases(raw)) {
      const t = topicOf("dataview", a);
      if (t) wanted.add(t);
    }
  }
  for (const t of wanted) {
    if (extraTopics.has(t)) continue;
    extraTopics.add(t);
    c.subscribe(t, { qos: 0 });
  }
  for (const t of [...extraTopics]) {
    if (wanted.has(t)) continue;
    extraTopics.delete(t);
    c.unsubscribe(t);
  }
}

function bind(c: MqttClient): void {
  c.on("connect", () => {
    for (const t of baseTopics()) c.subscribe(t, { qos: 0 });
    syncPins(c);
    emitStatus(true);
  });
  c.on("reconnect", () => emitStatus(false));
  c.on("close", () => emitStatus(false));
  c.on("error", (err) => emitStatus(false, err instanceof Error ? err.message : "mqtt error"));
  c.on("message", (topic, payload) => {
    void (async () => {
      const text = await decodeMqttBody(payload);
      if (!text) return;
      const patch = ingestMqttText(topic, text);
      if (patch) emitPatch(patch);
    })();
  });
}

function ensureClient(): MqttClient {
  if (client && !client.disconnecting) return client;
  const id = `openvlab-web_${Math.random().toString(36).slice(2, 10)}`;
  const next = mqtt.connect(BROKER_URL, {
    clientId: id,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
    // Same as their RealtimeMqttClient: native WS, no extra subprotocol.
    wsOptions: {},
  });
  bind(next);
  client = next;
  return next;
}

function stopClient(): void {
  extraTopics.clear();
  if (!client) return;
  const c = client;
  client = null;
  try {
    c.end(true);
  } catch {
    /* already closed */
  }
}

/** Keep one broker connection while any cockpit is mounted. */
export function retainOvlabMqtt(): () => void {
  refs += 1;
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  ensureClient();
  return () => {
    refs -= 1;
    if (refs > 0) return;
    refs = 0;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (refs <= 0) stopClient();
    }, 1500);
  };
}

export function setOvlabMqttPins(codes: string[]): void {
  pinCodes = codes.map((c) => c.trim()).filter(Boolean).slice(0, 12);
  if (client?.connected) syncPins(client);
}

export function watchOvlabMqtt(onPatch: PatchFn, onStatus?: StatusFn): () => void {
  patches.add(onPatch);
  if (onStatus) {
    statuses.add(onStatus);
    onStatus({ connected: !!client?.connected, error: null });
  }
  return () => {
    patches.delete(onPatch);
    if (onStatus) statuses.delete(onStatus);
  };
}

export function ovlabMqttConnected(): boolean {
  return !!client?.connected;
}
