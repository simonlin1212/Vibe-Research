"""OpenVlab 数据层 —— 期权 / 期货波动率市场数据(移植自 openvlab.cn 爬虫).

数据源: https://www.openvlab.cn/api/* (公开 REST, 无鉴权)
- /api/ctamap-all          市场页主表格, 全部品种概览
- /api/dto/{prodUnd}       单个标的详细数据, 如 510300
- /api/volatility-ts-all   波动率期限结构汇总

设计:
- 只读, 无状态, 客观呈现公开数据, 不推荐 / 不预测 / 不评分.
- 全站共享一份缓存 (TTL 默认 5 分钟), 多用户多次打开只抓一次.
  盘中过期重取, 上游失败回落上一笔; 休市 (盘后/午休/周末) 冻结, 只喂上一笔不出网.
  空结果不缓存, 下次请求直接重试. 启动时 warm_once 填一次首屏钥匙.
- requests 惰性导入: 缺失时对应函数抛 DependencyMissing, app 层转 501 + 安装提示.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any

from cache import TTLCache, is_nonempty

logger = logging.getLogger(__name__)

BASE_URL = "https://www.openvlab.cn"
API_PREFIX = "/api"

DEFAULT_HEADERS = {
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": f"{BASE_URL}/market",
}

# 市场概览主表格字段 (api_field -> 中文表头), 与 openvlab.cn/market 页面一致
MARKET_OVERVIEW_COLUMNS: list[tuple[str, str]] = [
    ("product_alias", "品种名称"),
    ("prodUnd", "标的代码"),
    ("product", "产品代码"),
    ("exchange", "交易所"),
    ("sector_alias", "板块"),
    ("sector", "板块代码"),
    ("price", "最新价"),
    ("ctn", "标的涨跌幅"),
    ("atmv_current", "平值隐波"),
    ("atmv_1dchg", "隐波变化"),
    ("atmv_percentile", "隐波百分位"),
    ("rv22", "实波"),
    ("valphaT", "VolAlphaT"),
    ("carry", "Carry"),
    ("skew_current", "偏度"),
    ("skew_1dchg", "偏度日变化"),
    ("skew_percentile", "偏度百分位"),
    ("frontfwd_mom", "近远月动量"),
    ("exp", "主力合约"),
    ("expiry_date", "到期日"),
    ("last_time", "更新时间"),
    ("has_night_trading", "夜盘"),
    ("is_overseas", "境外品种"),
]


class DependencyMissing(RuntimeError):
    """缺少 requests 依赖时抛出, app 层转 501 + 安装提示."""


def _requests():
    try:
        import requests  # noqa: PLC0415
    except ImportError as e:
        raise DependencyMissing("openvlab 数据需要 requests: pip install requests") from e
    return requests


_SESSION = None
_SESSION_LOCK = threading.Lock()


def _http():
    """One process-wide Session for OpenVlab (keep-alive)."""
    global _SESSION
    requests = _requests()
    if _SESSION is None:
        with _SESSION_LOCK:
            if _SESSION is None:
                sess = requests.Session()
                sess.headers.update(DEFAULT_HEADERS)
                _SESSION = sess
    return _SESSION


_TTL = 300  # 5 分钟, 全站共享
_CACHE = TTLCache(maxsize=256, default_ttl=_TTL, negative_ttl=0, name="ovlab")


def deriv_market_open(now: datetime | None = None) -> bool:
    """期货交易时段 (与前端 derivShared.derivSession 同窗口, 只按本地钟点, 不判节假日).

    日盘 09:00-11:30 / 13:30-15:00 (周一至周五); 夜盘 21:00 起, 凌晨段 00:00-02:30
    属前一交易日 (周二至周六凌晨算夜盘). 午休 / 盘后 / 周末为休市.
    节假日白天会误判为开市, 多打几枪上游无害.
    """
    now = now or datetime.now()
    day = now.weekday()  # Mon=0 .. Sun=6
    mins = now.hour * 60 + now.minute
    if mins < 150:  # 00:00-02:30 凌晨夜盘段
        return 1 <= day <= 5  # Tue..Sat
    if day >= 5:  # 周末
        return False
    return (540 <= mins < 690) or (810 <= mins < 900) or (mins >= 1260)


def _cached(key: str, fn, valid=is_nonempty, ttl: float | None = None):
    """Session-aware cache. Empty upstream is not stored, next call retries.

    休市: 有上一笔直接喂, 不出网; 冷键放行一次 (启动后第一枪).
    盘中: 过期重取, 上游失败回落上一笔 (不刷新 TTL, 下次请求继续试).
    ttl: custom seconds, default _TTL.
    """
    if not deriv_market_open():
        last = _CACHE.get_last(key)
        if last is not None and valid(last):
            return last

    try:
        return _CACHE.get_or_set(key, fn, ttl=ttl, valid=valid, negative_ttl=0, serve_last=False)
    except Exception:
        last = _CACHE.get_last(key)
        if last is not None and valid(last):
            logger.warning("ovlab %s upstream failed, serve last-good", key)
            return last
        raise


def _get(path: str, params: dict[str, Any] | None = None, timeout: float = 20.0) -> Any:
    """统一 GET, 校验 openvlab 的 {code, result, message} 响应壳."""
    url = f"{BASE_URL}{API_PREFIX}/{path.lstrip('/')}"
    logger.debug("GET %s params=%s", url, params)
    resp = _http().get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(
            f"openvlab API error on {path}: code={payload.get('code')} "
            f"message={payload.get('message', 'unknown error')}"
        )
    return payload.get("result")


def _post(path: str, body: dict[str, Any] | None = None, timeout: float = 25.0) -> Any:
    """统一 POST (JSON body), 校验响应壳. 用于 warehouse/last-bars/flow-data 等."""
    url = f"{BASE_URL}{API_PREFIX}/{path.lstrip('/')}"
    logger.debug("POST %s body=%s", url, body)
    resp = _http().post(
        url,
        json=body or {},
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(
            f"openvlab API error on {path}: code={payload.get('code')} "
            f"message={payload.get('message', 'unknown error')}"
        )
    return payload.get("result")


def get_market_overview() -> list[dict[str, Any]]:
    """市场概览: 全部品种的行情 / 隐波 / 偏度 / carry 等概览 (ctamap-all).

    返回原始 list[dict], 字段见 MARKET_OVERVIEW_COLUMNS. 含缓存 5 分钟.
    """
    return _cached(
        "ovlab_market",
        lambda: _get("ctamap-all"),
        valid=lambda v: isinstance(v, list) and len(v) > 0,
    )


def get_product_detail(prod_und: str, exps: list[str] | None = None) -> dict[str, Any]:
    """单个标的详细数据 (dto/{prodUnd}), 如 510300.

    prod_und: 标的代码 (prodUnd 字段)
    exps: 可选, 指定主力合约月份列表, 逗号拼接传给接口
    返回原始 dict. 含缓存 5 分钟 (按 prod_und + exps 分别缓存).
    """
    prod_und = (prod_und or "").strip()
    if not prod_und:
        return {}
    params = None
    if exps:
        params = {"exps": ",".join(exps)}
    cache_key = f"ovlab_detail::{prod_und}::{','.join(exps or [])}"
    return _cached(
        cache_key,
        lambda: _get(f"dto/{prod_und}", params=params),
        valid=lambda v: isinstance(v, dict) and bool(v),
    )


def get_volatility_term_structures() -> dict[str, Any]:
    """波动率期限结构汇总 (volatility-ts-all).

    部分字段可能受限, 失败返回空 dict. 含缓存 5 分钟.
    """
    return _cached(
        "ovlab_vol_ts",
        lambda: _get("volatility-ts-all"),
        valid=lambda v: isinstance(v, dict) and bool(v),
    )


# ---------------------------------------------------------------------------
# 期货期限结构
# ---------------------------------------------------------------------------

def get_future_term_structures_all() -> dict[str, Any]:
    """期货期限结构汇总 (future-ts-all), 全品种. 含缓存 5 分钟."""
    return _cached(
        "ovlab_future_ts_all",
        lambda: _get("future-ts-all"),
        valid=lambda v: isinstance(v, dict) and bool(v),
    )


def get_future_term_structure(prod_und: str) -> dict[str, Any]:
    """单个标的的期货期限结构 (future-ts/{prodUnd}). 含缓存 5 分钟."""
    prod_und = (prod_und or "").strip()
    if not prod_und:
        return {}
    return _cached(
        f"ovlab_future_ts::{prod_und}",
        lambda: _get(f"future-ts/{prod_und}"),
        valid=lambda v: isinstance(v, dict),
    )


def _arb_exp_ym(exp: str) -> str:
    """Expiry key -> YYMM tail used in contract codes (RB2609)."""
    s = str(exp or "").strip().replace("-", "")
    if len(s) >= 6:
        return s[-4:]
    return s[-4:] if len(s) >= 4 else s


def _arb_leg(und: str, blk: dict[str, Any], exp_key: str) -> dict[str, Any] | None:
    """One future-ts month -> board leg. Skip dte<1 (same as term-structure)."""
    px = _sfloat(blk.get("future_tday"))
    dte = _sfloat(blk.get("days_to_expiry"))
    if px is None or dte is None or dte < 1:
        return None
    exp = str(blk.get("exp") or exp_key).replace("-", "")
    if len(exp) == 4:
        exp = f"20{exp}"
    ym = _arb_exp_ym(exp)
    if not ym:
        return None
    return {
        "code": f"{und}{ym}",
        "exp": exp if len(exp) >= 6 else f"20{ym}",
        "px": px,
        "pxYd": _sfloat(blk.get("future_yday")),
        "oi": _sfloat(blk.get("oi_tday")),
        "dte": dte,
    }


def _arb_curve(und: str, raw: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(raw, dict):
        return out
    for k, blk in raw.items():
        if not isinstance(blk, dict):
            continue
        leg = _arb_leg(und, blk, str(k))
        if leg:
            out.append(leg)
    out.sort(key=lambda x: x["dte"])
    return out


def _arb_spread(a: dict[str, Any], b: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
    """spread = a.px - b.px; yesterday same formula; chg = today - yesterday."""
    pa, pb = _sfloat(a.get("px")), _sfloat(b.get("px"))
    spread = None if pa is None or pb is None else pa - pb
    ya, yb = _sfloat(a.get("pxYd")), _sfloat(b.get("pxYd"))
    spread_yd = None if ya is None or yb is None else ya - yb
    chg = None if spread is None or spread_yd is None else spread - spread_yd
    return spread, spread_yd, chg


def _arb_ts(und: str) -> dict[str, Any]:
    try:
        raw = get_future_term_structure(und)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        logger.info("arb-board future-ts %s failed", und)
        return {}


def _build_arb_board() -> dict[str, Any]:
    from arb_catalog import (  # noqa: PLC0415
        CALENDAR_UNDS, CROSS_PAIRS, INDEX_BASIS, catalog_unds, calendar_label,
    )

    unds = catalog_unds()
    curves: dict[str, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = list(pool.map(_arb_ts, unds))
    for und, raw in zip(unds, futs, strict=True):
        cur = _arb_curve(und, raw)
        if cur:
            curves[und] = cur

    calendar: list[dict[str, Any]] = []
    for und, label in CALENDAR_UNDS:
        months = curves.get(und) or []
        if len(months) < 2:
            continue
        near, nxt = months[0], months[1]
        spread, spread_yd, chg = _arb_spread(near, nxt)
        calendar.append({
            "und": und,
            "label": label,
            "near": near,
            "next": nxt,
            "spread": spread,
            "spreadYd": spread_yd,
            "spreadChg": chg,
        })

    cross: list[dict[str, Any]] = []
    for a, b, label, sector in CROSS_PAIRS:
        ca, cb = curves.get(a) or [], curves.get(b) or []
        if not ca or not cb:
            continue
        la, lb = ca[0], cb[0]
        spread, spread_yd, chg = _arb_spread(la, lb)
        cross.append({
            "id": f"{a}-{b}",
            "label": label,
            "sector": sector,
            "aUnd": a,
            "bUnd": b,
            "aLabel": calendar_label(a),
            "bLabel": calendar_label(b),
            "a": la,
            "b": lb,
            "spread": spread,
            "spreadYd": spread_yd,
            "spreadChg": chg,
        })

    index: list[dict[str, Any]] = []
    for und, cash_code, cash_kind, cash_label, cash_mult in INDEX_BASIS:
        months = curves.get(und) or []
        if not months:
            continue
        index.append({
            "id": f"{und}-{cash_code}",
            "und": und,
            "label": f"{und} vs {cash_label}",
            "cashCode": cash_code,
            "cashKind": cash_kind,
            "cashLabel": cash_label,
            "cashMult": cash_mult,
            "near": months[0],
        })

    return {"calendar": calendar, "cross": cross, "index": index}


def get_arb_board() -> dict[str, Any]:
    """跨期/跨品种/股指近月看板. 复用 ovlab_future_ts::{und}, 整板 60s 随时段冻结.

    不打 ctamap-all / future-ts-all. 空板仍缓存结构, 避免前端一直转圈.
    """
    return _cached(
        "ovlab_arb_board",
        _build_arb_board,
        valid=lambda v: isinstance(v, dict) and "calendar" in v,
        ttl=60,
    )


# ---------------------------------------------------------------------------
# 异动 / 资金流
# ---------------------------------------------------------------------------

def get_flow_alerts() -> list[dict[str, Any]]:
    """异动榜 (flow-alert): 成交异动/走势异动/连续成交, 含到期日/区间涨幅/窗口量额.

    上游秒级更新. 盘中缓存 60s 对齐驾驶舱轮询, 约 1 次/分钟出网, 不另限流.
    """
    return _cached(
        "ovlab_flow_alert",
        lambda: _get("flow-alert"),
        valid=lambda v: isinstance(v, list) and len(v) > 0,
        ttl=60,
    )


def get_flow_data(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """资金流分页数据 (flow-data, POST). body 可含分页/筛选参数. 不缓存 (POST, 参数多变)."""
    return _post("flow-data", body=body)


# ---------------------------------------------------------------------------
# 持仓 / 仓差 / 季节性
# ---------------------------------------------------------------------------

def get_warehouse_history(product: str) -> dict[str, Any]:
    """单品种多年持仓历史 (warehouse/history, POST).

    product: 品种代码如 MA. 返回 value(当前) + year2013~year2026 + ratioData + category.
    仓差 / 资金面 / 季节性分析用. 含缓存 5 分钟 (按 product).
    """
    product = (product or "").strip()
    if not product:
        return {}
    return _cached(
        f"ovlab_wh_history::{product}",
        lambda: _post("warehouse/history", body={"product": product}),
        valid=lambda v: isinstance(v, dict) and bool(v),
    )


def get_warehouse_seasonal_history_all(
    years: list[str] | None = None,
    product: str | None = None,
) -> dict[str, Any]:
    """全品种季节性持仓 (warehouse/seasonal-history-all, POST).

    years: 年份字符串列表如 ['2020','2021','2022','2023','2024','2025']
    product: 可选, 指定单品种
    返回按品种分组的多年持仓. 数据量大 (数百 KB). 含缓存 5 分钟 (按 years+product).
    """
    if not years:
        years = ["2020", "2021", "2022", "2023", "2024", "2025"]
    body: dict[str, Any] = {"years": years}
    if product:
        body["product"] = product.strip()
    cache_key = f"ovlab_wh_seasonal::{','.join(years)}::{product or ''}"
    return _cached(
        cache_key,
        lambda: _post("warehouse/seasonal-history-all", body=body),
        valid=lambda v: isinstance(v, dict) and bool(v),
    )


SPARK_N = 90  # cockpit receipt spark: last N trading days


def get_warehouse_receipt(product: str) -> dict[str, Any]:
    """仓单瘦身: 最新/日变/近90日. 复用 warehouse/history 同一把钥匙, 不另缓存.

    对齐 openvlab.cn/future/warehouse-receipt. 空品种归 {}; 有品种无点仍带回 product, 避免前端一直转圈.
    """
    p = (product or "").strip().upper()
    if not p:
        return {}
    raw = get_warehouse_history(p)
    if not isinstance(raw, dict):
        raw = {}
    empty = {
        "product": p,
        "asOf": "",
        "last": None,
        "chg": None,
        "updated": str(raw.get("last_update_time") or "") if raw else "",
        "spark": [],
    }
    if not raw:
        return empty
    cat, val, chg = raw.get("category"), raw.get("value"), raw.get("value2")
    dates: list[Any] = cat if isinstance(cat, list) else []
    vals: list[Any] = val if isinstance(val, list) else []
    chgs: list[Any] = chg if isinstance(chg, list) else []
    series: list[tuple[str, float, float | None]] = []
    n = min(len(dates), len(vals))
    for i in range(n):
        fv = _sfloat(vals[i])
        if fv is None:
            continue
        cg = _sfloat(chgs[i]) if i < len(chgs) else None
        series.append((str(dates[i])[:10], fv, cg))
    if not series:
        return empty
    last_t, last_v, last_chg = series[-1]
    spark = series[-SPARK_N:]
    return {
        "product": p,
        "asOf": last_t,
        "last": last_v,
        "chg": last_chg,
        "updated": str(raw.get("last_update_time") or ""),
        "spark": [[t, v] for t, v, _ in spark],
    }


# ---------------------------------------------------------------------------
# K 线 / 价格波动率 (POST, 需具体合约代码)
# ---------------------------------------------------------------------------

def get_last_bars(codes: list[str]) -> list[dict[str, Any]]:
    """最新 K 线 (last-bars, POST).

    codes: 具体合约代码列表如 ['ps2609-C-40000']. 注意 prodUnd(如 510300) 通常返回空,
    需用具体合约代码 (可从 product-exps / dto 取). 不缓存 (实时行情).
    """
    if not codes:
        return []
    return _post("last-bars", body={"codes": codes}) or []


def get_current_batch(codes: list[str]) -> dict[str, Any]:
    """当前批次 (current-batch, POST). codes 为具体合约代码列表. 不缓存."""
    if not codes:
        return {}
    return _post("current-batch", body={"codes": codes}) or {}


def get_price_volatility_series(codes: list[str] | str) -> list[dict[str, Any]]:
    """价格+隐波分时预览序列 (price-volatility-series, POST).

    codes: 品种:到期月 列表, 如 ['MA:202609', 'RB:202610'].
    上游 body 要求 codes 为 JSON 字符串 (JSON.stringify(array)).
    返回 list[{symbol, prices:[[datetime, price], ...], volatilities:[[datetime, iv], ...], intervals}].
    缓存 5 分钟 (与上游 staleTime 对齐).
    """
    if isinstance(codes, str):
        raw = (codes or "").strip()
        if not raw:
            return []
        # Accept JSON array string or comma-separated fallback
        try:
            parsed = json.loads(raw)
            code_list = [str(x).strip() for x in parsed if str(x).strip()] if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            code_list = [c.strip() for c in raw.split(",") if c.strip()]
    else:
        code_list = [str(c).strip() for c in (codes or []) if str(c).strip()]
    if not code_list:
        return []
    # Stable cache key: sorted unique codes
    uniq = sorted(set(code_list))
    cache_key = f"ovlab_price_vol::{'|'.join(uniq)}"
    body = {"codes": json.dumps(uniq, ensure_ascii=False)}
    return _cached(
        cache_key,
        lambda: _post("price-volatility-series", body=body) or [],
        valid=lambda v: isinstance(v, list) and len(v) > 0,
        ttl=300,
    )


# ---------------------------------------------------------------------------
# 元数据
# ---------------------------------------------------------------------------

def get_product_exps(prod_und: str | None = None) -> list[dict[str, Any]]:
    """全品种合约月份列表 (product-exps).

    prod_und: 可选, 指定单品种. 返回 75 个品种的合约月份. 含缓存 30 分钟 (日级静态).
    """
    cache_key = f"ovlab_product_exps::{prod_und or 'all'}"
    params = {"prodUnd": prod_und} if prod_und else None
    return _cached(
        cache_key,
        lambda: _get("product-exps", params=params),
        valid=lambda v: isinstance(v, list) and len(v) > 0,
        ttl=1800,
    )


def get_exchange_info() -> list[dict[str, Any]]:
    """交易所信息 (exchange-info). 含缓存 1 小时 (基本不变)."""
    return _cached(
        "ovlab_exchange_info",
        lambda: _get("exchange-info"),
        valid=lambda v: isinstance(v, list) and len(v) > 0,
        ttl=3600,
    )


def get_sector_info() -> list[dict[str, Any]]:
    """板块信息 (sector-info). 含缓存 1 小时."""
    return _cached(
        "ovlab_sector_info",
        lambda: _get("sector-info"),
        valid=lambda v: isinstance(v, list) and len(v) > 0,
        ttl=3600,
    )


def get_next_trading_day() -> str:
    """下一交易日 (next-trading-day). 含缓存 1 小时."""
    return _cached(
        "ovlab_next_trading_day",
        lambda: _get("next-trading-day"),
        valid=lambda v: isinstance(v, str) and bool(v),
        ttl=3600,
    )


def get_holidays(exchange: str) -> Any:
    """某交易所的节假日日历 (holidays/{exchange}). exchange 如 CZCE. 含缓存 1 小时."""
    exchange = (exchange or "").strip()
    if not exchange:
        return []
    return _cached(
        f"ovlab_holidays::{exchange}",
        lambda: _get(f"holidays/{exchange}"),
        valid=lambda v: bool(v),
        ttl=3600,
    )


def get_expired(prod_und: str) -> dict[str, Any]:
    """某标的的已过期合约 (expired/{prodUnd}). 含缓存 30 分钟."""
    prod_und = (prod_und or "").strip()
    if not prod_und:
        return {}
    return _cached(
        f"ovlab_expired::{prod_und}",
        lambda: _get(f"expired/{prod_und}"),
        valid=lambda v: isinstance(v, dict),
        ttl=1800,
    )


# ---------------------------------------------------------------------------
# 期权合约批量查询 (POST, 需完整合约字段)
# ---------------------------------------------------------------------------

def query_instruments_batch(instrument_queries: list[dict[str, Any]]) -> Any:
    """期权合约批量查询 (instrument-query-batch, POST).

    instrument_queries 每项需含: type / prodUnd / exp(到期日) / option_type(C/P) / strike(行权价).
    不缓存 (参数多变).
    """
    if not instrument_queries:
        return []
    return _post("instrument-query-batch", body={"instrument_queries": instrument_queries})


def get_instrument_series_batch(instruments: list[dict[str, Any]]) -> Any:
    """期权合约序列批量查询 (instrument-series-batch, POST).

    instruments 每项需含: type / prodUnd / exp / option_type / strike.
    不缓存.
    """
    if not instruments:
        return []
    return _post("instrument-series-batch", body={"instruments": instruments})


# ---------------------------------------------------------------------------
# 轻量行情图表 (chart/light) —— K 线 / 隐波 / 最新bar / 合约信息 / 曲面
# ---------------------------------------------------------------------------

def _history_get(path: str, symbol: str, resolution: str = "1D",
                  from_ts: int | None = None, to_ts: int | None = None) -> dict[str, Any]:
    """K 线 / 隐波历史公共拉取 (history / history-atmvol, GET).

    symbol: 合约代码如 SC2609 / 510300; resolution: 1D / 1H / 5m / 1m 等;
    from_ts / to_ts: Unix 秒, 默认近 1 年. 不缓存 (时间范围多变, 实时段会更新).
    """
    sym = (symbol or "").strip()
    if not sym:
        return {"data": []}
    now = int(time.time())
    params = {
        "symbol": sym,
        "resolution": resolution or "1D",
        "from": from_ts if from_ts is not None else now - 365 * 86400,
        "to": to_ts if to_ts is not None else now,
    }
    return _get(path, params=params)


def get_kline_history(symbol: str, resolution: str = "1D",
                      from_ts: int | None = None, to_ts: int | None = None) -> dict[str, Any]:
    """K 线历史 (history, GET).

    返回 {data:[{trade_date,open,high,low,close,...}]}. 不缓存.
    """
    return _history_get("history", symbol, resolution, from_ts, to_ts)


def get_atmvol_history(symbol: str, resolution: str = "1D",
                       from_ts: int | None = None, to_ts: int | None = None) -> dict[str, Any]:
    """ATM 隐含波动率历史 (history-atmvol, GET).

    参数同 get_kline_history. 返回 {data:[[date, atmvol], ...]}. 不缓存.
    """
    return _history_get("history-atmvol", symbol, resolution, from_ts, to_ts)


def get_last_bar(code: str) -> dict[str, Any]:
    """单个合约最新 bar (last-bar/{code}, GET). 实时 OHLC + oi + vol.

    缓存 60s (对齐自选合约轮询节奏), 休市冻结喂上一笔.
    """
    code = (code or "").strip()
    if not code:
        return {}
    return _cached(
        f"ovlab_lastbar::{code}",
        lambda: _get(f"last-bar/{code}"),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=60,
    )


def search_symbols(keyword: str = "", limit: int = 30) -> list[dict[str, Any]]:
    """标的搜索 (search-symbols, GET). 上游参数名是 search, 响应为 {data, pagination} 分页壳. 短缓存 60s."""
    kw = (keyword or "").strip()
    params: dict[str, Any] = {"search": kw} if kw else {}
    if limit and limit > 0:
        params["limit"] = limit

    def _unwrap() -> list[dict[str, Any]]:
        r = _get("search-symbols", params=params)
        if isinstance(r, dict):
            r = r.get("data")
        return r if isinstance(r, list) else []

    return _cached(
        f"ovlab_search::{kw}::{limit}",
        _unwrap,
        valid=lambda v: isinstance(v, list),
        ttl=60,
    )


def get_symbol_info(code: str) -> dict[str, Any]:
    """合约元信息 (symbol/{code}, GET): 交易所/交易时段/价格精度/到期日. 缓存 30 分钟."""
    code = (code or "").strip()
    if not code:
        return {}
    return _cached(
        f"ovlab_symbol::{code}",
        lambda: _get(f"symbol/{code}"),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=1800,
    )


def get_volatility_surface(product: str) -> dict[str, Any]:
    """波动率曲面 (volatility-surface/{product}, GET). 按到期月分组的 T 型报价/持仓. 缓存 2 分钟."""
    p = (product or "").strip()
    if not p:
        return {}
    return _cached(
        f"ovlab_volsurface::{p}",
        lambda: _get(f"volatility-surface/{p}"),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=120,
    )


def get_skewmap(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """偏度图 (skewmap, POST). body 可含 selectedExpiries. 不缓存 (POST)."""
    return _post("skewmap", body=body or {})


# ---------------------------------------------------------------------------
# T 型报价 (volatility-surface 解析 + Black-76 理论价)
# ---------------------------------------------------------------------------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def black76(fwd: float, strike: float, vol_pct: float, t: float, is_call: bool) -> float | None:
    """Black-76 期货期权理论价 (无贴现, 与盘面报价口径一致). vol_pct 百分数隐波, t 年化期限. 发散结果归 None."""
    if fwd <= 0 or strike <= 0 or vol_pct <= 0 or t <= 0:
        return None
    sig = vol_pct / 100.0
    sq = sig * math.sqrt(t)
    d1 = (math.log(fwd / strike) + 0.5 * sig * sig * t) / sq
    d2 = d1 - sq
    if is_call:
        v = fwd * _norm_cdf(d1) - strike * _norm_cdf(d2)
    else:
        v = strike * _norm_cdf(-d2) - fwd * _norm_cdf(-d1)
    return v if math.isfinite(v) else None


def theo_chg(px: float | None, px_yd: float | None) -> float | None:
    """理论价涨幅 (今-昨)/昨. 昨价非正则 None."""
    if px is None or px_yd is None or px_yd <= 0:
        return None
    v = (px - px_yd) / px_yd
    return v if math.isfinite(v) else None


def _sfloat(v: Any) -> float | None:
    """surface 标量都是 str: 转 float, 空串/非法/nan/inf 归 None (防 JSON 序列化 500)."""
    f: float | None = None
    if isinstance(v, (int, float)):
        f = float(v)
    elif isinstance(v, str):
        try:
            f = float(v.strip())
        except ValueError:
            return None
    if f is None or not math.isfinite(f):
        return None
    return f


def _sjson(v: Any) -> Any:
    """surface 复合字段是 JSON 字符串: 解 list/dict, 失败归 None."""
    if isinstance(v, (list, dict)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.startswith(("[", "{")):
            try:
                return json.loads(s)
            except Exception:
                return None
    return None


def _strike_map(v: Any) -> dict[float, float | None]:
    """[[strike, val], ...] -> {strike: val}; val 空串归 None."""
    arr = _sjson(v)
    out: dict[float, float | None] = {}
    if not isinstance(arr, list):
        return out
    for item in arr:
        if isinstance(item, list) and len(item) >= 2:
            k = _sfloat(item[0])
            if k is not None:
                out[k] = _sfloat(item[1])
    return out


def _xy(m: dict[float, float | None]) -> list[list[float]]:
    """Fitted smile pairs [[strike, iv], ...] from surface theovol (not T-ladder interp)."""
    return [[k, v] for k, v in sorted(m.items()) if v is not None]


def _lo_hi(v: Any) -> tuple[float | None, float | None]:
    """display_strike / trading_strike: [lo, hi]."""
    arr = _sjson(v)
    if not isinstance(arr, list) or len(arr) < 2:
        return None, None
    return _sfloat(arr[0]), _sfloat(arr[1])


def _oi_map(v: Any) -> dict[float, float | None]:
    """{"904.0": 336, ...} -> {904.0: 336}."""
    d = _sjson(v)
    out: dict[float, float | None] = {}
    if not isinstance(d, dict):
        return out
    for k, val in d.items():
        fk = _sfloat(k)
        if fk is not None:
            out[fk] = _sfloat(val)
    return out


# CFFEX index option unds (T 表走 prodUnd: IF/IH/IM). Upstream surface
# near expiry only returns an ATM stub (IF front: 5 rungs). Fill the ladder.
_INDEX_TQUOTE = frozenset({"IF", "IH", "IM", "IO", "HO", "MO"})


def _median_step(keys: list[float]) -> float | None:
    if len(keys) < 2:
        return None
    gaps = sorted(keys[i + 1] - keys[i] for i in range(len(keys) - 1) if keys[i + 1] > keys[i])
    if not gaps:
        return None
    return gaps[len(gaps) // 2]


def interp_iv(theo: dict[float, float | None], k: float) -> float | None:
    """Smile IV at strike k: exact hit, else linear in strike, wings flat."""
    got = theo.get(k)
    if got is not None and got > 0:
        return got
    xs = sorted(x for x, v in theo.items() if v is not None and v > 0)
    if not xs:
        return None
    if k <= xs[0]:
        return theo[xs[0]]
    if k >= xs[-1]:
        return theo[xs[-1]]
    for a, b in zip(xs, xs[1:]):
        if a <= k <= b:
            va, vb = theo[a], theo[b]
            if va is None or vb is None or b == a:
                return va if va is not None else vb
            t = (k - a) / (b - a)
            return va * (1.0 - t) + vb * t
    return None


def extend_index_strikes(
    product: str,
    keys: list[float],
    fwd: float | None,
    span: float = 0.15,
    min_n: int = 25,
) -> list[float]:
    """Index T-quote: pad a regular ladder around fwd (±span or min_n rungs).
    Commodities keep the upstream set."""
    ks = sorted(set(keys))
    if product.upper() not in _INDEX_TQUOTE:
        return ks
    step = _median_step(ks)
    if not step:
        return ks
    mid = float(fwd) if fwd else ks[len(ks) // 2]
    half = max(span * abs(mid), (min_n // 2) * step)
    lo, hi = mid - half, mid + half
    phase = ks[0]
    n0 = round((lo - phase) / step)
    out = set(ks)
    k = phase + n0 * step
    for _ in range(400):
        if k > hi + step * 0.1:
            break
        if k > 0:
            out.add(round(k, 6))
        k += step
    return sorted(out)


def _fut_months(product: str) -> dict[str, dict[str, float | None]]:
    """Per-expiry futures last from future-ts. ETF (digit product) has no futures."""
    if not product or product.isdigit():
        return {}
    raw = get_future_term_structure(product)
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, float | None]] = {}
    for k, blk in raw.items():
        if not isinstance(blk, dict):
            continue
        td = _sfloat(blk.get("future_tday"))
        if td is None:
            continue
        yd = _sfloat(blk.get("future_yday"))
        key = str(k)
        rec = {"px": td, "pct": theo_chg(td, yd)}
        out[key] = rec
        if len(key) >= 6:
            out[key[2:]] = rec
    return out


def _fut_of(futs: dict[str, dict[str, float | None]], exp: str) -> dict[str, float | None]:
    got = futs.get(exp)
    if got:
        return got
    tail = exp[2:] if len(exp) >= 6 else exp
    return futs.get(tail) or {}


def _build_tquote(product: str) -> dict[str, Any]:
    raw = get_volatility_surface(product)
    if not isinstance(raw, dict):
        return {}
    futs = _fut_months(product)
    expiries: list[dict[str, Any]] = []
    for exp_key in sorted(raw.keys()):
        blk = raw[exp_key]
        if not isinstance(blk, dict):
            continue
        fwd = _sfloat(blk.get("forward_td"))
        t = _sfloat(blk.get("maturity_tday"))
        theo = _strike_map(blk.get("theovol_tday"))
        if not theo:
            continue
        fwd_yd = _sfloat(blk.get("forward_yd"))
        t_yd = _sfloat(blk.get("maturity_yday"))
        theo_yd = _strike_map(blk.get("theovol_yday"))
        atm_yd = _sfloat(blk.get("atmvol_yday"))
        delta_c = _strike_map(blk.get("delta_tday_call"))
        delta_p = _strike_map(blk.get("delta_tday_put"))
        iv_cb = _strike_map(blk.get("mktvol_tday_call_bid"))
        iv_ca = _strike_map(blk.get("mktvol_tday_call_ask"))
        iv_pb = _strike_map(blk.get("mktvol_tday_put_bid"))
        iv_pa = _strike_map(blk.get("mktvol_tday_put_ask"))
        oi_c = _oi_map(blk.get("strike_poi_c"))
        oi_p = _oi_map(blk.get("strike_poi_p"))
        oid_c = _oi_map(blk.get("strike_oid_c"))
        oid_p = _oi_map(blk.get("strike_oid_p"))

        exp_str = str(blk.get("exp") or exp_key)
        base_keys = set(theo) | set(delta_c) | set(delta_p) | set(iv_cb) | set(iv_ca) | set(iv_pb) | set(iv_pa) | set(oi_c) | set(oi_p)
        keys = extend_index_strikes(product, sorted(base_keys), fwd)
        strikes: list[dict[str, Any]] = []
        for k in keys:
            theo_iv = interp_iv(theo, k)
            can_price = bool(fwd and t and theo_iv)
            px_c = black76(fwd, k, theo_iv, t, True) if can_price else None  # type: ignore[arg-type]
            px_p = black76(fwd, k, theo_iv, t, False) if can_price else None  # type: ignore[arg-type]
            iv_yd = interp_iv(theo_yd, k) if theo_yd else None
            if iv_yd is None:
                iv_yd = atm_yd
            can_yd = bool(fwd_yd and t_yd and iv_yd)
            px_c_yd = black76(fwd_yd, k, iv_yd, t_yd, True) if can_yd else None  # type: ignore[arg-type]
            px_p_yd = black76(fwd_yd, k, iv_yd, t_yd, False) if can_yd else None  # type: ignore[arg-type]
            strikes.append({
                "strike": k,
                "callCode": option_code(product, exp_str, "C", k),
                "putCode": option_code(product, exp_str, "P", k),
                "call": {
                    "price": px_c, "pct": theo_chg(px_c, px_c_yd),
                    "ivBid": iv_cb.get(k), "ivAsk": iv_ca.get(k),
                    "theoIv": theo_iv, "theoIvYd": iv_yd,
                    "delta": delta_c.get(k), "oi": oi_c.get(k), "oiChg": oid_c.get(k),
                },
                "put": {
                    "price": px_p, "pct": theo_chg(px_p, px_p_yd),
                    "ivBid": iv_pb.get(k), "ivAsk": iv_pa.get(k),
                    "theoIv": theo_iv, "theoIvYd": iv_yd,
                    "delta": delta_p.get(k), "oi": oi_p.get(k), "oiChg": oid_p.get(k),
                },
            })

        atm: float | None = None
        if fwd and keys:
            f = float(fwd)
            atm = min(keys, key=lambda k: abs(k - f))
        fut = _fut_of(futs, exp_str)
        disp_lo, disp_hi = _lo_hi(blk.get("display_strike"))
        expiries.append({
            "exp": exp_str,
            "und": und_code(product, exp_str),
            "expiryDate": str(blk.get("expiry_date") or ""),
            "dte": _sfloat(blk.get("days_to_expiry")),
            "maturity": t,
            "displayLo": disp_lo,
            "displayHi": disp_hi,
            "forward": fwd,
            "forwardYd": _sfloat(blk.get("forward_yd")),
            "futPx": fut.get("px"),
            "futPct": fut.get("pct"),
            "atmIv": _sfloat(blk.get("atmvol_tday")),
            "atmIvYd": _sfloat(blk.get("atmvol_yday")),
            "pcr": _sfloat(blk.get("rho_tday")),
            "moveUp": _sfloat(blk.get("move_up")),
            "moveDn": _sfloat(blk.get("move_dn")),
            "sumOiCall": _sfloat(blk.get("sum_oi_call")),
            "sumOiPut": _sfloat(blk.get("sum_oi_put")),
            "sumOiCallYd": _sfloat(blk.get("sum_poi_call")),
            "sumOiPutYd": _sfloat(blk.get("sum_poi_put")),
            "lastTime": str(blk.get("last_time") or ""),
            "atm": atm,
            "theoSmile": _xy(theo),
            "theoSmileYd": _xy(theo_yd),
            "strikes": strikes,
        })
    return {"product": product, "expiries": expiries}


def get_tquote(product: str) -> dict[str, Any]:
    """T 型报价: volatility-surface 解析 + Black-76 理论价. 缓存 2 分钟, 休市冻结."""
    p = (product or "").strip()
    if not p:
        return {}
    return _cached(
        f"ovlab_tquote::{p.upper()}",
        lambda: _build_tquote(p),
        valid=lambda v: isinstance(v, dict) and bool(v.get("expiries")),
        ttl=120,
    )


def option_code(prod_und: str, exp: str, cp: str, strike: float) -> str:
    """OpenVlab 期权合约代码: {prod}{exp[2:]}{C/P}{strike} (整数行权价去小数点).
    实测通用: SHFE/INE/DCE/CZCE/CFFEX/GFEX 期货期权 + ETF 期权 (5103002608C4.7)."""
    ym = exp[2:] if len(exp) >= 6 else exp
    return f"{prod_und}{ym}{cp.upper()}{strike:g}"


def und_code(product: str, exp: str) -> str:
    """IV 历史用的标的码: ETF 期权 (纯数字品种) 用基金代码本身, 期货期权用 {prod}{exp[2:]}."""
    if product.isdigit():
        return product
    ym = exp[2:] if len(exp) >= 6 else exp
    return f"{product}{ym}"


# ---------------------------------------------------------------------------
# 期权日K (分钟线聚合交易日 OHLCV + 标的平值隐波日线)
# ---------------------------------------------------------------------------

def _trading_day(ts: str) -> str:
    """分钟 bar 时间 -> 交易日: 夜盘 (>=20点) 归次交易日; 凌晨 (<6点) 是昨夜盘尾巴, 归前一晚的次交易日 (周末顺延). 节假日不判."""
    dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    if 6 <= dt.hour < 20:
        return dt.strftime("%Y-%m-%d")  # 日盘
    base = dt if dt.hour >= 20 else dt - timedelta(days=1)  # 夜盘起点晚
    nxt = base + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    return nxt.strftime("%Y-%m-%d")


def _build_option_daily(code: str, und: str) -> dict[str, Any]:
    now = int(time.time())
    minute = get_kline_history(code, "1", now - 200 * 86400, now)
    bars_in = minute.get("data") if isinstance(minute, dict) else None
    if not isinstance(bars_in, list) or not bars_in:
        return {}
    # 分钟 bar: [time, close, pct, oi, open, high, low, vol]
    days: dict[str, dict[str, Any]] = {}
    for b in bars_in:
        if not isinstance(b, (list, tuple)) or len(b) < 7:
            continue
        close = _sfloat(b[1])
        if close is None:
            continue
        vol = _sfloat(b[7]) or 0.0
        op = _sfloat(b[4])
        hi = _sfloat(b[5])
        lo = _sfloat(b[6])
        td = _trading_day(str(b[0]))
        d = days.get(td)
        if d is None:
            days[td] = {
                "t": td,
                "open": op if op is not None else close,
                "high": hi if hi is not None else close,
                "low": lo if lo is not None else close,
                "close": close,
                "vol": vol,
            }
        else:
            if hi is not None:
                d["high"] = max(d["high"], hi)
            if lo is not None:
                d["low"] = min(d["low"], lo)
            d["close"] = close
            d["vol"] += vol
    bars = [days[k] for k in sorted(days.keys())]
    if not bars:
        return {}
    # 标的平值隐波日线 (ETF 无则空)
    iv: list[list[Any]] = []
    if und:
        try:
            av = get_atmvol_history(und, "1D", now - 200 * 86400, now)
            arr = av.get("data") if isinstance(av, dict) else None
            if isinstance(arr, list):
                iv = [[str(x[0]), _sfloat(x[1])] for x in arr
                      if isinstance(x, (list, tuple)) and len(x) >= 2]
        except Exception:
            logger.warning("option-daily %s atmvol %s failed", code, und)
            iv = []
    return {"code": code, "und": und, "bars": bars, "iv": iv}


def get_option_daily(code: str, und: str = "") -> dict[str, Any]:
    """期权合约日K: 分钟线聚合交易日 OHLCV + 标的平值隐波日线. 缓存 5 分钟, 休市冻结."""
    c = (code or "").strip()
    if not c:
        return {}
    u = (und or "").strip()
    return _cached(
        f"ovlab_optdaily::{c.upper()}::{u.upper()}",
        lambda: _build_option_daily(c, u),
        valid=lambda v: isinstance(v, dict) and bool(v.get("bars")),
        ttl=300,
    )


# ---------------------------------------------------------------------------
# 期限结构 (volatility-surface 的 forward 今/昨曲线; future-ts-all 上游只覆盖 6 个品种, 弃用)
# ---------------------------------------------------------------------------

def _ts_curve(product: str) -> tuple[str, list[dict[str, Any]]]:
    """单品种远期曲线: [{exp, dte, fwd, fwdYd, oi, code}] 按 dte 升序.
    oi = 该月 Call+Put 期权持仓 (surface sum_oi); code = 标的合约码 (期货 AG2609, ETF 为基金代码)."""
    try:
        raw = get_volatility_surface(product)
    except Exception:
        logger.warning("term-structure surface %s failed", product)
        return product, []
    out: list[dict[str, Any]] = []
    if isinstance(raw, dict):
        for exp_key in sorted(raw.keys()):
            blk = raw[exp_key]
            if not isinstance(blk, dict):
                continue
            fwd = _sfloat(blk.get("forward_td"))
            dte = _sfloat(blk.get("days_to_expiry"))
            if fwd is None or dte is None:
                continue
            exp_str = str(blk.get("exp") or exp_key)
            oi_c = _sfloat(blk.get("sum_oi_call"))
            oi_p = _sfloat(blk.get("sum_oi_put"))
            oi = None if oi_c is None and oi_p is None else (oi_c or 0.0) + (oi_p or 0.0)
            out.append({
                "exp": exp_str,
                "dte": dte,
                "fwd": fwd,
                "fwdYd": _sfloat(blk.get("forward_yd")),
                "oi": oi,
                "code": und_code(product, exp_str),
            })
    out.sort(key=lambda x: x["dte"])
    return product, out


def _build_term_structure(prods: list[str]) -> dict[str, Any]:
    curves: dict[str, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for prod, curve in pool.map(_ts_curve, prods):
            if curve:
                curves[prod] = curve
    return {"curves": curves}


def get_term_structure(products: list[str]) -> dict[str, Any]:
    """多品种远期曲线 (volatility-surface forward). 并发拉取, 整体缓存 60s, 休市冻结."""
    prods = sorted({p.strip().upper() for p in products if p and p.strip()})[:80]
    if not prods:
        return {}
    return _cached(
        "ovlab_termstruct::" + ",".join(prods),
        lambda: _build_term_structure(prods),
        valid=lambda v: isinstance(v, dict) and bool(v.get("curves")),
        ttl=60,
    )


def get_surfacemap(params: dict[str, Any] | None = None) -> dict[str, Any]:
    """曲面图 (surfacemap, GET). params 可含 product 等. 缓存 2 分钟."""
    p = params or {}
    key = f"ovlab_surfacemap::{sorted(p.items())}"
    return _cached(
        key,
        lambda: _get("surfacemap", params=p),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=120,
    )


def _fut_unds(rows: list[dict[str, Any]] | None, tab: Any = None) -> list[str]:
    import qihuo_fee  # noqa: PLC0415

    out: list[str] = []
    for r in rows or []:
        u = str(r.get("prodUnd") or "").strip().upper()
        if not u or u.isdigit():
            continue
        if qihuo_fee.und_mult(u, tab):
            out.append(u)
    return sorted(set(out))


def _parked_one(und: str, tab: Any = None) -> dict[str, Any] | None:
    import fut_spec  # noqa: PLC0415
    import qihuo_fee  # noqa: PLC0415

    mult = qihuo_fee.und_mult(und, tab)
    fb = qihuo_fee.und_margin(und, tab)
    if mult is None or fb is None:
        return None
    mm = qihuo_fee.month_margins(und, tab)
    y = fut_spec.parked_from_ts(get_future_term_structure(und), mult, fb, mm)
    if y is None:
        return None
    return {"und": und, "parked": y, "mult": mult, "margin": fb}


def _build_parked(unds: list[str], tab: Any = None) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for row in pool.map(lambda u: _parked_one(u, tab), unds):
            if row:
                rows.append(row)
    rows.sort(key=lambda r: r["parked"], reverse=True)
    return {"rows": rows}


def get_parked_capital() -> dict[str, Any]:
    """Product parked from future-ts + 9qihuo spec. Reuses ovlab_future_ts::.

    Margin and multiplier from 9qihuo (key qihuo_fee). No local SPEC.
    Not the all-months dump. Not review warmup. Key ovlab_parked, 300s.
    """
    import qihuo_fee  # noqa: PLC0415

    tab = qihuo_fee.margins()
    unds = _fut_unds(get_market_overview(), tab)
    if not unds:
        return {"rows": []}
    return _cached(
        "ovlab_parked",
        lambda: _build_parked(unds, tab),
        valid=lambda v: isinstance(v, dict) and bool(v.get("rows")),
        ttl=300,
    )


# ---------------------------------------------------------------------------
# 启动预热
# ---------------------------------------------------------------------------

def warm_once() -> None:
    """启动时填一次驾驶舱首屏钥匙 (market / flow-alert / product-exps / 目录码分时).

    盘后启动: 这是休市期间唯一一次出网, 之后冻结到下一交易时段.
    盘中启动: 只是提前预热, 之后仍按 TTL 刷新. 失败只记日志, 不阻塞启动.
    future-ts-all 不预热: 期限结构卡走单品种 future-ts, 上游 all 只覆盖 6 个品种.
    """
    try:
        rows = get_market_overview()
    except Exception as e:
        logger.warning("deriv warm market failed: %s", e)
        return
    for label, fn in (
        ("flow-alert", get_flow_alerts),
        ("product-exps", get_product_exps),
    ):
        try:
            fn()
        except Exception as e:
            logger.info("deriv warm %s failed: %s", label, e)
    try:
        from deriv_catalog import DERIV_CATALOG  # noqa: PLC0415
        want = {p for p, _u, _n, _g, _s in DERIV_CATALOG}
        codes = sorted({
            f"{str(r.get('prodUnd') or '').strip()}:{str(r.get('exp') or '').strip()}"
            for r in rows
            if str(r.get("product") or "") in want
            and str(r.get("prodUnd") or "").strip()
            and str(r.get("exp") or "").strip()
        })
        if codes:
            get_price_volatility_series(codes)
            logger.info("deriv warm price-vol: %d codes", len(codes))
    except Exception as e:
        logger.info("deriv warm price-vol failed: %s", e)


# ---------------------------------------------------------------------------
# 持仓排名 (flow/option-flow) —— 期权 / 期货 持仓品种列表 + 持仓明细排名
# ---------------------------------------------------------------------------

def get_option_position_products() -> dict[str, Any]:
    """期权持仓品种列表 (option-position/products, GET).
    返回 {last_trading_day, products:[{product, product_alias, exchange_name, codes}]}.
    缓存 1 小时 (品种元数据低频变动).
    """
    return _cached(
        "ovlab_opt_pos_products",
        lambda: _get("option-position/products"),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=3600,
    )


def get_option_position_details(product: str, code: str, direction: str, day: str) -> dict[str, Any]:
    """期权持仓明细 (option-position/details, GET).
    product: 品种如 SC/IO; code: 合约如 SC2609; direction: C 或 P; day: YYYY-MM-DD.
    返回持仓排名表/图表数据 (可能为空 dict, 某些合约无明细). 缓存 5 分钟.
    响应为双层壳 {code:0, result:{code:200, message, data:{...}}}, 取 result.data.
    """
    p = (product or "").strip()
    c = (code or "").strip()
    d = (direction or "").strip().upper()
    dy = (day or "").strip()
    if not (p and c and d and dy):
        return {}
    if d not in ("C", "P"):
        return {}
    params = {"product": p, "code": c, "direction": d, "day": dy}
    key = f"ovlab_opt_pos_detail::{p}::{c}::{d}::{dy}"

    def _fetch() -> dict[str, Any]:
        r = _get("option-position/details", params=params)
        if isinstance(r, dict) and isinstance(r.get("data"), dict):
            return r["data"]
        return r if isinstance(r, dict) else {}

    return _cached(
        key,
        _fetch,
        valid=lambda v: isinstance(v, dict),
    )


def get_future_position_products() -> dict[str, Any]:
    """期货持仓品种列表 (future-position/products, GET).
    返回 {last_trading_day, products:[{product, product_alias, exchange_name, codes}]}.
    缓存 1 小时.
    """
    return _cached(
        "ovlab_fut_pos_products",
        lambda: _get("future-position/products"),
        valid=lambda v: isinstance(v, dict) and bool(v),
        ttl=3600,
    )


def get_future_position_details(product: str, code: str, direction: str, day: str) -> dict[str, Any]:
    """期货持仓明细 (future-position/details, GET).
    product: 品种如 RB; code: 合约如 rb2608; direction: 任意 (后端忽略, 传 0 即可); day: YYYY-MM-DD.
    返回 {codes, futureName, instrument, tradingDay, days, short_rank_table, long_rank_table,
    net_short_rank_table, net_long_rank_table, *_rank_chart, maxNetShort, maxNetLong, status}.
    缓存 5 分钟. 响应为双层壳, 取 result.data.
    """
    p = (product or "").strip()
    c = (code or "").strip()
    d = (direction or "0").strip()
    dy = (day or "").strip()
    if not (p and c and dy):
        return {}
    params = {"product": p, "code": c, "direction": d, "day": dy}
    key = f"ovlab_fut_pos_detail::{p}::{c}::{dy}"

    def _fetch() -> dict[str, Any]:
        r = _get("future-position/details", params=params)
        if isinstance(r, dict) and isinstance(r.get("data"), dict):
            return r["data"]
        return r if isinstance(r, dict) else {}

    return _cached(
        key,
        _fetch,
        valid=lambda v: isinstance(v, dict),
    )
