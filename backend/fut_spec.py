"""Parked capital formula. Spec numbers come from qihuo_fee, not a local table.

parked = sum(oi * price * month_margin) * multiplier.
Not review warmup.
"""
from __future__ import annotations

from typing import Any


def _sfloat(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return n


def parked_from_ts(
    ts: Any,
    mult: float,
    margin: float,
    month_margins: dict[str, float] | None = None,
) -> float | None:
    """Sum all months: oi_tday * future_tday * month_margin * mult.

    month_margins keys are YYYYMM. Missing months use margin.
    """
    if not isinstance(ts, dict) or mult <= 0:
        return None
    total = 0.0
    ok = False
    for yyyymm, blk in ts.items():
        if not isinstance(blk, dict):
            continue
        oi = _sfloat(blk.get("oi_tday"))
        px = _sfloat(blk.get("future_tday"))
        if oi is None or px is None or oi <= 0 or px <= 0:
            continue
        m = None
        if month_margins:
            m = month_margins.get(str(yyyymm))
        if m is None:
            m = margin
        if m is None or m <= 0:
            continue
        total += oi * px * m
        ok = True
    if not ok:
        return None
    return total * mult
