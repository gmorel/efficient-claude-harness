// Structure checks for ech-pre-postmortem: the agent and the command exist and say what they must.
// Run: node --test plugins/ech-pre-postmortem/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

test('the agent is named, is an Opus agent and can read, search and run', () => {
  const t = read('agents/pre-post-mortem.md');
  assert.match(t, /^name: pre-post-mortem$/m);
  assert.match(t, /^model: opus$/m);
  assert.match(t, /^tools: .*Bash/m);
  assert.match(t, /already failed|has already failed|already\b/i);
});

test('the command carries a description and the WATCH FOR THIS ONE closing', () => {
  const t = read('commands/pre-post-mortem.md');
  assert.match(t, /^description: /m);
  assert.match(t, /WATCH FOR THIS ONE/);
});

test('the manifest is named like the folder and starts at 0.1.0', () => {
  const m = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(m.name, 'ech-pre-postmortem');
  assert.equal(m.version, '0.1.0');
});

test('nothing refers to the old ech namespace or to owner paths', () => {
  for (const f of ['agents/pre-post-mortem.md', 'commands/pre-post-mortem.md']) {
    assert.doesNotMatch(read(f), /\bech:[a-z]|plugins\/ech\/|~\/\.claude/i, f);
  }
});
