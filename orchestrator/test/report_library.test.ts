import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FINANCE_PLUGIN } from "../src/finance/register.ts";
import { reportContextAsync, searchReportsAsync } from "../src/report_library.ts";
import type { ReportRecallPlan, ReportRecord } from "../src/report_library.ts";

/** 召回计划只比 reason 与 reportIds;query 由各用例按需单独断言 */
const planOf = (p: ReportRecallPlan | null) => (p ? { reason: p.reason, ...(p.reportIds ? { reportIds: p.reportIds } : {}) } : null);
import { ReportLibraryError, addReport, listReports, removeReport, reportCitationErrors, reportCitations, reportContext, reportFile, reportRecallPlan, reportsForSymbol, searchReports } from "../src/report_library.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-reports-"));
const b64 = (buf: Buffer, mime = "text/plain") => `data:${mime};base64,${buf.toString("base64")}`;

/** 生成一页、带真文字层的最小 PDF；xref 偏移动态计算，避免拿机器外的夹具。 */
function tinyPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, (m) => `\\${m}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

test("TXT 入库后原文件、正文索引、代码标签与检索引用同时成立", async () => {
  const root = tmp();
  const rec = await addReport(root, {
    name: "中际旭创300308调研.md",
    content: b64(Buffer.from("中际旭创 300308\n核心观点：收入增长来自高速光模块需求。", "utf8")),
  });
  assert.equal(rec.symbols.includes("300308"), true);
  assert.equal(rec.chars > 10, true);
  assert.equal(listReports(root).length, 1);
  const stored = reportFile(root, rec.id);
  assert.ok(stored && fs.readFileSync(stored.path, "utf8").includes("收入增长"));
  const hit = reportContext(root, "中际旭创的收入");
  assert.ok(hit?.text.includes(`[资料:${rec.id} p.-]`));
  assert.ok(hit?.text.includes("收入增长"));
  assert.ok(!hit?.text.includes("texts/"), "对话只能收到命中片段，不能获得完整正文路径");
});

test("PDF 真文字层可提取页码，并进入个股研究的代码召回", async () => {
  const root = tmp();
  const rec = await addReport(root, {
    name: "300308-report.pdf",
    content: b64(tinyPdf("300308 revenue growth"), "application/pdf"),
  });
  assert.equal(rec.pages, 1);
  assert.equal(rec.symbols.includes("300308"), true);
  const recalled = reportsForSymbol(root, "300308");
  assert.ok(recalled?.text.includes(`[资料:${rec.id} p.1]`));
  assert.ok(recalled?.text.includes("revenue growth"));
  assert.ok(!recalled?.text.includes("可继续读取:"), "研究线程禁止读取运行目录之外，不能给外部路径");
});

test("检索归一化不会让长文后页的片段与页码错位", async () => {
  const root = tmp();
  const firstPage = Array.from({ length: 500 }, (_, i) => `第一页填充${i}\n\n\n`).join("");
  const rec = await addReport(root, {
    name: "分页研报.md",
    content: b64(Buffer.from(`--- 第 1 页 ---\n${firstPage}--- 第 2 页 ---\n第二页独有结论：光模块需求继续增长。`, "utf8")),
  });
  const hit = reportContext(root, "光模块需求");
  assert.ok(hit?.text.includes(`[资料:${rec.id} p.2]`));
  assert.ok(hit?.text.includes("第二页独有结论"));
  assert.ok(!hit?.text.includes("第一页填充0"), "命中后页时不能按归一化坐标截取前页原文");
});

test("研报引用必须来自本轮真实命中，且页码不能由模型编造", () => {
  const id = "a".repeat(32);
  const sources = [{ id, name: "研究.pdf", page: 3 }];
  assert.deepEqual(reportCitationErrors("结论没有来源", sources), ["资料片段已进入本轮上下文，但回答没有保留任何 [资料:<id> p.<页码>] 引用"]);
  assert.ok(reportCitationErrors(`[资料:${id} p.4]`, sources).some((e) => e.includes("页码应为 p.3")));
  assert.ok(reportCitationErrors(`[资料:${"b".repeat(32)} p.3]`, sources).some((e) => e.includes("本轮未提供")));
  assert.deepEqual(reportCitationErrors(`该判断来自原文 [资料:${id} p.3]`, sources), []);
  assert.deepEqual(reportCitations(`前文 [资料:${id} p.3]`), [{ id, page: 3 }]);
});

test("检索片段优先覆盖不同查询词，不被封面单词重复或正文靠后误导", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rec = await addReport(root, {
    name: "会议纪要.md",
    content: b64(Buffer.from(`--- 第 1 页 ---\n${"收入 封面标题\n".repeat(1200)}\n--- 第 2 页 ---\n收入增长驱动因素：海外新产线交付带来新增需求。`)),
  });
  const [hit] = searchReports(root, "收入增长驱动因素");
  assert.equal(hit?.id, rec.id, "正文检索不能要求文件名也命中");
  assert.equal(hit?.page, 2);
  assert.match(hit!.snippet, /海外新产线交付带来新增需求/);
  assert.doesNotMatch(hit!.snippet, /封面标题/);
  assert.ok(hit!.snippet.length <= 1782);
});

test("片段覆盖跨扫描窗口的相邻关键词，保留 NFKC 原文与真实页码", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await addReport(root, {
    name: "note.md",
    content: b64(Buffer.from(`--- 第 7 页 ---\n${"growth filler\n".repeat(400)}--- 第 8 页 ---\n${"填".repeat(1460)}ＲＥＶＥＮＵＥ\n\n\n\nｇｒｏｗｔｈ：ｏｆﬁｃｅ新业务贡献。${"尾".repeat(2000)}`)),
  });
  const [hit] = searchReports(root, "revenue growth office");
  assert.equal(hit?.page, 8);
  assert.match(hit!.snippet, /ＲＥＶＥＮＵＥ/);
  assert.match(hit!.snippet, /ｏｆﬁｃｅ新业务贡献/);
  assert.doesNotMatch(hit!.snippet, /growth filler/);
});

test("同一引用片段不拼接相邻页，选定资料范围与无词命中兜底不变", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rec = await addReport(root, {
    name: "selected.md",
    content: b64(Buffer.from("--- 第 3 页 ---\nrevenue 本页资料。\n--- 第 4 页 ---\ngrowth 另一页的资料。")),
  });
  await addReport(root, { name: "unselected.md", content: b64(Buffer.from("revenue growth 更高相关性但未获授权。")) });
  const hits = searchReports(root, "revenue growth", { reportIds: [rec.id] });
  assert.deepEqual(hits.map((hit) => hit.id), [rec.id]);
  assert.equal(hits[0]!.page, 3, "相同覆盖分数按正文先后稳定选择");
  assert.match(hits[0]!.snippet, /本页资料/);
  assert.doesNotMatch(hits[0]!.snippet, /另一页的资料|未获授权/);
  const [fallback] = searchReports(root, "unmatched", { reportIds: [rec.id], mustInclude: true });
  assert.equal(fallback?.page, 3);
  assert.match(fallback!.snippet, /本页资料/);
  assert.doesNotMatch(fallback!.snippet, /另一页的资料/);
});

test("同一文件重复上传不复制；删除同时移除原文件与正文，但不碰其他报告", async () => {
  const root = tmp();
  const content = b64(Buffer.from("300308 同一份内容"));
  const a = await addReport(root, { name: "a.txt", content });
  const b = await addReport(root, { name: "rename.txt", content });
  const other = await addReport(root, { name: "b.txt", content: b64(Buffer.from("600519 另一份")) });
  assert.equal(a.id, b.id);
  const file = reportFile(root, a.id)!.path;
  assert.equal(await removeReport(root, a.id), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(listReports(root).map((r) => r.id), [other.id]);
  assert.equal(await removeReport(root, a.id), false);
});

test("候选先排名再提片段：排序、上限、页码及未入选资料的版本核验不变", async t => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const revisions: Record<string, string> = {};
  const records: ReportRecord[] = [];
  for (let i = 0; i < 25; i++) {
    const text = `--- 第 1 页 ---\n无关封面 ${i}\n--- 第 2 页 ---\nrevenue growth 第 ${i} 份资料。`;
    const rec = await addReport(root, { name: i === 0 ? "revenue growth.md" : `test-${i}.md`, content: b64(Buffer.from(text)) });
    records.push(rec);
    const stored = fs.readFileSync(path.join(root, "knowledge/reports", rec.text_file), "utf8");
    revisions[rec.id] = crypto.createHash("sha256").update(stored.endsWith("\n") ? stored.slice(0, -1) : stored).digest("hex");
  }
  const hits = searchReports(root, "revenue growth", { limit: 100 });
  assert.equal(hits.length, 20);
  assert.equal(hits[0]?.id, records[0]?.id, "文件名命中排序优先，不能先截文件数");
  assert.ok(hits.every(h => h.page === 2 && h.snippet.includes("revenue growth")));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    assert.deepEqual(await searchReportsAsync(root, "revenue growth", { limit: 100 }), hits);
    assert.ok(ticks > 0, "异步入口在全库扫描结束前须允许其他事件运行");
    assert.deepEqual(await reportContextAsync(root, "revenue growth"), reportContext(root, "revenue growth"));
  } finally { clearInterval(timer); }
  const ac = new AbortController();
  setImmediate(() => ac.abort());
  await assert.rejects(searchReportsAsync(root, "revenue growth", {}, ac.signal),
    e => e instanceof ReportLibraryError && e.code === "cancelled");
  assert.deepEqual(searchReports(root, "revenue growth", { limit: 1.9 }), hits.slice(0, 1));
  assert.deepEqual(searchReports(root, "revenue growth", { limit: NaN }), []);
  const loser = records.find(r => !hits.some(h => h.id === r.id))!;
  revisions[loser.id] = "0".repeat(64);
  assert.throws(() => searchReports(root, "revenue growth", { limit: 1, expectedRevisions: revisions }),
    e => e instanceof ReportLibraryError && e.code === "report_revision_mismatch");
});

test("损坏索引 fail-loud，绝不把它当空库覆盖；不支持的格式给出真实范围", async () => {
  const root = tmp();
  const manifest = path.join(root, "knowledge", "reports", "manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "{broken");
  assert.throws(() => listReports(root), (e: unknown) => e instanceof ReportLibraryError && e.code === "report_index_corrupt");
  await assert.rejects(
    addReport(tmp(), { name: "old.doc", content: b64(Buffer.from("x")) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "unsupported_report_type",
  );
});

test("非法 UTF-8 / GBK 字节必须明确失败，不能以乱码状态显示已接入 Agent", async () => {
  await assert.rejects(
    addReport(tmp(), { name: "gbk.txt", content: b64(Buffer.from([0xd6, 0xd0, 0xbc, 0xca])) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "report_parse_failed" && /UTF-8/.test(e.message),
  );
});

test("A股 / 港股 / 美股代码都能成为归档与对话检索键", async () => {
  const root = tmp();
  const hk = await addReport(root, { name: "腾讯控股-HK:700.docx.txt", content: b64(Buffer.from("港股 HK:700 业务复盘")) });
  const us = await addReport(root, { name: "NASDAQ-NVDA.md", content: b64(Buffer.from("Ticker: NVDA datacenter demand")) });
  assert.deepEqual(hk.symbols, ["00700"]);
  assert.deepEqual(us.symbols, ["NVDA"]);
  assert.ok(reportsForSymbol(root, "00700")?.hits.some((x) => x.id === hk.id));
  assert.ok(reportsForSymbol(root, "NVDA")?.hits.some((x) => x.id === us.id));
});

test("普通六位业务数字不能冒充 A 股代码；只有公司名的研报仍能按主体召回", async () => {
  const root = tmp();
  const macro = await addReport(root, {
    name: "电力行业月报.md",
    content: b64(Buffer.from("本月新增并网装机 300308 千瓦，累计利用小时 128900。")),
  });
  const company = await addReport(root, {
    name: "中际旭创跟踪笔记.txt",
    content: b64(Buffer.from("中际旭创的高速光模块订单与产能跟踪。")),
  });
  assert.deepEqual(macro.symbols, [], "单位前的六位数字不是证券代码");
  assert.deepEqual(company.symbols, [], "正文没有明确代码时不应猜代码");
  const recalled = reportsForSymbol(root, "300308", { companyName: "中际旭创" });
  assert.ok(recalled?.hits.some((x) => x.id === company.id), "公司名必须参与无代码研报的召回");
  assert.ok(!recalled?.hits.some((x) => x.id === macro.id), "业务数字相同的无关报告不能被召回");
});

test("旧版索引会按新规则重建代码标签，精确召回也不会混入正文偶遇同号的报告", async () => {
  const root = tmp();
  const exact = await addReport(root, { name: "300308-公司报告.md", content: b64(Buffer.from("公司代码：300308，收入增长。")) });
  const macro = await addReport(root, { name: "行业统计.md", content: b64(Buffer.from("新增装机 300308 千瓦。")) });
  const manifest = path.join(root, "knowledge", "reports", "manifest.json");
  const old = JSON.parse(fs.readFileSync(manifest, "utf8"));
  old.schema_version = 1;
  old.reports.find((r: { id: string }) => r.id === macro.id).symbols = ["300308"];
  fs.writeFileSync(manifest, JSON.stringify(old));
  const records = listReports(root);
  assert.deepEqual(records.find((r) => r.id === macro.id)?.symbols, []);
  assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).schema_version, 3);
  const recalled = reportsForSymbol(root, "300308");
  assert.deepEqual(recalled?.hits.map((x) => x.id), [exact.id]);
});

test("研报目录里的符号链接不能把上传写到用户数据根之外", async () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "knowledge", "reports"));
  await assert.rejects(
    addReport(root, { name: "300308.md", content: b64(Buffer.from("300308 x")) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "report_path_symlink",
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("普通对话的资料召回只认明确意图 / 代码 / 标题主体，泛词不触发（#39）", async () => {
  const root = tmp();
  const rec = await addReport(root, {
    name: "中际旭创300308调研.md",
    content: b64(Buffer.from("中际旭创 300308\n今日市场数据显示光模块需求旺盛。", "utf8")),
  });
  await addReport(root, {
    name: "市场数据周报.md",
    content: b64(Buffer.from("今日市场数据：成交额放大，情绪回暖。", "utf8")),
  });
  assert.equal(reportRecallPlan(root, "请做今日复盘，概括市场情绪与指数表现"), null, "泛词不能触发召回");
  assert.equal(reportRecallPlan(root, "成交额 今日 数据 情绪"), null, "报告正文里的常见词不能触发召回");
  assert.deepEqual(planOf(reportRecallPlan(root, "请解读我上传的报告")), { reason: "explicit" });
  assert.deepEqual(planOf(reportRecallPlan(root, "资料库里怎么说")), { reason: "explicit" });
  assert.deepEqual(planOf(reportRecallPlan(root, "300308 最近怎么看")), { reason: "symbol", reportIds: [rec.id] });
  assert.equal(reportRecallPlan(root, "1300308 不是代码"), null, "代码前后接着数字不算命中");
  assert.deepEqual(planOf(reportRecallPlan(root, "中际旭创的核心观点是什么")), { reason: "title", reportIds: [rec.id] });
  assert.equal(reportRecallPlan(root, "周报怎么写"), null, "文件名只剩通用词时不构成主体");
  assert.equal(reportRecallPlan(root, ""), null);
  assert.deepEqual(planOf(reportRecallPlan(tmp(), "请解读我上传的报告")), { reason: "explicit" }, "空库也认明确意图，由 reportContext 自己返回 null");
});

test("垂类召回规则经 Plugin 注入:通用规则不认的文档类型词,注入后不再当主体（#39）", async () => {
  const root = tmp();
  const rec = await addReport(root, { name: "贵州茅台年报.md", content: b64(Buffer.from("贵州茅台 营收增长。", "utf8")) });
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  assert.equal(reportRecallPlan(root, "贵州茅台怎么看", {}), null, "Core 不认识行业词:文件名整串当主体,消息命不中");
  assert.deepEqual(planOf(reportRecallPlan(root, "贵州茅台怎么看", rules)), { reason: "title", reportIds: [rec.id] }, "注入金融停用词后主体是「贵州茅台」");
  assert.equal(reportRecallPlan(root, "年报季到了", rules), null, "文档类型词本身不是主体");
  assert.deepEqual(planOf(reportRecallPlan(root, "研报里怎么说", rules)), { reason: "explicit" }, "垂类意图词与通用意图并列生效");
  assert.equal(reportRecallPlan(root, "研报里怎么说", {}), null, "没注入时 Core 不认识这个词");
});

test("标题主体:英文整词、连字符拆词、中文只剥首尾停用词（Codex r1 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const cat = await addReport(root, { name: "CAT analysis.txt", content: b64(Buffer.from("Caterpillar market analysis: dealer inventory normalizing.", "utf8")) });
  const apple = await addReport(root, { name: "apple-annual-report.md", content: b64(Buffer.from("Apple annual report: services revenue.", "utf8")) });
  const sjg = await addReport(root, { name: "数据港年报.md", content: b64(Buffer.from("数据港 机柜上架率提升。", "utf8")) });
  assert.equal(reportRecallPlan(root, "education market analysis", rules), null, "cat 不能命中 education 里的子串");
  assert.deepEqual(planOf(reportRecallPlan(root, "what about CAT this quarter", rules)), { reason: "title", reportIds: [cat.id] });
  assert.deepEqual(planOf(reportRecallPlan(root, "Apple outlook", rules)), { reason: "title", reportIds: [apple.id] }, "连字符文件名要拆成词");
  assert.equal(reportRecallPlan(root, "annual results", rules), null, "拆出来的通用词不算主体");
  assert.deepEqual(planOf(reportRecallPlan(root, "数据港怎么看", rules)), { reason: "title", reportIds: [sjg.id] }, "公司名里含停用词也要保住");
  assert.equal(reportRecallPlan(root, "今日数据更新", rules), null, "「数据」本身仍不触发");
});

test("英文虚词不构成主体；点名带扩展名的文件名即显式指定（Codex r2 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const semi = await addReport(root, { name: "Outlook for the semiconductor industry.md", content: b64(Buffer.from("Semiconductor demand outlook: capex cycle.", "utf8")) });
  const notes = await addReport(root, { name: "notes.txt", content: b64(Buffer.from("meeting notes: capex up 20%.", "utf8")) });
  assert.equal(reportRecallPlan(root, "P/E for Nvidia", rules), null, "for / the 这类虚词不能当主体");
  assert.deepEqual(planOf(reportRecallPlan(root, "semiconductor demand this year", rules)), { reason: "title", reportIds: [semi.id] });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize notes.txt", rules)), { reason: "name", reportIds: [notes.id] }, "点名文件即显式指定，哪怕它的词全是通用词");
  assert.equal(reportRecallPlan(root, "my notes on capex", rules), null, "裸的通用词不触发");
  assert.deepEqual(planOf(reportRecallPlan(root, "把这个 PDF 总结一下", rules)), { reason: "explicit" });
  assert.equal(reportRecallPlan(root, "PDF 怎么转 DOCX？", rules), null, "裸的格式词不是在要资料");
});

test("公司全称文件名剥出简称：「贵州茅台股份有限公司…年度报告」→「贵州茅台」（Codex r3 P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const rec = await addReport(root, { name: "贵州茅台股份有限公司2023年年度报告.md", content: b64(Buffer.from("贵州茅台 营收。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "贵州茅台怎么看", rules)), { reason: "title", reportIds: [rec.id] });
  assert.equal(reportRecallPlan(root, "有限公司怎么注册", rules), null, "后缀本身不是主体");
});

test("按页问答:召回意图只看【问题】部分,页面上下文里的「研报 / 公告 / 代码」不触发（Codex r3 P1）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const mt = await addReport(root, { name: "贵州茅台600519深度.md", content: b64(Buffer.from("贵州茅台 600519 直营占比提升。", "utf8")) });
  const other = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能出货。", "utf8")) });
  const page = "【当前页面：个股数据】\n个股：贵州茅台（600519）\n近期公告：分红方案\n近期研报：xxx；yyy";
  assert.equal(reportRecallPlan(root, `${page}\n\n【问题】\n今天走势怎么样`, rules), null, "页面上下文的研报 / 代码不算用户意图");
  const explicit = reportRecallPlan(root, `${page}\n\n【问题】\n研报里怎么说`, rules);
  assert.deepEqual(planOf(explicit), { reason: "explicit", reportIds: [mt.id] }, "明确要资料且停在某主体页面 → 只召回该主体的资料");
  assert.ok(!explicit!.query.includes("近期公告"), "打分查询不含页面上下文");
  assert.deepEqual(planOf(reportRecallPlan(root, `${page}\n\n【问题】\n300750 怎么看`, rules)), { reason: "symbol", reportIds: [other.id] }, "问题里的代码照常命中");
  assert.deepEqual(planOf(reportRecallPlan(root, "研报里怎么说", rules)), { reason: "explicit" }, "没有页面上下文 → 全库");
});

test("问题里明确指到的目标优先于页面主体；港股别名写法规范成五位码（Codex r4 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const mt = await addReport(root, { name: "贵州茅台600519深度.md", content: b64(Buffer.from("贵州茅台 600519 直营。", "utf8")) });
  const nd = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能。", "utf8")) });
  const tc = await addReport(root, { name: "腾讯点评.md", content: b64(Buffer.from("港股 HK:700 游戏收入回暖。", "utf8")) });
  assert.equal(tc.symbols.includes("00700"), true, "入库把 HK:700 规范成五位码");
  const page = "【当前页面：个股数据】\n个股：贵州茅台（600519）";
  assert.deepEqual(planOf(reportRecallPlan(root, `${page}\n\n【问题】\n研报里怎么说 300750`, rules)), { reason: "symbol", reportIds: [nd.id] }, "问题里的代码优先于页面主体");
  assert.deepEqual(planOf(reportRecallPlan(root, `${page}\n\n【问题】\n研报里怎么说`, rules)), { reason: "explicit", reportIds: [mt.id] }, "问题没有目标才回退页面主体");
  assert.deepEqual(planOf(reportRecallPlan(root, "700.HK 最近怎么样", rules)), { reason: "symbol", reportIds: [tc.id] });
  assert.deepEqual(planOf(reportRecallPlan(root, "HK:700 最近怎么样", rules)), { reason: "symbol", reportIds: [tc.id] });
  assert.equal(reportRecallPlan(root, "700 路公交", rules), null, "裸数字不是港股写法");
});

test("「我的资料」页：明确意图无目标时，页面里列出的文件名也是页面主体（无代码的行业 / 宏观资料不再漏，Codex r5 P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const macro = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性边际宽松，核心观点：关注利率。", "utf8")) });
  const semi = await addReport(root, { name: "半导体深度.md", content: b64(Buffer.from("先进封装需求。", "utf8")) });
  const other = await addReport(root, { name: "贵州茅台600519深度.md", content: b64(Buffer.from("贵州茅台 600519。", "utf8")) });
  assert.deepEqual(macro.symbols, [], "宏观资料没有代码");
  const page = "【当前页面：我的资料】\n已上传：宏观月报.md；半导体深度.md";
  const plan = reportRecallPlan(root, `${page}\n\n【问题】\n从我的研报里找核心观点`, rules);
  assert.equal(plan?.reason, "explicit");
  assert.deepEqual(new Set(plan!.reportIds), new Set([macro.id, semi.id]), "页面列出的两份都在，没列的不在");
  assert.ok(plan!.query.includes("宏观月报.md"), "打分查询带上文件名，保证能命中");
  assert.ok(!plan!.reportIds!.includes(other.id));
});

test("短字母代码只认大写整词；量词式指称算明确意图（Codex r6 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const on = await addReport(root, { name: "onsemi.md", content: b64(Buffer.from("NASDAQ: ON — silicon carbide ramp.", "utf8")) });
  assert.ok(on.symbols.includes("ON"), "入库识别出 ticker ON");
  const cat = await addReport(root, { name: "CAT analysis.txt", content: b64(Buffer.from("Caterpillar dealer inventory.", "utf8")) });
  assert.equal(reportRecallPlan(root, "focus on margins this quarter", rules), null, "小写 on 是英文单词，不是代码");
  assert.equal(reportRecallPlan(root, "my cat is sick", rules), null, "小写 cat 不是 CAT");
  assert.deepEqual(planOf(reportRecallPlan(root, "what about ON here", rules)), { reason: "symbol", reportIds: [on.id] });
  assert.deepEqual(planOf(reportRecallPlan(root, "$ON vs ON.US", rules)), { reason: "symbol", reportIds: [on.id] });
  assert.deepEqual(planOf(reportRecallPlan(root, "CAT outlook", rules)), { reason: "title", reportIds: [cat.id] });
  const page = "【当前页面：我的资料】\n已上传：onsemi.md；CAT analysis.txt";
  const plan = reportRecallPlan(root, `${page}\n\n【问题】\n比较这两份报告的核心观点`, rules);
  assert.equal(plan?.reason, "explicit", "「这两份报告」是明确意图");
  assert.deepEqual(new Set(plan!.reportIds), new Set([on.id, cat.id]));
  assert.equal(reportRecallPlan(root, "所有报告都看过了吗", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "compare these reports", rules)?.reason, "explicit");
});

test("文件名按边界比、别名并入打分查询、英文单数指称、列表页不限定范围（Codex r7 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const notes = await addReport(root, { name: "notes.txt", content: b64(Buffer.from("plain notes.", "utf8")) });
  const meeting = await addReport(root, { name: "meeting-notes.txt", content: b64(Buffer.from("meeting notes: capex.", "utf8")) });
  const tc = await addReport(root, { name: "腾讯点评.md", content: b64(Buffer.from("港股 HK:700 游戏收入。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize meeting-notes.txt", rules)), { reason: "name", reportIds: [meeting.id] }, "notes.txt 不能连带命中");
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize notes.txt", rules)), { reason: "name", reportIds: [notes.id] });
  const hk = reportRecallPlan(root, "700.HK 最近怎么样", rules);
  assert.deepEqual(planOf(hk), { reason: "symbol", reportIds: [tc.id] });
  assert.ok(hk!.query.includes("00700"), "打分查询带入库形式的代码");
  assert.equal(reportRecallPlan(root, "summarize this report", rules)?.reason, "explicit", "英文单数指称");
  const one = reportRecallPlan(root, "【当前页面：我的资料】\n已上传：notes.txt\n\n【问题】\nsummarize this report", rules);
  assert.deepEqual(planOf(one), { reason: "explicit", reportIds: [notes.id] }, "页面只列一份 → 就是它");
  const listing = ["notes.txt", "meeting-notes.txt", "腾讯点评.md"].join("；");
  const many = reportRecallPlan(root, `【当前页面：我的资料】\n已上传：${listing}\n\n【问题】\n所有报告里找核心观点`, rules);
  assert.equal(many?.reason, "explicit");
  assert.equal(many?.wantsAll, true, "「所有报告」= 圈定全库");
  assert.deepEqual(new Set(many!.reportIds), new Set([notes.id, meeting.id, tc.id]), "全库恰好是这三份");
  const generic = reportRecallPlan(root, `【当前页面：我的资料】\n已上传：${listing}\n\n【问题】\n资料库里找核心观点`, rules);
  assert.deepEqual(planOf(generic), { reason: "explicit" }, "没说「所有」时列了 ≥3 个文件名是列表页，不按它限定范围");
});

test("常驻控制台的「我正在看某页」前缀也算页面上下文，页面标题里的词不触发召回（Codex r8 P1）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  assert.equal(reportRecallPlan(root, "（我正在看「我的研报」这一页）\n今天怎么样", rules), null, "标题里的「研报」不是用户意图");
  assert.deepEqual(planOf(reportRecallPlan(root, "（我正在看「我的研报」这一页）\n研报里怎么说", rules)), { reason: "explicit" }, "问题本身明确要资料才召回");
  assert.equal(reportRecallPlan(root, "我正在看研报这一页，今天怎么样", rules)?.reason, "explicit", "不是包装格式的普通句子照常按问题判");
});

test("页面范围取并集且认港股别名；中文标题按体裁词切段（Codex r9 P2 ×3）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const mt = await addReport(root, { name: "贵州茅台600519深度.md", content: b64(Buffer.from("贵州茅台 600519。", "utf8")) });
  const macro = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  const tc = await addReport(root, { name: "腾讯点评.md", content: b64(Buffer.from("港股 HK:700 游戏。", "utf8")) });
  const tax = await addReport(root, { name: "贵州茅台深度报告消费税影响分析.md", content: b64(Buffer.from("消费税。", "utf8")) });
  const two = reportRecallPlan(root, "【当前页面：我的资料】\n- 贵州茅台600519深度.md｜标的 600519\n- 宏观月报.md｜标的 未识别\n\n【问题】\n比较这两份报告", rules);
  assert.deepEqual(new Set(two!.reportIds), new Set([mt.id, macro.id]), "带代码的和无代码的都在");
  const hk = reportRecallPlan(root, "【当前页面：个股数据】\n个股：腾讯控股（700.HK）\n\n【问题】\n研报里怎么说", rules);
  assert.deepEqual(planOf(hk), { reason: "explicit", reportIds: [tc.id] }, "页面上下文里的 700.HK 规范成 00700");
  assert.deepEqual(new Set(reportRecallPlan(root, "贵州茅台怎么看", rules)!.reportIds), new Set([mt.id, tax.id]), "中间嵌「深度报告」也能剥出「贵州茅台」");
  assert.equal(reportRecallPlan(root, "中国经济怎么样", rules), null, "不按普通词切段");
});

test("点了数量且页面正好那么多份时按页面来（Codex r10 P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const nd = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能。", "utf8")) });
  const a = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  const b = await addReport(root, { name: "半导体深度.md", content: b64(Buffer.from("先进封装。", "utf8")) });
  assert.equal(reportRecallPlan(root, "风险有哪些？", rules), null, "没有目标的句子不召回（不做跟进沿用）");
  const page = `【当前页面：我的资料】\n- ${nd.name}\n- ${a.name}\n- ${b.name}`;
  const three = reportRecallPlan(root, `${page}\n\n【问题】\n比较这三份报告的核心观点`, rules);
  assert.deepEqual(new Set(three!.reportIds), new Set([nd.id, a.id, b.id]), "点了三份、页面正好三份 → 就是它们");
  assert.deepEqual(planOf(reportRecallPlan(root, `${page}\n\n【问题】\n比较这两份报告`, rules)), { reason: "explicit" }, "数量对不上 → 仍按列表页全库");
  assert.equal(reportRecallPlan(root, `${page}\n\n【问题】\ncompare these three reports`, rules)?.reportIds?.length, 3);
});

test("三类目标取并集；键放查询最前（Codex r11 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const nd = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能。", "utf8")) });
  const macro = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  const mixed = reportRecallPlan(root, "比较宏观月报.md 与 300750 的结论", rules);
  assert.deepEqual(new Set(mixed!.reportIds), new Set([macro.id, nd.id]), "文件名 + 代码混用时两份都在");
  assert.equal(mixed!.reason, "symbol", "「比较宏观月报.md」紧贴着写不算点名，宏观月报经主体词「宏观」命中，代码分支优先");
  assert.ok(mixed!.query.startsWith("300750"), "键在查询最前");
  const longQ = "细节".repeat(300) + " 300750 还有哪些？";
  assert.ok(reportRecallPlan(root, longQ, rules)!.query.startsWith("300750"), "长问题也不会把键挤出检索窗口");
});

test("文件名嵌套只算最长；数量词门槛到十（Codex r12 P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const short = await addReport(root, { name: "报告.md", content: b64(Buffer.from("短。", "utf8")) });
  const annual = await addReport(root, { name: "年度报告.md", content: b64(Buffer.from("年度。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize 年度报告.md", rules)), { reason: "name", reportIds: [annual.id] }, "「年度报告.md」不连带「报告.md」");
  assert.deepEqual(planOf(reportRecallPlan(root, "解读一下 年度报告.md 的结论", rules)), { reason: "name", reportIds: [annual.id] }, "用空格 / 标点隔开的文件名才算点名");
  assert.equal(reportRecallPlan(root, "解读一下年度报告.md的结论", rules), null, "紧贴着写的不算点名（年度报告没有主体词，也不走标题路径）");
  const onlyShort = tmp();
  await addReport(onlyShort, { name: "报告.md", content: b64(Buffer.from("短。", "utf8")) });
  assert.equal(reportRecallPlan(onlyShort, "summarize 年度报告.md", rules), null, "库里没有「年度报告.md」时，不能把「报告.md」当成它送出去");
  assert.deepEqual(new Set(reportRecallPlan(root, "报告.md 和 年度报告.md 有什么区别", rules)!.reportIds), new Set([short.id, annual.id]), "各自独立出现时两份都算");
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize 报告.md", rules)), { reason: "name", reportIds: [short.id] });
  assert.equal(reportRecallPlan(root, "比较这六份报告", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "compare these four reports", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "看看这 8 份文件", rules)?.reason, "explicit");
});


test("含空格的长文件名不连带短文件名；列表页文件名进检索键；年报 / 财报明确指称触发（Codex r16 P1 ×2 / P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const notes = await addReport(root, { name: "notes.txt", content: b64(Buffer.from("plain notes.", "utf8")) });
  const meeting = await addReport(root, { name: "meeting notes.txt", content: b64(Buffer.from("meeting.", "utf8")) });
  const macro = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize meeting notes.txt", rules)), { reason: "name", reportIds: [meeting.id] }, "「 notes.txt」被更长的已知文件名覆盖，不算点名 notes.txt");
  assert.deepEqual(new Set(reportRecallPlan(root, "compare notes.txt with meeting notes.txt", rules)!.reportIds), new Set([notes.id, meeting.id]), "各自独立出现时两份都算");
  const listing = ["notes.txt", "meeting notes.txt", "宏观月报.md"].map((n) => `- ${n}`).join("\n");
  const many = reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n从我的资料里找核心观点`, rules);
  assert.deepEqual(planOf(many), { reason: "explicit" }, "≥3 个文件名不限定范围");
  assert.deepEqual(new Set(many!.keys), new Set(["notes.txt", "meeting notes.txt", "宏观月报.md"]), "但文件名进检索键，泛化问题也能打中");
  assert.ok(many!.query.startsWith("从我的资料里找核心观点") && many!.query.length > "从我的资料里找核心观点".length, "列表页时问题在前、文件名在后（问题不能被挤出检索窗口）");
  assert.equal(reportRecallPlan(root, "这份年报讲了什么", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "财报里怎么说", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "年报季到了", rules), null, "泛词仍不触发");
  assert.equal(reportRecallPlan(root, "这份年报讲了什么", {}), null, "没注入垂类规则时 Core 不认识这些词");
});

