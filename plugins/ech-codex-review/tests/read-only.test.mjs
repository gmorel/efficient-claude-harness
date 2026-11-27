// ech-codex-review is read-only by design. These checks prove no file here can reach a Codex write mode,
// and that nothing launches a real Codex job: the scripts are only run on paths that exit before the launch.
// Run: node --test plugins/ech-codex-review/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shipped = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests') walk(f); } else if (/\.(md|mjs|json)$/.test(e.name)) shipped.push(f);
  }
})(ROOT);
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: mkdtempSync(path.join(tmpdir(), 'home-')), HARNESS_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'data-')) },
});

test('no shipped file can select a Codex write sandbox', () => {
  for (const f of shipped) assert.doesNotMatch(readFileSync(f, 'utf8'), /workspace-write|danger-full-access/, f);
});

test('every mention of --write or codex-rescue in a shipped file is a prohibition or a refusal', () => {
  for (const f of shipped) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!/--write|codex-rescue/.test(line)) continue;
      assert.match(line, /never|refus|Proactive ·|read-only|by construction|^- Pass `--write`, or use|^description: .*never --write/i, `${path.relative(ROOT, f)}: ${line.trim()}`);
    }
  }
});

test('astra.mjs refuses --write before it launches anything', () => {
  const r = run('astra.mjs', ['run', 'say hi', '--write']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /read-only/);
});

test('astra.mjs with no arguments prints usage and no --write option', () => {
  const r = run('astra.mjs', []);
  assert.match(r.stderr + r.stdout, /usage: astra\.mjs/);
  assert.doesNotMatch(r.stderr + r.stdout, /\[--write\]/);
});

test('openai-gpt-reviewer: --print-prompt is a dry run that shows the prompt and the skills block', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rev-'));
  const patch = path.join(dir, 'x.patch'); writeFileSync(patch, 'diff --git a/x b/x\n');
  const skill = path.join(dir, 'SKILL.md'); writeFileSync(skill, '# skill\n');
  const r = run('openai-gpt-reviewer.mjs', ['diff', patch, '--focus', 'check it', '--skill', skill, '--print-prompt']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Do NOT run git/);
  assert.match(r.stdout, new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(r.stdout, /--write/);
});

test('openai-gpt-reviewer: a diff without --focus exits 2, an unknown effort exits 2', () => {
  assert.equal(run('openai-gpt-reviewer.mjs', ['diff', '/nonexistent']).status, 2);
  assert.equal(run('openai-gpt-reviewer.mjs', ['diff', '/nonexistent', '--focus', 'x', '--effort', 'low']).status, 2);
});

test('the four agents and two skills exist with matching names and a model line', () => {
  for (const a of ['delegate-to-openai-astra', 'openai-gpt-diff-reviewer', 'openai-gpt-plan-reviewer', 'sol-reviewer']) {
    const t = readFileSync(path.join(ROOT, 'agents', `${a}.md`), 'utf8');
    assert.match(t, new RegExp(`^name: ${a}$`, 'm'));
    assert.match(t, /^model: haiku$/m);
    assert.match(t, /^tools: Bash, Read$/m);
  }
  for (const s of ['delegate-to-openai-astra', 'codex-first-pr-review']) {
    assert.match(readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'), new RegExp(`^name: ${s}$`, 'm'));
  }
});

test('no owner-specific words ship in the plugin', () => {
  // Owner-specific words are never listed in this public repository. To check yours, run with ECH_OWNER_WORDS=word1,word2.
  const extra = (process.env.ECH_OWNER_WORDS || '').split(',').filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(['composer-lane', '\\bech:[a-z]', ...extra].join('|'), 'i');
  for (const f of shipped) assert.doesNotMatch(readFileSync(f, 'utf8'), re, f);
});
