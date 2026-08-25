"""9qihuo fee table: parse month margins + multiplier, one key, not warmup."""
from __future__ import annotations

import inspect

import qihuo_fee
import review_jobs
import ovlab


SAMPLE = """
<tr><td><a href='http://www.9qihuo.com/qihuoshouxufeisingle?heyue=au'>黄金2610 (<b>au2610</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >999.86</td><td>1139/859</td>
<td title='多头保证金比例' >16%</td><td title='空头保证金比例' >16%</td>
<td title='每手保证金' >159977.6元</td><td class='fee_hide_obj'>主力合约</td></tr>
<tr><td><a>白银2609 (<b>ag2609</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >16841</td><td>20209/13472</td>
<td title='多头保证金比例' >22%</td><td title='空头保证金比例' >22%</td>
<td title='每手保证金' >55575.3元</td><td class='fee_hide_obj'>主力合约</td></tr>
<tr><td><a>白银2612 (<b>ag2612</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >1</td><td>1/1</td>
<td title='多头保证金比例' >16%</td>
<td title='每手保证金' >2.4元</td></tr>
<tr><td><a>铁矿石2609 (<b>i2609</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >728</td><td>1/1</td>
<td title='多头保证金比例' >11%</td>
<td title='每手保证金' >8008元</td></tr>
<tr><td><a>PTA609 (<b>TA609</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >5912</td><td>1/1</td>
<td title='多头保证金比例' >10%</td>
<td title='每手保证金' >2956元</td></tr>
<tr><td><a>沪深300指数2609 (<b>IF2609</b>)</a></td>
<td title='当前价格（大概价格，不是实时的）' >4512.6</td><td>1/1</td>
<td title='多头保证金比例' >12%</td>
<td title='每手保证金' >162453.6元</td><td class='fee_hide_obj'>主力合约</td></tr>
"""


def test_yyyymm_four_and_czce_three():
    assert qihuo_fee.to_yyyymm("2610", 2026) == "202610"
    assert qihuo_fee.to_yyyymm("609", 2026) == "202609"
    assert qihuo_fee.to_yyyymm("701", 2026) == "202701"
    assert qihuo_fee.to_yyyymm("13", 2026) is None


def test_infer_mult_from_lot_margin():
    assert qihuo_fee.infer_mult(999.86, 0.16, 159977.6) == 1000
    assert qihuo_fee.infer_mult(16841, 0.22, 55575.3) == 15
    assert qihuo_fee.infer_mult(4512.6, 0.12, 162453.6) == 300
    assert qihuo_fee.infer_mult(100, 0.10, 17) is None


def test_parse_table_month_rates_and_mult():
    tab = qihuo_fee.parse_table(SAMPLE, now_year=2026)
    assert qihuo_fee.table_ok(tab)
    assert tab["months"]["AU"]["202610"] == 0.16
    assert tab["months"]["AG"]["202609"] == 0.22
    assert tab["months"]["AG"]["202612"] == 0.16
    assert tab["months"]["I"]["202609"] == 0.11
    assert tab["months"]["TA"]["202609"] == 0.10
    assert tab["months"]["IF"]["202609"] == 0.12
    assert tab["main"]["AU"] == "202610"
    assert tab["mults"]["AU"] == 1000
    assert tab["mults"]["AG"] == 15
    assert tab["mults"]["I"] == 100
    assert tab["mults"]["TA"] == 5
    assert tab["mults"]["IF"] == 300
    assert qihuo_fee.und_margin("AU", tab) == 0.16
    assert qihuo_fee.und_margin("AG", tab) == 0.22
    assert qihuo_fee.und_mult("au", tab) == 1000
    assert qihuo_fee.month_margins("ag", tab)["202609"] == 0.22


def test_margins_inject_fetch():
    out = qihuo_fee.margins(fetch=lambda: SAMPLE)
    assert out["n"] >= 6
    assert out["src"] == qihuo_fee.SRC
    assert out["mults"]["AU"] == 1000


def test_one_key_not_in_review_or_warm():
    src = inspect.getsource(qihuo_fee.margins)
    assert '"table"' in src and "300" in src and "qihuo_fee" in inspect.getsource(qihuo_fee)
    assert "qihuo_fee" in inspect.getsource(ovlab.get_parked_capital)
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    warm_ov = inspect.getsource(ovlab.warm_once)
    assert "qihuo_fee" not in warm
    assert "qihuo_fee" not in live
    assert "qihuo_fee" not in warm_ov
    assert "9qihuo" not in warm
