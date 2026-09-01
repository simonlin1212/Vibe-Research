"""Shared HTTP helpers for Vibe-Research API routers.

Validation, process-local TTL caches, and Daily Review warmup hook.
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import astock
from cache import TTLCache, is_nonempty
from fastapi import HTTPException

_SYMBOL_RE = re.compile(
    r"^(?:(?:sh|sz|bj)\d{6}|\d{6}|hkhsi|hkhstech|usdji|usixic|usinx|usvix|ussoxx|jpn225|kskospi|whusdcny)$",
    re.IGNORECASE,
)
_SYMBOL_HINT = "代码须为 6 位数字、sh/sz/bj+6 位、hkHSI/hkHSTECH、usIXIC / jpN225 / ksKOSPI 或 whUSDCNY"


def _validate(code: str) -> str:
    """Stock-only 6-digit (600519 / SH600519 / 600519.SH). Indices use _validate_symbol."""
    try:
        return astock.norm_ticker(code, stock_only=True)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _validate_symbol(code: str) -> str:
    """6-digit, sh/sz/bj+6, HK/US indices, or FX whUSDCNY (canonical case)."""
    raw = (code or "").strip()
    if not _SYMBOL_RE.fullmatch(raw):
        raise HTTPException(400, _SYMBOL_HINT)
    # Preserve Tencent-required case for HK / US indices; lowercase A-share symbols
    resolved = astock.resolve_symbol(raw)
    if not resolved:
        raise HTTPException(400, _SYMBOL_HINT)
    return resolved


# One process cache for cockpit + F10. Empty upstream uses a short negative TTL.
_DC_CACHE = TTLCache(maxsize=512, default_ttl=300, negative_ttl=15, name="app_dc")

# Same as marketingdashboard /api/board-flow: 120s Eastmoney cache.
# Frontend still polls every 10s and hits this cache.
BOARD_FLOW_TTL = 120
BOARD_FLOW_N = 20

# Same keys as GET /api/market/{world-indices,boards,rank,stock-flow,board-flow-intraday,commodities}
# world_indices / boards / rank / flow: warm_dc_jobs. commodities: put_commodities in warm_minutes.
COCKPIT_WARM_KEYS = (
    "world_indices",
    "commodities",
    "sector_boards",
    "stock_rank",
    "stock_flow",
    "board_flow_intraday",
)


def _put(endpoint: str, code: str, value, ttl: float):
    """Warmup force-write. Same key HTTP _dc / _read uses."""
    if is_nonempty(value):
        _DC_CACHE.set((endpoint, code), value, ttl=ttl)
    return value


def _serve(endpoint: str, code: str, default=None) -> Any:
    """Fresh slot, else last good. No fetch."""
    return _DC_CACHE.get_last((endpoint, code), default)


def _dc(endpoint: str, code: str, ttl: float, fetch, valid=is_nonempty, *, last: bool = True, default=None) -> Any:
    """HTTP default: last-good after first fill. last=False may refetch on expire."""
    val = _DC_CACHE.get_or_set(
        (endpoint, code),
        fetch,
        ttl=ttl,
        valid=valid,
        negative_ttl=15,
        serve_last=last,
    )
    return default if val is None else val


def _cached(endpoint: str, code: str, ttl: float, fetch, valid=is_nonempty):
    """Expire may fetch again: watchlist minutes, board stocks, concept 120, rank up/down, lives, cls telegraph."""
    return _dc(endpoint, code, ttl, fetch, valid, last=False)


def _read(endpoint: str, code: str, ttl: float, fetch, valid=is_nonempty, default=None) -> Any:
    """Last-good after the first fill. Clock force-write via _put."""
    return _dc(endpoint, code, ttl, fetch, valid, default=default)


def minute_covers_close(data: Any) -> bool:
    """True if the last 1-min bar reached the afternoon close (~15:00)."""
    bars = data.get("bars") if isinstance(data, dict) else None
    if not bars:
        return False
    dt = str((bars[-1] or {}).get("datetime") or "")
    m = re.search(r"(\d{1,2}):(\d{2})", dt)
    if not m:
        return False
    return int(m.group(1)) * 100 + int(m.group(2)) >= 1457


def serve_light_kline(sym: str, res: str, num: int):
    """Catalog 1-min 240: last-good when closed. Open session expire-refetches.

    Closed last-good that stops before 14:57 is treated as incomplete (Tencent
    501 mid-session) and expired so the next read can refill.
    """
    ep = f"ashare_light:{res}:{num}"
    catalog_min = res == "1" and int(num) == 240 and is_catalog_symbol(sym)
    kind = _session_kind()
    last = catalog_min and kind != "open"
    if last and kind == "closed":
        hit = _serve(ep, sym)
        if isinstance(hit, dict) and hit.get("bars") and not minute_covers_close(hit):
            _DC_CACHE.expire((ep, sym))
            last = False
    return _dc(
        ep,
        sym,
        light_kline_ttl(sym, res),
        lambda: astock.light_kline(sym, res, num=num),
        last=last,
    )


def put_fetch(endpoint: str, code: str, ttl: float, fetch, valid=is_nonempty):
    """Warmup: always fetch, then _put."""
    data = fetch()
    if valid(data):
        return _put(endpoint, code, data, ttl)
    return data


def is_catalog_symbol(sym: str) -> bool:
    from index_catalog import catalog_codes

    s = (sym or "").strip().lower()
    return bool(s) and s in {c.lower() for c in catalog_codes()}


def _session_kind() -> str:
    try:
        import review_warmup
        return review_warmup.session_kind()
    except Exception:
        return "closed"


def light_kline_ttl(sym: str, res: str, session: str | None = None) -> int:
    """Index minutes: 4s open so 行情观察 5s polls see new bars. Stocks 120s.

    Closed/lunch still outlast keep-warm (960/180) and stay last-good.
    """
    if res != "1":
        return 60
    kind = session if session is not None else _session_kind()
    s = (sym or "").lower()
    index = s.startswith(("sh000", "sz399", "hk", "us", "wh", "jp", "ks"))
    if kind == "open":
        return 4 if index else 120
    if kind == "lunch":
        return 180
    return 960


def commodity_quote_ttl(session: str | None = None) -> int:
    """Commodities TTL. 4s so 外盘 5s polls see new ticks. Same key as HTTP."""
    return 4


def put_commodities(codes: str | None = None) -> dict | list:
    """Fetch and write the same key GET /market/commodities uses. Warmup only."""
    import cockpit_live

    raw = (codes or "").strip() or cockpit_live.DEFAULT_FUTURES
    data = put_fetch(
        "commodities",
        raw,
        commodity_quote_ttl(),
        lambda: cockpit_live.futures_quotes(raw),
        valid=lambda d: isinstance(d, (dict, list)) and bool(d),
    )
    return data if isinstance(data, (dict, list)) and data else {}


def put_light_kline(sym: str, res: str = "1", num: int = 240) -> dict:
    """Fetch and write the same key GET /light-kline uses. Warmup only."""
    resolved = astock.resolve_symbol(sym) or (sym or "").strip()
    if not resolved:
        return {}
    data = put_fetch(
        f"ashare_light:{res}:{num}",
        resolved,
        light_kline_ttl(resolved, res),
        lambda: astock.light_kline(resolved, res, num=num),
        valid=lambda d: isinstance(d, dict) and bool(d),
    )
    return data if isinstance(data, dict) else {}


def light_kline_map(codes: list[str], res: str = "1", num: int = 240) -> dict[str, dict | None]:
    """Batch light kline. Same cache keys as GET /astock/light-kline. Max 40."""
    seen: set[str] = set()
    jobs: list[tuple[str, str]] = []
    out: dict[str, dict | None] = {}
    for raw in codes:
        key = (raw or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        if len(jobs) >= 40:
            break
        try:
            sym = _validate_symbol(key)
        except HTTPException:
            out[key] = None
            continue
        jobs.append((key, sym))

    def _one(pair: tuple[str, str]) -> tuple[str, str, dict | None]:
        raw, sym = pair
        data = serve_light_kline(sym, res, num)
        return raw, sym, data if isinstance(data, dict) and data else None

    if not jobs:
        return out
    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        for raw, sym, data in pool.map(_one, jobs):
            out[raw] = data
            if sym != raw:
                out[sym] = data
    return out


def _warm_review_dc(paint_only: bool = False) -> tuple[int, int, list[dict]]:
    """Warm app-level caches used by Daily Review (indices / boards / pools / 分时).

    paint_only=True skips Eastmoney-heavy keys so a user snapshot is not
    competing for Eastmoney RTT; Tencent/Sina minute + quote keys still fill.
    """
    import review_jobs

    errors: list[dict] = []
    ok = 0
    steps = review_jobs.warm_dc_jobs(paint_only=paint_only)
    for name, fn in steps:
        try:
            fn()
            ok += 1
        except Exception as e:
            errors.append({"name": name, "error": str(e)[:160]})
    return ok, len(steps) - ok, errors


# Background: keep Daily Review caches warm (session-aware interval).

