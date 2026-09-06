import assert from "node:assert/strict";
import test from "node:test";
import { appendixIds, citationPlugin } from "../src/verticals/finance/lib/reportCitations.ts";

test("引用目标只来自当前附录首列，忽略正文、代码及输入引用", () => {
  const ids = appendixIds("提及 ev-prose\n| ev-real | ev-input |\n```\n| ev-code | fake |\n```\n| calc-real | ev-real |\n| evil<script> | x |");
  assert.deepEqual([...ids], ["ev-real", "calc-real"]);
  assert.equal(appendixIds("").size, 0);
});

test("引用插件不处理相近 id、代码和已有链接，也不改变原文", () => {
  const tree = { type: "root" as const, children: [{ type: "paragraph" as const, children: [
    { type: "text" as const, value: "[ev-a / calc-a] ev-a-other" },
    { type: "inlineCode" as const, value: "ev-a" },
    { type: "link" as const, url: "https://example.com", children: [{ type: "text" as const, value: "ev-a" }] },
  ] }] };
  citationPlugin(new Set(["ev-a", "calc-a"]), "unique-")()(tree);
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /#unique-ev-a/);
  assert.match(serialized, /#unique-calc-a/);
  assert.doesNotMatch(serialized, /#unique-ev-a-other/);
  assert.match(serialized, /"type":"inlineCode","value":"ev-a"/);
});
