"""把闸口、取数、引擎接起来 —— 回测的对外入口。

    plan = plan_backtest(codes=["600519.SH"], start="2022-01-01", end="2025-12-31", style="long")
    if not plan:            # Refusal 的 __bool__ 是 False
        print(plan.reason); return
    result = run(plan, MaCross(20, 60))

🔴 **限制随结果一起走**（``Result.limits``）。回测结果最容易被误读的地方不是数字算错，
   而是读的人不知道它是在什么约束下算出来的 —— 拿 T+1 市场的回测当日内策略的依据、
   拿两只票的组合当分散化的证据。所以限制不是附注，是结果的一部分。
"""

from __future__ import annotations

import json
import logging
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

import pandas as pd

from backtest.engines.china_a import ChinaAEngine
from backtest.engines.global_equity import GlobalEquityEngine
from backtest.gate import Plan, Refusal
from backtest.loader import SymbolProvenance, VibeLoader

logger = logging.getLogger(__name__)

ENGINES = {"ChinaAEngine": ChinaAEngine, "GlobalEquityEngine": GlobalEquityEngine}
BARS_PER_YEAR = 252     # 日线


class Strategy(Protocol):
    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]: ...


@dataclass
class Result:
    metrics: Dict[str, Any]
    plan: Plan
    strategy: str
    provenance: Dict[str, SymbolProvenance]
    limits: List[str]
    notes: List[str]
    run_dir: Path
    missing: Dict[str, str] = field(default_factory=dict)

    def summary(self) -> str:
        m = self.metrics
        def pct(k: str) -> str:
            v = m.get(k)
            return f"{v * 100:.2f}%" if isinstance(v, (int, float)) else "—"
        def num(k: str, nd: int = 2) -> str:
            v = m.get(k)
            return f"{v:.{nd}f}" if isinstance(v, (int, float)) else "—"
        lines = [
            f"【{self.plan.market.label} · {self.plan.style.label}】{self.strategy}",
            f"标的 {', '.join(self.plan.codes)}   区间 {self.plan.start} → {self.plan.end}",
            "",
            f"  总收益 {pct('total_return')}    年化 {pct('annual_return')}    最大回撤 {pct('max_drawdown')}",
            f"  夏普 {num('sharpe')}    卡玛 {num('calmar')}    索提诺 {num('sortino')}",
            f"  交易 {m.get('trade_count', '—')} 笔    胜率 {pct('win_rate')}    盈亏比 {num('profit_loss_ratio')}",
        ]
        # `benchmark_return` 是**等权自基准**（就是这几只标的本身买入持有），不是指数。
        # 名字叫 benchmark，不说清楚就会被当成沪深300 / 标普 —— 那是完全不同的结论。
        bench = self.metrics.get("benchmark_return")
        if isinstance(bench, (int, float)):
            ticker = self.metrics.get("benchmark_ticker")
            what = f"指数 {ticker}" if ticker else "初始等权持有这几只标的本身（不是指数；无再平衡、不计费用；缺报价沿用前值，首笔报价前留现金）"
            lines.append(f"  对照 {bench * 100:.2f}%    ← {what}")
        if self.missing:
            lines += ["", "取不到数据（未参与回测）："] + [f"  · {c}：{why}" for c, why in self.missing.items()]
        lines += ["", "这次回测的限制（读结果前先看）："] + [f"  · {x}" for x in self.limits]
        lines += ["", "口径："] + [f"  · {x}" for x in self.notes]
        lines += ["", "数据来源："]
        for c, p in self.provenance.items():
            lines.append(f"  · {c}  {p.endpoint}  {p.rows} 根 {p.first_bar}→{p.last_bar}"
                         + (f"  [{p.note}]" if p.note else ""))
        return "\n".join(lines)


class BacktestNotValid(RuntimeError):
    """跑到一半发现这次回测不成立 —— **中止，不出报告**。

    闸口是在拿到数据之前判的，只能按日历估。真实数据到手、信号算出来之后，
    还有两件事只有这时候才知道 —— 而它们都会产出一份看着完全正常的报告。
    """


