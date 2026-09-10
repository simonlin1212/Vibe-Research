<p align="center"><a href="README.md">简体中文</a> | <b>English</b></p>

<h1 align="center">Vibe Research</h1>

<p align="center">
  <b>Connect your AI, chat directly, and enable the Agent when research is needed</b><br>
  Codex / Claude Code / WorkBuddy subscriptions or model APIs · Agent off by default · Enable it in the upper-left corner
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
  <a href="CHANGELOG.md"><img alt="Source v1.2.0" src="https://img.shields.io/badge/source-v1.2.0-F35D2B"></a>
  <img alt="UI" src="https://img.shields.io/badge/UI-React%20%2B%20Vite-646cff">
  <img alt="Agent off by default" src="https://img.shields.io/badge/Agent-opt--in-555">
  <img alt="Codex Harness" src="https://img.shields.io/badge/runtime-Codex%20Harness-black">
</p>

<p align="center">
  <a href="https://viberesearch.wiki">Website</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#what-you-can-do-with-vibe-research">Features</a> ·
  <a href="#connect-ai">Connect AI</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#security-and-privacy">Privacy</a> ·
  <a href="#development-and-tests">Development</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

Vibe-Research is an AI research workbench for individual investors, bringing market news, industry tracking, company research, and document management together so research can be checked and built on over time.

---

## The Author Is Open to Opportunities

The author is open to AI roles at Tencent and other leading technology companies in Shenzhen, and hopes to join a team passionate about AI development. Areas of interest include AI / Agent product development, real-world deployment, and AI consulting.

Contact: [simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)

---

## Screenshots

Actual **v1.1.0** UI, captured on September 7, 2026. Chat is available on the home page, with Agent mode off by default. Enable it for web-backed questions and multi-step research. The current product UI is in Chinese.

![Dark home page: ordinary chat, Agent switch, and five groups of research tools](assets/screenshots/2026-09-07/home-dark.png)

<details>
<summary>Light theme: the same layout with a warm-orange chat area</summary>

![Light home page with chat and five feature groups](assets/screenshots/2026-09-07/home-light.png)

</details>

Captured in an isolated, empty workspace with no AI connected and no private holdings, reports, or credentials. See [capture notes](assets/screenshots/2026-09-07/README.md).

## What you can do with Vibe Research

Start with market changes, identify industries and companies to follow, then check ideas, organize documents, and keep your research records. The table covers all **13 primary sidebar entries**. Groups are for this overview only; they do not rename the product's navigation. The current UI is in Chinese.

| Purpose | Primary entry | What it does |
|---|---|---|
| Get started | Home | Chat with AI, frame a research question, and open features from grouped cards |
| Follow markets | Daily review | Review market performance, fund flows, consecutive limit-up data, and the day's changes |
| Follow markets | Intelligence radar | Browse news, company filings, and event leads that warrant further checking |
| Follow industries | Industry signals | Track supply-chain signals such as GPU rental rates, monthly industry data, raw materials, and hiring |
| Follow industries | Sector center | Explore industry themes, supply-chain segments, and related companies by sector |
| Research and verify | Company research | Work through business, financials, earnings expectations, valuation, and risks to produce an evidence-backed report |
| Research and verify | Bull/bear debate | Compare supporting and opposing views to find missing assumptions, risks, and counterevidence |
| Research and verify | Backtesting | Describe an idea in chat and check a defined rule against historical data |
| Organize and retain | Watchlist | Manage companies of interest, refresh quotes, and keep following them |
| Organize and retain | My portfolio | Organize holdings and ledger entries alongside quotes; this is not an order-entry tool |
| Organize and retain | My reports | Import, read, and search personal documents; ask questions and check the source text |
| Organize and retain | Research records | Revisit, search, and manage research, backtest, and debate reports by date |
| Connect a model | Connect AI | Connect a subscription or model API, then use the tested configuration across AI entry points |

### Home: start with a question

After connecting AI, ask questions directly on the home page. Other sections also have a chat button in the upper-right corner for discussing the current page.

**The Agent is off by default.** Ordinary chat suits framing ideas, explaining concepts, and translation. Enable the Agent in the upper-left corner for web research, data retrieval, calculations, or multi-step work. It can investigate further, but usually takes longer and consumes more tokens. The switch keeps your chosen AI source; no new connection is required.

