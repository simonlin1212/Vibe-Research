from __future__ import annotations

import asyncio
import queue

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import ovlab

router = APIRouter(tags=["ovlab"])

def _ovlab_call(fn, label: str):
    """OpenVlab 端点统一异常包装: 缺依赖 501, 其他 502."""
    try:
        return {"data": fn()}
    except ovlab.DependencyMissing as e:
        raise HTTPException(501, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"OpenVlab {label}异常：{e}") from e


class FlowDataReq(BaseModel):
    product: str | None = None
    page: int = 1
    page_size: int = 20


class WarehouseHistoryReq(BaseModel):
    product: str


class PriceVolSeriesReq(BaseModel):
    # Accept list (preferred) or JSON/comma string for older clients
    codes: list[str] | str


class SkewmapReq(BaseModel):
    selectedExpiries: dict | None = None

@router.get("/api/ovlab/market")
def ovlab_market():
    """OpenVlab 市场概览: 全部品种的行情 / 平值隐波 / 偏度 / carry 等概览 (ctamap-all)。缓存 5 分钟。"""
    return _ovlab_call(ovlab.get_market_overview, "市场概览")


@router.get("/api/ovlab/detail")
def ovlab_detail(
    prod_und: str = Query(
        ..., min_length=1, max_length=32, description="标的代码, 如 510300"
    ),
    exps: str | None = Query(None, description="可选, 逗号分隔的合约月份列表"),
):
    """OpenVlab 单个标的详细数据 (dto/{prodUnd})。缓存 5 分钟。"""
    exp_list = [e.strip() for e in exps.split(",") if e.strip()] if exps else None
    return _ovlab_call(
        lambda: ovlab.get_product_detail(prod_und.strip(), exp_list), "个股详情"
    )


@router.get("/api/ovlab/volatility-ts")
def ovlab_volatility_ts():
    """OpenVlab 波动率期限结构汇总 (volatility-ts-all)。部分字段可能受限。缓存 5 分钟。"""
    return _ovlab_call(ovlab.get_volatility_term_structures, "波动率期限结构")


# —— 期货期限结构 ——


@router.get("/api/ovlab/future-ts-all")
def ovlab_future_ts_all():
    """OpenVlab 期货期限结构汇总 (future-ts-all)，全品种。缓存 5 分钟。"""
    return _ovlab_call(ovlab.get_future_term_structures_all, "期货期限结构汇总")


