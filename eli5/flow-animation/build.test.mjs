// The generator must build a script-free SVG of the real ELI5 flow, keep each pulse hidden until it begins, and carry no machine paths.
// Run: node --test eli5/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'eli5-flow-')), 'flow.svg');
const r = spawnSync('python3', ['-I', path.join(HERE, 'build.py'), out], { encoding: 'utf8' });
const svg = r.status === 0 ? readFileSync(out, 'utf8') : '';

test('it builds an SVG and exits 0', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(svg.length > 10000);
});
test('the usage message and exit 3 without an output path', () => {
  const u = spawnSync('python3', ['-I', path.join(HERE, 'build.py')], { encoding: 'utf8' });
  assert.equal(u.status, 3); assert.match(u.stderr, /usage/);
});
test('it is script-free and animated with SMIL only', () => {
  assert.doesNotMatch(svg, /<script|onload=|onclick=|javascript:|<foreignObject/i);
  assert.match(svg, /<animateMotion /); assert.match(svg, /repeatCount="indefinite"/);
});
test('it shows the real flow: style, Claude, the Stop hook, the switch, the ledger', () => {
  for (const s of ['output style ELI5', 'card-guard', 'Stop hook', 'CARD_GUARD', 'unset = off', 'card-guard.jsonl', 'write it again, once']) assert.ok(svg.includes(s), s);
  assert.equal((svg.match(/class="oval"/g) || []).length, 1);
});
test('no counters, no figures and no logos', () => {
  assert.doesNotMatch(svg, /saved|\$ \d|runs|events|<image/);
});
test('every pulse stays hidden until its own begin time, and is eased', () => {
  const groups = [...svg.matchAll(/visibility="hidden"><set attributeName="visibility" to="visible" begin="([\d.]+)s" fill="freeze"\/><animateMotion [^>]*begin="([\d.]+)s"/g)];
  assert.equal(groups.length, (svg.match(/<animateMotion /g) || []).length);
  assert.ok(groups.length >= 20);
  for (const [, show, move] of groups) assert.equal(show, move);
  assert.match(svg, /keySplines="0.45 0 0.55 1" calcMode="spline"/);
});
test('pulses are squares', () => { assert.doesNotMatch(svg, /<circle/); });
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude/); });
test('it is valid XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
