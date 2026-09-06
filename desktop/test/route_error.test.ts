import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("根路由错误以中文可恢复页面呈现，不回显错误正文或伪称数据已保存", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom",
    ssr: { noExternal: ["react-router-dom", "react-router"], resolve: { conditions: ["module-sync", "node", "import", "development"] } } });
  try {
    const { RouteErrorPage } = await server.ssrLoadModule("/src/core/components/RouteErrorPage.tsx");
    const { createMemoryRouter, RouterProvider } = await server.ssrLoadModule("react-router-dom");
    for (const [error, title] of [
      [{ status: 404, statusText: "SENSITIVE_DETAIL", internal: true, data: "SENSITIVE_DETAIL" }, "没有找到这个页面"],
      [{ status: 500, statusText: "SENSITIVE_DETAIL", internal: true, data: "SENSITIVE_DETAIL" }, "这个页面暂时无法显示"],
      [new Error("SENSITIVE_DETAIL /private/example/config"), "这个页面暂时无法显示"],
      ["SENSITIVE_DETAIL", "这个页面暂时无法显示"],
    ] as const) {
      const router = createMemoryRouter([{ id: "root", path: "/", element: createElement("div", null, "normal"),
        errorElement: createElement(RouteErrorPage) }], { initialEntries: ["/"], hydrationData: { errors: { root: error } } });
      try {
        const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
        assert.match(html, new RegExp(title));
        assert.match(html, /role="alert"/);
        assert.match(html, /重新加载页面/);
        assert.match(html, /href="\/"[^>]*>返回首页/);
        assert.match(html, /尚未保存的输入可能丢失/);
        assert.match(html, /不会清空本机配置或已保存记录/);
        assert.doesNotMatch(html, /SENSITIVE_DETAIL|private\/example|已自动保存|Unexpected Application Error/);
      } finally { router.dispose(); }
    }
    assert.match(fs.readFileSync(`${root}/src/verticals/finance/router.tsx`, "utf8"), /element:\s*<Layout\s*\/>\s*,\s*errorElement:\s*<RouteErrorPage\s*\/>/);
  } finally { await server.close(); }
});
