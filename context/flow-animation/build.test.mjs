// The generator must build a script-free animated SVG of the real ech-context flow and carry no machine paths.
// Run: node --test context/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'context-flow-')), 'flow.svg');
const r = spawnSync('python3', ['-I', path.join(HERE, 'build.py'), out], { encoding: 'utf8' });
const svg = r.status === 0 ? readFileSync(out, 'utf8') : '';

test('it builds an SVG and exits 0', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(svg.length > 10000);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
});
test('the usage message and exit 3 without an output path', () => {
  const u = spawnSync('python3', ['-I', path.join(HERE, 'build.py')], { encoding: 'utf8' });
  assert.equal(u.status, 3); assert.match(u.stderr, /usage/);
});
test('it is script-free and animated with SMIL only', () => {
  assert.doesNotMatch(svg, /<script|onload=|javascript:|@keyframes|animation:/);
  assert.match(svg, /<animateMotion /);
  assert.match(svg, /repeatCount="indefinite"/);
});
test('it shows the three real hook steps with the code defaults', () => {
  for (const s of ['UserPromptSubmit', 'PreCompact', 'SessionStart compact', '200k', '50k', '30 min', 'MUST SURVIVE', 'recovery line', 'SESSION_SIZE=off', 'COMPACT_GUARD=off']) assert.ok(svg.includes(s), s);
});
test('the two model steps are ovals, pulses are squares', () => {
  assert.equal((svg.match(/class="oval"/g) || []).length, 2);
  assert.doesNotMatch(svg, /<circle/);
});
test('pulses stay hidden until their begin time, and are eased', () => {
  const pulses = svg.match(/<g style="opacity:[^"]+" visibility="hidden"><animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;/g) || [];
  assert.ok(pulses.length >= 40, `found ${pulses.length}`);
  assert.match(svg, /keySplines="0 0 1 1;0.45 0 0.55 1;0 0 1 1"/);
});
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude/); });
test('it is valid XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
