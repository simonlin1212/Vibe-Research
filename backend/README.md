# Vibe-Research Backend

A股数据层 + 可插拔 AI 层。

## 安装

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

> 行情 + 研报只需 `fastapi / uvicorn / requests`（秒装、必可用）。
> 一致预期 / 新闻 / 公告需 `akshare`，K线 / 财务需 `mootdx`；未装时对应端点返回 501 + 安装提示，不影响其余功能。

## 1. HTTP API（给网页前端 + 系统 AI）

```bash
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8900
```

| 端点 | 说明 | 依赖 |
|---|---|---|
| `GET /api/health` | 健康检查 | — |
| `GET /api/quote?codes=600519,000858` | **遗留**实时行情（与 `/market/quotes` 共用 5s 腾讯缓存；网页请走 quotes） | stdlib |
| `GET /api/valuation?code=600519` | 完整估值（前向PE/PEG/消化年数） | requests+akshare |
| `GET /api/valuation/percentile?code=600519` | 估值历史分位（近5年·百度股市通） | akshare |
| `GET /api/financials?code=600519` | 财务关键指标（同花顺摘要，最新报告期，前端个股页用） | akshare |
| `GET /api/reports?code=600519` | 个股研报列表（含 PDF 链接） | requests |
| `GET /api/announcements?code=600519` | 近期公告（东财） | requests |
| `GET /api/news?code=600519` | 个股新闻 | akshare |
| `GET /api/cls-telegraph` | 财联社电报（全市场快讯，零 key） | requests |
| **资金面·筹码·信号（v3.3）** | `/api/margin` · `/block-trade` · `/holders` · `/dividend` · `/fund-flow` · `/dragon-tiger` · `/dragon-tiger/daily`（全市场龙虎榜） · `/lockup` · `/blocks` · `/hot-concepts` · `/investor-qa` | requests |
| `GET /api/market/review-snapshot` | 每日复盘聚合（`scope=paint|top|full`）：先腾讯指数/总览，完成后再情绪+行业强弱，再龙虎 | 缓存命中秒回 |
| `POST /api/market/review-context` | 复盘上下文（问 AI / 与邮件同一套打包） | 复盘清单 + 缓存 |
| `GET /api/market/review-mail` · `PUT /api/market/review-mail` · `POST /api/market/review-mail/run` | 定时复盘邮件状态（不回 SMTP 密码 / API key）· 保存开关/时间/收件人 · 立刻试发 | SMTP + `VR_REVIEW_LLM_*` |
| `GET /api/market/hsgt` | 北向资金分钟流向 | requests |
| `GET /api/market/quotes` · `/boards` · `/board-stocks` · `/rank` · `/board-flow-intraday` · `/commodities` · `/commodity-minutes` | 批量报价(股票指数按代码 5s, 期货走 commodities 并行) / 板块热点 / 成分股(腾讯pt*) / 个股榜单(含成交额, 新浪) / 分钟板块资金 / 大宗商品 | 腾讯/新浪/东财(仅独有资金流) |
| `GET /api/market/spot-table` · `/chem-spot` · `/future-daily` · `/stock-boards` · `/stock-boards-batch` · `/stock-flows` · `/lives` · `/etf-shares` | 生意社现期/基差 · 化工现货 · 新浪期货日K · 个股行业/概念(单票/批量) · 自选主力净额/净占比(对齐参考看板 ulist) · 新浪7x24(华尔街见闻兜底) · 沪/深ETF日频份额+季报申购赎回 | requests |
| `GET /api/polymarket/board` · `/event` · `/search` · `/watch` | Polymarket 事件概率（Gamma，钥匙 `polymarket`；监控复用 `event::slug`） | requests |
| `GET /api/iwencai/status` · `/select` | 问财是否已配置 · 选股名单(产业链刷新) | IWENCAI_API_KEY |
| `GET /api/market/breadth` · `/ths-profile` · `/ths-rotation` | 全A涨跌分位+直方图(新浪hs_a分页/腾讯) · shy313同花顺归属 · 概念/行业当日均涨 | requests |
| `GET /api/fin/board` · `/forecast` · `/company` · `/suggest` | 财报窗口：盈利榜+日历 / 业绩预告 / F10+主营+现金流 / 代码联想。宏观包与 F10 并行拉东财 | 东财 datacenter |
| `GET /api/stock-basic?code=` | 个股基本资料（行业/地域/概念/股本/上市日） | requests |
| `POST /api/chat` | 系统 AI 对话（function calling，AI 自己调数据工具） | requests |
| `GET /api/portfolio/ctp/status` | CTP 配置/依赖/登录状态（不主动连前置） | — |
| `GET /api/portfolio/ctp/logs` | CTP 操作日志（`?since=` 增量轮询） | — |
| `POST /api/portfolio/ctp/login` | **点击登录**（连前置并保持会话，不下单） | openctp-ctp |
| `POST /api/portfolio/ctp/logout` | 退出并断开会话 | openctp-ctp |
| `GET /api/portfolio/ctp` | 查资金/持仓（需已登录，只读）；先返回客户权益，期权市值后台算 | openctp-ctp |
| `GET /api/portfolio/ctp/market-equity` | 轮询后台市值权益（`客户权益+多头期权市值-空头期权市值`，流控不阻塞主查询） | openctp-ctp |
| `GET /api/portfolio/ctp/settlement?day=` | 查单日结算单（本地 `~/.vibe-research/ctp_settlements.json` 有则复用） | openctp-ctp |
| `GET /api/portfolio/ctp/settlement/range?start=&end=` | 区间结算单 + 市值权益 / 净值 / 累计收益 / 盈亏日历 / 统计；缓存优先。日历：盈亏=`Δequity-出入金`，收益=`盈亏-手续费` | openctp-ctp |
| `GET /api/global/stock/fundamentals?symbol=` | 美/港估值+分析师+机构持仓（Yahoo quoteSummary；挂了就空） | requests |
| `GET /api/global/stock/statements?symbol=&statement=` | 三表关键科目（income/balance/cashflow，东财） | requests |
| `GET /api/global/stock/sec-filings?symbol=` | 个股 SEC 申报列表（需 `VR_SEC_CONTACT`） | requests |
| `GET /api/global/sec/daily` | 全市场 SEC 当日流 Form4/8-K/13F（需 `VR_SEC_CONTACT`） | requests |
| `GET /api/global/earnings-calendar` | Nasdaq 财报日历 | requests |
| `GET /api/global/us/kline?symbol=` | 美股日 K（新浪） | requests |
| `GET /api/research/sources` | 研究桌可选包是否已装 | — |
| `GET /api/research/kline?symbol=&source=` | Stooq / Baostock / pykrx | 可选包 |
| `GET /api/research/correlation?codes=` | 日收益 Pearson 矩阵, 最多 12 只 | 各市场 K 线 |
| `GET /api/research/etf-holdings?symbol=` | ETF 穿透（东财 / N-PORT） | requests；美股需 VR_SEC_CONTACT |
| `GET /api/research/13f?manager=` | 13F 持仓 + 两季环比；`ticker=` 列持有人 | VR_SEC_CONTACT |
| `GET /api/backtest/meta` | 回测策略 / 默认费用 / 免责声明 | — |
| `POST /api/backtest/run` | A 股日线账户回测（次日开盘、T+1、整手、印花税只卖；`top_k` 按目标权重加减仓；`exclude_st` / `min_list_days`） | 腾讯日 K |
| `POST /api/backtest/factor` | 因子 Rank IC / Pearson IC / 五档 / 多空（技术因子 + OHLCV 公式 + 3 条 WorldQuant，日 K 现场算；周/月=交易期末） | 本机库存 |
| `POST /api/backtest/factor/compare` | 同一面板对照最多 6 个因子 + IC 相关 | 本机库存 |
| `POST /api/backtest/model` | 模型研究：样本内训 LightGBM，分数进 Top-K；没装则提示 | 本机库存；可选 lightgbm |
| `GET /api/backtest/store` | 本机日历 / 日 K 覆盖 / 实验；`?codes=` 看这批是否齐 | — |
| `POST /api/backtest/store/sync` | 补齐标的池近 3 年已收盘日 K（已齐跳过） | 腾讯日 K |
| CLI `python fill_2y_bars.py` | 同上，前台跑；`--index sh000905` 或跟代码 | 腾讯日 K |
| `GET /api/backtest/store/{symbol}` | 读一只已落盘日 K 的尾部 | — |
| `GET /api/backtest/runs` | 实验列表（`runs/<id>/` 写完不改） | — |
| `GET /api/backtest/runs/{id}` | 读回一个实验 | — |
| `DELETE /api/backtest/runs/{id}` | 删掉整个实验目录 | — |
| `GET /api/global/edgar/screener` | SEC EDGAR frames 全市场 screener（S 级，需 VR_SEC_CONTACT） | requests |
| `GET /api/global/movers?board=` | 美/港涨跌与成交额榜（东财 market_stock_list，C 级） | requests |
| `GET /api/global/stock/news?symbol=` | 美/港个股新闻（Yahoo search，C 级） | requests |
| `GET /api/global/stock/options?symbol=` | CBOE 延时期权概览（0DTE/近月异动·P/C·IV；仅美股，合规 C 级个人研究） | requests |

