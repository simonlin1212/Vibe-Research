/** Sequential fetch worker transport. Await close (including stdio), not exit.
 * Abort/timeout/overflow terminate the process group; no shell interpolation.
 */
import { spawn, spawnSync } from "node:child_process";

export async function runResearchProcess(command: string, args: string[], opts: {
  cwd: string; env: Record<string, string>; timeout: number; signal?: AbortSignal; maxBuffer?: number;
  input?: string; onStdout?: (chunk: Buffer) => void;
}): Promise<{ status: number | null; stderr: string; error?: NodeJS.ErrnoException }> {
  opts.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: process.platform !== "win32",
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: NodeJS.ErrnoException | undefined;
    let cancelled = false;
    let stopped = false;
    const stop = (code: "ETIMEDOUT" | "ENOBUFS" | "ABORT_ERR" | "BAD_OUTPUT") => {
      if (stopped) return;
      stopped = true;
      cancelled = code === "ABORT_ERR";
      failure = Object.assign(new Error(code), { code });
      try {
        if (child.pid && process.platform === "win32") {
          const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error("无法确认进程树已退出");
        } else if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = Object.assign(new Error("运行进程树终止失败，不能确认已取消"), { code: "STOP_FAILED" });
          cancelled = false;
          child.kill("SIGKILL");
        }
      }
    };
    const onAbort = () => stop("ABORT_ERR");
    const timer = setTimeout(() => stop("ETIMEDOUT"), opts.timeout);
    const take = (chunk: Buffer, stderr = false) => {
      bytes += chunk.length;
      if (bytes > (opts.maxBuffer ?? 64 * 1024 * 1024)) { stop("ENOBUFS"); return; }
      if (stderr) errors.push(chunk);
      else if (!stopped && opts.onStdout) {
        try { opts.onStdout(chunk); }
        catch { stop("BAD_OUTPUT"); }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => take(chunk));
    child.stderr.on("data", (chunk: Buffer) => take(chunk, true));
    child.stdin.on("error", (e) => { if (!stopped) failure = e; });
    child.stdin.end(opts.input);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.on("error", (e) => { failure = e; });
    child.on("close", (status) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (failure?.code === "STOP_FAILED") { reject(failure); return; }
      if (cancelled) { reject(opts.signal?.reason ?? new Error("用户取消研究")); return; }
      resolve({ status, stderr: Buffer.concat(errors).toString("utf8"), error: failure });
    });
  });
}
