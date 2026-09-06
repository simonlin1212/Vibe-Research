"""引擎的市场规则测试 —— **不联网**，用构造出来的行情把每条规则单独逼出来。

搬引擎的全部理由就是这些规则（T+1 / 涨跌停 / 整手 / 印花税）。
只跑一遍真实回测证明不了它们在起作用 —— 真实数据里这些条件很少同时出现，
出现了也看不出是哪条生效。所以这里一条一条造场景。
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
from pathlib import Path

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest.engines.china_a import ChinaAEngine, _price_limit  # noqa: E402
from backtest.engines.global_equity import GlobalEquityEngine  # noqa: E402


def frame(closes, opens=None, pre=None):
    """造一段日线。索引一律 datetime64[ns] —— 与取数层出口同口径。"""
    idx = pd.date_range("2024-01-02", periods=len(closes), freq="B").astype("datetime64[ns]")
    o = opens if opens is not None else closes
    df = pd.DataFrame({"open": o, "high": [max(a, b) for a, b in zip(o, closes)],
                       "low": [min(a, b) for a, b in zip(o, closes)],
                       "close": closes, "volume": [1e7] * len(closes)}, index=idx)
    if pre is not None:
        df["pre_close"] = pre
    return df


class FrameLoader:
    """把现成的 DataFrame 直接喂进去 —— 引擎那条缝只要 fetch()。"""
    name = "test"

    def __init__(self, frames): self.frames = frames
    def fetch(self, codes, start, end, fields=None, interval="1D"):
        return {c: self.frames[c] for c in codes if c in self.frames}


class Signals:
    def __init__(self, sig): self.sig = sig
    def generate(self, data_map): return self.sig


def run_engine(engine, frames, signals, cash=1_000_000.0):
    cfg = {"codes": list(frames), "initial_cash": cash, "start_date": "2024-01-02",
           "end_date": "2025-12-31", "interval": "1D", "position_adjustment": "rebalance"}
    eng = engine({**cfg})
    with contextlib.redirect_stdout(io.StringIO()):   # 引擎会往 stdout 打 metrics JSON
        m = eng.run_backtest(config=cfg, loader=FrameLoader(frames), signal_engine=Signals(signals),
                             run_dir=Path(tempfile.mkdtemp()), bars_per_year=252)
    return eng, m


# ── T+1 ──

def test_default_benchmark_holds_initial_equal_shares_without_daily_rebalancing():
    a, b = frame([100., 200., 100.]), frame([100., 100., 100.])
    _, metrics = run_engine(GlobalEquityEngine, {"A": a, "B": b},
                            {"A": pd.Series(0., index=a.index), "B": pd.Series(0., index=b.index)})
    assert metrics["benchmark_return"] == pytest.approx(0), "daily rebalancing incorrectly yields 12.5%"


def test_a_share_cannot_sell_on_the_day_it_bought():
    """信号第 2 天叫买、第 3 天叫卖。买入在第 3 天开盘成交（信号后移一根），
    卖出信号落在第 4 天开盘 —— 这里验的是引擎**不会**把两者压到同一天。"""
    px = [100.0] * 8
    df = frame(px)
    sig = pd.Series([0, 1, 0, 0, 0, 0, 0, 0], index=df.index, dtype=float)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    entries = [t for t in eng.trades]
    assert entries, "应当有一笔完整交易"
    t = entries[0]
    assert t.entry_time.date() != t.exit_time.date(), "A股 T+1：买入与卖出不能在同一天"


def test_us_may_round_trip_same_day():
    """对照组：美股 T+0。同样的信号，规则不同结论就该不同 ——
    否则"T+1 生效了"这个结论其实没被证明（可能只是信号本来就跨天）。"""
    eng = GlobalEquityEngine({"initial_cash": 1e6})
    bar = pd.Series({"open": 100.0, "close": 100.0})
    assert eng.can_execute("AAPL", 1, bar) is True


# ── 整手 ──

@pytest.mark.parametrize("raw,expect", [(1234.0, 1200), (99.0, 0), (100.0, 100), (250.5, 200)])
def test_a_share_rounds_down_to_100_lots(raw, expect):
    assert ChinaAEngine({}).round_size(raw, 10.0) == expect


def test_us_allows_fractional_shares():
    assert GlobalEquityEngine({}).round_size(1234.56, 10.0) > 1234


def test_us_fractional_sizing_never_exceeds_target():
    assert GlobalEquityEngine({}).round_size(123.456, 10.0) == 123.45


@pytest.mark.parametrize("market,code,price", [
    ("us", "AAPL", 123.456), ("hk", "00700.HK", 100.0),
    ("cn", "600519.SH", 100.0),
])
def test_full_target_reserves_real_fees_without_negative_cash(market, code, price):
    df = frame([price] * 8)
    sig = pd.Series([1.0] * 8, index=df.index)
    engine = (lambda cfg: ChinaAEngine({**cfg, "slippage": 0})) if market == "cn" else (
        lambda cfg: GlobalEquityEngine({**cfg, "slippage_hk": 0, "slippage_us": 0}, market))
    eng, _ = run_engine(engine, {code: df}, {code: sig}, cash=100_000)
    assert eng.fill_records
    assert all(s.capital >= -1e-8 for s in eng.equity_snapshots)
    assert eng.capital <= 100_000, "恒定行情不能因忽略费用而产生收益"


def test_fee_budget_is_shared_by_basket_not_symbol_order():
    df = frame([100.0] * 6)
    sig = pd.Series([0.5] * 6, index=df.index)
    filled = []
    for codes in [("A", "B"), ("B", "A")]:
        eng, _ = run_engine(lambda cfg: GlobalEquityEngine({**cfg, "slippage_hk": 0}, "hk"),
                            {c: df for c in codes}, {c: sig for c in codes}, cash=100_000)
        first = {f.symbol: f.signed_quantity for f in eng.fill_records if f.bar_idx == 1}
        assert first["A"] == first["B"]
        filled.append(first)
    assert filled[0] == filled[1]


# ── 费用：印花税只在卖出 ──

def test_stamp_tax_only_on_sell():
    eng = ChinaAEngine({})
    size, price = 10_000, 100.0
    buy = eng.calc_commission(size, price, 1, is_open=True)
    sell = eng.calc_commission(size, price, -1, is_open=False)
    notional = size * price
    assert sell - buy == pytest.approx(notional * 0.0005, rel=1e-9), "卖出应恰好多一道万5 印花税"


def test_commission_floor_of_five_yuan():
    """小额交易按最低 5 元收 —— 不设下限的话，小资金高频回测的费用会被系统性低估。"""
    eng = ChinaAEngine({})
    assert eng.calc_commission(100, 1.0, 1, is_open=True) >= 5.0


# ── 涨跌停 ──

@pytest.mark.parametrize("code,limit", [
    ("600519.SH", 0.10), ("000001.SZ", 0.10), ("300308.SZ", 0.20),
    ("688981.SH", 0.20), ("689009.SH", 0.20), ("830799.BJ", 0.30),
    ("301001.SZ", 0.20), ("302001.SZ", 0.20), ("430047.BJ", 0.30), ("920001.BJ", 0.30),
])
def test_price_limit_by_board(code, limit):
    assert _price_limit(code) == limit


@pytest.mark.parametrize("code,day,opening,allowed", [
    ("300308.SZ", "2020-08-21", 115, False),
    ("300308.SZ", "2020-08-24", 115, True),
    ("301001.SZ", "2025-01-02", 115, True),
    ("301001.SZ", "2025-01-02", 120, False),
    ("430047.BJ", "2025-01-02", 125, True),
    ("920001.BJ", "2025-01-02", 130, False),
])
def test_actual_fill_uses_board_and_historical_date(code, day, opening, allowed):
    bar = pd.Series({"open": opening, "close": opening, "pre_close": 100}, name=pd.Timestamp(day))
    assert ChinaAEngine({"slippage": 0}).can_execute(code, 1, bar) is allowed


def test_limit_up_bar_blocks_the_buy():
    """开盘就一字涨停（开=前收×1.1）时买不进去。
    ⚠️ 判据用**前收**，不是当日收盘 —— 用收盘判就是未来函数。"""
    eng = ChinaAEngine({})
    bar = pd.Series({"open": 110.0, "close": 110.0, "pre_close": 100.0})
    assert eng.can_execute("600519.SH", 1, bar) is False, "涨停封死应当买不进"
    normal = pd.Series({"open": 101.0, "close": 110.0, "pre_close": 100.0})
    # 开盘没封死、只是收盘涨停 —— 这一档必须能成交，否则就是拿收盘价做决策
    assert eng.can_execute("600519.SH", 1, normal) is True


def test_a_share_refuses_short():
    assert ChinaAEngine({}).can_execute("600519.SH", -1, pd.Series({"open": 10.0, "close": 10.0})) is False


# ── 未来函数 ──

def test_signal_is_shifted_by_one_bar():
    """第 1 天就给满仓信号，成交必须落在第 2 天开盘 ——
    若能在第 1 天成交，就是拿当天收盘算出来的信号在当天成交，回测会凭空变好看。"""
    # ⚠️ 涨幅要在涨跌停带以内。第一版这里写了 100 → 200（一天翻倍），
    #    引擎按前收算出带 [90,110] 正确拒了单 —— 是**测试数据不合法**，不是引擎错。
    df = frame([100.0, 103.0, 103.0, 103.0, 103.0])
    sig = pd.Series([1.0, 1.0, 1.0, 1.0, 1.0], index=df.index)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    assert eng.fill_records, "应当有成交"
    first = eng.fill_records[0]
    assert first.timestamp.date() == df.index[1].date(), "首笔成交应在第 2 根 bar"
    # 100 → 103 那一段不能被吃到：在第 2 根的价位买入，赚不到这 3%
    assert first.execution_price >= 103.0


def test_limit_band_blocks_an_impossible_gap():
    """上一条的副产品，单独立起来：第 2 根直接翻倍时应当买不进 ——
    这正是「用前收判涨跌停」在起作用的证据。"""
    df = frame([100.0, 200.0, 200.0, 200.0, 200.0])
    sig = pd.Series([1.0, 1.0, 1.0, 1.0, 1.0], index=df.index)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    assert not any(f.bar_idx == 1 for f in eng.fill_records), "一字涨停那根不该有成交"


# ── 策略参数校验（Codex 审计 r2 · P2）──

@pytest.mark.parametrize("kw", [dict(fast=0, slow=60), dict(fast=-5, slow=60),
                                dict(fast=20, slow=20), dict(fast=60, slow=20)])
def test_ma_cross_rejects_bad_windows(kw):
    from backtest.strategies import MaCross
    with pytest.raises(ValueError):
        MaCross(**kw)


@pytest.mark.parametrize("kw", [dict(window=0), dict(window=1),
                                dict(buy_below=70, sell_above=30), dict(buy_below=-1),
                                dict(sell_above=101), dict(buy_below=50, sell_above=50)])
def test_rsi_rejects_bad_params(kw):
    """阈值反了不会报错，只会静默生成一个「永不进场」的策略 —— 回测跑完给零成交。"""
    from backtest.strategies import RsiReversion
    with pytest.raises(ValueError):
        RsiReversion(**kw)
