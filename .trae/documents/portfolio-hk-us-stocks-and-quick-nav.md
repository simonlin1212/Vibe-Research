# 改造方案：持仓支持港美股 + 模糊搜索 + 持仓快捷跳转

## 概要

三件事一起做：
1. **持仓页支持港股/美股**：拆掉三层 6 位数字硬限制，复用已有 `gstock` 数据层，按市场分组汇总盈亏。
2. **模糊搜索**：输入框接受拼音首字母（如 `gzmt`）、中文名（如 `贵州茅台`）、美股代码（如 `AAPL`）、港股短代码（如 `700`），提交时后端解析成标准代码。无下拉联想。
3. **持仓明细增加快捷按钮**：每行 trash 图标旁加「个股数据」「多空辩论」两个按钮，点击跳转到对应页面并带入代码。个股数据页自动运行查询；辩论页仅填码不自动开始。

自选股页（Watchlist）做同样处理（支持港美股 + 模糊搜索）。

---

## 决策记录（已与用户确认）

| 决策点 | 选择 |
|--------|------|
| 代码存储与去重 | holding 加 `market` 字段（`"A"`/`"HK"`/`"US"`/`"KR"`），区分市场。去重仍按 `code` 字符串（A 股 6 位、港股 5 位、美股字母，实际不撞） |
| 币种汇总 | 按市场分组汇总，不折算汇率。不再有跨币种 grand total |
| 行情取数 | A 股走 `astock.tencent_quote`（批量）；港美股走 `gstock`（逐个） |
| 清仓名称回填 | 同上分流逻辑 |
| 辩论按钮范围 | 全部显示。港美股在辩论页点「开始」时报错「辩论暂仅支持 A 股代码」 |
| 跳转运行行为 | 个股数据页：带入代码 + 自动运行；辩论页：仅填码，不自动开始 |
| 搜索交互 | 联想下拉，点击选中。输入时实时调后端搜索（300ms 防抖），下拉显示候选（代码+名称+市场），点击选中后填入代码。保留直接输入代码回车提交作为 fallback |
| 自选股 | 同样支持港美股 + 模糊搜索。实时轮询交易时段保持 A 股口径（已知限制：港美股在 A 股非交易时段不自动轮询，但首次加载和手动刷新始终可用） |

---

## 现状分析（三层 6 位限制 + 已有能力）