@router.get("/api/ovlab/future-ts")
def ovlab_future_ts(
    prod_und: str = Query(
        ..., min_length=1, max_length=32, description="标的代码, 如 MA"
    ),
):
    """OpenVlab 单品种期货期限结构 (future-ts/{prodUnd})。缓存 5 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_future_term_structure(prod_und.strip()), "期货期限结构"
    )


@router.get("/api/ovlab/parked")
def ovlab_parked():
    """本地沉淀资金: future-ts 各月持仓x价格x乘数x保证金率. 复用 future-ts 钥匙, 300s."""
    return _ovlab_call(ovlab.get_parked_capital, "品种沉淀资金")


@router.get("/api/ovlab/arb-board")
def ovlab_arb_board():
    """跨期/跨品种/股指近月. 复用 future-ts 钥匙, 60s 冻结. 不打 market / future-ts-all."""
    return _ovlab_call(ovlab.get_arb_board, "套利看板")


# —— 异动 / 资金流 ——


@router.get("/api/ovlab/flow-alert")
def ovlab_flow_alert():
    """OpenVlab 异动榜 (flow-alert): 成交/走势/连续成交, 含到期日与区间涨幅. 盘中缓存 60 秒."""
    return _ovlab_call(ovlab.get_flow_alerts, "异动榜")


def _mqtt_pin(pin: str | None) -> None:
    import ovlab_mqtt
    if not pin:
        return
    codes = [p.strip() for p in pin.split(",") if p.strip()][:12]
    if codes:
        ovlab_mqtt.pin_dataview(codes)


@router.get("/api/ovlab/mqtt")
def ovlab_mqtt_status(pin: str | None = Query(default=None, max_length=400)):
    """OpenVlab MQTT snapshot: optionflow / ctamap / dataview. Does not write REST cache.

    SSE GET /mqtt/stream is the live path; this poll is the fallback.
    Optional pin=CODE,UND keeps those instr in the 800-slot dataview LRU
    and extra-subscribes instr/{alias}. Omit pin to leave pins as-is
    (arb cockpit shares this feed).
    """
    import ovlab_mqtt
    _mqtt_pin(pin)
    return {"data": ovlab_mqtt.snapshot()}


@router.get("/api/ovlab/mqtt/stream")
async def ovlab_mqtt_stream(
    request: Request,
    pin: str | None = Query(default=None, max_length=400),
):
    """SSE of the in-process MQTT sidecar. Same memory as GET /mqtt; push, not poll.

    First event is a full snapshot; later events are per-message patches.
    Webpage does not connect to OpenVlab EMQX. Does not write REST cache.
    """
    import ovlab_mqtt

    _mqtt_pin(pin)
    q = ovlab_mqtt.watch()

    async def gen():
        try:
            yield ovlab_mqtt.format_sse("snapshot", ovlab_mqtt.snapshot())
            idle = 0
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await asyncio.to_thread(q.get, True, 1.0)
                except queue.Empty:
                    idle += 1
                    if idle >= 15:
                        idle = 0
                        yield ": ping\n\n"
                    continue
                idle = 0
                yield ovlab_mqtt.format_sse("tick", evt)
        finally:
            ovlab_mqtt.unwatch(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/ovlab/flow-data")
def ovlab_flow_data(req: FlowDataReq):
    """OpenVlab 资金流分页数据 (flow-data, POST)。不缓存（参数多变）。"""
    body: dict = {"page": req.page, "pageSize": req.page_size}
    if req.product:
        body["product"] = req.product.strip()
    return _ovlab_call(lambda: ovlab.get_flow_data(body), "资金流")


# —— 持仓 / 仓差 ——


@router.post("/api/ovlab/warehouse-history")
def ovlab_warehouse_history(req: WarehouseHistoryReq):
    """OpenVlab 单品种多年仓单/持仓历史 (warehouse/history, POST)。缓存 5 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_warehouse_history(req.product.strip()), "持仓历史"
    )


@router.get("/api/ovlab/warehouse-receipt")
def ovlab_warehouse_receipt(
    product: str = Query(..., min_length=1, max_length=16, description="品种, 如 AU"),
):
    """仓单瘦身: 最新/日变/近90日. 复用 warehouse/history 缓存, 对齐 /future/warehouse-receipt."""
    return _ovlab_call(
        lambda: ovlab.get_warehouse_receipt(product.strip()), "仓单"
    )


@router.post("/api/ovlab/price-volatility-series")
def ovlab_price_volatility_series(req: PriceVolSeriesReq):
    """OpenVlab 价格+隐波分时预览 (price-volatility-series)。

    codes: 品种:到期月 列表, 如 [\"MA:202609\"], 或 JSON 字符串. 缓存 5 分钟.
    """
    return _ovlab_call(
        lambda: ovlab.get_price_volatility_series(req.codes), "价格波动率序列"
    )


# —— 元数据 ——


@router.get("/api/ovlab/product-exps")
def ovlab_product_exps(
    prod_und: str | None = Query(None, description="可选, 指定单品种"),
):
    """OpenVlab 全品种合约月份列表 (product-exps)。缓存 30 分钟。"""
    return _ovlab_call(lambda: ovlab.get_product_exps(prod_und), "合约月份")


@router.get("/api/ovlab/exchange-info")
def ovlab_exchange_info():
    """OpenVlab 交易所信息 (exchange-info)。缓存 1 小时。"""
    return _ovlab_call(ovlab.get_exchange_info, "交易所信息")


