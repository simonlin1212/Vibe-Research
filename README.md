# Vibe-Research · 个人 AI 投研系统（A股/美股/港股）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![GitHub stars](https://img.shields.io/github/stars/simonlin1212/Vibe-Research?style=social)](https://github.com/simonlin1212/Vibe-Research/stargazers)
[![官网 viberesearch.wiki](https://img.shields.io/badge/🌐_官网-viberesearch.wiki-F35D2B?style=flat)](https://viberesearch.wiki)

**[🌐 官网](https://viberesearch.wiki) · [产品预览](#️-产品预览) · [功能](#-功能) · [数据源](#-数据源data-sources) · [快速开始](#-快速开始) · [接入 AI](#-接入-ai) · [合规](#️-合规) · [相关生态](#-相关生态) · [联系作者](#-联系作者)**

> **Vibe-Research: Your Personal Trading Research Agent** · A股 / 美股 / 港股 的个人投研 Agent。
>
> 每日复盘、资讯雷达、个股数据、自选股、板块中心、我的持仓、我的研报、研究记录。把数据和功能配齐，由**你自己的 AI** 驱动投资研究。

Vibe-Research 是一个开源的「个人 AI 投研看板」，**主推 A 股、兼看美股 / 港股**（A 股常要看隔夜外围脸色，数据配上更全）。它不替你做决定——把行情、研报、估值、财务、公告、资金面、资讯都配齐，放进一个干净的看板，再留一个能接入**你自己的 AI** 的接口。方向和结论，交给你自己配置的模型 / agent。

> *Vibe-Research: Your Personal Trading Research Agent. An open dashboard for China A-share (plus US / HK): it wires up all the data and plugs into **your own AI / agent** — it never recommends a stock. You bring the model, it brings the data.*

## 🖥️ 产品预览

**每日复盘** — 大盘 / 短线情绪(连板股 · 成交额 TOP20) / 板块资金一屏看全，一键交给你的 AI 复盘

![Vibe-Research 每日复盘](docs/screenshots/daily-review.png)

<table>
<tr>
<td width="50%">

**个股数据** — 财报速览 + 估值分位 + 资金面一屏看穿

![个股数据](docs/screenshots/stock-detail.png)

</td>
<td width="50%">

**资讯雷达** — 12 赛道 108 个公开源，一键提炼今日要点

![资讯雷达](docs/screenshots/intel.png)

</td>
</tr>
</table>

---

## ✨ 功能

每个页面的具体模块：

| 页面 | 包含的模块 / 能力 |
|---|---|
| 📊&nbsp;**每&#8288;日&#8288;复&#8288;盘** | 大盘指数 · **全球市场**（隔夜美股道指 / 标普 / 纳指 + 港股恒指 / 恒生科技）· 关注股票（自选实时行情）· **短线情绪**（连板股 / 最高连板 / 连板梯队 / 封板率 / 炸板率 / 晋级率）· **全市场成交额 TOP20** · 市场情绪（大盘宽度 / 题材投机 / 涨跌停）· 板块资金趋势榜 · 资金轮动 · AI 当日复盘 |
| 📡&nbsp;**资&#8288;讯&#8288;雷&#8288;达** | 12 赛道 108 个公开 RSS 源 · AI 一键提炼「今日要点」· A 股公告 / 公开新闻（挂钩你的关注列表）|
| 🔍&nbsp;**个&#8288;股&#8288;数&#8288;据** | **A 股**：行情 · 估值矩阵（前向 PE / PEG）· **财报速览** · 估值历史分位 · 财务关键指标 · 研报 · 公告 · 新闻 · **资金面**（融资融券 / 股东户数 / 主力资金流 / 分红 / 大宗交易）· 龙虎榜 · 限售解禁 · 板块归属 · 热门概念 · 互动易问答。**美股 / 港股 / 韩股**（输 `AAPL` / `00700` / `005930.KS`）：行情 · 总市值 · 关键财务指标（营收 / 净利 / EPS / ROE / 毛利率 / 负债率；韩股仅行情）|
| ⭐&nbsp;**自&#8288;选&#8288;股** | **批量粘贴一串代码即加**（逗号 / 空格 / 换行都行）· 一屏表格总览（现价 / 涨跌 / PE / PB / 换手）· 一键交给 AI 读。只存本地 |
| 🧩&nbsp;**板&#8288;块&#8288;中&#8288;心** | 板块 + 产业链环节骨架 |
| 💼&nbsp;**我&#8288;的&#8288;持&#8288;仓** | 录入即实时盈亏 · 已清仓记录（只存本地、不上传）|
| 📄&nbsp;**我&#8288;的&#8288;研&#8288;报** | **拖拽 / 多选上传**自己的研报（PDF / Word / txt / 表格 / 图片）· 按文件名**自动分行业**归档 · 下载 / 删除。**只存本地部署目录、不上传、不进仓库** |
| 📝&nbsp;**研&#8288;究&#8288;记&#8288;录** | 复盘 / 今日要点 / 问 AI 结果本地沉淀，随时回看 |
| 🔌&nbsp;**接&#8288;入&nbsp;AI** | 订阅接入（本机 CLI，免 key）· API 多模型（自动填 baseURL）· MCP（挂进 Claude Code 等 agent）|

> **投研分析框架**：让 AI 分析个股时，自动按 估值 / 资金面 / 财报质量 / 行业景气 / 事件催化与风险 五维组织结论——框架只规定「怎么读数据」、不规定买卖，方向仍由你自己的 AI 决定。
>
> 连板股 / 成交额榜等均为**客观公开榜单数据，只呈现事实、不推荐、不预测**。

## 📡 数据源（Data Sources）

Vibe-Research 把三套公开数据源**直接集成进仓库**——`git clone` 下来**开箱即用，无需另外下载、接线**。

### A 股全栈数据 · AStockData

- **就在本仓库的 [`a-stock-data/`](a-stock-data/) 文件夹里**（v3.3.0）。十层数据架构、40 个端点，`a-stock-data/SKILL.md` **内嵌全部调用代码**，自包含、零第三方数据封装依赖，东财接口已内置限流防封。
- **覆盖**：行情 / K线 / 研报 / 一致预期 / 估值 / 历史分位 / 财务三表 / 公告 / 龙虎榜 / 融资融券 / 大宗交易 / 股东户数 / 分红 / 资金流 / 解禁 / 概念板块 / 打板情绪 / ETF 期权 / 互动易 / 全市场行业排名 …
- **给 agent 用**：用 Claude Code 等 agent 跑本仓库时，要调 A 股数据就看 [`a-stock-data/SKILL.md`](a-stock-data/SKILL.md)——每个接口都有 copy-paste 即用的代码。Vibe-Research 后端的数据层（`backend/astock.py`）也是从它移植的。
- **运行依赖**：`pip install mootdx requests pandas stockstats`（自包含，v3.0 起已移除 akshare 依赖）。
- **更新 / 上游**：<https://github.com/simonlin1212/a-stock-data> —— 想跟进最新端点、扩数据源，去这里看；**但即便你不更新，仓库自带的这份也是固定可用的快照，可以一直用。**

### 美股 / 港股数据 · global-stock-data

- **就在本仓库的 [`global-stock-data/`](global-stock-data/) 文件夹里**（v1.0.1）。8 层数据架构、18 个端点、零鉴权，覆盖美港股行情 / K线 / 技术指标 / 三表财报 / 资金流 / 期权 / SEC。
- 后端 `backend/gstock.py` 移植了**东财域内的合规子集**：全球指数（每日复盘「全球市场」栏）+ 美港股个股行情 & 关键财务指标（个股页输 `AAPL` / `00700` 即用）。东财调用复用 `astock.em_get`（直连优先，避开科学上网代理挂国内站）。
- **韩股**：东财已覆盖，个股页输 6 位代码**加 `.KS` 后缀**即可（如三星 `005930.KS`、SK 海力士 `000660.KS`）。⚠️ 韩股代码与 A 股同为 6 位数字，**必须带 `.KS` 后缀**才能被识别为韩股（否则按 A 股处理）；东财对韩股仅给行情、无财务。台股走美股 ADR（如台积电 `TSM`）。
- **上游**：<https://github.com/simonlin1212/global-stock-data> —— 想要 K线 / 技术指标 / 期权 / SEC 等全量端点，去这里看。

### 全球资讯 · investment-news

- 12 赛道 108 个公开 RSS 源，已并入 `backend/newsradar.py` + `backend/news_sources.json`：纯标准库、零 key、已按合规词表过滤（剔除赌 / 预测市场 / 加密等）。
- **上游**：<https://github.com/simonlin1212/investment-news>

> 数据均来自公开源。Vibe-Research 只做客观信息整理与公开榜单呈现（连板股 / 成交额榜等，与东财 / 同花顺同款客观数据），**只呈现事实、不推荐个股、不预测涨跌、不给买卖时机、不做主观评分**；用这些数据做什么分析、看什么方向，由你和你自己的 AI 决定。

## 🏗 架构

一套数据层 + 两条 AI 出口：

```
Vibe-Research/
├── a-stock-data/      A 股全栈数据工具箱（数据源，v3.3，自带即用）
├── global-stock-data/ 美股 / 港股数据工具箱（数据源，v1.0.1，自带即用）
├── backend/           FastAPI :8900
│   ├── astock.py        A 股数据（移植自 a-stock-data）
│   ├── gstock.py        美股 / 港股数据（移植自 global-stock-data）
│   ├── newsradar.py     资讯雷达（移植自 investment-news）
│   ├── market.py        市场情绪 + 板块资金流 + 全球指数
│   ├── portfolio.py     持仓 + 已清仓（存本地用户目录）
│   ├── chat.py          系统 AI（OpenAI 兼容 function-calling）
│   └── mcp_server.py    MCP server（给 Claude Code 等 agent）
└── frontend/          Vite + React 19 + TS + Tailwind（玻璃暖橙主题）:5899
```

**分级依赖**：行情（腾讯）+ 研报 / 公告（东财）**秒装可用**；akshare / mootdx 惰性导入，缺失时对应端点返回 501 + 安装提示，不拖垮服务。

## 🚀 快速开始

```bash
# 后端（:8900）
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8900

# 前端（:5899）
cd frontend && npm install && npm run dev
# 浏览器打开 http://localhost:5899
```

### Docker Compose 部署

需要 Docker Engine（含 Docker Compose）。Compose 会构建前端与后端，浏览器和 API 同源访问，后端不会直接暴露到宿主机。

```bash
cp .env.example .env
docker compose up -d --build
# 浏览器打开 http://127.0.0.1:8080
```

持仓和上传的研报会持久化在 `VR_DATA_DIR_HOST`（默认 `./data/`），升级时直接再次执行 `docker compose up -d --build` 即可；停止服务不删除数据。查看状态和日志：

```bash
docker compose ps
docker compose logs -f
```

默认只监听本机回环地址，适合个人部署。如需局域网或公网访问，请在 `.env` 中将 `VR_BIND_ADDRESS` 改为 `0.0.0.0`，并设置高强度 `VR_API_KEY`；打开网页后，在「接入 AI」页底部填入同一个后端访问密钥。通过公网反向代理时，也应将 `VR_ALLOW_ORIGINS` 收紧为你的站点域名。

## 🔌 接入 AI

在「接入 AI」页配置一次，全站的「问 AI / 复盘 / 今日要点」就都用你自己的模型。**分析都由你的模型给出，本产品不校准、无倾向。** 三种方式：

### 1. 订阅接入（调本机已登录的 CLI，免 API key）

用你自己的**订阅额度**，不用付 API 费。已支持：**Claude Code · Codex · Qwen Code · DeepSeek CLI**。

- **前提**：① 后端跑在你本机（云端读不到你本机 CLI）；② 对应 CLI 已安装并登录，命令在 `PATH` 上。例如：
  - Claude Code：`npm i -g @anthropic-ai/claude-code` → `claude`（用 Claude 订阅登录）
  - Codex：装 OpenAI Codex CLI → `codex login`（用 ChatGPT 订阅）
  - Qwen / DeepSeek：装各自 CLI 并登录
- 在「接入 AI 页 → 订阅接入」选一个即可，**无需填 key**。
- 原理：后端 `cli_runtime.py` 检测本机命令并 `spawn` 它一次性作答（数据已在提示词里）。⚠️ CLI 不做多轮工具调用，适合「复盘 / 今日要点 / 个股页问 AI」这类**数据已备好**的场景；要 AI 自己现场调数据工具的自由问答，用下面的「API 接入」。

### 2. API 接入（填自己的 key）

「接入 AI 页 → API 接入」选一个模型，**baseURL 自动填好**，只需粘 key。内置 **DeepSeek / 豆包 / MiniMax / OpenAI / OpenRouter / Groq / Together / MiMo / 任意 OpenAI 兼容端点**。这条支持 function-calling——AI 会自己调数据工具（行情/估值/研报/新闻）再作答。key 只存你本地浏览器、随请求发给你自己的后端、不上传、不进仓库。

### 3. MCP（给 Claude Code / 高手 agent）

把后端挂成 MCP server，agent 用自己的订阅额度调 Vibe-Research 的数据工具、多步分析。命令见 [`backend/README.md`](backend/README.md)。要更全量的 A 股数据端点，用根目录 [`a-stock-data/`](a-stock-data/SKILL.md) 工具箱。

## 🧪 测试

```bash
cd backend && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -m "not live"   # 离线单测 + API 校验（快、稳，无需联网）
.venv/bin/pytest -m live          # 联网核对数据源 shape（升级 / 发布前跑一遍）
```

## ⚖️ 合规

- 只做客观数据整理与公开榜单呈现：**不荐股、不预测涨跌、不给买卖时机、不承诺收益、不做主观评分**；中立无倾向。
- 连板股 / 成交额榜等均为**客观公开榜单数据**（东财 / 同花顺同款），产品只如实呈现、不附带任何推荐或预测。
- 所有分析方向由你自己配置的 AI 给出，与本产品无关。UI 无买卖按钮；估值历史分位只标位置、不划买卖线。
- **持仓 / 关注股 / 上传的研报 / API key 只存本地，不上传、不进仓库。**
- 持仓与上传的研报默认存在**用户目录 `~/.vibe-research/`**（可用环境变量 `VR_DATA_DIR` 换根目录、`VR_REPORTS_DIR` 单独指定研报目录）——在项目文件夹之外，**重新下载 / 覆盖更新项目文件夹不会丢数据**；旧版本存在 `backend/.cache/` 的数据，新版首次启动自动迁移（复制，原文件保留）。

## 🏛 相关生态

Vibe-Research 用到的数据 / 工具，来自同一套自研开源体系（都在 [`simonlin1212`](https://github.com/simonlin1212)）：

| 仓库 | 定位 |
|---|---|
| [**a-stock-data**](https://github.com/simonlin1212/a-stock-data) | A 股全栈数据工具包（10 层 · 40 端点）—— 本项目的 A 股数据引擎 |
| [**global-stock-data**](https://github.com/simonlin1212/global-stock-data) | 美股 / 港股全栈数据工具包（7 层 · 17 端点） |
| [**investment-news**](https://github.com/simonlin1212/investment-news) | 全球产业链资讯看板（12 赛道一一对应 A 股板块）—— 本项目的资讯源 |
| [**Agent-Staff**](https://github.com/simonlin1212/Agent-Staff) | 把公司 Agent 化：每部门一个 AI agent + CEO 参谋长，常驻飞书 |

## 📬 联系作者

作者 **Simon**，独立开发者。

- 🌐 主页：<https://www.simonlin.net>
- 💬 欢迎交流**企业 AI 落地方案**；项目相关问题也可提 [Issue](https://github.com/simonlin1212/Vibe-Research/issues)。

## 🙏 致谢

- A 股数据引擎：[a-stock-data](https://github.com/simonlin1212/a-stock-data)（作者：Simonlin1212）
- 美股 / 港股数据引擎：[global-stock-data](https://github.com/simonlin1212/global-stock-data)（作者：Simonlin1212）
- 资讯：[investment-news](https://github.com/simonlin1212/investment-news)（作者：Simonlin1212）
- 界面设计语言参考并致谢：[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（作者：HKUDS · 仅借鉴 UI，底层为全新实现）

## ⚠️ 免责声明

本项目仅供学习与研究，**不构成任何投资建议**。看板只做客观数据整理与公开榜单呈现——不推荐个股、不预测涨跌、不给买卖时机、不承诺收益；所有分析方向由你自己配置的 AI 给出，与本产品无关。股市有风险，请独立决策、自行核实，风险自担。

## 📄 License

MIT
