# 数据源端点目录(registry v1.0.0,共 117 个)

由 `datasources/gen_catalog.py` 从 `registry.json` 生成,勿手改。调用方式:`.venv/bin/python .agents/skills/data-access/scripts/fetch_endpoint.py --endpoint <id> --symbol <代码> [--args '<JSON>'] --out-dir <运行目录>`;legacy 端点为 Phase 0 的独立脚本。合规级:cn-public = 国内公开网页接口;S = 官方政府数据;B = 非官方 / 个人研究;C = 仅个人研究(CBOE 条款);rss-public = 公开 RSS。
symbol_kind:cn6 = A 股 6 位码;us = 美股 ticker;hk = 港股 5 位;global = 美股 / 港股自动判别;raw = 原样透传(指数 / 关键词 / 期权标的);none = 不需要标的。

## 6 基础数据(12)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_profile` | 公司概况(名称 / 上市日 / 行业 / 股本 / 市值) | CN | tencent+baostock | cn-public | cn6 | profile:required |  |
| `fetch_financials` | 季度报告期累计财务(营收 / 归母 / 扣非 / EPS) | CN | sina_abstract | cn-public | cn6 | financials:required | 关键 |
| `fetch_pe_history` | PE_TTM / PB 日频历史(5 年) | CN | baostock | cn-public | cn6 | valuation:optional |  |
| `em_stock_info` | 东财个股基本面(股本 / 市值 / 行业 / 上市日) | CN | eastmoney | cn-public | cn6 | profile:optional | 与 fetch_profile(腾讯 + baostock)交叉核对用 |
| `sina_income_statement` | 新浪财报三表 — 利润表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sina_balance_sheet` | 新浪财报三表 — 资产负债表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sina_cashflow` | 新浪财报三表 — 现金流量表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sw_industry` | 申万行业分类(当前归属 + 变迁史,消除前视偏差) | CN | swsresearch | cn-public | cn6 | profile:optional |  |
| `bs_valuation_history` | baostock 估值历史(PE/PB/PS/PCF + 换手 + 停牌 + ST,日频) | CN | baostock | cn-public | cn6 | valuation:optional | fetch_pe_history 已覆盖 PE/PB;本端点补 PS/PCF/换手/ST/停牌 |
| `bs_stock_basic` | baostock 标的基本信息(上市日 / 退市日 / 状态) | CN | baostock | cn-public | cn6 | profile:optional |  |
| `tdx_finance` | 通达信财务快照(37 字段季报) | CN | mootdx | cn-public | cn6 | - |  |
| `tdx_f10` | 通达信 F10 文本(公司概况 / 股东 / 股本 / 大事等 9 类) | CN | mootdx | cn-public | cn6 | - |  |

## 1 行情(11)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_quote` | 实时行情 / 估值快照(含僵尸报价判定) | CN | tencent | cn-public | cn6 | profile:required | 关键 |
| `fetch_trade_calendar` | 交易日历(参考报价日 / 盘前盘后) | CN | baostock | cn-public | none | profile:required |  |
| `fetch_kline` | 日 K 前复权序列 | CN | tencent | cn-public | cn6 | risk:optional |  |
| `tx_quote` | 腾讯实时行情(个股 / 指数 / ETF / 北交所,含僵尸报价判定) | CN | tencent | cn-public | raw | - | 指数 / ETF 请带前缀(sh000001 / sh510050);fetch_quote 仍是阶段必需的主行情脚本 |
| `tx_quotes_batch` | 腾讯批量行情(默认 A股四大指数 + 美股道指纳指 + 港股恒生与恒生科技) | CN/US/HK | tencent | cn-public | none | - |  |
| `baidu_kline_ma` | 百度股市通日 K(自带 MA5 / MA10 / MA20) | CN | baidu | cn-public | cn6 | - |  |
| `sina_adjust_factor` | 新浪复权因子(qfq / hfq) | CN | sina | cn-public | cn6 | - |  |
| `bs_kline_qfq` | baostock 前复权日 K(OHLC + 成交量 + 换手 + 停牌标记;供 calc 读 raw 算筹码 / 指标) | CN | baostock | cn-public | cn6 | risk:optional | raw 为 extracted JSON {query, rows:[{date,open,high,low,close,volume,turn,tradestatus}]};calc 用 history_json(rows_path=rows, where tradestatus=1)读取 |
| `tdx_bars` | 通达信 K 线(不复权,日 / 分钟) | CN | mootdx | cn-public | cn6 | - | 海外网络通常全部超时 |
| `tdx_quotes` | 通达信实时五档报价 | CN | mootdx | cn-public | cn6 | - |  |
| `tdx_transaction` | 通达信逐笔成交 | CN | mootdx | cn-public | cn6 | - |  |