test("英文 attached / uploaded 复数指称算明确意图；明确选中六份时检索给六个位置（Codex r17 P2 ×2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const ids: string[] = [];
  for (let i = 1; i <= 6; i += 1) ids.push((await addReport(root, { name: `r${i}.txt`, content: b64(Buffer.from(`report ${i} body.`, "utf8")) })).id);
  assert.equal(reportRecallPlan(root, "Read the attached files about capex", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "Compare the uploaded reports", rules)?.reason, "explicit");
  const listing = Array.from({ length: 6 }, (_, i) => `- r${i + 1}.txt`).join("\n");
  const six = reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n比较这六份报告`, rules);
  assert.equal(six!.reportIds!.length, 6);
  const ctxFive = reportContext(root, six!.query, { limit: 5, reportIds: six!.reportIds });
  const ctxSix = reportContext(root, six!.query, { limit: Math.max(5, six!.reportIds!.length), reportIds: six!.reportIds });
  assert.equal(ctxFive!.hits.length, 5, "limit 5 会截掉一份");
  assert.equal(ctxSix!.hits.length, 6, "按选中份数给位置就全在");
});

test("列表页查询保留用户问题；明确选中多份时放宽字数、截断可见（Codex r18 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const ids: string[] = [];
  for (let i = 1; i <= 60; i += 1) ids.push((await addReport(root, { name: `研究资料第${i}号文件.txt`, content: b64(Buffer.from(`第 ${i} 份正文，${i === 37 ? "资本开支上行" : "无"}。` + "内容".repeat(300), "utf8")) })).id);
  const listing = Array.from({ length: 60 }, (_, i) => `- 研究资料第${i + 1}号文件.txt`).join("\n");
  const q = "从资料库里找提到资本开支的报告";
  const plan = reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n${q}`, rules);
  assert.equal(plan?.reason, "explicit");
  assert.ok(plan!.query.startsWith(q), "列表页时用户问题在最前，不会被 60 个文件名挤出检索窗口");
  assert.ok(plan!.query.length <= 500, "查询总长受控");
  const ctx = reportContext(root, plan!.query, { limit: 5 });
  assert.ok(ctx!.hits.some((h) => h.id === ids[36]), "正文里提到资本开支的那份能被检索到");
  const eight = ids.slice(0, 8);
  const tight = reportContext(root, plan!.query, { limit: 8, reportIds: eight, maxChars: 1_000 });
  assert.equal(tight!.truncated, true, "字数上限放不下时 truncated 为真");
  const roomy = reportContext(root, eight.map((_, i) => `研究资料第${i + 1}号文件.txt`).join(" "), { limit: 8, reportIds: eight, maxChars: Math.min(40_000, Math.max(12_000, 8 * 4_000)) });
  assert.equal(roomy!.hits.length, 8, "按份数放宽后八份都在");
});