Background research starts after confirmation; an ordinary conversation does not automatically become a full research run. You can also browse sections before connecting AI.

### Company research: work from the business to its risks

Choose an A-share company and work through **company profile → financials → earnings expectations → valuation → risk → report**. Alongside the report, the run retains source material, calculation records, conflicts between sources, and data gaps.

View progress, request a stop, and check the run's status after refreshing the page. A stop request is not a stop confirmation; the interface distinguishes them. The complete six-stage workflow currently supports A-shares only. See [Data and markets](#data-and-markets) for US and Hong Kong coverage.

### Documents and evidence: go back to the source

Import PDF, DOCX, TXT, MD, or CSV files into My reports to read, search, and discuss them. Document citations let you check the original text; text PDFs retain page references, while scanned PDFs need OCR first.

Company research retains sources and reporting periods for raw data, and inputs and results for calculated figures. Conflicts and gaps are recorded rather than treated as zero or presented as completed, verified results. **A citation does not prove an inference is correct: check the source and calculation assumptions.**

Original research documents are stored and parsed locally; matching passages are sent to the selected model. Local storage does not mean everything runs offline.

### Debate and backtesting: check an idea from different angles

**Bull/bear debate** brings different analytical perspectives to the same material. Review supporting arguments, risk explanations, and rebuttals to identify unresolved disagreements.

**Backtesting** checks explicit historical rules. Describe the question in ordinary language, supply any missing conditions, and let the backtest tool run once those conditions are sufficient. Failures and unsupported conditions are disclosed; an unexecuted task is not presented as a result.

Both require the Agent to be enabled. Reports are saved in Research records for later search, comparison, and review. Historical performance does not predict future results or constitute a trading recommendation.

### Watchlist, holdings, and records: retain your work

Watchlist holds companies you follow, My portfolio organizes existing holdings, and the Research records section retains research outputs. A-share, US, and Hong Kong symbols are supported in watchlists and portfolio records.

Images and tables can be transcribed into watchlist or portfolio drafts. **Review them before explicitly saving**; an upload does not automatically change the ledger. Selected content is sent to the current AI provider, so remove unrelated sensitive information first. Transcription temporary files are cleaned up after success, failure, or cancellation; keep the originals for checking. Local cleanup does not mean the model provider deletes content already received.

## Connect AI

**Already using WorkBuddy? You can connect it to Vibe Research.** Use your own subscription or model API. Once connected, you do not need to keep choosing a source.

| Connection | What you provide |
|---|---|
| WorkBuddy / CodeBuddy | A locally installed, signed-in WorkBuddy app or Tencent's official CodeBuddy Code CLI |
| Codex subscription | ChatGPT authorization through the product-specific login |
| Claude subscription | A locally installed, signed-in Claude Code |
| Model API | Your own compatible DeepSeek, MiMo, OpenAI, or other endpoint, model, and API key |

Each service requires the appropriate installation, login, compatible interface, and available quota. No subscription is included. Passing a connection probe does not verify every workflow or provider.

![Connect AI: choose an existing subscription or another API connection method](assets/screenshots/2026-09-07/connect-ai.png)

This v1.1.0 connection dialog was captured in an isolated, unsigned-in workspace on September 7, 2026. It does not show a current account status.

### First connection

The home page opens with a chat box. If no AI is connected, a setup dialog offers one-click testing and saving for
an already signed-in Codex, Claude Code, or WorkBuddy subscription. The **Other connection methods** option opens Settings
for API configuration and login help. A new connection leaves the Agent off by default; future visits go straight
to chat, and the upper-left label shows the saved source. The dialog can be dismissed to browse features first.
Suggested research questions appear in chat, with existing features grouped into five categories below it.
Enable the Agent for current data and multi-step research. Explicit choices persist across reloads and re-testing the same source.
Subscription chat still starts its original client; response times are not guaranteed.

