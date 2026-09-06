import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiTokenPath } from "./vite-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
// 上游 #34：仅用户显式开启时监听所有网卡；这不是多用户登录或公网部署方案。
const lan = process.env.VRA_LAN === "1";

/**
 * 开发期鉴权:**Bearer token 只留在 Vite 进程里,不进浏览器**。
 * 前端一律打 `/api/*`(同源、无凭据),由这里补 Authorization 头转发到本机编排器 API。
 * 🔴 每次请求都重读 token 文件 —— API 重启会换 token(api.ts:resolveToken),
 *    缓存住就会在"看着还开着"的情况下整站 401,而且要重启前端才好,极难排查。
 *    文件是本机几十字节,重读的代价可以忽略。
 */
function apiToken(): string {
  const fromEnv = process.env.VRA_API_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = apiTokenPath(repoRoot);
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* 缺失时不补头,后端会以 401 明确拒绝,好过在这里静默放行 */
  }
  return "";
}

export default defineConfig({
  plugins: [react(), {
    name: "vra-lan-origin-guard",
    configureServer(server) {
      if (!lan) return;
      // 在 Vite 代理（自动附加后端 token）之前拒绝跨站浏览器请求。
      // 不能无条件改 Origin：非安全 HTTP 上浏览器可能不发送 Sec-Fetch-Site。
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        const site = req.headers["sec-fetch-site"];
        const sameOrigin = `${server.config.server.https ? "https" : "http"}://${req.headers.host}`;
        if ((origin !== undefined && origin !== sameOrigin)
          || (site !== undefined && site !== "same-origin" && site !== "none")) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "forbidden_origin", message: "请从工作台自身页面发起请求。" }));
          return;
        }
        next();
      });
    },
  }],
  // 🔴 `@` 指向**垂类包**而不是 src:上游 UI 里写的是 `@/components`、`@/lib`、`@/data`,
  //    我们把它整套放进 verticals/finance/,别名这么指,上游代码一行都不用改。
  resolve: { alias: { "@": path.resolve(here, "src/verticals/finance") } },
  server: {
    // 🔴 必须写死 IPv4:默认 localhost 在本机解析成 [::1],而后端绑的是 127.0.0.1,对不上会 502
    host: lan ? "0.0.0.0" : "127.0.0.1",
    port: 5930,
    // 启动器和 README 都只打开 5930；被占用时必须明确失败，不能静默漂到 5931 让用户看到旧页面。
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ""),
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            // LAN 请求已经通过前置同源检查，此处才归一化为后端认可的回环 Origin。
            if (lan) proxyReq.setHeader("origin", "http://127.0.0.1:5930");
            const token = apiToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
            // 后端 crossSiteReject 只接受本机 Origin;浏览器带的是 127.0.0.1:5930,本机、放行。
          });
          proxy.on("error", (err, _req, res) => {
            // 默认错误页是一段 HTML,前端 res.json() 会炸在"Unexpected token <",把真正原因埋掉
            const msg = /ECONNREFUSED/.test(String(err))
              ? "本机服务没有启动或已经关闭。请按页面提示重新启动。"
              : `代理失败:${err.message}`;
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "api_unreachable", message: msg }));
            }
          });
        },
      },
    },
  },
});