test("点名文件后，文件名自带的代码 / 公司名不再把兄弟文件并进来；检索 20 份硬上限可被识别（Codex r19 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const track = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能。", "utf8")) });
  const quarter = await addReport(root, { name: "宁德时代300750季报点评.md", content: b64(Buffer.from("宁德时代 300750 季度。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize 宁德时代300750跟踪.md", rules)), { reason: "name", reportIds: [track.id] }, "只点名一份就只有这一份");
  assert.deepEqual(new Set(reportRecallPlan(root, "宁德时代300750跟踪.md 和 300750 的其它报告", rules)!.reportIds), new Set([track.id, quarter.id]), "文件名以外又提了代码 → 并集");
  assert.deepEqual(new Set(reportRecallPlan(root, "300750 怎么看", rules)!.reportIds), new Set([track.id, quarter.id]), "没点名时代码照常命中全部");
  const many = tmp();
  const ids: string[] = [];
  for (let i = 1; i <= 25; i += 1) ids.push((await addReport(many, { name: `d${i}.txt`, content: b64(Buffer.from(`doc ${i}`, "utf8")) })).id);
  const ctx = reportContext(many, ids.map((_, i) => `d${i + 1}.txt`).join(" "), { limit: 25, reportIds: ids, maxChars: 40_000 });
  assert.equal(ctx!.hits.length, 20, "检索硬上限 20 份");
  assert.equal(ctx!.truncated, false, "字数没超时 truncated 为 false —— 所以服务层要按「注入份数 < 选中份数」另判不完整");
});

