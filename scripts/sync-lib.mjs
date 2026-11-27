#!/usr/bin/env node
// Keeps the shared lib files identical in every plugin that carries a copy.
// A plugin must work installed alone, so it cannot import from a sibling: each one holds its own copy.
// The canonical file lives in lib/shared/. This script copies it out; --check only compares.
//
// Usage: node scripts/sync-lib.mjs [--check]
// Exit: 0 in sync (or synced), 1 --check found drift, 3 bad usage.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// canonical file (under lib/shared) -> the copies, relative to the repo root
export const SHARED = {
  'jev-client.mjs': [
    'plugins/ech-coder/hooks/lib/jev-client.mjs',
    'plugins/ech-errand/hooks/lib/jev-client.mjs',
  ],
};

// -> [{ source, target, state: 'ok' | 'missing' | 'drift' }]
export function compare(root = ROOT, shared = SHARED) {
  const out = [];
  for (const [name, targets] of Object.entries(shared)) {
    const source = path.join('lib', 'shared', name);
    const want = readFileSync(path.join(root, source));
    for (const target of targets) {
      const f = path.join(root, target);
      const state = !existsSync(f) ? 'missing' : readFileSync(f).equals(want) ? 'ok' : 'drift';
      out.push({ source, target, state });
    }
  }
  return out;
}

export function sync(root = ROOT, shared = SHARED) {
  for (const r of compare(root, shared)) {
    if (r.state === 'ok') continue;
    mkdirSync(path.dirname(path.join(root, r.target)), { recursive: true });
    writeFileSync(path.join(root, r.target), readFileSync(path.join(root, r.source)));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--check')) { process.stderr.write('usage: sync-lib.mjs [--check]\n'); process.exit(3); }
  if (!args.includes('--check')) sync();
  const bad = compare().filter(r => r.state !== 'ok');
  for (const r of compare()) console.log(`${r.state.padEnd(7)} ${r.target}  <-  ${r.source}`);
  if (bad.length) { console.error(`${bad.length} shared copy out of sync: run node scripts/sync-lib.mjs`); process.exit(1); }
}
