#!/usr/bin/env node
/**
 * 薄 HTTP API(Phase 1 M3):默认只绑 127.0.0.1(非回环地址绑定需显式 VRA_API_TOKEN 且关闭 cookie 登录,见 isLoopbackHost);**每个请求都要鉴权**:Bearer token(VRA_API_TOKEN 或自动生成写入 .local/api.token)对所有路由有效,
 * 回环下 /login?token= 换来的 cookie 只放行 COOKIE_GET_ROUTES 白名单里的只读 GET;拒绝非本机 Origin / 跨站 / 非 JSON POST(防浏览器 CSRF);同一 service 层;返回只含相对路径,错误脱敏。
 * 用法:node orchestrator/src/api.ts [--port 8765] [--host 127.0.0.1]
 * 路由:GET /endpoints[?layer=&market=&q=]  POST /fetch {endpoint, symbol?, args?, session?}  POST /research {symbol, market?, stages?, endpoints?, knowledge?}
 *      GET /runs  GET /runs/:id/status|manifest|report|evidence[?field=&q=]|viewer  GET /knowledge/:market/:symbol  GET /health
 * 薄 UI(M4):GET /login?token=<token> 用 token 换 HttpOnly+SameSite=Strict Cookie 并跳 /ui;GET /ui(运行列表)/ GET /ui/runs/:id(报告 + 查看器链接)。
 *      Cookie 只对白名单只读 GET 有效(COOKIE_GET_ROUTES:/ui、/ui/runs/:id、/runs、/runs/:id/viewer|report|status);其余 GET 与所有 POST 只认 Bearer(防 CSRF);所有响应带 SECURITY_HEADERS。
 */
import fs from "node:fs";
import { productVersion } from "./version.ts";
import http from "node:http";
import { cancelResearch, confirmChatResearch } from "./service.ts";
import path from "node:path";

import crypto from "node:crypto";

import { IMPORT_MAX_TOTAL_BYTES, ServiceError, chatSend, llmProbe, translateHeadlines, evidenceAlerts, guidedToolTurn, listTools, runToolRequest, fetchEndpoint, ingestFiles, debateAdvance, debateStart, ledgerKinds, ledgerLabels, ledgerList, localAgents, productInfo, ledgerRemove, ledgerSnapshot, ledgerUpsert, pageQuery, getEvidence, getReport, knowledgeRecall, listEndpoints, listRuns, readRunFile, redact, reportDelete, reportDownload, reportPreview, reportUpload, reportsList, researchStatus, safePath, serviceContext, deleteRun, startCodexSubscriptionLogin, startResearch, thermoSeries, type ServiceContext } from "./service.ts";
import { REPORT_MAX_BYTES } from "./report_library.ts";
import { NOFOLLOW_FLAG, restrictPrivateFile } from "./fsutil.ts";
import { resumeUnifiedTask, runUnifiedTask } from "./task_service.ts";
import { deepTargetResolverFor } from "./deep_target_registry.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register_tasks.ts";
import { VIEWER_CSP } from "./viewer.ts";
const MAX_BODY = 256 * 1024;

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8", htmlCsp = HTML_CSP): void {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  const csp = type.startsWith("text/html") ? { "Content-Security-Policy": htmlCsp } : {};
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(data), ...SECURITY_HEADERS, ...csp });
  res.end(data);
}

function sendFile(res: http.ServerResponse, file: string, name: string, type: string): void {
  // 校验和打开必须落在同一个文件描述符上；若在 lstat 与读取之间把文件换成符号链接，
  // 仅靠路径检查仍可能把资料库之外的文件下载出去。
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("download target is not a regular file");
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...SECURITY_HEADERS,
    });
    const stream = fs.createReadStream(file, { fd, autoClose: true });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function reportMime(ext: string): string {
  if (ext === "PDF") return "application/pdf";
  if (ext === "DOCX") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "CSV") return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** 所有响应统一带:不缓存、不发 Referer(登录 URL 含 token)、禁止 MIME 嗅探 */
const SECURITY_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;

