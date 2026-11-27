// The generator must build a script-free SVG of the real ech-codex-review flow, with no invented figures and no machine paths.
// Run: node --test codex-review/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', '..', 'plugins', 'ech-codex-review');
const out = path.join(mkdtempSync(path.join(tmpdir(), 'codex-flow-')), 'flow.svg');
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
  assert.doesNotMatch(svg, /<script|onload=|javascript:|@keyframes|animation:/);
  assert.match(svg, /<animateMotion /); assert.match(svg, /repeatCount="indefinite"/);
});
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude/); });
test('pulses are square, eased, and hidden until their own begin time', () => {
  const groups = svg.match(/<g style="opacity:[^"]*" visibility="hidden"><set [^>]*\/><animateMotion [^>]*>/g) || [];
  assert.ok(groups.length >= 20);
  for (const g of groups) {
    const set = g.match(/<set [^>]*begin="([^"]+)"/)[1], move = g.match(/<animateMotion [^>]*begin="([^"]+)"/)[1];
    assert.equal(set, move, g);
  }
  assert.match(svg, /class="sq dot brief"/); assert.match(svg, /class="sq dot patch"/);
  assert.match(svg, /keySplines="0.45 0 0.55 1" calcMode="spline"/);
});
test('every agent drawn is a real agent of the plugin, and the two models are ovals', () => {
  for (const a of ['sol-reviewer', 'openai-gpt-diff-reviewer', 'openai-gpt-plan-reviewer', 'delegate-to-openai-astra']) {
    assert.ok(existsSync(path.join(PLUGIN, 'agents', `${a}.md`)), a); assert.match(svg, new RegExp(`>${a}<`));
  }
  assert.ok(existsSync(path.join(PLUGIN, 'skills', 'codex-first-pr-review', 'SKILL.md'))); assert.match(svg, />codex-first-pr-review</);
  assert.equal((svg.match(/class="oval"/g) || []).length, 2);
});
test('it says read-only and ADVISORY, and shows no invented figures', () => {
  assert.match(svg, /READ-ONLY: no --write, no codex-rescue, no transfer/);
  assert.ok((svg.match(/>ADVISORY</g) || []).length >= 4);
  assert.doesNotMatch(svg, /saved \$|\bruns\b|\bevents\b|\d+ ?%/);
});
test('the SVG is well-formed XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys,xml.dom.minidom as m; m.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
