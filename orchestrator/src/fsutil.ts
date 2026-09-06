/** 文件工具:原子写入(临时文件 → fsync → 替换)、sha256、JSON 读写、追加 JSONL。*/
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** O_NOFOLLOW 在 Windows 不受支持；Windows 路径由 safePath/lstat 的逐级链接检查保护。 */
export const NOFOLLOW_FLAG = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

const WINDOWS_PRIVATE_ACL = String.raw`
$ErrorActionPreference = "Stop"
$file = $env:VRA_PRIVATE_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $file
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleSpecific($existing)
}
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$acl.SetOwner($sid)
Set-Acl -LiteralPath $file -AclObject $acl
`;

const WINDOWS_CHECK_ACL = String.raw`
$ErrorActionPreference = "Stop"
$file = $env:VRA_PRIVATE_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $file
if (-not $acl.AreAccessRulesProtected) { exit 3 }
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -ne $sid) { exit 4 }
  }
}
exit 0
`;

function windowsAcl(script: string, file: string): { status: number | null; error?: Error } {
  const env: NodeJS.ProcessEnv = { ...process.env, VRA_PRIVATE_FILE: path.resolve(file) };
  // A parent PowerShell 7 process exports its module search path. Windows
  // PowerShell 5.1 cannot load those Security modules; use its own defaults.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return { status: result.status, error: result.error };
}

/** Windows 的 mode 0600 不会改变 NTFS DACL；敏感文件必须显式断开继承并只授权当前 SID。 */
export function restrictPrivateFile(file: string): void {
  if (process.platform !== "win32") { fs.chmodSync(file, 0o600); return; }
  const result = windowsAcl(WINDOWS_PRIVATE_ACL, file);
  if (result.error || result.status !== 0) throw new Error(`无法收紧 Windows 文件权限(${result.error?.message ?? `exit ${result.status}`})`);
}

export function privateFilePermissions(file: string): { secure: boolean; detail: string } {
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    return { secure: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
  }
  const result = windowsAcl(WINDOWS_CHECK_ACL, file);
  if (result.error) return { secure: false, detail: `Windows ACL 检查失败:${result.error.message}` };
  if (result.status === 0) return { secure: true, detail: "Windows ACL 已断开继承，仅当前用户 SID 可读写" };
  if (result.status === 3) return { secure: false, detail: "Windows ACL 仍在继承父目录权限" };
  if (result.status === 4) return { secure: false, detail: "Windows ACL 还授权了其他账户" };
  return { secure: false, detail: `Windows ACL 检查异常(exit ${result.status})` };
}

export function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function atomicWrite(p: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, obj: unknown): void {
  atomicWrite(p, JSON.stringify(obj, null, 2) + "\n");
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function readJsonIfExists<T = unknown>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}

export function appendJsonl(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
    .sort()
    .map((f) => path.join(dir, f));
}

export function nowIso(): string {
  // Asia/Shanghai ISO 字符串
  const d = new Date();
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  return sh.toISOString().replace("Z", "+08:00");
}

export function ensureDirs(root: string, subs: string[]): void {
  for (const s of subs) fs.mkdirSync(path.join(root, s), { recursive: true });
}
