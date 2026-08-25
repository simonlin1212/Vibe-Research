"""Daily Review cache warmup — keep hot paths filled so the first UI paint is fast.

Design:
- Daemon thread, same style as portfolio.start_scheduler.
- Session-aware interval: denser in A-share continuous auction, sparse otherwise.
- Only warms shared market caches (no per-user watchlist / no stock-specific K lines).
- Disable with VR_REVIEW_WARMUP=0.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator

import trading_calendar

BEIJING = timezone(timedelta(hours=8))
log = logging.getLogger("review_warmup")

# Snapshot / user fetches set this so a warmup pass does not start while the
# UI is already filling the same Eastmoney quota.
_user_fetches = 0
_user_lock = threading.Lock()


@contextmanager
def user_fetch() -> Iterator[None]:
    """Mark a user-facing review fetch so warmup can yield the Eastmoney lock."""
    global _user_fetches
    with _user_lock:
        _user_fetches += 1
    try:
        yield
    finally:
        with _user_lock:
            _user_fetches -= 1


def user_busy() -> bool:
    with _user_lock:
        return _user_fetches > 0

# last run snapshot for /api/market/review-warmup
_STATE: dict[str, Any] = {
    "enabled": False,
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_ok": 0,
    "last_fail": 0,
    "last_errors": [],
    "session": None,
    "next_interval_sec": None,
    "last_minute_at": None,
    "minute_interval_sec": None,
}


def _env_flag(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(30, int(raw))
    except ValueError:
        return default


def session_kind(now: datetime | None = None) -> str:
    """Rough A-share session: open | lunch | closed (Beijing, trading days)."""
    now = now or datetime.now(BEIJING)
    if now.tzinfo is None:
        now = now.replace(tzinfo=BEIJING)
    else:
        now = now.astimezone(BEIJING)
    if not trading_calendar.is_cn_trading_day(now):
        return "closed"
    hm = now.hour * 100 + now.minute
    # match frontend ashareSession: auction + continuous
    if 915 <= hm < 1130:
        return "open"
    if 1130 <= hm < 1300:
        return "lunch"
    if 1300 <= hm <= 1505:
        return "open"
    return "closed"


def interval_for_session(kind: str) -> int:
    if kind == "open":
        return _env_int("VR_REVIEW_WARMUP_OPEN_SEC", 90)
    if kind == "lunch":
        return _env_int("VR_REVIEW_WARMUP_LUNCH_SEC", 300)
    return _env_int("VR_REVIEW_WARMUP_CLOSED_SEC", 900)


def minute_interval_for_session(kind: str) -> int:
    """Keep-warm cadence. Closed TTL still outlasts this; open index minutes are 4s."""
    if kind == "open":
        return 20
    return 60


def _run_step(name: str, fn: Callable[[], Any], errors: list[dict]) -> bool:
    try:
        fn()
        return True
    except Exception as e:
        errors.append({"name": name, "error": str(e)[:160]})
        log.warning("warmup step %s failed: %s", name, e)
        return False


def warm_market() -> tuple[int, int, list[dict]]:
    """Fill market.py TTL caches used by 复盘 top rows."""
    import market

    errors: list[dict] = []
    ok = 0
    def _breadth():
        import cross_section

        return cross_section.market_breadth()

    steps = (
        ("overview", market.put_overview),
        ("emotion", market.put_emotion),
        ("breadth", _breadth),
    )
    for name, fn in steps:
        if _run_step(name, fn, errors):
            ok += 1
    return ok, len(steps) - ok, errors


def warm_once(extra: Callable[..., tuple[int, int, list[dict]]] | None = None) -> dict:
    """One warmup pass. extra(paint_only=) warms app-level _DC_CACHE entries.

    When a user snapshot is in flight, skip Eastmoney-heavy market steps but
    still fill Tencent/Sina minute keys so the first charts are not empty.
    """
    busy = user_busy()
    if busy:
        log.info("user snapshot in flight: skip EM warmup, keep minute keys")
        _STATE["skipped"] = True
    else:
        _STATE.pop("skipped", None)

    _STATE["running"] = True
    _STATE["last_started"] = datetime.now(BEIJING).isoformat(timespec="seconds")
    kind = session_kind()
    _STATE["session"] = kind

    ok, fail, errors = (0, 0, []) if busy else warm_market()
    if extra is not None:
        try:
            e_ok, e_fail, e_err = extra(paint_only=busy)
            ok += e_ok
            fail += e_fail
            errors.extend(e_err)
        except Exception as e:
            fail += 1
            errors.append({"name": "extra", "error": str(e)[:160]})

    try:
        import review_jobs
        m_ok, m_fail, m_err = review_jobs.warm_minutes()
        ok += m_ok
        fail += m_fail
        errors.extend(m_err)
        _STATE["last_minute_at"] = datetime.now(BEIJING).isoformat(timespec="seconds")
        _STATE["minute_interval_sec"] = minute_interval_for_session(kind)
    except Exception as e:
        fail += 1
        errors.append({"name": "minutes", "error": str(e)[:160]})

    if not busy:
        try:
            import review_context
            review_context.archive_from_bundle()
        except Exception:
            log.warning("review archive skipped", exc_info=True)

    _STATE["last_ok"] = ok
    _STATE["last_fail"] = fail
    _STATE["last_errors"] = errors[-12:]
    _STATE["last_finished"] = datetime.now(BEIJING).isoformat(timespec="seconds")
    _STATE["next_interval_sec"] = interval_for_session(kind)
    _STATE["running"] = False
    return dict(_STATE)


def status() -> dict:
    return {
        **_STATE,
        "session_now": session_kind(),
        "open_sec": _env_int("VR_REVIEW_WARMUP_OPEN_SEC", 90),
        "lunch_sec": _env_int("VR_REVIEW_WARMUP_LUNCH_SEC", 300),
        "closed_sec": _env_int("VR_REVIEW_WARMUP_CLOSED_SEC", 900),
        "minute_open_sec": 20,
        "minute_closed_sec": 60,
        "trading_day": trading_calendar.is_cn_trading_day(),
    }


def start_scheduler(
    extra: Callable[..., tuple[int, int, list[dict]]] | None = None,
    initial_delay: float = 3.0,
) -> None:
    """Start daemon warmup loop. No-op when VR_REVIEW_WARMUP=0."""
    if not _env_flag("VR_REVIEW_WARMUP", True):
        _STATE["enabled"] = False
        log.info("review warmup disabled (VR_REVIEW_WARMUP=0)")
        return

    _STATE["enabled"] = True

    def loop() -> None:
        time.sleep(max(0.5, initial_delay))
        next_full = 0.0
        next_minute = 0.0
        while True:
            now = time.monotonic()
            kind = session_kind()
            if now >= next_full:
                try:
                    warm_once(extra=extra)
                except Exception:
                    log.exception("review warmup pass crashed")
                delay = 5 if _STATE.get("skipped") else interval_for_session(session_kind())
                _STATE["next_interval_sec"] = delay
                next_full = time.monotonic() + delay
                next_minute = time.monotonic() + minute_interval_for_session(session_kind())
            elif now >= next_minute:
                try:
                    import review_jobs
                    m_ok, m_fail, m_err = review_jobs.warm_minutes()
                    _STATE["last_minute_at"] = datetime.now(BEIJING).isoformat(timespec="seconds")
                    _STATE["minute_interval_sec"] = minute_interval_for_session(kind)
                    if m_fail:
                        _STATE["last_errors"] = (list(_STATE.get("last_errors") or []) + m_err)[-12:]
                    log.info("minute keep-warm ok=%s fail=%s", m_ok, m_fail)
                except Exception:
                    log.exception("minute keep-warm crashed")
                next_minute = time.monotonic() + minute_interval_for_session(session_kind())
            time.sleep(1)

    threading.Thread(target=loop, name="review-warmup", daemon=True).start()
    log.info("review warmup started")