test("遮罩按空白灵活匹配；两字母大写主体保留；键优先时超长键仍保留（Codex r20 P1/P2 ×2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const cat24 = await addReport(root, { name: "CAT 2024 report.txt", content: b64(Buffer.from("cat 2024.", "utf8")) });
  await addReport(root, { name: "CAT analysis.txt", content: b64(Buffer.from("cat analysis.", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "summarize CAT  2024 report.txt", rules)), { reason: "name", reportIds: [cat24.id] }, "多打一个空格也只点名这一份，CAT 不再并入兄弟文件");
  const ai = await addReport(root, { name: "AI行业报告.md", content: b64(Buffer.from("算力。", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "AI 行业趋势", rules)), { reason: "title", reportIds: [ai.id] }, "两字母全大写主体保留");
  assert.equal(reportRecallPlan(root, "ai 行业趋势", rules), null, "小写 ai 不算");
  const longName = "研".repeat(230) + ".md";
  const longRep = await addReport(root, { name: longName, content: b64(Buffer.from("超长文件名。", "utf8")) });
  const longQ = "请解读这份报告" + "细".repeat(300);
  const plan = reportRecallPlan(root, `【当前页面：我的资料】\n- ${longName}\n\n【问题】\n${longQ}`, rules);
  assert.deepEqual(planOf(plan), { reason: "explicit", reportIds: [longRep.id] });
  assert.ok(plan!.query.startsWith("研".repeat(100)), "超长键截断后仍在查询最前");
  assert.ok(plan!.query.length <= 500 && plan!.query.includes("请解读这份报告"), "问题至少保留开头");
  assert.ok(reportContext(root, plan!.query, { limit: 5, reportIds: plan!.reportIds })!.hits.length === 1, "截断的键片段仍能命中该文件");
});

test("明确要资料时，页面上下文里的公司名 / 板块名也算页面主体（无代码资料不再漏，Codex r21 P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const zj = await addReport(root, { name: "中际旭创投资者交流.md", content: b64(Buffer.from("光模块需求。", "utf8")) });
  const ai = await addReport(root, { name: "AI算力行业深度.md", content: b64(Buffer.from("算力。", "utf8")) });
  const other = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750。", "utf8")) });
  assert.deepEqual(zj.symbols, [], "这份资料没有解析出代码");
  const stock = reportRecallPlan(root, "【当前页面：个股数据】\n个股：中际旭创（300308）\n近期公告：无\n\n【问题】\n研报里怎么说", rules);
  assert.deepEqual(planOf(stock), { reason: "explicit", reportIds: [zj.id] }, "公司名出现在页面上下文 → 召回它，且只召回它");
  const sector = reportRecallPlan(root, "【当前页面：板块】\n板块：AI算力\n\n【问题】\n研报里怎么说", rules);
  assert.deepEqual(planOf(sector), { reason: "explicit", reportIds: [ai.id] }, "板块名也算");
  assert.ok(!stock!.reportIds!.includes(other.id));
});

