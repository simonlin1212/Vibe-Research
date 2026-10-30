/**
 * **只连公网地址**的出站请求(远程访问模式下,页面里填的地址用)。
 *
 * 为什么不能只看域名写法:任何人都能把一个正常的公网域名解析到 10.x / 127.0.0.1 / 云元数据地址,
 * 写法检查全部放行,后台照样替他去连内网(Codex 审计 2026-10-09 A1)。
 * ⇒ 在**连接时**查解析结果:地址检查放在 socket 的 lookup 回调里,连上的就是查过的那个地址,
 *    第二次解析换成内网地址(DNS 重绑定)也绕不过去。
 *
 * 🔴 判据是**显式网段**,不用 `is_private` 一类的属性:那类属性的覆盖面随运行时版本变,而且各有遗漏。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable, pipeline } from "node:stream";
import zlib from "node:zlib";

/** 不是公网的 IPv4 网段(本机、内网、共享地址、链路本地、文档 / 测试、组播、保留)*/
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
/** 不是公网的 IPv6 网段。6to4(2002::/16)与 IETF 协议段(含 Teredo)整段拒:它们能把任意 IPv4 包进来 */
const V6_BLOCKED: [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
const BLOCKED = new net.BlockList();
for (const [a, p] of V4_BLOCKED) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of V6_BLOCKED) BLOCKED.addSubnet(a, p, "ipv6");

/** IPv6 末 32 位里嵌着的 IPv4(IPv4 映射 ::ffff:0:0/96、NAT64 64:ff9b::/96);没有就返回 null */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16), lo = parseInt(m[3]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** 是不是可以连的公网地址。不是合法 IP 一律按"不是"处理 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const family = net.isIP(bare);
  if (family === 4) return !BLOCKED.check(bare, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedV4(bare);
  if (v4 !== null) return net.isIPv4(v4) && !BLOCKED.check(v4, "ipv4");
  // 其它 ::/96 形态(已废弃的 IPv4 兼容地址)也可能包着内网 IPv4,整段拒
  if (BLOCKED.check(bare, "ipv6") || /^::[0-9a-f.:]*$/.test(bare)) return false;
  return true;
}

/** 地址不是公网时的错误码(调用方按它给出"地址被拒"而不是"网络不通") */
export const NON_PUBLIC_CODE = "ENONPUBLIC";

type LookupFn = typeof dns.lookup;

/**
 * 给 http(s).request 用的 lookup:解析出的**每一个**地址都要是公网,否则整条拒绝
 * (只挑一个公网地址去连,系统换地址重试时仍可能落到内网那一个)。
 */
export function publicOnlyLookup(resolve: LookupFn = dns.lookup, allowed: (ip: string) => boolean = isPublicAddress) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) { callback(err); return; }
      const list = addresses as unknown as dns.LookupAddress[];
      const bad = list.find((a) => !allowed(a.address));
      if (!list.length || bad) {
        callback(Object.assign(new Error(`${hostname} 解析到了非公网地址${bad ? ` ${bad.address}` : ""},不允许连接`), { code: NON_PUBLIC_CODE }));
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** 没有响应体的状态码:Response 构造时不能带 body */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * 按 Content-Encoding 建解压流(多层编码按相反顺序解)。认不出的编码返回 null,正文原样给出——与 fetch 一致。
 * 以前直接把压缩字节当正文,`JSON.parse` 失败,正常端点被报成 bad_json(审计第二轮 A1 修复引入)。
 */
function decoders(encoding: string | undefined): NodeJS.ReadWriteStream[] | null {
  const codings = (encoding ?? "").toLowerCase().split(",").map((s) => s.trim()).filter((s) => s && s !== "identity");
  const out: NodeJS.ReadWriteStream[] = [];
  for (const c of codings.reverse()) {
    if (c === "gzip" || c === "x-gzip") out.push(zlib.createGunzip());
    else if (c === "deflate") out.push(zlib.createInflate());
    else if (c === "br") out.push(zlib.createBrotliDecompress());
    else return null;
  }
  return out;
}

/**
 * 只连公网地址的 POST。返回标准 `Response`,调用方的跳转 / 超时 / 取消处理不用改。
 * 不跟随跳转(由调用方按 3xx 报错);每次新建连接,不复用别的请求留下的 socket。
 */
export function publicOnlyPost(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal },
  deps: { resolve?: LookupFn; allowed?: (ip: string) => boolean } = {}): Promise<Response> {
  return publicOnlyRequest(url, { method: "POST", ...init }, deps);
}

/** 只连公网地址的 GET(设置页「获取可用模型」用),其余规则与 publicOnlyPost 相同 */
export function publicOnlyGet(url: string, init: { headers: Record<string, string>; signal: AbortSignal },
  deps: { resolve?: LookupFn; allowed?: (ip: string) => boolean } = {}): Promise<Response> {
  return publicOnlyRequest(url, { method: "GET", ...init }, deps);
}

function publicOnlyRequest(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
  deps: { resolve?: LookupFn; allowed?: (ip: string) => boolean }): Promise<Response> {
  const target = new URL(url);
  const allowed = deps.allowed ?? isPublicAddress;
  const host = target.hostname.replace(/^\[|\]$/g, "");
  // IP 字面量不会经过 lookup,这里直接查
  if (net.isIP(host) && !allowed(host)) {
    return Promise.reject(Object.assign(new Error(`${host} 不是公网地址,不允许连接`), { code: NON_PUBLIC_CODE }));
  }
  const mod = target.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(target, {
      method: init.method,
      // 与 fetch 一样声明能解压的编码(调用方自己给了就用调用方的)
      headers: {
        "accept-encoding": "gzip, deflate, br", ...init.headers,
        ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}),
      },
      signal: init.signal,
      agent: false,
      lookup: publicOnlyLookup(deps.resolve, allowed) as unknown as net.LookupFunction,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
      }
      if (NULL_BODY.has(status)) { res.resume(); resolve(new Response(null, { status, headers })); return; }
      const chain = decoders(res.headers["content-encoding"]);
      // pipeline:任何一段出错或被取消(超时 / abort 会销毁 res),整条链连同解压流一起销毁
      const body: Readable = chain?.length ? pipeline([res, ...chain], () => {}) as unknown as Readable : res;
      try {
        resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (e) { res.destroy(); reject(e); }
    });
    req.on("error", reject);
    if (init.body !== undefined) req.end(init.body); else req.end();
  });
}
