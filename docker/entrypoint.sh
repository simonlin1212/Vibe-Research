#!/bin/bash
set -e

# Vibe-Research Docker 启动脚本
# 启动 nginx（前端 + API 代理）和 uvicorn（后端 API）

echo "==> Starting Vibe-Research..."
echo "    Backend:  http://0.0.0.0:8900"
echo "    Frontend: http://0.0.0.0:80"
echo "    VR_DATA_DIR: ${VR_DATA_DIR:-/data}"

# 启动后端（uvicorn）—— 后台运行
cd /app/backend
uvicorn app:app \
    --host 0.0.0.0 \
    --port 8900 \
    --workers 1 \
    --log-level info &
BACKEND_PID=$!

# 等待后端就绪
echo "==> Waiting for backend to start..."
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8900/api/health > /dev/null 2>&1; then
        echo "==> Backend is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "==> Backend failed to start, exiting..."
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
    sleep 1
done

# 启动 nginx（前台运行，阻塞容器）
echo "==> Starting nginx..."
exec nginx -g 'daemon off;'