## 2 研报(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_estimates` | 机构一致预期 EPS(FY T/T+1/T+2) | CN | ths | cn-public | cn6 | estimates:required | 关键 |
| `em_reports` | 个股研报列表(标题 / 机构 / 评级 / 三年 EPS 预测) | CN | eastmoney | cn-public | cn6 | estimates:optional, risk:optional | PDF 可由 infoCode 拼 pdf.dfcfw.com 下载;reportapi 只认 6 位码 |
| `em_industry_reports` | 行业研报列表 | CN | eastmoney | cn-public | none | - |  |
| `iwencai_search` | 问财 NL 语义搜索(研报 / 公告 / 新闻) | CN | iwencai | cn-public | none | - | env IWENCAI_API_KEY; 需 IWENCAI_API_KEY;--args {"query":"..."} |
| `iwencai_query` | 问财 NL 数据查询(结构化) | CN | iwencai | cn-public | none | - | env IWENCAI_API_KEY |

## 7 公告(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_announcements` | 公告标题(深交所 / 东财) | CN | szse+eastmoney | cn-public | cn6 | risk:optional |  |
| `cninfo_announcements` | 巨潮公告(全文检索,动态 orgId) | CN | cninfo | cn-public | cn6 | risk:optional |  |
| `exchange_announcements` | 公告备源(深市深交所 / 沪市北交所东财 np-anotice,带 PDF 直链) | CN | szse+eastmoney | cn-public | cn6 | - |  |

## 3 信号(10)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_concept_blocks` | 个股所属板块 / 概念归属 | CN | eastmoney | cn-public | cn6 | profile:optional |  |
| `em_fund_flow_minute` | 个股资金流(分钟级,当日) | CN | eastmoney | cn-public | cn6 | - | 盘中才有;ETF 不覆盖 |
| `em_dragon_tiger` | 个股龙虎榜(上榜记录 / 席位 / 机构) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_lockup_expiry` | 限售解禁(历史 + 未来 90 天) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_industry_comparison` | 行业板块涨跌排名 | CN | eastmoney | cn-public | none | - |  |
| `em_board_fund_flow` | 板块资金流向(行业 / 概念 / 地域 × 今日 / 5 日 / 10 日) | CN | eastmoney | cn-public | none | - |  |
| `em_daily_dragon_tiger` | 全市场龙虎榜 | CN | eastmoney | cn-public | none | - |  |
| `ths_hot_reason` | 同花顺当日强势股 + 题材归因 | CN | ths | cn-public | none | - | --args {"date":"YYYY-MM-DD"} |
| `ths_hsgt_realtime` | 沪深股通分钟累计净买入(亿元) | CN | ths | cn-public | none | - |  |
| `exchange_dragon_tiger` | 龙虎榜官方备源(深交所结构化 + 上交所全文) | CN | szse+sse | cn-public | none | - | --args {"trade_date":"YYYY-MM-DD"},默认北京时间当天 |