> 上表为主要端点；完整路由清单见 `app.py`。要更全量的 A 股数据（打板 / ETF期权 / 全市场行业排名等），用根目录 [`a-stock-data/`](../a-stock-data/SKILL.md) 工具箱。

`/api/chat` 请求体：
```json
{
  "messages": [{"role": "user", "content": "茅台估值贵不贵？"}],
  "context": "本页上下文（可空）",
  "llm": {"baseURL": "https://api.deepseek.com", "apiKey": "sk-…", "model": "deepseek-chat"}
}
```
`llm` 由前端从本地配置随请求带上，后端不持久化 key。

## 2. MCP Server（给 Claude Code / 高手 agent）

零第三方依赖，复用同一套数据工具。挂进 Claude Code：

```bash
claude mcp add vibe-research -- \
  "$(pwd)/.venv/bin/python" "$(pwd)/mcp_server.py"
```

挂上后，你的 agent 直接拥有行情 / 估值 / 研报 / 新闻 / 资金 / 期权期货等 **49 个** 数据工具（与网页「问 AI」同一套 `tools.TOOLS`），
用你自己的订阅额度调数据、多步分析——无需 API key、不占本产品成本。

### 完整 A 股数据工具箱（随仓库自带）

MCP 暴露网页 AI 同一套工具（49 个）。若 agent 需要更全的 A 股数据（龙虎榜 / 融资融券 / 大宗交易 / 股东户数 / 分红 / 资金流 / 解禁 / 概念板块 / 打板情绪 / ETF 期权 / 互动易 / 全市场行业排名 …共 **47 个端点**），本仓库根目录**自带完整数据源** [`a-stock-data/`](../a-stock-data/SKILL.md)（a-stock-data v3.6.0）：

- 要调哪个接口，直接看 [`a-stock-data/SKILL.md`](../a-stock-data/SKILL.md)——每个端点都有 copy-paste 即用的代码（内嵌全部调用逻辑，零第三方数据封装依赖，东财接口已内置限流防封）。
- 运行依赖：`pip install mootdx requests pandas stockstats`（自包含，v3.0 起已移除 akshare）。
- 上游与更新：[github.com/simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（不更新也能一直用，自带的是固定可用快照）。
- 分工：**MCP 49 工具** = 网页 / 问 AI 常用；**自带数据源 40+ 端点** = agent 深度自助调研的全量工具箱。二者同源，按需取用。

## 合规

- 数据端点只返回客观行情/研报/财报/新闻，不含任何建议、排名、预测。
- `/api/chat` 的 system prompt 内置中立红线：不荐股、不预测涨跌、不给买卖时机、不构成投资建议。
- 分析结论一律由用户配置的模型 / agent 给出，本产品只提供数据与工具。
