/** Detached research cancellation: durable request/ack, never trust a stored PID.
 * Control lives outside the agent's run workspace. A run id is reserved once;
 * retries use a new id, so a late cancel cannot affect a replacement worker.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NOFOLLOW_FLAG, writeJson } from "./fsutil.ts";

export class ResearchControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface ResearchControl {
  token: string;
  state: "starting" | "running" | "complete" | "incomplete" | "stale" | "failed" | "cancelled";
  finished_at: string | null;
}
export function isResearchCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true && error === signal.reason && !(error instanceof ResearchControlError);
}
const states = new Set(["starting", "running", "complete", "incomplete", "stale", "failed", "cancelled"]);
function controlPath(dataRoot: string, runId: string, file?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new ResearchControlError("bad_run_id", "非法研究编号");
  let current = path.resolve(dataRoot);
  for (const segment of ["research-control", runId, ...(file ? [file] : [])]) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new ResearchControlError("path_symlink", "研究控制路径包含链接");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return current;
}
export function readResearchControl(dataRoot: string, runId: string): ResearchControl | null {
  const file = controlPath(dataRoot, runId, "owner.json");
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG | fs.constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 4096) throw new Error("shape");
    const v = JSON.parse(fs.readFileSync(fd, "utf8")) as ResearchControl;
    if (!v || !/^[a-f0-9-]{36}$/.test(v.token) || !states.has(v.state) ||
        !(v.finished_at === null || typeof v.finished_at === "string")) throw new Error("shape");
    return v;
  } catch { throw new ResearchControlError("control_invalid", "研究控制记录损坏，未执行取消"); }
  finally { fs.closeSync(fd); }
}
export function reserveResearch(dataRoot: string, runId: string): ResearchControl {
  const dir = controlPath(dataRoot, runId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(controlPath(dataRoot, runId), { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ResearchControlError("run_exists", "研究编号已使用，请创建新的研究");
    throw e;
  }
  const record: ResearchControl = { token: randomUUID(), state: "starting", finished_at: null };
  writeJson(controlPath(dataRoot, runId, "owner.json"), record);
  return record;
}
export function updateResearchControl(dataRoot: string, runId: string, token: string, state: ResearchControl["state"]): void {
  const record = readResearchControl(dataRoot, runId);
  if (!record || record.token !== token) throw new ResearchControlError("control_mismatch", "研究运行身份不匹配");
  if (record.finished_at) return;
  writeJson(controlPath(dataRoot, runId, "owner.json"), { ...record, state,
    finished_at: state === "running" || state === "starting" ? null : new Date().toISOString() });
}
export function researchDecision(dataRoot: string, runId: string): "cancel" | "finalize" | null {
  const file = controlPath(dataRoot, runId, "decision");
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG | fs.constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 8) throw new ResearchControlError("control_invalid", "研究收尾决定损坏");
    const value = fs.readFileSync(fd, "utf8");
    if (value !== "cancel" && value !== "finalize") throw new ResearchControlError("control_invalid", "研究收尾决定损坏");
    return value;
  } finally { fs.closeSync(fd); }
}
/** Publish a fully written decision atomically, without replacing the winner.
 * Cancellation and archival compete for this single slot across processes.
 */
function decide(dataRoot: string, runId: string, value: "cancel" | "finalize") {
  const temporary = controlPath(dataRoot, runId, `decision-${randomUUID()}`);
  fs.writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  try {
    try { fs.linkSync(temporary, controlPath(dataRoot, runId, "decision")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return researchDecision(dataRoot, runId);
  } finally { fs.unlinkSync(temporary); }
}
export function researchCancellationRequested(dataRoot: string, runId: string): boolean {
  return researchDecision(dataRoot, runId) === "cancel";
}
export function requestResearchCancellation(dataRoot: string, runId: string): ResearchControl {
  const record = readResearchControl(dataRoot, runId);
  if (!record) throw new ResearchControlError("cancel_unavailable", "此研究未由当前版本启动，无法安全取消");
  if (!record.finished_at) {
    decide(dataRoot, runId, "cancel");
  }
  return record;
}
export function watchResearchCancellation(dataRoot: string, runId: string, token: string) {
  const record = readResearchControl(dataRoot, runId);
  if (!record || record.token !== token || record.finished_at) throw new ResearchControlError("control_mismatch", "研究运行身份不匹配");
  const controller = new AbortController();
  const check = () => {
    try {
      if (researchCancellationRequested(dataRoot, runId)) controller.abort(new Error("用户取消研究"));
    } catch (e) { controller.abort(e); }
  };
  updateResearchControl(dataRoot, runId, token, "running");
  check();
  const timer = setInterval(check, 200);
  timer.unref();
  const checkpoint = () => { check(); controller.signal.throwIfAborted(); };
  const finalize = () => {
    checkpoint();
    decide(dataRoot, runId, "finalize");
    checkpoint();
  };
  return { signal: controller.signal, close: () => clearInterval(timer), check, checkpoint, finalize };
}
