# Vibe-Research

个人一站式投研平台：把公开行情和复盘材料配齐，结论由使用者自己的 AI 写。

只改本仓库。未要求不 commit、不 push。答复用中文、人话。少写代码：能挂到已有入口就挂。

加格子、加指数、加给模型看的字段、页面上要显示实时价：先读下面的词，再改对应入口。完成标准：没有第二份名单、第二把缓存钥匙、第二条 `/api/quote` 轮询。README 只写人能点到的页面。

**A 股运行时**:
真正跑服务的是 `backend/astock.py`。根目录 `a-stock-data/` 是给 agent 看的参考快照（SKILL 可能超前运行时）。修行情 / 研报 / 报价先改 `backend/astock.py`，不要只改 SKILL.md。
v3.6.0 的 `norm_ticker` / 报价 `is_stale` / 北交所老号段已进运行时（个股 HTTP `_validate` 走同一份 `norm_ticker`）。
v3.7.1 的 `get_prefix` 认 `.SH/.SZ/.BJ` 与显式前缀; 东财 `em_secid` 复用它（510/588 不再 `startswith("6")`）。裸 `000016` 仍是深市个股, 上证50 写 `sh000016` 或 `000016.SH`。
v3.7.0 多出来的源挂 `backend/astock_research.py`：筹码 / 新浪复权因子 / baostock 估值史与上市状态 / 申万行业变迁 / 央行社融原表 / 统计局 PMI 原文。HTTP `/api/astock/*`，钥匙 `astock_chips` `astock_adj` `astock_valhist` `astock_ipo` `astock_sw` `astock_pboc` `astock_nbs_pmi`。社融 / PMI 画在 `/macro` 月度行，其余先不画。不进预热、不并进 `macro_board` / `lpr`、不另开复权 parquet。baostock / xlrd 惰性，未装 501。问 AI：`query_chips` / `query_valuation_history` / `query_list_status` / `query_sw_industry`。
_Avoid_: 把 SKILL 当线上实现、两套 ticker 归一化、沪指数白名单改裸 000xxx、塞进 warmup、第二把 macro_board、第二套复权 parquet

## Language

**复盘快照**:
驾驶舱首屏要画的那几格数字（指数、总览、情绪、行业、龙虎、北向）。按 paint / top / full 分批取。
入口: `backend/review_snapshot.py`（读复盘清单）。
_Avoid_: snapshot payload, BFF, review DTO

**复盘清单**:
「复盘要拉哪些格、走腾讯还是东财、用哪条缓存」的唯一名单。预热、邮件、问 AI 都读这份。
入口: `backend/review_jobs.py`。缓存键与 `GET /api/market/*` 对齐，预热填过的问 AI 再取不再打上游。
_Avoid_: job list, warmup steps, panel catalog

**复盘上下文**:
把复盘数字打成一段给模型看的中文快照。网页问 AI 和定时邮件用同一段，缺的格写「未取到」。
入口: `backend/review_context.py`；HTTP `POST /api/market/review-context`。问 AI 只调 `api.reviewContext`。对照昨日档走 `GET /api/market/review-archive-diff`（`api.reviewArchiveDiff`）。
加一段给模型看的内容：改这个打包口和 `EXPECTED`。按日落 `VR_DATA_DIR/review-archive/`（预热 / 问 AI / 邮件共用；`VR_REVIEW_ARCHIVE=0` 关）。
复盘页顶上一行对照昨日档：`GET /api/market/review-archive-diff`（钥匙 `review_archive_diff` 60s，不进预热、不另开 snapshot）。`need_two_runs`（还只有一天，`changes` 是 null）和 `unchanged`（比过了没变）分开，空列表不能当缺档。打包口加【相对昨日】，不进 `EXPECTED`。
_Avoid_: prompt packer, reviewContext.ts, system prompt, 空 diff 当没变, 第二条 review-snapshot

**指数目录**:
驾驶舱那 17 个指数（含中证500 `sh000905`、中证1000 `sh000852`、日经225 `jpN225`、韩国KOSPI `ksKOSPI`）的唯一名单。复盘快照、报价中心、问 AI 工具都认这份。恒生 / 恒科 / 日经 / KOSPI 画在行情观察、纳指期货下面，不另开名单。无标的/日K tab。纳指期货 NQ 是 `hf_NQ`，比特币是新浪 `hf_BTC`（期货 CFD），都不进指数目录。
入口: `backend/index_catalog.py`。前端 `frontend/src/config/cockpit.ts` 的 `WORLD_INDEX_DEFS` 必须同序同码。
`astock.A_INDICES`、`cockpit_live.WORLD_INDICES` 从这里来。
_Avoid_: A_INDICES, WORLD_INDICES, WORLD_INDEX_DEFS（实现名，不是领域名）

**衍生目录**:
期权驾驶舱首屏要画的国内品种唯一名单（21 个：股指 IO/HO/MO、ETF 期权 5 个、商品期权 13 个），码是 OpenVlab `ctamap-all` 的 `product`，按活数据校准（无国债、无 HC）。预热不进复盘清单。
入口: `backend/deriv_catalog.py`。前端 `frontend/src/config/deriv.ts` 的 `DERIV_DEFS` 必须同序同码。
_Avoid_: 第二份品种 JSON, 把 OpenVlab 塞进 review_jobs / 报价中心

