import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { productUiReady } from "../src/startup_health.ts";

test("启动就绪必须同时收到真实界面与代理后端健康状态", async (t) => {
  let phase = "cold";
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(phase === "wrong-ui" ? "other service" : '<div id="root"></div>'); return; }
    if (phase === "hung") return;
    if (phase === "cold") { res.writeHead(502); res.end(); return; }
    if (phase === "unauthorized") { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(phase === "malformed" ? '<div id="root"></div>' : JSON.stringify({ ok: true, version: "test" }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (phase of ["cold", "unauthorized", "malformed", "wrong-ui", "hung"]) {
    assert.equal(await productUiReady(url, 80), false, phase);
  }
  phase = "ready";
  assert.equal(await productUiReady(url), true);
});

test("Windows 启动器在打开浏览器前轮询就绪，并持续检查两棵进程", () => {
  const script = fs.readFileSync(new URL("../../scripts/start.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(script, /Start-Sleep -Seconds 2/);
  assert.match(script, /startup_health\.ts/);
  assert.match(script, /while \(\[DateTime\]::UtcNow -lt \$readyDeadline\)/);
  assert.ok(script.indexOf('if (-not $ready)') < script.indexOf('Start-Process "http://127.0.0.1:5930"'));
  assert.match(script, /\$api\.Refresh\(\)[\s\S]*\$ui\.Refresh\(\)/);
});
