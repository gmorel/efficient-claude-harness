// The generator must build a script-free SVG that shows the plugin's real flow, keep pulses hidden until they begin, and carry no machine paths.
// Run: node --test pre-postmortem/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'ppm-flow-')), 'flow.svg');
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
test('it is script-free and animates with SMIL only', () => {
  assert.doesNotMatch(svg, /<script|onload=|onclick=|javascript:/i);
  assert.match(svg, /<animateMotion /); assert.match(svg, /repeatCount="indefinite"/);
});
test('it draws the real flow of the plugin, in order', () => {
  const steps = ['risky change', 'pre-post-mortem agent', 'pre-post-mortem command', 'it already failed', 'weeks out', 'months out', '3 ways it is incomplete', 'attack the analysis', 'WATCH FOR THIS ONE'];
  let at = svg.indexOf('</style>');
  for (const s of steps) { const i = svg.indexOf(s, at); assert.ok(i > at, `missing or out of order: ${s}`); at = i; }
});
test('one model oval, square pulses, no counters', () => {
  assert.equal((svg.match(/class="oval"/g) || []).length, 1);
  assert.match(svg, /class="sq dot/); assert.doesNotMatch(svg, /<circle/);
  assert.doesNotMatch(svg, /saved \$|\d+ runs|\d+ events/);
});
test('pulses stay hidden until they begin, and are eased', () => {
  const hidden = (svg.match(/visibility="hidden"/g) || []).length;
  assert.ok(hidden >= 40);
  assert.equal((svg.match(/<set attributeName="visibility" to="visible" begin="[\d.]+s"/g) || []).length, hidden);
  assert.match(svg, /keySplines="0.45 0 0.55 1" calcMode="spline"/);
});
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude|\/home\//); });
test('it is valid XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
test('the copy in docs/ matches a fresh build', () => {
  assert.equal(readFileSync(path.join(HERE, '..', '..', 'docs', 'pre-postmortem-flow.svg'), 'utf8'), svg);
});
