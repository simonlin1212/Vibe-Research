"""Downside risk uses shortfall from zero, not dispersion of negative returns."""
import json
import math

import numpy as np
import pandas as pd
import pytest

from backtest.metrics import calc_metrics, equal_weight_hold_curve
from backtest.risk_xray import compute_risk_xray


@pytest.mark.parametrize("returns", [[0, -.01, -.01, -.01], [0, .02, -.01, .03], [0, -.02, .01, -.04]])
def test_sortino_uses_all_observations_and_target_zero(returns):
    equity = pd.Series(100 * np.cumprod(1 + np.asarray(returns)), index=pd.date_range("2024-01-01", periods=len(returns)))
    actual = calc_metrics(equity, [], 100, 252)
    deviation = math.sqrt(sum(min(r, 0) ** 2 for r in returns) / len(returns))
    assert actual["sortino"] == pytest.approx(round(np.mean(returns) / deviation * math.sqrt(252), 4))


@pytest.mark.parametrize("equity", [[100, 110, 120], [], [100], [100, 0, 50]])
def test_sortino_without_defined_denominator_is_missing_not_a_fake_number(equity):
    actual = calc_metrics(pd.Series(equity, dtype=float), [], 100, 252)
    assert actual["sortino"] is None
    json.dumps(actual, allow_nan=False)


def test_risk_xray_constant_daily_loss_has_nonzero_downside_risk():
    prices = pd.DataFrame({"A": 100 * .99 ** np.arange(40)}, index=pd.date_range("2024-01-01", periods=40))
    risk = compute_risk_xray(prices, {"A": 1})
    assert risk["volatility"]["downside_deviation_annualized"] == pytest.approx(.01 * math.sqrt(252))


def test_held_basket_waits_in_cash_and_carries_missing_quotes_without_reallocation():
    panel = pd.DataFrame({"A": [100, 200, np.nan, 100], "B": [np.nan, 50, 100, 50]})
    assert equal_weight_hold_curve(panel).tolist() == pytest.approx([1, 1.5, 2, 1])


@pytest.mark.parametrize("prices", [[0, 1], [np.nan, np.nan], [100, np.inf]])
def test_held_basket_rejects_unvalued_sleeves(prices):
    with pytest.raises(ValueError, match="Cannot value held benchmark"):
        equal_weight_hold_curve(pd.DataFrame({"A": prices}))