test("裸的资料 / 文档 / 报告不算意图；「这一份报告」算（Codex r22 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  await addReport(root, { name: "技术方案.md", content: b64(Buffer.from("文档目录结构说明。", "utf8")) });
  for (const q of ["如何给技术文档添加目录？", "报告里加一个表格", "资料整理的通用规范是什么", "the report format", "open the file"]) {
    assert.equal(reportRecallPlan(root, q, rules)?.reason === "explicit", false, `不该算明确意图: ${q}`);
  }
  for (const q of ["这一份报告讲了什么？", "那一个文件说了什么", "我的资料里有没有提到", "资料库里怎么说", "报告里怎么说", "这些报告的共同点", "所有报告都看过了吗", "上传的东西", "summarize this report", "compare the uploaded reports"]) {
    assert.equal(reportRecallPlan(root, q, rules)?.reason, "explicit", `应算明确意图: ${q}`);
  }
});

test("裸 PDF 不算意图；document/file 是停用词；所有报告标 wantsAll；4/9 开头代码可召回；长大写公司名不当 ticker（Codex r23）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const tax = await addReport(root, { name: "tax-document.pdf".replace(".pdf", ".txt"), content: b64(Buffer.from("tax notes.", "utf8")) });
  assert.equal(reportRecallPlan(root, "How do I format a document?", rules), null, "document 是通用名词，不是主体");
  assert.equal(reportRecallPlan(root, "tax planning tips", rules)?.reportIds?.[0], tax.id, "tax 仍是主体");
  const all = reportRecallPlan(root, "所有报告里找核心观点", rules);
  assert.equal(all?.reason, "explicit"); assert.equal(all?.wantsAll, true);
  assert.equal(reportRecallPlan(root, "compare all reports", rules)?.wantsAll, true);
  assert.equal(reportRecallPlan(root, "上传的资料里怎么说", rules)?.wantsAll, undefined);
  assert.equal(reportRecallPlan(root, "总结所有文件", rules)?.wantsAll, true, "中文「所有文件」也算");
  assert.equal(reportRecallPlan(root, "每份文档说了什么", rules)?.wantsAll, true);
  const bj = await addReport(root, { name: "北方公司430047跟踪.md", content: b64(Buffer.from("北方公司 430047。", "utf8")) });
  assert.ok(bj.symbols.includes("430047"), "4 开头的代码入库时被识别");
  assert.deepEqual(planOf(reportRecallPlan(root, "430047 怎么看", rules)), { reason: "symbol", reportIds: [bj.id] });
  const legacy = await addReport(root, { name: "旧索引资料.md", content: b64(Buffer.from("正文里提到 920001 这个代码。", "utf8")) });
  assert.ok(!legacy.symbols.includes("920001"), "正文里的裸代码没有语境不入库");
  const bare = reportRecallPlan(root, "920001 最近怎么样", rules);
  assert.equal(bare?.reason, "symbol"); assert.equal(bare?.reportIds, undefined); assert.equal(bare?.query, "920001", "没登记的代码只按代码本身打分");
  assert.equal(reportContext(root, bare!.query, { limit: 5 })!.hits[0]!.id, legacy.id, "正文里写了这个代码的资料能召回");
  const nv = await addReport(root, { name: "NVIDIA annual report.md", content: b64(Buffer.from("data center.", "utf8")) });
  assert.deepEqual(planOf(reportRecallPlan(root, "Nvidia outlook", rules)), { reason: "title", reportIds: [nv.id] }, "≥6 字母的全大写是公司名，不分大小写");
});

