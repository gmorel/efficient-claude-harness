// Unit checks for the card-guard Stop hook.
//
// The one that matters is the first: the hook is OFF unless CARD_GUARD says otherwise. A Stop hook
// that blocked by default would refuse the final reply of every person who installed this plugin,
// in every session, whatever output style they run.
// Every check gives the hook its own HARNESS_DATA_DIR, so no test writes to a real ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'ech', 'hooks', 'card-guard.mjs');

// Runs the hook with a minimal environment: the result must not depend on the caller's.
function run(message, env = {}, extra = {}) {
  const data = mkdtempSync(path.join(tmpdir(), 'card-guard-'));
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-test', last_assistant_message: message, ...extra }),
    env: { PATH: process.env.PATH, HARNESS_DATA_DIR: data, ...env },
  });
  const ledger = path.join(data, 'card-guard.jsonl');
  return {
    rc: r.status,
    blocked: r.stdout.trim() ? JSON.parse(r.stdout).reason : null,
    logged: existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse) : [],
    data,
  };
}

const GOOD = '> 🟢 **The tests pass.**\n> ▫️ 27 checks, 0 failures.';
const DECIDE = '> **👉 For you**\n> 🟡 To decide: ship it or wait. If you say nothing: I wait.';

test('off by default: no CARD_GUARD means no block and no ledger', () => {
  const r = run('this is plain prose, not a card at all');
  assert.equal(r.rc, 0);
  assert.equal(r.blocked, null);
  assert.deepEqual(r.logged, []);
});

test('block: prose outside a blockquote is refused', () => {
  const r = run('I fixed the bug.', { CARD_GUARD: 'block' });
  assert.equal(r.rc, 0);
  assert.match(r.blocked, /one blockquote/);
});

test('block: HTML is refused', () => {
  const r = run('> 🟢 **Done.**\n> ▫️ <details>more</details>', { CARD_GUARD: 'block' });
  assert.match(r.blocked, /no HTML/);
});

test('block: a `<T>` generic or an e-mail in a code span is not HTML', () => {
  const r = run('> 🟢 **Done.**\n> ▫️ The type is `Vec<T>` and the address is <me@example.com>.',
    { CARD_GUARD: 'block' });
  assert.equal(r.blocked, null);
});

test('a valid card passes in every mode', () => {
  for (const CARD_GUARD of ['block', 'strict', 'log']) {
    assert.equal(run(GOOD, { CARD_GUARD }).blocked, null, CARD_GUARD);
    assert.equal(run(DECIDE, { CARD_GUARD }).blocked, null, CARD_GUARD);
  }
});

test('block logs a soft fault instead of refusing it; strict refuses it', () => {
  const missing = '> **👉 For you**\n> 🟡 To decide: ship it or wait.';   // no default-answer phrase
  const b = run(missing, { CARD_GUARD: 'block' });
  assert.equal(b.blocked, null);
  assert.equal(b.logged.length, 1);
  assert.match(b.logged[0].logged.join(' '), /If you say nothing/);
  assert.match(run(missing, { CARD_GUARD: 'strict' }).blocked, /If you say nothing/);
});

test('strict: a paragraph with no marker, two bold verdicts, and a stray title are each named', () => {
  assert.match(run('> 🟢 **Done.**\n>\n> no marker here', { CARD_GUARD: 'strict' }).blocked, /marker/);
  assert.match(run('> 🟢 **Done.**\n> ▫️ **Also bold.**', { CARD_GUARD: 'strict' }).blocked, /one bold verdict/);
  assert.match(run('> **👉 For you**\n> 🟢 Done.', { CARD_GUARD: 'strict' }).blocked, /open with the bold verdict/);
  assert.match(run('> 🟡 To decide: a or b. If you say nothing: a.', { CARD_GUARD: 'strict' }).blocked, /For you/);
});

test('strict: a wrapped line and a fenced block need no marker of their own', () => {
  const card = '> 🟢 **Done.**\n> ▫️ The first line of the paragraph\n> carries the marker, this one does not.\n>\n> ▫️ Run it:\n> ```bash\n> node tests/lint.mjs\n> ```';
  assert.equal(run(card, { CARD_GUARD: 'strict' }).blocked, null);
});

test('the title and the default-answer phrase are configurable, for a card in another language', () => {
  const fr = '> **👉 Pour toi**\n> 🟡 À décider : a ou b. Sans réponse de ta part : a.';
  assert.match(run(fr, { CARD_GUARD: 'strict' }).blocked, /For you/);
  assert.equal(run(fr, {
    CARD_GUARD: 'strict',
    CARD_GUARD_TITLE: '> **👉 Pour toi**',
    CARD_GUARD_DEFAULT_PHRASE: 'Sans réponse de ta part',
  }).blocked, null);
});

test('stop_hook_active never blocks, so the guard cannot loop', () => {
  assert.equal(run('plain prose', { CARD_GUARD: 'strict' }, { stop_hook_active: true }).blocked, null);
});

test('an off file in the data directory switches the guard off', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'card-guard-off-'));
  writeFileSync(path.join(data, 'card-guard.off'), '');
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', input: JSON.stringify({ last_assistant_message: 'plain prose' }),
    env: { PATH: process.env.PATH, HARNESS_DATA_DIR: data, CARD_GUARD: 'strict' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('a Stop input with no last_assistant_message fails open, but leaves a trace', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'card-guard-proto-'));
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', input: JSON.stringify({ session_id: 's-test' }),
    env: { PATH: process.env.PATH, HARNESS_DATA_DIR: data, CARD_GUARD: 'strict' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.match(readFileSync(path.join(data, 'card-guard.jsonl'), 'utf8'), /guard is inactive/);
});

test('unparsable input and an empty message cost nothing', () => {
  for (const input of ['not json at all', JSON.stringify({ last_assistant_message: '   ' })]) {
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8', input,
      env: { PATH: process.env.PATH, HARNESS_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'cg-')), CARD_GUARD: 'strict' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  }
});
