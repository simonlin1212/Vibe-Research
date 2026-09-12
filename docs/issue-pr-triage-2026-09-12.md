# Issue / PR 处理记录（2026-09-12）

本次在 v1.2.0 后的主分支上增量修复，不改动现有版本标签或新建 Release。

| 条目 | 处理 |
|---|---|
| [#42](https://github.com/simonlin1212/Vibe-Research/pull/42) 数字引用校验 | v1.2.0 已适配，说明后关闭，保留贡献致谢。 |
| [#45](https://github.com/simonlin1212/Vibe-Research/pull/45) 计算记录缺字段 | 主分支已先检查记录契约再访问字段，说明后关闭；不采用静默跳过坏记录。 |
| [#43](https://github.com/simonlin1212/Vibe-Research/pull/43) 新闻备用请求 | 参考贡献与 AkShare 请求形态，采用下面的有界、可追溯实现，未直接合并原 PR。 |
| [#46](https://github.com/simonlin1212/Vibe-Research/pull/46) 阶段恢复 | 已回复，等待最小复现和拆分；未把文件修改时间视为有效计算进展，未放宽 HTTP 接入策略。 |
| [#47](https://github.com/simonlin1212/Vibe-Research/pull/47) 报告渲染与删除 | 已回复，保留现有阅读器；请把归档删除拆分并补足活跃记录、坏清单保护。 |
| [#37](https://github.com/simonlin1212/Vibe-Research/pull/37) Docker | 当前实现未通过访问控制、指令资产和登录隔离审查，说明后关闭。 |
| [#48](https://github.com/simonlin1212/Vibe-Research/issues/48) API 保存 | 保持开放，等待报告者重测；不宣称旧安装包问题已完整复现。 |
| [#41](https://github.com/simonlin1212/Vibe-Research/issues/41) GPU 历史库 | 保留功能需求，尚未实现。 |

## 新闻取数行为

- 主 JSONP 请求取得有效新闻时直接返回；失败或明确返回空列表时，使用浏览器 callback、缓存参数及 Referer 再请求一次。
- 使用现有 HTTP 捕获层，每次网络请求带 15 秒超时，沿用其限流和代理连接回退。15 秒不是整个端点的总耗时承诺。
- 参考 AkShare `stock_news_em` 的请求形态和文章编号构造链接；不直接调用缺少超时的 SDK 函数，也不复制其固定 Cookie。
- 两路仍是同一东财数据源。备用成功时返回 `partial` 并说明降级，不宣称独立信源容灾或一定能解决反爬。
- 仅两次均成功解析出明确空列表时，说明“本次搜索未返回条目”。任一路失败且最终没有新闻时显式失败，不推断公司没有新闻。
- 每条新闻的 `raw_ref` 来自提供该条目的响应；不沿用第一次请求或无关上下文的引用。标题或日期缺失、返回结构异常时不伪造内容或当前日期。

## 验证

- 新增 17 项故障与边界回归：改动前全部失败，修复后通过；相关数据源及注册表测试共 31 项通过。
- Python 计算、回测和数据层全套 771 项通过；随后增加的 3 项真实取数入口离线测试也通过，新文件共 20 项通过。覆盖 `ok / partial / failed` 的退出码、落盘信封及原始响应文件。
- 本机联网：同一测试标的的主请求、备用请求分别返回 10 条，文章链接与响应引用均完整。另经完整取数入口检查正常场景，以及“注入主请求超时、备用请求真实联网”的降级场景；后者包含模拟故障，不能称为真实发生的反爬故障复现。
- Codex CLI / GPT-5.3 Codex Spark 独立静态审查：`No actionable findings`。未调用 WorkBuddy、未运行金融研究模型任务。
- 隐私扫描：当前候选与 HEAD 各 20 个既有命中，逐项内容一致；完整引用历史 23 个既有命中，为测试串、兼容探针及公开查询参数，无新增。GitHub Secret Scanning 与 Push Protection 开启，开放告警为 0。
- 未声称全部外部取数源、客户机器、Windows 实机或完整投研业务已重新验收。远端 CI 状态以本次提交对应的 Actions 为准。
