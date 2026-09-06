/** Uploaded-file reader: exact allowlist + content hashes, no arbitrary paths or network. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface IngestReadContext {
  dir: string;
  files: { name: string; kind: "text" | "image"; mimeType?: string; sha256: string }[];
}
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_CHARS = 32_000;
const RECEIPTS = ".read-receipts.json";
export const INGEST_READ_SHAPE = { name: z.string().min(1).max(200), offset: z.number().int().nonnegative().optional() };
const inputSchema = z.object(INGEST_READ_SHAPE).strict();
const contextSchema = z.object({ dir: z.string().min(1), files: z.array(z.object({
  name: z.string().min(1).max(200), kind: z.enum(["text", "image"]),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).min(1).max(10) }).strict();

function rootOf(ctx: IngestReadContext): string {
  contextSchema.parse(ctx);
  if (!path.isAbsolute(ctx.dir) || fs.lstatSync(ctx.dir).isSymbolicLink()) throw new Error("Invalid import root");
  for (const f of ctx.files) {
    if (f.name !== path.basename(f.name) || /[\\/]/.test(f.name) || f.name.startsWith(".") || (f.kind === "image" && !f.mimeType)) {
      throw new Error("Invalid uploaded filename");
    }
  }
  if (new Set(ctx.files.map((f) => f.name)).size !== ctx.files.length) throw new Error("Duplicate uploaded filename");
  return fs.realpathSync(ctx.dir);
}

function readRegular(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid import file");
    // Bounded descriptor read: a concurrent growth must not turn this into an unbounded read.
    const buf = Buffer.alloc(stat.size + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (!got) break;
      n += got;
    }
    if (n !== stat.size) throw new Error("Import file changed");
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

type Receipts = Record<string, { sha256: string; end: number; total: number }>;
function receiptsAt(root: string): Receipts {
  let raw: Buffer;
  try { raw = readRegular(path.join(root, RECEIPTS), 16_384); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  return z.record(z.string(), z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
    end: z.number().int().nonnegative().max(MAX_BYTES), total: z.number().int().nonnegative().max(MAX_BYTES),
  }).strict()).parse(JSON.parse(raw.toString("utf8")));
}

function bytesOf(root: string, f: IngestReadContext["files"][number]): Buffer {
  const buf = readRegular(path.join(root, f.name), MAX_BYTES);
  if (crypto.createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Error("Import file changed");
  return buf;
}

export class MissingIngestReadError extends Error {}

function validatedReceipts(root: string, ctx: IngestReadContext): { receipts: Receipts; totals: number[] } {
  const receipts = receiptsAt(root);
  const totals = ctx.files.map((f) => {
    const bytes = bytesOf(root, f);
    return f.kind === "text" ? bytes.toString("utf8").length : bytes.length;
  });
  for (const [name, r] of Object.entries(receipts)) {
    const i = ctx.files.findIndex((f) => f.name === name);
    if (i < 0 || r.sha256 !== ctx.files[i]!.sha256 || r.total !== totals[i] || r.end > r.total) {
      throw new Error("Invalid read receipt");
    }
  }
  return { receipts, totals };
}

function writeReceipts(root: string, receipts: Receipts): void {
  const tmp = path.join(root, `.receipt-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(receipts), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, path.join(root, RECEIPTS));
  } finally { try { fs.unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
}

/** Every fresh model invocation must receive/read every file in that invocation. */
export function prepareIngestReadAttempt(ctx: IngestReadContext): void {
  const root = rootOf(ctx);
  validatedReceipts(root, ctx); // Validate every original AND receipt before clearing anything.
  writeReceipts(root, {});
}

/** Receipt means bytes were returned by the tool, not that a model understood them. */
export function readIngestFile(ctx: IngestReadContext, args: unknown) {
  const { name, offset = 0 } = inputSchema.parse(args);
  const root = rootOf(ctx);
  const f = ctx.files.find((entry) => entry.name === name);
  if (!f) throw new Error("File is not in this upload");
  const buf = bytesOf(root, f);
  const text = f.kind === "text" ? buf.toString("utf8") : "";
  const total = f.kind === "text" ? text.length : buf.length;
  const receipts = receiptsAt(root);
  const old = receipts[name];
  if (old && (old.sha256 !== f.sha256 || old.total !== total || old.end > total)) throw new Error("Invalid read receipt");
  if (offset > (old?.end ?? 0) || offset > total || (f.kind === "image" && offset !== 0)) throw new Error("Read pages in order");
  const end = f.kind === "text" ? Math.min(total, offset + CHUNK_CHARS) : total;
  receipts[name] = { sha256: f.sha256, end: Math.max(old?.end ?? 0, end), total };
  writeReceipts(root, receipts);
  return { content: [
    { type: "text" as const, text: JSON.stringify({ name, start: offset, end, total,
      ...(f.kind === "text" ? { text: text.slice(offset, end), has_more: end < total } : {}) }) },
    ...(f.kind === "image" ? [{ type: "image" as const, data: buf.toString("base64"), mimeType: f.mimeType! }] : []),
  ] };
}

export function assertIngestReadComplete(ctx: IngestReadContext): void {
  const root = rootOf(ctx);
  const { receipts, totals } = validatedReceipts(root, ctx);
  for (const [i, f] of ctx.files.entries()) {
    const total = totals[i]!;
    const r = receipts[f.name];
    if (!r || r.end !== total) {
      throw new MissingIngestReadError(`资料尚未完整读取：${f.name}；请减少文件大小或分批重试`);
    }
  }
}
