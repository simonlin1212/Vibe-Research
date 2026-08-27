"""CTFI latest: official page parse, one cache key, not warmup / quote hub."""
from __future__ import annotations

import inspect

import ctfi
import review_jobs
from routers.market_routes import market_ctfi, market_ctfi_img

SAMPLE = """
<div class="title2">
            <tr>中国进口原油运价指数 CHINA IMPORT CRUDE OIL TANKER FREIGHT INDEX</tr>
            <tr><br>2026-08-27</tr>
        </div>
            <tr>
                <td>综合指数</td>
                <td></td>
                <td></td>
                <td align="center">点</td>
                <td align="center">100%</td>
                <td align="center">7254.60</td>
                <td align="center">13.43</td>
            </tr>
            <tr>
                <td rowspan="5">中东湾拉斯坦努拉—中国宁波(CT1)<br/>ME Gulf Ras Tannura to China Ningbo(CT1)</td>
                <td rowspan="5">270000MT</td>
                <td rowspan="5">VLCC</td>
                <td align="center">点</td>
                <td rowspan="5" align="center">60%</td>
                <td align="center">9079.96</td>
                <td align="center">114.32</td>
            </tr>
            <tr>
                <td rowspan="5">西非马隆格/ 杰诺—中国宁波(CT2)<br/> West Africa Malongo and Djeno to China Ningbo(CT2)</td>
                <td rowspan="5">260000MT</td>
                <td rowspan="5">VLCC</td>
                <td align="center">点</td>
                <td rowspan="5" align="center">40%</td>
                <td align="center">4516.56</td>
                <td align="center">-137.91</td>
            </tr>
"""


def test_parse_composite_and_routes():
    out = ctfi.parse_page(SAMPLE)
    assert out["date"] == "2026-08-27"
    assert out["price"] == 7254.60
    assert out["chg"] == 13.43
    assert out["pct"] == 0.19
    assert out["routes"]["CT1"] == 9079.96
    assert out["routes"]["CT2"] == 4516.56
    assert "CT1 9079.96" in (out["extra"] or "")
    assert ctfi.latest_ok(out)
    assert out["url"] == ctfi.PAGE


def test_parse_rejects_empty():
    try:
        ctfi.parse_page("<html></html>")
    except ValueError as e:
        assert "composite" in str(e)
    else:
        raise AssertionError("expected ValueError")


def test_img_ok_wants_png():
    assert not ctfi.img_ok(b"")
    assert not ctfi.img_ok(b"<html>")
    assert ctfi.img_ok(ctfi._PNG + b"x" * 200)


def test_http_shares_ctfi_key_not_warmup():
    route = inspect.getsource(market_ctfi)
    img = inspect.getsource(market_ctfi_img)
    assert '_cached("ctfi", "latest"' in route
    assert '_cached("ctfi", "img"' in img
    live = inspect.getsource(review_jobs.live_jobs)
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    assert '"ctfi"' not in live
    assert "ctfi" not in warm
