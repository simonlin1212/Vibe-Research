"""a-stock-data v3.7 extras the cockpit pages do not paint yet.

Chips / sina adj / baostock valuation+IPO / SW industry history /
PBOC social-financing workbook / NBS PMI text.
HTTP + 问 AI hang here. Not warmup, not quote-hub, not macro_board / lpr.
"""
from __future__ import annotations

import io
import json
import logging
import re
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Any, Iterator

import numpy as np
import requests

import astock

log = logging.getLogger("astock_research")

UA = {"User-Agent": astock.UA}
SW_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"
PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = f"{PBC_BASE}/diaochatongjisi/116219/116319/index.html"
NBS_INDEX = "https://www.stats.gov.cn/sj/zxfb/"

SFIN_COLS = (
    "month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans",
    "trust_loans", "undiscounted_bankers_acceptance", "corporate_bonds",
    "government_bonds", "equity_financing", "abs_by_depository", "loans_written_off",
)

_SW_ROWS: list[dict] | None = None
_YMD = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _num(v: Any) -> float | None:
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s or s in (".", "-", "--", "None"):
        return None
    try:
        n = float(s)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def _ymd(v: str | None) -> str:
    s = str(v or "").strip()
    if not s:
        return ""
    if not _YMD.fullmatch(s):
        raise ValueError(f"日期须 YYYY-MM-DD, 收到 {v!r}")
    return s


def window(start: str | None, end: str | None, days: int = 180) -> tuple[str, str]:
    e = _ymd(end) or date.today().isoformat()
    s = _ymd(start) or (date.fromisoformat(e) - timedelta(days=max(int(days), 1))).isoformat()
    return s, e


def _get(url: str, timeout: int = 30, **kw: Any) -> requests.Response:
    r = requests.get(url, headers={**UA, **(kw.pop("headers", {}) or {})}, timeout=timeout, **kw)
    r.raise_for_status()
    return r


def _html(url: str, timeout: int = 30) -> str:
    r = _get(url, timeout=timeout)
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


# ---------------------------------------------------------------------------
# Sina adjust factors
# ---------------------------------------------------------------------------

def parse_sina_factor(text: str) -> list[dict]:
    """Parse `var sh600519qfq={...}/* trailer */`. raw_decode stops at JSON end."""
    brace = (text or "").find("{")
    if brace < 0:
        raise RuntimeError(f"新浪复权因子响应无 JSON: {(text or '')[:120]}")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[brace:])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"新浪复权因子 JSON 解析失败: {e}") from e
    out = []
    for it in (data.get("data") or []):
        if not isinstance(it, dict) or "d" not in it or "f" not in it:
            continue
        fac = _num(it.get("f"))
        if fac is None:
            continue
        out.append({"date": str(it["d"])[:10], "factor": fac})
    return out


def sina_adjust_factor(code: str, kind: str = "qfq") -> list[dict]:
    """Sina qfq/hfq factor series. Market from get_prefix (suffix wins)."""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 qfq 或 hfq, 收到 {kind!r}")
    raw = str(code).strip()
    digits = astock.norm_ticker(raw)
    prefix = astock.get_prefix(raw)
    symbol = f"{prefix}{digits}"
    url = f"https://finance.sina.com.cn/realstock/company/{symbol}/{kind}.js"
    r = _get(url, timeout=10, headers={"Referer": "https://finance.sina.com.cn/"})
    rows = parse_sina_factor(r.text)
    if not rows:
        raise RuntimeError(f"新浪复权因子空 data ({symbol}/{kind})")
    return rows


def apply_adjust(
    bars: list[dict],
    factors: list[dict],
    kind: str = "qfq",
    price_keys: tuple[str, ...] = ("open", "high", "low", "close"),
) -> list[dict]:
    """Apply sina factors. qfq divides, hfq multiplies. Empty factors raise."""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 qfq 或 hfq, 收到 {kind!r}")
    if not factors:
        raise ValueError("复权因子列表为空, 无法复权. 不要用未复权价继续计算.")
    rows = []
    for b in bars:
        if not isinstance(b, dict) or "date" not in b:
            raise ValueError("每根 K 线需含 date 键")
        nb = dict(b)
        nb["date"] = str(nb["date"])[:10]
        rows.append(nb)
    fac = sorted(factors, key=lambda x: x["date"])
    out: list[dict] = []
    i, cur = 0, None
    for bar in sorted(rows, key=lambda b: b["date"]):
        while i < len(fac) and fac[i]["date"] <= bar["date"]:
            cur = fac[i]["factor"]
            i += 1
        if cur is None:
            raise RuntimeError(
                f"K 线日期 {bar['date']} 早于因子序列最早日 {fac[0]['date']}, 无法复权"
            )
        if cur == 0:
            raise RuntimeError(f"复权因子为 0 ({bar['date']})")
        nb = dict(bar)
        for k in price_keys:
            if k in nb and nb[k] is not None:
                v = float(nb[k])
                nb[k] = round(v / cur if kind == "qfq" else v * cur, 4)
        nb["adj_factor"] = cur
        out.append(nb)
    return out


