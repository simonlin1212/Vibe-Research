import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("#34 LAN 默认为关，仅同源请求可被归一化，跨站请求不得到达带 token 的代理", async () => {
  const previous = process.env.VRA_LAN;
  const previousToken = process.env.VRA_API_TOKEN;
  process.env.VRA_API_TOKEN = "synthetic-lan-proxy-test-token";
  const root = fileURLToPath(new URL("../", import.meta.url));
  let seen = 0;
  let forwardedOrigin: string | undefined;
  let forwardedToken: string | undefined;
  const target = http.createServer((req, res) => {
    seen += 1;
    forwardedOrigin = req.headers.origin;
    forwardedToken = req.headers.authorization;
    res.end("local backend");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetPort = (target.address() as { port: number }).port;
  try {
    for (const setting of [undefined, "0", "1"]) {
      if (setting === undefined) delete process.env.VRA_LAN; else process.env.VRA_LAN = setting;
      const server = await createServer({ root, logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] }, server: {
        port: 0, hmr: false, proxy: { "/api": { target: `http://127.0.0.1:${targetPort}` } },
      } });
      try {
        assert.equal(server.config.server.host, setting === "1" ? "0.0.0.0" : "127.0.0.1");
        // 验证配置选择，但实测始终只监听回环，不暴露用户数据或开启真实 LAN。
        server.config.server.host = "127.0.0.1";
        await server.listen();
        const port = (server.httpServer!.address() as { port: number }).port;
        const origin = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(`${origin}/api/probe`, { method: "POST", headers: { Origin: origin,
          "Content-Type": "application/json" }, body: "{}" })).status, 200);
        assert.equal(forwardedOrigin, setting === "1" ? "http://127.0.0.1:5930" : origin);
        assert.equal(forwardedToken, "Bearer synthetic-lan-proxy-test-token");
        if (setting === "1") {
          for (const badOrigin of ["https://evil.example", "null", `${origin}/path`, origin.replace("http:", "https:")]) {
            const before = seen;
            assert.equal((await fetch(`${origin}/api/probe`, { method: "POST", headers: {
              Origin: badOrigin, "Content-Type": "application/json" }, body: "{}" })).status, 403);
            assert.equal(seen, before, "不允许先把请求发到后端再拒绝");
          }
          for (const site of ["cross-site", "same-site"]) {
            const before = seen;
            assert.equal((await fetch(`${origin}/api/probe`, { headers: { Origin: origin, "Sec-Fetch-Site": site } })).status, 403);
            assert.equal(seen, before);
          }
        }
      } finally { await server.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.VRA_LAN; else process.env.VRA_LAN = previous;
    if (previousToken === undefined) delete process.env.VRA_API_TOKEN; else process.env.VRA_API_TOKEN = previousToken;
    target.closeAllConnections();
    await new Promise<void>((resolve, reject) => target.close((err) => err ? reject(err) : resolve()));
  }
});
