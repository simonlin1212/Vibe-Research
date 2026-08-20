# Vibe-Research 后端 —— FastAPI + A股/美股/港股数据层。
# 构建上下文为仓库根目录（见 compose.yaml build.context），仅拷贝 backend/ 进镜像。
FROM python:3.12-slim

# pandas / numpy 编译会拖慢构建，这里不需要编译工具链（用预编译 wheel）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend

# 先装依赖再拷代码：requirements 变化频率远低于源码，可复用依赖层缓存
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./

EXPOSE 8900

# 用户私有数据（持仓 / 研报）写 VR_DATA_DIR 挂载卷，见 compose.yaml
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
