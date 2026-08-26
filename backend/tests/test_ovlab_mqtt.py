"""OpenVlab MQTT sidecar (offline). optionflow overlay does not write REST cache."""
import gzip
import json

import pytest

import ovlab
import ovlab_mqtt


TOPIC = "vlab/stream/optionflow/guest"
CTA = "vlab/stream/ctamap/guest"
DV = "vlab/stream/dataview/guest/instr/+"


def setup_function():
    ovlab_mqtt.reset_for_tests()
    ovlab._CACHE.clear()


def test_topic_optionflow_and_ctamap():
    assert ovlab_mqtt.topic_of("optionflow", tier="guest") == TOPIC
    assert ovlab_mqtt.topic_of("ctamap", tier="guest") == CTA


def test_topic_dataview_wildcard_without_instr():
    assert ovlab_mqtt.topic_of("dataview") == DV
    assert ovlab_mqtt.topic_of("dataview", instr="MA2609C3000") == (
        "vlab/stream/dataview/guest/instr/MA2609C3000"
    )


def test_topic_unknown_and_fitterport_skipped():
    assert ovlab_mqtt.topic_of("nope") is None
    assert ovlab_mqtt.topic_of("fitterport") is None


def test_default_sources_are_three():
    assert ovlab_mqtt.mqtt_sources() == ["optionflow", "ctamap", "dataview"]


def test_source_from_topic():
    assert ovlab_mqtt.source_from_topic(TOPIC) == "optionflow"
    assert ovlab_mqtt.source_from_topic("other/optionflow/guest") is None
    assert ovlab_mqtt.source_from_topic("vlab/stream/dataview/guest/instr/X") == "dataview"


def test_parse_live_envelope_aliases_instr():
    raw = json.dumps(
        {"t": "live", "s": "optionflow", "d": {"instrument": "MA2609C3000"}}
    ).encode()
    msg = ovlab_mqtt.parse_message(TOPIC, raw)
    assert msg is not None
    assert msg["source"] == "optionflow"
    assert msg["data"]["instr"] == "MA2609C3000"
    assert msg["data"]["contract_code"] == "MA2609C3000"


def test_parse_gzip_payload():
    body = json.dumps(
        {"t": "live", "s": "optionflow", "d": {"instr": "RB2609P3000"}}
    ).encode()
    msg = ovlab_mqtt.parse_message(TOPIC, gzip.compress(body))
    assert msg is not None
    assert msg["data"]["instrument"] == "RB2609P3000"


def test_parse_bare_json_uses_topic_source():
    raw = json.dumps([{"instrument": "CU2609C70000"}]).encode()
    msg = ovlab_mqtt.parse_message(TOPIC, raw)
    assert msg is not None
    assert msg["source"] == "optionflow"
    assert msg["data"][0]["instr"] == "CU2609C70000"


def test_parse_dataview_kv_text():
    topic = "vlab/stream/dataview/guest/instr/al2609"
    msg = ovlab_mqtt.parse_message(topic, b"instr:al2609 last_trade_price:18500 oi:12")
    assert msg is not None
    assert msg["source"] == "dataview"
    assert msg["data"]["instr"] == "al2609"
    assert msg["data"]["oi"] == 12


def test_as_flow_rows_list_and_single():
    rows = ovlab_mqtt.as_flow_rows(
        [{"rule_id": "r001_single_trade", "instrument": "A", "time": "2026-08-18 21:00:00"}]
    )
    assert len(rows) == 1
    assert rows[0]["contract_code"] == "A"
    one = ovlab_mqtt.as_flow_rows(
        {"t": "nope", "rule_id": "r002_1m_pct_move", "contract_code": "B"}
    )
    assert one[0]["rule_id"] == "r002_1m_pct_move"


