# ============================================================
# Vibe-Research Dockerfile —— 多阶段构建
# 阶段1: 构建前端 (Vite + React)
# 阶段2: 安装后端依赖 (Python + FastAPI)
# 阶段3: 合并运行 (nginx + uvicorn)
# ============================================================

# ── 阶段1: 构建前端 ──
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# 先复制依赖文件，利用 Docker 缓存层
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install --legacy-peer-deps

# 复制源码并构建
COPY frontend/ ./
RUN npm run build

# ── 阶段2: 安装后端依赖 ──
FROM python:3.11-slim AS backend-deps

WORKDIR /app

# 安装编译依赖（部分 Python 包需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ── 阶段3: 最终运行镜像 ──
FROM python:3.11-slim AS runtime

# 安装 nginx（用于托管前端静态文件 + 代理后端 API）
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log

WORKDIR /app

# 从阶段2复制 Python 依赖
COPY --from=backend-deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=backend-deps /usr/local/bin /usr/local/bin

# 从阶段1复制前端构建产物
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# 复制后端代码
COPY backend/ /app/backend/

# 复制启动脚本
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# nginx 配置：托管前端 + 代理 /api 到后端
COPY docker/nginx.conf /etc/nginx/nginx.conf

# 数据持久化目录（持仓、研报等用户数据）
# 实际数据目录为 /data（通过 VR_DATA_DIR 环境变量映射到 ~/.vibe-research）
RUN mkdir -p /data
ENV VR_DATA_DIR=/data

# 暴露端口
# 80: nginx（前端 + API 代理）
EXPOSE 80

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
