// The generator must build a script-free SVG that tells the plugin's real rule and carries no machine paths.
// Run: node --test errand/flow-animation/build.test.mjs (needs python3)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const out = path.join(mkdtempSync(path.join(tmpdir(), 'errand-flow-')), 'flow.svg');
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
test('the models are ovals, the agents rectangles, and the pulses square and eased', () => {
  assert.equal((svg.match(/class="oval/g) || []).length, 2);
  assert.match(svg, /class="sq /); assert.doesNotMatch(svg, /<circle/);
  assert.match(svg, /keySplines="0.45 0 0.55 1;/);
});
test('pulses stay hidden until they begin', () => {
  const hidden = (svg.match(/<g visibility="hidden"><set attributeName="visibility" to="visible" begin="[\d.]+s" fill="freeze"\/>/g) || []).length;
  assert.ok(hidden >= 20, `only ${hidden} hidden pulses`);
  assert.equal(hidden, (svg.match(/visibility="hidden"/g) || []).length);
});
test('no machine path or home directory leaks into the SVG', () => { assert.doesNotMatch(svg, /\/Users\/|\/Volumes\/|\.claude|\/home\//); });
test('it is well-formed XML', () => {
  const x = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
});
test('the figures it shows match the plugin code', () => {
  const hook = readFileSync(path.join(ROOT, 'plugins/ech-errand/hooks/errand-router.mjs'), 'utf8');
  const agent = readFileSync(path.join(ROOT, 'plugins/ech-errand/agents/code-explorer.md'), 'utf8');
  assert.match(hook, /ERRAND_ROUTER_MIN_STREAK\) \|\| 3;/); assert.match(svg, /3rd\+ nudged/);
  assert.match(hook, /ERRAND_ROUTER_BLOCK_STREAK\) \|\| 5;/); assert.match(svg, /5th\+ denied/);
  assert.match(hook, /ERRAND_ROUTER_VERIFY_WINDOW\) \|\| 8;/); assert.match(svg, /next 8 not nudged/);
  assert.match(hook, /ERRAND_ROUTER_MIN_CONF\) \|\| 0\.8;/); assert.match(svg, /confidence 0\.80 or more/);
  const hooks = JSON.parse(readFileSync(path.join(ROOT, 'plugins/ech-errand/hooks/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Bash|Read'); assert.match(svg, /hook on Bash\|Read/);
  assert.match(agent, /^model: haiku$/m); assert.match(svg, />Haiku</);
});
