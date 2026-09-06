# 模型接入指南

本文讲清四件事:第一次打开怎么选 AI、Agent 开关是什么、怎么验证一个 provider 能不能用、怎么加一家新的 provider。
后端默认 provider 的密钥只放环境变量；浏览器里由用户填写的 key 会持久保存在当前浏览器的本机
`localStorage`，以免每次重填。它不是系统钥匙串，也不承诺加密，只建议在可信个人电脑使用；共享电脑
用完应主动清除。调用时 key 随本轮请求交给本机后端，但不会写入产品配置、日志、事件账本或研究产物。

## 1. 第一次只选 AI 来源

| 通道 | 适用 | 怎么配 | 说明 |
|---|---|---|---|
| ChatGPT 订阅登录(默认) | OpenAI 模型,Plus / Pro / Team 订阅 | “接入 AI”→“订阅接入”→“登录 Codex” | 产品打开 OpenAI 官方登录页；登录态存在**产品自己的 CODEX_HOME**,与 `~/.codex` 隔离;不需要任何 API key |
| Claude.ai 订阅登录 | 本机 Claude Code 已安装并登录 | 在 Claude Code 里完成 `/login`，设置页自动检测 | 复用本机订阅；普通对话无工具，六阶段研究只开放产品受控 MCP；用户配置与 CLI 会话落盘保持关闭 |
| WorkBuddy / CodeBuddy 登录 | WorkBuddy 桌面版或 CodeBuddy Code CLI 已安装并登录 | WorkBuddy 用户无需重复安装；独立 CLI 用户运行 `codebuddy` 登录，设置页自动检测 | 复用本机账号；普通对话无工具，六阶段研究只开放产品受控 MCP；用户配置、自动记忆与后台任务关闭，旧 CLI 在一次性临时用户目录中运行 |
| API key | OpenAI 或第三方(DeepSeek / 通义千问 / 智谱 GLM / Kimi …) | 浏览器“接入 AI”填写，或 `export <ENV_KEY>=...` + `--provider <id>` | 浏览器 key 持久保存在本机浏览器配置，调用时才发给本机后端；命令行/后端默认 key 从模板声明的环境变量读取 |

连接成功后，产品自动进入 **Vibe Research Agent（默认开启）**，不再追问执行引擎、Quick 或 Deep。
受控任务入口会按任务语义选择确定性程序、轻量材料定位或六阶段研究。首页提供今日复盘、公司研究、
已有研报三个入口，跳转对应受控页面后由用户补充信息并确认；下方普通聊天明确不自动取数或抓全网研报。
设置页第二张卡可以关闭 Agent，
切到模型直连；这个开关只对已经通过直连能力探针的 API provider 开放，订阅登录不能被伪装成裸模型 API。

| 执行方式 | 能做什么 | 明确边界 |
|---|---|---|
| Agent（默认） | 本地上下文、工具调用、任务状态、研究进度、资料转写与六阶段研究 | Codex 订阅走 Codex Harness；Claude 与 WorkBuddy 订阅走各自本机 Agent，不混叫 |
| 模型直连 | 普通对话、标题翻译、现有材料定位等轻量任务 | 不调用工具、不保留 Agent 任务记忆；研究、辩论、Agent 回测与资料转写会要求重新开启 Agent |

Claude / WorkBuddy 的辩论、Agent 回测与资料转写已接通，和对话、材料定位、A 股六阶段研究一样沿用
设置里选定的来源，不再要求换成 Codex。持仓页可提交截图或表格生成草稿，核对后填入表单，再由用户
点击“添加”保存；文件内容会交给选定的 AI，不能把“台账本地保存”理解成“所选文件不发送给模型”。
真实业务验收的输入、来源、失败轮次和边界见 [M12](跨来源业务验收_M12_2026-09-05.md)。

当前 Claude Code 与 WorkBuddy / CodeBuddy Agent 已支持对话、有界材料任务和完整 A 股六阶段研究。
研究时每个阶段使用一次独立 CLI 会话，关闭内建工具，只开放本次运行目录内的五个产品受控 MCP 工具；
不会暗中换成 Codex。它们没有 Codex lifecycle hooks、skills 与连续线程，因此运行清单会明确记录较低的
`stage_prompt_only / host_events / per_stage_session` 能力边界。

### 2026-09-05 真实运行与发布边界