/**
 * HTML 响应额外的 CSP。
 * 🔴 `viewer.html` 是**运行产物**,内容来自生成链;它以 text/html 在 API 这个源上渲染,
 *    一旦里面混进 `<script>`,脚本就在"已认证的源"里跑 —— 可以用 cookie 拉别的运行报告再发出去。
 *    普通 HTML 禁止脚本；viewer 路由另用源码内固定脚本的哈希白名单，仍保持隔离源与禁止联网。
 */
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox";

/** Cookie 只对这些只读 GET 路由有效(白名单,而不是"任何 GET");其余路由只认 Bearer */
export const COOKIE_GET_ROUTES: readonly RegExp[] = [/^\/ui$/, /^\/ui\/runs\/[^/]+$/, /^\/runs$/, /^\/runs\/[^/]+\/(viewer|report|status)$/];

/** `max` 只对明确需要大体积的路由放宽(导入要带 base64 文件);其余一律用默认 256KB */
function readBody(req: http.IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // 🔴 按**字节**计,不按字符计。原来 `buf += c` 先把 chunk 解码成字符串,再拿 `buf.length`
    //    (UTF-16 码元数)跟字节上限比 —— 一个中文字 3 字节只算 1,256KB 的上限实际能塞进约 768KB。
    //    顺带:攒 Buffer 也避免了在 chunk 边界上把多字节字符切成两半。
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // 已经判超限了:继续把数据读完丢掉,别再累计也别再攒
      bytes += c.length;
      if (bytes > max) {
        // 超限之后:**继续读、但一律丢掉**。
        // 🔴 两条更"干脆"的做法都试过,都是错的:
        //    ① `req.destroy()` —— 掐断连接,客户端拿到 EPIPE / "network error",
        //       看不到那句"请求体过大",只会以为网断了;
        //    ② `req.pause()` —— 不读了但也不收,客户端卡在上传上、连接被长期占住;
        //       想在响应 flush 之后再 destroy socket 也不行:客户端还在写,照样 EPIPE。
        //    ⇒ 只有边读边丢才能同时做到:内存有界(丢掉不攒)、客户端写得完、
        //      写完就能读到我们回的 413。这也是通用 HTTP 服务器的常规做法。
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(new ServiceError("body_too_large", "请求体过大"));
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { const buf = Buffer.concat(chunks).toString("utf8"); if (!buf.trim()) return resolve({}); try { const v = JSON.parse(buf); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch { reject(new ServiceError("bad_json", "请求体不是合法 JSON")); } });
    req.on("error", reject);
  });
}

/** 浏览器跨站防护:带 Origin 的请求只接受本机来源;POST 必须是 application/json(浏览器表单 / text/plain 的无预检请求一律拒绝) */
function crossSiteReject(req: http.IncomingMessage): { code: number; error: string } | null {
  const origin = req.headers.origin;
  if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin))) return { code: 403, error: "forbidden_origin" };
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return { code: 403, error: "forbidden_cross_site" };
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return { code: 415, error: "content_type_must_be_json" };
  return null;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const UI_CSS = "body{font-family:-apple-system,'PingFang SC',sans-serif;margin:0;background:#f6f7f9;color:#1f2328}header{background:#1f2d3d;color:#fff;padding:14px 20px}main{padding:16px 20px}table{border-collapse:collapse;background:#fff;font-size:14px}th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}th{background:#eef2f7}a{color:#1d4ed8}pre{background:#fff;border:1px solid #e2e8f0;padding:12px;white-space:pre-wrap;font-size:13px}.tag{padding:1px 6px;border-radius:4px;background:#e2e8f0}.complete{background:#d1fae5}.failed{background:#fee2e2}.incomplete,.stale{background:#fef3c7}";

