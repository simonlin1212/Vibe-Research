import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// 开源版后端接口（可插拔 AI 层 + 数据）走 /api 前缀，默认代理到本地 FastAPI。
// Phase 1 为纯前端空壳，后端未接时前端仍可独立跑（接口调用做了降级）。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // 默认用 127.0.0.1 而非 localhost：部分 macOS/Node 会把 localhost 优先解析到 IPv6 ::1，
  // 而后端常只监听 127.0.0.1:8900（IPv4），导致 /api 代理 ECONNREFUSED（issue #8）。
  const apiTarget = env.VITE_API_URL || "http://127.0.0.1:8900";

  return {
    plugins: [react()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    server: {
      port: 5899,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
    preview: {
      port: 5899,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom"],
            "vendor-charts": ["echarts"],
          },
        },
      },
    },
  };
});
