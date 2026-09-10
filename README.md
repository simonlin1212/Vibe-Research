<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>

<h1 align="center">Vibe Research</h1>

<p align="center">
  <b>接入自己的 AI，日常直接聊，需要研究时开启 Agent</b><br>
  Codex / Claude Code / WorkBuddy 订阅或模型 API 一次接入 · Agent 默认关闭 · 左上角一键开启
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
  <a href="CHANGELOG.md"><img alt="源码版本 v1.2.0" src="https://img.shields.io/badge/source-v1.2.0-F35D2B"></a>
  <img alt="UI" src="https://img.shields.io/badge/UI-React%20%2B%20Vite-646cff">
  <img alt="Agent 默认关闭" src="https://img.shields.io/badge/Agent-opt--in-555">
  <img alt="Codex Harness" src="https://img.shields.io/badge/runtime-Codex%20Harness-black">
</p>

<p align="center">
  <a href="https://viberesearch.wiki">官方网站</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#用-vibe-research-做什么">产品功能</a> ·
  <a href="#接入-ai">接入 AI</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#安全与隐私">隐私</a> ·
  <a href="#开发与测试">开发</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

Vibe-Research 是一款面向个人投资者的 AI 投研工作台，把市场资讯、行业跟踪、公司研究和资料管理汇集在一起，让研究有据可查、持续积累。

---

## 作者正在寻找工作机会

作者目前关注腾讯等大型科技企业在深圳的 AI 相关岗位，希望加入一支热爱 AI 开发的团队，继续从事 AI / Agent 产品开发、应用落地及 AI 咨询工作。

联系：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)

---

## 界面预览

以下为 2026-09-07 拍摄的 **v1.1.0** 真实界面。首屏直接聊天，Agent 默认关闭；需要联网查证或多步研究时再开启。

![深色首页：普通对话、Agent 开关与五类研究功能入口](assets/screenshots/2026-09-07/home-dark.png)

<details>
<summary>浅色主题：同一套布局，暖橙色交流区</summary>

![浅色首页：对话区与五类功能卡片](assets/screenshots/2026-09-07/home-light.png)

</details>

截图使用空白、未接入 AI 的隔离工作区，没有私人持仓、研报或账号凭据；[截图说明](assets/screenshots/2026-09-07/README.md)。

## 用 Vibe Research 做什么

从市场变化出发，找到值得跟踪的行业与公司，再核对观点、整理资料，留下自己的研究记录。下表对应左侧的 **13 个一级栏目**；分组用于阅读，不改变产品里的栏目名称。

| 使用场景 | 一级栏目 | 可以做什么 |
|---|---|---|
| 直接开始 | 首页 | 与 AI 对话、梳理研究问题，从分类卡片进入各个功能 |
| 看市场 | 每日复盘 | 查看盘面表现、资金与连板数据，梳理当天热点和变化 |
| 看市场 | 资讯雷达 | 集中查看新闻、公司公告与事件线索，找到需要进一步核对的信息 |
| 看行业 | 产业信号 | 跟踪 GPU 租金、月度产业数据、原材料与招聘等上下游信号 |
| 看行业 | 板块中心 | 按板块查看产业方向、产业链环节和相关公司 |
| 研究与验证 | 个股研究 | 分阶段整理公司业务、财务、盈利预期、估值和风险，形成带证据的研究报告 |
| 研究与验证 | 多空辩论 | 对照支持与反对的观点，寻找遗漏的前提、风险与反证 |
| 研究与验证 | 回测 | 用对话说明要验证的想法，结合历史数据检查规则表现 |
| 管理与积累 | 自选股 | 管理正在关注的公司，刷新行情并继续跟踪 |
| 管理与积累 | 我的持仓 | 整理个人持仓与台账，结合行情查看记录；不提供下单交易 |
| 管理与积累 | 我的研报 | 导入、查阅和检索自己的资料，围绕资料提问并核对原文 |
| 管理与积累 | 研究记录 | 回看研究、回测和辩论报告，按时间查看、搜索与管理 |
| 连接模型 | 接入 AI | 连接自己的订阅或模型 API，测试成功后供各个 AI 入口使用 |

### 首页：先聊问题，再按需研究

连接 AI 后，可以在首页直接提问。其他栏目右上角也有对话入口，方便围绕当前页面继续交流。

**Agent 默认关闭。** 普通对话适合梳理思路、解释概念和翻译；需要联网查资料、取数、计算或多步研究时，再打开左上角“开启Agent”。开启后可以研究得更深入，但通常更慢，也更消耗 Token。开关保留已选的 AI 来源，不要求重新接入。

