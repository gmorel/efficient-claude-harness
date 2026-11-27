// The shared lib copies must match lib/shared byte for byte. A plugin cannot import from a sibling,
// so drift here means two plugins run different versions of the same file.
// Run: node --test tests/lib-sync.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compare, sync, SHARED } from '../scripts/sync-lib.mjs';

test('every shared copy in the repo matches its canonical file', () => {
  const bad = compare().filter(r => r.state !== 'ok');
  assert.deepEqual(bad, [], 'run: node scripts/sync-lib.mjs');
  assert.ok(compare().length >= 2, 'the manifest lists at least two copies');
});

test('the check detects drift and a missing copy, and sync repairs both', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sync-lib-'));
  mkdirSync(path.join(root, 'lib', 'shared'), { recursive: true });
  mkdirSync(path.join(root, 'a'), { recursive: true });
  writeFileSync(path.join(root, 'lib', 'shared', 'x.mjs'), 'one\n');
  writeFileSync(path.join(root, 'a', 'x.mjs'), 'two\n');
  const shared = { 'x.mjs': ['a/x.mjs', 'b/lib/x.mjs'] };
  assert.deepEqual(compare(root, shared).map(r => r.state), ['drift', 'missing']);
  sync(root, shared);
  assert.deepEqual(compare(root, shared).map(r => r.state), ['ok', 'ok']);
  assert.equal(readFileSync(path.join(root, 'b', 'lib', 'x.mjs'), 'utf8'), 'one\n');
});

test('every plugin that imports a shared file is in the manifest', () => {
  const importers = { 'jev-client.mjs': ['ech-coder', 'ech-errand'] };
  for (const [name, plugins] of Object.entries(importers)) {
    for (const p of plugins) assert.ok(SHARED[name].includes(`plugins/${p}/hooks/lib/${name}`), `${p} lacks ${name}`);
  }
});
