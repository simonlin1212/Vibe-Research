"""回测的 JSON 入口 —— 界面与命令行共用这一个。

    echo '{"codes":["600519.SH"],"start":"2022-01-01","end":"2025-12-31",
           "style":"long","strategy":"ma_cross","params":{"fast":20,"slow":60}}' \
      | python -m backtest.cli

stdout 只出一份 JSON。三种结果**分得清**：

    {"ok": true,  "result": {...}}                 跑完了
    {"ok": false, "refused": {reason, remedy}}     闸口拦住了（**这不是错误**，是结论）
    {"ok": false, "error": "..."}                  真出错了

🔴 「被闸口拦住」与「出错了」必须分开：前者是产品在做它该做的事（说清楚这个回测为什么
   不成立），后者是我们的问题。混成一个 error，界面就只能显示"失败了"，
   而用户真正需要看到的是那句"为什么不成立、怎么才能跑"。
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import traceback
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backtest.gate import Plan, plan_backtest  # noqa: E402
from backtest.run import BacktestNotValid, Result, run  # noqa: E402
from backtest.strategies import BUILTIN  # noqa: E402
from backtest.stdio_utf8 import force_utf8_stdio  # noqa: E402
from backtest.loader import price_basis  # noqa: E402


def _catalog() -> dict:
    """界面要用的选项表 —— **由这里下发，前端不写死一份**。

    写死的那份迟早与真实实现对不上，而对不上的表现是「选了没反应」或者
    「真实存在的选项不在列表里」，两种都看不出是配置漂移。
    """
    from backtest.gate import MARKETS, STYLES
    return {
        # The model assembles this JSON; option labels alone do not tell it that
        # a ticker must be passed as codes: ["AAPL"], not symbol/ticker/code.
        "input_schema": {
            "type": "object", "additionalProperties": False,
            "required": ["codes", "start", "end"],
            "properties": {
                "codes": {"type": "array", "minItems": 1, "items": {"type": "string"},
                          "description": "标的代码数组，例如 AAPL、600519.SH、00700.HK。字段必须叫 codes，不是 symbol。"},
                "start": {"type": "string", "format": "date", "description": "起始日期 YYYY-MM-DD"},
                "end": {"type": "string", "format": "date", "description": "结束日期 YYYY-MM-DD"},
                "style": {"type": "string", "enum": list(STYLES), "default": "swing"},
                "strategy": {"type": "string", "enum": list(BUILTIN), "default": "buy_and_hold"},
                "params": {"type": "object", "description": "所选策略的参数，按 strategies 对应 params 填写；无参数用 {}。"},
                "initial_cash": {"type": "number", "exclusiveMinimum": 0, "default": 1000000},
                "allow_short": {"type": "boolean", "default": False},
            },
        },
        "example_request": {
            "codes": ["AAPL"], "start": "2021-01-01", "end": "2025-12-31", "style": "swing",
            "strategy": "ma_cross", "params": {"fast": 20, "slow": 60}, "initial_cash": 100000,
            "allow_short": False,
        },
        "styles": [
            {"key": s.key, "label": s.label, "holding": s.holding,
             "interval": s.interval, "min_bars": s.min_bars, "why_min": s.why_min}
            for s in STYLES.values()
        ],
        "markets": [
            {"key": m.key, "label": m.label, "can_short": m.can_short,
             "same_day_roundtrip": m.same_day_roundtrip, "price_limit": m.price_limit,
             "lot": m.lot, "fees": m.fees, "currency": m.currency}
            for m in MARKETS.values()
        ],
        "strategies": [
            {"key": "buy_and_hold", "label": "买入持有", "params": {},
             "note": "恒定目标权重的历史对照；不代表未来表现。"},
            {"key": "ma_cross", "label": "均线交叉",
             "params": {"fast": {"default": 20, "label": "快线"}, "slow": {"default": 60, "label": "慢线"}},
             "note": "快线在慢线上方时目标权重为 1，下方为 0；多标的时均分权重。"},
            {"key": "rsi_reversion", "label": "RSI 均值回归",
             "params": {"window": {"default": 14, "label": "窗口"},
                        "buy_below": {"default": 30, "label": "买入线"},
                        "sell_above": {"default": 70, "label": "卖出线"}},
             "note": "RSI 低于下阈值时目标权重为 1，高于上阈值时为 0；中间保留前值，多标的均分。"},
        ],
    }


def _plan_view(p: Plan) -> dict:
    return {"codes": p.codes, "market": p.market.label, "engine": p.market.engine,
            "style": p.style.label, "start": p.start, "end": p.end,
            "limits": p.limits, "notes": p.notes}


def _result_view(r: Result) -> dict:
    m = r.metrics
    keep = ("total_return", "annual_return", "max_drawdown", "sharpe", "calmar", "sortino",
            "win_rate", "profit_loss_ratio", "profit_factor", "trade_count",
            "avg_holding_days", "benchmark_return", "benchmark_ticker",
            "total_turnover", "max_consecutive_loss")
    benchmark_is_self = "benchmark_ticker" not in m
    disclosures = [price_basis(r.plan.market.key)]
    if benchmark_is_self:
        disclosures.append("本次基准是所测标的自身的等权买入持有，不是独立外部基准。")
    turnover = m.get("total_turnover")
    if isinstance(turnover, (int, float)) and turnover < 1:
        disclosures.append(
            f"总换手率为 {turnover}；该值低于 1，收益差异可能包含未投入现金的影响，不能只归因于策略信号。"
        )
    # 运行后才发现的限制必须进入服务端强制披露；静态口径仍在 plan.notes。
    # 不截断：超出下游披露契约时明确拒绝报告，不能悄悄丢掉风险提示。
    disclosures.extend(note for note in r.notes if note not in r.plan.notes)
    disclosures = list(dict.fromkeys(disclosures))
    return {
        "strategy": r.strategy,
        "plan": _plan_view(r.plan),
        # 只挑界面要用的,并**原样透传** —— 不在这里做换算或四舍五入,
        # 免得同一个数在报告与界面上不一致
        "metrics": {k: m[k] for k in keep if k in m},
        # 基准是**等权买入持有这几只标的本身**,除非 metrics 里带了 benchmark_ticker
        "benchmark_is_self": benchmark_is_self,
        "required_disclosures": disclosures,
        "missing": r.missing,
        "provenance": [
            {"code": p.code, "endpoint": p.endpoint, "rows": p.rows,
             "first_bar": p.first_bar, "last_bar": p.last_bar, "note": p.note,
             "price_basis": p.price_basis or price_basis(p.market)}
            for p in r.provenance.values()
        ],
    }


def main() -> None:
    # 🔴 **必须在打任何 JSON 之前**：中文 Windows 的管道默认 GBK，
    #    含 \xa0 会当场崩、其余中文会变成 Node 按 UTF-8 读不懂的字节（上游 issue #27）。
    force_utf8_stdio()
    raw = sys.stdin.read()
    try:
        req: dict[str, Any] = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"入参不是合法 JSON:{exc}"}, ensure_ascii=False))
        return

    if req.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": _catalog()}, ensure_ascii=False))
        return

    try:
        plan = plan_backtest(
            codes=req.get("codes") or [],
            start=str(req.get("start") or ""),
            end=str(req.get("end") or ""),
            style=str(req.get("style") or "swing"),
            initial_cash=req.get("initial_cash", 1_000_000),
            allow_short=bool(req.get("allow_short")),
        )
        if not isinstance(plan, Plan):
            # 闸口拦住 ≠ 出错。把 reason / remedy 原样交给界面。
            return print(json.dumps(
                {"ok": False, "refused": {"reason": plan.reason, "remedy": plan.remedy}},
                ensure_ascii=False))

        key = str(req.get("strategy") or "buy_and_hold")
        if key not in BUILTIN:
            return print(json.dumps(
                {"ok": False, "error": f"没有这个策略:{key}(可用:{', '.join(BUILTIN)})"},
                ensure_ascii=False))
        strategy = BUILTIN[key](**(req.get("params") or {}))

        # 🔴 引擎会往 stdout 打整份 metrics JSON —— 不接住的话,
        #    我们这份 JSON 前面会多出一坨,调用方 parse 直接失败。
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            result = run(plan, strategy)
        print(json.dumps({"ok": True, "result": _result_view(result)}, ensure_ascii=False))

    except BacktestNotValid as exc:
        # 运行期守卫拦下的,与闸口同一类结论(数据到手后才知道的那部分)
        print(json.dumps({"ok": False, "refused": {"reason": str(exc), "remedy": "按上面的说明调整参数再试"}},
                         ensure_ascii=False))
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                          "trace": traceback.format_exc()[-800:]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
