import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const src = await readFile(new URL("../src/lib/ovlabMqtt.ts", import.meta.url), "utf8");

test("网页 MQTT 直连 OpenVlab EMQX, 不另开 market", async () => {
  assert.ok(src.includes('BROKER_URL = "wss://emqx.openvlab.cn/mqtt"'));
  assert.ok(src.includes("mqtt.connect"));
  assert.ok(src.includes('TOPIC_PREFIX = "vlab/stream"'));
  assert.ok(src.includes("optionflow"));
  assert.ok(src.includes("ctamap"));
  assert.ok(src.includes("dataview"));
  assert.ok(src.includes("instr/+"));
  assert.ok(src.includes("keepalive: 30"));
  assert.ok(src.includes("reconnectPeriod: 3000"));
  assert.ok(src.includes("ingestMqttText"));
  assert.doesNotMatch(src, /ovlab_flow_alert|ovlab_market/);
});

function sourceFromTopic(topic) {
  const head = "vlab/stream/";
  if (!topic.startsWith(head)) return null;
  const srcName = topic.slice(head.length).split("/")[0] ?? "";
  return ["dataview", "fitterport", "optionstrat", "ctamap", "optionflow"].includes(srcName) ? srcName : null;
}

function asFlowRows(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data.flatMap(asFlowRows);
  if (typeof data !== "object") return [];
  if (data.instrument && !data.instr) data = { ...data, instr: data.instrument, contract_code: data.instrument };
  if (data.rule_id || data.instr || data.contract_code) return [data];
  return [];
}

function asCtaRows(data) {
  if (Array.isArray(data)) return data.flatMap(asCtaRows);
  if (!data || typeof data !== "object") return [];
  if (data.product || data.prodUnd) {
    const out = { ...data };
    if (!out.prodUnd && String(out.product ?? "").toUpperCase().endsWith("_O")) {
      out.prodUnd = String(out.product).slice(0, -2);
    }
    return [out];
  }
  return [];
}

function ingestMqttText(topic, text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  let source = null;
  let data = obj;
  if (obj && obj.t === "live" && obj.s) {
    source = obj.s;
    data = obj.d;
  }
  if (!source) source = sourceFromTopic(topic);
  if (source === "optionflow") {
    const optionflow = asFlowRows(data);
    return optionflow.length ? { source, optionflow } : null;
  }
  if (source === "ctamap") {
    const ctamap = asCtaRows(data);
    return ctamap.length ? { source, ctamap } : null;
  }
  return { source, data };
}

function dvShortCode(code) {
  const fut = /^FUT_[A-Z]+_([A-Z0-9]+):(\d{6})$/i.exec(code || "");
  if (fut) return `${fut[1].toUpperCase()}${fut[2].slice(2)}`;
  const spot = /^(?:SHSE|SZSE)_(\d+)$/i.exec(code || "");
  return spot ? spot[1] : null;
}

test("dataview value 是最新价, 长码收成短码", () => {
  assert.ok(src.includes('"value"'));
  assert.ok(src.includes("dvShortCode"));
  assert.ok(src.includes("/^(FUT_|OPT_)/i"));
  assert.equal(dvShortCode("FUT_CFFEX_IF:202608"), "IF2608");
  assert.equal(dvShortCode("FUT_SHFE_AG:202609"), "AG2609");
  assert.equal(dvShortCode("SHSE_510300"), "510300");
  assert.equal(dvShortCode("IF2608"), null);
});

test("live envelope optionflow / ctamap 解析", () => {
  const flow = ingestMqttText(
    "vlab/stream/optionflow/guest",
    JSON.stringify({ t: "live", s: "optionflow", d: { instrument: "MA2609C3000", rule_id: "r001_single_trade" } }),
  );
  assert.equal(flow.source, "optionflow");
  assert.equal(flow.optionflow[0].instr, "MA2609C3000");
  const cta = ingestMqttText(
    "vlab/stream/ctamap/guest",
    JSON.stringify({ t: "live", s: "ctamap", d: { product: "AG_O", price: 16057, exp: "202609" } }),
  );
  assert.equal(cta.ctamap[0].prodUnd, "AG");
  assert.equal(cta.ctamap[0].price, 16057);
});
