"""Global equity (US / HK / Canada) backtest engine.

Market rules:
  US:
    - T+0, long/short allowed
    - Zero commission (retail brokers)
    - Fractional shares supported (round to 0.01)
    - Low slippage (high liquidity)
  HK:
    - T+0, long/short allowed
    - Stamp tax 0.1% bilateral + levies
    - Lot-size rounding (simplified to 100 shares)
    - Higher slippage than US
  Canada (TSX / TSX Venture):
    - Same-session round trips and long/short orders supported
    - Whole shares; odd and mixed lots remain executable
    - Broker commission and slippage are config-driven
    - Official TSX/TSXV price-increment grid is applied to fills

India (NSE/BSE) is handled by the dedicated ``backtest.engines.india_equity``
``IndiaEquityEngine`` (T+1 delivery, circuit bands, STT/stamp/GST stack).
"""

from __future__ import annotations

import math

import pandas as pd

from backtest.engines.base import BaseEngine


class GlobalEquityEngine(BaseEngine):
    """US / HK / Canada equity engine, selected by *market* parameter.

    Config keys:
      - slippage_us: default 0.0005
      - slippage_hk: default 0.001
      - hk_stamp_tax: default 0.001 (0.1% bilateral)
      - hk_commission: default 0.00015 (万1.5)
      - hk_levy: default 0.0000565 (SFC + FRC)
      - hk_settlement: default 0.00002 (CCASS)
      - slippage_ca: defaults to slippage_us
      - ca_commission: broker commission rate, default 0.0
    """

    def __init__(self, config: dict, market: str = "us"):
        config = {**config, "leverage": config.get("leverage", 1.0)}
        super().__init__(config)
        self.market = market

        # US defaults
        self.slippage_us: float = config.get("slippage_us", 0.0005)
        # HK defaults
        self.slippage_hk: float = config.get("slippage_hk", 0.001)
        self.hk_stamp_tax: float = config.get("hk_stamp_tax", 0.001)
        self.hk_commission: float = config.get("hk_commission", 0.00015)
        self.hk_levy: float = config.get("hk_levy", 0.0000565)
        self.hk_settlement: float = config.get("hk_settlement", 0.00002)
        # Canada defaults. Commission varies by broker, so the model exposes a
        # rate instead of inventing an exchange-wide charge.
        self.slippage_ca: float = config.get("slippage_ca", self.slippage_us)
        self.ca_commission: float = config.get("ca_commission", 0.0)

    def can_execute(self, symbol: str, direction: int, bar: pd.Series) -> bool:
        """US/HK/Canada: same-session trading, both directions allowed."""
        return True

    def round_size(self, raw_size: float, price: float) -> float:
        """US: fractional; HK: 100-share lots; Canada: whole shares.

        TSX and TSXV accept odd and mixed lots through dedicated facilities,
        so forcing every order to a board lot would reject valid retail trades.
        The exchange still has no native fractional-share order, hence the
        whole-share floor.
        """
        if self.market == "hk":
            return max(int(raw_size / 100) * 100, 0)
        if self.market == "ca":
            return float(math.floor(max(raw_size, 0.0)))
        # Target sizing must not round up into a cash deficit.
        return math.floor(max(raw_size, 0.0) * 100) / 100

    def calc_commission(self, size: float, price: float, _direction: int, is_open: bool) -> float:
        """US: zero; HK: stamp tax + levies; Canada: configured broker rate.

        ``_direction`` is unused — reserved for future short-borrow fees
        (US Reg-T margin, HK SBL costs).
        """
        if self.market == "hk":
            notional = size * price
            comm = notional * self.hk_commission       # broker commission
            comm += notional * self.hk_stamp_tax       # stamp tax bilateral
            comm += notional * self.hk_levy            # SFC + FRC levies
            comm += notional * self.hk_settlement      # CCASS settlement
            return comm
        if self.market == "ca":
            return size * price * self.ca_commission
        # US: zero commission (SEC fee negligible)
        return 0.0

    def apply_slippage(self, price: float, direction: int) -> float:
        """Apply market slippage and Canada's official price-increment grid."""
        if self.market == "hk":
            rate = self.slippage_hk
        elif self.market == "ca":
            rate = self.slippage_ca
        else:
            rate = self.slippage_us
        slipped = price * (1 + direction * rate)
        if self.market != "ca":
            return slipped

        # TSX/TSXV standard increments: $0.005 below $0.50, otherwise $0.01.
        # Round against the trader: buys/cover orders up, sells/shorts down.
        tick = 0.005 if slipped < 0.50 else 0.01
        units = slipped / tick
        if direction > 0:
            steps = math.ceil(units - 1e-12)
        elif direction < 0:
            steps = math.floor(units + 1e-12)
        else:
            steps = round(units)
        return round(steps * tick, 3 if tick == 0.005 else 2)
