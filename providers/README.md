# provider profiles(模型接入,开发方案 v2 §6)

每家一份 JSON(**只引用环境变量名,永不含真实 token**):`id` = Codex `model_provider` id;`wire_api` = Codex `model_providers.<id>.wire_api`(**只能 responses** —— 引擎已移除 chat,契约层会当场拒);`base_url` / `env_key` / `requires_openai_auth` 直接映射到 Codex 配置;其余是契约元数据:`responses_support`(native / gateway / none)、`stream_format`、`tool_calls`、`reasoning` 映射、`context_limit_tokens`、`retryable_errors`、`known_incompatibilities`、`matrix`(10 项兼容测试矩阵状态)。

用法:
1. 设环境变量(如 `export DEEPSEEK_API_KEY=...`);
2. 用户配置 `.local/config.json`:`{"provider": {"profile": "deepseek", "auth": "api_key"}, "defaults": {"model": "deepseek-v4-flash"}}`(或 CLI `--provider deepseek --model deepseek-v4-flash`);
3. 先跑矩阵:`node orchestrator/src/finance/provider_matrix.ts --provider deepseek --model deepseek-v4-flash`(10 项:①单次文本 ②单工具调用 ③连续三轮工具调用 ④并行工具调用 ⑤工具失败自修复 ⑥长流 ⑦reasoning item ⑧schema 严格输出 ⑨多轮上下文延续 ⑩多轮在无 previous_response_id 协议下的延续),结果在 `.local/provider-matrix/<id>/<时间>/`,按结果回填 `matrix.status` / `matrix.results`(`--reasoning low|medium|high` 调 reasoning 档位,⑦ 依赖模型回传 reasoning 摘要;openai 基线 9 pass · 1 n/a 见 `openai.json`);
4. 矩阵不全绿的 provider 只能用于试验,不应用于正式研究运行(编排器会在 manifest 记录 provider 与矩阵状态)。

模板硬约束(`validateProfile`):第三方 `base_url` 必须显式填写，远程要求 HTTPS，本机字面回环主机 localhost / 127.0.0.1 / [::1] 允许 HTTP(空值会让 Codex 回退到 OpenAI 官方端点,密钥发错主机)、第三方只能 `auth_modes=["api_key"]`、`responses_support=native` ⇒ `wire_api=responses`,`wire_api=responses` ⇒ `responses_support ∈ {native, gateway}`、`auth_modes` 不重复、`context_limit_tokens ≥ 1`、`env_http_headers` 不得引用 HOME/PATH 等受保护变量、`verified_at` 为 YYYY-MM-DD 或 null。`default_model` / `context_limit_tokens` 是易变的供应商信息,`verified_at` 记最近一次人工核实日期(null = 未核实;模型名下线时请显式 `--model`)。

国产模型各自单独进矩阵,不当同一种 "OpenAI-compatible"。自建 Responses↔Chat adapter 不在本目录范围(独立子项目)。用户私有覆盖放 `.local/providers/<id>.json`(同结构,优先级更高)。
