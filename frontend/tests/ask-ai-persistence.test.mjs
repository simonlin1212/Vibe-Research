import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SRC = new URL("../src/components/ui/AskAiButton.tsx", import.meta.url);
const source = await readFile(SRC, "utf8");

// 这些断言锁的是 #19 的修复：对话此前只存在组件 useState 里，
// 切页面/刷新就全丢。用户反馈「关闭 AI 就找不回之前的对话」，
// 而每轮对话都花了他自己的 API 额度。

test("Ask AI persists the conversation through the safe storage helper", () => {
  assert.match(source, /from "@\/lib\/storage"/);
  assert.match(source, /storageGet/);
  assert.match(source, /storageSet/);
  // 必须走 storage.ts 的封装：localStorage 在隐私模式/配额写满时会直接抛异常，
  // 裸调会让整个面板崩掉。
  assert.doesNotMatch(source, /(?<!\/\/.*)\blocalStorage\.(get|set|remove)Item\b/);
});

test("conversations are keyed per route, not shared across pages", () => {
  assert.match(source, /useLocation/);
  assert.match(source, /CHAT_KEY_PREFIX\s*\+\s*pathname/);
});

test("persisted history is capped so localStorage cannot be blown out", () => {
  assert.match(source, /MAX_PERSISTED_MSGS\s*=\s*\d+/);
  assert.match(source, /slice\(-MAX_PERSISTED_MSGS\)/);
});

test("malformed stored data is ignored instead of crashing the panel", () => {
  // 存量数据可能来自旧版本或被手工改坏；JSON.parse 必须包 try/catch，
  // 且要校验形状，否则脏数据会让页面白屏。
  assert.match(source, /try\s*\{[\s\S]*JSON\.parse[\s\S]*\}\s*catch/);
  assert.match(source, /Array\.isArray\(parsed\)/);
});

test("there is a way to clear a stored conversation", () => {
  assert.match(source, /storageRemove/);
  assert.match(source, /clearChat/);
});

test("emptying the conversation removes the key rather than storing an empty shell", () => {
  assert.match(source, /if \(!msgs\.length\)\s*\{\s*\n?\s*storageRemove\(key\)/);
});

test("key and messages are stored in one atomic state, not a ref", () => {
  // 分成 msgs + 归属 ref 是不够的：key 变化那一帧 ref 已指向新 key 而 msgs 仍是旧的
  // （setState 下一帧才生效），守卫会误放行、覆盖目标 key 已存的对话。
  assert.match(source, /useState<\{ key: string; msgs: StoredMsg\[\] \}>/);
  assert.match(source, /if \(chat\.key !== chatKey\) return;/);
  assert.doesNotMatch(source, /loadedKeyRef/);
});

test("switching keys aborts an in-flight stream", () => {
  // 否则迟到的 chunk 会被追加到目标页的对话上，且存的是用来源页上下文生成的回答。
  const effect = source.match(/useEffect\(\(\) => \{[\s\S]*?setChat\(\{ key: chatKey[\s\S]*?\}, \[chatKey\]\);/);
  assert.ok(effect, "未找到 chatKey 切换的 effect");
  assert.match(effect[0], /abortRef\.current\?\.abort\(\)/);
});

test("callers can scope a conversation below the route level", () => {
  // 个股页不换路由就能换标的：只按 pathname 分 key 会让 A 股票的历史
  // 作为 history 发给正在问 B 股票的模型。
  assert.match(source, /scopeKey\?: string/);
  assert.match(source, /CHAT_KEY_PREFIX \+ pathname \+ \(scopeKey \? `#\$\{scopeKey\}` : ""\)/);
});

test("panel is portaled to document.body so glass backdrop-filter cannot trap fixed", () => {
  // .glass 的 backdrop-filter 会让 position:fixed 相对卡片定位，弹层缩成一条。
  assert.match(source, /createPortal/);
  assert.match(source, /document\.body/);
});

test("the stock page actually passes a per-symbol scope", async () => {
  const page = await readFile(
    new URL("../src/pages/StockData.tsx", import.meta.url), "utf8",
  );
  assert.match(page, /<AskAiButton[\s\S]*?scopeKey=/);
  // 必须用已解析结果的代码，不能用一边打字一边变的输入框 state
  assert.match(page, /scopeKey=\{gstock \? `g:\$\{gstock\.code\}` : val\?\.code\}/);
  const valAt = page.indexOf("api.valuation(c)");
  const marginAt = page.indexOf("api.margin(c)");
  const gStockAt = page.indexOf("api.globalStock(c)");
  const hkAt = page.indexOf("api.hkCashflow(c)");
  assert.ok(valAt > 0 && marginAt > valAt, "A 股资金面在估值之后");
  assert.ok(gStockAt > 0 && hkAt > gStockAt, "美股明细在报价之后");
});

test("aborted-request cleanup is gated by request identity", () => {
  // 换页会中止旧请求，其 catch 可能在用户已于新页面发起提问后才落地。
  // 不校验就会删掉新请求的空气泡，后续 chunk 无处可写、对话残缺。
  const block = source.match(/\} catch \(e\) \{[\s\S]*?\} finally \{/);
  assert.ok(block, "未找到 catch 块");
  // 不能简单用 abortRef.current === ac：close() 会把它置 null，
  // 那种情况下空气泡**仍要清理**，否则会被持久化成一条空回复。
  assert.match(block[0], /const superseded = abortRef\.current !== null && abortRef\.current !== ac;/);
  assert.match(block[0], /if \(!superseded && chatKeyRef\.current === startedKey\)/);
});

test("streaming replies are partial from creation and only cleared on success", () => {
  // 每个 delta 都会触发落盘，所以「中止时再补标记」来不及：
  // 流到一半换页/换标的，存下来的就是一条被当作完整回答的残句，
  // 回到该对话时还会以完整发言的身份进入下一轮 history。
  assert.match(source, /partial\?: boolean/);
  assert.match(source, /role: "assistant", content: "", tools: \[\], partial: true/); // 创建即标
  assert.match(source, /const \{ partial: _drop, \.\.\.rest \} = msg;/);            // 成功才摘
  assert.match(source, /const keep = completeTurns\(msgs\)/);                        // 不落盘
  assert.match(source, /completeTurns\(msgs\)\.map/);                                // 不进 history
});

test("an interrupted turn drops the question too, not just the half answer", () => {
  // 只丢 assistant 会留下孤立的提问，模型在 history 里看到连续两条 user 发言，
  // 会把那个被放弃的问题当成还在等回答，去答错的题。
  assert.match(source, /function completeTurns/);
  assert.match(source, /if \(out\.length && out\[out\.length - 1\]\.role === "user"\) out\.pop\(\);/);
});

test("a request that fails before any content removes its question too", () => {
  // 对称情况：一个字都没收到时删空气泡，若不连提问一起删，
  // 界面和存储里都会留下孤立的 user turn，下一轮就是连续两条 user。
  const block = source.match(/\} catch \(e\) \{[\s\S]*?\} finally \{/);
  assert.ok(block, "未找到 catch 块");
  assert.match(block[0], /const dropUser = m\[m\.length - 2\]\?\.role === "user";/);
  assert.match(block[0], /m\.slice\(0, dropUser \? -2 : -1\)/);
});