后台研究经确认后启动；普通对话不会自动变成一轮完整研究。未接入 AI 时也可以先浏览栏目。

### 个股研究：从公司业务到风险，逐步展开

选择一家 A 股公司，研究会依次整理 **公司画像 → 财务 → 盈利预期 → 估值 → 风险 → 报告**。不是只给一段结论，还保留各阶段使用的资料、计算依据、来源冲突与数据缺口。

研究过程中可以查看进度、请求中止，刷新页面后继续查看状态。发出中止请求不代表已经停止，页面会区分请求与确认状态。完整六阶段研究目前只支持 A 股；港美股支持范围见[数据与市场](#数据与市场)。

### 我的研报与证据核对：读结论，也能回头看依据

把 PDF、DOCX、TXT、MD 或 CSV 资料导入“我的研报”，可以查阅、检索，并围绕资料提问。回答中的资料引用用于回查原文，文本型 PDF 保留页码；扫描版 PDF 需要先做文字识别。

公司研究中的原始数据保留来源与资料期，派生数字保留计算输入和结果。遇到来源冲突或缺数据，会记录下来，不把空缺当成零，也不把无法验证的结果当作已完成。**有引用不代表推论必然正确，仍需核对原文与计算条件。**

原始研报在本机保存和解析，检索命中的正文片段会发送给所选模型；“本地保存”不等于全程离线。

### 多空辩论与回测：从不同角度核对想法

**多空辩论**让不同分析视角围绕同一份资料展开，查看支持理由、风险解释和反驳，帮助发现尚未解决的分歧。

**回测**用于检查明确的历史规则。先用自然语言说明问题；缺少条件时继续补充，条件齐备后调用回测工具。工具失败或不支持的条件会说明，不把未执行的任务写成回测结果。

两者都需要开启 Agent。报告会保存在“研究记录”，方便之后查找、比较和回看。历史表现不代表未来结果，也不是现实交易建议。

### 自选股、持仓与记录：把研究积累留下来

“自选股”管理关注清单，“我的持仓”整理已有持仓，“研究记录”保存研究产出。A 股、美股与港股代码均可用于自选股与持仓记录。

持仓与自选股支持从截图或表格整理草稿，**人工核对后再确认保存**，不会上传后直接改写台账。选定内容会发给当前 AI，请先移除无关敏感信息。转写暂存件在成功、失败或取消后清理；请保留原文件核对。清理本机暂存件不代表模型服务商删除了已收到的内容。

## 接入 AI

**已有 WorkBuddy，也可以接入 Vibe Research。** 可以使用自己的订阅，或填写模型 API；连接成功后，日常无需反复选择。

| 接入方式 | 使用自己的什么 |
|---|---|
| WorkBuddy / CodeBuddy | 本机已安装并登录的 WorkBuddy，或腾讯官方 CodeBuddy Code CLI |
| Codex 订阅 | 通过产品专用登录完成的 ChatGPT 授权 |
| Claude 订阅 | 本机已安装并登录的 Claude Code |
| 模型 API | 自己的 DeepSeek、MiMo、OpenAI 等兼容服务地址、模型和 API key |

接入需要对应服务的安装、登录、接口兼容与可用额度；产品不附赠订阅。一次连接测试成功不等于所有业务和供应商都已验证。

![接入 AI：选择已有订阅，或进入其他 API 接入方式](assets/screenshots/2026-09-07/connect-ai.png)

上图为 2026-09-07 的 v1.1.0 接入弹窗，使用未登录的隔离工作区拍摄；不是当前账号状态。

### 第一次连接

首页直接显示交流框。尚未连接时会弹出“请接入AI”：已登录的 Codex、Claude Code、WorkBuddy
可点击对应入口测试并保存；“其他接入方式”进入设置，支持 API 配置与登录帮助。新连接默认关闭 Agent，
以后打开首页无需重复选择，左上角显示已保存的实际来源。也可先关闭弹窗浏览栏目。
交流框按模式提供常见问题，下方按五类整理现有功能入口。需要联网查证或多步研究时，打开左上角“开启Agent”。
明确切换的状态会保留；重新测试同一来源不会重置。订阅普通对话仍需启动对应客户端，不承诺固定响应时间。

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
模型直连能力验证。出现重新连接提示时，请检查是否尚未登录、登录失效或连接探针未通过，按页面具体错误处理；不要把所有接入失败都当作订阅已过期。

<details>
<summary>接入细节、工具权限与局域网边界</summary>

- Agent Runtime 负责本地上下文、工具调用、任务状态、进度和失败处理。Codex 订阅走 Codex Harness；Claude 订阅走 Claude Code Agent；WorkBuddy / CodeBuddy 走 CodeBuddy Code Agent，三者不会混叫。
- Claude Code 与 WorkBuddy / CodeBuddy Agent 可运行完整 A 股六阶段研究；每个阶段使用一次独立会话，只能调用 Vibe Research 的受控 MCP，不会暗中换成 Codex。
- AI 来源可以是订阅登录，也可以是用户自己的 Model Provider API。新来源默认关闭 Agent，同一来源重测保留明确选择。
- 模型直连不运行 Agent、不调用工具，也没有 Agent 任务记忆；六阶段研究、多空辩论和 Agent 回测会明确提示重新开启 Agent，不会静默降级。
- Codex 订阅使用产品自己的 `CODEX_HOME`，不读写用户的 `~/.codex`；Claude 与 CodeBuddy 订阅复用各自本机登录态。普通对话关闭全部工具与 MCP；六阶段研究关闭内建工具，只开放产品受控 MCP。用户配置与自动记忆保持关闭。WorkBuddy 自带的旧 CLI 若没有“禁止会话落盘”参数，整次回答会改在一次性临时用户目录运行，结束后删除。
- 无论订阅或 API，点击“测试并保存”都会先做一次真实对话探针；探针失败不覆盖当前已生效配置。
- API 模式的 key 会持久保存在当前浏览器的本机 `localStorage`，方便下次直接使用；它不是系统钥匙串，
  也不承诺加密，只建议在可信个人电脑使用。key 随请求交给本机后端，但不进入仓库、后端配置、运行账本
  或日志；共享电脑用完请主动清除。

内置 provider 模板：OpenAI、DeepSeek、Qwen、GLM、Kimi、MiMo，以及未实测的 `selfhosted` 自托管占位模板。Codex Harness 的 API 通道只支持 Responses API；
直连通道使用 provider 模板中单独声明并验证的协议。模板存在不等于已经通过兼容矩阵，界面会区分
“已实测”和“有模板、未实测”；普通对话不把未验证来源伪装成已验证的 API 直连能力。

详细说明见 [docs/model-access.md](docs/model-access.md) 和 [providers/README.md](providers/README.md)。

局域网访问为可选功能，默认关闭。从仓库根启动：`VRA_LAN=1 bash scripts/start`；Windows PowerShell
先设置 `$env:VRA_LAN="1"`，再运行 `scripts/start.ps1`。只开放前端，后端仍绑定回环；
也可在后端已启动时运行 `VRA_LAN=1 npm run dev --prefix desktop`。
**仅限受信任局域网**：这是单用户工作台共享，不是账号隔离；网络内能访问端口的人可操作该工作台。
HTTP 传输不加密，API key 和研究资料可能在网络上明文传输。不要暴露公网或在不可信网络开启。
代理先校验浏览器同源，再归一化 Origin；远程模型地址仍须 HTTPS，本机模型可用回环 HTTP。
详见 [模型接入与局域网边界](docs/model-access.md#3-自托管模型与局域网访问)。

</details>

## 快速开始

### 从源码运行

当前版本 **v1.2.0** 提供开源源码 + 本地浏览器工作台，便于用自己的开发 Agent 改造。Mac 客户端已暂撤；v1.1.0 的 DMG 也已于 2026-09-10 从 GitHub 撤下，旧版本记录和源码归档保留。旧客户端数据不会自动迁移，详见[源码交付说明](docs/source-delivery.md)。

macOS、Windows 和 Linux 都使用下面的源码流程。页面仍在本机运行，不是把私人研究上传到网站。首次使用需要先安装 Node.js、Python 和 Git，再初始化项目。

让开发 Agent 打开克隆下来的仓库即可改造页面与功能。`desktop/` 是浏览器前端目录，并非 Mac 客户端；修改代码后按[开发与测试](#开发与测试)验证。

### 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 11、macOS 或 Linux；Windows 原生运行，不要求 WSL |
| Node.js | ≥ 22.18，推荐 24 LTS |
| Python | ≥ 3.11，推荐并已验证 3.12 |
| Agent 引擎 | Codex Harness 随依赖安装，当前开发分支锁定并已本机验证 0.153.4；用户无需另装全局 Codex |
| 模型 | Codex / Claude Code / WorkBuddy 订阅登录，或兼容所选执行方式的模型 API |

> Node 必须是启用了 TypeScript 支持的构建（nodejs.org 官方安装包、nvm / fnm / Volta 装的都是）：`node -p process.features.typescript` 应输出 `strip` 或 `transform`。部分 Linux 发行版仓库打包的 Node 编译时关闭了这一项，启动或跑测试会报 `ERR_UNKNOWN_FILE_EXTENSION ".ts"` / `ERR_NO_TYPESCRIPT`，请换官方构建。`npm test` 前会先做这项检查并给出同样的提示。

### 安装依赖

> 已有源码副本请先备份自己的数据，再更新代码并执行 setup，不必重新克隆。旧 Mac 客户端数据不会自动迁入源码工作区；不要删除 `~/.vibe-research-desktop`，也不要把它提交到仓库。

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

### 启动浏览器 UI

Windows 运行 `scripts\start.cmd`，macOS / Linux 运行 `scripts/start`。两者都会同时管理本机 API 与界面，
浏览器地址为 [http://127.0.0.1:5930](http://127.0.0.1:5930)。macOS / Linux 如不想自动打开浏览器，
可运行 `scripts/start --no-open`；按 Ctrl+C 会同时关闭两端。

Vite 只在本机代理 `/api/*`，并在服务端补上鉴权信息。若设置了 `VRA_DATA_ROOT`，两个进程必须使用
同一个值。

## 数据与市场

- 当前注册表：**117 个端点、30 层**，覆盖 CN、US、HK。
- 数据类别：行情、K 线、财务、一致预期、公告、研报、资金、筹码、期权、SEC/FINRA/CBOE、
  新闻、宏观、产业温度计、招聘、管制与数据日历。
- A 股、美股和港股都可用于自选股、持仓、资料归档与 Agent 对话。
- **六阶段个股研究目前只支持 A 股。** 港美市场不会启动一条没有完整数据链的空研究。
- 扫描版 PDF 需要先 OCR；文本型 PDF 会保留页码引用。

端点目录见 [datasources/CATALOG.md](datasources/CATALOG.md)。

## 安全与隐私

- 开启 Agent 后，公开网页读取可能经第三方 Jina Reader 转发；目标网址（包括查询参数）会发送给该服务。不要提交含私密令牌、内部资料或签名下载凭据的网址。搜索请求同样会发送到对应搜索服务。

- 原始研报文件只保存在本机；模型只接收服务端检索命中的正文片段。
- 后端默认 provider 的 key 只走环境变量，不写入产品配置或仓库。
- 浏览器里填写的 API key 只保存在当前浏览器 `localStorage`，仅在调用时经本机后端转给所选模型服务商。
- 普通对话不调用工具；开启 Agent 后，对话可使用产品提供的联网和研究工具。专门的资料抽取等有界任务仍按任务限制执行权限。
- 资料引用格式为 `[资料:<id> p.<页码>]`，漏引、错引和未知引用会被机器校验拒绝。
- Agent 研究阶段无网络；取数由编排器使用受控脚本完成，原始响应落盘并记录哈希。
- 本机 API 默认只绑定 `127.0.0.1`，写请求必须鉴权并使用 JSON。
- 输出只包含数据、分析框架、情景概率和裁决点，不提供建仓、加减仓、目标价或止损位。

## 当前边界

- 当前只提供源码 + 本地浏览器 UI，不提供 Mac 客户端或安装包构建工具；v1.1.0 DMG 已撤下，旧版本记录与源码归档保留。
- MiMo API 已完成从空配置到真实业务报告的端到端验证；其他第三方模型仍需使用者自己的 key，
  没有真实跑过兼容矩阵的模板不会标成“已实测”。
- Windows 11 原生支持已接入：PowerShell 初始化/启动脚本、Windows 路径与进程处理、受控研究工具链，
  CI 配置包含 `windows-latest` / `macos-latest` / `ubuntu-latest`，Windows 使用选定的跨平台契约测试，并非全部后端测试。仍未在 Windows 实机验收，也尚未验证正常退出后的 Job Object 子进程回收保证。Windows 10 仅按 Codex 上游能力尽力兼容。
- 源码运行需要本机依赖环境；端点登记在册不保证第三方服务随时可用。

## 工作方式

```text
本地浏览器工作台
首页 Agent · 复盘 · 资讯 · 个股研究 · 回测 · 资料库
        │
        ▼
金融 Agent 层
117 个数据端点 · 六阶段 SOP · calc · validator · report archive
        │
        ▼
本地 Agent 运行时（Local Agent Runtime）与模型供应商（Model Provider）
按用户所选来源路由（不是串联运行）
├─ Codex 订阅 / 兼容 Responses API → Codex Harness
├─ Claude 订阅 → Claude Code CLI
├─ WorkBuddy / CodeBuddy → CodeBuddy Code CLI
└─ 已验证 API 的普通对话 → 模型直连，不调用 Agent 工具
```

三级约束不会只依赖提示词：

| 层 | 组成 | 作用 |
|---|---|---|
| 提示层 | `AGENTS.md` + `.agents/skills/` | 定义金融研究纪律与 SOP |
| 执行层 | 对应运行时的 sandbox / hooks / 受控 MCP | 按任务限制联网、文件访问、取数和产物范围 |
| 编排层 | orchestrator + validator + calc + gate | 强制阶段、证据引用、确定性计算和合规边界 |

项目不修改 Codex 源码。Codex 仓库只作上游参考，产品通过官方 CLI 与 SDK 使用 Harness。

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

## 开发与测试

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

完整研究耗时取决于取数范围、模型响应与校验重试，可能需要数十分钟或更久，不承诺固定时长。进度会持续显示，结果写入 `.local/runs/<run-id>/`。
退出码：`0` complete、`2` incomplete/stale、`3` failed。

### 研究运行产物

六阶段研究会产出：

- `report.md`：最终研究报告。
- `evidence.json`：本轮使用的证据，每条保留来源、资料期和原文引用。
- `calculations.json`：派生数字的输入、函数和计算 DAG。
- `conflicts.json`：跨来源冲突，不静默取舍。
- `manifest.json`：模型、版本、阶段、状态、资料召回和运行清单。
- `viewer.html`：可在浏览器查看证据与报告。

### 回归检查

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

最近本机验收记录（2026-09-09，v1.2.0 源码版）：

- orchestrator：Node 26 串行 **853 项：852 通过、1 项 Windows ACL 专项跳过**；类型检查通过。历史并发测试的等待超时记录仍保留，不以串行结果抹掉。
- desktop：**84/84**，类型检查与生产构建通过；Python（计算库、回测、数据脚本）：**754/754**。

- 当前修复、浏览器验证和隐私检查见 [v1.2.0 Issue / PR 处理记录](docs/issue-pr-triage-v1.2.0.md)。本轮未重跑真实模型、全部外部取数端点或 Windows 实机。
- 增量修复通过独立审计与复审；交付调整见[源码交付说明](docs/source-delivery.md)。历史业务验证保留在 [M40 验收](docs/发布候选与隐私验收_M40_2026-09-07.md)，不当作本版全业务验收。

项目约定：每个环节完成后先测试，再做 Codex 独立审计、逐条核实、修复和复审；审计完成前不把
该环节称为“建成”，也不提交或推送。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

<details>
<summary>查看与历史公开版 v1.0.4 的对比</summary>

对照基线为 [v1.0.4 发布说明](https://github.com/simonlin1212/Vibe-Research/releases/tag/v1.0.4)及[该标签的 README](https://github.com/simonlin1212/Vibe-Research/blob/v1.0.4/README.md)。右列为 v1.2.0 源码工作台；相对 v1.1.0 的变化见 [CHANGELOG](CHANGELOG.md)。

| 方面 | 历史公开版 v1.0.4 | v1.2.0 源码版 |
|---|---|---|
| 使用形态 | 开源源码 + 本地浏览器工作台 | 源码 + 本地浏览器工作台；暂撤 Mac 安装壳，便于 Agent 改造 |
| 订阅接入 | Codex、Claude Code，另有 API 接入 | 增加 WorkBuddy / CodeBuddy；首页快速测试，显示实际已保存来源 |
| 首页与日常对话 | 已有首页 Agent 和研究栏目 | 普通对话默认开启、Agent 按需启用；保留左侧栏目，首页收拢为五类入口；统一橙色深浅主题 |
| 聊天工具 | Claude 订阅对话关闭工具和联网 | 开启 Agent 后可搜索、读网页、取数和计算；后台研究经确认启动，回复显示实际工具记录 |
| 持仓与自选股 | 代码录入、本地台账、行情刷新 | 增加截图／表格转写草稿，人工核对后确认保存 |
| 研究体验 | 已有六阶段研究、证据校验、研报库、辩论和回测 | 保留并完善这些能力，增强报告与来源面板、运行中止、刷新恢复及来源绑定 |
| 安装与引擎 | Codex 0.149.0；Mac / Linux 文档需分别启动两端 | 引擎保留 0.153.4；setup 安装依赖，start 一次启动两端 |

</details>

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
