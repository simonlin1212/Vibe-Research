import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ai-watch hangs AIHOT from the same event_rank key", () => {
  const page = readFileSync(join(root, "src/pages/AiWatch.tsx"), "utf8");
  const panel = readFileSync(join(root, "src/components/ai-watch/AihotPanel.tsx"), "utf8");
  const grid = readFileSync(join(root, "src/components/ai-watch/AiGrid.tsx"), "utf8");
  const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
  assert.match(page, /AihotPanel/);
  assert.match(page, /id: "aihot"/);
  assert.match(panel, /eventRanks\("aihot"\)/);
  assert.match(panel, /usePolling/);
  assert.match(panel, /180_000/);
  assert.match(panel, /主题/);
  assert.match(grid, /grid-rows-5/);
  assert.match(api, /part=\$\{encodeURIComponent\(part\)\}/);
  assert.doesNotMatch(panel, /openRouterUsage|aiInfra|useQuotes|quoteHub|telegraphHub/);
  assert.doesNotMatch(page, /event-sopilot|NewsNow|REBANG/);
});