test("「所有报告」圈定全库并不按相关性过滤；库大于上限时可判不完整（Codex r24 P1）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const ids: string[] = [];
  for (let i = 1; i <= 8; i += 1) ids.push((await addReport(root, { name: `第${i}份.txt`, content: b64(Buffer.from(`内容${i}`, "utf8")) })).id);
  const plan = reportRecallPlan(root, "总结所有报告的核心观点", rules);
  assert.equal(plan?.wantsAll, true);
  assert.deepEqual(new Set(plan!.reportIds), new Set(ids), "全库都选中");
  const scored = reportContext(root, "核心观点", { limit: 8, reportIds: plan!.reportIds });
  assert.equal(scored, null, "按相关性打分：措辞和正文不沾边 → 一份都不进来");
  const all = reportContext(root, plan!.query, { limit: Math.max(5, plan!.reportIds!.length), reportIds: plan!.reportIds, mustInclude: true, maxChars: 40_000 });
  assert.equal(all!.hits.length, 8, "mustInclude：八份全部注入");
  const many = tmp();
  const mids: string[] = [];
  for (let i = 1; i <= 25; i += 1) mids.push((await addReport(many, { name: `m${i}.txt`, content: b64(Buffer.from(`x${i}`, "utf8")) })).id);
  const bigPlan = reportRecallPlan(many, "compare all reports", rules);
  const big = reportContext(many, bigPlan!.query, { limit: 25, reportIds: bigPlan!.reportIds, mustInclude: true, maxChars: 40_000 });
  assert.equal(big!.hits.length, 20, "检索硬上限 20");
  assert.ok(bigPlan!.reportIds!.length > big!.hits.length, "服务层据此（注入份数 < 选中份数）标不完整");
});