最新未提交开发版的回归、干净安装、全端点诊断与修后 full 实跑状态以
[M14](完整版本机验收_M14_2026-09-05.md) 为准；不是 Windows 真机、所有 API 厂商或全部数据源均通过。
下列 M8 数字保留为历史检查点，不覆盖 M12–M14 的后继修复与验收。

- WorkBuddy：核心数据范围六阶段 `complete / exit 0`，约 103 分钟；119 条证据、29 条计算记录
  （22 成功、7 失败尝试留痕）。报告首轮 30 分钟超时，第二轮通过。
- Claude Code 2.1.261：重新登录后，核心数据范围六阶段用 27 分 43 秒结束，各阶段最终 validator 通过；
  119 条证据、25 条计算记录（24 成功、1 失败尝试留痕）。因早期历史财务与可选项 gaps，最终仍为
  `incomplete / exit 2`。已有 11 个有效单季足够当前 TTM，必需计算范围与可选长历史缺口的状态区分待完善。
- 两次 `endpoint_scope` 均为 `core`，不是全注册表端点范围 `full`；不代表所有资料源或所有业务页已验收。
- 后续四轮 Claude Code 整仓范围审计确认的 14 项优先 P2 已完成本地整改、回归及独立 Codex 复审。
  该提交检查点回归为 orchestrator 721 项（720 通过、1 Windows ACL 跳过）、desktop 37/37、Python 640/640；
  类型检查与构建通过。首页/行情/查看器使用独立合成数据完成实际浏览器验收，不替代订阅六阶段修后重跑。
  M8 与原 14 项优先整改已本地提交为 `2ed80ac`，未推送、未发布；当时仍有后继产品与验收缺口。

- 后继运行隔离与辩论中止批次单独记账，状态及验证边界见
  [本地验收记录](运行隔离与辩论中止验收_2026-09-05.md)。六阶段深度研究的取消入口已在
  [M11](深度研究取消验收_2026-09-05.md) 单独实现并验收；“请求中止”与“已确认停止”分开显示，
  保留此前已完成阶段，停止未确认不冒充已取消。

### 本地模型地址的范围

API 地址接受 HTTPS；HTTP 只允许字面主机 `localhost`、`127.0.0.1` 或 `[::1]`，可带端口和路径，
例如 `http://127.0.0.1:11434/v1`。不允许远程/局域网明文 HTTP、URL 内嵌账号密码、查询参数或片段。
这只解决地址校验：模型仍须满足所选执行方式的协议、鉴权与输出契约，直连开关仍要求已有能力验证。
本轮用本地 HTTP 替身验证传输链路，未宣称实际 Ollama / LM Studio 模型或所有兼容端点均已验收。

设置页的订阅卡片不是静态开关。后端会实时检测 Codex / Claude Code / CodeBuddy Code 的 CLI、版本与登录状态。
Codex 未登录时会显示“登录 Codex”：点击后由产品使用自己的 `CODEX_HOME` 启动官方 `codex login`，
浏览器授权完成后页面自动轮询并点亮；登录失败或超时会明确提示重试。Qwen Code 的旧免费 OAuth 已停止，
DeepSeek CLI 也使用 API key，因此二者不列为
“免 key 订阅”。当前没有能同时证明“复用订阅”与“彻底禁用本地工具”的安全适配器时，不会照搬
Open Design 的自动批准参数后把按钮点亮。

### 从全新版本接入 ChatGPT 订阅

1. 启动本地 API 与浏览器 UI，进入左侧“接入 AI”。
2. 选择“订阅接入”，在 Codex 卡片点击“登录 Codex”。
3. 在自动打开的 OpenAI 官方页面由用户本人完成登录。产品不接触账号密码，也不会复用 `~/.codex` 的登录态。
4. 返回设置页等待状态变为“已登录”，点击“测试并保存”。只有真实对话探针成功后，订阅配置才会保存。
5. 若浏览器没有自动打开，可在仓库根使用后备命令：

```bash
CODEX_HOME="$(pwd)/.local/codex-home" codex login
```

设置页会实时检测这个产品专用登录态，无需重启或手工复制认证文件。

### 从全新版本接入 WorkBuddy / CodeBuddy

