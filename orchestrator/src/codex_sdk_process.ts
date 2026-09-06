import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { runResearchProcess } from "./research_process.ts";

export async function runCodexSdkTurn(request: {
  options: CodexOptions; threadOptions: ThreadOptions; threadId: string | null;
  prompt: string; outputSchema?: unknown;
}, signal: AbortSignal, timeout: number, record: (event: ThreadEvent) => void): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const consume = (text: string) => {
    pending += text;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.trim()) record(JSON.parse(line) as ThreadEvent);
    }
  };
  const result = await runResearchProcess(process.execPath, [fileURLToPath(new URL("./codex_sdk_worker.ts", import.meta.url))], {
    cwd: request.threadOptions.workingDirectory!, env: request.options.env ?? {}, signal, timeout,
    input: JSON.stringify(request), onStdout: (b) => consume(decoder.write(b)),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex SDK worker exited ${result.status}: ${result.stderr.slice(-2000)}`);
  consume(decoder.end());
  if (pending.trim()) throw new Error("Codex SDK worker returned an incomplete event");
}