# ---------------------------------------------------------------------------
# Chip distribution (baostock OHLC + turn)
# ---------------------------------------------------------------------------

def triangular_weights(grid: np.ndarray, low: float, high: float, avg: float) -> np.ndarray:
    """Triangle on the price grid, peak at avg, area 1."""
    w = np.zeros_like(grid)
    if not np.isfinite([low, high, avg]).all() or high < low:
        return w
    if high - low < 1e-9:
        w[np.argmin(np.abs(grid - low))] = 1.0
        return w
    avg = min(max(avg, low), high)
    left = (grid >= low) & (grid <= avg)
    right = (grid > avg) & (grid <= high)
    if avg - low > 1e-9:
        w[left] = (grid[left] - low) / (avg - low)
    else:
        w[left] = 1.0
    if high - avg > 1e-9:
        w[right] = (high - grid[right]) / (high - avg)
    else:
        w[right] = 1.0
    total = w.sum()
    if total > 0:
        return w / total
    w[np.argmin(np.abs(grid - avg))] = 1.0
    return w


def chip_distribution(rows: list[dict], grid_size: int = 300, decay: float = 1.0) -> dict:
    """CYQ from high/low/close/turn (turn is percent). Seed day-1 as 100% float."""
    need = {"date", "high", "low", "close", "turn"}
    clean: list[dict] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if need - set(r):
            continue
        hi, lo, cl, turn = _num(r.get("high")), _num(r.get("low")), _num(r.get("close")), _num(r.get("turn"))
        if hi is None or lo is None or cl is None or turn is None or hi <= 0:
            continue
        clean.append({
            "date": str(r["date"])[:10],
            "high": hi, "low": lo, "close": cl, "turn": turn,
        })
    if not clean:
        raise ValueError("chip_distribution: 有效行数为 0")
    clean.sort(key=lambda x: x["date"])

    lo = min(x["low"] for x in clean)
    hi = max(x["high"] for x in clean)
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    grid = np.linspace(lo - pad, hi + pad, int(grid_size))

    chips = None
    for row in clean:
        t = min(max(float(row["turn"]) / 100.0 * decay, 0.0), 1.0)
        avg = (row["high"] + row["low"] + row["close"]) / 3.0
        w = triangular_weights(grid, row["low"], row["high"], avg)
        if w.sum() <= 0:
            continue
        if chips is None:
            chips = w.copy()
            continue
        chips = chips * (1.0 - t) + w * t
    if chips is None:
        raise RuntimeError("chip_distribution: 所有交易日价格区间无效")
    total = float(chips.sum())
    if total <= 0:
        raise RuntimeError("chip_distribution: 筹码总量为 0")
    chips = chips / total

    price = float(clean[-1]["close"])
    cum = np.cumsum(chips)

    def price_at(q: float) -> float:
        return float(np.interp(q, cum, grid))

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = int(np.argmax(chips))
    return {
        "price": price,
        "profit_ratio": float(chips[grid <= price].sum()),
        "avg_cost": float((grid * chips).sum()),
        "cost_90": [p05, p95],
        "cost_70": [p15, p85],
        "concentration_90": float((p95 - p05) / (p95 + p05)) if p95 + p05 else None,
        "concentration_70": float((p85 - p15) / (p85 + p15)) if p85 + p15 else None,
        "peak_price": float(grid[peak_i]),
        "histogram": [(float(pp), float(cc)) for pp, cc in zip(grid, chips) if cc > 1e-6],
    }


# ---------------------------------------------------------------------------
# Baostock (lazy)
# ---------------------------------------------------------------------------

