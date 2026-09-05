#!/bin/bash
# 不用 set -e，手动处理错误

# 从 orchestrator package.json 读取版本号
APP_VERSION=$(node -e "try{console.log(require('./orchestrator/package.json').version)}catch{console.log('unknown')}" 2>/dev/null || echo "unknown")

echo "==> Starting Vibe-Research v${APP_VERSION}..."
echo "    Frontend: http://0.0.0.0:80"
echo "    Backend:  http://0.0.0.0:8765"
echo "    Data root: ${VRA_DATA_ROOT:-/data}"

export VRA_PYTHON="${VRA_PYTHON:-/app/.venv/bin/python}"
export VRA_DATA_ROOT="${VRA_DATA_ROOT:-/data}"

mkdir -p /data

# ── API token：用户未设置时自动生成并持久化 ──
# API 绑定 0.0.0.0 时强制要求 VRA_API_TOKEN，Docker 中 nginx 总是注入 token，
# 浏览器不持有，所以这个 token 不增加安全性，自动生成即可。
if [ -z "$VRA_API_TOKEN" ]; then
    TOKEN_FILE="/data/api.token"
    if [ -f "$TOKEN_FILE" ]; then
        VRA_API_TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
        echo "==> VRA_API_TOKEN loaded from $TOKEN_FILE"
    else
        VRA_API_TOKEN=$(openssl rand -hex 32)
        echo "$VRA_API_TOKEN" > "$TOKEN_FILE"
        chmod 600 "$TOKEN_FILE"
        echo "==> VRA_API_TOKEN auto-generated and saved to $TOKEN_FILE"
    fi
fi
export VRA_API_TOKEN

# ── 启动后端 API（后台） ──
cd /app
node --experimental-strip-types orchestrator/src/api.ts --port 8765 --host 0.0.0.0 &
BACKEND_PID=$!
echo "==> Backend PID: $BACKEND_PID"

# ── 等待后端就绪 ──
echo "==> Waiting for backend to start..."
READY=0
for i in $(seq 1 60); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $VRA_API_TOKEN" \
        http://127.0.0.1:8765/health 2>/dev/null || true)
    if [ "$HTTP_CODE" = "200" ]; then
        echo "==> Backend is ready! (HTTP $HTTP_CODE)"
        READY=1
        break
    fi
    if [ $((i % 10)) -eq 0 ]; then
        echo "==> Still waiting... ($i/60, last HTTP: $HTTP_CODE)"
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "==> ERROR: Backend process (PID $BACKEND_PID) died unexpectedly"
        exit 1
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    echo "==> ERROR: Backend failed to start within 60s"
    kill "$BACKEND_PID" 2>/dev/null
    exit 1
fi

# ── 注入 API token 到 nginx 配置 ──
export NGINX_API_TOKEN="$VRA_API_TOKEN"
echo "==> API token configured for nginx proxy (${#NGINX_API_TOKEN} chars)"

# 生成 nginx 配置（注入 API token）
envsubst '${NGINX_API_TOKEN}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# nginx 前台运行
echo "==> Starting nginx..."
exec nginx -g 'daemon off;'