1. 已安装并登录 WorkBuddy 桌面版：直接回到“接入 AI”选择 WorkBuddy / CodeBuddy，产品会发现应用内置 CLI。
2. 没有桌面版：运行 `npm install -g @tencent-ai/codebuddy-code`，再运行 `codebuddy` 完成登录。
3. 等待状态显示“可用”，点击“测试并保存”。
4. 产品只向页面返回“是否已登录”；账号、token 和 CLI 原始响应不进入浏览器、日志或配置。旧版内置 CLI
   需要的订阅凭据只在进程内转交给一次性临时用户目录中的回答进程，结束后随临时目录删除。
5. 启动六阶段研究时，CodeBuddy 的内建工具继续关闭；产品仅为当前阶段加载 VRA MCP，并等待它初始化后再
   让模型工作。阶段产物仍须通过 schema、证据绑定、确定性计算与合规 validator，CLI 的自然语言回复不作为完成依据。

auth 的解析规则:用户没在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写过 auth 时,切换到第三方 profile 会自动用模板唯一支持的 `api_key`;显式写过的永不被覆盖(不支持就报错,不静默降级)。产品配置 `vibe-research.config.json` 里的 auth 只是产品默认,不算显式。

## 2. 从全新版本接入第三方模型

普通用户不需要先写环境变量：进入“接入 AI”→“API 接入”，选择供应商，填写 API 地址、模型名与
key，然后点击“测试并保存”。页面会先通过本机后端向所选供应商发起一次真实对话，并同时记录它是否
支持模型直连；成功才保存，失败则保留当前已生效配置并显示可行动提示。保存后，全站只使用这一份 AI 来源，
默认交给 Agent 运行。只有探针确认支持直连时，设置页的 Agent 开关才允许关闭。

下面的命令行流程用于开发者跑完整兼容矩阵：

```bash
# 1) 密钥只放环境变量(变量名见模板 env_key;此处以 DeepSeek 为例)
export DEEPSEEK_API_KEY=...
# 2) 先跑 10 项兼容矩阵(结果在 .local/provider-matrix/deepseek/<时间>/summary.md,不含密钥)
node orchestrator/src/finance/provider_matrix.ts --provider deepseek --model deepseek-v4-flash
# 3) 矩阵可接受后用于研究(或写进 .local/config.json)
node orchestrator/src/run.ts --symbol 300308 --market SZ --provider deepseek --model deepseek-v4-flash --python "$(pwd)/.venv/bin/python" < /dev/null
```

`.local/config.json` 写法:

```json
{ "provider": { "profile": "deepseek" }, "defaults": { "model": "deepseek-v4-flash" } }
```

优先级:`.local/config.json` ← 环境变量 `VRA_PROVIDER` / `VRA_PROVIDER_AUTH` ← CLI `--provider` / `--auth`。环境变量层整体生效(`VRA_PROVIDER` 与 `VRA_CODEX_HOME` / `VRA_PYTHON` 等可同时用)。

### Agent 引擎走 Responses；模型直连走 provider 单独验证的协议

Codex Agent 引擎(`codex-rs/model-provider-info`)对 `wire_api = "chat"` **直接硬报错**。所以一家厂商要作为
Agent 的模型来源，必须自己提供 OpenAI 兼容的 `/responses` 端点，或者在中间架一个
Responses→Chat Completions 网关（此时填 `responses_support: "gateway"`，`base_url` 指向网关）。
契约层会在选用时拒绝不兼容配置，不会让它跑到研究中途才失败。

模型直连不经过 Codex Agent 引擎。它读取 provider 模板里独立的 `direct` 声明，并在保存配置时做真实探针；
因此直连可以使用已验证的 Chat Completions 端点。`direct.supported=true` 只说明这个独立通道已经验证，
不能由顶层 Responses 配置自动推导，也不能靠模板存在就开放开关。

内置模板与对应环境变量（下表是 **Agent / Responses 通道**，供应商信息核实于 2026-08-26）：

