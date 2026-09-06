# 开发验证：先跑通产品，再集中跨模型验收

2026-09-06 开发约定：日常真实 Agent 联调优先 `gpt-5.3-codex-spark`；不可用时使用
GPT-5.6 系列（明确记录实际模型名，例如 `gpt-5.6-sol`）。这仅决定开发测试用的模型，
不修改产品默认值、不替客户选择来源，不改变已有 Claude Code / WorkBuddy / API 适配器。

## 三层验证

1. 每批修改先跑不调用真实模型的回归：前后端单测、Python 测试、类型检查与构建。
   这些测试中的订阅 CLI 使用可控替身，不需要消耗真实订阅额度。
2. 涉及 Agent 主流程时，在独立数据根做真实联调：先单阶段，再核心数据范围六阶段。
   `core` 缩小的是取数端点范围，不是删掉研究阶段，也不代表全端点验收。
3. 功能稳定后集中执行全数据范围、Claude Code / WorkBuddy、直连 API 以及 Windows 验收。
   开发期仍保留各适配器的自动契约测试和独立代码审查；已发现的超时等缺陷不得因延期而关闭。

## 零模型回归

在仓库根执行（先按安装说明准备依赖，Python 使用该安装的虚拟环境）：

```sh
npm test --prefix desktop
node --test --test-concurrency=1 orchestrator/test/*.test.ts
python -m pytest calc/tests backtest/tests .agents/skills/data-access/scripts/tests -q
npm run typecheck --prefix orchestrator
npm run build --prefix desktop
```

逐项检查退出码，不能把最后一项成功当作前面全部成功。平台跳过项、构建警告单独记载。

## 真实联调（会使用订阅额度）

下面假设日常产品使用默认 `.local/` 数据根，已在其设置页完成产品专用 Codex 登录，
认证保存在 `.local/codex-home`。命令仅把**测试产物**放进 `.local/dev-validation`，
通过 `--codex-home` 显式沿用同一产品的登录；不是另开一个未登录的设置页面。
若日常产品使用自定义数据根，请把 `--codex-home` 改为该产品实际已登录的目录。
不要复制或软链个人 `~/.codex` 的认证文件，不要借用其他产品的登录目录。
下面为 macOS / Linux 示例，在仓库根执行。Python 自动检测不适用时加 `--python` 指向本机虚拟环境。

```sh
VRA_DATA_ROOT="$PWD/.local/dev-validation" node orchestrator/src/run.ts \
  --symbol 300308 --market SZ --run-id spark-profile-001 \
  --engine codex --provider openai --auth chatgpt_login \
  --codex-home "$PWD/.local/codex-home" \
  --model gpt-5.3-codex-spark --reasoning low \
  --execution-mode controlled_mcp --endpoints core --stages profile \
  --max-retries 0 --turn-timeout-min 2 --knowledge off --no-archive
```

- 每次使用新的 `--run-id`；不覆盖既有产物。数据、事件和失败尝试留在 ignored 的 `.local/`。
- 单阶段验证应检查该阶段的 `validator_ok`；只跑画像的全局结果仍可能是 `incomplete / exit 2`，
  不能据此说完整报告通过，也不能把它误判成模型不可用。
- 六阶段联调去掉 `--stages profile`，使用新 run-id，可设 `--max-retries 1 --turn-timeout-min 3`。
  不降低来源、数字绑定、阶段所有权或合规校验标准。
- `--no-archive` 同时跳过查看器和附录生成；它适合阶段测试，不适合验证报告引用界面。
  验证包含附录的自动收尾时去掉该参数，仍使用独立测试数据根，避免污染日常知识库。
- 仅在明确模型不可用/无权限，或当前模型不适合该项验证时改用已授权 GPT-5.6，并在新运行记录原因。
  登录失效、网络失败、资料缺口和模型产物校验失败是不同问题，不要一律归为模型不支持。
- 测试选择通过单次参数传入，不改全局配置，也不把测试登录态搬到其他产品。
- 只有六阶段产物、最终校验、报告访问路径均核实后，才能说该范围的业务闭环已通过。
  本机 `controlled_mcp` 成功不等于 Windows 原生系统已经验证。

## 官方模型依据

[OpenAI 模型说明](https://learn.chatgpt.com/docs/models)列出 Spark 的纯文本、Pro 研究预览定位；
[额度说明](https://learn.chatgpt.com/docs/pricing)不能作为“无限使用”或“固定最低价格”的依据。
账户及客户端能否实际使用，以本产品引擎的真实调用为准。