def test_remember_optionflow_does_not_write_rest_cache():
    msg = ovlab_mqtt.parse_message(
        TOPIC,
        json.dumps(
            {
                "t": "live",
                "s": "optionflow",
                "d": {
                    "instrument": "al2609C24600",
                    "time": "2026-08-18 23:42:01",
                    "rule_id": "r002_1m_pct_move",
                    "window_volume": 15,
                },
            }
        ).encode(),
    )
    assert msg is not None
    ovlab_mqtt.remember(msg)
    assert ovlab._CACHE.get("ovlab_flow_alert") is None
    assert ovlab._CACHE.get("ovlab_market") is None
    snap = ovlab_mqtt.snapshot()
    assert snap["recv"] == 1
    assert snap["feeds_ui"] is True
    assert snap["optionflow_n"] == 1
    assert snap["optionflow"][0]["contract_code"] == "al2609C24600"


def test_alias_exch_time_to_time():
    rows = ovlab_mqtt.as_flow_rows(
        {
            "instrument": "sn2609C430000",
            "exch_time": "2026-08-18 23:48:30",
            "rule_id": "r003_repeated_aggressive_burst",
        }
    )
    assert rows[0]["time"] == "2026-08-18 23:48:30"


def test_remember_ctamap_and_dataview_counts():
    ovlab_mqtt.remember(
        {
            "topic": CTA,
            "source": "ctamap",
            "data": [
                {"prodUnd": "AL", "price": 18500, "ctn": 0.01},
                {"prodUnd": "CU", "price": 70000, "ctn": "-1.2%"},
            ],
        }
    )
    ovlab_mqtt.remember(
        {
            "topic": "vlab/stream/dataview/guest/instr/al2609",
            "source": "dataview",
            "data": {"instr": "al2609", "last_trade_price": 18510, "oi": 12},
        }
    )
    snap = ovlab_mqtt.snapshot()
    assert snap["ctamap_n"] == 2
    assert snap["dataview_n"] == 1
    assert snap["optionflow"] == []
    by_und = {str(r.get("prodUnd")): r for r in snap["ctamap"]}
    assert by_und["AL"]["price"] == 18500
    assert by_und["CU"]["ctn"] == pytest.approx(-0.012)
    tick = snap["dataview"][0]
    assert tick["instr"] == "al2609"
    assert tick["last"] == 18510
    assert tick["oi"] == 12
    assert isinstance(tick.get("at"), float)
    assert ovlab._CACHE.get("ovlab_market") is None


def test_cta_ag_o_fills_prod_und():
    ovlab_mqtt.remember(
        {
            "topic": CTA,
            "source": "ctamap",
            "data": {"product": "AG_O", "price": 16057, "ctn": 0.04, "exp": "202609"},
        }
    )
    ag = next(r for r in ovlab_mqtt.snapshot()["ctamap"] if r.get("product") == "AG_O")
    assert ag["prodUnd"] == "AG"
    assert ag["price"] == 16057


def test_cta_upsert_same_product():
    ovlab_mqtt.remember(
        {"topic": CTA, "source": "ctamap", "data": {"prodUnd": "AL", "price": 1}}
    )
    ovlab_mqtt.remember(
        {"topic": CTA, "source": "ctamap", "data": {"prodUnd": "AL", "price": 2, "ctn": 0.01}}
    )
    snap = ovlab_mqtt.snapshot()
    assert snap["ctamap_n"] == 1
    assert snap["ctamap"][0]["price"] == 2
    assert snap["ctamap"][0]["ctn"] == 0.01


def test_dataview_kv_remember_last():
    msg = ovlab_mqtt.parse_message(
        "vlab/stream/dataview/guest/instr/al2609",
        b"instr:al2609 last_trade_price:18500 oi:12",
    )
    assert msg is not None
    ovlab_mqtt.remember(msg)
    tick = ovlab_mqtt.snapshot()["dataview"][0]
    assert tick["last"] == 18500
    assert tick["instr"].upper() == "AL2609"


def test_start_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("VR_OVLAB_MQTT", "0")
    ovlab_mqtt.stop()
    ovlab_mqtt.start()
    snap = ovlab_mqtt.snapshot()
    assert snap["enabled"] is False
    assert snap["connected"] is False
    assert snap["recv"] == 0


def test_dv_short_code_fut_and_etf():
    assert ovlab_mqtt.dv_short_code("FUT_CFFEX_IF:202608") == "IF2608"
    assert ovlab_mqtt.dv_short_code("FUT_SHFE_AG:202609") == "AG2609"
    assert ovlab_mqtt.dv_short_code("SHSE_510300") == "510300"
    assert ovlab_mqtt.dv_short_code("SZSE_159919") == "159919"
    assert ovlab_mqtt.dv_short_code("IF2608") is None


