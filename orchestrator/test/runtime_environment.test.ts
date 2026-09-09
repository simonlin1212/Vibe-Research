import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fetchEnv, codexEnv } from "../src/config.ts";
import { researchEnv, startResearch, type ServiceContext } from "../src/service.ts";
import "../src/finance/register.ts";

test("explicit controlled MCP policy survives the real child launch, including space-containing paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-packaged-mode-"));
  try {
    for (const name of ["Applications", "Disk Image"]) {
      const repoRoot = path.join(dir, name);
      fs.mkdirSync(path.join(repoRoot, "orchestrator/src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "orchestrator/src/run.ts"), "console.log(JSON.stringify(process.argv.slice(2)))");
      const ctx = { repoRoot, dataRoot: path.join(repoRoot, "data"), python: "python3", node: process.execPath,
        providerEnvKey: null, researchExecutionMode: "controlled_mcp" } as ServiceContext;
      const result = startResearch(ctx, { symbol: "300308", market: "SZ", executionMode: "agent", run_id: "mode-check" });
      const log = path.join(ctx.dataRoot, result.log);
      let output = "";
      for (let i = 0; i < 100; i++) {
        output = fs.readFileSync(log, "utf8").trim();
        if (output) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const argv: string[] = JSON.parse(output);
      assert.equal(argv[argv.indexOf("--execution-mode") + 1], "controlled_mcp");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("no-bytecode policy survives fetch, research and Codex environment isolation", () => {
  const source = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", UNRELATED_SECRET: "do-not-forward" };
  const envs = [fetchEnv({}, source), codexEnv({}, source), researchEnv({ providerEnvKey: null }, source)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bytecode-"));
  try {
    fs.writeFileSync(path.join(dir, "probe.py"), "value = 1\n");
    const python = process.env.VRA_PYTHON || "python3";
    for (const env of envs) {
      assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
      assert.equal(env.UNRELATED_SECRET, undefined);
      execFileSync(python, ["-c", "import probe; assert probe.value == 1"], { cwd: dir, env });
      assert.equal(fs.existsSync(path.join(dir, "__pycache__")), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
