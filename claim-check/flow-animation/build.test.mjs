// The generator must build a script-free animated SVG of the real claim-check flow and carry no machine paths.
// Run: node --test claim-check/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'claim-flow-')), 'flow.svg');
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
  assert.doesNotMatch(svg, /<script|onload=|onclick=|javascript:/i);
  assert.match(svg, /<animateMotion /); assert.match(svg, /repeatCount="indefinite"/);
});
test('it shows the real flow: Stop and SubagentStop, the regex gate, Haiku, block once, fail open', () => {
  for (const s of ['Stop', 'SubagentStop', 'regex gate', 'Haiku', 'block once', 'fail open', 'stop_hook_active', 'last 30 tool calls', 'claim-sentinel']) {
    assert.ok(svg.includes(s), s);
  }
});
test('the model is the only oval and pulses are squares', () => {
  assert.equal((svg.match(/class="oval"/g) || []).length, 1);
  assert.doesNotMatch(svg, /<circle /);
});
test('every pulse stays hidden until its own begin time, and is eased', () => {
  const groups = svg.match(/<g style="opacity:[^"]+" visibility="hidden"><set [^>]*\/><animateMotion [^>]*>/g) || [];
  assert.ok(groups.length >= 40, `only ${groups.length} pulse heads`);
  assert.equal(groups.length, (svg.match(/visibility="hidden"/g) || []).length);
  for (const g of groups) {
    const set = g.match(/<set [^>]*begin="([\d.]+)s"/), mo = g.match(/<animateMotion [^>]*begin="([\d.]+)s"/);
    assert.ok(set && mo, g); assert.equal(set[1], mo[1]);
  }
  assert.match(svg, /keySplines="0.45 0 0.55 1" calcMode="spline"/);
});
test('no machine path, home directory or settings folder leaks into the SVG', () => {
  assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\/home\/|\.claude/);
});
test('it is well-formed XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
