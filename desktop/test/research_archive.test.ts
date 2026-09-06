import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("归档保留公司与代码并补充状态、真实时间，缺失值不猜", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  try {
    const { ResearchRunItem, ResearchFailureNotice } = await server.ssrLoadModule("/src/verticals/finance/components/ResearchRunItem.tsx");
    const render = (status: string | null, started_at: string | null) => renderToStaticMarkup(createElement(ResearchRunItem, {
      run: { run_id: "distinct-run", name: "中际旭创", symbol: "300308", status, started_at }, onOpen: () => {},
    }));
    const html = render("complete", "2026-09-06T09:00:00+08:00");
    for (const text of ["中际旭创", "300308", "完成", "开始", "2026-09-06T09:00:00+08:00", 'type="button"']) assert.ok(html.includes(text), text);
    assert.match(render("failed", null), /失败/);
    assert.match(render(null, "bad"), /状态未知/);
    assert.match(render(null, "bad"), /时间未记录/);
    assert.doesNotMatch(render("failed", null), /Invalid Date|1970/);
    const notice = renderToStaticMarkup(createElement(ResearchFailureNotice, { failure: {
      code: "quota", message: "模型额度耗尽", action: "等待恢复后重新发起", retryable: false,
    } }));
    assert.match(notice, /模型额度耗尽/); assert.match(notice, /已落盘资料保留/);
    assert.match(notice, /href="\/settings"/); assert.match(notice, /重新发起/);
  } finally { await server.close(); }
});