@router.get("/api/ovlab/sector-info")
def ovlab_sector_info():
    """OpenVlab 板块信息 (sector-info)。缓存 1 小时。"""
    return _ovlab_call(ovlab.get_sector_info, "板块信息")


@router.get("/api/ovlab/next-trading-day")
def ovlab_next_trading_day():
    """OpenVlab 下一交易日 (next-trading-day)。缓存 1 小时。"""
    return _ovlab_call(ovlab.get_next_trading_day, "下一交易日")


@router.get("/api/ovlab/holidays")
def ovlab_holidays(
    exchange: str = Query(
        ..., min_length=1, max_length=16, description="交易所代码, 如 CZCE"
    ),
):
    """OpenVlab 某交易所节假日日历 (holidays/{exchange})。缓存 1 小时。"""
    return _ovlab_call(lambda: ovlab.get_holidays(exchange.strip()), "节假日")


# —— 轻量行情图表 (chart/light) ——


@router.get("/api/ovlab/kline-history")
def ovlab_kline_history(
    response: Response,
    symbol: str = Query(
        ..., min_length=1, max_length=64, description="合约代码, 如 SC2609"
    ),
    resolution: str = Query("1D", description="周期: 1D / 1H / 5m / 1m"),
    from_ts: int | None = Query(None, description="Unix 秒, 默认近 1 年"),
    to_ts: int | None = Query(None, description="Unix 秒, 默认当前"),
):
    """OpenVlab K 线历史 (history)。不缓存。"""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return _ovlab_call(
        lambda: ovlab.get_kline_history(symbol.strip(), resolution, from_ts, to_ts),
        "K 线历史",
    )


@router.get("/api/ovlab/atmvol-history")
def ovlab_atmvol_history(
    response: Response,
    symbol: str = Query(
        ..., min_length=1, max_length=64, description="合约代码, 如 SC2609"
    ),
    resolution: str = Query("1D"),
    from_ts: int | None = Query(None),
    to_ts: int | None = Query(None),
):
    """OpenVlab ATM 隐含波动率历史 (history-atmvol)。不缓存。"""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return _ovlab_call(
        lambda: ovlab.get_atmvol_history(symbol.strip(), resolution, from_ts, to_ts),
        "ATMV 历史",
    )


@router.get("/api/ovlab/last-bar")
def ovlab_last_bar(
    code: str = Query(
        ..., min_length=1, max_length=64, description="合约代码, 如 SC2609"
    ),
):
    """OpenVlab 单合约最新 bar (last-bar/{code})。缓存 60s, 休市喂上一笔。"""
    return _ovlab_call(lambda: ovlab.get_last_bar(code.strip()), "最新 bar")


@router.get("/api/ovlab/search-symbols")
def ovlab_search_symbols(
    keyword: str = Query("", description="模糊关键词"),
    limit: int = Query(30, ge=1, le=200),
):
    """OpenVlab 标的搜索 (search-symbols)。短缓存 60s。"""
    return _ovlab_call(lambda: ovlab.search_symbols(keyword.strip(), limit), "标的搜索")


@router.get("/api/ovlab/symbol-info")
def ovlab_symbol_info(
    code: str = Query(
        ..., min_length=1, max_length=64, description="合约代码, 如 SC2609"
    ),
):
    """OpenVlab 合约元信息 (symbol/{code}): 交易时段/价格精度/到期日。缓存 30 分钟。"""
    return _ovlab_call(lambda: ovlab.get_symbol_info(code.strip()), "合约信息")


