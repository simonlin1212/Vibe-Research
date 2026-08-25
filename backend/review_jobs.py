"""One job list for 复盘快照, warmup, mail, and 问 AI.

Callers ask for jobs; they do not keep their own panel lists.
Cache keys match GET /api/market/* so a warm pass fills 问 AI.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from api_common import (
    BOARD_FLOW_N,
    BOARD_FLOW_TTL,
    _DC_CACHE,
    _cached,
    _put,
    _read,
    commodity_quote_ttl,
    put_commodities,
    put_fetch,
    put_light_kline,
)
from index_catalog import catalog_codes

Job = tuple[str, Callable[[], Any]]


def _clock(write: bool):
    return put_fetch if write else _read


PAINT_SAFE_COCKPIT = frozenset({
    "world_indices",
    "sector_boards",
    "stock_rank",
})


def tencent_jobs() -> list[Job]:
    import astock_boards

    return [
        ("hsgt", lambda: _read("hsgt", "live", 120, astock_boards.hsgt_realtime)),
    ]


def overview_jobs() -> list[Job]:
    import market

    return [("overview", market.get_overview)]


def em_top_jobs(*, write: bool = False) -> list[Job]:
    import astock
    import market

    op = _clock(write)
    return [
        ("emotion", market.get_short_term_emotion),
        (
            "industry",
            lambda: op(
                "industry",
                "20",
                300,
                lambda: astock.industry_comparison(top_n=20),
                valid=lambda d: bool(isinstance(d, dict) and d.get("top")),
            ),
        ),
    ]


def em_extra_jobs(*, write: bool = False) -> list[Job]:
    import astock

    op = _clock(write)
    return [
        (
            "lhb",
            lambda: op(
                "dt_daily",
                "auto:40:all",
                600,
                lambda: astock.daily_dragon_tiger(None, None, top=40),
            ),
        ),
    ]


def live_jobs(*, sector_kind: str = "01", news_source: str = "cls") -> list[Job]:
    """Panels outside 复盘快照 that 问 AI / mail still need."""
    import astock_boards
    import cockpit_live
    import cross_section
    import fear_greed
    import lives_feed

    kind = "02" if str(sector_kind) == "02" else "01"
    src = str(news_source)
    if src not in ("lives", "jin10"):
        src = "cls"

    def _news() -> list:
        if src == "lives":
            d = _cached("market_lives", "1:40", 8, lambda: lives_feed.market_lives(1, 40))
        elif src == "jin10":
            d = _cached("market_lives", "jin10:40", 8, lambda: lives_feed.jin10_flash(40))
        else:
            return _cls_tg_40()
        items = d.get("items") if isinstance(d, dict) else None
        return items if isinstance(items, list) else []

    return [
        ("world", lambda: _read("world_indices", "live", 20, cockpit_live.world_indices)),
        (
            "sector_up",
            lambda: _read(
                "sector_boards",
                f"{kind}:0:80",
                10,
                lambda: cockpit_live.sector_boards(kind, "0", 80),
            ),
        ),
        (
            "sector_down",
            lambda: _read(
                "sector_boards",
                f"{kind}:1:80",
                10,
                lambda: cockpit_live.sector_boards(kind, "1", 80),
            ),
        ),
        (
            "board_flow",
            lambda: _read(
                "board_flow_ranks",
                str(BOARD_FLOW_N),
                BOARD_FLOW_TTL,
                lambda: cockpit_live.board_flow_intraday(BOARD_FLOW_N, curves=False),
                valid=lambda d: isinstance(d, list) and len(d) > 0,
            ),
        ),
        (
            "rank_hot",
            lambda: _read(
                "stock_rank",
                "amount:0:30",
                20,
                lambda: cockpit_live.stock_rank("amount", 0, 30),
            ),
        ),
        (
            "rank_up",
            lambda: _cached(
                "stock_rank",
                "changepercent:0:30",
                20,
                lambda: cockpit_live.stock_rank("changepercent", 0, 30),
            ),
        ),
        (
            "rank_down",
            lambda: _cached(
                "stock_rank",
                "changepercent:1:30",
                20,
                lambda: cockpit_live.stock_rank("changepercent", 1, 30),
            ),
        ),
        (
            "commodities",
            lambda: _cached(
                "commodities",
                cockpit_live.DEFAULT_FUTURES,
                commodity_quote_ttl(),
                lambda: cockpit_live.futures_quotes(cockpit_live.DEFAULT_FUTURES),
            ),
        ),
        (
            "fear_greed",
            lambda: _cached("fear_greed", "board", 300, fear_greed.board, valid=fear_greed.board_ok),
        ),
        ("news", _news),
        ("breadth", cross_section.market_breadth),
        (
            "money",
            lambda: _read(
                "stock_flow",
                "ALL:15",
                120,
                lambda: astock_boards.stock_moneyflow(15, None),
            ),
        ),
        *money_jobs(),
    ]


def _cls_tg_40(*, write: bool = False) -> list:
    import astock

    op = _clock(write)
    return op("cls_tg", "40", 120, lambda: astock.cls_telegraph(40))


def money_jobs(*, write: bool = False) -> list[Job]:
    """Same keys as GET /shareholder-changes and /market/{etf-flow,lpr,bond-yield,etf-shares}."""
    import astock
    import etf_shares

    op = _clock(write)
    share_key = f"{','.join(etf_shares.DEFAULT_CODES)}:80"
    return [
        (
            "etf_flow",
            lambda: op(
                "etf_flow",
                "net_inflow:40",
                180,
                lambda: astock.etf_fund_flow("net_inflow", 40),
            ),
        ),
        (
            "sh_chg",
            lambda: op(
                "sh_chg",
                "ALL:all:40",
                600,
                lambda: astock.shareholder_changes("", "all", 40),
            ),
        ),
        ("lpr", lambda: op("lpr", "730", 3600, lambda: astock.lpr_rates(730))),
        (
            "bond_y",
            lambda: op(
                "cn_bond_yield",
                "treasury",
                3600,
                lambda: astock.bond_yield_curve("treasury"),
            ),
        ),
        (
            "etf_shares",
            lambda: op(
                "etf_shares_many",
                share_key,
                600,
                lambda: etf_shares.etf_shares_many(list(etf_shares.DEFAULT_CODES), 80),
            ),
        ),
    ]


def watch_quotes(codes: list[str] | None) -> list[dict]:
    """自选价. Same quote_one keys as GET /market/quotes."""
    import cockpit_live

    raw = [str(c).strip() for c in (codes or []) if str(c).strip()][:20]
    if not raw:
        return []
    parsed = cockpit_live.quotes_cached(raw)
    out: list[dict] = []
    for c in raw:
        q = parsed.get(c)
        if isinstance(q, dict) and q.get("price"):
            out.append({
                "name": q.get("name") or c,
                "price": q.get("price"),
                "pct": q.get("pct"),
                "amount": q.get("amount"),
            })
        else:
            out.append({"name": c})
    return out


def warm_dc_jobs(*, paint_only: bool = False) -> list[Job]:
    """App-level _DC_CACHE steps. paint_only skips Eastmoney-heavy keys."""
    import astock_boards
    import cockpit_live

    steps: list[Job] = []
    if not paint_only:
        steps.extend(em_top_jobs(write=True)[1:])  # industry only; emotion is warm_market
        steps.extend(em_extra_jobs(write=True))
        steps.extend(money_jobs(write=True))
        steps.append(("cls_tg", lambda: _cls_tg_40(write=True)))
        steps.append(("hsgt", lambda: put_fetch("hsgt", "live", 120, astock_boards.hsgt_realtime)))

    cockpit: list[Job] = [
        ("world_indices", lambda: put_fetch("world_indices", "live", 20, cockpit_live.world_indices)),
        (
            "sector_boards",
            lambda: put_fetch(
                "sector_boards",
                "01:0:80",
                10,
                lambda: cockpit_live.sector_boards("01", "0", 80),
            ),
        ),
        (
            "sector_boards",
            lambda: put_fetch(
                "sector_boards",
                "01:1:80",
                10,
                lambda: cockpit_live.sector_boards("01", "1", 80),
            ),
        ),
        (
            "stock_rank",
            lambda: put_fetch(
                "stock_rank",
                "amount:0:30",
                20,
                lambda: cockpit_live.stock_rank("amount", 0, 30),
            ),
        ),
        (
            "stock_flow",
            lambda: put_fetch(
                "stock_flow",
                "ALL:15",
                120,
                lambda: astock_boards.stock_moneyflow(15, None),
            ),
        ),
        (
            "board_flow_ranks",
            lambda: put_fetch(
                "board_flow_ranks",
                str(BOARD_FLOW_N),
                BOARD_FLOW_TTL,
                lambda: cockpit_live.board_flow_intraday(BOARD_FLOW_N, curves=False),
                valid=lambda d: isinstance(d, list) and len(d) > 0,
            ),
        ),
        (
            "board_flow_intraday",
            lambda: put_fetch(
                "board_flow_intraday",
                str(BOARD_FLOW_N),
                BOARD_FLOW_TTL,
                lambda: cockpit_live.board_flow_intraday(BOARD_FLOW_N, curves=True),
            ),
        ),
    ]
    if paint_only:
        cockpit = [step for step in cockpit if step[0] in PAINT_SAFE_COCKPIT]
    steps.extend(cockpit)
    return steps


def _peek_codes(endpoint: str, code: str) -> list[str]:
    raw = _DC_CACHE.get_last((endpoint, code))
    rows = raw if isinstance(raw, list) else (raw.get("rows") if isinstance(raw, dict) else None)
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for r in rows:
        if isinstance(r, dict):
            c = str(r.get("code") or "").strip()
            if c:
                out.append(c)
    return out


def minute_symbols() -> list[str]:
    """Shared cockpit minutes: index catalog + cached rank / flow (not watchlist)."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in (
        catalog_codes()
        + _peek_codes("stock_rank", "amount:0:30")
        + _peek_codes("stock_flow", "ALL:15")
    ):
        key = (raw or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def warm_minutes() -> tuple[int, int, list[dict]]:
    """Force-refresh shared minute keys so a page refresh is a cache hit."""
    import cockpit_live

    errors: list[dict] = []
    ok = 0
    fail = 0
    syms = minute_symbols()

    def _one(sym: str) -> tuple[str, bool, str]:
        try:
            data = put_light_kline(sym)
            if not data:
                return sym, False, f"empty minute for {sym}"
            return sym, True, ""
        except Exception as e:
            return sym, False, str(e)[:160]

    if syms:
        with ThreadPoolExecutor(max_workers=min(8, len(syms))) as pool:
            for sym, good, err in pool.map(_one, syms):
                if good:
                    ok += 1
                else:
                    fail += 1
                    errors.append({"name": f"minute:{sym}", "error": err})

    try:
        if put_commodities():
            ok += 1
        else:
            fail += 1
            errors.append({"name": "commodities", "error": "empty"})
    except Exception as e:
        fail += 1
        errors.append({"name": "commodities", "error": str(e)[:160]})

    try:
        raw = cockpit_live.DEFAULT_FUTURES
        data = cockpit_live.future_minutes(
            [c.strip() for c in raw.split(",") if c.strip()],
        )
        if cockpit_live.future_minutes_filled(data):
            _put("commodity_minutes", raw, data, 4)
            ok += 1
        else:
            fail += 1
            errors.append({"name": "commodity_minutes", "error": "empty"})
    except Exception as e:
        fail += 1
        errors.append({"name": "commodity_minutes", "error": str(e)[:160]})

    try:
        n = cockpit_live.warm_hub_quotes(syms)
        if n:
            ok += 1
        else:
            fail += 1
            errors.append({"name": "quotes", "error": "empty"})
    except Exception as e:
        fail += 1
        errors.append({"name": "quotes", "error": str(e)[:160]})
    return ok, fail, errors


def run_jobs(jobs: list[Job], bucket: dict[str, Any], errors: list[str], workers: int = 6) -> None:
    if not jobs:
        return

    def _one(name: str, fn: Callable[[], Any]) -> None:
        try:
            bucket[name] = fn()
        except Exception as e:
            bucket[name] = None
            errors.append(f"{name}: {e}"[:160])

    with ThreadPoolExecutor(max_workers=min(workers, len(jobs))) as pool:
        futs = [pool.submit(_one, name, fn) for name, fn in jobs]
        for fut in futs:
            fut.result()