| id | 厂商 / 通道 | env_key | 默认模型 | base_url |
|---|---|---|---|---|
| `openai` | OpenAI 官方(订阅登录或 API key) | `OPENAI_API_KEY` | 引擎默认 | null(官方端点) |
| `deepseek` | DeepSeek 官方 Responses | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | `https://api.deepseek.com` |
| `qwen` | 通义千问 · 阿里云百炼 | `DASHSCOPE_API_KEY` | `qwen3.8-max` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `glm` | 智谱 GLM · 阿里云百炼 | `DASHSCOPE_API_KEY` | `glm-5.2` | 同上 |
| `kimi` | Kimi · 阿里云百炼 | `DASHSCOPE_API_KEY` | `kimi-k2.7-code` | 同上 |
| `mimo` | 小米 MiMo 官方原生 Responses | `MIMO_API_KEY` | `mimo-v2.5` | `https://token-plan-cn.xiaomimimo.com/v1` |

⚠️ **三个百炼模板不能直接用**:`base_url` 里的 `{WorkspaceId}` 是留给你填的。把模板复制到 `.local/providers/<id>.json`、
换成自己的工作空间 ID 再选用 —— 没换会在**选用时当场被拒**(而不是把密钥发到一个不存在的主机上)。
走百炼而不是各家官方端点,是因为截至核实日只有 DeepSeek 官方提供原生 `/responses`;智谱官方开放平台没有,
月之暗面官方是否提供未核实 —— 未核实的事不写成事实。

模板里的 `default_model` / `context_limit_tokens` 是易变的供应商信息,`verified_at` 记最近一次人工核实日期(null = 未核实);模型名下线时请显式 `--model`。

### 一个模板可以声明"它不支持服务端 schema"

`structured_output` 字段(缺省 `json_schema`):

- `json_schema` —— 支持 `text.format.type=json_schema`,产品照常硬传(OpenAI / DeepSeek 走这条)。
- `prompt` —— **不支持**。产品会把 schema 写进提示词,不再硬传。
  硬传的后果不是降级而是**整轮被拒**:阶段直接 failed。

🔴 为什么这条降级不算放松要求:**`outputSchema` 从来就不是校验边界**。产物合不合规是产品自己校验的
(阶段过 validator、导入草稿过 `parseOutput`)。降级损失的是**命中率**——模型少了一层硬约束、
可能更容易写歪、重试次数上升;但写歪了照样过不了产品这关。所以这条降级**不能**顺手把校验也一起省掉。

## 3. 兼容矩阵怎么读

`provider_matrix.ts` 用 Codex SDK 对目标 provider 真跑 10 个小回合,机器判定 pass / partial / fail / n/a / error;临时目录 cwd、workspace-write、无网络、不加载产品宪法(只测协议兼容,不测研究纪律)。

| # | 项目 | pass 的判据 | 非 pass 的含义 |
|---|---|---|---|
| ① | 单次文本 | 回复含约定 token | 基本对话不通 |
| ② | 单工具调用 | 至少 1 条命令且输出含约定串 | 不会调用工具 |
| ③ | 连续三轮工具调用 | step-A / B / C 出自不同命令项且按序 | partial = 合并成一条或乱序 |
| ④ | 并行工具调用 | 两条命令都执行且事件流观察到同时在途 | partial = 都执行但串行 |
| ⑤ | 工具失败自修复 | 先失败 → 修复命令 → 最终回复说明 | partial = 修了没说 / 没修 |
| ⑥ | 长流 | 1–200 行编号一个不缺 + turn.completed | partial = 流被截断 |
| ⑦ | reasoning item | 事件里出现 reasoning 项 | partial = 模型不回传推理摘要(不算 fail) |
| ⑧ | schema 严格输出 | outputSchema 下最终回复为合法 JSON 且字段齐 | fail = 不是 JSON |
| ⑨ | 多轮上下文延续 | 第二回合复述第一回合约定词 | 会话不连续 |
| ⑩ | 无 previous_response_id 协议下的延续 | 非 responses 协议时 ⑨ 通过即 pass | responses 协议记 n/a(由 Codex 内部处理)——目前所有模板都是 responses,故此项恒为 n/a |

判定口径(含 ④ 如何用 `item.started/completed` 交错证明并发、⑦ 为什么要 `model_reasoning_summary=detailed`)见 `orchestrator/src/finance/provider_matrix.ts` 头注释;`judge()` 有逐项正反单测。结果文件落盘前做两层脱敏(provider 密钥精确替换 + 通用 token / 签名 URL)。矩阵不全绿的 provider 只应用于试验;编排器会把 provider 与矩阵状态写进运行的 `manifest.json`。

OpenAI 基线(2026-08-22,订阅登录,引擎默认模型):9 pass · 1 n/a。