def test_dataview_value_aliases_if2608():
    ovlab_mqtt.remember(
        {
            "topic": "vlab/stream/dataview/guest/instr/FUT_CFFEX_IF:202608",
            "source": "dataview",
            "data": {"instr": "FUT_CFFEX_IF:202608", "value": 4592.6, "oi": 20110},
        }
    )
    by = {str(t.get("instr") or "").upper(): t for t in ovlab_mqtt.snapshot()["dataview"]}
    assert by["IF2608"]["last"] == 4592.6
    assert by["FUT_CFFEX_IF:202608"]["last"] == 4592.6
    assert by["IF2608"]["oi"] == 20110


def test_dataview_si2610_value_is_not_last():
    ovlab_mqtt.remember(
        {
            "topic": "vlab/stream/dataview/guest/instr/SI2610",
            "source": "dataview",
            "data": {"instr": "SI2610", "value": 69.73, "oi": 1},
        }
    )
    rows = ovlab_mqtt.snapshot()["dataview"]
    assert rows == [] or all(t.get("last") != 69.73 for t in rows)


def test_dv_aliases_option_mixed_case():
    aliases = ovlab_mqtt.dv_aliases("AG2609C16000")
    assert "AG2609C16000" in aliases
    assert "ag2609c16000" in aliases
    assert "ag2609C16000" in aliases
    t = ovlab_mqtt.topic_of("dataview", instr="ag2609C16000")
    assert t == "vlab/stream/dataview/guest/instr/ag2609C16000"


def _dv_tick(code: str, last: float = 1.0) -> None:
    ovlab_mqtt.remember(
        {
            "topic": f"vlab/stream/dataview/guest/instr/{code}",
            "source": "dataview",
            "data": {"instr": code, "last_trade_price": last, "oi": 1},
        }
    )


def test_pinned_dataview_survives_lru():
    ovlab_mqtt.pin_dataview(["AG2609C16000"])
    _dv_tick("ag2609C16000", 1.2)
    for i in range(ovlab_mqtt._DV_MAX + 20):
        _dv_tick(f"x{i}")
    snap = ovlab_mqtt.snapshot()
    keys = {str(t.get("instr") or "").upper() for t in snap["dataview"]}
    assert "AG2609C16000" in keys
    assert snap["dataview_n"] == ovlab_mqtt._DV_MAX
    ag = next(t for t in snap["dataview"] if str(t.get("instr")).upper() == "AG2609C16000")
    assert ag["last"] == 1.2


def test_mqtt_status_endpoint():
    from fastapi.testclient import TestClient

    import app as app_module

    r = TestClient(app_module.app).get("/api/ovlab/mqtt")
    assert r.status_code == 200
    body = r.json()["data"]
    assert body["feeds_ui"] is True
    assert body["enabled"] is False
    assert "connected" in body
    assert body.get("sources") == ["optionflow", "ctamap", "dataview"]
    assert "optionflow" in body
    assert "ctamap" in body
    assert "dataview" in body


def test_mqtt_status_pin_query():
    from fastapi.testclient import TestClient

    import app as app_module

    r = TestClient(app_module.app).get("/api/ovlab/mqtt?pin=AG2609C16000,AG2609")
    assert r.status_code == 200
    _dv_tick("ag2609C16000", 9.5)
    for i in range(ovlab_mqtt._DV_MAX + 5):
        _dv_tick(f"y{i}")
    snap = ovlab_mqtt.snapshot()
    keys = {str(t.get("instr") or "").upper() for t in snap["dataview"]}
    assert "AG2609C16000" in keys
    assert "AG2609" in ovlab_mqtt._pinned


def test_pin_queues_dataview_topics_offline():
    ovlab_mqtt.pin_dataview(["AG2609"])
    topics = ovlab_mqtt.snapshot()["topics"]
    assert "vlab/stream/dataview/guest/instr/AG2609" in topics
    assert "vlab/stream/dataview/guest/instr/ag2609" in topics


