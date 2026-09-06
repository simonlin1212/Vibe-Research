import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readIngestFile, assertIngestReadComplete, prepareIngestReadAttempt, MissingIngestReadError, type IngestReadContext } from "../src/ingest_tools.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ingest-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = "资料甲".repeat(30000);
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  fs.writeFileSync(path.join(dir, "01_rows.txt"), text);
  fs.writeFileSync(path.join(dir, "02_shot.png"), bytes);
  const ctx: IngestReadContext = { dir, files: [
    { name: "01_rows.txt", kind: "text", sha256: crypto.createHash("sha256").update(text).digest("hex") },
    { name: "02_shot.png", kind: "image", mimeType: "image/png", sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
  ] };
  return { ctx, text, bytes };
}

test("仅开放选中的文件，文本分页必须连续读全，图片保留原始字节", (t) => {
  const { ctx, text, bytes } = fixture(t);
  for (const name of ["../01_rows.txt", "auth.json", "", "02_shot.png/../01_rows.txt"]) {
    assert.throws(() => readIngestFile(ctx, { name }));
  }
  assert.throws(() => readIngestFile(ctx, { name: "01_rows.txt", offset: -1 }));
  assert.throws(() => readIngestFile(ctx, { name: "01_rows.txt", offset: 500 }));
  assert.throws(() => assertIngestReadComplete(ctx));
  let offset = 0;
  let actual = "";
  while (offset < text.length) {
    const r = readIngestFile(ctx, { name: "01_rows.txt", offset });
    const chunk = JSON.parse((r.content[0] as { text: string }).text);
    actual += chunk.text;
    offset = chunk.end;
  }
  assert.equal(actual, text);
  assert.throws(() => assertIngestReadComplete(ctx), /02_shot/);
  const img = readIngestFile(ctx, { name: "02_shot.png" });
  assert.deepEqual(img.content[1], { type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
  assert.doesNotThrow(() => assertIngestReadComplete(ctx));
});

test("替换文件、符号链接、篡改读取凭据都不得升级为已完整读取", (t) => {
  const { ctx } = fixture(t);
  fs.writeFileSync(path.join(ctx.dir, "01_rows.txt"), "changed");
  assert.throws(() => readIngestFile(ctx, { name: "01_rows.txt" }), /changed|变更/);
  fs.unlinkSync(path.join(ctx.dir, "02_shot.png"));
  fs.symlinkSync("01_rows.txt", path.join(ctx.dir, "02_shot.png"));
  assert.throws(() => readIngestFile(ctx, { name: "02_shot.png" }));
});

for (const damage of ["sha256", "total", "end", "unknown_file"]) {
  test(`先验证全部回执，再判断缺读或重置：${damage}`, (t) => {
    const { ctx, bytes } = fixture(t);
    const f = ctx.files[1]!;
    const receipt = { sha256: f.sha256, total: bytes.length, end: bytes.length };
    if (damage === "sha256") receipt.sha256 = "0".repeat(64);
    if (damage === "total") receipt.total += 1;
    if (damage === "end") receipt.end += 1;
    const file = path.join(ctx.dir, ".read-receipts.json");
    const before = JSON.stringify({ [damage === "unknown_file" ? "unknown.png" : f.name]: receipt });
    fs.writeFileSync(file, before);
    for (const check of [assertIngestReadComplete, prepareIngestReadAttempt]) {
      assert.throws(() => check(ctx), e => e instanceof Error && !(e instanceof MissingIngestReadError));
      assert.equal(fs.readFileSync(file, "utf8"), before, "坏回执不能被清掉");
    }
  });
}

test("真实 stdio MCP 只公布一个只读工具并返回 image content", async (t) => {
  const { ctx, bytes } = fixture(t);
  const client = new Client({ name: "ingest-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/ingest_tools_mcp.ts", import.meta.url))],
    env: { VRA_INGEST_DIR: ctx.dir, VRA_INGEST_FILES: JSON.stringify(ctx.files) }, stderr: "pipe" });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name), ["read_ingest_file"]);
  const r = await client.callTool({ name: "read_ingest_file", arguments: { name: "02_shot.png" } });
  assert.deepEqual((r.content as unknown[])[1], { type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
  const bad = await client.callTool({ name: "read_ingest_file", arguments: { name: "../auth.json" } });
  assert.equal(bad.isError, true);
});