## 4 资金筹码(7)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_fund_flow_120d` | 个股资金流(日级 120 日) | CN | eastmoney | cn-public | cn6 | - | push2his 在部分网络(含本机)不通,失败属预期;备源见 fund_flow_backup |
| `em_margin_trading` | 融资融券明细(日级) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_block_trade` | 大宗交易 | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_holder_num` | 股东户数变化(季度) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_dividend_history` | 分红送转历史 | CN | eastmoney | cn-public | cn6 | valuation:optional |  |
| `sina_fund_flow` | 新浪个股资金流(日度,东财备源) | CN | sina | cn-public | cn6 | risk:optional |  |
| `bs_chip_distribution` | 筹码分布 CYQ(获利比例 / 平均成本 / 成本区间 / 集中度,前复权 + 换手衰减模型) | CN | baostock+calc | cn-public | cn6 | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算;不进研究阶段计划(计算型端点待迁 calc);仅供手工调用 |

## 5 新闻(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_stock_news` | 东财个股新闻 | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_global_news` | 东财全球财经资讯 7x24 | CN | eastmoney | cn-public | none | - |  |
| `cls_telegraph` | 财联社电报(全市场快讯) | CN | cls | cn-public | none | - |  |
| `rss_news` | RSS 新闻雷达(106 个 tier-1 策展源 × 12 行业,红线关键词标记) | CN/US/HK | rss(investment-news) | rss-public | none | - | --args {"industry":"semiconductor"} 或 {"sources":["OpenAI"]};行业 key 见 rss_sources.json |

## 8 打板(9)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_zt_pool` | 东财涨停池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_zb_pool` | 东财炸板池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_dt_pool` | 东财跌停池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_yzt_pool` | 东财昨日涨停池(今日表现) | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_limit_up_sentiment` | 打板三池计数(涨停 / 炸板 / 跌停;炸板率等由 calc 算) | CN | eastmoney | cn-public | none | - |  |
| `em_stock_monitor` | 东财重点监控池 | CN | eastmoney | cn-public | none | - |  |
| `em_price_anomaly` | 日内严重异常波动明细 | CN | eastmoney | cn-public | none | - |  |
| `em_price_anomaly_count` | 异常波动统计(按标的聚合) | CN | eastmoney | cn-public | none | - |  |
| `ths_limit_up_pool` | 同花顺涨停揭秘(原因题材 / 封板率 / 板型) | CN | ths | cn-public | none | - |  |

## 10 情绪(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_hot_rank` | 东财人气榜 | CN | eastmoney | cn-public | none | - |  |
| `em_hot_concept` | 个股热门概念命中 | CN | eastmoney | cn-public | cn6 | - |  |
| `ths_hot_list` | 同花顺热榜(人气 / 概念标签) | CN | ths | cn-public | none | - |  |
| `cninfo_irm` | 互动易问答(投资者提问 + 公司回复) | CN | cninfo | cn-public | cn6 | risk:optional |  |
| `em_turnover_rank` | 全市场成交额榜(沪深京 A 股) | SH/SZ/BJ | eastmoney | cn-public | none | - | 客观公开榜单(东财行情中心同款),只做客观展示 —— 非推荐、非预测、不评分。 |

## 9 期权(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sina_option_chain` | ETF 期权链(近月 T 型报价 + 希腊字母 + IV) | CN | sina | cn-public | raw | - | --symbol 510050/510300/588000/510500;--args {"side":"put","month":"YYMM"} |

## 11 宏观(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `pboc_social_financing` | 人民银行社会融资规模增量(月度) | CN | pbc.gov.cn | cn-public | none | - | --args {"year":2024};仅支持 2021 年起版式 |
| `nbs_pmi` | 国家统计局 PMI(制造业 / 非制造业 / 综合 + 大中小型) | CN | stats.gov.cn | cn-public | none | - |  |

## G1 行情(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `tx_us_quote` | 腾讯美股实时行情(71 字段) | US | tencent | cn-public | us | - |  |
| `sina_us_quote` | 新浪美股实时行情(36 字段) | US | sina | cn-public | us | - | market_cap 为新浪原值,单位以实测为准 |
| `tx_hk_quote` | 腾讯港股实时行情(78 字段) | HK | tencent | cn-public | hk | - |  |
| `sina_hk_quote` | 新浪港股实时行情(25 字段) | HK | sina | cn-public | hk | - |  |
| `em_global_quote` | 东财 push2 实时行情(美股 / 港股统一) | US/HK | eastmoney | cn-public | global | - |  |

## G2 K线(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sina_us_kline` | 新浪美股日 K(可回溯 1984) | US | sina | cn-public | us | - |  |
| `yahoo_kline` | Yahoo chart K 线(美股 / 港股,零 crumb) | US/HK | yahoo | B | global | - |  |

## G3 指标(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `indicators_cn` | 技术指标快照(A 股,baostock 前复权日 K → MA/EMA/MACD/RSI/KDJ/BOLL) | CN | calc(baostock) | cn-public | cn6 | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算;不进研究阶段计划(计算型端点待迁 calc);仅供手工调用 |
| `indicators_us` | 技术指标快照(美股,新浪日 K) | US | calc(sina) | cn-public | us | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算 |
| `indicators_hk` | 技术指标快照(港股,Yahoo 日 K) | HK | calc(yahoo) | B | hk | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算 |

