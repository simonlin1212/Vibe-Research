<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>

<h1 align="center">Vibe-Research · 个人 AI 投研系统（A股/美股/港股）</h1>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![GitHub stars](https://img.shields.io/github/stars/simonlin1212/Vibe-Research?style=social)](https://github.com/simonlin1212/Vibe-Research/stargazers)
[![官网 viberesearch.wiki](https://img.shields.io/badge/🌐_官网-viberesearch.wiki-F35D2B?style=flat)](https://viberesearch.wiki)
[![English README](https://img.shields.io/badge/📖_English-README-1F6FEB?style=flat)](README_en.md)

<p align="center">
  <a href="https://viberesearch.wiki">官网</a> ·
  <a href="#功能">功能</a> ·
  <a href="#数据源data-sources">数据源</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#接入-ai">接入 AI</a> ·
  <a href="#合规">合规</a> ·
  <a href="#相关生态">相关生态</a>
</p>

> **Vibe-Research: Your Personal Trading Research Agent** · A股 / 美股 / 港股 的个人投研 Agent。
>
> A股 / 美股 / 期权期货、资讯雷达、我的持仓。把数据和功能配齐，由**你自己的 AI** 驱动投资研究。

Vibe-Research 是一个开源的「个人 AI 投研看板」，**主推 A 股、兼看美股 / 港股**（A 股常要看隔夜外围脸色，数据配上更全）。它不替你做决定——把行情、研报、估值、财务、公告、资金面、资讯都配齐，放进一个干净的看板，再留一个能接入**你自己的 AI** 的接口。方向和结论，交给你自己配置的模型 / agent。

**看板读法**：复盘页是一屏驾驶舱（桌面无需滚动，点面板放大；自选格带分时/日K）；手机底栏切主页面，浏览器可「添加到主屏幕」。美股 / 期权 / 套利 / 事件 / 持仓走同一套黑底看盘台（红涨绿跌、黄字高亮、格子拼贴），不再切主题。

> *Vibe-Research: Your Personal Trading Research Agent. An open dashboard for China A-share (plus US / HK): it wires up all the data and plugs into **your own AI / agent** — it never recommends a stock. You bring the model, it brings the data.*

## 功能

每个页面的具体模块：

| 页面 | 包含的模块 / 能力 |
|---|---|
| 🇨🇳&nbsp;**A&#8288;股** | 顶栏：**复盘** / **K线**。K 线页左自选表（价量涨跌/买卖/换手量比振幅/开高低/涨跌停/市值估值）右上分时（可切一日/两日，右上角进详情/公告）右下日K。整站顶栏下方横向滚动行情条（全球指数 + 黄金/原油/BTC 等商品，与驾驶舱共用 5 秒报价中心）。复盘是一屏驾驶舱（可放大面板）：**全球关键指数** / **涨跌分布 / 广度** / **自选**（首行右上）/ **市场板块实时热点**（行业/概念，左领涨/右领跌，点板块在另半边看成分股）/ **板块资金流向**（分钟累计蝴蝶图，点击筛主力净流入）/ **主力净流入排行** / **个股榜单** / **宏观观察**（标的：商品/NQ + 恒生/恒科/日韩 + 日K）/ 涨跌停格 / 龙虎·资金·8 条产业链。7×24 快讯不占复盘格，新条仍全站右上角弹 3 分钟，事件页可看全文。 |
| 🪟&nbsp;**财&#8288;报&#8288;窗&#8288;口** | 顶栏进入 `/fin`：对齐参考看板两行七格。披露日历（21 天可点柱带）/ 业绩预告 / 行业树状·条形榜 / 个股盈利榜 / 公司 3×3 指标+主营 / 近 12 期趋势 / 同业对比。默认贵州茅台；宏观包与 F10 **并行拉东财**，不再串行估值/公告/研报 |
| 📡&nbsp;**资&#8288;讯&#8288;雷&#8288;达** | 复盘第一行右侧**快讯格**（财联社 / 新浪/见闻 / 金十，打标 + NEW，默认自动滚到顶）。新条全站右上角弹窗停留 3 分钟（最多 4 条，点标题回复盘） |
| ⭐&nbsp;**自&#8288;选&#8288;股** | **批量粘贴一串代码即加**（逗号 / 空格 / 换行都行）· 一屏表格总览（现价 / 涨跌 / PE / PB / 换手）· **实时行情开关**（右上角，默认关；开了在交易时段每 3 秒自动刷新，非交易时段与页面切走时自动暂停）· 一键交给 AI 读。只存本地 |
| 💼&nbsp;**我&#8288;的&#8288;持&#8288;仓** | **A股**：录入即实时盈亏 · 已清仓记录（只存本地）。**期货账户**：CTP 只读 · 区间结算单本地缓存 · 净值/累计收益/盈亏日历/统计（能按今日实时预估的都按预估；年化按自然日 365；账号在本机 `~/.vibe-research/ctp.json`）|
| 🌊&nbsp;**期&#8288;权&#8288;/&#8288;期&#8288;货** | 顶栏 `/derivatives`（紧挨 A 股，旧 `/ovlab` 书签自动跳转）：**驾驶舱一屏** = 行情观察（一张竖表：价/涨跌/隐波/IV分位色带/溢价/分时；卡内 tab 切自选 `deriv.watch` / 指数（同花顺商品指数分时））· 临期期权日历（当月未过期月历，切月看远月，格子标交易所，点/悬停看标的）· 期限结构（品种可搜；选中品种：远期曲线点上标现值/涨幅 · 今实线/昨虚线 + 同月持仓量柱 + 仓单最新/日变/近90日，在异动左侧）· 异动（成交/走势/连续可关 · 剩余天数 · 区间涨幅 · 区间成交量 · 本机阈值）· **T 型报价联动区**（品种可搜；品种旁大号当月期货最新/涨跌；左侧上下叠 IV 微笑（LC：原始 theovol、今紫昨灰、合成标的现价竖线）与 ATM 隐波期限（LC 复刻 vol-ts 浮窗），同 tquote，点期限月切表；全部行权价链：理论价=Black-76/IV 买卖/Delta/持仓，价旁标涨幅，标的现价蓝线卡在两档之间，默认隐藏实值可关，按到期月切换；默认 ATM 购出图；点行情观察标的出标的日K/分时，点 T 表合约出期权图；日K/分时同一张卡上下叠在右侧一小条，主看 T 表；日K=分钟聚合+标的隐波日线+下方量窗，分时=昨结零轴+合约隐波+下方量窗叠持仓线，可切一日/两日，X 轴按交易时段铺满不拉满）。数据全部走 **OpenVlab** 公开缓存（市场概览 / flow-alert / price-volatility-series），60s 轮询同一把钥匙，盘中按 TTL 刷新、**休市（盘后/午休/周末）冻结只读上一笔**，后端启动时补一次首屏；CTP 账户只留在「我的持仓」 |
| ⚖️&nbsp;**套&#8288;利** | 顶栏 `/arb`（紧挨期权期货）：**驾驶舱一屏** = 跨期价差（近月−次月）· 跨品种价差（近月对近月）· 期现（股指 IF/IH/IM vs 沪深300/上证50/中证1000 及对应 ETF；**现期** tab：生意社现期表 + 化工现货）· 点一对出图（股指默认**日度升贴水**；跨品种默认**日K**；跨期默认分时；均可切换）+ 两腿仓单。期货腿走 OpenVlab `future-ts` 瘦身看板，现货腿走报价中心，不另开 market 轮询。只呈现价差，不评分、不标可做。 |
| 🗞️&nbsp;**事&#8288;件** | 顶栏 `/event`（紧挨套利）：**实时新闻**（财联社 / 新浪见闻 / 金十，与复盘快讯同一口）· **财经日历**（短线侠日程，与 [九言日历](https://jiuyan.033533.online/) 同一口）· **Polymarket 监控**（本机名单，粘贴事件链接加入，展开各档概率；热门榜可点 + 加入）。只呈现概率，不评分。 |
| 🇺🇸&nbsp;**美&#8288;股** | 顶上一行**全球情绪**（加密 Alternative.me / 美股 CNN / 日港金油波动率）· 本地观察列表（ticker）· 东财快照行情 · **日 K + 成交量**（新浪）· **财报日历** · **SEC 当日申报流**（需 `VR_SEC_CONTACT`）。点列表即切图 |
| 🔬&nbsp;**研&#8288;究&#8288;桌** | 顶栏 `/research`：多标的 **相关性热力图** · **ETF 穿透**（A 股东财中报/年报全持仓，美股 N-PORT）· **13F 环比** · Stooq/Baostock/pykrx K 线。只呈现公开披露，持仓天生滞后 |
| 🧪&nbsp;**回&#8288;测** | 顶栏 `/backtest`：账户 + **因子** + **模型**。因子多超额动量 / 动量加速 / 量变等公式，Rank IC / Pearson IC / 五档 / 多空；周/月调仓用交易期末。默认剔 ST / 次新。账户有 `top_k` 目标权重、个股上限、行业中性、Sortino。模型页同一日 K 训 LightGBM（可选），分数进 Top-K。网格只在样本内选参 |
| 🗄️&nbsp;**数&#8288;据** | 顶栏更多 `/data`：看本机日历、日 K 覆盖、实验。可补齐标的池近 3 年已收盘日 K。命令行: `python backend/fill_2y_bars.py` |
| 🤖&nbsp;**AI&#8288;观&#8288;察** | 顶栏进入：公有云 Token 消耗（OpenRouter 日榜）· LLM 价格趋势 / 降价事件（TrakToken TTSI）· 大模型价格表与智能×成本散点（Artificial Analysis，可选 key）· AI 基建 CapEx/ROI（SEC + 模型外推）。只客观呈现，预测段标「模型假设」 |
| 🔌&nbsp;**接&#8288;入&nbsp;AI** | 订阅接入（本机 CLI，免 key）· API 多模型（自动填 baseURL）· MCP（挂进 Claude Code 等 agent）|

> **投研分析框架**：让 AI 分析个股时，按 估值 / 资金面 / 财报质量 / 行业景气 / 事件催化与风险 五维组织结论。

## 数据源（Data Sources）

Vibe-Research 把三套公开数据源**直接集成进仓库**——`git clone` 下来**开箱即用，无需另外下载、接线**。

### A 股全栈数据 · AStockData

- **就在本仓库的 [`a-stock-data/`](a-stock-data/) 文件夹里**（v3.6.0，给 agent 的参考快照）。十层数据架构、47 个端点（44 主 + 3 官方备胎）、15 个数据源，`a-stock-data/SKILL.md` **内嵌全部调用代码**。 **真正跑服务的是 `backend/astock.py`**（从这份工具箱移植；`norm_ticker` / 僵尸报价 `is_stale` / 北交所老号段已进运行时）。东财接口已内置限流防封，主源被封还能降级到备用源。
- **覆盖**：行情 / K线 / 研报 / 一致预期 / 估值 / 历史分位 / 财务三表 / 公告 / 龙虎榜 / 融资融券 / 大宗交易 / 股东户数 / 分红 / 资金流 / 解禁 / 概念板块 / 打板情绪 / ETF 期权 / 互动易 / 全市场行业排名 …
- **轻量图表 API**：`GET /api/astock/light-kline?code=600519&resolution=1D`（`1` 分时 / `5` 五日 / `1D` 日K前复权，腾讯 ifzq，标准库即可，缓存 60 秒；美股指数如 `usIXIC` 走 `usMinute`；`whUSDCNY` 走东财离岸 `USDCNH` 1 分钟 K）· `GET /api/astock/light-kline-batch?codes=sh000001,usIXIC,whUSDCNY` 一次拉多只（驾驶舱指数/板块成分股/个股榜用）
- **统一报价中心**：网页走 `GET /api/market/quotes?codes=`（开市 5 秒新鲜、过期先给上一笔再补；多页共用，不各打一遍腾讯）。`GET /api/quote` 是遗留 HTTP 适配，与 quotes 共用同一把腾讯缓存，新页面不要再调。指数不写成裸 6 位，避免 `sh000001` 撞 `000001`。网页报价中心把上一帧价格/涨跌幅留在 localStorage（关 tab 再开也在），先画再补。VIX 空了走新浪。期货走 `/commodities`，和指数并行，互不拖死。驾驶舱指数/商品/榜单/自选/产业链/顶栏跑马灯共用同一快照；后端慢或挂了时浏览器直连 `qt.gtimg.cn` / `ifzq` 兜底。板块热点默认左领涨/右领跌，点板块后成分股出在另一半。
- **分时中心**：全球指数分时自己立刻打 17 码 `light-kline-batch`（不进 minuteHub，行先画再补线）。个股迷你图仍合并成 20 秒一批。商品分钟后端并行拉新浪。K 线页分时走同一 `loadLightKline` 缓存（240 根）；两日走腾讯 5 日分时取最近两交易日；五日/日 K 仍独立。K 线页分时轴铺满 09:30-15:00（午休空着），可切一日/两日，下窗柱是成交额（标「成交额」），按当根相对上一分钟红绿。期权分时同样拆量窗，黄线叠持仓量（独立轴）。分时由预热强制重写同一把钥匙（开市 20 秒、休市 60 秒），TTL 长过这个间隔，刷新网页读缓存。轮询换榜时保留上一帧，不先清空。
- **自选 / 个股行 / 分时轴**：驾驶舱自选格与 K 线页加自选同一套搜名称/代码/拼音（`GET /api/fin/suggest`）当场加减，下拉可用上下键高亮、回车加入；财报窗搜公司同一套键盘。榜单/成分/产业链点星加入自选。可见行批量补行业/概念（`GET /api/market/stock-boards-batch`，前端 5 分钟缓存）。分时迷你图按交易时段画 X 轴（A 股午休压缩，港股 09:30-16:00 午休压缩，日经/KOSPI 按东财北京时 08:00 起轴，商品/美股/汇率 24h）。
- **产业链**：上/中/下游行复用驾驶舱 `QuoteStockRow`（分时 / 额 / 主力净 / 板块）。切到该页签时从涨跌停借横向空间（约 58%）；够宽则三列 + 右侧关键技术/按链快讯，窄则单列并把技术点摊在顶上。按关键词匹配相关板块涨跌。「+添加 / 更新」粘贴问财文本在前端按上中下游解析（6 位 A 股代码），自定义链只存本机；「从问财获取 / 问财刷新」走 `GET /api/iwencai/select`（需 `IWENCAI_API_KEY`）。客观呈现不附推荐。
- **复盘预热**：后端启动后后台定时预拉复盘清单上的接口 + **指数分时**（指数目录 17 码，美股走腾讯 `usMinute`，日经/KOSPI 走东财，开市约 20 秒强制重写，休市 60 秒）+ **驾驶舱热路径**（全球指数 / 板块热点 / 个股榜 / 主力净流入 / 分钟资金流 / 商品报价与分钟 / 资金页增减持·国债·LPR·ETF 资金流·ETF 份额 / 快讯 40 条），整页预热交易时段约 90 秒一次。钟养过的固定键，网页再问只读上一笔，过期不再出网；板块新鲜度跟整页钟（约 90 秒），不是 10 秒再打腾讯。商品报价与分时一样强制重写同一把钥匙，TTL 长过预热间隔。用户正在拉 snapshot 时预热仍补腾讯/新浪分时键，只让开东财步骤。分钟资金流流入/流出榜并行；蝴蝶图不绑情绪完成，`curves=1` 与榜同时发。按板块分键缓存，二次访问不再串行 20 次东财 kline。首屏走 `GET /api/market/review-snapshot`（`scope=paint|top|full`：先腾讯指数/总览，完成后再情绪+行业强弱，再龙虎）；东财 `em_get` 与参考看板一样不卡发起间隔，HTTP 并行。顶栏行情条与全球指数格共用 5 秒报价中心。全 A 分位走独立 `/market/breadth`，不挡情绪格。`GET /api/market/review-warmup` 看预热状态；`VR_REVIEW_WARMUP=0` 可关
- **复盘上下文**：`POST /api/market/review-context` 把当前复盘打成给模型看的文本（与邮件同一套）。网页「AI 复盘 / 问 AI」只调这一处，不再在浏览器里拼快照。
- **定时复盘邮件**（默认关）：接入 AI 页可开关、改时间、改收件人（立刻生效）。A 股交易日到点按同一份复盘清单收集 → 同一套复盘上下文 → SMTP 发出（法定节假日不发；日历取不到时只跳过周末）。`GET/PUT /api/market/review-mail` · `POST /api/market/review-mail/run`。SMTP 与模型 key 仍在 `.env`
- **全球情绪**：`GET /api/market/fear-greed`（钥匙 `fear_greed`，5 分钟）。加密 Alternative.me、美股 CNN Fear & Greed、日/港/金/油波动率反转分。复盘「涨跌分布 / 广度」下部与美股页同一口，不进报价中心。
- **事件 / Polymarket**：`GET /api/polymarket/board` · `/event?slug=` · `/search?q=`（钥匙 `polymarket`，看板 60s）。Gamma 公开接口，免 key。网页 `/event` 用，不进复盘预热、不进报价中心。
- **财经日历**：`GET /api/event/calendar`（钥匙 `event_cal`，300s）。短线侠 timeline，和九言日历同一口。不进复盘预热、不进报价中心。
- **生意社现货（参考看板补齐）**：`GET /api/market/spot-table` 现货/期货/基差对照（8h 缓存，历史落在 `~/.vibe-research/spot-history.json`）· `GET /api/market/chem-spot?id=` 化工现货中位数。套利期现卡「现期」tab 读这两口，A 股宏观观察不画。
- **期货日 K / 个股板块 / 直播快讯**：`GET /api/market/future-daily?code=nf_AU0`（新浪内盘/外盘日 K）· `GET /api/market/stock-boards?code=600519` · `GET /api/market/stock-boards-batch?codes=`（东财行业/地域/概念）· `GET /api/market/lives`（新浪 7×24，失败回退华尔街见闻；`source=jin10` 走金十 `flash_newest.js`；快讯格三档共用这条）
- **涨跌幅分位 / 成交额榜 / 真假板 / 同花顺成份**：`GET /api/market/breadth`（全 A p10–p90 + 8 档直方图，挂情绪格；新浪 `hs_a` 按页拉满，单页上限约 100，不足则腾讯批量）· 成交额榜 / 个股榜走新浪 `hs_a` · 涨跌停池与短线情绪共用东财四池原始缓存（180 秒）· 腾讯买一/卖一标真假封（只扫池内标的）· `GET /api/market/ths-profile` / `ths-rotation`（shy313 同花顺概念/行业，24h 缓存 `~/.vibe-research/ths-ext.json`）
- **板块热点成分股**：默认左领涨 / 右领跌；点板块后原来的成分股列表出在另一半（再点或关回双列）。成分股走腾讯 `getBoardRankList`（`pt*` 代码）；主力净流仍补东财 `ulist`（独有字段）
- **ETF 份额**：`GET /api/market/etf-shares?code=510300` 或 `?codes=510050,510300,510500,588000,159915,159919`。沪市走上交所日频（万份/1e4），深市走深交所基金规模（份/1e8），本地缓存；季报申购/赎回仍走东财。复盘资金页一张图看这六只
- **已去掉的闲置/兜底东财封装**：人气榜、akshare 个股概况、行业研报；板块排名/成分/个股榜/成交额/涨跌家数/全球指数不再用东财兜底。资金流、打板四池、公告研报等独有数据仍走东财。
- **给 agent 用**：用 Claude Code 等 agent 跑本仓库时，要调 A 股数据就看 [`a-stock-data/SKILL.md`](a-stock-data/SKILL.md)——每个接口都有 copy-paste 即用的代码。线上实现以 `backend/astock.py` 为准；`norm_ticker` / 北交所老号段 / 报价 `is_stale` 已同步进运行时。
- **运行依赖**：`pip install mootdx requests pandas stockstats`（自包含，v3.0 起已移除 akshare 依赖）。
- **更新 / 上游**：<https://github.com/simonlin1212/a-stock-data> —— 想跟进最新端点、扩数据源，去这里看；**但即便你不更新，仓库自带的这份也是固定可用的快照，可以一直用。**

### 美股 / 港股数据 · global-stock-data

- **就在本仓库的 [`global-stock-data/`](global-stock-data/) 文件夹里**（v2.0.3）。13 层数据架构、30+ 个端点、11 个数据源、零鉴权，覆盖美港股行情 / K线 / 技术指标 / 三表财报 / 资金流 / 期权（CBOE 官方期权链含完整希腊字母与 0DTE 流）/ FINRA 空头成交量 / SEC EDGAR 申报流与全市场筛选。每个数据源都标注了合规级别。
- 后端 `backend/gstock.py` + `gstock_deep/`：全球指数 + 美港股行情/关键财务 + **估值/分析师/机构持仓（Yahoo quoteSummary；挂了就空）** + **三表关键科目（东财）** + **CBOE 期权 0DTE/异动** + **SEC 申报 / EDGAR Screener / 财报日历** + **美/港涨跌榜（market_stock_list）** + **个股新闻（Yahoo search，crumb 被拦时走 RSS）**。个股页输 `AAPL` / `00700` 即可。
- **美股日 K**：`GET /api/global/us/kline?symbol=AAPL&num=180`（新浪；Yahoo chart 在国内 403）。A 股日 K 腾讯/mootdx 空时回退 **Baostock**（可选包）。
- **研究桌**：`GET /api/research/kline`（Stooq / Baostock / pykrx）· `/correlation` · `/etf-holdings` · `/13f`。韩股日 K 需 `pip install pykrx`（Naver 复权，不是 KRX 原始盘）。
- **回测**：`GET /api/backtest/meta` · `GET /api/backtest/index-pool`（沪深300 / 中证500 / 科创50 / 创业板指；`history=1` 同时写入中证变动日快照）· `POST /api/backtest/run`（可 `index` + `pit_members` 按日成分回放；策略含 `top_k` 目标权重，可 `max_weight` / `industry_neutral`；`exclude_st` / `min_list_days` 可交易掩码）· `POST /api/backtest/factor`（含 ROE/净利润/营收公告日 PIT；周/月=交易期末）· `POST /api/backtest/model`（LightGBM 可选，分数进 Top-K）· `GET/DELETE /api/backtest/runs` · `GET /api/backtest/store`（可带 `?codes=` 看这批覆盖）· `POST /api/backtest/store/sync` · `POST /api/backtest/store/members` · `POST /api/backtest/store/fundamentals`。库存不齐会现拉, 会慢。日 K 走 `daily_bars`（腾讯，与 light_kline 同源）。实验在 `~/.vibe-research/backtest/runs/<id>/`。表单默认仍是最新名单静态池；勾选按日成分才回放。沪深300 基准有快照时是等权可交易账户，不是指数价格比。北交所 920 按 30% 涨跌停。
- **美股页**：观察列表 + K 线 + **EDGAR Screener（S 级）** + 涨跌榜 + 选中标的期权 + 财报日历 + SEC 日报。
- **AI 观察**：`GET /api/ai-watch/openrouter-usage`（需 `OPENROUTER_API_KEY`，无 key 读本地缓存）· `spend-index`（TrakToken RSS）· `aa-models`（可选 `ARTIFICIAL_ANALYSIS_API_KEY`）· `ai-infra`（SEC CapEx + 模型外推）。快照落在 `~/.vibe-research/ai-watch/`。
- **SEC**：设置 `VR_SEC_CONTACT="Name you@example.com"`，否则 SEC 端点返回 503。
- **CBOE 期权**：合规 C 级，仅个人研究；商用须先取得 Cboe 授权。延时数据，不用于实盘下单。
- **韩股**：加 `.KS`（如 `005930.KS`）；行情 + 研究桌日 K（pykrx）。台股走 ADR（如 `TSM`）。
- **上游**：<https://github.com/simonlin1212/global-stock-data>

### 全球资讯 · investment-news

- 12 赛道 108 个公开 RSS 源，已并入 `backend/newsradar.py` + `backend/news_sources.json`：纯标准库、零 key、已按合规词表过滤（剔除赌 / 预测市场 / 加密等）。
- **上游**：<https://github.com/simonlin1212/investment-news>

### 期权/期货 · OpenVlab

- 接入 [openvlab.cn](https://www.openvlab.cn/market) 的全部公开 REST 接口（无鉴权），并入 `backend/ovlab.py`：
  - **市场概览** `GET /api/ovlab/market` — 全部品种现价 / 涨跌 / 平值隐波 / 隐波百分位 / 22 日实波 / VolAlphaT / Carry / 偏度及百分位 / 主力合约 / 到期日 / 夜盘 / 境外
  - **单品种详情** `GET /api/ovlab/detail?prod_und=510300` — dto（含主力合约月份、希腊字母、隐波曲线、各合约报价）
  - **期权波动率期限结构** `GET /api/ovlab/volatility-ts`
  - **期货期限结构** `GET /api/ovlab/future-ts-all` · `GET /api/ovlab/future-ts?prod_und=MA`
  - **套利看板** `GET /api/ovlab/arb-board` — 跨期近-次 / 跨品种近月 / 股指近月；复用 `future-ts` 钥匙，60s 冻结；不打 market / future-ts-all
  - **异动榜** `GET /api/ovlab/flow-alert` — 成交异动 / 走势异动 / 连续成交；合约 / 到期日 / 区间涨幅 / 窗口成交量 / 权利金。盘中缓存 60 秒（对齐驾驶舱轮询），休市冻结
  - **MQTT** 网页直连 `wss://emqx.openvlab.cn/mqtt`（mqtt.js，optionflow / ctamap / dataview）。本机 sidecar 仍订同一批：`GET /api/ovlab/mqtt` 快照、`GET /api/ovlab/mqtt/stream` SSE 兜底；异动/行情观察/分时叠在 REST 底上，不写 `ovlab_flow_alert` / `ovlab_market`；`VR_OVLAB_MQTT=0` 关；`paho-mqtt` + `websocket-client`
  - **资金流** `POST /api/ovlab/flow-data` — 分页资金流
  - **持仓历史** `POST /api/ovlab/warehouse-history` — 单品种多年仓单序列（year2013~2026 + ratioData）
  - **仓单瘦身** `GET /api/ovlab/warehouse-receipt?product=AU` — 最新/日变/近90日，复用上条缓存；驾驶舱期限结构卡用
  - **K 线 / 价格波动率** `POST /api/ovlab/price-volatility-series`（body: `{codes: ["MA:202609", ...]}`，返回当日分时价格+隐波序列；市场概览「走势」列同源，缓存 5 分钟）
  - **轻量行情图表**（移植自 `/chart/light`）`GET /api/ovlab/kline-history?symbol=SC2609&resolution=1D`（K 线 OHLC + 持仓 + 成交量）· `GET /api/ovlab/atmvol-history`（ATM 隐含波动率历史）· `GET /api/ovlab/last-bar?code=SC2609`（实时最新 bar）· `GET /api/ovlab/search-symbols?keyword=SC`（标的搜索）· `GET /api/ovlab/symbol-info?code=SC2609`（合约元信息：交易时段 / 价格精度 / 到期日）· `GET /api/ovlab/volatility-surface?product=SC`（波动率曲面）· `POST /api/ovlab/skewmap`（偏度图）· `GET /api/ovlab/surfacemap`（曲面图）
  - **持仓排名**（移植自 `/flow/option-flow`、`/future/position-ranking`）`GET /api/ovlab/option-position-products`（期权持仓品种列表）· `GET /api/ovlab/option-position-details?product=IO&code=IO2608&direction=C&day=2026-07-03`（期权持仓明细，方向 C/P）· `GET /api/ovlab/future-position-products`（期货持仓品种列表）· `GET /api/ovlab/future-position-details?product=RB&code=rb2608&direction=0&day=2026-08-03`（期货持仓明细：买方/卖方/净多/净空 4 张期货公司持仓排名表 + 增减 + 净多/净空第一）
  - **异动资金流** `POST /api/ovlab/flow-data`（期权异动明细分页：合约/最新价/涨跌幅/持仓量/持仓变化/成交量/成交额/买卖盘占比/OTM/DTE，可按品种筛选，不缓存）
  - **元数据** `GET /api/ovlab/product-exps`（合约月份）· `/exchange-info` · `/sector-info` · `/next-trading-day` · `/holidays?exchange=CZCE`
- 前端「期权/期货」页：**驾驶舱一屏**（无复盘/K线页签；分时可切两日）。T 型报价 / 异动挂在驾驶舱格子里。AI 工具层（`tools.py`）注册 15 个 `query_ovlab_*` 工具（含套利看板、波动率/期货期限结构、K线/ATM隐波、合约搜索、资金流、波动率曲面，前端虽部分未展示但 AI 可查），问 AI / MCP 均可调用。缓存分层：行情/概览 5 分钟、走势预览序列 5 分钟、波动率曲面 2 分钟、合约搜索 60 秒、合约元信息/到期月份 30 分钟、交易所/板块/节假日 1 小时、实时 K 线 / 最新 bar / flow-data 不缓存。**只客观呈现公开数据，不推荐、不预测、不评分。**

> 数据均来自公开源。Vibe-Research 只做客观信息整理与公开榜单呈现（连板股 / 成交额榜等，与东财 / 同花顺同款客观数据），**只呈现事实、不推荐个股、不预测涨跌、不给买卖时机、不做主观评分**；用这些数据做什么分析、看什么方向，由你和你自己的 AI 决定。

## 架构

给 AI 改代码：见 [CONTEXT.md](CONTEXT.md)。

一套数据层 + 两条 AI 出口：

```
Vibe-Research/
├── a-stock-data/      A 股全栈数据工具箱（数据源，v3.6.0，自带即用）
├── global-stock-data/ 美股 / 港股数据工具箱（数据源，v2.0.3，自带即用）
├── backend/           FastAPI :8900
│   ├── astock.py        A 股数据（移植自 a-stock-data）
│   ├── gstock.py        美股 / 港股行情与关键财务
│   ├── ext_feeds.py     Stooq / Baostock / pykrx
│   ├── etf_lookthrough.py  ETF 穿透（东财 + N-PORT）
│   ├── inst_13f.py      13F 持仓与环比
│   ├── gstock_deep/     估值/三表/资金流/SEC/财报日历
│   ├── ai_watch/        AI 观察：OpenRouter / TTSI / AA / 基建 ROI
│   ├── newsradar.py     资讯雷达（移植自 investment-news）
│   ├── market.py        市场情绪 + 板块资金流 + 全球指数
│   ├── ovlab.py         期权 / 期货波动率（移植自 openvlab.cn 爬虫）
│   ├── portfolio.py     A 股持仓 + 已清仓（存本地用户目录）
│   ├── ctp/             期货 CTP 只读查资金/持仓（可选 openctp-ctp）
│   ├── tools.py         AI 工具层（chat / MCP 共用, 含研究桌 4 个）
│   ├── chat.py          系统 AI（OpenAI 兼容 function-calling）
│   └── mcp_server.py    MCP server（给 Claude Code 等 agent）
└── frontend/          Vite + React 19 + TS + Tailwind（深蓝青驾驶舱）:5899；K/分时 lightweight-charts，热力图/期限结构 ECharts
```

**分级依赖**：行情（腾讯）+ 研报 / 公告（东财）**秒装可用**；akshare / mootdx 惰性导入，缺失时对应端点返回 501 + 安装提示，不拖垮服务。

## 快速开始

### Windows（双击 bat，无需 venv）

分别双击项目根目录下的两个脚本（各开一个窗口）：

- `start-backend.bat` — 后端 `:8900`（系统 Python 直接装依赖并启动）
- `start-frontend.bat` — 前端 `:5899`（缺 `node_modules` 时自动 `npm install`）

浏览器打开 http://localhost:5899

### macOS / Linux

```bash
# 后端（:8900）
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8900

# 前端（:5899）
cd frontend && npm install && npm run dev
# 浏览器打开 http://localhost:5899
```

### 服务器部署 / 自动更新

- 局域网：`bash deploy/install-lan-hook.sh` 一次，之后每次本地 commit 自动更新 `172.168.115.149`（`VR_LAN_SKIP=1` 可跳过）
- 手动：`bash deploy/update.sh`（参数见脚本注释）
- systemd 首次安装：`bash deploy/install-systemd.sh`
- **GitHub Actions 自动部署**（push `main` → 云主机；成功可发邮件）：见 [`deploy/README.md`](deploy/README.md)

默认假定 `VR_PYTHON=/root/miniconda3/bin/python`、目录 `/root/Vibe-Research-main`。

## 接入 AI

在「接入 AI」页配置一次，全站的「问 AI / 复盘 / 今日要点」就都用你自己的模型。**分析都由你的模型给出，本产品不校准、无倾向。** 三种方式：

### 1. 订阅接入（调本机已登录的 CLI，免 API key）

用你自己的**订阅额度**，不用付 API 费。已支持：**Claude Code · Codex · Qwen Code · DeepSeek CLI**。

- **前提**：① 后端跑在你本机（云端读不到你本机 CLI）；② 对应 CLI 已安装并登录，命令在 `PATH` 上。例如：
  - Claude Code：`npm i -g @anthropic-ai/claude-code` → `claude`（用 Claude 订阅登录）
  - Codex：装 OpenAI Codex CLI → `codex login`（用 ChatGPT 订阅）
  - Qwen / DeepSeek：装各自 CLI 并登录
- 在「接入 AI 页 → 订阅接入」选一个即可，**无需填 key**。
- 原理：后端 `cli_runtime.py` 检测本机命令并 `spawn` 它一次性作答（数据已在提示词里）。⚠️ CLI 不做多轮工具调用，适合「复盘 / 今日要点 / 个股页问 AI」这类**数据已备好**的场景；要 AI 自己现场调数据工具的自由问答，用下面的「API 接入」。
- **复盘快照**：点「AI 复盘 / 问 AI」时，前端把当前驾驶舱各格打成一份文本（指数 / 涨跌分布 / 涨跌停 / 板块 / 资金 / 个股榜 / 商品 / 实时热点 7×24 全文 / 自选 / 龙虎 / 利率），缺格标明「未取到」。实现见 `frontend/src/lib/reviewContext.ts`。
- **定时复盘邮件**（可选）：A 股交易日收盘后后端自己跑一轮同样的总结，SMTP 发到你的邮箱（休市日不发）。开关 / 时间 / 收件人在接入 AI 页改。网页 key 定时任务读不到，必须在 `backend/.env` 再配一份模型 + SMTP。详见 `backend/.env.example`。

### 2. API 接入（填自己的 key）

「接入 AI 页 → API 接入」选一个模型，**baseURL 自动填好**，只需粘 key。内置 **DeepSeek / 豆包 / MiniMax / OpenAI / OpenRouter / Groq / Together / MiMo / 任意 OpenAI 兼容端点**。这条支持 function-calling——AI 会自己调数据工具（行情/估值/研报/新闻）再作答。key 只存你本地浏览器、随请求发给你自己的后端、不上传、不进仓库。

### 3. MCP（给 Claude Code / 高手 agent）

把后端挂成 MCP server，agent 用自己的订阅额度调 Vibe-Research 的数据工具、多步分析。命令见 [`backend/README.md`](backend/README.md)。要更全量的 A 股数据端点，用根目录 [`a-stock-data/`](a-stock-data/SKILL.md) 工具箱。

### 4. 定时复盘邮件（收盘后发到你的邮箱）

开关、时间和收件人在「接入 AI」页改，立刻生效。网页「问 AI」的 key 定时任务读不到，SMTP 授权码和模型 key 仍写在 `backend/.env`（字段见 `backend/.env.example`）：

```
VR_REVIEW_MAIL=1
VR_REVIEW_MAIL_AT=16:10
VR_REVIEW_MAIL_TO=you@qq.com
VR_REVIEW_LLM_BASE_URL=https://api.deepseek.com
VR_REVIEW_LLM_API_KEY=
VR_REVIEW_LLM_MODEL=deepseek-chat
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=you@qq.com
SMTP_PASS=                 # QQ 邮箱授权码, 不是登录密码
```

后端在工作日到点后收集看板快照，复用现有复盘提示词，SMTP 发一封。每天最多一封；服务器晚启动会补发当天那封。接入 AI 页可看状态、立刻试发。只做客观陈述，不构成投资建议。

## 测试

```bash
cd backend && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -m "not live"   # 离线单测 + API 校验（快、稳，无需联网）
.venv/bin/pytest -m live          # 联网核对数据源 shape（升级 / 发布前跑一遍）
```

拆模块后漏 import 会在进上游之前就 `NameError`（2026-08 美股页一批 502 就是这个）。`tests/test_undefined_names.py` 用标准库符号表扫 `backend/`：函数里用到、本文件没绑定的名字直接失败，不联网。

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。版本号唯一来源是 `frontend/package.json`，后端 API / 前端界面 / MCP `serverInfo` 全部从它读取。

## 合规

- 只做客观数据整理与公开榜单呈现：**不荐股、不预测涨跌、不给买卖时机、不承诺收益、不做主观评分**；中立无倾向。
- 连板股 / 成交额榜等均为**客观公开榜单数据**（东财 / 同花顺同款），产品只如实呈现、不附带任何推荐或预测。
- 所有分析方向由你自己配置的 AI 给出，与本产品无关。UI 无买卖按钮；估值历史分位只标位置、不划买卖线。
- **持仓 / 关注股 / API key 只存本地，不上传、不进仓库。**
- 持仓默认存在**用户目录 `~/.vibe-research/`**（可用环境变量 `VR_DATA_DIR` 换根目录）——在项目文件夹之外，**重新下载 / 覆盖更新项目文件夹不会丢数据**；旧版本存在 `backend/.cache/` 的数据，新版首次启动自动迁移（复制，原文件保留）。

## 相关生态

Vibe-Research 用到的数据 / 工具，来自同一套自研开源体系（都在 [`simonlin1212`](https://github.com/simonlin1212)）：

| 仓库 | 定位 |
|---|---|
| [**a-stock-data**](https://github.com/simonlin1212/a-stock-data) | A 股全栈数据工具包（10 层 · 47 端点 · 15 数据源）—— 本项目的 A 股数据引擎 |
| [**global-stock-data**](https://github.com/simonlin1212/global-stock-data) | 美股 / 港股全栈数据工具包（13 层 · 30+ 端点 · 11 数据源） |
| [**investment-news**](https://github.com/simonlin1212/investment-news) | 全球产业链资讯看板（12 赛道一一对应 A 股板块）—— 本项目的资讯源 |
| [**Agent-Staff**](https://github.com/simonlin1212/Agent-Staff) | 把公司 Agent 化：每部门一个 AI agent + CEO 参谋长，常驻飞书 |

## 联系作者

作者 **Simon**，独立开发者。

- 🐦 X：[@linsizhen](https://x.com/linsizhen)
- ✉️ 邮箱：<simonlin0423@gmail.com>
- 💬 欢迎交流**企业 AI 落地方案**；项目相关问题也可提 [Issue](https://github.com/simonlin1212/Vibe-Research/issues)。

## 致谢

- A 股数据引擎：[a-stock-data](https://github.com/simonlin1212/a-stock-data)（作者：Simonlin1212）
- 美股 / 港股数据引擎：[global-stock-data](https://github.com/simonlin1212/global-stock-data)（作者：Simonlin1212）
- 资讯：[investment-news](https://github.com/simonlin1212/investment-news)（作者：Simonlin1212）
- 界面设计语言参考并致谢：[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（作者：HKUDS · 仅借鉴 UI，底层为全新实现）

## 免责声明

本项目仅供学习与研究，**不构成任何投资建议**。看板只做客观数据整理与公开榜单呈现——不推荐个股、不预测涨跌、不给买卖时机、不承诺收益；所有分析方向由你自己配置的 AI 给出，与本产品无关。股市有风险，请独立决策、自行核实，风险自担。

## License

MIT
