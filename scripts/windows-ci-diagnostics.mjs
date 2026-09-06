// CI-only synthetic diagnostics. Never inspect credentials or run a real model CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executableInvocation } from '../orchestrator/src/local_agent_runtime.ts';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') process.exit(0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-ci-diagnostic-'));
const quote = s => s.replaceAll("'", "''");
const emit = (label, result) => console.log(JSON.stringify({ label, status: result.status,
  error: result.error?.code, stdout: result.stdout?.slice(0, 5000), stderr: result.stderr?.slice(0, 5000) }));
try {
  const script = path.join(dir, 'fake.cjs'), bin = path.join(dir, 'fake.ps1');
  fs.writeFileSync(script, "console.log(JSON.stringify({args:process.argv.slice(2)}));process.exit(7);\n");
  fs.writeFileSync(bin, `& '${quote(process.execPath)}' '${quote(script)}' @args\r\nexit $LASTEXITCODE\r\n`);
  for (const [label, env] of [['full', process.env], ['minimal', { PATH: '' }]]) {
    const launch = executableInvocation(bin, ['--help', 'two words'], env);
    emit(label, spawnSync(launch.file, launch.args, { env, encoding: 'utf8', timeout: 10000 }));
  }
  const source = fs.readFileSync(new URL('../orchestrator/src/fsutil.ts', import.meta.url), 'utf8');
  const acl = source.match(/const WINDOWS_PRIVATE_ACL = String.raw`([\s\S]*?)`;/)?.[1];
  if (!acl) throw Error('ACL diagnostic source not found');
  const file = path.join(dir, 'private.txt');
  fs.writeFileSync(file, 'synthetic');
  emit('acl-command', spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', acl], {
    env: { ...process.env, VRA_PRIVATE_FILE: file }, encoding: 'utf8', timeout: 10000,
  }));
  emit('acl-encoded', spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(acl, 'utf16le').toString('base64')], {
    env: { ...process.env, VRA_PRIVATE_FILE: file }, encoding: 'utf8', timeout: 10000,
  }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