## G4 财务(8)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_global_income` | 东财全球财报 — 利润表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | - |  |
| `em_global_balance` | 东财全球财报 — 资产负债表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | - |  |
| `em_global_cashflow` | 东财全球财报 — 现金流量表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | - |  |
| `em_global_key_indicators` | 东财关键财务指标(美股 49 列 / 港股 75 列) | US/HK | eastmoney | cn-public | global | - |  |
| `yahoo_key_statistics` | Yahoo 关键指标(PE/PB/EV/利润率/ROE/Beta/目标价) | US/HK | yahoo | B | global | - |  |
| `yahoo_analyst_estimates` | Yahoo 分析师预期(EPS 趋势 / 评级分布 / 升降级 / 财报惊喜) | US/HK | yahoo | B | global | - |  |
| `yahoo_institutional_holders` | Yahoo 机构持仓(前 10 + 内部人 / 机构占比) | US/HK | yahoo | B | global | - |  |
| `yahoo_financials` | Yahoo 财报三表(年度 / 季度;多数标的已下线,后备) | US/HK | yahoo | B | global | - |  |

## G5 资金(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_global_fund_flow` | 东财日级资金流(美股 / 港股) | US/HK | eastmoney | cn-public | global | - |  |

## G6 期权(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `cboe_options` | CBOE 官方延时期权链(按到期筛选 + 成交量前 N 合约;聚合留给 calc) | US | cboe | C | us | - | --args {"expiry":"0DTE"} 或 {"dte_max":7} |
| `cboe_quote` | CBOE 个股快照(含 IV30) | US | cboe | C | us | - |  |
| `yahoo_options` | Yahoo 期权链(后备,无希腊字母,仅美股) | US | yahoo | B | us | - |  |

## G7 SEC(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_ticker_cik` | SEC ticker → CIK | US | sec | S | us | - | env VRA_SEC_CONTACT |
| `sec_filings` | SEC 申报列表(10-K/10-Q/8-K/4/13F...) | US | sec | S | us | - | env VRA_SEC_CONTACT |
| `sec_xbrl_facts` | SEC XBRL 结构化财务(companyfacts,默认 10 个核心指标) | US | sec | S | us | - | env VRA_SEC_CONTACT |

## G10 申报流(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_daily_filings` | EDGAR 每日申报流(Form 4 / 8-K / 13F) | US | sec | S | none | - | env VRA_SEC_CONTACT |
| `sec_fulltext_search` | EDGAR 全文检索(2001 至今) | US | sec | S | raw | - | env VRA_SEC_CONTACT; --symbol '"HBM4"' |

## G11 横截面(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_market_frame` | EDGAR frames 全市场横截面(免费 screener) | US | sec | S | raw | - | env VRA_SEC_CONTACT; --symbol 净利润/NetIncomeLoss --args {"year":2025,"quarter":2} |

## G9 做空(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `finra_short_volume` | FINRA Reg SHO 单票日度空头成交占比 | US | finra | B | us | - |  |
| `finra_short_ranking` | FINRA 空头占比排行(最近一日全市场) | US | finra | B | none | - |  |

## G12 宏观(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `treasury_yield_curve` | 美债收益率曲线(财政部,每日 1M~30Y) | US | treasury.gov | S | none | - |  |
| `cftc_cot` | CFTC 持仓报告 COT | US | cftc | S | none | - | --args {"market_contains":"GOLD"} |
| `nasdaq_earnings_calendar` | Nasdaq 财报日历 | US | nasdaq | B | none | - |  |

## G8 工具(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_stock_search` | 东财全球股票搜索(代码 / 市场 / 中文名) | US/HK | eastmoney | cn-public | raw | - |  |
| `em_market_list` | 东财全市场列表(NASDAQ / NYSE / 美股 ETF / 港股 排名) | US/HK | eastmoney | cn-public | none | - |  |
| `yahoo_news` | Yahoo Finance 新闻搜索 | US/HK | yahoo | B | raw | - |  |