**小米 MiMo 实测(2026-08-26,`mimo-v2.5`,API key)**:pass 7 · partial 1 · error 1 · n/a 1。

| 项 | 结果 | 说明 |
|---|---|---|
| ①②③④⑤⑥⑨ | pass | 文本 / 单工具 / 三轮工具 / **并行工具(峰值 2)** / 失败自修复 / 200 行长流 / 多轮延续 |
| ⑦ reasoning | partial | `mimo-v2.5` 不回传;⚠️ 换 `mimo-v2.5-pro` 直连实测**有** —— 这项跟**模型**走,不跟 provider 走 |
| ⑧ schema | **error** | `responses_feature_not_supported:text.format type 'json_schema' is not supported, only 'text' and 'json_object' are allowed` |
| ⑩ | n/a | responses 协议不适用 |

⑧ 是**协议层的事实**,矩阵如实记着不粉饰;产品侧用 `structured_output: "prompt"` 绕开了它。
同日用 `mimo-v2.5` 真跑了一个完整研究阶段(profile):**validator 通过、79 条证据**,
agent 那一轮 4.7 分钟 —— ⚠️ 慢,turn 超时压到 5 分钟会连续两次超时。产品默认 30 分钟，
其中也包含 WorkBuddy 正式报告在真实六阶段运行中两次撞到 20 分钟旧上限的余量。

### 发布前从零接入实测（2026-08-28）

- **Codex 订阅**：产品专用 `.local/codex-home` 从未登录状态开始，在设置页点击“登录 Codex”，
  成功打开 OpenAI 官方授权页；用户完成授权后，页面自动从“等待授权”变为“可用”。随后
  “测试并保存”真实对话通过，并在“每日复盘”完成一份完整当日复盘。最终配置为
  `provider=cli-codex`，没有 API key，也没有读取或覆盖 `~/.codex`。
- **MiMo API**：清空浏览器模型配置后，从“API 接入”重新选择 MiMo，填写官方 base URL、
  `mimo-v2.5-pro` 与用户自己的 key；“测试并保存”真实对话通过，随后同样在“每日复盘”完成完整报告。
  key 未写入仓库、后端配置、运行账本或日志。实测结束后已把默认接入恢复为 Codex 订阅。
- **失败保护**：新配置只有在真实对话成功后才保存；失败不会覆盖当前已生效配置。订阅登录任务限制为
  单实例并带超时与整组进程清理，重复点击不会启动多个登录流程。

这次验证的是普通用户真实路径，不是只调用 provider 矩阵或后端函数：从无配置/未登录状态开始，
经过浏览器设置页接入，再在实际业务页面发起 Agent 任务。

## 3. 自托管模型与局域网访问

来自上游 PR #34 的自托管模板与 LAN 开关已适配当前双引擎开发版。它们是两件不同的事：
模型运行在哪里决定 API 地址；从哪台设备看工作台决定前端监听地址。不要把两者混为一谈。

### 自托管模型

普通用户仍在“接入 AI”选择 API 来源，填写实际地址、模型名和 key，测试成功后全站沿用这份配置，
不需要再把聊天和研究各配一次。后端机器上的模型可用 `http://127.0.0.1:11434/v1`；远程模型使用 HTTPS。
从手机访问时，模型地址中的 `127.0.0.1` 指后端所在电脑，不是手机。

开发者需要 provider 模板时，复制 `providers/selfhosted.json` 到 `<数据根>/providers/selfhosted.json`，
替换整个 `base_url`（不能保留 `{ApiPath}`）并填写 `default_model`。密钥仅经 `SELFHOSTED_API_KEY`
环境变量提供，不写进模板或配置文件。未替换占位符时选用会被拒绝。
模板保持 `matrix.status=unverified`，没有附带自动转换网关，也没有宣称某个推理框架版本已通过。
Agent 路径需要兼容 Responses 与工具调用；`responses_support=gateway` 只是描述用户提供的网关，
不会自动把 Chat Completions 变成 Responses。实际兼容矩阵需使用自己的服务与授权运行。
此模板未声明已验证的模型直连能力，不会因为模板存在就解锁直连开关。

### 局域网工作台

