# 持仓添加/删除性能优化方案

## 目标
添加/删除持仓时不再调用询价/净值接口，前端在现有收益基础上本地加减，后续整体轮询时统一校准。

## 现状分析（慢的根源）
- `backend/portfolio.py:79-101` `add_holding`/`remove_holding` 写盘后都调 `get_portfolio()`
- `get_portfolio()`（portfolio.py:141）每次实时拉全部行情：A股走腾讯批量(~1s)，场外基金走 `fund_nav` 逐个调东财 lsjz+fundsuggest 受 1 秒限流(每只~2s)，港美股逐个调 gstock(~2-3s/只)
- N 只场外基金 → 每次添加/删除等 ~2N 秒

## 改动方案

### 1. 后端：add/remove 只写盘，返回轻量数据
**文件**：`backend/portfolio.py`

- `add_holding(code, market, shares, cost)`：
  - 写盘逻辑不变（合并/追加）
  - 返回值从 `get_portfolio()` 改为写盘后的 **纯持仓列表** `list[dict]`（`[{code, market, shares, cost}]`，不含行情）
- `remove_holding(code)`：同上，返回写盘后的纯持仓列表
- 新增辅助函数 `_holdings_list() -> list[dict]`：加锁读盘，返回 holdings 纯数据（不拉行情）

```python
def _holdings_list() -> list[dict]:
    with _LOCK:
        return _load().get("holdings", [])

def add_holding(...) -> list[dict]:
    with _LOCK:
        d = _load()
        # ... 合并/追加逻辑不变 ...
        _save(d)
    return _holdings_list()  # 不调 get_portfolio()

def remove_holding(code) -> list[dict]:
    with _LOCK:
        d = _load()
        d["holdings"] = [h for h in d["holdings"] if h["code"] != code]
        _save(d)
    return _holdings_list()
```

### 2. 后端：app.py 端点返回类型调整
**文件**：`backend/app.py`

- `/api/portfolio/holding` POST 和 DELETE：返回 `{"data": [...holdings]}`（纯列表，不再是完整 PortfolioData）

### 3. 前端：api.ts 返回类型调整
**文件**：`frontend/src/lib/api.ts`

- `addHolding`/`removeHolding` 返回类型从 `PortfolioData` 改为轻量持仓项数组
- 新增类型 `HoldingBase`：`{code, market, shares, cost}`（不含行情字段）

```typescript
export interface HoldingBase { code: string; market: string; shares: number; cost: number }

addHolding: (...) => request<HoldingBase[]>("/portfolio/holding", "POST", {...}),
removeHolding: (code) => request<HoldingBase[]>(`/portfolio/holding?code=...`, "DELETE"),
```

### 4. 前端：Portfolio.tsx 乐观更新
**文件**：`frontend/src/pages/Portfolio.tsx`

**添加（add 函数）**：
- 调 `api.addHolding` 拿回写盘后的 holdings 纯列表（确认写盘成功）
- 本地构造新 `Holding` 行插入 `data.holdings`：
  - `price`：场外基金用已有的 `navPrice`；A股/港美股用 `0`（待校准）
  - `name`：场外基金用搜索时已知的名称；A股/港美股用 `code` 占位
  - `market_value`/`pnl`/`pnl_pct`：用已知 price+shares+cost 本地计算
- 本地更新 `data.totals`：对应 market 的 market_value/cost/pnl 增量累加
- 不等行情，**瞬时响应**

```typescript
const add = async () => {
  // ... 校验 ...
  const baseList = await api.addHolding(code.trim(), s, c, selMarket);
  // 本地乐观更新
  setData(prev => {
    if (!prev) return prev;
    const price = selMarket === "FD" ? (navPrice ?? 0) : 0;
    const name = selMarket === "FD" ? (搜索时已知的名称) : code.trim();
    const mv = price * s, cv = c * s, pnl = mv - cv;
    const newRow: Holding = { code, market: selMarket, name, price, shares: s, cost: c,
      market_value: mv, pnl, pnl_pct: cv ? pnl/cv*100 : 0 };
    const holdings = [...prev.holdings, newRow]; // 同代码合并场景：需替换而非追加
    const totals = recomputeTotals(prev.totals, selMarket, mv, cv, pnl);
    return { ...prev, holdings, totals };
  });
  // 清空表单
};
```

**删除（remove 函数）**：
- 调 `api.removeHolding` 拿回确认
- 本地从 `data.holdings` 移除该行
- 本地从 `data.totals` 对应 market 减去该行的 market_value/cost/pnl

```typescript
const remove = async (c: string) => {
  await api.removeHolding(c);
  setData(prev => {
    if (!prev) return prev;
    const row = prev.holdings.find(h => h.code === c);
    if (!row) return prev;
    const holdings = prev.holdings.filter(h => h.code !== c);
    const totals = recomputeTotals(prev.totals, row.market, -row.market_value, -row.cost, -row.pnl);
    return { ...prev, holdings, totals };
  });
};
```

**辅助函数 `recomputeTotals`**：对指定 market 的 total 增减 mv/cost/pnl，重算 pnl_pct。

### 5. 校准时机（不改逻辑，复用现有机制）
- 前端 `setInterval(load, 30min)` 自动调 `api.portfolio()`（get_portfolio 含行情）→ 校准
- 手动刷新按钮调 `api.refreshPortfolio()` → 校准
- 新增的 A股/港美股持仓 price=0，下次轮询自动补上真实行情

## 不改的部分
- `get_portfolio()` 本身不改（轮询时正常拉行情）
- `close_position` 暂不改（用户未提清仓慢，且名称回填有其特殊性）
- `start_scheduler` 不改（本就只更新时间戳）
- `useLiveQuotes` 不涉及（持仓页未用）

## 边界情况
- **同代码加仓**：后端按加权平均成本合并，前端乐观更新需替换已有行而非追加（用 baseList 的最新 shares/cost 覆盖）
- **写盘失败**：后端抛异常，前端 catch 显示错误，不乐观更新
- **A 股/港美股新增 price=0**：市值/盈亏显示 0，表格能看到行，下次刷新校准（可接受，符合"后续统一计算"）

## 验证步骤
1. 后端启动，前端构建
2. 添加场外基金：确认瞬时响应（<200ms），表格立即出现新行，totals 增量更新
3. 删除持仓：确认瞬时响应，表格立即移除，totals 减量更新
4. 手动刷新：确认 price/market_value/pnl 被真实行情校准
5. 同代码加仓：确认合并正确（加权平均成本）
