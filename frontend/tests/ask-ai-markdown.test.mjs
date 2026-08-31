import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

test("the existing markdown stack renders common AI response formatting", () => {
  const markdown = "## Risk\n\n- **High volatility**\n\n> Verify independently";
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown),
  );

  assert.match(html, /<h2>Risk<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>High volatility<\/strong>/);
  assert.match(html, /<blockquote>/);
});

test("Ask AI renders assistant messages with the markdown stack", async () => {
  const md = await readFile(new URL("../src/components/ui/Md.tsx", import.meta.url), "utf8");
  assert.match(md, /import\("react-markdown"\)/);
  assert.match(md, /import\("remark-gfm"\)/);
  const source = await readFile(
    new URL("../src/components/ui/AskAiButton.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /import \{ Md \} from "@\/components\/ui\/Md"/);
  assert.doesNotMatch(source, /from "react-markdown"/);
  assert.doesNotMatch(source, /from "remark-gfm"/);
  assert.match(
    source,
    /m\.role === "assistant"\s*\?\s*\(\s*<div className="prose[^"]*">\s*<Md>\{m\.content\}<\/Md>\s*<\/div>/s,
  );
});