class _Guarded:
    """夹在策略与引擎之间的一道检查。

    放这里是因为它要同时看到**真实数据**和**真实信号**，而引擎恰好在取完数、
    喂给策略的那一刻两样都有。检查不过就抛，让回测**在出报告之前**死掉。
    """

    def __init__(self, inner: Strategy, plan: Plan) -> None:
        self.inner, self.plan = inner, plan
        self.name = getattr(inner, "name", type(inner).__name__)
        self.note: str = ""

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        # ① 样本够不够 —— 按**实际 bar 数**，不是按日历估的那个数。
        #    次新股、长期停牌、数据源缺失都会让实际根数远少于估算；
        #    闸口放行了，回测在 40 根 bar 上跑完，报告写着「长线」。
        bars = {c: len(df) for c, df in data_map.items()}
        if not bars:
            raise BacktestNotValid("一只标的的数据都没取到")
        longest = max(bars.values())
        need = self.plan.style.min_bars
        if longest < need:
            raise BacktestNotValid(
                f"{self.plan.style.label}至少要 {need} 根日线，实际只有 {longest} 根"
                f"（{', '.join(f'{c} {n} 根' for c, n in sorted(bars.items()))}）。"
                f"{self.plan.style.why_min}"
            )
        # 单只票**自己**够不够 —— 与整体用同一个门槛。
        # ⚠️ 第一版这里写的是「不足最长的一半才提示」，那是我自己发明的门槛，留了个洞：
        #    长线要 480 根，A 有 600 根、B 有 400 根 —— 整体过关，B 也够不上「一半」线，
        #    于是 B 带着不足的历史参与回测，而**报告里一个字都不说**。
        #    ⇒ 判据只用一个：低于这个口径的最低要求就说出来。不致命(组合整体够)，但必须看得见。
        thin = {c: n for c, n in bars.items() if n < need}
        if thin:
            self.note = (
                f"以下标的自身历史不足{self.plan.style.label}所需的 {need} 根，"
                "它们仍参与了回测，但各自的胜率 / 盈亏比只是少数几笔的偶然：" +
                "、".join(f"{c} 仅 {n} 根" for c, n in sorted(thin.items()))
            )

        sig = self.inner.generate(data_map)

        # ② 策略发了引擎会**静默拒掉**的信号 —— 那样报告描述的是另一个策略
        # ⚠️ 判据只看**市场**，不看调用方声明了什么。
        #    带上 `and not plan.allow_short` 会留一个洞：手搓 Plan 绕过闸口时，
        #    (A股 + allow_short=True) 这种组合会跳过检查、做空单被引擎静默拒掉。
        #    ⛔ 也不能改成 `or`：那会把「美股 + 调用方没声明做空」误杀，
        #       而美股本来就能做空、引擎会正常成交，没有任何静默丢弃。
        if not self.plan.market.can_short:
            offenders = {}
            for code, ser in (sig or {}).items():
                if not isinstance(ser, pd.Series):
                    continue
                n = int((pd.to_numeric(ser, errors="coerce") < 0).sum())
                if n:
                    offenders[code] = n
            if offenders:
                raise BacktestNotValid(
                    f"策略发出了做空信号（{', '.join(f'{c} {n} 次' for c, n in sorted(offenders.items()))}），"
                    f"而{self.plan.market.label}不允许做空 —— 引擎会把这些单**静默拒掉**，"
                    f"跑出来的是「删掉所有做空信号后的策略」，不是你写的那个。已中止"
                )
        return sig


def run(plan: Plan | Refusal, strategy: Strategy, run_dir: Optional[Path] = None,
        python: Optional[str] = None) -> Result:
    """按闸口给的计划跑一次回测。

    传进来的若是 :class:`Refusal`，直接抛 —— 调用方本该先看闸口的结论。
    """
    if isinstance(plan, Refusal):
        raise ValueError(f"闸口拒绝了这次回测：{plan.reason}（{plan.remedy}）")

    run_dir = Path(run_dir) if run_dir else Path(tempfile.mkdtemp(prefix="backtest-"))
    run_dir.mkdir(parents=True, exist_ok=True)

    loader = VibeLoader(out_dir=run_dir / "data", python=python)
    engine_cls = ENGINES[plan.market.engine]
    config = plan.to_config()
    engine = engine_cls(config)

    guarded = _Guarded(strategy, plan)
    try:
        metrics = engine.run_backtest(
            config=config, loader=loader, signal_engine=guarded,
            run_dir=run_dir, bars_per_year=BARS_PER_YEAR,
        )
    except BacktestNotValid as exc:
        failed = {c: why for c, why in loader.failures.items() if c in plan.codes}
        if not failed:
            raise
        # 守卫只看取回的样本；部分标的没取到时，不能只用其余标的的样本
        # 不足来给整个计划下「不成立」的结论。保留两类原因，作为数据错误。
        details = "；".join(f"{c}：{why}" for c, why in failed.items())
        raise RuntimeError(f"回测数据不完整（{details}）；已取得样本的限制：{exc}") from exc

    # 取不到的票**要说出来**。引擎那边只是把它们从 data_map 里漏掉，
    # 结果照样算得出来 —— 读的人会以为三只票都在里面，其实只跑了两只。
    # 🔴 只报**用户点名的标的**。同一个 loader 实例还会被 benchmark 那条路用到
    #    （base.py 把它一起传过去），基准取数失败会落在同一个 failures 里 ——
    #    不过滤的话，报告会写「你的某只标的没参与回测」，而那根本不是用户的标的。
    asked = set(plan.codes)
    missing = {c: why for c, why in loader.failures.items() if c in asked}
    if missing:
        logger.warning("以下标的没有参与回测：%s", ", ".join(missing))

    notes = list(plan.notes)
    if guarded.note:
        notes.append(guarded.note)
    # 指定了指数基准却没取到时，报告只是**少一行**，看起来仍是一份完整的报告。
    # 日志在服务端 / Notebook / 界面里对用户不可见 ⇒ 这件事必须进结果本身。
    # （当前 to_config() 不设 benchmark，这条是给将来接指数基准时兜底的。）
    wanted = config.get("benchmark")
    if wanted and wanted != "auto" and not metrics.get("benchmark_ticker"):
        # ⚠️ 声称「下面的对照是…」之前得确认对照那一行真的会出现 ——
        #    否则就是**注释替代码许愿**：摘要里没有对照行，说明却说有。
        fallback = metrics.get("benchmark_return")
        notes.append(
            f"指定的基准 {wanted} 没有取到，下面的对照是等权买入持有这几只标的本身，不是该指数"
            if isinstance(fallback, (int, float)) and fallback == fallback
            else f"指定的基准 {wanted} 没有取到，本次**没有任何对照**"
        )
    return Result(
        metrics=metrics, plan=plan, strategy=guarded.name,
        provenance={c: p for c, p in loader.provenance.items() if c in asked},
        limits=list(plan.limits), notes=notes,
        run_dir=run_dir, missing=missing,
    )
