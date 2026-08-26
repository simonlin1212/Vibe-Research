"""OpenVlab webpage MQTT sidecar (unofficial).

Their market page streams over MQTT-over-WebSocket:
  wss://emqx.openvlab.cn/mqtt
  topic = {prefix}/{source}/{tier}  e.g. vlab/stream/optionflow/guest

This process connects and keeps payloads in memory.
optionflow is overlaid on the cockpit 异动 card (REST flow-alert is the
seed; MQTT does not write ovlab_flow_alert). ctamap overlays 行情观察
(REST ovlab_market is the seed; MQTT does not write that key). dataview
overlays watch last / T-quote und / minute last print (does not write
last-bar, does not replace T-quote theo prices). The webpage talks to
EMQX itself (mqtt.js); this process is the SSE fallback
GET /ovlab/mqtt/stream (GET /ovlab/mqtt remains a snapshot). pin= keeps
the chart contract in the 800-slot LRU and extra-subscribes instr/{alias}
(OpenVlab page case mix: ag2609C16000).
dataview last is often `value`; FUT_CFFEX_IF:202608 aliases to IF2608.

Default sources: optionflow, ctamap, dataview (dataview uses MQTT '+'
wildcard because their JS only subscribes with an instrument code).
VR_OVLAB_MQTT=0 turns the client off (tests set this).
Missing paho-mqtt / websocket-client: log and skip, REST 异动 still works.

Their ToS: display-only, API not a compatibility guarantee.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import os
import queue
import re
import secrets
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Sequence
from typing import Any
from urllib.parse import quote, unquote

logger = logging.getLogger(__name__)

BROKER_HOST = "emqx.openvlab.cn"
BROKER_PORT = 443
BROKER_PATH = "/mqtt"
TOPIC_PREFIX = "vlab/stream"
CLIENT_ID_PREFIX = "openvlab-web"  # guest ACL on their public EMQX
ORIGIN = "https://www.openvlab.cn"

SOURCES = frozenset(
    {"dataview", "fitterport", "optionstrat", "ctamap", "optionflow"}
)
# optionflow / ctamap take no extra path; dataview needs instr.
_BARE_SOURCES = frozenset({"optionflow", "ctamap"})

_KEEP = 8
_FLOW_MAX = 200
_DV_MAX = 800
_PIN_MAX = 12
_WATCH_MAXQ = 64
_OPT_RE = re.compile(r"^([A-Za-z]+)(\d{4})([CPcp])(\d+(?:\.\d+)?)$")
_FUT_LONG_RE = re.compile(r"^FUT_[A-Z]+_([A-Z0-9]+):(\d{6})$", re.I)
_SPOT_LONG_RE = re.compile(r"^(?:SHSE|SZSE)_(\d+)$", re.I)
_lock = threading.Lock()
_started = False
_client: Any = None
_recv = 0
_raw = 0
_drop = 0
_last_at: float | None = None
_error: str | None = None
_connected = False
_topics: list[str] = []
_recent: deque[dict[str, Any]] = deque(maxlen=_KEEP)
_flow: OrderedDict[str, dict[str, Any]] = OrderedDict()
_cta: OrderedDict[str, dict[str, Any]] = OrderedDict()
_dv: OrderedDict[str, dict[str, Any]] = OrderedDict()
_pinned: set[str] = set()
_watchers: list[queue.Queue] = []

# Live fields from the market table tick. Identity keys stay so the UI can join.
_CTA_PASS = frozenset(
    {
        "product",
        "prodUnd",
        "product_und",
        "price",
        "ctn",
        "atmv_current",
        "atmv_1dchg",
        "atmv_percentile",
        "carry",
        "skew_current",
        "skew_1dchg",
        "last_time",
        "exp",
    }
)


def enabled() -> bool:
    raw = os.environ.get("VR_OVLAB_MQTT", "1").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def mqtt_tier() -> str:
    t = os.environ.get("VR_OVLAB_MQTT_TIER", "guest").strip().lower()
    return t if t in {"guest", "user", "pro"} else "guest"


def mqtt_sources() -> list[str]:
    raw = os.environ.get("VR_OVLAB_MQTT_SOURCES", "optionflow,ctamap,dataview")
    out: list[str] = []
    for part in raw.split(","):
        src = part.strip().lower()
        if src in SOURCES and src not in out:
            out.append(src)
    return out or ["optionflow"]


def topic_of(
    source: str,
    *,
    tier: str | None = None,
    instr: str | None = None,
    prefix: str = TOPIC_PREFIX,
) -> str | None:
    """Build a subscribe topic. None = do not subscribe (matches their JS)."""
    src = (source or "").strip().lower()
    if src not in SOURCES:
        return None
    t = (tier or mqtt_tier()).strip().lower()
    base = f"{prefix}/{src}/{t}"
    if src in _BARE_SOURCES:
        return base
    if src == "dataview":
        code = (instr or "").strip()
        if not code:
            # Their JS skips dataview without instr; '+' is the MQTT single-level
            # wildcard so we still attach without picking a contract.
            return f"{base}/instr/+"
        return f"{base}/instr/{quote(code, safe='')}"
    return None


def source_from_topic(topic: str, prefix: str = TOPIC_PREFIX) -> str | None:
    head = prefix.rstrip("/") + "/"
    if not topic.startswith(head):
        return None
    src = topic[len(head) :].split("/", 1)[0]
    return src if src in SOURCES else None


def decode_body(payload: bytes | bytearray | str) -> str | None:
    """gzip (their fflate path) then UTF-8; raw JSON also ok."""
    if isinstance(payload, str):
        return payload
    if not payload:
        return None
    raw = bytes(payload)
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except OSError:
            logger.warning("ovlab mqtt gzip decode failed")
            return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("ovlab mqtt payload not utf-8")
        return None


def _walk(data: Any, fn) -> Any:
    if isinstance(data, list):
        return [fn(x) if isinstance(x, dict) else x for x in data]
    if isinstance(data, dict):
        return fn(data)
    return data


def _alias_flow(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if isinstance(out.get("instrument"), str) and not isinstance(out.get("instr"), str):
        out["instr"] = out["instrument"]
    if isinstance(out.get("instr"), str) and not isinstance(out.get("instrument"), str):
        out["instrument"] = out["instr"]
    if isinstance(out.get("instrument"), str) and not isinstance(
        out.get("contract_code"), str
    ):
        out["contract_code"] = out["instrument"]
    if isinstance(out.get("contract_code"), str) and not isinstance(
        out.get("instrument"), str
    ):
        out["instrument"] = out["contract_code"]
    if isinstance(out.get("exch_time"), str) and not isinstance(out.get("time"), str):
        out["time"] = out["exch_time"]
    if isinstance(out.get("time"), str) and not isinstance(out.get("exch_time"), str):
        out["exch_time"] = out["time"]
    return out


def _alias_cta(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if isinstance(out.get("product_und"), str) and not isinstance(out.get("prodUnd"), str):
        out["prodUnd"] = out["product_und"]
    if isinstance(out.get("prodUnd"), str) and not isinstance(out.get("product_und"), str):
        out["product_und"] = out["prodUnd"]
    return out


def normalize(source: str, data: Any) -> Any:
    if source == "optionflow":
        return _walk(data, _alias_flow)
    if source == "ctamap":
        return _walk(data, _alias_cta)
    return data


def parse_dataview_kv(text: str) -> dict[str, Any] | None:
    """Fallback their JS uses when dataview payload is 'k:v k:v' text."""
    pairs: list[tuple[str, Any]] = []
    for part in text.split():
        i = part.find(":")
        if i <= 0:
            continue
        key = part[:i].strip()
        if not key:
            continue
        raw = part[i + 1 :].strip()
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            raw = raw[1:-1]
        try:
            val: Any = float(raw) if "." in raw else int(raw)
        except ValueError:
            val = raw
        pairs.append((key, val))
    return dict(pairs) if pairs else None


def as_flow_rows(data: Any) -> list[dict[str, Any]]:
    """Pull optionflow alert dicts out of a live envelope payload."""
    if data is None:
        return []
    if isinstance(data, list):
        out: list[dict[str, Any]] = []
        for item in data:
            out.extend(as_flow_rows(item))
        return out
    if not isinstance(data, dict):
        return []
    for key in ("alerts", "list", "items", "rows", "result"):
        nested = data.get(key)
        if nested is not None and nested is not data:
            got = as_flow_rows(nested)
            if got:
                return got
    if any(
        data.get(k) not in (None, "")
        for k in ("rule_id", "instrument", "instr", "contract_code", "window_volume")
    ):
        return [_alias_flow(data)]
    return []


def _flow_key(row: dict[str, Any]) -> str:
    return "|".join(
        (
            str(row.get("contract_code") or row.get("instr") or ""),
            str(row.get("time") or ""),
            str(row.get("rule_id") or ""),
        )
    )


def _finite(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        return x if math.isfinite(x) else None
    if isinstance(v, str):
        s = v.strip().replace("%", "").replace(",", "")
        if not s:
            return None
        try:
            x = float(s)
        except ValueError:
            return None
        return x if math.isfinite(x) else None
    return None


def _cta_ctn(v: Any) -> Any:
    """Keep REST fraction units. Percent strings like 1.23% become 0.0123."""
    if isinstance(v, str) and "%" in v:
        n = _finite(v)
        return None if n is None else n / 100.0
    return v


def _slim_cta(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in row.items():
        if k not in _CTA_PASS or v is None or v == "":
            continue
        out[k] = _cta_ctn(v) if k == "ctn" else v
    # OpenVlab commodity ticks are AG_O / AU_O with empty prodUnd.
    prod = str(out.get("product") or "")
    if not out.get("prodUnd") and prod.upper().endswith("_O"):
        out["prodUnd"] = prod[:-2]
    return out


def as_cta_rows(data: Any) -> list[dict[str, Any]]:
    """Pull ctamap product dicts out of a live envelope payload."""
    if data is None:
        return []
    if isinstance(data, list):
        out: list[dict[str, Any]] = []
        for item in data:
            out.extend(as_cta_rows(item))
        return out
    if not isinstance(data, dict):
        return []
    for key in ("rows", "list", "items", "result"):
        nested = data.get(key)
        if nested is not None and nested is not data:
            got = as_cta_rows(nested)
            if got:
                return got
    if any(
        data.get(k) not in (None, "")
        for k in ("product", "prodUnd", "product_und")
    ):
        return [_alias_cta(data)]
    return []


def _cta_key(row: dict[str, Any]) -> str:
    p = str(row.get("product") or "").strip().upper()
    if p:
        return p
    return str(row.get("prodUnd") or row.get("product_und") or "").strip().upper()


def _ingest_cta(data: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in as_cta_rows(data):
        slim = _slim_cta(row)
        key = _cta_key(slim)
        if not key:
            continue
        if key in _cta:
            prev = _cta.pop(key)
            prev.update(slim)
            slim = prev
        _cta[key] = slim
        out.append(slim)
    return out


def _dv_last(row: dict[str, Any], code: str = "") -> float | None:
    keys = (
        "last_trade_price",
        "lastTradePrice",
        "last_price",
        "lastPrice",
        "last",
        "close",
        "price",
    )
    # value is the last on FUT_CFFEX_IF:202608; short SI2610 ticks use it for other crumbs.
    if _FUT_LONG_RE.match(code or "") or str(code).upper().startswith("OPT_"):
        keys = (*keys, "value")
    for k in keys:
        v = _finite(row.get(k))
        if v is not None and v > 0:
            return v
    return None


def _dv_oi(row: dict[str, Any]) -> float | None:
    for k in ("oi", "open_interest", "openInterest"):
        v = _finite(row.get(k))
        if v is not None and v >= 0:
            return v
    return None


def dv_short_code(code: str) -> str | None:
    """FUT_CFFEX_IF:202608 -> IF2608; SHSE_510300 -> 510300."""
    c = (code or "").strip()
    m = _FUT_LONG_RE.match(c)
    if m:
        return f"{m.group(1).upper()}{m.group(2)[-4:]}"
    m = _SPOT_LONG_RE.match(c)
    if m:
        return m.group(1)
    return None


def _dv_put(tick: dict[str, Any]) -> None:
    key = str(tick.get("instr") or "").strip().upper()
    if not key:
        return
    if key in _dv:
        del _dv[key]
    _dv[key] = tick
    while len(_dv) > _DV_MAX:
        victim = next((k for k in _dv if k not in _pinned), None)
        if victim is None:
            break
        del _dv[victim]


def _ingest_dv(topic: str, data: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if isinstance(data, dict):
        rows = [data]
    elif isinstance(data, list):
        rows = [x for x in data if isinstance(x, dict)]
    out: list[dict[str, Any]] = []
    for row in rows:
        code = str(
            row.get("instr") or row.get("symbol") or _instr_from_topic(topic) or ""
        ).strip()
        if not code or code == "+":
            continue
        last = _dv_last(row, code)
        oi = _dv_oi(row)
        if last is None and oi is None:
            continue
        tick: dict[str, Any] = {"instr": code, "at": time.time()}
        if last is not None:
            tick["last"] = last
        if oi is not None:
            tick["oi"] = oi
        _dv_put(tick)
        out.append(tick)
        short = dv_short_code(code)
        if short and short.upper() != code.upper():
            alias = dict(tick)
            alias["instr"] = short
            _dv_put(alias)
            out.append(alias)
    return out


def _trim_flow() -> None:
    if len(_flow) <= _FLOW_MAX:
        return
    keep = sorted(
        _flow.items(),
        key=lambda kv: str(kv[1].get("time") or ""),
        reverse=True,
    )[:_FLOW_MAX]
    _flow.clear()
    _flow.update(keep)


def _ingest_flow(data: Any) -> list[dict[str, Any]]:
    rows = as_flow_rows(data)
    out: list[dict[str, Any]] = []
    for row in rows:
        key = _flow_key(row)
        if key.strip("|") == "":
            continue
        if key in _flow:
            del _flow[key]
        _flow[key] = row
        out.append(row)
    _trim_flow()
    return out


def dv_aliases(code: str) -> list[str]:
    """MQTT topic spellings OpenVlab uses (al2609 / ag2609C16000)."""
    c = (code or "").strip()
    if not c:
        return []
    out: list[str] = []
    for v in (c, c.upper(), c.lower()):
        if v not in out:
            out.append(v)
    m = _OPT_RE.match(c)
    if m:
        mixed = f"{m.group(1).lower()}{m.group(2)}{m.group(3).upper()}{m.group(4)}"
        if mixed not in out:
            out.append(mixed)
    return out


def pin_dataview(codes: Sequence[str]) -> None:
    """Keep these contracts in the dataview LRU; extra-sub instr/{alias} when connected."""
    aliases: list[str] = []
    seen: set[str] = set()
    for raw in list(codes)[:_PIN_MAX]:
        for a in dv_aliases(raw):
            if a in seen:
                continue
            seen.add(a)
            aliases.append(a)
    keys = {a.upper() for a in aliases}
    wanted: list[str] = []
    for a in aliases:
        t = topic_of("dataview", instr=a)
        if t and t not in wanted:
            wanted.append(t)
    with _lock:
        _pinned.clear()
        _pinned.update(keys)
        client = _client
        connected = _connected
        new_topics: list[str] = []
        for t in wanted:
            if t not in _topics:
                _topics.append(t)
                new_topics.append(t)
    if not client or not connected:
        return
    for t in new_topics:
        try:
            client.subscribe(t, qos=0)
        except Exception:
            logger.warning("ovlab mqtt pin subscribe failed %s", t)


def _instr_from_topic(topic: str) -> str:
    parts = topic.split("/")
    try:
        i = parts.index("instr")
    except ValueError:
        return ""
    if i + 1 >= len(parts):
        return ""
    return unquote(parts[i + 1])


def parse_message(
    topic: str,
    payload: bytes | bytearray | str,
    *,
    prefix: str = TOPIC_PREFIX,
) -> dict[str, Any] | None:
    """Parse one inbound MQTT payload into {topic, source, data} or None."""
    text = decode_body(payload)
    if text is None:
        return None
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        src = source_from_topic(topic, prefix)
        if src != "dataview":
            return None
        kv = parse_dataview_kv(text)
        if not kv:
            return None
        return {"topic": topic, "source": src, "data": kv}
    if isinstance(obj, dict) and obj.get("t") == "live" and obj.get("s") in SOURCES:
        src = str(obj["s"])
        return {"topic": topic, "source": src, "data": normalize(src, obj.get("d"))}
    src = source_from_topic(topic, prefix)
    if not src:
        return None
    return {"topic": topic, "source": src, "data": normalize(src, obj)}


def _summarize(data: Any) -> dict[str, Any]:
    if isinstance(data, list):
        first = data[0] if data else None
        keys = sorted(first.keys()) if isinstance(first, dict) else []
        return {"kind": "list", "n": len(data), "keys": keys}
    if isinstance(data, dict):
        return {"kind": "dict", "keys": sorted(data.keys())[:40]}
    return {"kind": type(data).__name__}


def _live_meta() -> dict[str, Any]:
    return {
        "enabled": enabled(),
        "connected": _connected,
        "recv": _recv,
        "last_at": _last_at,
        "error": _error,
        "ctamap_n": len(_cta),
        "dataview_n": len(_dv),
        "optionflow_n": len(_flow),
    }


def watch() -> queue.Queue:
    """Queue of live patches for one SSE client. Caller must unwatch()."""
    q: queue.Queue = queue.Queue(maxsize=_WATCH_MAXQ)
    with _lock:
        _watchers.append(q)
    return q


def unwatch(q: queue.Queue) -> None:
    with _lock:
        if q in _watchers:
            _watchers.remove(q)


def _fanout(evt: dict[str, Any]) -> None:
    with _lock:
        watchers = list(_watchers)
    for q in watchers:
        try:
            q.put_nowait(evt)
        except queue.Full:
            try:
                q.get_nowait()
            except queue.Empty:
                pass
            try:
                q.put_nowait(evt)
            except queue.Full:
                pass


def format_sse(event: str, payload: Any) -> str:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    lines = [f"event: {event}"]
    for line in body.split("\n"):
        lines.append(f"data: {line}")
    return "\n".join(lines) + "\n\n"


def remember(msg: dict[str, Any]) -> None:
    """Keep last payloads in RAM only. Never writes ovlab TTLCache."""
    global _recv, _last_at
    src = str(msg.get("source") or "")
    data = msg.get("data")
    patch: dict[str, Any] | None = None
    with _lock:
        _recv += 1
        _last_at = time.time()
        n = _recv
        if src == "optionflow":
            rows = _ingest_flow(data)
            if rows:
                patch = {"source": src, "optionflow": rows, **_live_meta()}
        elif src == "ctamap":
            rows = _ingest_cta(data)
            if rows:
                patch = {"source": src, "ctamap": rows, **_live_meta()}
        elif src == "dataview":
            rows = _ingest_dv(str(msg.get("topic") or ""), data)
            if rows:
                patch = {"source": src, "dataview": rows, **_live_meta()}
        _recent.append(
            {
                "topic": msg.get("topic"),
                "source": src,
                "at": _last_at,
                **_summarize(data),
            }
        )
    if patch:
        _fanout(patch)
    if n == 1 or n % 100 == 0:
        logger.info("ovlab mqtt recv=%s source=%s", n, src)


def optionflow_rows() -> list[dict[str, Any]]:
    with _lock:
        rows = list(_flow.values())
    rows.sort(key=lambda r: str(r.get("time") or ""), reverse=True)
    return rows[:80]


def snapshot() -> dict[str, Any]:
    with _lock:
        flow = list(_flow.values())
        flow_n = len(_flow)
        recent = list(_recent)
        cta = list(_cta.values())
        dv = list(_dv.values())
        return_base = {
            "enabled": enabled(),
            "connected": _connected,
            "broker": f"wss://{BROKER_HOST}{BROKER_PATH}",
            "topics": list(_topics),
            "tier": mqtt_tier(),
            "sources": mqtt_sources(),
            "recv": _recv,
            "raw": _raw,
            "drop": _drop,
            "last_at": _last_at,
            "last": recent[-1] if recent else None,
            "error": _error,
            "feeds_ui": True,
            "optionflow_n": flow_n,
            "ctamap_n": len(cta),
            "dataview_n": len(dv),
        }
    flow.sort(key=lambda r: str(r.get("time") or ""), reverse=True)
    return_base["optionflow"] = flow[:80]
    return_base["ctamap"] = cta
    return_base["dataview"] = dv
    return return_base


def reset_for_tests() -> None:
    global _recv, _raw, _drop, _last_at, _error, _connected, _topics
    with _lock:
        _recv = 0
        _raw = 0
        _drop = 0
        _last_at = None
        _error = None
        _connected = False
        _topics = []
        _recent.clear()
        _flow.clear()
        _cta.clear()
        _dv.clear()
        _pinned.clear()
        _watchers.clear()


def _paho_mod():
    try:
        import paho.mqtt.client as mqtt  # noqa: PLC0415
    except ImportError:
        return None
    try:
        import websocket  # noqa: F401, PLC0415
    except ImportError:
        return None
    return mqtt


def _new_client(mqtt, client_id: str):
    kwargs: dict[str, Any] = {
        "client_id": client_id,
        "transport": "websockets",
        "protocol": mqtt.MQTTv311,
        "clean_session": True,
    }
    ver = getattr(mqtt, "CallbackAPIVersion", None)
    if ver is not None:
        return mqtt.Client(ver.VERSION2, **kwargs)
    return mqtt.Client(**kwargs)


def _reason_ok(reason_code: Any) -> bool:
    if reason_code is None:
        return False
    if hasattr(reason_code, "value"):
        return int(reason_code.value) == 0
    try:
        return int(reason_code) == 0
    except (TypeError, ValueError):
        return str(reason_code) in {"0", "Success"}


def _on_connect(client, _userdata, _flags, reason_code, _properties=None):
    global _connected, _error
    ok = _reason_ok(reason_code)
    with _lock:
        _connected = ok
        _error = None if ok else f"connack {reason_code}"
        topics = list(_topics)
    if not ok:
        logger.warning("ovlab mqtt connect failed: %s", reason_code)
        return
    logger.info("ovlab mqtt connected, subscribe %s", topics)
    for t in topics:
        client.subscribe(t, qos=0)


def _on_subscribe(_client, _userdata, _mid, granted, _properties=None):
    codes = granted if isinstance(granted, (list, tuple)) else [granted]
    logger.info("ovlab mqtt suback %s", codes)


def _on_disconnect(_client, _userdata, *args):
    global _connected
    with _lock:
        _connected = False
    logger.info("ovlab mqtt disconnected")


def _on_message(_client, _userdata, msg):
    global _raw, _drop
    payload = getattr(msg, "payload", b"")
    with _lock:
        _raw += 1
        nraw = _raw
    if nraw == 1:
        if isinstance(payload, (bytes, bytearray)):
            logger.info(
                "ovlab mqtt first payload n=%s prefix=%s",
                len(payload),
                bytes(payload[:16]).hex(),
            )
        else:
            logger.info("ovlab mqtt first payload type=%s", type(payload).__name__)
    parsed = parse_message(getattr(msg, "topic", ""), payload)
    if parsed is None:
        with _lock:
            _drop += 1
        return
    remember(parsed)


def start() -> None:
    """Connect in this thread (caller should use a daemon thread). Idempotent."""
    global _started, _client, _error, _topics
    if not enabled():
        logger.info("ovlab mqtt off (VR_OVLAB_MQTT=0)")
        return
    with _lock:
        if _started:
            return
        _started = True
    mqtt = _paho_mod()
    if mqtt is None:
        with _lock:
            _error = "missing paho-mqtt / websocket-client"
        logger.warning("ovlab mqtt skipped: pip install paho-mqtt websocket-client")
        return
    tier = mqtt_tier()
    topics = [topic_of(s, tier=tier) for s in mqtt_sources()]
    topics = [t for t in topics if t]
    if not topics:
        with _lock:
            _error = "no mqtt topics"
        logger.warning("ovlab mqtt skipped: no topics")
        return
    client_id = f"{CLIENT_ID_PREFIX}_{secrets.token_hex(4)}"
    try:
        client = _new_client(mqtt, client_id)
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        if hasattr(client, "tls_set"):
            client.tls_set()
        if hasattr(client, "ws_set_options"):
            client.ws_set_options(path=BROKER_PATH, headers={"Origin": ORIGIN})
        client.on_connect = _on_connect
        client.on_disconnect = _on_disconnect
        client.on_message = _on_message
        client.on_subscribe = _on_subscribe
        with _lock:
            _topics = topics
            _client = client
            _error = None
        client.connect_async(BROKER_HOST, BROKER_PORT, keepalive=30)
        client.loop_start()
        logger.info("ovlab mqtt starting client_id=%s topics=%s", client_id, topics)
    except Exception as e:
        with _lock:
            _error = str(e)
            _client = None
        logger.warning("ovlab mqtt start failed: %s", e)


def stop() -> None:
    global _started, _client, _connected
    with _lock:
        client = _client
        _client = None
        _started = False
        _connected = False
    if client is None:
        return
    try:
        client.loop_stop()
        client.disconnect()
    except Exception as e:
        logger.info("ovlab mqtt stop: %s", e)
