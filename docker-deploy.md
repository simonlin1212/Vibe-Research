# Vibe-Research Docker 部署指南

基于 Codex Harness 的本地金融研究工作台 Docker 部署方案。

## ⚠️ 安全警告

**本方案没有浏览器侧入口鉴权。** nginx 代理为所有请求注入 Bearer token（与原项目 LAN 模式 `VRA_LAN=1` 行为一致），能连到端口的任何人拥有完整 API 权限——包括运行研究（消耗你的模型额度）、读取所有 run 产物和资料库。

- **只在受信任的局域网内使用，不要将端口暴露到公网**
- 不要在公网防火墙上开端口映射此服务
- 如需公网访问，请使用 VPN 或 SSH 隧道

## 快速部署

```bash
docker compose up -d
docker compose logs -f
```

浏览器打开 http://localhost:5899

零配置启动：API token 自动生成并持久化到 `/data/api.token`，无需手动设置。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `VRA_DATA_ROOT` | ✅ | 容器内数据目录，通常设为 `/data` |
| `VRA_API_TOKEN` | 否 | API 认证 token。不设置则自动生成并持久化 |
| `VRA_PYTHON` | 否 | Python 路径，默认 `/app/.venv/bin/python` |

## 复用主机 AI 订阅登录态

如果主机上已登录过 Claude Code 或 Codex，可以直接挂载凭据目录，免去容器内重新登录：

编辑 `docker-compose.yml`，取消对应注释：

```yaml
volumes:
  - vibe-data:/data
  # 复用主机登录态（取消注释）
  - ${HOME}/.claude:/data/claude-home    # Claude Code
  - ${HOME}/.codex:/data/codex-home      # Codex
```

## 接入 AI

启动后在 Web 界面的「接入 AI」页面配置模型。有两种方式：

### API 接入（推荐）

1. 打开 http://localhost:5899 → 「接入 AI」→「API 接入」
2. 选择模型供应商（DeepSeek / OpenAI / Qwen 等）
3. 填写 API 地址和 Key
4. 点击「测试并保存」

> API key 只保存在你浏览器的 localStorage 里，提问时经后端转给模型服务商，用完即弃——不进入配置文件、日志或仓库。
> ⚠️ 端点必须支持 **Responses API**（引擎已不再支持 Chat Completions）。填写自定义端点前请确认供应商支持该协议。

### 订阅接入（Codex / Claude Code）

订阅接入需要浏览器 OAuth 登录，在 Docker 中需要手动操作一次：

**Codex 登录：**
```bash
docker exec -it vibe-research bash
CODEX_HOME=/data/codex-home codex login --device-auth
# 按提示在浏览器完成授权
```

**Claude Code 登录：**
```bash
docker exec -e CLAUDE_CONFIG_DIR=/data/claude-home -it vibe-research claude
# 在 Claude Code 交互界面中执行 /login 完成授权
```

登录态持久化：Codex 存储在 /data/codex-home，Claude Code 存储在 /data/claude-home（均在 vibe-data 卷内），容器重启后无需重新登录。

> 如果不需要订阅接入，使用 API 接入即可，无需登录。

## 数据持久化

用户数据存储在 `/data` 目录（容器内），挂载到宿主机的 `vibe-data`：

```bash
# 备份
docker run --rm -v vibe-data:/data -v $(pwd):/backup alpine tar czf /backup/vibe-data-backup.tar.gz -C /data .

# 恢复
docker run --rm -v vibe-data:/data -v $(pwd):/backup alpine tar xzf /backup/vibe-data-backup.tar.gz -C /data
```

## 常见问题

### 容器启动后立即退出

```bash
docker compose logs -f
```

常见原因：
- 端口被占用
- Python 依赖缺失

### 页面显示「连不上后端」

检查后端是否正常运行：
```bash
docker exec vibe-research curl -sf http://localhost/api/health
```

### forbidden_origin 错误

nginx 代理会自动处理 Origin 头，不应出现此错误。如仍出现，检查 nginx 配置是否正确加载。

## GitHub Actions 构建

手动触发（`workflow_dispatch`），输入标签即可构建推送至 ghcr.io 和 Docker Hub。

### 所需 Secrets

| Secret | 说明 |
|--------|------|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token |

## 多架构

支持 `linux/amd64` + `linux/arm64`，使用 GitHub Actions 原生 arm64 runner 构建。