test("裸代码兜底只认合法号段；旧索引升级时重算代码；every report 算全库请求（Codex r25）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  await addReport(root, { name: "月度数据.md", content: b64(Buffer.from("202409 的成交额。", "utf8")) });
  assert.equal(reportRecallPlan(root, "202409 的数据怎么样", rules), null, "日期式六位数不是代码，不兜底召回");
  assert.equal(reportRecallPlan(root, "summarize every report", rules)?.wantsAll, true);
  // 模拟从 1.0.2 升级:schema_version 2 的索引里 43x 代码没识别出来
  const old = tmp();
  const rec = await addReport(old, { name: "北方公司430047跟踪.md", content: b64(Buffer.from("北方公司。", "utf8")) });
  const manifest = path.join(fs.realpathSync(old), "knowledge", "reports", "manifest.json");
  const idx = JSON.parse(fs.readFileSync(manifest, "utf8")) as { schema_version: number; reports: { id: string; symbols: string[] }[] };
  idx.schema_version = 2;
  idx.reports = idx.reports.map((r) => ({ ...r, symbols: [] }));
  fs.writeFileSync(manifest, JSON.stringify(idx, null, 2) + "\n");
  const after = listReports(old).find((r) => r.id === rec.id)!;
  assert.ok(after.symbols.includes("430047"), "读取旧索引时按当前规则重算出代码");
  assert.equal((JSON.parse(fs.readFileSync(manifest, "utf8")) as { schema_version: number }).schema_version, 3, "并以当前版本落盘");
  assert.deepEqual(planOf(reportRecallPlan(old, "430047 怎么看", rules)), { reason: "symbol", reportIds: [rec.id] });
});

