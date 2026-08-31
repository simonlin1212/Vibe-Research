<p align="center"><a href="README.md">简体中文</a> | <b>English</b></p>

<h1 align="center">Vibe-Research · Your Personal AI Research Dashboard (A-share / US / HK)</h1>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![GitHub stars](https://img.shields.io/github/stars/simonlin1212/Vibe-Research?style=social)](https://github.com/simonlin1212/Vibe-Research/stargazers)
[![中文 README](https://img.shields.io/badge/📖_中文-README-F35D2B?style=flat)](README.md)

<p align="center">
  <a href="https://viberesearch.wiki">Website</a> ·
  <a href="#features">Features</a> ·
  <a href="#data-sources">Data Sources</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#bring-your-own-ai">Bring Your Own AI</a> ·
  <a href="#compliance">Compliance</a>
</p>

> **Vibe-Research: Your Personal Trading Research Agent.**
>
> An open dashboard for China A-share (plus US / HK): it wires up all the data and plugs into **your own AI / agent** — it never recommends a stock. You bring the model, it brings the data.

Vibe-Research is an open-source research dashboard built primarily for **China A-share**, with US and HK markets included (A-share traders usually check overnight Wall Street and Hong Kong first, so the data is wired up too).

It does not make decisions for you. It pulls together quotes, analyst reports, valuation, financials, filings, fund flows and news into one clean dashboard, then leaves an interface where **you plug in your own AI**. The direction and the conclusions come from the model or agent *you* configure.

**Reading model**: the A-share review page is a one-screen cockpit (no desktop scroll). Other pages share the same navy/cyan shell; click a panel to zoom.

## Features

| Page | What's in it |
|---|---|
| 🇨🇳&nbsp;**A-share** | Header: **Review** / **K-line**. Site-wide ticker tape under the header (world indices + gold/oil/BTC, shares the 5s quote hub). Review is a one-screen cockpit: **world indices** (CN/HK/US/FX) / sentiment / **watchlist (top-right)** / **live sector boards** (leaders left / laggards right; click a board to open constituents on the other half) / **intraday board-flow** (click to filter) / **main-force inflow rank** / **stock ranks with turnover** / **commodities** (futures + **Sunsirs spot/basis**) / limit pools / LHB · funds · 8 industry chains. 7×24 news is not a review cell; toasts still pop site-wide, full feed stays on `/event`. |
| 🪟&nbsp;**Earnings** | Header `/fin`: same two-row seven-panel layout as the reference cockpit. 21-day calendar, forecasts, industry treemap, stock ranks, company cards + mainop, 12-period trend, peers. Defaults to Kweichow Moutai. Board + F10 fetch Eastmoney in parallel; no valuation/filings pile-on |
| 🤖&nbsp;**AI Watch** | OpenRouter public-cloud token share · TrakToken LLM price trend / cut events · AA model table + intelligence×cost scatter (optional key) · AI infra CapEx/ROI (SEC + labeled forecast) |
| 📡&nbsp;**News&nbsp;Radar** | Review news cell: CLS + Sina/Wallstreetcn 7×24 (tags + NEW) |
| ⭐&nbsp;**Watchlist** | **Paste a whole batch of tickers at once** (commas, spaces or newlines) · one-screen table (price, change, PE, PB, turnover) · **live quotes toggle** (top right, off by default; refreshes every 3s during trading hours, auto-pauses outside them and when the tab is hidden) · hand the whole list to your AI. Stored locally |
| 💼&nbsp;**Portfolio** | Enter cost and size, see live P&L · closed-position log (local only, never uploaded). **Futures account**: CTP read-only |
| 🌊&nbsp;**Options/Futures** | Header `/derivatives` (next to A-share; old `/ovlab` bookmarks redirect): one-screen cockpit — market watch (parked-capital: futures = OI×price×mult×9qihuo exchange margin, ETF = shares × last), near-expiry calendar, term structure + warehouse receipts, flow alerts, T-quote (LC IV smile + ATM term on the left, same tquote, OpenVlab hover cards) with option/underlying charts. OpenVlab public REST; MQTT overlays REST in memory (`VR_OVLAB_MQTT=0` off). CTP stays on Portfolio |
| ⚖️&nbsp;**Arb** | Header `/arb` (next to Options/Futures): one-screen cockpit — calendar spreads, inter-commodity spreads, index/ETF basis + Sunsirs spot/basis, click a pair for spread chart + warehouse receipts. OpenVlab `future-ts` board; cash legs use the quote hub. Facts only, no scores |
| 🗞️&nbsp;**Events** | Header `/event` (next to Arb): live news (same telegraph hub) + economic calendar (same Duanxianxia timeline as Jiuyan) |
| ⚡&nbsp;**Duanxianxia** | Header `/dxx` (next to Events): auction seals, limit-up tape, upstream emotion fields (not our scores), plate strength, review/mining hit counts. Public no-login feeds only. Click a code for A-share charts |
| 🔬&nbsp;**Research desk** | Header `/research`: correlation heatmap · ETF look-through (Eastmoney full book / SEC N-PORT) · 13F QoQ · Stooq/Baostock/pykrx candles. Public filings only; holdings are stale by construction |
| 🧪&nbsp;**Backtest** | Header `/backtest`: account + factor + model. Weekly/monthly factor rebalance uses the last session of the trading week/month. Default ST / new-list screen. `top_k` target weights, name cap, industry-neutral, Sortino. Optional LightGBM scores feed the same matcher. Grid fits on the IS cut |
| 🗄️&nbsp;**Data** | More menu `/data`: local calendar, daily-bar coverage, experiments. Can fill the last 3y of closed bars for the A-share universe |
| 🔌&nbsp;**Bring Your AI** | Subscription mode (local CLI, no API key) · API mode (any OpenAI-compatible endpoint) · MCP (mount into Claude Code and other agents) |

> **Built-in analysis framework**: when your AI analyzes a stock it organizes findings across five dimensions — valuation, fund flows, earnings quality, industry cycle, catalysts and risks.

## Data Sources

Three public data toolkits are **vendored directly into this repo** — `git clone` and everything works, no extra downloads or wiring.

### A-share full-stack data · AStockData

- Lives in [`a-stock-data/`](a-stock-data/) (v3.6.0, agent reference snapshot). Ten data layers, 47 endpoints (44 primary + 3 official backups), 15 sources. **The running service is `backend/astock.py`** (ported from this toolkit; `norm_ticker` / quote `is_stale` / old BJ prefixes are in runtime). [`a-stock-data/SKILL.md`](a-stock-data/SKILL.md) **embeds every call as runnable code** — self-contained, with built-in rate limiting for Eastmoney endpoints.
- **Covers**: quotes / candles / analyst reports / consensus estimates / valuation / historical percentiles / financial statements / filings / Dragon-Tiger list / margin trading / block trades / shareholder counts / dividends / fund flows / lockup expiry / concept sectors / limit-up sentiment / ETF options / investor Q&A / market-wide industry rankings.
- **Daily review snapshot / warmup**: `GET /api/market/review-snapshot` uses `scope=paint|top|full` so the first paint is Tencent + overview, then emotion + industry strength, then emotion ladders / dragon-tiger. `POST /api/market/review-context` packs the same board text for Ask AI and the scheduled review mail (one list, one packer). Index membership is the 15-code catalog (CSI 500 and CSI 1000). `em_get` has no launch gap (same as the reference cockpit). Breadth percentiles are a separate `/market/breadth` poll. Index minute sparks include US (`usIXIC` via Tencent `usMinute`) and USD/CNY (`whUSDCNY` via Eastmoney offshore `USDCNH`). Cockpit minutes use `GET /api/astock/light-kline-batch`. Live prices: the UI uses `GET /api/market/quotes` (same Tencent parser, 5s per-code cache; A-share closed stretches the hub, offshore quotes stay 5s; catalog indices stale-refresh on expire so the watch panel 5s poll moves; indices are never stored as bare 6-digit). `GET /api/quote` is a leftover adapter sharing that cache — new pages should not call it. Futures on `/commodities` in parallel; VIX falls back to Sina. Watchlist search uses `GET /api/fin/suggest`; visible rows batch industry/concept tags via `GET /api/market/stock-boards-batch` (skipped on sector constituent rows). The stock page reads industry/area/concepts from `/api/stock-basic` (same push2 call) and does not hit `/stock-boards` again. World-index minutes fire their own 14-code `light-kline-batch` immediately (not the stock minute hub); stock sparks still share a 20s hub (index/FX TTL 20s, stocks 120s). Commodity minutes fetch Sina in parallel. The K-line page uses the same `loadLightKline` cache for 1-minute bars (240). Chain refresh uses `GET /api/iwencai/select`. Background warmup also prefetches cockpit hot paths (world indices / sector boards / stock rank / main-force inflow / intraday board-flow / commodities). While a user snapshot is in flight, warmup still fills Tencent/Sina minute keys and skips Eastmoney steps. Board-flow inflow/outflow ranks run in parallel; butterfly curves start without waiting for emotion. Intraday board-flow is cached per board so a second hit does not fire 16 serial Eastmoney kline calls. The header tape shares `world-indices` with the cockpit panel. `GET /api/market/review-warmup` shows status; `VR_REVIEW_WARMUP=0` disables it.
- **Sunsirs spot (from the reference cockpit)**: `GET /api/market/spot-table` spot/futures/basis (8h cache, history in `~/.vibe-research/spot-history.json`) · `GET /api/market/chem-spot?id=` chemical-spot median. The commodities panel has a Spot tab.
- **Futures daily / stock boards / live wire**: `GET /api/market/future-daily?code=nf_AU0` (Sina) · `GET /api/market/stock-boards?code=600519` · `GET /api/market/stock-boards-batch?codes=` (Eastmoney industry/area/concepts) · `GET /api/market/lives` (Sina 7×24, Wallstreetcn fallback; not a cockpit cell).
- **Breadth percentiles / turnover rank / sealed boards / THS membership**: `GET /api/market/breadth` (all-A histogram + avg/median on the breadth panel; Sina `hs_a` is paged, ~100 names per page, then Tencent batch) · turnover / stock rank use Sina `hs_a` · emotion and limit pools share the raw Eastmoney four-pool cache (180s) · limit pools tag true/fake seals from Tencent bid1/ask1 (pool names only) · `GET /api/market/ths-profile` / `ths-rotation` (shy313 Tonghuashun concepts/industries, 24h cache in `~/.vibe-research/ths-ext.json`). Sector hotspot shows leading boards on the left and lagging boards on the right; click a board to open the existing constituent list on the other half (Tencent `getBoardRankList` / `pt*`; Eastmoney `ulist` still patches main-net). Removed unused/fallback Eastmoney quote paths (popularity rank, akshare profile, industry reports, board/rank/breadth/world-index fallbacks). Unique Eastmoney series (fund flow, limit pools, filings) stay.
- **For agents**: running this repo with Claude Code or similar? Point them at `SKILL.md` — every endpoint has copy-paste ready code. The backend data layer (`backend/astock.py`) is ported from it.
- **Runtime deps**: `pip install mootdx requests pandas stockstats`
- **Upstream**: <https://github.com/simonlin1212/a-stock-data> — the vendored copy is a pinned snapshot and keeps working even if you never update it.

### US / HK data · global-stock-data

- Lives in [`global-stock-data/`](global-stock-data/) (v2.0.3). 13 data layers, 30+ endpoints, 11 sources, no auth required — quotes, candles, technicals, financial statements, options (CBOE official chain with full Greeks and 0DTE flow), FINRA short volume, SEC EDGAR filing stream + **EDGAR frames screener**, US/HK movers boards. Every source is labeled with its compliance tier.
- Dashboard: US page hosts EDGAR Screener, movers, and selected-ticker options; stock page shows US daily candles (`/api/global/us/kline` Sina). Research desk: `/api/research/*` (correlation, ETF holdings, 13F QoQ, extra klines).
- `backend/gstock.py` + `gstock_deep/`: global indices, US/HK quotes & key metrics, **Yahoo valuation/analyst/holders** (quoteSummary only; empty if Yahoo is down), **3-statement summaries & fund flow**, **CBOE options 0DTE/unusual flow**, **SEC filings / earnings calendar**, **Yahoo stock news (RSS fallback when crumb is blocked)**.
- Set `VR_SEC_CONTACT="Name you@example.com"` for SEC endpoints.
- **CBOE options**: compliance tier C — personal research only; commercial use needs a Cboe license. Delayed data, not for live trading.
- **Korean stocks**: append `.KS` (e.g. `005930.KS`); quotes plus daily bars on the research desk (`pip install pykrx`). Taiwan via US ADRs (e.g. `TSM`).
- **Upstream**: <https://github.com/simonlin1212/global-stock-data>

### Global news · investment-news

- 108 public RSS feeds across 12 industry tracks, merged into `backend/newsradar.py`. Standard library only, no API keys.
- **Upstream**: <https://github.com/simonlin1212/investment-news>

> All data comes from public sources. Vibe-Research only performs objective data aggregation and presents public rankings as-is — **it does not recommend stocks, predict price moves, time trades, or assign subjective scores**. What you do with the data is up to you and your AI.

## Architecture

For AI coding: see [CONTEXT.md](CONTEXT.md).

One data layer, three AI outlets:

```
Vibe-Research/
├── a-stock-data/      A-share data toolkit (vendored v3.6.0, ready to use)
├── global-stock-data/ US / HK data toolkit (vendored v2.0.3, ready to use)
├── backend/           FastAPI :8900
│   ├── astock.py        A-share data
│   ├── gstock.py        US / HK quotes & key metrics
│   ├── gstock_deep/     valuation / statements / SEC / short / calendar
│   ├── newsradar.py     News radar
│   ├── market.py        Market breadth + sector fund flows + global indices
│   ├── portfolio.py     Portfolio (stored in your local user directory)
│   ├── tools.py         AI tool layer (49 data tools, shared by chat / MCP)
│   ├── chat.py          In-app AI (OpenAI-compatible function calling)
│   └── mcp_server.py    MCP server (for Claude Code and other agents)
└── frontend/          Vite + React 19 + TS + Tailwind :5899; K/minute on lightweight-charts, heatmaps/term-structure on ECharts
```

**Tiered dependencies**: quotes (Tencent) and reports/filings (Eastmoney) work with a minimal install. `akshare` / `mootdx` are imported lazily — if missing, only those endpoints return 501 with an install hint; the service still runs.

## Quick Start

```bash
# Backend (:8900)
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8900

# Frontend (:5899)
cd frontend && npm install && npm run dev
# Open http://localhost:5899
```

## Bring Your Own AI

Configure once on the "Bring your AI" page and every AI feature across the dashboard uses your model. **All analysis comes from your model — this project does not tune or bias it.** Three options:

### 1. Subscription mode (uses a CLI you're already logged into — no API key)

Uses your existing subscription instead of paying per API call. Supported: **Claude Code · Codex · Qwen Code · DeepSeek CLI**.

- **Requirements**: the backend runs on your own machine, and the CLI is installed, logged in and on your `PATH`.
- Pick one on the "Bring your AI" page — no key needed.
- ⚠️ CLIs answer in one shot without multi-step tool calls, so this suits flows where the data is already prepared (daily review, takeaways, asking about the stock currently on screen). For open-ended questions where the AI should fetch data itself, use API mode.
- **Review snapshot**: "AI review / Ask AI" packs the current cockpit cells into one text blob (indices, breadth, limit boards, sectors, flows, ranks, commodities, full 7x24 telegraph text with tags, watchlist, dragon-tiger, rates). Missing cells are marked so the model does not invent numbers. See `frontend/src/lib/reviewContext.ts`.
- **Scheduled review email** (opt-in): toggle, time and recipient on the Bring-your-AI page. The browser key is not visible to the job — SMTP and model key stay in `backend/.env`.

### 2. API mode (bring your own key)

Pick a model and the base URL is filled in for you — just paste the key. Built-in presets for **DeepSeek / Doubao / MiniMax / OpenAI / OpenRouter / Groq / Together / MiMo / any OpenAI-compatible endpoint**. This mode supports function calling, so the AI fetches quotes, valuation, reports and news on its own. Your key stays in your browser's local storage and is sent only to your own backend.

### 3. MCP (for Claude Code and other agents)

Mount the backend as an MCP server so your agent can call Vibe-Research's data tools with its own subscription. See [`backend/README.md`](backend/README.md).

### 4. Scheduled review email

Toggle, time and recipient are on the Bring-your-AI page and take effect immediately. The browser key is invisible to the job — SMTP auth code and model key stay in `backend/.env`. Weekdays only, one mail per day, same review prompt as the web page.

## Tests

```bash
cd backend && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -m "not live"   # offline unit + API tests (fast, no network)
.venv/bin/pytest -m live         # verifies live data source shapes (run before releases)
```

A split-module leftover import fails as `NameError` before any upstream call. `tests/test_undefined_names.py` walks `backend/` symbol tables (stdlib only, no network) and fails on names used but never bound in that file.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). The single source of truth for the version is `frontend/package.json`; the backend API, the UI and the MCP `serverInfo` all read from it.

## Compliance

- Objective data aggregation and public-ranking display only: **no stock recommendations, no price predictions, no trade timing, no return promises, no subjective scoring.** Neutral by design.
- Limit-up lists and turnover rankings are **objective public data** (the same numbers Eastmoney and Tonghuashun publish); the product displays them as-is with nothing attached.
- All analytical direction comes from the AI *you* configure, not from this project. There are no buy/sell buttons in the UI, and valuation percentiles mark position only — no lines suggesting when to act.
- **Your portfolio, watchlist and API keys stay on your machine.** Nothing is uploaded; nothing enters the repo.
- Portfolio defaults to `~/.vibe-research/` (override with `VR_DATA_DIR`) — outside the project folder, so re-downloading or overwriting the project never loses your data.

## Related Projects

All from the same open-source stack ([`simonlin1212`](https://github.com/simonlin1212)):

| Repo | What it is |
|---|---|
| [**a-stock-data**](https://github.com/simonlin1212/a-stock-data) | A-share full-stack data toolkit (10 layers · 44 endpoints · 15 sources) — this project's A-share engine |
| [**global-stock-data**](https://github.com/simonlin1212/global-stock-data) | US / HK full-stack data toolkit (13 layers · 30+ endpoints · 11 sources) |
| [**investment-news**](https://github.com/simonlin1212/investment-news) | Global industry news dashboard (12 tracks mapped to A-share sectors) |
| [**Agent-Staff**](https://github.com/simonlin1212/Agent-Staff) | Agentify a company: one AI agent per department plus a chief-of-staff |

## Contact

Built by **Simon**, independent developer.

- 🐦 X: [@linsizhen](https://x.com/linsizhen)
- ✉️ Email: <simonlin0423@gmail.com>
- 💬 Happy to talk about **enterprise AI adoption**; for project issues please open an [Issue](https://github.com/simonlin1212/Vibe-Research/issues).

## Acknowledgements

- A-share data engine: [a-stock-data](https://github.com/simonlin1212/a-stock-data)
- US / HK data engine: [global-stock-data](https://github.com/simonlin1212/global-stock-data)
- News: [investment-news](https://github.com/simonlin1212/investment-news)
- UI design language referenced with thanks: [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) (UI inspiration only; the implementation here is separate)

## Disclaimer

This project is for learning and research purposes and **does not constitute investment advice**. The dashboard performs objective data aggregation and displays public rankings — it does not recommend stocks, predict price movements, time trades, or promise returns. All analytical conclusions come from the AI you configure yourself and have nothing to do with this project. Markets carry risk; verify independently and decide for yourself.

## License

MIT
