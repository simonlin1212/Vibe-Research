# 发布前清单(维护者待办)

本清单于 2026-09-05 按活动开发分支更新。已有公开版本不代表当前双引擎与界面改动已发布，
测试通过也不自动授权提交、推送或发布。开发验收见 [M14 记录](完整版本机验收_M14_2026-09-05.md)
与 [界面 V2 记录](界面V2迁移验收_2026-09-05.md)；其中历史数字不是当前重新执行的结果。

## 1. 待拍板 / 待填

| 项 | 现状 | 动作 |
|---|---|---|
| License | `LICENSE` 与中英文 README 已采用 MIT，不再是待定项 | 发布前核对依赖许可证；引擎 openai/codex 为 Apache-2.0，本仓库不含其源码 |
| 仓库地址 | 两份 README 已使用 `simonlin1212/Vibe-Research` 的真实 clone 地址 | 发布前核对分支、上游修复及实际发布内容，不再要求重建仓库 |
| 国产模型矩阵 | `providers/{deepseek,qwen,glm,kimi}.json` 的 `matrix.status` 未真测 | 设对应环境变量(`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`——百炼三件套共用;三个百炼模板还要先在 `.local/providers/` 填掉 `{WorkspaceId}`)后 `node orchestrator/src/finance/provider_matrix.ts --provider <id> --model <m>`,按结果回填 `matrix.status / results / note / last_run` 与 `verified_at` |
| 模板易变字段 | 四个模板有 2026-08-26 的 `verified_at`；这是历史文档核对，不是当前实跑证明 | 发布前重新核对厂商文档与实际兼容矩阵，不把模板日期等同模型验证通过 |
| 联系方式与赞赏 | 已按发布规范:X @linsizhen、邮箱、BMC 二维码 `assets/bmc-qr.png` | 核对无误即可 |
| Windows | Mac 契约测试不能替代 Windows 执行；已准备更广的 Windows CI 测试选择 | 经授权上传独立测试分支，用 Windows runner 检查；云端 Windows Server 结果仍不等于全部 Windows 客户实机通过 |
| 真实模型验收 | 本轮只使用 Claude Code 订阅、主模型 Opus 5；不再调用 WorkBuddy | 完整六阶段运行须留存终态、重试、缺口、实际模型和耗时，不以短探针或旧成功覆盖新失败 |

## 2. 发布时序(审计必须在 push 之前)

1. 执行 `scripts/doctor --net`，安装/隐私/配置故障必须解决；外部限流、缺授权或源侧不可达逐项披露，
   不关闭 TLS、不带入个人密钥、不把 `partial` 或 `failed` 改成全绿。单标的 full 不是 117 个端点全量体检；
2. `(cd orchestrator && npm run typecheck && npm test)`、`python -m pytest calc/tests -q`、`python -m pytest .agents/skills/data-access/scripts/tests -q` 全过;
3. 一次真实研究运行 complete(🔴 **必须是完整六阶段、不带 `--seed-from` 的运行** —— 硬测试夹具
   (`--fixture`)会跳过前四阶段、产物按测试运行隔离,**不能替代这一步**;夹具运行的 manifest 带
   `seeded_from` 且 `test_scenario: true`,一眼可辨)(`node orchestrator/src/run.ts --symbol 300308 --market SZ --python <venv>/bin/python < /dev/null`);
4. `codex review`(或 `codex exec` 审查提示)→ 逐条核实(会误报)→ 修 → 复审至 "No actionable regressions";
5. 确认 `.gitignore` 含 `.local/`、仓库内无 `.local/` 内容、无密钥(doctor 密钥扫描 + 人工过一遍 `git status`);
6. 英文 README 两遍翻译审查(diff 对照 + 纯英文只读);
6.5 **上游对账**:数据层是从 a-stock-data / global-stock-data / investment-news **移植代码**(不是依赖),
   上游更新不会自动流过来 → 按 [datasources/UPSTREAM.md](../datasources/UPSTREAM.md) 的方法对一次账。
   🔴 判据是「这个修复在本产品的代码路径上会不会发生」,**不是版本号是否落后** —— 必须读 release notes 逐条判断;
7. 维护者明确授权后，核对 License / clone 地址 / 徽章，`CHANGELOG.md` 定版本号，再按授权范围分别
   执行提交、推送、标签与 Release。Windows 测试分支的上传授权不包含合并 main 或发布。

## 3. 发布后

- 国产模型矩阵结果回填后再发一次小版本;
- `codex-version.json` 的 `verified_on` 随每次版本验证追加;
- 用户反馈的源侧限制(东财 push2 / 百度 403 / 申万证书链 / mootdx)记入 `datasources/` 说明,不在代码里静默降级。