@router.get("/api/ovlab/volatility-surface")
def ovlab_volatility_surface(
    product: str = Query(
        ..., min_length=1, max_length=32, description="标的代码, 如 SC"
    ),
):
    """OpenVlab 波动率曲面 (volatility-surface/{product})。缓存 2 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_volatility_surface(product.strip()), "波动率曲面"
    )


@router.get("/api/ovlab/tquote")
def ovlab_tquote(
    product: str = Query(
        ..., min_length=1, max_length=32, description="品种代码, 如 AU"
    ),
):
    """OpenVlab T 型报价: 按到期月分组的行权价链 (IV/Delta/持仓) + Black-76 理论价。缓存 2 分钟。"""
    return _ovlab_call(lambda: ovlab.get_tquote(product.strip()), "T型报价")


@router.get("/api/ovlab/option-daily")
def ovlab_option_daily(
    code: str = Query(
        ..., min_length=1, max_length=40, description="期权合约代码, 如 AU2609C952"
    ),
    und: str = Query("", description="标的代码 (IV 日线用), 如 AU2609; ETF 期权传基金代码"),
):
    """OpenVlab 期权日K: 分钟线聚合交易日 OHLCV + 标的平值隐波日线。缓存 5 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_option_daily(code.strip(), und.strip()), "期权日K"
    )


@router.get("/api/ovlab/term-structure")
def ovlab_term_structure(
    products: str = Query(
        ..., min_length=1, max_length=800, description="逗号分隔品种代码, 如 AU,AG,CU"
    ),
):
    """OpenVlab 期限结构: 多品种远期曲线 (volatility-surface forward 今/昨)。并发拉取, 缓存 60 秒。"""
    plist = [p for p in products.split(",") if p.strip()]
    return _ovlab_call(lambda: ovlab.get_term_structure(plist), "期限结构")


@router.post("/api/ovlab/skewmap")
def ovlab_skewmap(req: SkewmapReq):
    """OpenVlab 偏度图 (skewmap, POST)。不缓存。"""
    return _ovlab_call(
        lambda: ovlab.get_skewmap(req.model_dump(exclude_none=True)), "偏度图"
    )


@router.get("/api/ovlab/surfacemap")
def ovlab_surfacemap(product: str | None = Query(None, description="可选标的代码")):
    """OpenVlab 曲面图 (surfacemap, GET)。缓存 2 分钟。"""
    params = {"product": product.strip()} if product and product.strip() else {}
    return _ovlab_call(lambda: ovlab.get_surfacemap(params), "曲面图")


# —— 持仓排名 (flow/option-flow) ——


@router.get("/api/ovlab/option-position-products")
def ovlab_option_position_products():
    """OpenVlab 期权持仓品种列表 (option-position/products)。缓存 1 小时。"""
    return _ovlab_call(ovlab.get_option_position_products, "期权持仓品种")


@router.get("/api/ovlab/option-position-details")
def ovlab_option_position_details(
    product: str = Query(
        ..., min_length=1, max_length=32, description="品种, 如 SC/IO"
    ),
    code: str = Query(..., min_length=1, max_length=64, description="合约, 如 SC2609"),
    direction: str = Query(..., description="方向: C 或 P"),
    day: str = Query(..., description="日期 YYYY-MM-DD"),
):
    """OpenVlab 期权持仓明细 (option-position/details)。缓存 5 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_option_position_details(
            product.strip(), code.strip(), direction.strip(), day.strip()
        ),
        "期权持仓明细",
    )


@router.get("/api/ovlab/future-position-products")
def ovlab_future_position_products():
    """OpenVlab 期货持仓品种列表 (future-position/products)。缓存 1 小时。"""
    return _ovlab_call(ovlab.get_future_position_products, "期货持仓品种")


@router.get("/api/ovlab/future-position-details")
def ovlab_future_position_details(
    product: str = Query(..., min_length=1, max_length=32, description="品种, 如 RB"),
    code: str = Query(..., min_length=1, max_length=64, description="合约, 如 rb2608"),
    direction: str = Query("0", description="方向 (后端忽略, 传 0 即可)"),
    day: str = Query(..., description="日期 YYYY-MM-DD"),
):
    """OpenVlab 期货持仓明细 (future-position/details)。缓存 5 分钟。"""
    return _ovlab_call(
        lambda: ovlab.get_future_position_details(
            product.strip(), code.strip(), direction.strip(), day.strip()
        ),
        "期货持仓明细",
    )
