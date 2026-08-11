"""持仓数据层 —— 用户自己录入的持仓 + 实时行情叠加浮动盈亏。

合规：持仓是用户主动录入的自己的标的（存本地 ~/.vibe-research/portfolio.json，
不上传、不进仓库），不预置任何标的、不含 _SEED 兜底、不做推荐。
盈亏红涨绿跌（A股口径）。含每半小时后台定时刷新 + 手动刷新。

存储位置：默认用户目录 ~/.vibe-research/（可用 VR_DATA_DIR 覆盖）——
放仓库外，重新下载/覆盖项目文件夹不会丢数据（issue #12）。
≤v0.1.1 存在 backend/.cache/ 仓库内，首次启动自动迁移（复制，旧文件保留作备份）。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timezone, timedelta

import astock
import gstock

HERE = os.path.dirname(os.path.abspath(__file__))
_OLD_PF_FILE = os.path.join(HERE, ".cache", "portfolio.json")  # ≤v0.1.1 旧位置
# CACHE_DIR 名字保留（测试/外部按此名 monkeypatch），实际已是用户数据目录
CACHE_DIR = os.environ.get("VR_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".vibe-research")
PF_FILE = os.path.join(CACHE_DIR, "portfolio.json")
BEIJING = timezone(timedelta(hours=8))
_LOCK = threading.Lock()


def _migrate_legacy() -> None:
    """旧版持仓在仓库内 .cache/ 里，重下载项目会丢；迁到用户目录（新位置已有则不动）。"""
    try:
        if not os.path.exists(PF_FILE) and os.path.exists(_OLD_PF_FILE):
            os.makedirs(CACHE_DIR, exist_ok=True)
            tmp = PF_FILE + ".migrate.tmp"
            shutil.copy2(_OLD_PF_FILE, tmp)
            os.replace(tmp, PF_FILE)  # 原子落位：复制中断不会留半截 portfolio.json 挡住下次重试
    except OSError as e:
        # 迁移失败不阻塞启动，但要出声——旧数据原样保留在 _OLD_PF_FILE，可手工复制
        print(f"[vibe-research] 持仓数据迁移失败（旧数据仍在 {_OLD_PF_FILE}）: {e}", file=sys.stderr)


_migrate_legacy()


def _now() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M")


def _load() -> dict:
    try:
        with open(PF_FILE, encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"holdings": [], "last_refresh": None}
    # 旧数据迁移：≤6位限制时全是 A 股，缺 market 字段补 "A"
    for h in d.get("holdings", []):
        if "market" not in h:
            h["market"] = "A"
    for c in d.get("closed", []):
        if "market" not in c:
            c["market"] = "A"
    return d


def _save(d: dict) -> None:
    # 先写临时文件再原子改名：并发读若撞上写中途的半截 JSON，会被 _load 静默当成空持仓
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = PF_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, PF_FILE)


def _holdings_list() -> list[dict]:
    """读盘返回纯持仓列表（不拉行情），供 add/remove 写盘后确认用。"""
    with _LOCK:
        return _load().get("holdings", [])


def add_holding(code: str, market: str, shares: float, cost: float) -> list[dict]:
    """加一笔持仓；同代码则按加权平均成本合并（加仓）。返回写盘后的纯持仓列表（不含行情）。"""
    with _LOCK:
        d = _load()
        for h in d["holdings"]:
            if h["code"] == code:
                total = h["shares"] + shares
                # 4 位小数：ETF/基金成本常见 3-4 位（issue #13），2-3 位会让市值/盈亏对不上账
                h["cost"] = round((h["shares"] * h["cost"] + shares * cost) / total, 4) if total else cost
                h["shares"] = total
                break
        else:
            d["holdings"].append({"code": code, "market": market, "shares": shares, "cost": cost})
        _save(d)
    return _holdings_list()  # 不调 get_portfolio()，前端乐观更新


def remove_holding(code: str) -> list[dict]:
    """删除一笔持仓。返回写盘后的纯持仓列表（不含行情）。"""
    with _LOCK:
        d = _load()
        d["holdings"] = [h for h in d["holdings"] if h["code"] != code]
        _save(d)
    return _holdings_list()


def close_position(code: str, market: str, date: str, price: float, shares: float, cost: float) -> dict:
    """记一笔已清仓：算已实现盈亏，存入 closed 列表。"""
    pnl = (price - cost) * shares
    with _LOCK:
        d = _load()
        d.setdefault("closed", [])
        # 名称回填按市场分流：A 股 → 腾讯批量行情；港美股 → gstock；场外基金 → fund_nav
        name = code
        try:
            if market == "A":
                name = astock.tencent_quote([code]).get(code, {}).get("name", code)
            elif market == "FD":
                name = astock.fund_nav([code]).get(code, {}).get("name", "") or code
            else:
                g = gstock.us_hk_stock(code)
                name = (g.get("name") or g.get("quote", {}).get("name") or code) if g else code
        except Exception:
            pass
        d["closed"].append({
            "code": code, "market": market, "name": name, "date": date, "price": price,
            "shares": shares, "cost": cost, "pnl": round(pnl, 2),
            "pnl_pct": round((price - cost) / cost * 100, 2) if cost else 0.0,
        })
        _save(d)
    return get_portfolio()


def remove_closed(index: int) -> dict:
    with _LOCK:
        d = _load()
        cl = d.get("closed", [])
        if 0 <= index < len(cl):
            cl.pop(index)
            _save(d)
    return get_portfolio()


def get_portfolio() -> dict:
    """读持仓 + 实时行情，算每笔与汇总的市值/浮动盈亏。按市场分组汇总（不折算汇率）。"""
    with _LOCK:
        d = _load()
    hs = d.get("holdings", [])
    rows = []
    # 按市场分组：A 股批量走 tencent_quote（高效），港美股逐个走 gstock，
    # 场外基金批量走 fund_nav（东财 lsjz，内部逐个查受 1 秒限流）
    a_codes = [h["code"] for h in hs if h.get("market", "A") == "A"]
    a_quotes = {}
    if a_codes:
        try:
            a_quotes = astock.tencent_quote(a_codes)
        except Exception:
            a_quotes = {}
    fd_codes = [h["code"] for h in hs if h.get("market") == "FD"]
    fd_quotes = {}
    if fd_codes:
        try:
            fd_quotes = astock.fund_nav(fd_codes)
        except Exception:
            fd_quotes = {}

    # 分市场累加
    mkt_mv: dict[str, float] = {}
    mkt_cost: dict[str, float] = {}
    for h in hs:
        market = h.get("market", "A")
        price = 0.0
        name = h["code"]
        if market == "A":
            q = a_quotes.get(h["code"], {})
            price = q.get("price", 0.0)
            name = q.get("name", h["code"])
        elif market == "FD":
            q = fd_quotes.get(h["code"], {})
            price = q.get("price", 0.0)  # 单位净值
            name = q.get("name", "") or h["code"]
        else:
            try:
                g = gstock.us_hk_stock(h["code"])
                if g and g.get("quote"):
                    price = g["quote"].get("price") or 0.0
                    name = g.get("name") or g["quote"].get("name") or h["code"]
            except Exception:
                pass
        mv = price * h["shares"]
        cv = h["cost"] * h["shares"]
        pnl = mv - cv
        rows.append({
            "code": h["code"], "market": market, "name": name,
            "price": price, "shares": h["shares"], "cost": h["cost"],
            "market_value": round(mv, 2), "pnl": round(pnl, 2),
            "pnl_pct": round(pnl / cv * 100, 2) if cv else 0.0,
        })
        mkt_mv[market] = mkt_mv.get(market, 0.0) + mv
        mkt_cost[market] = mkt_cost.get(market, 0.0) + cv

    # 按市场分组汇总（不折算汇率，各自独立）
    totals = []
    for market in sorted(mkt_mv.keys()):
        mv = mkt_mv[market]
        cost = mkt_cost[market]
        pnl = mv - cost
        totals.append({
            "market": market,
            "market_value": round(mv, 2),
            "cost": round(cost, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl / cost * 100, 2) if cost else 0.0,
        })

    closed = d.get("closed", [])
    return {
        "holdings": rows,
        "totals": totals,
        "closed": closed,
        "realized_pnl": round(sum(c.get("pnl", 0) for c in closed), 2),
        "updated": _now(),
        "last_refresh": d.get("last_refresh"),
    }


def _refresh_snapshot() -> None:
    """后台定时任务：刷新时间戳（GET 本就实时算，这里记录后台刷新点）。"""
    with _LOCK:
        d = _load()
        d["last_refresh"] = _now()
        _save(d)


def start_scheduler(interval: int = 1800) -> None:
    """每半小时后台刷新一次持仓数据（daemon 线程）。"""
    def loop():
        while True:
            time.sleep(interval)
            try:
                _refresh_snapshot()
            except Exception:
                pass
    threading.Thread(target=loop, daemon=True).start()