function cookieToken(req: http.IncomingMessage): string | null {
  const m = /(?:^|;\s*)vra_token=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function uiIndex(ctx: ServiceContext): string {
  const rows = listRuns(ctx, 200).map((r) => `<tr><td><a href="/ui/runs/${esc(r.run_id)}">${esc(r.run_id)}</a></td><td>${esc(r.symbol)}</td><td><span class="tag ${esc(r.status)}">${esc(r.status)}</span></td><td>${esc(r.started_at)}</td><td>${esc(r.finished_at)}</td><td><a href="/runs/${esc(r.run_id)}/viewer">查看器</a></td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Vibe Research · 运行列表</title><style>${UI_CSS}</style></head><body><header><h1>Vibe Research Agent · 运行列表</h1><div>本机只读页面;本页不提供任何投资动作建议。</div></header><main><table><thead><tr><th>run_id</th><th>主体</th><th>状态</th><th>开始</th><th>结束</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6">(尚无运行;用 node orchestrator/src/run.ts 跑一次)</td></tr>'}</tbody></table></main></body></html>`;
}

function uiRun(ctx: ServiceContext, id: string): string | null {
  const st = researchStatus(ctx, id);
  if (!st.exists) return null;
  const rep = getReport(ctx, id);
  const reportText = rep.report ?? (rep.availability === "unvalidated" ? "报告尚未通过最终校验，正文暂不可用。本地草稿保留供排查。" : "这次运行尚无报告文件。");
  const stages = st.stages.map((s) => `<li>${esc(s.stage)} <span class="tag ${esc(s.status)}">${esc(s.status)}</span> × ${s.attempts}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Vibe Research · ${esc(id)}</title><style>${UI_CSS}</style></head><body><header><h1>${esc(st.run_id)} · <span class="tag ${esc(st.status)}">${esc(st.status)}</span></h1><div><a style="color:#9cf" href="/ui">← 运行列表</a> · 证据 ${st.evidence_count ?? "-"} · 计算 ${st.calculation_count ?? "-"} · ${st.viewer && rep.availability === "ready" ? `<a style="color:#9cf" href="/runs/${esc(id)}/viewer">打开证据查看器</a>` : "查看器尚不可用"}</div></header><main><h2>阶段</h2><ul>${stages}</ul><h2>report.md</h2><pre>${esc(reportText)}</pre></main></body></html>`;
}

/** 把浏览器主动停止 / 连接中断变成模型调用的 AbortSignal，避免页面停了后台仍继续计费。 */
async function withRequestAbort<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const abort = () => ac.abort();
  const responseClosed = () => { if (!res.writableEnded) abort(); };
  req.once("aborted", abort);
  res.once("close", responseClosed);
  try {
    if (req.aborted) ac.abort();
    return await run(ac.signal);
  } finally {
    req.removeListener("aborted", abort);
    res.removeListener("close", responseClosed);
  }
}

export function createApiServer(ctx: ServiceContext, opts: { token: string; cookieLogin?: boolean }): http.Server {
  if (!opts.token || opts.token.length < 16) throw new Error("API token 必须 ≥ 16 字符(默认随机生成并写入 .local/api.token)");
  const cookieLogin = opts.cookieLogin !== false;  // 非本机绑定(明文 HTTP)时由 main 关闭:cookie 会被网络观察者截获
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cs = crossSiteReject(req);
      if (cs) return send(res, cs.code, { error: cs.error });
      // 鉴权:Bearer 对所有路由有效;Cookie(由 /login 用 token 换取)只对 COOKIE_GET_ROUTES 白名单里的只读 GET 有效(POST / 其它 GET 仍只认 Bearer,防 CSRF)
      const bearerOk = (req.headers.authorization ?? "") === `Bearer ${opts.token}`;
      if (req.method === "GET" && url.pathname === "/login") {
        if (!cookieLogin) return send(res, 404, { error: "cookie login disabled (non-loopback bind)" });
        if (url.searchParams.get("token") !== opts.token) return send(res, 401, { error: "unauthorized" });
        res.writeHead(302, { "Set-Cookie": `vra_token=${opts.token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/ui", ...SECURITY_HEADERS });
        return res.end();
      }
      const cookieOk = cookieLogin && req.method === "GET" && COOKIE_GET_ROUTES.some((re) => re.test(url.pathname)) && cookieToken(req) === opts.token;
      if (!bearerOk && !cookieOk) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/ui") return send(res, 200, uiIndex(ctx), "text/html; charset=utf-8");
      if (req.method === "GET" && /^\/ui\/runs\/[^/]+$/.test(url.pathname)) { const t = uiRun(ctx, decodeURIComponent(url.pathname.split("/")[3])); return t === null ? send(res, 404, { error: "no such run" }) : send(res, 200, t, "text/html; charset=utf-8"); }
      const parts = url.pathname.split("/").filter(Boolean);
      const q = Object.fromEntries(url.searchParams.entries());
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, version: productVersion() });
      // 设置页要看的有效配置。**只读** —— 不提供任何写入密钥的入口(见 service.productInfo)
      if (req.method === "GET" && url.pathname === "/product") return send(res, 200, productInfo(ctx));
      if (req.method === "GET" && url.pathname === "/local-agents") return send(res, 200, await localAgents(ctx, process.env, url.searchParams.get('provider') ?? undefined));
      if (req.method === "POST" && url.pathname === "/local-agents/codex/login") {
        await readBody(req);
        return send(res, 202, startCodexSubscriptionLogin(ctx));
      }
      if (req.method === "GET" && url.pathname === "/endpoints") return send(res, 200, listEndpoints(ctx, { layer: q.layer, market: q.market, q: q.q, enabled_only: q.enabled_only === "1", for_ui: q.all !== "1" }));
      // 界面查询:页面按**名字**要一屏数据,不点名物理端点(见 service.pageQuery)
      if (req.method === "GET" && parts[0] === "page" && parts[1] && parts.length === 2) {
        return await withRequestAbort(req, res, async (signal) => send(res, 200, await pageQuery(ctx, { query: parts[1], symbol: q.symbol, refresh: q.refresh === "1", signal })));
      }
      // 用户在界面上拨过某个块参数的那次查询走 POST:参数是结构化的,塞查询串会变成字符串猜类型。
      // ⚠️ 能拨哪些键由垂类的 `userArgs` 白名单说了算,这里不放宽(见 service.pickUserArgs)。
      if (req.method === "POST" && parts[0] === "page" && parts[1] && parts.length === 2) {
        return await withRequestAbort(req, res, async (signal) => {
          const b = (await readBody(req)) as { symbol?: string; refresh?: boolean; blockArgs?: Record<string, Record<string, unknown>> };
          return send(res, 200, await pageQuery(ctx, { query: parts[1], symbol: b?.symbol, refresh: b?.refresh === true, blockArgs: b?.blockArgs, signal }));
        });
      }
      // 多空辩论:开一场 → 逐个阶段推进(一次一个,界面据此逐段显示)
      // 垂类自带的工具:GET 列清单 / POST 跑一个。Core **不知道**这些工具各自是干什么的。
      if (req.method === "GET" && url.pathname === "/tools") {
        return send(res, 200, { tools: listTools() });
      }
      if (req.method === "POST" && parts[0] === "tool" && parts[1] && parts.length === 2) {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req) as { input?: unknown; llm?: unknown; executionMode?: unknown };
          return send(res, 200, await runToolRequest(ctx, parts[1], b, signal));
        });
      }
      // 对话式工具：Agent 负责补问和组参数；条件齐备后仍由上面的同一条工具执行链真实运行。
      if (req.method === "POST" && parts[0] === "guided-tool" && parts[1] && parts.length === 2) {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await guidedToolTurn(ctx, parts[1], b as never, signal));
        });
      }
      if (req.method === "POST" && url.pathname === "/debate") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = (await readBody(req)) as { symbol?: string; session?: string; depth?: string; llm?: unknown; executionMode?: unknown };
          return send(res, 200, await debateStart(ctx, {
            symbol: String(b?.symbol ?? ""),
            ...(b?.session ? { session: b.session } : {}),
            ...(b?.depth ? { depth: String(b.depth) } : {}),
            ...(b?.executionMode !== undefined ? { executionMode: b.executionMode } : {}),
            ...(b?.llm !== undefined ? { llm: b.llm } : {}),
          }, signal));
        });
      }
      if (req.method === "POST" && parts[0] === "debate" && parts[1] && parts[2] === "advance") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await debateAdvance(ctx, { id: parts[1],
            ...(b.executionMode !== undefined ? { executionMode: b.executionMode } : {}),
            ...(b.llm !== undefined ? { llm: b.llm } : {}) }, signal));
        });
      }
      if (req.method === "POST" && url.pathname === "/fetch") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await fetchEndpoint(ctx, { ...b, signal } as never));
        });
      }
      // 统一任务入口：客户端只提交高层 task；路由器自行决定 deterministic / Quick / Deep。
      // Deep 只经适配器启动既有六阶段编排；旧 /research 保持兼容。
      if (req.method === "POST" && url.pathname === "/tasks") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await runUnifiedTask(ctx, b, signal, {
            deepTargetResolver: deepTargetResolverFor(ctx.dataRoot),
          }));
        });
      }
      if (req.method === "POST" && url.pathname === "/tasks/resume") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await resumeUnifiedTask(ctx, b, signal, {
            deepTargetResolver: deepTargetResolverFor(ctx.dataRoot),
          }));
        });
      }
      // Normal Agent chat uses product tools; direct mode and internal probes stay separate.
      if (req.method === "POST" && url.pathname === "/chat/confirm-research") {
        const b = await readBody(req);
        return send(res, 200, confirmChatResearch(ctx, b));
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        // body 里可带 `llm`(界面上选的模型 + 用户自己的 key)。
        // 🔴 key 只在这一次请求的内存里流转 —— 不写配置、不进日志、不入账本。
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await chatSend(ctx, b as never, signal));
        });
      }
      // 外部 RSS 标题翻译：与自由对话分开，后端固定 developer 指令、schema 与一次性线程。
      if (req.method === "POST" && url.pathname === "/translate-headlines") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await translateHeadlines(ctx, b as never, signal));
        });
      }
      // 连接探针：后端固定令牌、不召回资料、不复用线程 —— 设置页「测试并保存」专用，不是第二个聊天入口（#40）。
      if (req.method === "POST" && url.pathname === "/llm-probe") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req);
          return send(res, 200, await llmProbe(ctx, b as never, signal));
        });
      }
      // 资料导入:上传截图 / 文本 → agent 转写成台账**草稿**(不直接落库,见 ingest.ts)。
      // base64 会把体积放大约 1/3,再留些余量给 JSON 外壳
      if (req.method === "POST" && url.pathname === "/import") {
        return await withRequestAbort(req, res, async (signal) => {
          const b = await readBody(req, Math.ceil(IMPORT_MAX_TOTAL_BYTES * 1.4));
          return send(res, 200, await ingestFiles(ctx, b as never, signal));
        });
      }
      // 用户资料:上传后先提取正文并建立本地索引，成功才出现在列表。
      if (req.method === "GET" && url.pathname === "/reports") return send(res, 200, reportsList(ctx));
      if (req.method === "POST" && url.pathname === "/reports") {
        const b = await readBody(req, Math.ceil(REPORT_MAX_BYTES * 1.4) + 16 * 1024);
        return send(res, 200, await reportUpload(ctx, b));
      }
      if (req.method === "POST" && parts[0] === "reports" && parts[1] && parts[2] === "delete" && parts.length === 3) {
        await readBody(req);
        return send(res, 200, await reportDelete(ctx, { id: parts[1] }));
      }
      if (req.method === "GET" && parts[0] === "reports" && parts[1] && parts[2] === "download" && parts.length === 3) {
        const found = reportDownload(ctx, parts[1]);
        return found ? sendFile(res, found.path, found.report.name, reportMime(found.report.ext)) : send(res, 404, { error: "no_such_report" });
      }
      if (req.method === "GET" && parts[0] === "reports" && parts[1] && parts[2] === "preview" && parts.length === 3) {
        const found = reportPreview(ctx, parts[1]);
        return found ? send(res, 200, found) : send(res, 404, { error: "no_such_report" });
      }
      if (req.method === "POST" && url.pathname === "/research") { const b = await readBody(req); return send(res, 202, startResearch(ctx, b as never)); }
      if (req.method === "POST" && url.pathname === "/research/cancel") {
        const b = await readBody(req);
        if (Object.keys(b).some((key) => key !== "run_id")) throw new ServiceError("bad_request", "取消只接受研究编号");
        return send(res, 200, cancelResearch(ctx, b.run_id));
      }
      if (req.method === "DELETE" && parts[0] === "runs" && parts[1] && parts.length === 2) {
        // 删除一次研究运行(归档清理,用户反馈 2026-09-06);进行中的 run 由 service 层拒(run_in_progress)
        const r = deleteRun(ctx, parts[1]);
        return send(res, r.deleted ? 200 : 404, r);
      }
      if (req.method === "GET" && url.pathname === "/runs") return send(res, 200, listRuns(ctx, q.limit ? Number(q.limit) : undefined));
      // 「昨天以来变了什么」:对齐同一对象最近两次研究。**不足两次会报 need_two_runs**,
      // 调用方据此区分"没变化"与"还没有可比较的第二次"——这两件事完全不同(见 service.evidenceAlerts)。
      if (req.method === "GET" && url.pathname === "/alerts") {
        return send(res, 200, evidenceAlerts(ctx, { symbol: String(q.symbol ?? ""), market: q.market, base: q.base, next: q.next }));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts[1] && parts[2]) {
        const id = parts[1];
        if (parts[2] === "status") return send(res, 200, researchStatus(ctx, id));
        if (parts[2] === "report") return send(res, 200, getReport(ctx, id));
        if (parts[2] === "evidence") return send(res, 200, getEvidence(ctx, id, { field: q.field, source: q.source, q: q.q, limit: q.limit ? Number(q.limit) : undefined }));
        if (parts[2] === "manifest") { const t = readRunFile(ctx, id, "manifest.json"); return t === null ? send(res, 404, { error: "no such run" }) : send(res, 200, t); }
        if (parts[2] === "viewer") { const t = readRunFile(ctx, id, "viewer.html"); return t === null ? send(res, 404, { error: "no viewer" }) : send(res, 200, t, "text/html; charset=utf-8", VIEWER_CSP); }
      }
      if (req.method === "GET" && parts[0] === "knowledge" && parts[1] && parts[2]) return send(res, 200, knowledgeRecall(ctx, parts[2], parts[1]));
      // 端点观测序列(只读)。⚠️ 端点 id 会被拼进文件路径 —— service 层用**注册表白名单**校验,
      //    不做路径清洗(清洗规则总有想不到的编码形式,白名单没有想不到的情形)
      if (req.method === "GET" && parts[0] === "series" && parts[1] && parts.length === 2) {
        return send(res, 200, thermoSeries(ctx, decodeURIComponent(parts[1])));
      }

      // ---- 用户自有台账 ----
      // 🔴 写操作一律用 POST(含删除),不用 DELETE:crossSiteReject 的"必须 application/json"
      //    这条只覆盖 POST —— 换成 DELETE 就绕过了那道无预检防线,而 cookie 白名单又只放行只读 GET。
      //    路径可读性让位于"所有写操作走同一套防护"。
      if (req.method === "GET" && url.pathname === "/ledger") {
        // 一次读盘拿两半:分两次调会让 records 与 issues 来自不同快照(见 service.ledgerSnapshot)
        const snap = ledgerSnapshot(ctx);
        return send(res, 200, { kinds: ledgerKinds(ctx), labels: ledgerLabels(ctx), records: snap.records, issues: snap.issues });
      }
      if (req.method === "GET" && parts[0] === "ledger" && parts[1] && parts.length === 2) return send(res, 200, ledgerList(ctx, parts[1]));
      if (req.method === "POST" && parts[0] === "ledger" && parts[1] && parts.length === 2) {
        const b = await readBody(req);
        // 兼容两种写法:{...字段} 或 {record:{...}}。
        // ⚠️ 用 hasOwnProperty 而不是 `b.record ?? b` —— 后者会把显式的 `{"record": null}`
        //    回退成"整个请求体就是记录",把一个结构错误伪装成字段校验错误。
        const rec = Object.prototype.hasOwnProperty.call(b, "record") ? b.record : b;
        return send(res, 200, ledgerUpsert(ctx, { kind: parts[1], record: rec as Record<string, unknown> }));
      }
      if (req.method === "POST" && parts[0] === "ledger" && parts[1] && parts[2] === "delete" && parts.length === 3) {
        const b = await readBody(req);
        return send(res, 200, ledgerRemove(ctx, { kind: parts[1], id: String(b.id ?? "") }));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof URIError) return send(res, 400, { error: "bad_path", message: "网址编码无效，请从栏目入口重新打开" });
      if (e instanceof ServiceError) {
        // 🔴 请求体过大要回 **413**,不能混在 400 里。
        //    上一版注释写着"照常回一个 413",代码却走统一的 400 —— 又一次**声称与代码不符**
        //    (自己的测试只断言了 error 码、没断言状态码,所以放过去了)。
        if (e.code === "body_too_large") {
          // Connection: close = 这条连接用完不复用;剩下的请求体由 readBody **边读边丢**,
          // 客户端写完就能读到这个响应(不要在这里 destroy socket —— 它还在写,会变成 EPIPE)
          res.setHeader("Connection", "close");
          return send(res, 413, { error: e.code, message: redact(e.message, 200) });
        }
        if (e.code === "resume_not_found") return send(res, 404, { error: e.code, message: redact(e.message, 200) });
        return send(res, 400, { error: e.code, message: redact(e.message, 200) });
      }
      console.error(`[api] internal error: ${redact(e instanceof Error ? e.stack ?? e.message : String(e), 600)}`);
      return send(res, 500, { error: "internal" });
    }
  });
}

/** token:VRA_API_TOKEN 优先;否则随机生成并写入 <dataRoot>/api.token(0600),客户端从该文件读 */
export function resolveToken(ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env): { token: string; source: "env" | "file" | "generated"; file: string } {
  const file = safePath(ctx, "api.token");  // 文件本身若是符号链接 → safePath 拒绝(不跟随读 / 写数据区外文件)
  if (env.VRA_API_TOKEN && env.VRA_API_TOKEN.length >= 16) return { token: env.VRA_API_TOKEN, source: "env", file };
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile()) throw new ServiceError("path_symlink", "api.token 不是普通文件");
    restrictPrivateFile(file);
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return { token: t, source: "file", file };
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW_FLAG, 0o600);
  fs.writeSync(fd, token + "\n");
  fs.closeSync(fd);
  restrictPrivateFile(file);
  return { token, source: "generated", file };
}

/** 回环地址判定(绑定前置检查与 cookie 登录开关共用同一口径) */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * 解析 `--port`。
 * 🔴 **必须能接受 0**（0 = 让系统分配一个空闲端口，嵌入式启动方可用它避开"端口被占"）。
 *    原来写的是 `Number(x || 8765) || 8765` —— `0` 是 falsy，两个 `||` 各吃掉它一次,
 *    于是 `--port 0` 会**静默变成 8765**：不报错、看着正常、绑到了另一个端口。
 */
export function parsePortArg(args: readonly string[], fallback = 8765): number {
  const i = args.indexOf("--port");
  if (i < 0 || i + 1 >= args.length) return fallback;
  const raw = args[i + 1]!;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 0 && n <= 65535 ? n : fallback;
}

/**
 * 这个文件是不是被当入口跑的。
 * 源码开发走 `api.ts`，若以后部署编译产物也要识别 `api.js` / `api.mjs` / `api.cjs`。
 */
export function isEntryPath(argv1: string | undefined): boolean {
  return /[\\/]api\.(ts|js|mjs|cjs)$/.test(argv1 ?? "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = parsePortArg(args);
  const host = args.includes("--host") ? args[args.indexOf("--host") + 1] : "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (!loopback && !process.env.VRA_API_TOKEN) { console.error("[api] 非回环地址绑定必须显式设置 VRA_API_TOKEN"); process.exit(2); }
  const ctx = serviceContext();
  const tk = resolveToken(ctx);
  const srv = createApiServer(ctx, { token: tk.token, cookieLogin: loopback });
  // 🔴 打印**实际绑上的端口**,不是请求的那个 —— `--port 0` 时请求的是 0,
  //    调用方（桌面外壳）就是靠这一行知道该连哪儿的
  srv.listen(port, host, () => {
    // 🔴 **整行都用实际端口**。只改前半段的话,给用户点的那个登录链接仍然写着 `:0`,
    //    照着点必然打不开 —— 而这一行看起来是「已经修好了」的。
    const p = actualPort(srv, port);
    console.error(`[api] listening http://${host}:${p}  token 来源=${tk.source}(文件 .local/api.token;请求头 Authorization: Bearer <token>;${loopback ? `浏览器打开 http://${host}:${p}/login?token=<token> 进入运行列表页 /ui` : "非本机绑定:cookie 登录已关闭,只认 Bearer"})`);
  });
}

/** 实际绑定的端口;取不到就退回请求值(只可能发生在非 TCP 的 address() 上) */
function actualPort(srv: http.Server, requested: number): number {
  const a = srv.address();
  return a && typeof a === "object" ? a.port : requested;
}

if (isEntryPath(process.argv[1])) {
  main().catch((e) => { console.error(`[api] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
