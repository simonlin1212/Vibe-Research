import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("研究报告区区分未校验、缺失与资料不完整，不渲染未放行正文", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  try {
    const { ResearchReport } = await server.ssrLoadModule("/src/verticals/finance/components/ResearchReport.tsx");
    const render = (availability: string | undefined, report: string | null, run_status = "running") => renderToStaticMarkup(createElement(ResearchReport, {
      result: { run_id: "test", report, appendix: null, availability, run_status },
    }));
    for (const state of ["unvalidated", undefined]) {
      const html = render(state, "DRAFT_CANARY");
      assert.match(html, /尚未通过最终校验/); assert.doesNotMatch(html, /DRAFT_CANARY/);
    }
    assert.match(render("missing", null), /尚无报告文件/);
    assert.match(render("ready", "<script>正文</script>", "complete"), /&lt;script&gt;正文/);
    const partial = render("ready", "VALIDATED_REPORT", "incomplete");
    assert.match(partial, /VALIDATED_REPORT/); assert.match(partial, /资料不完整/);
    const withAppendix = (availability: string) => renderToStaticMarkup(createElement(ResearchReport, {
      result: { run_id: "test", availability, run_status: "complete",
        report: "## 研究结论\n\n**证据优先** [ev-test]\n\n![remote](https://example.com/tracker.png)\n\n[unsafe](javascript:alert(1))",
        appendix: "## 引用明细\n\n| 证据 | 资料期 |\n| --- | --- |\n| ev-test | 2026-06 |\n\nAPPENDIX_CANARY" },
    }));
    const ready = withAppendix("ready");
    assert.match(ready, /<h2>研究结论<\/h2>/);
    assert.match(ready, /<strong>证据优先<\/strong>/);
    assert.match(ready, /<table>/); assert.match(ready, /APPENDIX_CANARY/);
    assert.match(ready, /证据附录/);
    assert.doesNotMatch(ready, /<img|tracker\.png|href="javascript:/);
    assert.doesNotMatch(withAppendix("unvalidated"), /APPENDIX_CANARY|研究结论/);
    assert.match(ready, /href="#reference-[^"]+ev-test"/);
    assert.match(ready, /<tr id="reference-[^"]+ev-test" tabindex="-1">/);
    const citations = renderToStaticMarkup(createElement(ResearchReport, { result: {
      run_id: "second-run", availability: "ready", run_status: "complete",
      report: "同段 [ev-a / ev-b]，计算 (calc-a)。未收录 [ev-missing]。\n\n`ev-a`\n\n[原始链接](https://example.com/ev-a)",
      appendix: "| id | 来源 |\n| --- | --- |\n| ev-a | A |\n| ev-b | B |\n| calc-a | ev-a |",
    } }));
    for (const id of ["ev-a", "ev-b", "calc-a"]) {
      assert.match(citations, new RegExp(`href="#reference-[^"]+second-run-${id}"`));
      assert.equal((citations.match(new RegExp(` id="reference-[^"]+second-run-${id}"`, "g")) ?? []).length, 1);
    }
    assert.doesNotMatch(citations, /href="#[^"]+ev-missing"/);
    assert.match(citations, /<code>ev-a<\/code>/);
    assert.match(citations, /href="https:\/\/example.com\/ev-a"/);
    const footnote = render("ready", "正文[^1]\n\n[^1]: 来源说明", "complete");
    assert.match(footnote, /id="user-content-fnref-1"/);
    assert.match(footnote, /aria-describedby="footnote-label"/);
    assert.match(footnote, /aria-label="Back to reference 1"/);
    const invalid = renderToStaticMarkup(createElement(ResearchReport, { result: {
      run_id: "boundary", availability: "ready", run_status: "complete",
      report: "other-ev-a ev-a- _ev-a ev-a_more",
      appendix: "| id | 来源 |\n| --- | --- |\n| ev-a | A |",
    } }));
    assert.doesNotMatch(invalid.split("</article>")[0], /<a /);
    const page = fs.readFileSync(`${root}/src/verticals/finance/pages/Research.tsx`, "utf8");
    assert.match(page, /<ResearchReport result=\{report\} \/>/);
    assert.match(page, /report\.run_id === active\.run_id/);
  } finally { await server.close(); }
});
