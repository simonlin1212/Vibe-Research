import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '2.2.7';

test('v2.2.7 source version is consistent across packages, locks, README badges and CHANGELOG', () => {
  for (const dir of ['desktop', 'orchestrator']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, dir, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, VERSION);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
  for (const file of ['README.md', 'README_en.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const badges = [...text.matchAll(/badge\/source-v(\d+\.\d+\.\d+)-/g)].map((m) => m[1]);
    assert.deepEqual(badges, [VERSION], `${file} 首屏源码版本徽标必须恰好一个且等于 ${VERSION}`);
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const firstRelease = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];
  assert.equal(firstRelease, VERSION, 'CHANGELOG 最上面的版本条目必须是当前版本');
});