For ChatGPT subscription access, start the UI, open **Connect AI → Subscription**, and click **Log in to Codex**.
Complete authorization on the official OpenAI page that opens, return to Settings, and click **Test and save**
after the login status turns ready. The product uses its own `.local/codex-home` and never reads or overwrites
`~/.codex`. If the authorization page does not open, return to Settings and click **Log in to Codex** again. If the
local status is still unclear, run `scripts/doctor` (or `scripts\doctor.ps1` on Windows) for an actionable diagnosis.

For Claude.ai subscription access, install and log in to Claude Code. The settings page detects it automatically;
no Claude API key needs to be entered into Vibe Research.

For WorkBuddy / CodeBuddy access, Settings directly detects the official CodeBuddy Code CLI bundled with an installed,
signed-in WorkBuddy desktop app. No second installation or login is required. Users without the desktop app can instead
install Tencent's CLI with `npm install -g @tencent-ai/codebuddy-code` and run `codebuddy` once to sign in. Neither path
requires entering a token or API key into Vibe Research.

For API access, open **Connect AI → API access**, choose a provider, enter the API base URL, model name, and key,
then click **Test and save**. A real model request must succeed before the new configuration is saved and shared
across the product. The same probe records whether the provider supports the verified direct-mode contract.
If asked to reconnect, check whether login is incomplete, expired, or the connection probe failed. Follow the specific error shown; not every connection failure means the subscription has expired.

<details>
<summary>Connection details, tool permissions, and LAN boundaries</summary>

- The Agent Runtime manages local context, tool calls, task state, progress, and failure handling. Codex subscriptions use the Codex Harness; Claude subscriptions use the Claude Code Agent; WorkBuddy / CodeBuddy uses the CodeBuddy Code Agent. They are not presented as the same runtime.
- The Claude Code and WorkBuddy / CodeBuddy Agents can run the full six-stage A-share workflow. Each stage uses a separate session with access only to the controlled Vibe Research MCP, and the runtime is never silently switched to Codex.
- The AI source can be a subscription login or the user's Model Provider API. A new source defaults to Agent off; re-testing the same source preserves an explicit choice.
- Direct mode does not run the Agent, call tools, or preserve Agent task memory. Six-stage research, bull/bear debate, and Agent-guided backtesting clearly ask the user to re-enable the Agent instead of silently degrading.
- Codex subscription mode uses the product's own `CODEX_HOME` and never reads or writes the user's `~/.codex`. Claude and CodeBuddy subscription modes reuse their own local login. Ordinary chat disables all tools and MCP; six-stage research disables built-in tools and exposes only the controlled product MCP. User settings and automatic memory remain off. If WorkBuddy bundles an older CLI without a no-session-persistence flag, the entire answer runs under a disposable temporary home that is deleted afterward.
- Both subscription and API configurations must pass a real conversation probe before **Test and save** updates the active configuration.
- In API mode, the key persists in the current browser profile's local `localStorage` so it does not need to be entered again.
  It is not an OS keychain and encryption is not guaranteed, so use it only on a trusted personal computer and clear it after
  use on a shared machine. It is sent to the local backend per request and is not written to the repository, backend
  configuration, run ledger, or logs.

Built-in provider templates: OpenAI, DeepSeek, Qwen, GLM, Kimi, MiMo, and an unverified `selfhosted` placeholder. The Codex Harness API path supports the Responses
API; the direct channel uses the separately declared and verified protocol in each provider profile. A template's
presence does not mean it passed the compatibility matrix. Ordinary chat does not mark an unverified profile as a verified direct API.

See [docs/model-access.md](docs/model-access.md) and [providers/README.md](providers/README.md).