## 12 市场声音(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `exa_market_voice` | 市场声音 · 全网语义搜索(Exa 免 key MCP):新闻 / 深度文 / KOL 帖,按主题分组,前 N 条读摘录 | CN | exa-mcp | web-search-free(mcp.exa.ai,无 key;结果为公开网页索引,只作线索) | cn6 | risk:optional | 查询词由模块按公司名确定性生成(业绩进展 / 风险 / 行业竞争 / 英文分析师);标题与摘录经 textsafe 脱敏(动作词替换、控制字符剥离、截断),原文在 raw;数字不可作事实引用 |
| `exa_forum_voice` | 市场声音 · 雪球 / 股吧讨论(经 Exa 索引,只取标题 / 作者 / 日期 / 链接;正文受 WAF 限制不可读) | CN | exa-mcp | web-search-free(mcp.exa.ai,无 key;雪球 / 股吧页面本身受 WAF,只用索引元数据) | cn6 | risk:optional | 雪球 / 股吧匿名直连被阿里云 WAF 拦截(2026-08-23 实测),Jina 读帖子正文也被 IP 频繁墙挡;本端点只提供讨论的存在性与热度线索 |

## 13 产业温度计(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `tw_monthly_revenue` | 产业温度计 · 台系供应链月营收(FinMind 零鉴权):台光 / 台燿 / 金像电 / 联亚,环比 · 同比 · 累计同比 · 台光×金像电差分 | CN | finmind | public-api-free(api.finmindtrade.com,无 key;台股法定月营收) | none | risk:optional | 每月 10 日前披露、滞后 ~10 天;402 = 配额 / 限流必须出声;资料期 > 2 个月标 partial;证据 market=TW / symbol=台股代码,币种 TWD。读法护栏在 note 与 extra.guard;history_fields=月营收 / 环比 / 同比进用户数据区序列,下次运行出 _prev / _change_*(累计同比与差分文本不做历史) |
| `gpu_rent_thermometer` | 产业温度计 · GPU 租金(近一年逐日中位 + 现货 + Kalshi 远期概率):算力缺不缺的一根线 | CN | 500farm+kalshi | public-api-free(500.farm Prometheus 代理 + api.elections.kalshi.com trade-api v2,无 key) | none | risk:optional | 曲线 = 500.farm 对 Vast 可租挂单的逐日中位(按机型档位分组统计后聚合,**不是**逐张挂单精确中位);🔴 现货 = 曲线的最新采样点,同源同算法 ⇒ 卡片数字与曲线末端严格一致(旧版现货走 Vast bundles,与曲线对不上且只有两张卡);型号名用统计站 label 原文(H100 SXM / A100 SXM4,写错只会安静返回空序列);Prometheus 空窗会给 NaN/Inf,必须丢弃(进 JSON 会让整条端点失败);挂单卡数是规模读数不是信号本体,拿不到给 None 不算失败;Kalshi 三分判定(格式变 / 未开盘 / 有报价);$3 是折旧参考线不是保本线;证据 market=US / symbol=GPU 型号;曲线走 extra(序列不是证据) |
| `cn_commodity_futures` | 产业温度计 · 上游大宗期货(新浪连续合约:沪铜 / 沪锡 / 沪铝 / 沪镍 / 工业硅) | CN | sina_futures | public-api-free(akshare futures_zh_daily_sina,无 key) | none | risk:optional | 全市场证据 → symbol=MARKET / record_key=品种代码;期货价不是本公司采购价(护栏原样进 note);工业硅需求由光伏主导对半导体是弱信号;资料超 10 天未更新标 stale 并降 partial;逐品种隔离失败,全失败才抛;DataFrame 非传输层原文 → record_raw(kind=extracted) |
| `dram_spot_thermo` | 产业温度计 · DRAM / NAND 现货均价(GitHub 社区仓转录的 DRAMeXchange) | CN | github-community | public-repo-free(raw.githubusercontent.com,无 key) | none | risk:optional | 🔴 社区转录的 DRAMeXchange 存档不是官方一手(可能有转录误差与停更),护栏必须原样带出;DRAM 现货是 HBM 的影子指标不是 HBM 价格(HBM 走年度长约无公开现货价);ddr5 序列无 product 字段 → 规格如实写"未在数据中标明";全市场证据 symbol=MARKET / record_key=品类;超 14 天标 stale 降 partial |

