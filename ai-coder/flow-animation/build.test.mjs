// The generator must build a page, default to the Matrix look, keep the theoretical counters and carry no machine paths.
// Run: node --test ai-coder/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), 'flow-')), 'flow.html');
const r = spawnSync('python3', ['-I', path.join(HERE, 'build.py'), out], { encoding: 'utf8' });
const html = r.status === 0 ? readFileSync(out, 'utf8') : '';

test('it builds a page and exits 0', () => { assert.equal(r.status, 0, r.stderr); assert.ok(html.length > 10000); });
test('the usage message and exit 3 without an output path', () => {
  const u = spawnSync('python3', ['-I', path.join(HERE, 'build.py')], { encoding: 'utf8' });
  assert.equal(u.status, 3); assert.match(u.stderr, /usage/);
});
test('Matrix is the default look and Classic stays behind the button', () => {
  assert.match(html, /class="box mx"/); assert.match(html, /id="b-matrix" aria-pressed="true"/); assert.match(html, /id="b-classic"/);
});
test('every agent in the diagram has a saved counter and the legend says it is theoretical', () => {
  for (const k of ['coder', 'avg', 'high', 'expl', 'qa', 'review']) assert.match(html, new RegExp(`id="sv-${k}"`));
  assert.match(html, /Theoretical:/);
  assert.doesNotMatch(html, /· theory|· ex\./);
});
test('the four models are ovals and the agents are rectangles', () => { assert.equal((html.match(/class="oval"/g) || []).length, 4); });
test('pulses stay hidden until they begin, and are eased', () => {
  assert.ok((html.match(/visibility="hidden"/g) || []).length >= 20);
  assert.match(html, /keySplines="0.45 0 0.55 1" calcMode="spline"/);
});
test('no machine path or home directory leaks into the page', () => { assert.doesNotMatch(html, /\/Users\/|\/Volumes\/|\.claude/); });

test('--svg writes a script-free animated SVG with five odometer counters and a loop', () => {
  const svgOut = path.join(path.dirname(out), 'flow.svg');
  const s = spawnSync('python3', ['-I', path.join(HERE, 'build.py'), out, '--svg', svgOut], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const svg = readFileSync(svgOut, 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<script|onload=|javascript:/);
  assert.equal((svg.match(/clip-path="url\(#cl-/g) || []).length, 5);
  assert.match(svg, /repeatCount="indefinite"/);
  assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude/);
});