### 限制点
1. **前端输入过滤**：[Portfolio.tsx#L146](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L146) `replace(/\D/g, "").slice(0, 6)` + [Portfolio.tsx#L51](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L51) `!/^\d{6}$/.test()`。清仓录入 [Portfolio.tsx#L70](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L70)、[Portfolio.tsx#L223](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L223) 同样。
2. **后端校验**：[app.py#L204-L205](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L204) `portfolio_add` + [app.py#L265-L266](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L265) `portfolio_close` 内联 6 位校验。辩论页 [Debate.tsx#L49](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Debate.tsx#L49) 也有。
3. **行情取数**：[portfolio.py#L132](file:///Users/tony/Workspace/Vibe-Research/backend/portfolio.py#L132) `astock.tencent_quote` + [astock.py#L26-L32](file:///Users/tony/Workspace/Vibe-Research/backend/astock.py#L26) `get_prefix` 只返回 sh/sz/bj。

### 已有能力（可直接复用）
- [gstock.py](file:///Users/tony/Workspace/Vibe-Research/backend/gstock.py) 完整支持美/港/韩股：`resolve_symbol`（代码/名称→解析）、`us_hk_stock`（行情+财务）、`_search`（东财搜索，精确代码优先）。
- [StockData.tsx#L114-L127](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/StockData.tsx#L114) 已实现「6 位→A 股，否则→港美股」分流。
- 后端已有 `/api/global/stock` [app.py#L354](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L354)。
- 东财搜索 API 原生支持拼音首字母（实测 `gzmt`→贵州茅台）、中文名、美股代码、港股短代码。

### 东财搜索 MktNum（实测）
| MktNum | 市场 | 示例 |
|--------|------|------|
| 0 | 深A | 000700 模塑科技 |
| 1 | 沪A | 600519 贵州茅台 |
| 105 | NASDAQ | AAPL 苹果 |
| 106 | NYSE | — |
| 116 | 港股 | 00700 腾讯控股 |
| 177 | 韩股 | — |

当前 `gstock._MKT` [gstock.py#L34](file:///Users/tony/Workspace/Vibe-Research/backend/gstock.py#L34) 只含 105/106/107/116/177，**缺 A 股的 0/1**，导致搜索会过滤掉 A 股结果。

---

## 改动清单

### 后端

#### 1. `backend/gstock.py` — 扩展搜索支持 A 股

**改 `_MKT`（[gstock.py#L34](file:///Users/tony/Workspace/Vibe-Research/backend/gstock.py#L34)）**：加入 A 股 MktNum。
```python
_MKT = {0: ("", "A"), 1: ("", "A"),            # 新增：深A / 沪A
        105: (".O", "US"), 106: (".N", "US"), 107: (".O", "US"),
        116: (".HK", "HK"), 177: (".KS", "KR")}
```
> 注意：A 股 secucode 无后缀（就是 6 位裸代码），suffix 留空。market 统一为 `"A"`（不分沪/深/北，因为行情分流只关心「是否 A 股」）。

**新增 `search_suggestions(query)` 函数**：返回候选列表（非单条），供前端下拉联想用。
```python
def search_suggestions(query: str) -> list[dict]:
    """东财搜索 → 候选列表 [{code, name, market}]，过滤到 A/HK/US/KR 市场。
    6位纯数字直通 A 股（省一次搜索请求）；其余走东财 searchapi。"""
    q = query.strip().upper()
    if not q:
        return []
    if q.isdigit() and len(q) == 6:
        return [{"code": q, "name": "", "market": "A"}]
    url = "https://searchapi.eastmoney.com/api/suggest/get"
    params = {"input": q, "type": 14,
              "token": "D43BF722C8E33BDC906FB84D85E326E8", "count": 10}
    try:
        r = astock.em_get(url, params=params, headers=_UA_H, timeout=10)
        rows = (r.json().get("QuotationCodeTable") or {}).get("Data") or []
    except Exception:
        return []
    out, seen = [], set()
    for s in rows:
        try:
            mkt = int(s.get("MktNum"))
        except (TypeError, ValueError):
            continue
        if mkt not in _MKT:
            continue
        code = s.get("Code", "")
        market = _MKT[mkt][1]
        key = (code, market)
        if key in seen:
            continue
        seen.add(key)
        out.append({"code": code, "name": s.get("Name", ""), "market": market})
    return out[:8]  # 最多 8 条，下拉够用
```

**保留 `resolve_for_portfolio(query)` 函数**：单条解析，供后端 add_holding/close_position 的 fallback（用户直接输入代码回车、未走下拉选中时）。
```python
def resolve_for_portfolio(query: str) -> dict | None:
    """输入 → {code, name, market}。6位纯数字直通A股；其余取搜索第一条。查不到返回 None。"""
    q = query.strip().upper()
    if not q:
        return None
    if q.isdigit() and len(q) == 6:
        return {"code": q, "name": "", "market": "A"}
    hit = resolve_symbol(q)   # 复用已有逻辑（含港股补零、精确匹配优先）
    if not hit:
        return None
    return {"code": hit["code"], "name": hit["name"], "market": hit["market"]}
```

#### 2. `backend/portfolio.py` — 持仓数据层改造

**holding 结构加 market 字段**：
```python
# 旧：{"code": "600519", "shares": 100, "cost": 12.5}
# 新：{"code": "600519", "market": "A", "shares": 100, "cost": 12.5}
```

**`_load()` 加迁移**（[portfolio.py#L53-L58](file:///Users/tony/Workspace/Vibe-Research/backend/portfolio.py#L53)）：旧 holding/closed 缺 `market` → 补 `"A"`。
```python
def _load() -> dict:
    try:
        with open(PF_FILE, encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"holdings": [], "last_refresh": None}
    for h in d.get("holdings", []):
        if "market" not in h:
            h["market"] = "A"   # 旧数据全是A股（6位限制）
    for c in d.get("closed", []):
        if "market" not in c:
            c["market"] = "A"
    return d
```

**`add_holding` 改签名**（[portfolio.py#L70-L84](file:///Users/tony/Workspace/Vibe-Research/backend/portfolio.py#L70)）：接受 `code`(query) + `market`，query 解析后存标准 code。
```python
def add_holding(code: str, market: str, shares: float, cost: float) -> dict:
    """加一笔持仓；同代码则按加权平均成本合并（加仓）。
    code 可以是6位代码/拼音/中文/港美股代码，由调用方解析后传入标准 code+market。"""
    with _LOCK:
        d = _load()
        for h in d["holdings"]:
            if h["code"] == code:
                total = h["shares"] + shares
                h["cost"] = round((h["shares"] * h["cost"] + shares * cost) / total, 4) if total else cost
                h["shares"] = total
                break
        else:
            d["holdings"].append({"code": code, "market": market, "shares": shares, "cost": cost})
        _save(d)
    return get_portfolio()
```

**`get_portfolio` 改行情取数 + 分组汇总**（[portfolio.py#L124-L162](file:///Users/tony/Workspace/Vibe-Research/backend/portfolio.py#L124)）：
- A 股 holding 批量走 `astock.tencent_quote`（保持高效）。
- 港美股 holding 逐个走 `gstock.us_hk_stock(code)`，取 `quote.price` 和 `quote.name`。
- `totals` 改为按市场分组的 dict：`{"A": {market_value, cost, pnl, pnl_pct}, "HK": {...}, ...}`。
- 不再有跨币种 grand total。
- 每行 holding 的 row 补 `market` 字段。

**`close_position` 改名称回填**（[portfolio.py#L95-L111](file:///Users/tony/Workspace/Vibe-Research/backend/portfolio.py#L95)）：
- 加 `market` 参数。
- 名称回填按 market 分流：A 股 → `astock.tencent_quote`；港美股 → `gstock.us_hk_stock`。
- closed 记录存 `market` 字段。

#### 3. `backend/app.py` — 接口校验放宽 + 搜索端点

**新增搜索端点**（供前端下拉联想）：
```python
@app.get("/api/search")
def search(q: str = Query(..., min_length=1, max_length=20)):
    """股票搜索：代码/拼音首字母/中文/港美股代码 → 候选列表。"""
    return {"data": gstock.search_suggestions(q)}
```

**`portfolio_add`（[app.py#L200-L209](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L200)）**：
- `HoldingIn` model 加可选 `market` 字段：前端下拉选中时传入已知 market；直接输入回车时 market 为空，后端 fallback 解析。
- 去掉 `if not code.isdigit() or len(code) != 6` 校验。
- 有 market → 直接用；无 market → 调 `gstock.resolve_for_portfolio(code)` 解析。解析失败 → 400。

```python
class HoldingIn(BaseModel):
    code: str          # 下拉选中=标准代码；直接输入=可能拼音/中文/代码
    shares: float
    cost: float
    market: str = ""   # 下拉选中时传入；空则后端解析

@app.post("/api/portfolio/holding")
def portfolio_add(h: HoldingIn):
    if h.market:
        code, market = h.code, h.market
    else:
        resolved = gstock.resolve_for_portfolio(h.code)
        if not resolved:
            raise HTTPException(400, f"未找到该股票：{h.code}")
        code, market = resolved["code"], resolved["market"]
    if h.shares <= 0:
        raise HTTPException(400, "数量必须大于 0")
    return {"data": pf.add_holding(code, market, h.shares, h.cost)}
```

**`portfolio_close`（[app.py#L261-L278](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L261)）**：
- 同样去掉 6 位校验，`CloseIn` 加可选 `market` 字段，无 market 时 fallback 解析。

> ⚠️ 不要修改 `_validate`（[app.py#L66-L70](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L66)）和 `_CODE_RE`——它们可能被其他端点（个股数据等）使用。只改 portfolio 相关端点的内联校验。

**`/api/quote` 端点（[app.py#L391-L398](file:///Users/tony/Workspace/Vibe-Research/backend/app.py#L391)）**：扩展支持港美股。
- 入参格式不变（逗号分隔字符串），但支持 `市场:代码` 前缀（如 `A:600519,HK:00700,US:AAPL`）。无前缀的 6 位数字默认 A 股（向后兼容）。
- A 股批量走 `tencent_quote`；港美股逐个走 `gstock.us_hk_stock`，结果归一化成 `Quote` 形状（缺字段填 `None`/`0`）。
- 返回 `Record[str, Quote]`，key 为裸代码（跨市场不撞）。

```python
def _normalize_global_to_quote(g: dict) -> dict:
    """gstock 返回的 GlobalQuote → 前端 Quote 形状（缺字段填 None/0）。"""
    q = g.get("quote") or {}
    return {
        "name": g.get("name") or q.get("name") or g.get("code"),
        "price": q.get("price") or 0.0,
        "last_close": q.get("prev_close") or 0.0,
        "change_pct": q.get("change_pct") or 0.0,
        "pe_ttm": None, "pb": None, "mcap_yi": None,
        "turnover_pct": None, "limit_up": None, "limit_down": None,
    }
```

#### 4. `backend/debate.py` — 无需改动

辩论后端保持仅 A 股。港美股在辩论页前端 `start()` 校验时报错。

---

### 前端

#### 5. `frontend/src/lib/api.ts` — 类型、接口调整

**`Holding` 加 market**（[api.ts#L178-L181](file:///Users/tony/Workspace/Vibe-Research/frontend/src/lib/api.ts#L178)）：
```typescript
export interface Holding {
  code: string; market: string; name: string; price: number;
  shares: number; cost: number; market_value: number; pnl: number; pnl_pct: number;
}
export interface ClosedPosition {
  code: string; market: string; name: string; date: string; price: number;
  shares: number; cost: number; pnl: number; pnl_pct: number;
}
```

**`PortfolioData.totals` 改为按市场分组**（[api.ts#L186-L192](file:///Users/tony/Workspace/Vibe-Research/frontend/src/lib/api.ts#L186)）：
```typescript
export interface MarketTotal {
  market: string; market_value: number; cost: number; pnl: number; pnl_pct: number;
}
export interface PortfolioData {
  holdings: Holding[];
  totals: MarketTotal[];   // 按市场分组，每组一条
  closed: ClosedPosition[];
  realized_pnl: number;    // 仍为单一值（已清仓记录大概率全A，暂不分组）
  updated: string; last_refresh: string | null;
}
```

**新增搜索结果类型 + search 方法**：
```typescript
export interface SearchSuggestion {
  code: string; name: string; market: string;
}
// api 对象内：
search: (q: string) => get<SearchSuggestion[]>(`/search?q=${encodeURIComponent(q)}`),
```

**`addHolding` 加可选 market 参数**：
```typescript
addHolding: (code: string, shares: number, cost: number, market?: string) =>
  request<PortfolioData>("/portfolio/holding", "POST", { code, shares, cost, market: market || "" }),
```

#### 5b. `frontend/src/components/ui/StockSearchInput.tsx` — 新增搜索下拉组件

可复用的股票搜索输入框，持仓页和自选股页共用。核心行为：
- 用户输入 → 300ms 防抖 → 调 `GET /api/search?q=xxx` → 下拉显示候选
- 候选项格式：`代码 · 名称 · 市场标签`（如 `600519 · 贵州茅台 · A股`、`AAPL · 苹果 · 美股`）
- 鼠标点击 / 回车选中 → 调 `onSelect({code, name, market})`，输入框填入 code
- 选中后下拉关闭；用户继续编辑会重新触发搜索
- 点击组件外部关闭下拉
- 市场标签映射：A→「A股」、HK→「港股」、US→「美股」、KR→「韩股」

```tsx
interface StockSearchInputProps {
  value: string;
  onChange: (v: string) => void;
  onSelect: (item: SearchSuggestion) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function StockSearchInput({ value, onChange, onSelect, ...props }: StockSearchInputProps) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number>();
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖搜索
  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const q = value.trim();
    if (!q) { setSuggestions([]); setOpen(false); return; }
    timerRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.search(q);
        setSuggestions(data);
        setOpen(data.length > 0);
      } catch { setSuggestions([]); }
      finally { setLoading(false); }
    }, 300);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [value]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input value={value} onChange={(e) => onChange(e.target.value.slice(0, 20))}
        onFocus={() => suggestions.length && setOpen(true)} {...props} />
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-popover shadow-lg">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">搜索中…</div>}
          {!loading && suggestions.map((s) => (
            <button key={`${s.market}:${s.code}`} type="button"
              onClick={() => { onSelect(s); onChange(s.code); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
              <span className="font-mono">{s.code}</span>
              <span className="flex-1 truncate">{s.name}</span>
              <span className="text-xs text-muted-foreground">{mktLabel(s.market)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

#### 6. `frontend/src/pages/Portfolio.tsx` — 持仓页改造

**代码输入框替换为 StockSearchInput**（[Portfolio.tsx#L144-L148](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L144)）：
- 引入 `StockSearchInput`，替换原生 `<input>`。
- 新增 state 存选中的 market：`const [selMarket, setSelMarket] = useState("")`。
- `onSelect` 回调：`setSelMarket(s.market)`。
- placeholder 改为 `"代码 / 拼音 / 中文"`。

```tsx
<StockSearchInput
  value={code}
  onChange={setCode}
  onSelect={(s) => setSelMarket(s.market)}
  placeholder="代码 / 拼音 / 中文"
  className="w-40 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
/>
```

**`add()` 传入 market**（[Portfolio.tsx#L50-L63](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L50)）：
- 去掉 `!/^\d{6}$/.test()` 校验，改为非空检查。
- 调 `api.addHolding(code, s, c, selMarket)`——下拉选中时 selMarket 有值；直接回车时为空，后端 fallback 解析。
- 添加成功后清空 code + selMarket。

**清仓录入同样替换为 StockSearchInput**（[Portfolio.tsx#L221-L225](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L221)）+ 加 `cSelMarket` state。

**汇总卡改为按市场分组**（[Portfolio.tsx#L124-L138](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L124)）：
- 遍历 `totals` 数组，每组一个汇总行（标注市场名 + 币种）。
- 币种标注：A→人民币、HK→港元、US→美元、KR→韩元。

**持仓明细表加两个按钮**（[Portfolio.tsx#L204-L208](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Portfolio.tsx#L204)）：
- trash 图标旁加：个股数据图标（如 `LineChart`）、多空辩论图标（如 `Swords`）。
- 点击跳转：`navigate(\`/stock-data?code=${h.code}\`)` 和 `navigate(\`/debate?code=${h.code}\`)`。
- 需引入 `useNavigate`。

```tsx
<td className="px-2 py-2.5">
  <div className="flex items-center gap-1.5">
    <button onClick={() => navigate(`/stock-data?code=${h.code}`)}
      className="text-muted-foreground/50 hover:text-primary" title="个股数据">
      <LineChart className="h-3.5 w-3.5" />
    </button>
    <button onClick={() => navigate(`/debate?code=${h.code}`)}
      className="text-muted-foreground/50 hover:text-primary" title="多空辩论">
      <Swords className="h-3.5 w-3.5" />
    </button>
    <button onClick={() => remove(h.code)} className="text-muted-foreground/50 hover:text-destructive" title="删除">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  </div>
</td>
```

> 注意：表头列数不变（最后一列仍为空标题），只是列内按钮增多。

#### 7. `frontend/src/pages/StockData.tsx` — 支持 URL 参数自动运行

**读取 URL `?code=` 并自动触发**（[StockData.tsx#L80-L106](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/StockData.tsx#L80)）：
```typescript
import { useSearchParams } from "react-router-dom";

export function StockData() {
  const [searchParams] = useSearchParams();
  // ...现有 state...
  const autoRanRef = useRef(false);  // 防止 StrictMode 双触发

  useEffect(() => {
    if (autoRanRef.current) return;
    const c = searchParams.get("code");
    if (c) {
      setCode(c);
      autoRanRef.current = true;
      // 自动运行（需把 run() 逻辑提取或直接调）
      // 由于 run() 读的是 state code，这里要直接用 c 触发，不等 setCode 异步生效
      void runWith(c);
    }
  }, [searchParams]);
  // ...
}
```
> 实现细节：`run()` 当前读 `code` state。URL 带参时需直接用参数值触发，不等 `setCode` 异步生效。可提取一个 `runWith(code: string)` 内部函数，`run()` 调 `runWith(code.trim().toUpperCase())`。

#### 8. `frontend/src/pages/Debate.tsx` — 支持 URL 参数填码

**读取 URL `?code=` 填入输入框，不自动开始**（[Debate.tsx#L31-L49](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Debate.tsx#L31)）：
```typescript
import { useSearchParams } from "react-router-dom";

export function Debate() {
  const [searchParams] = useSearchParams();
  // ...现有 state...
  useEffect(() => {
    const c = searchParams.get("code");
    if (c) setCode(c);
  }, [searchParams]);
  // ...
}
```

**`start()` 校验保持 6 位 A 股**（[Debate.tsx#L49](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Debate.tsx#L49)）：
- 港美股代码（非 6 位数字）点「开始辩论」时报错：`"多空辩论暂仅支持 6 位 A 股代码"`。
- 这就是用户选择的「港美股点击报错」——在辩论页点开始时报错，不是在持仓页点按钮时报错。

#### 9. `frontend/src/lib/watchlist.ts` — 自选股存储改造

**存储改为 `{code, market}[]`**，旧 `string[]` 迁移：
```typescript
export interface WatchItem { code: string; market: string }

export function loadWatch(): WatchItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(v)) return [];
    // 兼容旧格式 string[]：纯字符串 → {code, market:"A"}
    return v.map((x) => typeof x === "string" ? { code: x, market: "A" } : x)
            .filter((x) => x.code);
  } catch { return []; }
}

export function saveWatch(items: WatchItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
}
```

**删除 `parseCodes` / `addCodes`**：不再需要本地正则提取代码——搜索联想由 `StockSearchInput` 组件处理，选中即得到标准 `{code, market}`。

#### 10. `frontend/src/pages/Watchlist.tsx` — 自选股页改造

**输入框替换为 StockSearchInput**（[Watchlist.tsx#L37](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Watchlist.tsx#L37)、[Watchlist.tsx#L52-L59](file:///Users/tony/Workspace/Vibe-Research/frontend/src/pages/Watchlist.tsx#L52)）：
- `codes` state 改为 `items: WatchItem[]`。
- `input` state 保留，但输入框换成 `StockSearchInput`。
- `onSelect` 回调：直接把选中的 `{code, market}` 加入 items 列表（自选股无需填数量/成本，选中即加入）。
- 保留手动「添加」按钮作为 fallback：点击时调后端 resolve 解析 input 文本。

```tsx
const [items, setItems] = useState<WatchItem[]>(loadWatch);
const [input, setInput] = useState("");

// 下拉选中 → 直接加入
const onSelect = (s: SearchSuggestion) => {
  if (items.some((x) => x.code === s.code && x.market === s.market)) return;
  const next = [...items, { code: s.code, market: s.market }];
  setItems(next); saveWatch(next); setInput(""); setHint(`已添加 ${s.name}`);
};

// 手动添加（fallback：直接输入代码回车）
const add = async () => {
  if (!input.trim()) return;
  try {
    const resolved = await api.search(input.trim());  // 借用搜索取第一条
    if (resolved.length === 0) { setHint("未找到该股票"); return; }
    onSelect(resolved[0]);
  } catch { setHint("搜索失败"); }
};
```

**行情展示**：调用 `/api/quote` 时格式化为 `市场:代码`：
```typescript
const codeStr = items.map((x) => `${x.market}:${x.code}`).join(",");
const data = await api.quote(codeStr);
```

**名称展示**：港美股在 Quote 中 `name` 可能有值（gstock 返回），A 股也有。统一用 `quotes[code]?.name || code`。

#### 11. `frontend/src/hooks/useLiveQuotes.ts` — 适配多市场

**入参从 `codes: string[]` 改为 `items: WatchItem[]`**：
- `codesRef.current = items.map(x => \`${x.market}:${x.code}\`)` 传给 `/api/quote`。
- 返回的 `quotes` key 仍为裸代码（后端归一化后按裸代码 key）。

**交易时段保持 A 股口径**（[useLiveQuotes.ts#L35-L41](file:///Users/tony/Workspace/Vibe-Research/frontend/src/hooks/useLiveQuotes.ts#L35)）：
- `isTradingHours()` 不改（A 股时段）。
- 已知限制：港美股在 A 股非交易时段不自动轮询。首次加载（[useLiveQuotes.ts#L118-L120](file:///Users/tony/Workspace/Vibe-Research/frontend/src/hooks/useLiveQuotes.ts#L118)）和手动刷新（`refresh`）始终可用，不受交易时段限制。

#### 12. `frontend/src/lib/api.ts` — quote 方法

**`quote` 方法不变签名**，仍接受逗号分隔字符串（[api.ts#L268](file:///Users/tony/Workspace/Vibe-Research/frontend/src/lib/api.ts#L268)）：
```typescript
quote: (codes: string) => get<Record<string, Quote>>(`/quote?codes=${encodeURIComponent(codes)}`),
```
> 注意加 `encodeURIComponent`——现在 codes 可能含 `:` 和字母，需要编码。

---

## 数据流

### 添加持仓（下拉选中港美股）
```
用户在 StockSearchInput 输入 "AAPL"
→ 300ms 防抖后 GET /api/search?q=AAPL
→ 返回 [{code:"AAPL", name:"苹果", market:"US"}, {code:"AAPL22", ...}, ...]
→ 下拉显示候选，用户点击「AAPL · 苹果 · 美股」
→ onSelect({code:"AAPL", name:"苹果", market:"US"}) → setSelMarket("US")，输入框填 "AAPL"
→ 用户填数量/成本，点添加
→ POST /api/portfolio/holding {code:"AAPL", shares, cost, market:"US"}
→ 后端有 market → 直接用，pf.add_holding("AAPL", "US", shares, cost)
→ 存储 {"code":"AAPL", "market":"US", ...}
→ 返回 get_portfolio()：US holding 逐个走 gstock.us_hk_stock("AAPL") 取行情
→ 前端渲染，汇总卡显示 "美股 · 美元" 分组
```

### 添加持仓（直接输入代码回车，fallback）
```
用户直接输入 "600519" 回车（未走下拉）
→ POST /api/portfolio/holding {code:"600519", shares, cost, market:""}
→ 后端 market 为空 → gstock.resolve_for_portfolio("600519") → {code:"600519", market:"A"}
→ pf.add_holding("600519", "A", shares, cost)
```

### 持仓跳转个股数据
```
持仓表点击 LineChart 图标（code=00700, market=HK）
→ navigate("/stock-data?code=00700")
→ StockData 读 ?code=00700 → setCode("00700") + 自动 runWith("00700")
→ 00700 非6位数字 → 走 api.globalStock("00700") → 渲染港股价
```

### 持仓跳转辩论（港美股报错）
```
持仓表点击 Swords 图标（code=AAPL, market=US）
→ navigate("/debate?code=AAPL")
→ Debate 读 ?code=AAPL → setCode("AAPL")，不自动开始
→ 用户点"开始辩论" → start() 校验 !/^\d{6}$/.test("AAPL")
→ setError("多空辩论暂仅支持 6 位 A 股代码")
```

---

## 验证步骤

### 后端验证
1. **搜索**：`GET /api/search?q=gzmt` → 含 `{code:"600519", name:"贵州茅台", market:"A"}`；`?q=AAPL` → 含 `{code:"AAPL", name:"苹果", market:"US"}`；`?q=txkg` → 含 `{code:"00700", name:"腾讯控股", market:"HK"}`。
2. **解析 fallback**：`gstock.resolve_for_portfolio("gzmt")` → `{code:"600519", market:"A"}`；`resolve_for_portfolio("不存在的")` → `None`。
3. **添加港美股持仓（带market）**：`POST /api/portfolio/holding {code:"AAPL", shares:10, cost:150, market:"US"}` → 200，holdings 含 `market:"US"`。
4. **添加持仓（fallback无market）**：`POST /api/portfolio/holding {code:"600519", shares:100, cost:12, market:""}` → 200，后端解析为 A 股。
5. **分组汇总**：同时持有 A 股 + 港股 → `totals` 有两组，各自币种独立。
6. **旧数据迁移**：留旧 `portfolio.json`（无 market 字段）→ 加载后 holding 自动补 `market:"A"`。
7. **清仓名称回填**：清仓港美股 → closed 记录有 name（来自 gstock）。
8. **`/api/quote` 多市场**：`GET /api/quote?codes=A:600519,HK:00700,US:AAPL` → 返回三只行情，key 为裸代码。

### 前端验证
1. **持仓下拉搜索**：输入 `gzmt` → 下拉出现贵州茅台 → 点击选中 → 填数量成本 → 添加成功。
2. **持仓下拉选美股**：输入 `AAPL` → 下拉出现苹果 → 选中添加 → 汇总卡出现"美股 · 美元"分组。
3. **持仓直接输入回车**：输入 `600519` 不点下拉 → 直接填数量成本添加 → 后端 fallback 解析成功。
4. **持仓明细跳转个股数据**：点击 LineChart → 跳到个股数据页，代码已填，自动查询出结果。
5. **持仓明细跳转辩论（A股）**：点击 Swords → 跳到辩论页，代码已填，用户点开始能正常辩论。
6. **持仓明细跳转辩论（港美股）**：点击 Swords → 跳到辩论页，代码已填，点开始报错"多空辩论暂仅支持 6 位 A 股代码"。
7. **自选股下拉搜索**：输入 `txkg` → 下拉出现腾讯控股 → 点击直接加入自选列表。
8. **自选股多市场行情**：同时有 A 股 + 港美股自选 → 行情都能显示。
9. **自选股旧数据迁移**：localStorage 旧格式 `["600519"]` → 加载后变成 `[{code:"600519", market:"A"}]`。

---

## 不做的事（明确排除）

- 不扩展辩论后端支持港美股（用户选择"港美股点击报错"，后续可单独扩展）。
- 不做实时汇率折算（用户选择按市场分组）。
- 不改 `_validate` / `_CODE_RE`（可能被其他端点使用）。
- 不扩展 `isTradingHours` 支持港美股交易时段（已知限制，手动刷新始终可用）。
- 不改自选股 `useLiveQuotes` 的轮询频率（A 股 3 秒，港美股跟随同一节拍）。
- 不新增批量解析端点（自选股下拉选中即加入，无需批量；fallback 走单个 search 取第一条）。
- 不做下拉的键盘导航（上下键/回车选中）——首版只做鼠标点击，够用且简单。后续可加。
