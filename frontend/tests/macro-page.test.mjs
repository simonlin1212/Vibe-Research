import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("macro page hangs CTFI, not quote hub", () => {
  const header = readFileSync(join(root, "src/components/cockpit/CockpitHeader.tsx"), "utf8");
  const nav = header.slice(header.indexOf("export const PAGE_NAV"), header.indexOf("export function parseAShareTab"));
  const usIdx = nav.indexOf('to: "/us-market"');
  const macroIdx = nav.indexOf('to: "/macro"');
  const researchIdx = nav.indexOf('to: "/research"');
  assert.ok(usIdx >= 0 && macroIdx > usIdx && researchIdx > macroIdx, "宏观在美股后、研究前");
  const page = readFileSync(join(root, "src/pages/MacroCockpit.tsx"), "utf8");
  const goods = readFileSync(join(root, "src/components/cockpit/CommodityPanel.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  assert.match(page, /api\.ctfi/);
  assert.match(page, /api\.ctfiImg/);
  assert.match(page, /880 \/ 278/);
  assert.match(page, /object-contain/);
  assert.match(page, /packMacroContext/);
  assert.match(page, /进口原油运价 CTFI/);
  assert.match(api, /\/market\/ctfi/);
  assert.match(api, /\/market\/ctfi-img/);
  assert.doesNotMatch(page, /useQuotes/);
  assert.doesNotMatch(page, /quoteHub/);
  assert.doesNotMatch(page, /ovlabMarket/);
  assert.doesNotMatch(goods, /api\.ctfi/);
});
