"""确定性计算库的 **JSON 入口**：stdin 进一个 `{fn, args}`，stdout 出结果。

🔴 为什么需要它：界面此前**自己又抄了一套**估值算法（PE / CAGR / PEG / 消化年数），
   于是产品里有了「两套事实与计算链路」—— `calc/` 里改对了口径，桌面端不会跟着变。
   实测后果：`calc/` 的正式口径是**四情景**消化年数（30 / 25 / 22 / 18 倍锚），
   而界面写死 30 倍出**一个数**，把最乐观的那一档呈现成了既定事实。
   ⇒ 界面改成调这里，公式只有一份。

⚠️ 这里**不写任何新公式**，只做转发。新增计算一律加进 `formulas.py` ——
   否则"只有一份"这句话立刻又不成立了。

用法（Core 的 runTool 就是这么调的）：
    echo '{"fn":"pe_digestion_scenarios","args":{"pe":30.76,"cagr":59.71}}' | python -m calc.tool
"""

from __future__ import annotations

import json
import sys

from calc import formulas
from calc.display import attach_display
from calc.stdio_utf8 import force_utf8_stdio

# 允许从外部调的函数**白名单**。函数名逐个与 `formulas.py` 核对过
# （第一版凭印象写了个 `cagr`，实际不存在，真名是 `forward_cagr` / `growth_rate`）。
# 🔴 不做 `getattr(formulas, fn)` 那种开放转发：那等于把本模块的任意属性暴露给调用方，
#    而 formulas 里还有 `_err` / `_num` 这类私有件。要加就往这张表里加，一次一个。
ALLOWED = {
    "pe_digestion_scenarios",
    "pe_digestion_years",
    "peg",
    "forward_pe",
    "forward_cagr",
    "growth_rate",
    "pe_deducted_annualized",
    "pe_ttm_from_parts",
    "percentile_rank",
    "consensus_dispersion",
    "forward_vs_ttm_judgement",
}


def _fail(msg: str, **extra: object) -> None:
    print(json.dumps({"ok": False, "error": msg, **extra}, ensure_ascii=False))
    sys.exit(2)


def main() -> None:
    # 中文 Windows 的管道默认 GBK，而结果里全是中文（见 stdio_utf8.py）
    force_utf8_stdio()

    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        _fail(f"入参不是合法 JSON:{exc}")
        return

    if req.get("catalog"):
        print(json.dumps({"ok": True, "catalog": sorted(ALLOWED)}, ensure_ascii=False))
        return

    fn = str(req.get("fn") or "")
    if fn not in ALLOWED:
        # 🔴 认不出就报错，**不回落到任何默认函数** —— 悄悄算了别的，
        #    调用方拿到的会是一个看起来正常、其实答非所问的数字。
        _fail(f"没有这个计算函数:{fn or '(空)'}", available=sorted(ALLOWED))
        return

    args = req.get("args")
    if not isinstance(args, dict):
        _fail("args 必须是对象")
        return

    try:
        result = getattr(formulas, fn)(**args)
    except TypeError as exc:  # 参数名 / 个数不对
        _fail(f"{fn} 的参数不对:{exc}")
        return

    # 附上确定性的 display（界面照抄它，不自己格式化 —— 否则四舍五入口径又会分叉）
    result = attach_display(result)
    print(json.dumps({"ok": True, "fn": fn, "result": result}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