def bs_code(code: str) -> str:
    """6-digit -> baostock sh.XXXXXX / sz.XXXXXX. Reject BJ before login."""
    raw = str(code or "").strip()
    digits = astock.norm_ticker(raw)
    pfx = astock.get_prefix(raw)
    if pfx == "bj":
        raise ValueError(
            f"baostock 不支持北交所代码 {digits} (4/8/92). 估值请用腾讯当日快照."
        )
    return f"{pfx}.{digits}"


def _require_bs():
    try:
        import baostock as bs  # type: ignore
    except ImportError as e:
        raise astock.DependencyMissing("baostock 未安装: pip install baostock") from e
    return bs


@contextmanager
def bs_session() -> Iterator[Any]:
    bs = _require_bs()
    lg = bs.login()
    if getattr(lg, "error_code", "0") != "0":
        raise RuntimeError(f"baostock 登录失败: {getattr(lg, 'error_code', '')} {getattr(lg, 'error_msg', '')}")
    try:
        yield bs
    finally:
        bs.logout()


def _rs_rows(rs) -> list[dict]:
    if getattr(rs, "error_code", "0") != "0":
        raise RuntimeError(f"baostock 查询失败: {rs.error_code} {rs.error_msg}")
    fields = list(rs.fields)
    out = []
    while rs.next():
        raw = rs.get_row_data()
        out.append({f: raw[i] if i < len(raw) else None for i, f in enumerate(fields)})
    return out


def baostock_ohlc_turn(code: str, start: str, end: str) -> list[dict]:
    """Daily OHLC + turn, qfq. Halted days dropped. BJ rejected."""
    bsc = bs_code(code)
    s, e = window(start, end)
    with bs_session() as bs:
        rs = bs.query_history_k_data_plus(
            bsc,
            "date,open,high,low,close,turn,tradestatus",
            start_date=s,
            end_date=e,
            frequency="d",
            adjustflag="2",
        )
        rows = _rs_rows(rs)
    out = []
    for r in rows:
        if str(r.get("tradestatus") or "") != "1":
            continue
        out.append({
            "date": str(r.get("date") or "")[:10],
            "open": _num(r.get("open")),
            "high": _num(r.get("high")),
            "low": _num(r.get("low")),
            "close": _num(r.get("close")),
            "turn": _num(r.get("turn")),
        })
    return out


def chips(code: str, start: str = "", end: str = "", days: int = 180) -> dict:
    """CYQ for one stock. Baostock qfq + turn."""
    s, e = window(start, end, days)
    rows = baostock_ohlc_turn(code, s, e)
    out = chip_distribution(rows)
    out["code"] = astock.norm_ticker(code)
    out["start"] = s
    out["end"] = e
    out["bars"] = len(rows)
    return out


def baostock_valuation_history(code: str, start: str = "", end: str = "", days: int = 365) -> list[dict]:
    """Daily PE/PB/PS/PCF + turn + halt + ST. Unadjusted close."""
    bsc = bs_code(code)
    s, e = window(start, end, days)
    fields = "date,code,close,peTTM,pbMRQ,psTTM,pcfNcfTTM,turn,tradestatus,isST"
    with bs_session() as bs:
        rs = bs.query_history_k_data_plus(
            bsc, fields, start_date=s, end_date=e, frequency="d", adjustflag="3",
        )
        rows = _rs_rows(rs)
    out = []
    for r in rows:
        out.append({
            "date": str(r.get("date") or "")[:10],
            "code": r.get("code"),
            "close": _num(r.get("close")),
            "peTTM": _num(r.get("peTTM")),
            "pbMRQ": _num(r.get("pbMRQ")),
            "psTTM": _num(r.get("psTTM")),
            "pcfNcfTTM": _num(r.get("pcfNcfTTM")),
            "turn": _num(r.get("turn")),
            "tradestatus": str(r.get("tradestatus") or ""),
            "isST": str(r.get("isST") or ""),
        })
    return out


def baostock_stock_basic(code: str) -> dict:
    """ipoDate / outDate / status. Only source here for delist date."""
    bsc = bs_code(code)
    with bs_session() as bs:
        rows = _rs_rows(bs.query_stock_basic(code=bsc))
    return dict(rows[0]) if rows else {}


# ---------------------------------------------------------------------------
# Shenwan industry history
# ---------------------------------------------------------------------------

