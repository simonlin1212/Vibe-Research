"""Duanxianxia cockpit HTTP. One cache family dxx. Not review warmup."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException

import dxx
from api_common import _cached, _serve

router = APIRouter(tags=["dxx"])

_PARTS = (
    ("fengdan", 60, "/api/getFengdanLast", dxx.parse_fengdan, dxx.fengdan_ok),
    ("daban", 60, "/api/getDabanData", dxx.parse_daban, dxx.daban_ok),
    ("ztlive", 60, "/api/getZtliveData", dxx.parse_ztlive, dxx.ztlive_ok),
    ("qingxu", 300, "/api/getChartByQingxu", dxx.parse_qingxu, dxx.curve_ok),
    ("qxlive", 60, "/api/getLastQxlive", dxx.parse_qxlive, dxx.curve_ok),
    ("strong", 60, "/api/getLiveByStrong", dxx.parse_strong, dxx.strong_ok),
    ("fupan", 300, "/api/getFupanByYidong", dxx.parse_fupan, dxx.fupan_ok),
    ("wajue", 300, "/api/getWajueMatch", dxx.parse_wajue, dxx.wajue_ok),
)


def _part(code: str, ttl: float, path: str, parse, valid):
    """Expire refetch. Upstream fail serves last fill. Key family dxx."""
    def fetch():
        return parse(dxx._pull(path))

    try:
        data = _cached("dxx", code, ttl, fetch, valid=valid)
        if valid(data):
            return data
    except Exception:
        last = _serve("dxx", code)
        if valid(last):
            return last
        return None
    last = _serve("dxx", code)
    return last if valid(last) else None


@router.get("/api/dxx/board")
def dxx_board():
    """No-login duanxianxia board. Keys dxx/*, 60s live / 300s hist."""
    out = {"src": dxx.SRC}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = {
            code: pool.submit(_part, code, ttl, path, parse, valid)
            for code, ttl, path, parse, valid in _PARTS
        }
        for code, fut in futs.items():
            out[code] = fut.result()
    if not dxx.board_ok(out):
        raise HTTPException(502, "连不上短线侠")
    return {"data": out}
