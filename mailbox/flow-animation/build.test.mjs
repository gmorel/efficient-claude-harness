// The generator must build a script-free animated SVG of the real mailbox flow and carry no machine paths.
// Run: node --test mailbox/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'mailbox-flow-')), 'flow.svg');
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
  assert.doesNotMatch(svg, /<script|onload=|javascript:|<foreignObject/i);
  assert.match(svg, /<animateMotion/); assert.match(svg, /repeatCount="indefinite"/);
});
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude/); });
test('pulses are squares, stay hidden until they begin, and are eased', () => {
  const hidden = (svg.match(/visibility="hidden"><set attributeName="visibility" to="visible" begin="[\d.]+s"/g) || []).length;
  assert.ok(hidden >= 20, `only ${hidden} hidden pulses`);
  assert.equal((svg.match(/<g style="opacity:[\d.]+" visibility="hidden">/g) || []).length, hidden);
  assert.doesNotMatch(svg, /<circle/);
  assert.match(svg, /keySplines="0.45 0 0.55 1/);
});
test('it shows the real flow: BLOCKING passes, held, next prompt, hourly digest, /mailbox, flush, clear, off by default', () => {
  for (const s of ['BLOCKING: passes at once', '>held<', 'your prompt, held messages as context', 'hourly digest', '/mailbox', '>flush<', 'clear: dropped', 'Off by default']) {
    assert.ok(svg.includes(s), `missing: ${s}`);
  }
});
test('the model is the one oval and the sessions and hooks are rectangles', () => {
  assert.equal((svg.match(/class="oval"/g) || []).length, 1);
  assert.equal((svg.match(/class="node"/g) || []).length, 7);
});
test('the SVG is valid XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