**期权驾驶舱**:
`/derivatives` 默认那一屏（顶栏紧挨 A 股；旧 `/ovlab` 书签 301 过来，查询串保留）。格子从 `GET /api/ovlab/market`（钥匙 `ovlab_market`）筛衍生目录，异动走 `ovlab_flow_alert`（对齐 [openvlab.cn/flow/option-flow](https://www.openvlab.cn/flow/option-flow)：表列时间/合约/成交异动⬆红(ask主动买)·成交异动⬇绿(bid主动卖)·走势异动·连续成交/剩余天数/区间涨幅/区间成交量；阈值本机 `deriv.alertThresh`：三类可关（开关只在阈值面板，不另占顶栏），成交异动默认额10万或量100手（下限1万/50手），走势异动默认1分钟涨幅20%且额1万（额下限1000），连续成交默认2秒额5万（下限5万），不另开轮询；盘中钥匙 `ovlab_flow_alert` 60s 过期重取，休市冻结），迷你走势只对可见目录码调 `price-volatility-series`（轴同行情报观察 has_night_trading, 白盘不铺 21:00）。首行：**行情观察**主卡一张竖表（股指+商品主力，默认股指在上，含隐波/IV分位色带/溢价/沉淀资金）| 临期期权日历 | **期限结构** | 异动。卡内 tab 切自选合约（`WatchPanel`，本机 `deriv.watch`）与「指数」（`ThsCmdIndexPanel`：同花顺商品指数 850xxx 快照+分钟分时，名单 `frontend/src/config/thsCmdIndex.ts`，走 `GET /api/ths`，不进指数目录/衍生目录/报价中心）；股指·商品表沉淀列：期货 ← 本地算 `GET /api/ovlab/parked`（各月 `future-ts` 持仓×价格×九期网乘数×该月交易所保证金，复用 `ovlab_future_ts::`，钥匙 `ovlab_parked` 300s，不打 `future-ts-all`）；ETF ← 已有 `etf_shares_many` 最新份额×行情观察现价（同一把 `510050,510300,510500,588000,159915,159919:80`）；乘数/保证金都走九期网手续费表（缺月用该品种主力月%），不写死 `fut_spec.SPEC`，期货公司加收不计入；不进复盘预热/报价中心；临期日历走 `product-exps` 月历（日级基础数据, 进页拉一次, 点刷新才再取, 不跟 60s 行情轮询），只画当前查看月且未过期，切月看远月，格子标交易所短名，点/悬停列出当日标的；手机全宽叠卡。第二行留给 **T 型报价联动区**（`TQuotePanel` 约七成 + 右侧分时/日K约三成（上分时下日K））：点「行情观察」的品种行切 T 型报价品种并在右下出该标的日K/分时（空 `prodUnd` 用目录 `und`，T 表换月不覆盖标的图）；点 T 表顶栏当月期货价同样出标的图；T 表换品种下拉也出主力期货图（不先清成 ATM 购）；T 表与期限结构品种下拉左点搜索、右箭头展开（本地过滤，不另轮询）；到期月在看涨/看跌表下小方块(品名+YYMM / 月.日 剩N天, 点月切表, 不在顶栏、不跨左侧微笑); 换到期月且当前期权不在链上才 ATM 购，点 T 表某档 Call/Put 切该期权合约图。T 表默认全部行权价（从上到下降序，点行权价列头切升序），表头看涨期权Call 红字 / 看跌期权Put 绿字，标的现价用蓝线卡在相邻两档之间（当月期货最新，行情观察同快照仅 ETF 回落，不标 ATM 字母），默认开「隐藏实值」（只藏实值侧格子，夹档两边都留，本机 `deriv.tquote.hideItm` 记过关才关）；可见格子实值暗红底、虚值暗绿底（ATM/未知不涂，选中仍紫，字色不动），IV 相对 ATM 着色、持仓为相对可见档最大仓的半透明横条（购向右/沽向左）、最大持仓档标「仓」；品种下拉旁大号显示当月期货最新/涨跌（tquote 挂 future-ts 同月 `future_tday/yday`，切到期月跟着变；ETF 无期货回落行情观察快照，不另轮询）；概览含当月远期涨跌 / ATM隐波 / PCR / 购沽持仓 / 偏度 / 预期波动。T 表 ← `GET /api/ovlab/tquote?product=`：`volatility-surface` 按到期月解析出行权价链（IV 买卖/理论 IV/Delta/持仓），价格列是 Black-76 理论价（theoIv+forward 反推，平价关系自洽），旁标相对昨理论价涨幅（昨=forward_yd+theovol_yday 同式反推，不另开接口），每档带 `callCode/putCode`（`{prod}{exp[2:]}{C/P}{strike:g}`，全交易所+ETF 实测通用），每月带 `und`（期货期权 `{prod}{ym}`，ETF 用基金代码）。股指（IF/IH/IM）近月上游往往只给 ATM 附近几档，T 表按已有间距把梯子补到约 ±15% / 至少 25 档，翼侧 IV 用微笑插值（不另开接口）。**期权日K** ← `GET /api/ovlab/option-daily?code=&und=`：OpenVlab `history` 对期权码分钟级给真值（历史段约小时级快照、当日 1 分钟），后端按交易日聚合 OHLCV（夜盘 >=20 点归次交易日、凌晨 <6 点归前一晚的次交易日、周末顺延，`_trading_day`），IV 叠加标的历史隐波日线（`history-atmvol`，ETF 无则空）；量在主图下方独立窗；缓存 5min 随时段冻结；盘中 MQTT dataview 叠当日最后一根高低收（不另开接口）。**期权分时** ← 前端直拉 `history`+`history-atmvol`（期权码，一日或两日分钟，往回 5 天够到上周五夜），昨结=分钟 pct 字段反推（虚线价线，不画红绿 Baseline 区），价线白、不画均价，图上叠成交量+持仓量（history `[t,close,pct,oi,o,h,l,vol]`，量柱按当根 close>=open 红绿对齐 [openvlab.cn/chart/light](https://www.openvlab.cn/chart/light/ZN202609)，量/仓在主图下方独立窗（仓独立轴 `oi`，可拖分隔条），不另开接口）；X 轴铺满当日交易时段槽位（ETF/股指日盘 09:30-15:00，商品 09:00-15:00 跳 10:15 休，有夜盘再加 21:00 起），未到时刻空着，股指/ETF 日盘从 09:30 贴左（无夜盘, 晚上也不铺 21:00），白盘商品(SI/LC/PS, 或行情观察 has_night_trading=0)从 09:00 贴左不铺 21:00，有夜盘商品从昨夜 21:00 贴左；价轴绕昨结对称、四角标轴端同 A 股（无夜盘点也铺, 无凌晨成交则 23:00 接到 09:00, 不铺 23:00-02:30 真空）；夜盘 history 还没有今夜点时轴仍切到当夜交易日（`frameTradingDays` / `liveAxisKind`），MQTT 填当前分钟；十字光标读价/IV/量/仓（LC logical 下标，空槽不能把 value 当数字）；盘中 15s 拉 history、MQTT dataview 叠当前分钟槽。**期货标的图**（行情观察行 / 点 T 表顶栏期货价，`kind=und`）优先新鲜 dataview，否则叠行情观察同份 ctamap 主力价（MQTT 主推），再用 `last-bar` 做底；叠价相对行情观察/history 偏离过大(如 SI 期权碎价串到 SI2610)则丢掉（期权码不能走 last-bar，会回退成标的期货）。K/分时卡走 `lightweight-charts`（封装 `frontend/src/lib/lcChart.ts`，TradingView 读图：A股/期权分时量在独立窗、右侧价格轴、十字带价签、图内 HUD、昨收/昨结价线、合约淡字水印；轴精度银一位金两位；当前合约异动分钟走 `createSeriesMarkers`；分时/套利最新一跳 `createUpDownMarkers` 红绿闪；A股/美股长窗日K对数轴；盘中 MQTT 只改最后一根时 `series.update`，中段空槽仍 `setData`）。T 表左侧上下叠「IV微笑」与「IV期限」，走 createOptionsChart（LC），淡字水印 IV微笑/IV期限（不另写标题），浮窗 React 叠上（深色能看清即可, 不复刻官网白底）。微笑对齐 [openvlab.cn/volatility/analysis](https://www.openvlab.cn/volatility/analysis/FU)：surface 原始 `theovol` 点（`theoSmile`，不画 T 表补档）、今紫空心圆/昨灰虚、smooth 0.25、横轴 `display_strike`，竖线只画合成标的现价（`forward_td`，像素叠层保证竖直，不用两点折线；图上不钉字，悬停竖线才出「合成标的现价: xx.xx」），不画昨收、不跟隐藏实值、不拆购沽市价 IV。期限对齐 [openvlab.cn/volatility/vol-ts](https://www.openvlab.cn/volatility/vol-ts)：各月 ATM 隐波今紫/昨点虚，横轴剩余天数 ±5% 边距，点月切 T 表，悬停复刻 vol-ts 浮窗（平值隐波/今昨变化/月总持仓 Call·Put·PCR，昨仓走 surface `sum_poi`）。同口 tquote，不改理论价、不另打 `volatility-ts-all`。首行期限结构卡仍是远期价+仓单（ECharts），不跟 T 表联动。注意：last-bar 对期权码回退标的期货（所以自选/行情不用它画期权），`surface` 字段偶发 `"nan"` 字符串，`_sfloat` 必须挡非有限值否则响应 JSON 序列化 500（EG 实盘踩过）。无复盘/K线页签。分时卡可切一日/两日（本机 `deriv.minute.days`，两日按交易日拼轴、日间断开、昨结按当日；快切轴长用 `guardLc` 吞 LC `Value is null`，`showSession` 取消上一帧 rAF）。旧书签 `?tab=kline/detail/quote/flow` 忽略，仍是驾驶舱。CTP 账户数据不进这一页（留在 /portfolio）。**期限结构卡** ← `GET /api/ovlab/term-structure?products=`：`volatility-surface` 的 `forward_td/yd` 按到期月抽成远期曲线（并发拉取+缓存 60s 随时段冻结），覆盖**全市场 domestic 品种**（75 个，无期权的上游返回空自动不进曲线），上部下拉选品种（可搜），今实线/昨虚线与持仓柱叠同一图（左轴价、右轴仓），今曲线点上标现值/涨幅（涨幅=(今-昨)/昨，红涨绿跌）。期货走 `GET /api/ovlab/future-ts?prod_und=`（上游 `future-ts/{prodUnd}` 的 `future_tday/yday` + `oi_tday`，对齐 [openvlab.cn/future/term-structure](https://www.openvlab.cn/future/term-structure)）；ETF 无此接口，退回 surface Call+Put。同卡叠该品种**仓单**（最新/日变/近90日折线，品种下拉正下方常显）：`GET /api/ovlab/warehouse-receipt?product=`，上游 `warehouse/history` 同一把钥匙 `ovlab_wh_history`（对齐 [openvlab.cn/future/warehouse-receipt](https://www.openvlab.cn/future/warehouse-receipt)），不另开缓存；有品种无点仍回 `{product, last:null}`（空 `{}` 会让前端一直转圈）；默认选第一个有仓单的商品（不默认股指）；股指/ETF 标「无仓单」。品种选择只在本格内，不跟 T 型报价联动；上游 `future-ts-all` 只覆盖 6 个品种，单品种 `future-ts/{prodUnd}` 才有全月份持仓。
ovlab 缓存随交易时段：盘中过期重取、上游失败回落上一笔；休市（盘后/午休/周末）冻结只喂上一笔，冷键放行一次。后端启动 `ovlab.warm_once` 填一次首屏钥匙（market / flow-alert / product-exps / 目录码分时；不预热 future-ts-all）。时段窗口前后端各一份（`ovlab.deriv_market_open` / `derivShared.derivSession`），改窗口两边同步。MQTT：网页按 OpenVlab 同款直连 `wss://emqx.openvlab.cn/mqtt`（mqtt.js / guest / `vlab/stream`，订 optionflow · ctamap · dataview `instr/+`）。后端 sidecar 仍订同一批（`VR_OVLAB_MQTT=0` 关）。optionflow 叠在异动卡上（REST `ovlab_flow_alert` 做底；网页主推是浏览器 MQTT，broker 挂了才 SSE `GET /api/ovlab/mqtt/stream` / 0.5s 读 `GET /api/ovlab/mqtt`，不写那把钥匙）；异动卡顶栏标 MQTT 已连接(绿) / 未连 / 关。ctamap 叠行情观察价/涨跌/隐波（REST `ovlab_market` 做底，不另开 market 轮询、不写那把钥匙）；dataview 叠自选最新、T 表当月期货价、日K/分时最后一笔（不写 last-bar，不改 T 表理论价）。盘中 dataview 超过 8 秒未刷新视为陈旧，期货主力改叠行情观察同份 ctamap（主推），T 表顶栏同序（远月仍走当月 futPx）。点 T 表出图时 `?pin=期权码,标的` 钉住 LRU 不挤掉，并额外订 `instr/{code}` 大小写别名（网页同款 `ag2609C16000`）。商品期权 ctamap 的 `product` 是 `AG_O`/`AU_O`、`prodUnd` 常空，合约码用目录 `und`+`exp`（`AG2609`/`AU2609`），右下角主力图叠行情观察同一口价；股指期货 dataview 码是 `FUT_CFFEX_IF:202608`（最新价在 `value`），收成 `IF2608` 叠日K/分时；guest 股指大约数秒一跳。没有这条再走 ctamap 整表。轴和 HUD 银一位、金两位。套利页同口不带 pin，不冲掉钉住。`VR_OVLAB_MQTT=0` 关。
入口: `frontend/src/pages/DerivCockpit.tsx` + `frontend/src/hooks/useDerivData.ts` + `frontend/src/hooks/useOvlabMqtt.ts` + `frontend/src/lib/ovlabMqtt.ts` + `frontend/src/components/deriv/`。
_Avoid_: 第二条 /api/ovlab/market 轮询, 同一屏两条分时源（新浪 commodity-minutes 不进这页）, CTP 接口, MQTT 写入 ovlab_flow_alert, MQTT 当第二条行情轮询, future-ts-all 算沉淀, iframe 九期网, 第二把 qihuo_fee 钥匙, 杠杆涨跌当本站评分, 塞进复盘预热, 第二条 etf_shares 钥匙, 第二条报价轮询算 ETF 沉淀

**九期网手续费表**:
沉淀用的交易所标准保证金（按合约月）和合约乘数（`每手保证金 / (价格 × 保证金率)`）。入口 `backend/qihuo_fee.py`，一把钥匙 `qihuo_fee`（`table` 300s，挂了回落上一笔）。不写死品种表。手续费不进沉淀。不进复盘预热/报价中心。
_Avoid_: 第二把 qihuo_fee 钥匙, iframe 九期网, 手写 fut_spec.SPEC, 期货公司加收当交易所%

**套利驾驶舱**:
`/arb` 顶栏紧挨期权期货的独立驾驶舱（不是期权页签）。格子：跨期价差（近月-次月）| 跨品种价差（近月对近月 1:1）| 期现（股指走报价中心；现期 tab 生意社现期表 + 化工现货，A 股宏观观察不再画）| 上排两腿仓单 | 下排左分时右日K（股指日线标日度基差=现货−期货；不再切换）。名单 `backend/arb_catalog.py`，前端 `frontend/src/config/arb.ts` 必须同序同码。跨期/跨品种/股指近月走 `GET /api/ovlab/arb-board`（钥匙 `ovlab_arb_board` 60s 随时段冻结），内部复用 `ovlab_future_ts::{und}`，不打 `/api/ovlab/market`，不用 `future-ts-all`。股指期现：IF/IH/IM 近月对指数/ETF，现货腿走报价中心（上证50 `sh000016` 只订报价、不进指数目录；ETF 价×1000 与期货同量纲）；基差=现货−期货。商品期现读 `spot_table`。价差图：期货腿 ovlab `history`，指数/ETF 腿 `loadLightKline`，前端用两腿 OHLC 合成价差 K（开=Lo-Ro·m、收=Lc-Rc·m、高=Lh-Rl·m、低=Ll-Rh·m，再夹住开收；股指期现再取负成现货−期货），分时和日K都走 `lightweight-charts` 蜡烛（封装 `frontend/src/lib/lcChart.ts`，空心阳/实心阴，不画零轴红绿区, 价差不一定贴 0；主图 HUD 读 O/H/L/C, 右侧价签同 `LcHoverTag` 相对上一根收）；仓单复用 `ovlab_wh_history`。MQTT dataview 叠两腿最新（同口网页直连，不带 pin），不写 REST 钥匙。不进复盘清单/预热。CTP 不进这一页。只客观呈现价差，不评分、不标可做。
入口: `frontend/src/pages/ArbCockpit.tsx` + `frontend/src/hooks/useArbData.ts` + `frontend/src/components/arb/`。
_Avoid_: 第二条 /api/ovlab/market 轮询, future-ts-all, 第二份配对 JSON, 把套利塞进 /derivatives, 上证50 塞进指数目录, 新浪 commodity-minutes, CTP, 持有成本/套利评分

**资讯驾驶舱**:
`/event` 顶栏紧挨套利。格子：财经日历 | 实时新闻（财联社 / 新浪见闻 / 金十 三栏各三分之一）；下行 X起爆 | 热榜（NewsNow+REBANG 合成一格，微博/知乎/金十去重，雪球不拉） | AIHOT。快讯走同一份电报中心，三栏同订，不是推送，网页 10 秒拉已点亮的源，过期重取，不另开轮询。**财经日历** ← `GET /api/event/calendar`（钥匙 `event_cal` / `timeline`，300s 上一笔），上游短线侠 `getHotNewsByType type=timeline`，和 [jiuyan.033533.online](https://jiuyan.033533.online/) 同一口。**热榜** ← `GET /api/event/ranks`（钥匙 `event_rank` / `sopilot` `newsnow` `rebang` `aihot`，180s 上一笔）：SoPilot 推文起爆榜 HTML、NewsNow `/api/s`、REBANG 首页+财经页、AIHOT 官方 `/api/v1/items` + `hot-topics` + `dailies/latest` + `/topics` 主题卡（官方 v1 无 topics 口）。不 iframe、不经 NewsNow 转 AIHOT、不进复盘预热/报价中心。
入口: `frontend/src/pages/EventCockpit.tsx` + `frontend/src/components/event/`；后端 `backend/event_cal.py` + `backend/event_rank.py`；HTTP `GET /api/event/calendar` · `/api/event/ranks`。
_Avoid_: 第二条快讯轮询, 把日历/热榜塞进 telegraphHub, 塞进复盘预热, 报价中心, CTP, 第二把 aihot 钥匙

**AI 观察**:
`/ai-watch` 顶栏。原格子：OpenRouter Token / TTSI / 基建 ROI / 价格表 / 散点。底栏再挂 **AIHOT**（与资讯页同一把 `event_rank/aihot`，`GET /api/event/ranks?part=aihot`，180s）。不另开钥匙、不拉 SoPilot/NewsNow/REBANG。
入口: `frontend/src/pages/AiWatch.tsx` + `frontend/src/components/ai-watch/AihotPanel.tsx`。
_Avoid_: 第二把 aihot 钥匙, iframe, 把 AIHOT 塞进 aiw_or / aiw_ttsi / aiw_aa / aiw_infra

**短线侠驾驶舱**:
`/dxx` 顶栏紧挨宏观。格子：竞价封单 | 竞价/打板 | 涨停直播 | 情绪 | 板块强度 | 复盘/挖掘。只接免登录公开口：`getFengdanLast` / `getDabanData` / `getZtliveData` / `getChartByQingxu` / `getLastQxlive` / `getLiveByStrong` / `getFupanByYidong` / `getWajueMatch`。日历仍走资讯页 `event_cal`，不在这页再拉 timeline。一把钥匙 `dxx`（live 60s / 历史 300s，上一笔），不进复盘清单/预热、不进报价中心。QX 等是上游字段，页面标「不是本站评分」。挖掘只列匹配次数。点代码出 A 股分时日K（`?code=`），不另开轮询。
入口: `frontend/src/pages/DxxCockpit.tsx` + `frontend/src/components/dxx/`；后端 `backend/dxx.py`；HTTP `GET /api/dxx/board`。
_Avoid_: 第二条报价轮询, 第二把 dxx 钥匙, 塞进复盘预热, 日历再拉一份 timeline, 登录/加密接口, 把 QX 当本站评分

**全球情绪**:
加密 Alternative.me、美股 CNN Fear & Greed、日/港/金/油波动率反转分（0–100）。名单只在后端一份。复盘「涨跌分布 / 广度」格下部和美股页同一块。问 AI 叠进【宏观观察】，不另开 EXPECTED。
入口: `backend/fear_greed.py`；HTTP `GET /api/market/fear-greed`（钥匙 `fear_greed`，300s 过期再取）。不进指数目录、不进报价中心、不进预热钟。模拟分丢掉。
_Avoid_: 第二份情绪名单, 第二条报价轮询, 把大盘股 52 周位置塞进来

**宏观驾驶舱**:
`/macro` 顶栏紧挨资讯。格子：LPR（中国货币网 1Y/5Y 折线，走 `lcChart`）| 银行间（DR007 取银银间 7 天定盘 FDR007 + FR007 + SHIBOR ON/1W/3M）| 汇率/美债（美元人民币订报价中心 `whUSDCNY`；美债 10Y FRED DGS10、美元指数东财 `100.UDI`）| 中债国债 + 政策性金融债曲线 | 月度 CPI/PPI/PMI/社融/M2 | 人行社融原表 | 统计局 PMI 原文 | 上海航运交易所 [CTFI](https://www.sse.net.cn/index/singleIndex?indexType=ctfi) 综合 + CT1/CT2（基期 2012-11-28=1000，涨跌按点数换算百分比）+ 官方走势图（`indexImg?name=ctfi`）。LPR/国债/政金债走已有 `GET /api/market/lpr` · `/bond-yield`（钥匙仍是 `lpr` / `cn_bond_yield`，复盘预热继续填国债，A 股资金页不再画）。银行间 + 月度 + 美债/美指一把钥匙 `macro_board`（`board` 600s），不进预热钟。人行社融 / 统计局 PMI 走已有 `GET /api/astock/pboc-sfin` · `/nbs-pmi`（钥匙 `astock_pboc` / `astock_nbs_pmi`，LPR/board 出齐再取），不并进 `macro_board`、不进预热。美元人民币不进第二份名单。CTFI 日更，钥匙 `ctfi`（`latest` / `img`）4h 上一笔。不进指数目录、不进行情观察。
入口: `frontend/src/pages/MacroCockpit.tsx` + `frontend/src/components/macro/` + `backend/ctfi.py` + `backend/macro_board.py` + `backend/astock_research.py`；HTTP `GET /api/market/lpr` · `/bond-yield` · `/macro-board` · `/ctfi` · `/ctfi-img` · `/api/astock/pboc-sfin` · `/nbs-pmi`。
_Avoid_: 塞进指数目录, 第二条报价轮询, 第二把 lpr/cn_bond_yield/macro_board 钥匙, 资金页再画一份, 挂回 A 股行情观察, 美债/美指进指数目录

**同花顺行情**:
fuyao 网关（`quota-h.10jqka.com.cn`）的快照 / 日 K / 分钟线：股票（沪 17 深 33）、指数（沪 16 深 32）、同花顺指数（64，含商品 850xxx）、板块（48）。免鉴权，Referer 必须带 stockpage 代码路径，裸域名 403。字段是数字 ID；涨跌幅不取上游 199112（语义随市场漂移），由 最新/昨收 现算。不进报价中心、不进复盘清单，是独立数据源。
入口: `backend/ths_quote.py`；HTTP `GET /api/ths/snapshot` · `GET /api/ths/kline`（period: day_1/min_1/min_5）。期权驾驶舱行情观察「指数」tab 挂这份快照+分钟线。
_Avoid_: hexin-v 逆向, 第二条报价轮询, 199112 当统一涨跌幅

**报价中心**:
网页里全球指数 / 商品 / 自选 / K 线页 / 自选公告表共用的那一份实时报价。开市 5 秒，休市/午休拉长，订了外盘（美港日韩汇/期货）报价和分钟都 5s，行情观察同一口。顶栏跑马灯订同一口；设置 / 回测 / 数据 / 研究页退订，画上一笔，不另开轮询。间隔问 `ashareSession.hubPollMs`（交易日来自预热状态的 `trading_day`）。商品快照/分钟过期重取(TTL 4s), 不 last-good 冻死。指数目录盘中报价过期补腾讯(不再钟养冻死), 分时 TTL 4s 过期重取; 休市/午休 A 股分时仍 last-good, 收盘后最后一根早于 14:57 当没走完过期重取。港股/美/日/韩/汇分时不跟 A 股 15:00 last-good (TTL 4s 过期重取); 恒生/恒科分时轴 09:30-12:00+13:00-16:00, 15 点后继续画。腾讯分时空了 A 股指数走东财分钟。
入口: `frontend/src/lib/quoteHub.ts` 的 `useQuotes`。字段用 `pct` / `prev` / `change` / `turnover` / `amount` / `volume` / `bid` / `ask` / `bid_vol` / `ask_vol` / `open` / `high` / `low` / `amplitude` / `vol_ratio` / `limit_up` / `limit_down` / `float_mcap_yi` / `pe_static`，以及腾讯已有的 `pe_ttm` / `pb` / `mcap_yi`。同一份腾讯行透出，不另开轮询。
K 线挂在 `/a-share` 复盘：左列「行情观察」约四成压「自选」约六成（代码/名称/现价/涨幅/涨跌/额/换/开高低走报价中心，不再用 QuoteStockRow 分时 SVG / 主力净）；右侧仍首行三成「涨跌分布 / 市场板块热点 / 板块资金流向」，下行七成正中「分时 / 日K」上下叠（同一 `AShareLightChart` `pane=charts`），右个股榜 + 涨跌停 +「主力 / 龙虎 / 资金 / 产业链」（默认主力净流入排行，本机 `ashare.review.v2`）。共用 `?code=` 与报价中心，不另开轮询；点行出图；旧 `?tab=kline` 落到这一屏。分时照期权卡：轴铺满 09:30-15:00 午休空着（恒生/恒科 09:30-12:00+13:00-16:00），可切一日/两日（两日走腾讯 5 日分时取最近两交易日拼轴、日间断开、昨收按当日，本机 `ashare.minute.days`），量柱按当根相对上一分钟红绿（腾讯分时 O/H/L/C 同价, 不当开收）；A 股分时 T/P/额挂标题行不叠图, 分时/日K标题行右边标最新行情时间(本轮报价 time, 落盘旧戳不用, 不另开轮询); 期权分时 T/P/V/IV/OI 同样挂标题行不叠图; 价轴绕昨收对称(幅度取区间高低相对昨收的较大端, 不再垫到1%), 分时右侧价轴刻度写相对昨收/昨结的涨跌幅(>=0% 红, <0% 绿; 日K仍写价; 约 4-5 档, 不挤), 零轴虚线不在右轴再贴白标签, 淡字水印(股票名/代码)在价轴样式之后再挂, 名字只认当前码换票不留上一只, 四角标区间最高最低价和涨跌幅; A 股分时下窗画成交额(标「成交额」, 腾讯累计拆成分钟增量), 日K 下窗画成交量(轴从 0 起, 柱高跟量成正比; 对数轴只作用价)；十字右侧价签写成 价格(+/-%) 相对昨收/昨结(白底黑字, 涨跌幅单独红绿, 所有 LC 时间图同一块 `LcHoverTag`, 自带横线价签关掉, 不标距今)；期权日K/分时拆量窗, 分时持仓黄线叠在量窗（独立轴 `oi`）。加自选与复盘自选格同一套 `GET /api/fin/suggest`（名称/拼音/代码）。点其他格股票/指数/商品出分时日K（`?code=`，指数带 sh/sz/us 前缀，商品 `hf_XAU`），不写自选。商品分时走已有 `commodity-minutes`（宏观观察同一把钥匙），日K走 `future-daily`，不进腾讯 light-kline；最后一根叠报价中心现价（T/P跟着动，不另开轮询；落盘旧价不叠，等本轮行情），分时按 `hubPollMs` 静默续拉（外盘 5s；续拉失败留上一笔, 不盖「K 线加载失败」）；分时按 24h 原序，不贴 A 股 09:30-15:00；分时无量/额则价线独占窗口(不拆空量窗)。详情/公告仍从分时右上进（`?tab=detail|feed`），A 股顶栏不再切复盘/K线。
`/api/quote` 是遗留 HTTP 适配，新页面订阅报价中心。全 A 横截面不准塞进这里。
_Avoid_: quoteHub, market quotes client, 第二条报价轮询, 休市再写一套间隔, 5000 只进报价中心

**标的池**:
全 A 六位代码的唯一名单。名称写在同一份文件的 `names`，不是第二张 instruments 表。广度、板块轮动、横截面都读这份。
入口: `backend/universe.py`（`load` / `name_map` / `rows` / `search`）。文件 `VR_DATA_DIR/a-share-codes.json`（新浪 `hs_a` 拉满后落下，24h）。
联想走现有 `GET /api/fin/suggest`：先扫这份（代码/名称前缀 → 拼音首字母 → 包含），空了再腾讯智能框。搜索读过期名单，24h 只卡广度。名单进进程内存、拼音预热一次，不是第二份表。名称不够厚时非数字查询直接走腾讯，避免本地落空再打一枪。
_Avoid_: 第二份代码名单, a-share-codes 再写一处, TickFlow instruments parquet / DuckDB 维表, 第二条搜索 HTTP

**板块归属**:
shy313 概念/行业快照，给横截面 JOIN、个股 profile、轮动反查。
入口: `backend/ths_ext.py`。文件 `VR_DATA_DIR/ths-ext.json`（24h）。不是 TickFlow 式同步/清库。
_Avoid_: 第二份板块 JSON, parquet 扩展表, 数据页同步按钮

**横截面快照**:
全 A 当日价 / 涨跌 / PE / PB / 市值 / 换手 + 行业概念。给选股用，先数据层。
入口: `backend/screener_snap.py`。180 秒一把钥匙。打腾讯不写报价中心 5 秒缓存。不进复盘预热，不加 HTTP。
_Avoid_: 第二把全 A 估值钥匙, 预热里拉 5000 只

**全 A 库存**:
标的池近 3 年已收盘日 K（和回测最长 lookback 同一窗口）。原始 OHLC 与复权因子仍写 `VR_DATA_DIR/market/`，和回测同一仓。
入口: `backend/backtest/universe_sync.py`（`STORE_LOOKBACK` / `LOOKBACKS`）。数据页看覆盖，点一次补齐；已齐的跳过，收盘后同一按钮做增量。命令行同一条路: `python backend/fill_2y_bars.py`（可 `--index sh000905` 或跟 6 位代码）。只写已收盘 bar。不清库。不进复盘预热、不进报价中心。
_Avoid_: 第二套 parquet 目录, 盘后 enriched 管道, 启动就扫 5000 只, 同步按钮墙

**缓存键**:
同一份数只用一把钥匙。`TTLCache` 有效值过期不删，留作上一笔：`get()` 只认热槽，`get_last()` 可读上一笔，`get_or_set(serve_last=True)` 第一次填过之后不再出网。空结果仍是短负缓存，过期就扔，不留下一笔。
HTTP `_dc` 默认上一笔。过期再拉只走 `_cached`：自选分时 / 五日和日 K、点开的板块成分、概念板块、涨跌幅榜、直播快讯、财联社电报、分钟资金流、搜索联想。钟养的格子预热 `_put` / `put_fetch` 强制写。个股 F10（估值分位 / 公告 / 财务 / 基本资料 / 公司财报包等）、ovlab、fino、gstock 解析也走上一笔。
全球指数是 `("world_indices", "live")`；总览 / 情绪 / 成交额榜也挂这套，不另开 `market._CACHE`。
_Avoid_: 第二份 TTL、market._CACHE 再包一层、过期就打上游、旁路第二份 last dict、路由按键名写 last=、F10 再开三份 TTLCache

**问 AI**:
使用者把自己的模型接到复盘页。复盘上下文和数据工具走现有入口。
_Avoid_: chat widget, LLM service

**交易日历**:
A 股这一天开不开市。复盘邮件、预热、网页报价中心/分时中心的休市间隔只问这个，不各自判 weekday。
入口: `backend/trading_calendar.py`。`is_cn_trading_day()` 不打网上游；后台刷新上证日 K 日期（东财 push2his，挂了走 push2delay，再挂走已有 `astock.daily_bars("sh000001")`）。网页读预热状态的 `trading_day`。
回测加减交易日也走这里: `day_shift` / `floor_day` / `ceiling_day` / `count_day_frames`，用同一份日期集，不另开日历表。
拿不到日历或日期超出覆盖：只判周末。
_Avoid_: 第二份 weekday 列表、akshare 日历、Omicron / 第二套 int 日期表

**回测**:
自选 / 持仓的日线账户模拟。信号日不等于成交日。默认次日开盘。一笔共享现金。T+1、整手 100、佣金双边、印花税只卖。涨跌停看成交价对昨收带宽。净值只从现金+市值来。
行情: `VR_DATA_DIR/market/` 分区 parquet（原始 OHLC 与复权因子分开），内存 DuckDB / Polars 查，不建 `.db`。只写已收盘 bar（`trading_calendar.last_closed_session`，15:00）。
成分股按日快照（中证调整公告写入变动日，`members_on(asof)` 取 `<= asof` 最新一张）。财务用 `(start, end)` + 公告日，东财 F10 `NOTICE_DATE` 入库 `np` / `revenue` / `roe`。自选默认仍是静态池；勾选按日成分才回放。沪深300 基准有覆盖时是等权可交易账户（同一套撮合），没有快照才退回指数价格比。北交所 920 涨跌停按 30%。
实验: `VR_DATA_DIR/backtest/runs/<id>/` 写完不改。账户写 config / 成交 / 净值；因子写 config / factor.json；模型写 config / model.json，可带成交 / 净值。`meta.kind` 区分 account / factor / model。作业先同步；要排队再加 `jobs.json`，不上 SQLite。
入口: `backend/backtest/`；HTTP `GET /api/backtest/meta` · `GET /api/backtest/progress` · `GET /api/backtest/index-pool` · `POST /api/backtest/run` · `POST /api/backtest/factor` · `POST /api/backtest/factor/compare` · `POST /api/backtest/model` · `GET/DELETE /api/backtest/runs` · `GET /api/backtest/store` · `POST /api/backtest/store/members` · `POST /api/backtest/store/fundamentals`。进度在内存里, 网页在跑时轮询, 不是 TickFlow worker/SSE, 不上 jobs.json。网页 `/backtest`（账户 / 因子 / 模型）· `/data`。日 K 走 `astock.daily_bars`（与 `light_kline` 同一腾讯日 K 解析 `_tencent_daily`）。因子从这份日 K 现场算：动量 / RSI / ATR / 量比 / MACD / KDJ / 振幅 + 超额动量 / 动量加速 / 量变 / 量价相关 / 20 日振幅 + 3 条只用 OHLCV 的 WorldQuant 公式。换手率要流通股本，库存没有时算不了。
账户策略: `hold` / `ma_cross` / `dates` / `rank_mom`（换名单、续持不调仓位）/ `top_k`（分数 → 目标权重，续持加减仓）。`top_k` 可开个股上限和行业中性（`ths_ext.profile` 末级；缺归属单独一组，不假装中性）。同一套现金、T+1、整手、涨跌停、次日开盘。模型页把 LightGBM 分数交给 `top_k`；没装 lightgbm 时接口说明。
一键导入指数成分：东财最新名单写入 `market/members/`，并拉中证调整公告按变动日补快照（`GET /api/backtest/index-pool?history=1`）。表单填的仍是最新名单（静态池，有幸存者偏差）；勾选按日成分才用 `members_on` 回放。
本机数据页看日历 / 标的池日 K / 按日成分 / 财务 PIT / 实验。可点补齐近 3 年、按日成分、财务 PIT，只写已收盘 bar，不清库。回测页 `GET /api/backtest/store?codes=` 看这批齐不齐，缺的跑的时候现拉。`POST /api/backtest/store/members` · `POST /api/backtest/store/fundamentals`。回测优先读库存，缺的再补。
问 AI 工具 `run_backtest` 读成交摘要和净值。
样本外: 参数只在切点前选；`stats_oos_fresh` 是切点后新开的一笔钱（均线仍用切点前历史）。滚动切窗每折新开账户，开着时不再叠单点切窗。回看账户实验用本机 parquet 对 `data_hash`（超过 40 只跳过，避免打开卡死服务）；因子回看只读落盘结果，不重算哈希。对不上只提示、不改 run。持仓页「回测这些」进 `/backtest?codes=&from=portfolio&autostart=1`。
因子页：Rank IC / Pearson IC / 五档净值 / 多空，可改方向 / 分层 / 等权或因子加权；对照最多 6 个因子。周/月调仓用交易周/月最后一根，不是日历周一或月初。默认剔 ST / 退（今天的名称，有前视）和次新（这段日 K 第一根 bar，面板不够长则跳过）；账户 / 因子 / 模型同一套掩码。财务 PIT 因子（ROE/净利润/营收）按公告日。账户有止损、最长持有、月收益和回撤段、Sortino。均线 / 动量 / 模型网格只在样本内选。模型实验 `kind=model`，分数进同一套撮合。因子 / 模型实验也落 runs/，和账户分开列。写明幸存者偏差。实验条可叠对照；成交按标的汇总；可填回表单再跑。
_Avoid_: 第二条日历, 第二条报价轮询, 重叠持有期×252/horizon 年化, SQLite/.db, 用已跑完净值切窗冒充 walk-forward, 第二份代码名单, 第二份板块 JSON, 第二套行情目录

## 就地改

大文件就地改：`backend/astock.py`、`frontend/src/pages/StockData.tsx`、`frontend/src/pages/CtpPortfolio.tsx`、`frontend/src/lib/api.ts`。

K/分时（A 股轻量图、美股日K、期权日K/分时、套利价差）和复盘资金页 ETF 份额日线、宏观 LPR 折线走 `lightweight-charts`，入口 `frontend/src/lib/lcChart.ts`。十字右侧价签一律 `LcHoverTag`（白底黑字, 涨跌幅相对昨收/昨结红绿, 不标距今）。右轴最新价红绿块由 `ChgPriceAxisPrimitive` 画在刻度字之上, 邻近刻度让开。ECharts 只留给非时间序列（期限结构、国债曲线、相关热力图、回测）。T 表 IV 微笑/期限走 `createOptionsChart`，浮窗用 React 叠在 LC 上（深色能看清即可）。格子小走势仍是手写 SVG。

报价中心、分时、快讯三个 hub 各自保留。`CockpitLayout` / `QuoteStockRow` 继续用。快讯只在资讯页 `/event` 看，全站不再弹窗。

东财 `push2` / `push2delay` 主机轮询只在东财挂了、有的格子活有的死时再动。

## 验分叉

改完按触及面跑，用「会不会再分叉」来验，不单验「函数返回了 dict」。

- 后端：`cd backend && python -m pytest -m "not live"`
- 前端：`cd frontend && npm test` 且 `npx tsc -b`
- 指数目录：`backend/tests/test_index_catalog.py` + `frontend/tests/review-context.test.mjs`
- 复盘对照昨日档：`backend/tests/test_review_archive_diff.py`（`need_two_runs` 的 changes 是 null，空列表只属于 `unchanged`；不进预热）+ `frontend/tests/review-context.test.mjs`（复盘页挂 `ReviewArchiveDiffBar`，不另开 snapshot）
- 衍生目录 / 期权驾驶舱导航：`backend/tests/test_deriv_catalog.py` + `frontend/tests/page-nav.test.mjs`（`/derivatives` 紧挨 `/a-share`，前后端同序同码）+ `frontend/tests/option-chart.test.mjs`
- 套利目录 / 套利驾驶舱：`backend/tests/test_arb_catalog.py`（前后端同序同码；`sh000016` 不进指数目录）+ `test_ovlab.py` arb-board（复用 future-ts，不打 market）+ `frontend/tests/page-nav.test.mjs`（`/arb` 紧挨 `/derivatives`，无 CTP）+ `frontend/tests/arb-chart.test.mjs` + `frontend/tests/lc-chart.test.mjs`
- 资讯：`backend/tests/test_event_cal.py`（一把 `event_cal` 钥匙、不进预热钟）+ `backend/tests/test_event_rank.py`（一把 `event_rank` 钥匙、四源解析、不进预热钟）+ `frontend/tests/page-nav.test.mjs`（`/event` 紧挨 `/arb`）+ `frontend/tests/event-page.test.mjs`（快讯走 telegraphHub，日历走 `api.eventCalendar`，热榜走 `api.eventRanks`）+ `frontend/tests/ai-watch-page.test.mjs`（`/ai-watch` 挂同一把 `event_rank/aihot`，`part=aihot`）
- 短线侠：`backend/tests/test_dxx.py`（一把 `dxx` 钥匙、不进预热钟）+ `frontend/tests/page-nav.test.mjs`（`/dxx` 紧挨 `/macro`，`/macro` 紧挨 `/event`）+ `frontend/tests/dxx-page.test.mjs`（一板 `api.dxxBoard`，不进报价中心）
- OpenVlab MQTT：`backend/tests/test_ovlab_mqtt.py`（sidecar 三条 topic / 解析 / 不写 `ovlab_flow_alert`；SSE `/mqtt/stream` 兜底）+ `frontend/tests/ovlab-mqtt.test.mjs`（网页 `mqtt.connect` / `wss://emqx.openvlab.cn/mqtt`）+ `frontend/tests/alert-panel.test.mjs`；live 连 broker 在 `test_live.py`
- 同花顺行情：`backend/tests/test_ths_quote.py`（市场码归位、pct 现算、缓存上一笔）+ `frontend/tests/ths-cmd-index.test.mjs`（驾驶舱指数 tab 走 `/api/ths`，不进指数目录/报价中心）
- 品种沉淀资金：`backend/tests/test_fut_spec.py`（公式、按月保证金、复用 `future-ts`、无手写 `SPEC`、不打 `future-ts-all`、不进预热钟）+ `backend/tests/test_qihuo_fee.py`（九期网表一把 `qihuo_fee` 钥匙、乘数反推、CZCE 三位码、不进预热钟）+ `frontend/tests/ths-cmd-index.test.mjs`（股指·商品列：期货走 `/api/ovlab/parked`，ETF 走已有 `etfSharesBatch` 份额×现价）
- 全球情绪：`backend/tests/test_fear_greed.py`（一份名单、模拟分丢掉、HTTP/问 AI 同一把 `fear_greed` 钥匙、不进预热钟）+ `frontend/tests/spark-axis.test.mjs`（涨跌分布格下部 / 美股页走 `api.fearGreed`，不进报价中心）
- 宏观 / CTFI：`backend/tests/test_ctfi.py`（官方页解析综合/CT1/CT2、一把 `ctfi` 钥匙、不进预热钟）+ `backend/tests/test_macro_board.py`（银行间/月度/美债解析、一把 `macro_board` 钥匙、不进预热钟/报价中心）+ `frontend/tests/macro-page.test.mjs`（`/macro` 走 `api.lpr` / `api.cnBondYield` treasury+policy / `api.macroBoard` / `api.ctfi` / `api.pbocSfin` / `api.nbsPmi`，LPR 折线走 lcChart；美元人民币只订 `whUSDCNY`；人行社融/统计局 PMI 不并进 `macro_board`；A 股资金页不再画利率）+ `frontend/tests/page-nav.test.mjs`
- a-stock-data 增量：`backend/tests/test_astock_research.py`（qfq 除法、筹码期初播种、北交所登录前拒绝、新浪 JSON 尾巴、社融 `2026.1`→10 月、统计局 PMI 解析、申万 as-of；HTTP 钥匙不进预热、不碰 `macro_board`）
- 报价中心：`frontend/tests/quote-hub.test.mjs`（K 线页 / 自选公告走 `useQuotes`；分时日K最后一根叠报价、分时静默续拉失败不盖加载失败；跑马灯在设置/回测/数据/研究退订）+ `backend/tests/test_clock_serve.py`（指数目录报价过期补腾讯）+ `backend/tests/test_light_kline_batch.py`（盘中指数分时 TTL 4s 过期重取；港股 15:00 last-good 不冻）
- 缓存键：预热填过 `world_indices` 后，`get_global_indices` 不再打上游；热槽过期仍读上一笔（`backend/tests/test_clock_serve.py`、`backend/tests/test_cache.py`）
- 标的池 / 横截面：`backend/tests/test_cross_section.py`（只有 `a-share-codes.json`；快照不写报价 5 秒缓存）
- 全 A 库存：`backend/tests/test_universe_sync.py`（补齐走 `ensure_bars`，已齐跳过，不进预热）
- 因子：`backend/tests/test_backtest_factor.py`（IC / 五档走日 K 面板，不建 enriched；周/月调仓是交易期末）
- 可交易掩码 / 日历加减：`backend/tests/test_backtest_screen.py` · `backend/tests/test_trading_calendar.py`（不引入 Omicron）
- 目标权重 / 模型：`backend/tests/test_backtest_matcher.py` · `backend/tests/test_backtest_model.py`（同一套撮合，不建 .db，不引入 quantide）
- 指数成分导入：`backend/tests/test_backtest_index_pool.py`（今日快照走 members/，fetch 可注入，不扫全 A）
- 按日成分 / 财务 PIT / 可交易基准：`backend/tests/test_backtest_pit.py`（调整公告可注入，不打中证/东财；没有快照时基准才用价格比）