LAN access is optional and off by default. From the repository root, run `VRA_LAN=1 bash scripts/start`;
in Windows PowerShell, set `$env:VRA_LAN="1"` and run `scripts/start.ps1`. Only the UI is exposed; the backend stays on loopback.
With the backend already running, `VRA_LAN=1 npm run dev --prefix desktop` also starts the UI.
**Trusted LANs only**: this shares a single-user workspace, not separate accounts. Anyone who can reach the port can operate it.
HTTP is unencrypted; API keys and research data may travel in plaintext. Never expose this port publicly or on an untrusted network.
The proxy checks the browser origin before normalizing it. Remote model endpoints still require HTTPS; loopback HTTP is supported.
See [model access and LAN boundaries](docs/model-access.md#3-自托管模型与局域网访问) (Chinese).

</details>

## Quick start

### Run from source

Version **v1.2.0** provides open-source code and a local browser workbench for customization with your coding agent. The Mac client is temporarily withdrawn; the v1.1.0 DMG was also removed from GitHub on September 10, 2026. Release history and source archives remain. Existing client data is not migrated automatically; see the [source delivery notes](docs/source-delivery.md) (Chinese).

macOS, Windows, and Linux all use the source workflow below. The workbench runs locally, not on a hosted research service. Install Node.js, Python, and Git before initializing the project.

Open the cloned repository in your coding agent to customize pages and features. `desktop/` contains the browser frontend, not a native Mac client. Validate changes with the [development commands](#development-and-tests).

### Requirements

| Item | Requirement |
|---|---|
| Operating system | Windows 11, macOS, or Linux; Windows runs natively and does not require WSL |
| Node.js | ≥ 22.18; Node 24 LTS recommended |
| Python | ≥ 3.11; Python 3.12 recommended and currently verified |
| Agent engine | Codex Harness is installed with the product dependencies; the development branch pins version 0.153.4, verified locally; no global Codex install required |
| Model access | Codex / Claude Code / WorkBuddy subscription login, or a model API compatible with the selected execution mode |

> Node must be a build with TypeScript support enabled (the official nodejs.org installers and anything installed via nvm / fnm / Volta are): `node -p process.features.typescript` should print `strip` or `transform`. Some Linux distribution packages ship Node compiled without it; starting the app or running tests then fails with `ERR_UNKNOWN_FILE_EXTENSION ".ts"` / `ERR_NO_TYPESCRIPT` — switch to an official build. `npm test` runs this check first and prints the same guidance.

### Install dependencies

> If you already have a source checkout, back up your data before updating the code and running setup; there is no need to clone again. Existing Mac client data is not migrated automatically. Keep `~/.vibe-research-desktop` intact and never commit it to a repository.

Windows (PowerShell or Command Prompt):

```bat
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent
scripts\setup-windows.cmd
scripts\start.cmd
```

`setup-windows.cmd` creates `.venv`, installs Node/Python dependencies, initializes the private product data
directory, and runs diagnostics. `start.cmd` starts the local API and browser UI and opens
`http://127.0.0.1:5930`.

macOS / Linux:

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent
scripts/setup
scripts/start
```

`scripts/setup` creates `.venv`, installs the bundled Agent engine and all Node/Python dependencies, initializes the
private data directory, and runs diagnostics. `scripts/start` checks the installation and fixed ports, starts both
services, and opens the browser only after both are healthy. No global Codex install or second terminal is required.

### Start the browser UI

Run `scripts\start.cmd` on Windows or `scripts/start` on macOS / Linux. Both commands manage the local API and UI
together at [http://127.0.0.1:5930](http://127.0.0.1:5930). On macOS / Linux, use `scripts/start --no-open` to skip
opening the browser automatically; Ctrl+C stops both processes.

Vite proxies `/api/*` locally and adds authentication on the server side. If `VRA_DATA_ROOT` is set, both
processes must use the same value.

## Data and markets

- Current registry: **117 endpoints across 30 layers**, covering CN, US, and HK.
- Data includes quotes, candles, financial statements, consensus, filings, reports, fund flows, positioning,
  options, SEC/FINRA/CBOE, news, macro data, industry thermometers, hiring, restrictions, and data calendars.
- A-share, US, and Hong Kong symbols work in the watchlist, portfolio, document library, and agent conversations.
- **The six-stage company research workflow currently supports A-shares only.** It will not launch an empty
  US or Hong Kong research run without the required data chain.
- Scanned PDFs require OCR. Text PDFs preserve page-level citations.

See [datasources/CATALOG.md](datasources/CATALOG.md) for the endpoint catalog.

## Security and privacy

- With Agent enabled, public-page reading may use the third-party Jina Reader service. The target URL, including its query parameters, is sent to that service. Do not submit URLs containing private tokens, internal documents, or signed download credentials. Search queries are also sent to the selected search service.

- Original research documents stay on the local machine. The model receives only passages selected by server-side search.
- Keys for the backend's default provider come only from environment variables and are not written to product configuration or the repository.
- An API key entered in the browser persists in that browser profile's local `localStorage`; it is not an OS keychain and encryption is not guaranteed. It is sent through the local backend to the selected model provider only when used and is not written to backend configuration or logs.
- Ordinary chat does not call tools. With Agent enabled, chat can use product-provided web and research tools. Bounded tasks such as document extraction retain task-specific execution restrictions.
- Document citations use `[资料:<id> p.<page>]`. Missing, incorrect, or unknown citations are rejected by code.
- Research-stage agents have no network access. The orchestrator fetches data through controlled scripts and stores
  raw responses with hashes.
- The local API binds to `127.0.0.1` by default. Write requests require authentication and JSON.
- Output is limited to data, analytical frameworks, scenario probabilities, and decision checkpoints. It does not
  provide position, sizing, target-price, or stop-loss instructions.

## Current boundaries

- Current delivery is source code and a local browser UI only, without native Mac client build tools. The v1.1.0 DMG has been withdrawn; release history and source archives remain.
- MiMo API has passed an end-to-end run from an empty configuration to a real business report. Other third-party
  providers still require the user's own keys and are not marked verified without real compatibility-matrix runs.
- Native Windows 11 support includes PowerShell setup/start scripts, Windows path and process handling, and the
  controlled research toolchain. CI configuration includes `windows-latest`, `macos-latest`, and `ubuntu-latest`;
  Windows runs selected cross-platform contract tests, not the entire backend suite. Physical Windows hardware and a Job Object guarantee for child-process cleanup after normal exit have not been validated.
  Windows 10 is best-effort, following upstream Codex support.
- Running from source requires local dependencies. A registered endpoint is not a guarantee of third-party uptime.

## How it works

```text
Local browser workbench
Home agent · review · intelligence · company research · backtesting · document library
        │
        ▼
Finance agent layer
117 data endpoints · six-stage SOP · calc · validator · report archive
        │
        ▼
Local Agent Runtime and Model Provider
Route by the selected source (alternative paths, not a chain)
├─ Codex subscription / compatible Responses API → Codex Harness
├─ Claude subscription → Claude Code CLI
├─ WorkBuddy / CodeBuddy → CodeBuddy Code CLI
└─ Ordinary chat with a verified API → direct model request, no Agent tools
```

The project enforces its rules at three levels:

| Layer | Components | Purpose |
|---|---|---|
| Instruction | `AGENTS.md` + `.agents/skills/` | Defines financial research discipline and procedures |
| Execution | Runtime-specific sandbox / hooks / controlled MCP | Restricts network, file access, data fetching, and output locations by task |
| Orchestration | orchestrator + validator + calc + gate | Enforces stages, citations, deterministic calculations, and compliance |

The project does not modify Codex source code. The Codex checkout is an upstream reference only; the product uses
the official CLI and SDK.

## Project structure

| Path | Purpose |
|---|---|
| `desktop/` | React + Vite local browser UI |
| `orchestrator/` | Agent orchestration, validators, API, MCP, chat, document library, and report archive |
| `backtest/` | Deterministic backtest engine and tool entry point |
| `calc/` | Deterministic calculation library |
| `datasources/` | Endpoint registry, catalog, and health checks |
| `.agents/skills/` | Financial research procedures and data tools |
| `providers/` | Provider templates with no secrets |
| `scripts/` | Initialisation and diagnostics |
| `.local/` | Private user data, reports, sessions, and run artifacts; gitignored |

## Development and tests

### Run one research job from the command line

Windows PowerShell:

```powershell
node orchestrator/src/run.ts `
  --symbol 300308 `
  --market SZ `
  --python "$PWD\.venv\Scripts\python.exe"
```

Windows automatically uses the `controlled_mcp` execution layer. The research thread has no shell access and no
workspace write permission; it can only read sanitized run files, call deterministic calculations, and write the
current stage through controlled tools. macOS and Linux keep the existing hook-based execution layer.

macOS / Linux:

```bash
node orchestrator/src/run.ts \
  --symbol 300308 \
  --market SZ \
  --python "$(pwd)/.venv/bin/python" < /dev/null
```

A full run depends on data scope, model response times, and validation retries; it can take tens of minutes or longer, with no fixed duration guaranteed. Progress remains visible, and results are written to
`.local/runs/<run-id>/`. Exit codes: `0` complete, `2` incomplete/stale, and `3` failed.

### Research run artifacts

A six-stage research run produces:

- `report.md`: the final research report.
- `evidence.json`: evidence used in the run, including source, date, and raw reference.
- `calculations.json`: deterministic inputs, functions, and calculation DAGs.
- `conflicts.json`: disagreements between sources, without silent resolution.
- `manifest.json`: model, version, stages, status, recalled documents, and run metadata.
- `viewer.html`: a browser-readable evidence and report viewer.

### Regression checks

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

Latest local acceptance checks (September 9, 2026, v1.2.0 source edition):

- orchestrator: the serial Node 26 run reported **853 tests: 852 passed, one Windows-only ACL test skipped**; typecheck passed. Historical concurrent-test wait timeouts remain disclosed rather than erased by the serial result.
- desktop: **84/84**, with typecheck and production build passing; Python (calculation library, backtest, and data scripts): **754/754**.

- Current fixes, browser checks, and privacy checks are recorded in the [v1.2.0 Issue / PR triage](docs/issue-pr-triage-v1.2.0.md) (Chinese). This round did not rerun live models, every external data endpoint, or physical Windows hardware.
- Incremental fixes passed independent review and follow-up review; see the [source delivery notes](docs/source-delivery.md) (Chinese). Historical business validation remains in [M40 acceptance](docs/发布候选与隐私验收_M40_2026-09-07.md) (Chinese), not as full business acceptance of this revision.

Project rule: test each completed component, run an independent Codex review, verify every finding, fix valid issues,
and re-review. A component is not described as complete and is not committed or pushed before that loop closes.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

<details>
<summary>Compare with the historical v1.0.4 release</summary>

The baseline is the [v1.0.4 release](https://github.com/simonlin1212/Vibe-Research/releases/tag/v1.0.4) and [README at that tag](https://github.com/simonlin1212/Vibe-Research/blob/v1.0.4/README.md), checked on September 7, 2026. The right column describes v1.2.0 source delivery. Changes since v1.1.0 are listed in the [CHANGELOG](CHANGELOG.md).

| Area | Historical public v1.0.4 | v1.2.0 source |
|---|---|---|
| Delivery | Open-source code and a local browser workbench | Source code and a local browser workbench; the Mac wrapper is temporarily withdrawn to simplify agent-assisted customization |
| Subscriptions | Codex and Claude Code, alongside API access | Adds WorkBuddy / CodeBuddy, quick connection tests on the home page, and the actual saved source label |
| Home and everyday chat | Already included home Agent chat and research sections | Ordinary chat by default, opt-in Agent; keeps sidebar sections, groups home shortcuts into five categories, and unifies orange light/dark themes |
| Chat tools | Claude subscription chat disabled tools and networking | With Agent enabled: search, public page reading, data, and calculations; background research requires confirmation and replies show actual tool calls |
| Portfolio and watchlist | Symbol entry, local records, and quote refresh | Adds image/table transcription drafts that require review and explicit saving |
| Research experience | Already included six-stage research, evidence validation, a document library, debate, and backtesting | Retains and refines these capabilities, with improved report/source panels, cancellation, refresh recovery, and source binding |
| Setup and engine | Codex 0.149.0; Mac/Linux instructions started backend and UI separately | Retains engine 0.153.4; setup installs dependencies and start launches both services |

The comparison describes the v1.2.0 source-only revision; see [boundaries](#current-boundaries).

</details>

## Disclaimer

This project produces research data, analytical frameworks, scenario probabilities, and decision checkpoints only.
It does not provide investment-action instructions. Nothing produced by this project is investment advice.
Third-party public data may be delayed, incomplete, or wrong. Users are responsible for verification, decisions,
and compliance with each data source's terms.

## Support

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

This repository is licensed under the [MIT License](LICENSE). OpenAI Codex is licensed under Apache-2.0; this
repository does not contain Codex source code.

**Author:** Simon Lin · X [@linsizhen](https://x.com/linsizhen) · Email: [simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
