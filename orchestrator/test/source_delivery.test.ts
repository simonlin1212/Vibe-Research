import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('source delivery retains browser and engine entrypoints without the native Mac client', () => {
  for (const file of ['scripts/setup', 'scripts/start', 'scripts/start.cmd', 'scripts/start.ps1',
    'orchestrator/src/startup.ts', 'orchestrator/src/api.ts', 'desktop/src/main.tsx', 'desktop/vite.config.ts']) {
    assert.ok(fs.existsSync(path.join(root, file)), `Missing source entrypoint: ${file}`);
  }
  for (const file of ['packaging/macos/Launcher.swift', 'packaging/macos/build.mjs',
    'orchestrator/src/packaged.ts', 'orchestrator/src/desktop_gateway.ts']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `Native client must be withdrawn: ${file}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'orchestrator/package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@openai/codex-sdk'], '0.153.4');
});

test('both readmes lead to source setup without an active native installer or build guide', () => {
  for (const file of ['README.md', 'README_en.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /scripts\/setup/);
    assert.match(text, /scripts\/start/);
    assert.doesNotMatch(text, /packaging\/macos\/|VibeResearch-[^\s`]+\.dmg|### (?:Mac 独立客户端|Standalone Mac client)/);
  }
});
