import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('v1.2.0 source version is consistent across packages and locks', () => {
  for (const dir of ['desktop', 'orchestrator']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, dir, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, '1.2.0');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
});
