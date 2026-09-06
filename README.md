<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>

<h1 align="center">Vibe Research</h1>

<p align="center">
  <b>接入自己的 AI，默认直接使用本地金融研究 Agent</b><br>
  Codex / Claude Code / WorkBuddy 订阅或模型 API 一次接入 · Agent 默认开启 · 已验证 API 可切换模型直连
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.4-F35D2B">
  <img alt="UI" src="https://img.shields.io/badge/UI-React%20%2B%20Vite-646cff">
  <img alt="Orchestrator tests" src="https://img.shields.io/badge/orchestrator-797%20passed-passing">
  <img alt="Desktop tests" src="https://img.shields.io/badge/desktop-54%20tests-passing">
  <img alt="Codex Harness" src="https://img.shields.io/badge/runtime-Codex%20Harness-black">
</p>

<p align="center">
  <a href="https://viberesearch.wiki">官方网站</a> ·
  <a href="#这是什么">这是什么</a> ·
  <a href="#功能">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#模型接入">模型接入</a> ·
  <a href="#数据与市场">数据</a> ·
  <a href="#安全与隐私">安全</a> ·
  <a href="#开发与测试">开发</a> ·
  <a href="#当前边界">边界</a> ·
  <a href="CHANGELOG.md">CHANGELOG</a>
</p>

---

## 作者正在寻找工作机会

作者目前关注腾讯等大型科技企业在深圳的 AI 相关岗位，希望加入一支热爱 AI 开发的团队，继续从事 AI / Agent 产品开发、应用落地及 AI 咨询工作。

联系：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)

---

## 这是什么

此开发分支已同步 v1.0.4 基线及后继 Issue/PR 修复，另含尚未发布的双引擎改动；版本徽章不代表开发分支已发布。

Vibe Research 是一个**本地金融研究工作台**。第一次打开时只需要决定 AI 从哪里来：使用已经登录的
Codex / Claude Code / WorkBuddy（CodeBuddy）订阅，或者填写自己的模型 API。连接成功后，Vibe Research Agent 默认开启，普通
使用者不需要再理解 Harness、脚本或路由模式。