test("垂类资料名词参与全库 / 数量判定；助词与冠词形式也认（Codex r26 P1/P2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const ids: string[] = [];
  for (let i = 1; i <= 6; i += 1) ids.push((await addReport(root, { name: `r${i}.txt`, content: b64(Buffer.from(`report ${i}`, "utf8")) })).id);
  assert.equal(reportRecallPlan(root, "总结所有研报", rules)?.wantsAll, true, "垂类名词参与全库判定");
  assert.equal(reportRecallPlan(root, "总结所有研报", {})?.wantsAll, undefined, "Core 不认识研报");
  const listing = ids.map((_, i) => `- r${i + 1}.txt`).join("\n");
  const six = reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n比较这六份研报`, rules);
  assert.equal(six!.reportIds!.length, 6, "垂类名词参与数量判定");
  for (const q of ["总结所有的报告", "查看全部的文件", "compare all the reports", "summarize all of the reports"]) {
    const plan = reportRecallPlan(root, q, rules);
    assert.equal(plan?.reason, "explicit", q); assert.equal(plan?.wantsAll, true, q);
  }
  assert.equal(reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\ncompare these six of the reports`, rules)!.reportIds!.length, 6);
});

test("裸「上传」不算；垂类名词参与意图；遮罩长名优先；建议文案可召回（Codex r27）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const ids: string[] = [];
  for (let i = 1; i <= 6; i += 1) ids.push((await addReport(root, { name: `f${i}.txt`, content: b64(Buffer.from(`f ${i} 上传`, "utf8")) })).id);
  assert.equal(reportRecallPlan(root, "怎么上传文件到服务器", rules), null, "裸「上传」不是在要资料库");
  assert.equal(reportRecallPlan(root, "已上传文件里怎么说", rules)?.reason, "explicit");
  assert.equal(reportRecallPlan(root, "我上传的报告怎么样", rules)?.reason, "explicit");
  const listing = ids.map((_, i) => `- f${i + 1}.txt`).join("\n");
  assert.equal(reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n比较这六份财报`, rules)!.reportIds!.length, 6, "垂类名词参与意图 + 数量判定");
  assert.equal(reportRecallPlan(root, "总结所有财报", rules)?.wantsAll, true);
  assert.equal(reportRecallPlan(root, "比较这六份财报", {}), null, "Core 不认识财报");
  assert.equal(reportRecallPlan(root, `【当前页面：我的资料】\n${listing}\n\n【问题】\n帮我给这些资料排个阅读顺序`, rules)?.reason, "explicit", "内置建议文案能触发召回");
  const m = tmp();
  const alpha = await addReport(m, { name: "alpha.txt", content: b64(Buffer.from("a", "utf8")) });
  const pa = await addReport(m, { name: "project alpha.txt", content: b64(Buffer.from("pa", "utf8")) });
  const po = await addReport(m, { name: "project outlook.txt", content: b64(Buffer.from("po", "utf8")) });
  const both = reportRecallPlan(m, "compare alpha.txt and project alpha.txt", rules);
  assert.deepEqual(new Set(both!.reportIds), new Set([alpha.id, pa.id]), "长名先遮，project outlook 不被并进来");
  assert.ok(!both!.reportIds!.includes(po.id));
});

test("页面列了文件名时只认文件名，不把没列出的同代码文件并进来；非整数索引版本判损坏（Codex r28 P2 ×2）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const oldOne = await addReport(root, { name: "贵州茅台600519旧版.md", content: b64(Buffer.from("贵州茅台 600519 旧。", "utf8")) });
  const newOne = await addReport(root, { name: "贵州茅台600519深度.md", content: b64(Buffer.from("贵州茅台 600519 新。", "utf8")) });
  const macro = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  const page = "【当前页面：我的资料】\n- 贵州茅台600519深度.md｜标的 600519\n- 宏观月报.md｜标的 未识别";
  const two = reportRecallPlan(root, `${page}\n\n【问题】\n比较这两份报告`, rules);
  assert.deepEqual(new Set(two!.reportIds), new Set([newOne.id, macro.id]), "没列出来的同代码旧文件不进来");
  assert.ok(!two!.reportIds!.includes(oldOne.id));
  const stock = reportRecallPlan(root, "【当前页面：个股数据】\n个股：贵州茅台（600519）\n\n【问题】\n研报里怎么说", rules);
  assert.deepEqual(new Set(stock!.reportIds), new Set([oldOne.id, newOne.id]), "没有文件名可认时代码兜底照常");
  const bad = tmp();
  await addReport(bad, { name: "x.md", content: b64(Buffer.from("x", "utf8")) });
  const manifest = path.join(fs.realpathSync(bad), "knowledge", "reports", "manifest.json");
  const idx = JSON.parse(fs.readFileSync(manifest, "utf8")) as { schema_version: number };
  idx.schema_version = 2.5;
  fs.writeFileSync(manifest, JSON.stringify(idx, null, 2) + "\n");
  assert.throws(() => listReports(bad), (e: unknown) => e instanceof ReportLibraryError && e.code === "report_index_corrupt");
});

test("「所有」带目标时只作用于该目标，不是整个库（Codex r29 P1）", async () => {
  const root = tmp();
  const rules = FINANCE_PLUGIN.reportRecall ?? {};
  const a = await addReport(root, { name: "宁德时代300750跟踪.md", content: b64(Buffer.from("宁德时代 300750 储能。", "utf8")) });
  const b = await addReport(root, { name: "宁德时代300750点评.md", content: b64(Buffer.from("宁德时代 300750 季度。", "utf8")) });
  const other = await addReport(root, { name: "宏观月报.md", content: b64(Buffer.from("流动性。", "utf8")) });
  const nv = await addReport(root, { name: "NVDA earnings.md", content: b64(Buffer.from("$NVDA data center.", "utf8")) });
  const scoped = reportRecallPlan(root, "总结 300750 的所有报告", rules);
  assert.deepEqual(new Set(scoped!.reportIds), new Set([a.id, b.id]), "只圈这个主体的资料");
  assert.equal(scoped!.wantsAll, true, "但这几份要全部注入");
  assert.ok(!scoped!.reportIds!.includes(other.id) && !scoped!.reportIds!.includes(nv.id));
  const en = reportRecallPlan(root, "all reports on NVDA", rules);
  assert.deepEqual(planOf(en), { reason: "symbol", reportIds: [nv.id] });
  const whole = reportRecallPlan(root, "总结所有报告", rules);
  assert.equal(whole!.reportIds!.length, 4, "没有目标时才是整个库");
});