def test_format_sse_event_and_data():
    body = ovlab_mqtt.format_sse("tick", {"a": 1})
    assert body.startswith("event: tick\n")
    assert "data: {\"a\":1}" in body
    assert body.endswith("\n\n")


def test_watch_fanout_on_remember():
    q = ovlab_mqtt.watch()
    try:
        ovlab_mqtt.remember(
            {
                "topic": "vlab/stream/dataview/guest/instr/al2609",
                "source": "dataview",
                "data": {"instr": "al2609", "last_trade_price": 18510, "oi": 12},
            }
        )
        evt = q.get(timeout=1)
        assert evt["source"] == "dataview"
        assert evt["dataview"][0]["last"] == 18510
        assert evt["dataview_n"] == 1
    finally:
        ovlab_mqtt.unwatch(q)


def _first_sse_event(buf: str) -> tuple[str, dict]:
    block = buf.split("\n\n", 1)[0]
    event = "message"
    data_lines: list[str] = []
    for line in block.split("\n"):
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())
    return event, json.loads("\n".join(data_lines))


def _as_text(chunk: str | bytes) -> str:
    return chunk if isinstance(chunk, str) else chunk.decode()


def test_mqtt_stream_snapshot():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from routers.ovlab_routes import ovlab_mqtt_stream

    _dv_tick("al2609", 18510)
    request = MagicMock()
    request.is_disconnected = AsyncMock(return_value=True)

    async def run():
        resp = await ovlab_mqtt_stream(request, pin=None)
        assert resp.media_type == "text/event-stream"
        chunks: list[str] = []
        async for c in resp.body_iterator:
            chunks.append(_as_text(c))
        return "".join(chunks)

    buf = asyncio.run(run())
    event, payload = _first_sse_event(buf)
    assert event == "snapshot"
    assert payload["feeds_ui"] is True
    assert payload["dataview_n"] == 1
    assert payload["dataview"][0]["last"] == 18510
    assert ovlab_mqtt._watchers == []


def test_mqtt_stream_tick_after_snapshot():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from routers.ovlab_routes import ovlab_mqtt_stream

    request = MagicMock()
    request.is_disconnected = AsyncMock(side_effect=[False, True, True])

    async def run():
        resp = await ovlab_mqtt_stream(request, pin=None)
        ovlab_mqtt.remember(
            {
                "topic": "vlab/stream/dataview/guest/instr/cu2609",
                "source": "dataview",
                "data": {"instr": "cu2609", "last_trade_price": 70001, "oi": 3},
            }
        )
        chunks: list[str] = []
        async for c in resp.body_iterator:
            chunks.append(_as_text(c))
        return "".join(chunks)

    buf = asyncio.run(run())
    events = []
    rest = buf
    while "\n\n" in rest:
        block, rest = rest.split("\n\n", 1)
        if not block or block.startswith(":"):
            continue
        events.append(_first_sse_event(block + "\n\n"))
    kinds = [e[0] for e in events]
    assert "snapshot" in kinds
    assert "tick" in kinds
    tick = next(p for e, p in events if e == "tick")
    assert tick["source"] == "dataview"
    assert tick["dataview"][0]["last"] == 70001
    assert ovlab_mqtt._watchers == []


def test_mqtt_stream_pin_query():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from routers.ovlab_routes import ovlab_mqtt_stream

    request = MagicMock()
    request.is_disconnected = AsyncMock(return_value=True)

    async def run():
        resp = await ovlab_mqtt_stream(request, pin="AG2609C16000,AG2609")
        async for _c in resp.body_iterator:
            break

    asyncio.run(run())
    assert "AG2609C16000" in ovlab_mqtt._pinned
    assert "AG2609" in ovlab_mqtt._pinned
    assert ovlab_mqtt._watchers == []


def test_mqtt_stream_route_registered():
    from fastapi.testclient import TestClient

    import app as app_module

    spec = TestClient(app_module.app).get("/openapi.json").json()
    assert "/api/ovlab/mqtt/stream" in spec["paths"]
    assert "/api/ovlab/mqtt" in spec["paths"]