Agent 模式会在本机维持上下文、调用工具、推进任务、处理失败并保存研究过程。Codex 订阅由
[OpenAI Codex Harness](https://developers.openai.com/blog/codex-as-a-platform) 承载；Claude.ai 订阅由
本机 Claude Code Agent 承载；WorkBuddy / CodeBuddy 账号由腾讯官方 CodeBuddy Code CLI 承载。Vibe Research 在这些运行时之上统一叠加金融数据、研究 SOP、确定性计算、
证据校验和合规边界。

Claude Code 与 WorkBuddy / CodeBuddy Agent 除了对话和有界材料任务，也已接通辩论、Agent 回测、
截图／表格资料转写和完整 A 股六阶段研究。
研究阶段关闭它们的内建工具，只开放 Vibe Research 的五个受控 MCP 工具；不会暗中换成 Codex。

API 用户还可以在设置里关闭 Agent，改成模型直连。这个开关只对通过直连能力验证的 provider 开放：

| Agent 模式（默认、推荐） | 模型直连模式 |
|---|---|
| 维持上下文和任务状态 | 每次请求独立完成 |
| 可调用本地数据、计算和研究工具 | 不调用 Agent 工具 |
| 支持六阶段研究、辩论和 Agent 回测 | 适合轻量对话、翻译和材料定位 |
| 保留进度、证据链、报告与失败状态 | 不保留 Agent 任务记忆 |
| 订阅或 API 都可作为推理来源 | 只支持已验证的 API provider |

当前订阅入口已接通 Codex、Claude Code 与 WorkBuddy / CodeBuddy，设置页会实时检测 CLI、版本与登录状态。
CodeBuddy 适配器复用本机已登录账号：普通对话关闭全部工具与 MCP，六阶段研究关闭内建工具、只开放产品受控 MCP，
同时隔离用户配置、自动记忆和会话落盘。
Qwen Code 与 DeepSeek CLI 当前仍需各自的 API key，也归入 API 接入。

## 功能

| 模块 | 当前能力 |
|---|---|
| 首页 Agent | 普通对话，以及今日复盘、公司研究、已有研报三个受控入口；进入页面后确认执行 |
| 每日复盘 | 汇总市场、热点、涨停原因和当日线索 |
| 资讯雷达 | Investment News 标题翻译、公开新闻、A 股公告和事件概率 |
| 产业信号 | GPU 租金、月频产业数据、原材料、招聘和数据日历 |
| 板块中心 | 查看板块表现并下钻到具体产业方向 |
| 个股研究 | A 股六阶段研究：公司画像、财务、一致预期、估值、风险、报告 |
| 我的研报 | 本地保存 PDF、DOCX、TXT、MD、CSV；抽取、检索、引用、下载和删除 |
| 回测 | 只提供 Agent 对话入口；信息不足时补问，齐备后调用真实回测工具 |
| 多空辩论 | 多方、空方、反驳与中立主持共用同一份真实资料包 |
| 自选股与持仓 | A 股、美股和港股代码识别、本地保存与行情刷新；截图／表格生成草稿，人工核对后填写并确认保存 |
| 研究记录 | 保存研究、回测和辩论报告，可搜索、按时间查看和删除 |
| 接入 AI | 第一步连接订阅或模型 API；第二张卡显示 Agent 开关，默认开启并全站生效 |

### 研究结果不是一段无法复核的文字

六阶段研究会产出：

- `report.md`：最终研究报告。
- `evidence.json`：本轮使用的证据，每条保留来源、资料期和原文引用。
- `calculations.json`：派生数字的输入、函数和计算 DAG。
- `conflicts.json`：跨来源冲突，不静默取舍。
- `manifest.json`：模型、版本、阶段、状态、资料召回和运行清单。
- `viewer.html`：可在浏览器查看证据与报告。

任何关键数据拿不到，状态都会变成 `incomplete` 或 `failed`，不会用旧值或猜测填空。

研究运行中可请求中止，刷新页面后也能继续查看状态；此前已完成的阶段会保留。
发出请求不代表后台已停止，页面会区分停止请求、停止确认与无法确认的失败状态。
持仓导入只生成草稿，不自动写入台账；选定的图片或表格内容会发送给当前 AI 来源，提交前请移除无关敏感信息。

## 快速开始

### 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 11、macOS 或 Linux；Windows 原生运行，不要求 WSL |
| Node.js | ≥ 22.18，推荐 24 LTS |
| Python | ≥ 3.11，推荐并已验证 3.12 |
| Agent 引擎 | Codex Harness 随依赖安装，已验证 0.149.0；用户无需另装全局 Codex |
| 模型 | Codex / Claude Code / WorkBuddy 订阅登录，或兼容所选执行方式的模型 API |

> Node 必须是启用了 TypeScript 支持的构建（nodejs.org 官方安装包、nvm / fnm / Volta 装的都是）：`node -p process.features.typescript` 应输出 `strip` 或 `transform`。部分 Linux 发行版仓库打包的 Node 编译时关闭了这一项，启动或跑测试会报 `ERR_UNKNOWN_FILE_EXTENSION ".ts"` / `ERR_NO_TYPESCRIPT`，请换官方构建。`npm test` 前会先做这项检查并给出同样的提示。

### 安装依赖

Windows（PowerShell / CMD）：

```bat
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent
scripts\setup-windows.cmd
scripts\start.cmd
```

`setup-windows.cmd` 会创建 `.venv`、安装 Node/Python 依赖、初始化产品私有目录并运行体检；
`start.cmd` 会启动本地 API、浏览器 UI 并打开 `http://127.0.0.1:5930`。

macOS / Linux：

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent
scripts/setup
scripts/start
```

`scripts/setup` 会创建 `.venv`、安装本产品自带的 Agent 引擎与 Node/Python 依赖、初始化私有目录并运行
体检；`scripts/start` 会检查安装状态和端口，同时启动两端，确认都可用后才打开浏览器。无需全局安装 Codex，
也无需打开两个终端。

### 连接 AI

第一次打开任意功能都会进入“接入 AI”。只需先选一种来源并测试保存；连接成功后 Agent 自动开启，
之后不必重复选择。API 通过直连能力验证后，才会允许在第二张卡里关闭 Agent。

使用 ChatGPT 订阅：启动界面后进入“接入 AI”→“订阅接入”，点击“登录 Codex”，在自动打开的
OpenAI 官方页面完成授权；页面自动识别登录结果后，点击“测试并保存”。产品使用独立的
`.local/codex-home`，不会读取或覆盖用户的 `~/.codex`。授权页没有自动打开时，回到设置页重新点击
“登录 Codex”；本地状态仍不明确时运行 `scripts/doctor`（Windows 为 `scripts\doctor.ps1`）查看修复提示。

使用 Claude.ai 订阅：先安装并登录 Claude Code；设置页会自动检测，不需要把 Claude 的 key 填进产品。

使用 WorkBuddy / CodeBuddy：如果电脑已经安装并登录 WorkBuddy 桌面版，设置页会直接识别它自带的官方
CodeBuddy Code CLI，不需要重复安装或登录。没有桌面版时，也可以运行
`npm install -g @tencent-ai/codebuddy-code` 安装腾讯官方 CLI，再运行 `codebuddy` 登录。两种方式都不需要
把账号 token 或 API key 填进产品。

API 接入：进入“接入 AI”→“API 接入”，选择供应商并填写 API 地址、模型名和 key，再点击
“测试并保存”。系统先发起一次真实模型对话，成功才保存并供全站使用；同时会记录该 provider 是否通过
模型直连能力验证。出现“请先到接入 AI 重新连接”时，表示本机登录态已失效，不是研究或回测逻辑失败。

### 启动浏览器 UI

Windows 运行 `scripts\start.cmd`，macOS / Linux 运行 `scripts/start`。两者都会同时管理本机 API 与界面，
浏览器地址为 [http://127.0.0.1:5930](http://127.0.0.1:5930)。macOS / Linux 如不想自动打开浏览器，
可运行 `scripts/start --no-open`；按 Ctrl+C 会同时关闭两端。

Vite 只在本机代理 `/api/*`，并在服务端补上鉴权信息。若设置了 `VRA_DATA_ROOT`，两个进程必须使用
同一个值。

### 命令行运行一次研究

Windows PowerShell：

```powershell
node orchestrator/src/run.ts `
  --symbol 300308 `
  --market SZ `
  --python "$PWD\.venv\Scripts\python.exe"
```

Windows 会自动使用 `controlled_mcp` 执行层：研究线程没有 Shell、没有写目录权限，只能通过受控工具读取
净化后的运行文件、调用确定性计算并写当前阶段产物。macOS / Linux 继续使用既有 hooks 执行层。

macOS / Linux：

```bash
node orchestrator/src/run.ts \
  --symbol 300308 \
  --market SZ \
  --python "$(pwd)/.venv/bin/python" < /dev/null
```

完整研究通常需要 15–19 分钟。进度会持续显示，结果写入 `.local/runs/<run-id>/`。
退出码：`0` complete、`2` incomplete/stale、`3` failed。

## 工作方式

```text
浏览器工作台
首页 Agent · 复盘 · 资讯 · 个股研究 · 回测 · 资料库
        │
        ▼
金融 Agent 层
117 个数据端点 · 六阶段 SOP · calc · validator · report archive
        │
        ▼
OpenAI Codex Harness
agent loop · context · tools · progress · sandbox
        │
        ▼
Local Agent Runtime
Codex SDK · Claude Code CLI · CodeBuddy Code CLI（本机检测 / 登录探针 / 受限执行）
        │
        ▼
Model Provider
ChatGPT / Claude.ai / WorkBuddy 订阅 · OpenAI · DeepSeek · Qwen · GLM · Kimi · MiMo · compatible API
```

三级约束不会只依赖提示词：

| 层 | 组成 | 作用 |
|---|---|---|
| 提示层 | `AGENTS.md` + `.agents/skills/` | 定义金融研究纪律与 SOP |
| 执行层 | Codex hooks + workspace sandbox | 限制联网、文件访问、取数和产物范围 |
| 编排层 | orchestrator + validator + calc + gate | 强制阶段、证据引用、确定性计算和合规边界 |

项目不修改 Codex 源码。Codex 仓库只作上游参考，产品通过官方 CLI 与 SDK 使用 Harness。

## 模型接入

“接入 AI”在界面上按两个问题分开：先选 AI 来源，再决定是否使用 Agent。第二步默认已经替使用者选好
“开启”，只有明确想做轻量直连的 API 用户才需要改。

- Agent Runtime 负责本地上下文、工具调用、任务状态、进度和失败处理。Codex 订阅走 Codex Harness；Claude 订阅走 Claude Code Agent；WorkBuddy / CodeBuddy 走 CodeBuddy Code Agent，三者不会混叫。
- Claude Code 与 WorkBuddy / CodeBuddy Agent 可运行完整 A 股六阶段研究；每个阶段使用一次独立会话，只能调用 Vibe Research 的受控 MCP，不会暗中换成 Codex。
- AI 来源可以是订阅登录，也可以是用户自己的 Model Provider API。换来源不会自动关闭 Agent。
- 模型直连不运行 Agent、不调用工具，也没有 Agent 任务记忆；六阶段研究、多空辩论和 Agent 回测会明确提示重新开启 Agent，不会静默降级。
- Codex 订阅使用产品自己的 `CODEX_HOME`，不读写用户的 `~/.codex`；Claude 与 CodeBuddy 订阅复用各自本机登录态。普通对话关闭全部工具与 MCP；六阶段研究关闭内建工具，只开放产品受控 MCP。用户配置与自动记忆保持关闭。WorkBuddy 自带的旧 CLI 若没有“禁止会话落盘”参数，整次回答会改在一次性临时用户目录运行，结束后删除。
- 无论订阅或 API，点击“测试并保存”都会先做一次真实对话探针；探针失败不覆盖当前已生效配置。
- API 模式的 key 会持久保存在当前浏览器的本机 `localStorage`，方便下次直接使用；它不是系统钥匙串，
  也不承诺加密，只建议在可信个人电脑使用。key 随请求交给本机后端，但不进入仓库、后端配置、运行账本
  或日志；共享电脑用完请主动清除。

内置 provider 模板：OpenAI、DeepSeek、Qwen、GLM、Kimi、MiMo，以及未实测的 `selfhosted` 自托管占位模板。Agent 引擎只支持 Responses API；
直连通道使用 provider 模板中单独声明并验证的协议。模板存在不等于已经通过兼容矩阵，界面会区分
“已实测”和“有模板、未实测”，未验证时不会开放直连开关。

详细说明见 [docs/model-access.md](docs/model-access.md) 和 [providers/README.md](providers/README.md)。

局域网访问为可选功能，默认关闭。从仓库根启动：`VRA_LAN=1 bash scripts/start`；Windows PowerShell
先设置 `$env:VRA_LAN="1"`，再运行 `scripts/start.ps1`。只开放前端，后端仍绑定回环；
也可在后端已启动时运行 `VRA_LAN=1 npm run dev --prefix desktop`。
**仅限受信任局域网**：这是单用户工作台共享，不是账号隔离；网络内能访问端口的人可操作该工作台。
HTTP 传输不加密，API key 和研究资料可能在网络上明文传输。不要暴露公网或在不可信网络开启。
代理先校验浏览器同源，再归一化 Origin；远程模型地址仍须 HTTPS，本机模型可用回环 HTTP。
详见 [模型接入与局域网边界](docs/model-access.md#3-自托管模型与局域网访问)。

## 数据与市场

- 当前注册表：**117 个端点、30 层**，覆盖 CN、US、HK。
- 数据类别：行情、K 线、财务、一致预期、公告、研报、资金、筹码、期权、SEC/FINRA/CBOE、
  新闻、宏观、产业温度计、招聘、管制与数据日历。
- A 股、美股和港股都可用于自选股、持仓、资料归档与 Agent 对话。
- **六阶段个股研究目前只支持 A 股。** 港美市场不会启动一条没有完整数据链的空研究。
- 扫描版 PDF 需要先 OCR；文本型 PDF 会保留页码引用。

端点目录见 [datasources/CATALOG.md](datasources/CATALOG.md)。

## 项目结构

| 路径 | 作用 |
|---|---|
| `desktop/` | React + Vite 本地浏览器 UI |
| `orchestrator/` | Agent 编排、validator、API、MCP、对话、资料库与报告归档 |
| `backtest/` | 确定性回测引擎与工具入口 |
| `calc/` | 确定性计算库 |
| `datasources/` | 数据端点注册表、目录和健康巡检 |
| `.agents/skills/` | 金融研究 SOP 与取数工具 |
| `providers/` | 模型 provider 模板，不包含密钥 |
| `scripts/` | 初始化与体检 |
| `.local/` | 用户私有数据、报告、登录态和运行产物；已 gitignore |

## 安全与隐私

- 原始研报文件只保存在本机；模型只接收服务端检索命中的正文片段。
- 后端默认 provider 的 key 只走环境变量，不写入产品配置或仓库。
- 浏览器里填写的 API key 只保存在当前浏览器 `localStorage`，仅在调用时经本机后端转给所选模型服务商。
- 资料对话关闭 Shell、图片读取、子代理、插件、应用和联网能力。
- 资料引用格式为 `[资料:<id> p.<页码>]`，漏引、错引和未知引用会被机器校验拒绝。
- Agent 研究阶段无网络；取数由编排器使用受控脚本完成，原始响应落盘并记录哈希。
- 本机 API 默认只绑定 `127.0.0.1`，写请求必须鉴权并使用 JSON。
- 输出只包含数据、分析框架、情景概率和裁决点，不提供建仓、加减仓、目标价或止损位。

## 开发与测试

```bash
npm run typecheck --prefix orchestrator
npm test --prefix orchestrator

npm run typecheck --prefix desktop
npm test --prefix desktop
npm run build --prefix desktop

.venv/bin/python -m pytest calc/tests -q
.venv/bin/python -m pytest backtest/tests -q
.venv/bin/python -m pytest .agents/skills/data-access/scripts/tests -q
```

当前未提交开发版的本机验证：

- orchestrator：串行 **798 项**（797 通过、1 项 Windows ACL 专项按平台跳过），类型检查通过。
- desktop：**54/54**，类型检查与生产构建通过，主包体积警告保留。
- Python（计算库、回测、数据脚本）：最近 M14 检查点 **699/699**；本次上游同步未修改 Python、未重跑。
- 最新上游修复适配、两轮独立复审与测试范围，见 [上游 Issue 同步验收](docs/上游Issue同步验收_2026-09-05.md)。
- 增量修复分批通过实际 Codex 独立复审；这不是整仓无遗漏或发布就绪证明。
- 真实跨来源业务、干净安装、117 端点诊断和修后 full 实跑的成功与失败范围，见
  [M12 业务验收](docs/跨来源业务验收_M12_2026-09-05.md) 与 [M14 本机验收](docs/完整版本机验收_M14_2026-09-05.md)。

项目约定：每个环节完成后先测试，再做 Codex 独立审计、逐条核实、修复和复审；审计完成前不把
该环节称为“建成”，也不提交或推送。

## 当前边界

- 交付形态仍是开源源码 + 本地浏览器 UI，不是 DMG / EXE；当前未发布改动已用一个 `scripts/start`
  同时管理本地 API 与浏览器界面。
- MiMo API 已完成从空配置到真实业务报告的端到端验证；其他第三方模型仍需使用者自己的 key，
  没有真实跑过兼容矩阵的模板不会标成“已实测”。
- Windows 11 原生支持已接入：PowerShell 初始化/启动脚本、Windows 路径与进程处理、受控研究工具链，
  CI 配置包含 `windows-latest` / `macos-latest` / `ubuntu-latest`；本次未提交改动未运行远端 CI，
  也未在 Windows 实机验收。Windows 10 仅按 Codex 上游能力尽力兼容。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 免责声明

本项目只产出研究数据、分析框架、情景概率与裁决点，不提供任何投资动作建议。所有输出均不构成
投资建议；第三方公开数据可能延迟、缺失或有误，使用者应自行核实并承担决策责任，同时遵守各数据源
的使用条款。

## 赞赏

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

本仓库采用 [MIT License](LICENSE)。OpenAI Codex 使用 Apache-2.0；本仓库不包含 Codex 源码。

**作者：** Simon 林 · X [@linsizhen](https://x.com/linsizhen) · 邮箱：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