def _require_xlrd():
    try:
        import xlrd  # noqa: F401
    except ImportError as e:
        raise astock.DependencyMissing("申万行业表是 xls, 需要 xlrd: pip install xlrd") from e


def parse_sw_rows(rows: list[dict]) -> list[dict]:
    """Normalize SW classify rows: zfill codes, derive l1/l2."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        code = str(r.get("code") or r.get("股票代码") or "").strip().zfill(6)
        ind = str(r.get("industry_code") or r.get("行业代码") or "").strip().zfill(6)
        start = str(r.get("start_date") or r.get("计入日期") or "")[:10]
        if not re.fullmatch(r"\d{6}", code) or not re.fullmatch(r"\d{6}", ind) or not start:
            continue
        out.append({
            "code": code,
            "start_date": start,
            "industry_code": ind,
            "l1_code": ind[:2] + "0000",
            "l2_code": ind[:4] + "00",
            "update_date": str(r.get("update_date") or r.get("更新日期") or "")[:10],
        })
    out.sort(key=lambda x: (x["code"], x["start_date"]))
    return out


def sw_industry_as_of(rows: list[dict], code: str, as_of: str) -> dict | None:
    """Last SW industry change on or before as_of. None if not listed yet."""
    digits = astock.norm_ticker(code)
    day = _ymd(as_of) or date.today().isoformat()
    hist = [r for r in parse_sw_rows(rows) if r["code"] == digits and r["start_date"] <= day]
    if not hist:
        return None
    row = hist[-1]
    return {
        "code": digits,
        "as_of": day,
        "industry_code": row["industry_code"],
        "l1_code": row["l1_code"],
        "l2_code": row["l2_code"],
        "since": row["start_date"],
    }


def sw_industry_history() -> list[dict]:
    """Official SW classify xls. Process-level cache; 12k rows."""
    global _SW_ROWS
    if _SW_ROWS is not None:
        return _SW_ROWS
    _require_xlrd()
    import pandas as pd

    r = _get(SW_URL, timeout=60)
    try:
        df = pd.read_excel(io.BytesIO(r.content), engine="xlrd")
    except Exception as e:
        raise RuntimeError(f"申万行业表无法读取: {e}") from e
    df = df.rename(columns={
        "股票代码": "code", "计入日期": "start_date",
        "行业代码": "industry_code", "更新日期": "update_date",
    })
    missing = {"code", "start_date", "industry_code"} - set(df.columns)
    if missing:
        raise RuntimeError(f"申万表结构变了, 缺列 {sorted(missing)}; 实际列={list(df.columns)}")
    rows = parse_sw_rows(df.to_dict("records"))
    if not rows:
        raise RuntimeError("申万行业表解析后为空")
    _SW_ROWS = rows
    return rows


def sw_industry_lookup(code: str, as_of: str = "") -> dict:
    hit = sw_industry_as_of(sw_industry_history(), code, as_of)
    if hit is None:
        return {"code": astock.norm_ticker(code), "as_of": _ymd(as_of) or date.today().isoformat()}
    return hit


# ---------------------------------------------------------------------------
# PBOC social financing (2021+)
# ---------------------------------------------------------------------------

def month_label(v: Any) -> str | None:
    """`2026.01` -> 2026-01; `2026.1` (Excel ate the tail zero) -> 2026-10."""
    m = re.match(r"^(\d{4})\.(\d{1,2})$", str(v).strip())
    if not m:
        return None
    year_s, mon_s = m.group(1), m.group(2)
    if len(mon_s) == 1:
        mon_s += "0"
    return f"{year_s}-{int(mon_s):02d}"


def parse_pbc_year_links(html: str) -> dict[int, str]:
    years = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(\d{4})年统计数据\s*</a>""", html or "")
    return {int(y): href for href, y in years}


def parse_pboc_sfin(grid: list[list], year: int) -> list[dict]:
    """Parse PBOC workbook rows. Only 2021+ layout (standalone 月份 header)."""
    start = None
    for i, row in enumerate(grid or []):
        cell = row[0] if row else None
        if str(cell).strip() == "月份":
            start = i
            break
    if start is None:
        raise RuntimeError(
            f"{year} 年社融表没有独立的月份表头单元格. 本端点仅支持 2021 年起."
        )
    out: list[dict] = []
    for row in grid[start + 3:]:
        if not row:
            continue
        month = month_label(row[0])
        if not month or not month.startswith(f"{year}-"):
            continue
        rec: dict[str, Any] = {"month": month}
        for j, col in enumerate(SFIN_COLS[1:], 1):
            rec[col] = _num(row[j] if j < len(row) else None)
        if rec.get("afre_total") is None:
            continue
        out.append(rec)
    if not out:
        raise RuntimeError(f"社融表解析后无有效月份 ({year} 年)")
    return out


