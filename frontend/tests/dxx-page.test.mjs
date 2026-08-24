import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("dxx page uses one board and does not open quote hub", () => {
  const page = readFileSync(join(root, "src/pages/DxxCockpit.tsx"), "utf8");
  const panels = readFileSync(join(root, "src/components/dxx/panels.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  assert.match(page, /api\.dxxBoard/);
  assert.match(page, /FengdanPanel/);
  assert.match(page, /DabanPanel/);
  assert.match(page, /ZtlivePanel/);
  assert.match(page, /QingxuPanel/);
  assert.match(page, /packDxxContext/);
  assert.match(api, /dxxBoard/);
  assert.match(api, /\/dxx\/board/);
  assert.match(panels, /上游字段, 不是本站评分/);
  assert.match(panels, /匹配次数/);
  assert.doesNotMatch(page, /useQuotes/);
  assert.doesNotMatch(page, /quoteHub/);
  assert.doesNotMatch(page, /ovlabMarket/);
  assert.doesNotMatch(page, /eventCalendar/);
});