默认只绑定 `127.0.0.1:5930`。从仓库根运行 `VRA_LAN=1 bash scripts/start` 才将 UI 绑定所有网卡；
Windows PowerShell 使用 `$env:VRA_LAN="1"` 后运行 `scripts/start.ps1`。
后端继续绑定 `127.0.0.1:8765`，不改其跨站检查。代理先拒绝异源/不合法来源，再将合法请求归一化为回环来源。
Vite 的 `strictPort` 保留，端口被占用时明确失败，不能静默漂移到另一个界面。
关闭方式是停止本次服务，取消 `VRA_LAN` 环境变量后重启；本功能不修改保存的 AI 配置。

这不是多用户或公网产品：没有新增 LAN 登录保护，可达该 UI 端口的人可以使用工作台权限、读取或修改本地资料。
HTTP 上浏览器到后端这一跳不加密，输入的 API key/资料存在网络窃听风险；后端 Bearer 不进浏览器并不能消除这一点。
仅在受信任局域网主动开启，不对公网映射端口。本轮只在回环网络测试该开关与代理，不替代实际跨设备或 Windows 验收。
局域网浏览器缺少 `crypto.randomUUID` 时，回测、页面分析、记录反思与资料任务均使用非鉴权的 UI 标识。

## 4. 加一家新的 provider

1. 复制 `providers/deepseek.json` 为 `providers/<id>.json`(或放用户私有覆盖 `.local/providers/<id>.json`,同结构,优先级更高);`id` 小写字母开头,只含 `a-z0-9_-`,且与文件名一致。
2. 填字段:`name`、`wire_api`(**只能 `responses`**;`chat` 会被当场拒绝,见上文)、`base_url`(**第三方必须显式填写；远程 HTTPS、本机字面回环主机允许 HTTP**——Codex 对空 base_url 会回退到 `api.openai.com`,密钥会发到错误主机)、`env_key`(大写变量名,不得是 HOME / PATH 等受保护名)、`auth_modes`(第三方只能 `["api_key"]`)、`requires_openai_auth: false`、`default_model`、`responses_support`(厂商自己提供 `/responses` 填 `native`,经自建网关转换填 `gateway`;不能填 `none`)。可选:`query_params` / `http_headers` / `env_http_headers`(值是环境变量名)/ `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` / `context_limit_tokens` / `retryable_errors` / `known_incompatibilities` / `verified_at`。
3. `http_headers` / `query_params` 里写了像密钥的值会被直接拒绝——密钥只能经 `env_key` / `env_http_headers` 引用。
4. 跑矩阵,按结果回填 `matrix.status` / `matrix.results` / `matrix.note`。

模板怎么映射到 Codex:非 openai 的 profile 注入 `model_provider=<id>` + `model_providers.<id>={name, base_url, env_key, wire_api, requires_openai_auth=false, …}`(经 SDK 配置覆盖,不写 `~/.codex`);进程环境只透传 `env_key` 与 `env_http_headers` 引用的变量(openai 的 api_key 模式另设 `CODEX_API_KEY`);agent 的 shell 命令不继承任何密钥类变量。

## 5. 常见问题

- **`--provider deepseek` 报"环境变量 DEEPSEEK_API_KEY 未设置"**:密钥只从环境变量读,先 `export`。
- **报"provider xxx 不支持 auth=chatgpt_login"**:你在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写了 chatgpt_login;第三方只能 api_key,改掉或删掉显式设置即可。
- **⑦ partial**:该模型 / 协议不回传推理摘要,不影响研究运行。
- **④ partial**:provider 把同一回合的多条工具调用串行执行,功能可用但慢。
- **⑩ n/a**:responses 协议下 previous_response_id 由 Codex 内部处理,此项不适用(所有模板都是 responses)。
- **报"引擎不再支持 wire_api=\"chat\""**:你在用一份旧模板。改成厂商的 Responses 端点,或架一个 Responses→Chat 网关并填 `responses_support: "gateway"`。
- **报"base_url 里还有没替换的占位符 {WorkspaceId}"**:百炼三件套要填自己的工作空间 ID,把模板复制到 `.local/providers/<id>.json` 改完再用。
- **想用 OpenAI 兼容网关**:新建独立 id 的模板(不要改 `openai.json` 的 base_url,它必须为 null)。
- **Responses↔Chat 自建适配器**:不在本仓库范围(独立子项目);`responses_support=gateway` 留给这类网关。