## 14 管制与准入(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `policy_access` | 管制与准入 · 美方名单状态(1260H 全文检索 / BIS 规则提及 / FCC Covered List)+ 中方出口管制公告事件流 | CN | federalregister+cninfo+fcc+mofcom | public-api-free(federalregister.gov API / cninfo companyOverview / fcc.gov 与 mofcom 经 r.jina.ai 免 key) | cn6 | risk:optional | 判定以联邦公报通知全文检索公司英文名为准;无英文名 = undetermined(≠ not_on_list);没被点名 ≠ 不受影响;'被建议列入' ≠ '已列入';中方侧默认不接(商务部公告列表 JS 渲染零配置抓不到,证据里给 not_connected 护栏)。移植自 V2 policy_access.py |

## 15 数据日历(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `next_disclosure` | 数据日历 · 本公司下一份定期报告的预约披露日(东财 RPT_PUBLIC_BS_APPOIN) | CN | eastmoney | public-api-free(datacenter-web.eastmoney.com,无 key) | cn6 | risk:optional | 预约日可能提前或推迟,以公司公告为准;过了预约日仍未披露=延期信号;result=null 是真实状态(无记录)不是故障;成功但一行都解析不出=结构变了必须抛 |
| `us_anchor_earnings` | 数据日历 · 美股锚下一个财报日(Nasdaq analyst/{ticker}/earnings-date,默认 NVDA) | CN | nasdaq | public-api-free(api.nasdaq.com,无 key;主机限流 2/s) | none | risk:optional | 文案带 * / expected = 交易所与 Zacks 预估日,不是公司确认日,证据 note 必须写明;逐 ticker 隔离失败;解析不出日期=结构变了必须抛;证据 market=US / record_key=ticker |

## 16 海外头条(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `techmeme_headlines` | 海外科技头条 · Techmeme river 时间流(按产业标签标注相关性) | CN | techmeme | public-free(www.techmeme.com/river,无 key) | none | risk:optional | 🔴 不可信文本:标题里的数字不得写成事实,动作措辞经 textsafe 脱敏,链接只进附录;相关性来自 industry_tags.json 的 headline_keywords(不硬编码个人关键词表),关键词为空 = 未标注(unscored)≠ 不相关;river 解析 0 条 = 结构变了 → 回退 RSS 但必须出声(只有约 15 条,窗口不完整);无时间戳条目丢弃不猜;窗口内零条是真实状态(凌晨 / 假日)标 partial 不算故障 |

## 17 招聘信号(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `hiring_anchor_signal` | 招聘信号 · 产业锚点公司公开在招岗位(Greenhouse / Ashby 零鉴权) | CN | ats-public | public-api-free(boards-api.greenhouse.io / api.ashbyhq.com,无 key;只读公开岗位不碰简历) | none | risk:optional | 锚点清单在 industry_tags.json 的 hiring_anchors(与温度计同一处配置);⛔ Workday 系(NVIDIA/Coherent/Lumentum/Marvell/Micron)需 host+tenant+site 非零配置,不收、如实写未接入;岗位数是招聘意图不是产能,只在同一公司内部比变化;全市场证据 symbol=MARKET / record_key=ats:slug;逐家隔离失败,全失败才抛;解析不出 jobs 数组=结构变了必须抛 |

## 18 宏观概率(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `macro_probability` | 宏观概率 · 预测市场对宏观事件的定价概率(Kalshi + Polymarket,零鉴权) | CN/US/HK | prediction-markets(kalshi+polymarket) | public-api-free(api.elections.kalshi.com / gamma-api.polymarket.com,无 key;只读公开行情,不下单不涉资金) | none | risk:optional | 移植自 simonlin1212/GlobalPercent 的模块分类器与取数形态。只收 6 个核心模块(货币政策 / 宏观经济 / 地缘政治 / 政治选举 / 股指大宗 / AI科技),参考类(加密 / 体育 / 娱乐 / 其他)丢弃;每模块取前 3(排序键 = max(24h 成交量, 未平仓量) —— 月度宏观合约典型是持仓大、当日安静,只看当日量会被冷门合约挤掉)。**近端允许安静、远期必须有 24h 成交量** —— 纯日期窗口会误杀有意义的远期宏观合约(实测「Recession in 2027?」有真实成交却结算在 500 多天后),纯流动性又留不住 2099 年的僵尸盘。⚠️ 这是**市场当前的定价预期,不是事实也不是预测**,概率随时在变、只在 as_of 那一刻成立;低成交量合约噪音极大。⚠️ Kalshi 的成交量字段是 volume_24h_fp / volume_fp(不是 volume_24h),且服务端**忽略 category 查询参数**,只能翻页后本地分类。 |
