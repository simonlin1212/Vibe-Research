# Vibe-Research Docker 部署指南

本项目提供完整的 Docker 部署方案，支持：
- 单容器全栈部署（前端 + 后端 + nginx 一体化）
- GitHub Actions 自动构建推送至 ghcr.io 和 Docker Hub
- 本地 Docker Compose 一键启动
- 多架构支持（amd64 / arm64）

## 架构

```
┌─────────────────────────────────────────┐
│         Vibe-Research Container          │
│                                         │
│  ┌─────────┐    ┌────────────────────┐  │
│  │  nginx  │───▶│  uvicorn (FastAPI) │  │
│  │  :80    │    │  :8900             │  │
│  └────┬────┘    └────────────────────┘  │
│       │                                 │
│  ┌────▼────┐                            │
│  │ 前端静态 │                            │
│  │ 文件    │                            │
│  └─────────┘                            │
└─────────────────────────────────────────┘
```

## 本地部署（Docker Compose）

### 前置要求

- Docker Engine 20.10+
- Docker Compose v2

### 快速启动

```bash
# 拉取最新镜像
docker pull ghcr.io/birdxs/vibe-research:latest

# 启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### 访问

- 前端: http://localhost:5899
- 后端 API: http://localhost:5899/api
- 健康检查: http://localhost:5899/api/health

### 数据持久化

用户数据（持仓、研报）存储在 Docker 命名卷 `vibe-data` 中，对应容器内 `/data` 目录。

```bash
# 备份数据
docker run --rm -v vibe-data:/data -v $(pwd):/backup alpine tar czf /backup/vibe-backup.tar.gz -C /data .

# 恢复数据
docker run --rm -v vibe-data:/data -v $(pwd):/backup alpine tar xzf /backup/vibe-backup.tar.gz -C /data
```

## 本地部署（纯 Docker）

```bash
docker run -d \
  --name vibe-research \
  -p 5899:80 \
  -v vibe-data:/data \
  -e VR_ALLOW_ORIGINS="*" \
  ghcr.io/birdxs/vibe-research:latest
```

## GitHub Actions 自动构建

### 触发条件

- 推送到 `main` / `master` 分支 → 构建并推送 `latest`
- 推送 `v*` 标签（如 `v0.3.1`）→ 推送对应版本号

### 配置 Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 说明 |
|-------------|------|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（在 Docker Hub Account Settings → Security 生成） |

> ghcr.io 使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需额外配置。

### 镜像地址

构建完成后，镜像同时推送至：

- `ghcr.io/birdxs/vibe-research:latest`
- `docker.io/<username>/vibe-research:latest`

### 手动触发

在 GitHub Actions 页面选择 `Build & Push Docker Image` 工作流，点击 `Run workflow`。

## 从源码构建

```bash
# 构建镜像
docker build -t vibe-research:local .

# 运行
docker run -d --name vibe-research -p 5899:80 -v vibe-data:/data vibe-research:local
```

## 多架构支持

GitHub Actions 工作流默认构建 `linux/amd64` 和 `linux/arm64` 两种架构镜像，可直接在 Intel/AMD 服务器、Apple Silicon Mac、树莓派等环境运行。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VR_ALLOW_ORIGINS` | `*` | CORS 白名单，公网部署请设为你的前端域名 |
| `VR_API_KEY` | 空（不鉴权） | 设置后所有 `/api/*` 需带 `Authorization: Bearer <key>` |
| `VR_DATA_DIR` | `/data` | 用户数据目录（持仓、研报） |
| `VR_REPORTS_DIR` | 空 | 研报单独目录（可选） |

## 生产部署建议

1. **设置 API Key**：公网部署务必设置 `VR_API_KEY`，否则任何人都能访问后端
2. **限制 CORS**：设置 `VR_ALLOW_ORIGINS=https://your-domain.com`
3. **反向代理**：在 nginx/Caddy 前置 HTTPS 终止
4. **数据备份**：定期备份 `vibe-data` 卷
5. **资源限制**：建议设置 `--memory=1g --cpus=1`

## 常见问题

### 容器启动后立即退出

检查日志：`docker compose logs vibe-research`

常见原因：
- 端口被占用：修改 `-p 5899:80` 中的主机端口
- Python 依赖缺失：重新构建镜像

### 无法访问前端

- 检查防火墙是否放行 5899 端口
- 检查 nginx 配置是否正确代理了 `/api`

### 数据丢失

确保使用了持久化卷（`-v vibe-data:/data`），否则容器删除后数据会丢失。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)
