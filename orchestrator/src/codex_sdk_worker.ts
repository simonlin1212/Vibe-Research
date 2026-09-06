/** One official SDK turn in a parent-owned process group. No SDK fork, no
 * credentials on disk/argv. The parent kills the group and awaits stream close.
 */
import { once } from "node:events";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 8 * 1024 * 1024) throw new Error("SDK turn input too large");
    chunks.push(b);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    options: CodexOptions; threadOptions: ThreadOptions; threadId: string | null;
    prompt: string; outputSchema?: unknown;
  };
  if (typeof request.prompt !== "string" || !request.options || !request.threadOptions) throw new Error("Invalid SDK turn input");
  const codex = new Codex(request.options);
  const thread = request.threadId ? codex.resumeThread(request.threadId, request.threadOptions) : codex.startThread(request.threadOptions);
  const { events } = await thread.runStreamed(request.prompt, { outputSchema: request.outputSchema });
  for await (const event of events) {
    if (!process.stdout.write(`${JSON.stringify(event)}\n`)) await once(process.stdout, "drain");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
