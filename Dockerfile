# ============================================================
# Vibe-Research v1.0 Dockerfile
# 多阶段构建：前端构建 → 最终运行镜像
# ============================================================

# ── 阶段1: 构建前端 (React + Vite) ──
FROM node:22-alpine AS frontend-builder

WORKDIR /app

COPY desktop/package.json desktop/package-lock.json* ./desktop/
WORKDIR /app/desktop
RUN npm install --legacy-peer-deps

COPY desktop/ ./
COPY orchestrator/src/data_root.ts ../orchestrator/src/data_root.ts

RUN npx vite build

# ── 阶段2: 最终运行镜像 ──
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    python3 \
    python3-venv \
    python3-pip \
    curl \
    gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log

WORKDIR /app

COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
WORKDIR /app/orchestrator
RUN npm install
WORKDIR /app

# Claude Code CLI（订阅接入需要）
RUN npm install -g @anthropic-ai/claude-code

RUN python3 -m venv /app/.venv
COPY .agents/skills/data-access/scripts/requirements.txt /tmp/requirements.txt
RUN /app/.venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY . .

COPY --from=frontend-builder /app/desktop/dist /usr/share/nginx/html

COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN node --experimental-strip-types orchestrator/src/init.ts --python /app/.venv/bin/python 2>/dev/null || true

RUN mkdir -p /data
ENV VRA_DATA_ROOT=/data
ENV VRA_PYTHON=/app/.venv/bin/python
ENV CLAUDE_CONFIG_DIR=/data/claude-home

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