def _abs_pbc(href: str) -> str:
    return href if href.startswith("http") else PBC_BASE + href


def pboc_social_financing(year: int | None = None) -> list[dict]:
    """PBOC monthly AFRE increments, yi yuan. year=None -> latest year."""
    table = parse_pbc_year_links(_html(PBC_INDEX))
    if not table:
        raise RuntimeError("人民银行索引页未找到 XXXX年统计数据 链接")
    target = max(table) if year is None else int(year)
    if target not in table:
        raise ValueError(f"人民银行无 {target} 年数据, 可选: {sorted(table, reverse=True)[:8]}")
    ypage = _html(_abs_pbc(table[target]))
    topics = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(社会融资规模)\s*</a>""", ypage)
    if not topics:
        raise RuntimeError(f"{target} 年页未找到社会融资规模专题链接")
    tpage = _html(_abs_pbc(topics[0][0]))
    books = re.findall(r"""href=["']([^"']+\.xlsx?)["']""", tpage)
    if not books:
        raise RuntimeError(f"{target} 年社融专题页未找到 xls/xlsx 附件")
    content = _get(_abs_pbc(books[0]), timeout=60).content
    import pandas as pd

    raw = pd.read_excel(io.BytesIO(content), header=None)
    grid = raw.fillna("").astype(object).values.tolist()
    return parse_pboc_sfin(grid, target)


# ---------------------------------------------------------------------------
# NBS PMI
# ---------------------------------------------------------------------------

def parse_nbs_pmi(title: str, html: str, source_url: str = "") -> dict:
    """Latest NBS PMI from title + article HTML. Core three must parse."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html or "", flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[\s\u3000\xa0]+", "", text)

    def grab(pat: str) -> float | None:
        m = re.search(pat, text)
        return float(m.group(1)) if m else None

    ym = re.search(r"(\d{4})年(\d{1,2})月", title or "")
    large = medium = small = None
    combined = re.search(r"大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%", text)
    if combined:
        large, medium, small = (float(x) for x in combined.groups())
    else:
        m_ms = re.search(r"中、小型企业PMI分别为([\d.]+)%和([\d.]+)%", text)
        if m_ms:
            medium, small = (float(x) for x in m_ms.groups())
        for name, pat in (
            ("large", r"大型企业PMI为([\d.]+)%"),
            ("medium", r"中型企业PMI为([\d.]+)%"),
            ("small", r"小型企业PMI为([\d.]+)%"),
        ):
            m = re.search(pat, text)
            if not m:
                continue
            v = float(m.group(1))
            if name == "large":
                large = v
            elif name == "medium" and medium is None:
                medium = v
            elif name == "small" and small is None:
                small = v

    result = {
        "title": (title or "").strip(),
        "period": f"{ym.group(1)}-{int(ym.group(2)):02d}" if ym else None,
        "manufacturing_pmi": grab(r"(?<!非)制造业采购经理指数（PMI）为([\d.]+)%"),
        "non_manufacturing_pmi": grab(r"非制造业商务活动指数为([\d.]+)%"),
        "composite_pmi": grab(r"综合PMI产出指数为([\d.]+)%"),
        "pmi_large": large,
        "pmi_medium": medium,
        "pmi_small": small,
        "source_url": source_url,
    }
    core = ("manufacturing_pmi", "non_manufacturing_pmi", "composite_pmi")
    absent = [k for k in core if result[k] is None]
    if absent:
        raise RuntimeError(f"PMI 正文措辞可能已变更, 无法解析 {absent}")
    return result


def nbs_pmi() -> dict:
    idx = _html(NBS_INDEX)
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*</a>', idx)
    hit = next(((u, t) for u, t in links if "采购经理指数" in t), None)
    if not hit:
        raise RuntimeError("国家统计局最新发布页未找到采购经理指数条目")
    href, title = hit
    url = href if href.startswith("http") else NBS_INDEX + href.lstrip("./")
    return parse_nbs_pmi(title, _html(url), url)
