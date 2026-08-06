# Vibe-Research 前端 —— 多阶段构建。
# 构建上下文为仓库根目录（见 compose.yaml build.context），仅把 frontend/ 送进构建上下文。
#
# Stage 1: 构建静态产物（node 20 LTS + npm ci 锁版本）
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: nginx 托管静态产物 + 反代 /api → backend 服务（见 nginx.conf）
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
