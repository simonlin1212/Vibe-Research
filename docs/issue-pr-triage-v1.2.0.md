# v1.2.0 Issue / PR 处理记录

2026-09-09 实查 `simonlin1212/Vibe-Research`：2 个开放 Issue、6 个开放 PR。
基线 main = `f15ab898dc5d9a900d5f78ac864e7730f2f114bc`，与公开 v1.1.0 相同。
本次为源码修复与客户端撤回，不把未发布的 M41 动态板块带入，也不直接合并混有其他功能的 PR。

| 项目 | 核对结果 | 本次处理 |
|---|---|---|
| [Issue #48](https://github.com/simonlin1212/Vibe-Research/issues/48) Mac API 保存后消失 | 共享设置页以可编辑模型名恢复预设，导致自定义模型无对应选项，或同名模型被误识别为其他来源 | 修复来源与模型共同匹配；保存后回读确认，不把静默写入失败报成功。旧 Mac 存储故障未完整复现，不宣称旧安装包已修复 |
| [PR #42](https://github.com/simonlin1212/Vibe-Research/pull/42) 中间计算数值误拦 | 输入和 details 中的合法舍入、单位换算可能被拒 | 适配该贡献及回归用例，限制小数容差；不放宽 output.value 的 display 规则 |
| [PR #45](https://github.com/simonlin1212/Vibe-Research/pull/45) calcs 缺字段崩溃 | 当前 validateStage 已先验证计算记录形状并返回带文件名的错误，再访问 output.status | 已有回归覆盖；不采用直接跳过无 calculation_id / output 文件的写法，避免坏产物被静默忽略 |
| [PR #47](https://github.com/simonlin1212/Vibe-Research/pull/47) 报告阅读与删除 | 现有 ResearchReport 已支持 GFM 表格、引用跳转和安全链接；PR 还夹带 #46 等改动 | 保留现有阅读器，不进行会改写引用目标的全文正则替换。删除运行记录是新增破坏性功能，需独立设计活跃任务与跨站保护，不在本版加入 |
| [PR #43](https://github.com/simonlin1212/Vibe-Research/pull/43) 新闻备用通道 | 备用 AkShare 实现仍请求同一东财端点；当前安装的实现无请求超时且含过时硬编码 Cookie。PR 两路异常均吞成空数组，备用数据还可能沿用第一次请求的 raw_ref | 暂缓该实现，保留当前失败信号；不把同源重试宣传成独立信源容灾，也不声称本版解决了所有新闻源不可用问题 |
| [PR #46](https://github.com/simonlin1212/Vibe-Research/pull/46) 阶段恢复与校验改造 | 包含文件 mtime 重置停止预算、最终阶段反向恢复先前失败、HTTP 接入放宽等跨边界改动 | 不合入这套恢复机制；避免新增任意文件延长循环或让后阶段补文件覆盖前阶段失败。沿用原有有界重试与阶段所有权，未宣称所有长任务均已修复 |
| [Issue #41](https://github.com/simonlin1212/Vibe-Research/issues/41) GPU 一年历史增量库 | 需求是完整历史下载、每日增量合并、坏文件与失败保护；已有温度计观测归档不等于该能力 | 新功能暂缓，需要独立数据契约和持久化验收，不在撤客户端版临时加入 |
| [PR #37](https://github.com/simonlin1212/Vibe-Research/pull/37) Docker 部署 | 新部署方式包含公网端口映射、代理补 token 并改 Origin、个人登录目录挂载建议及过宽 Markdown 排除 | 暂缓；当前仍以源码本机运行为交付。需独立验证同源边界、指令资产与账号隔离后再考虑 |

## 验证范围

- #42 新增回归先失败，再修复后通过；包含 27.30 不能错误接受 27.35，以及舍入、亿元换算和百分比的合法例子。
- #48 使用合成测试配置，不读取客户 key、不调用真实模型。存储回读与预设匹配单元测试、浏览器实际页面恢复分别验证；不把它等同于供应商连接实测。
- 保留原版本安全与金融校验，撤回 Mac 专属实现，继续保留通用运行环境测试。
- 后端 Node 26 串行全套：853 项，852 通过、1 项 Windows ACL 在 macOS 跳过；前端 84/84、前后端类型检查和生产构建通过（原有大分块警告保留）。Python 计算库、回测和数据脚本 754/754。
- 真实 Chrome + 当前源码 API/Vite：18/18，包含健康接口版本 1.2.0、两种自定义模型刷新/栏目往返后预设、模型、地址和测试密钥保持。独立空白数据区，未调用真实模型；合成浏览器配置验证后清除。
- Gitleaks 当前候选 510 个文件及 HEAD 各 20 个命中：18 个测试串、1 个兼容矩阵口令、1 个公开查询参数，逐路径/行号/规则对照既有核实清单一致；全 Git 引用历史 23 个命中亦一致，无新增。GitHub Secret Scanning 与 Push Protection 已开启，开放告警 0。私有数据、登录态、回退备份和测试产物均在忽略区，不进入提交。
- 未重跑真实模型、全部外部取数端点或 Windows 实机；远端 CI 只在推送候选提交后产生，不把本机通过当成远端结果。

本轮只移植核实后的适用修复；未关闭 Issue、未合并或关闭远程 PR，未新增 Release、未删除旧安装附件。

## 独立审查与依赖补丁

Codex CLI / GPT-5.6 Sol 首轮发现 1 项 P1：details 中的嵌套计算结果也会进入新放宽的小数池。
审查举例中的“年”已有单位保护，但改用嵌套 PE 结果后实际红测复现；现按 resultProjection 的同一形状判据
排除结果形对象的 value，保留真实中间量。34 项数值回归通过，第二轮独立审查无可操作 P1/P2。
不把审查结论等同于金融结果正确或全供应商实测。

依赖审计发现 MCP 间接依赖 Hono 4.13.3 的中等级别告警，锁文件仅升级该包至 4.13.5，
版本、下载地址及完整性值核对 npm 官方元数据；不升级 MCP SDK 和 Codex 引擎。
依赖补丁独立复审无可操作 P1/P2；重新安装锁定依赖后完整后端及类型检查通过，前后端生产依赖审计均为 0 告警。
公告：[静态生成路径处理](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv)、
[表单嵌套](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)、
[查询解析](https://github.com/advisories/GHSA-crvj-82cr-hjcx)。这是依赖告警修复，不表示已经证明产品存在上述全部利用路径。
