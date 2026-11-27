// node --test plugins/ech-context/tests/session-size.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastContext, decide, promptKind, needsWithdraw, WITHDRAW } from '../hooks/session-size.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-size.mjs');

const usage = (ctx, extra = {}) => JSON.stringify({
  type: 'assistant', isSidechain: false, ...extra,
  message: { role: 'assistant', usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1002, output_tokens: 50 } },
});
const user = text => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const synthetic = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
const compact = post => JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false, compactMetadata: { preTokens: 666641, postTokens: post } });

function fixture(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-size-'));
  const f = path.join(dir, 't.jsonl');
  writeFileSync(f, lines.join('\n') + '\n');
  return { dir, f };
}

function run(inp, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-size-run-'));
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(inp),
    env: { ...process.env, SESSION_SIZE: '', SESSION_SIZE_LEDGER: path.join(dir, 'l.jsonl'), SESSION_SIZE_STATE_DIR: path.join(dir, 'state'), HARNESS_DATA_DIR: dir, ...env },
    encoding: 'utf8',
  });
  const ledger = existsSync(path.join(dir, 'l.jsonl')) ? readFileSync(path.join(dir, 'l.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { code: r.status, out: r.stdout, ledger, dir };
}

test('reads the last main usage, skipping sidechain, synthetic and user lines', () => {
  const { f } = fixture([usage(150000), usage(260000), usage(999999, { isSidechain: true }), synthetic, user('hi "usage" in text')]);
  assert.deepEqual(lastContext(f), { context: 260000, source: 'usage' });
});

test('a compact boundary after the last usage wins', () => {
  const { f } = fixture([usage(640000), compact(21000), user('go on')]);
  assert.deepEqual(lastContext(f), { context: 21000, source: 'compact' });
});

test('finds usage behind a line bigger than one read chunk', () => {
  const big = user('x'.repeat(3 * 1024 * 1024));
  const { f } = fixture([usage(230000), big, big]);
  assert.equal(lastContext(f).context, 230000);
});

test('a one-line file with no trailing newline is read', () => {
  const { dir } = fixture([]);
  const f = path.join(dir, 'one.jsonl');
  writeFileSync(f, usage(205000));
  assert.equal(lastContext(f).context, 205000);
});

test('missing file or no usage returns null', () => {
  assert.equal(lastContext('/nonexistent/x.jsonl'), null);
  assert.equal(lastContext(fixture([user('a'), user('b')]).f), null);
});

test('decide: silent below, fires above, once per 50k, re-arms after compaction', () => {
  assert.equal(decide(140000, {}).fire, false);
  let d = decide(210000, {}); assert.equal(d.fire, true); assert.equal(d.firedAt, 210000);
  assert.equal(decide(250000, { firedAt: 210000 }).fire, false);
  d = decide(260000, { firedAt: 210000 }); assert.equal(d.fire, true); assert.equal(d.firedAt, 260000);
  d = decide(100000, { firedAt: 260000 }); assert.equal(d.fire, false); assert.equal(d.firedAt, null);
  assert.equal(decide(205000, { firedAt: null }).fire, true);
});

test('end to end: fires above the limit with additionalContext and a ledger line', () => {
  const { f } = fixture([usage(240000), user('next')]);
  const r = run({ session_id: 's1', transcript_path: f, cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  assert.equal(r.code, 0);
  const o = JSON.parse(r.out);
  assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(o.hookSpecificOutput.additionalContext, /240k tokens/);
  assert.match(o.hookSpecificOutput.additionalContext, /information only/);
  assert.match(o.hookSpecificOutput.additionalContext, /Do not refuse, shrink, postpone or redirect/);
  assert.doesNotMatch(o.hookSpecificOutput.additionalContext, /slash command|update-2nd-brain/);
  assert.match(o.systemMessage, /240k tokens.*fresh session/);
  assert.equal(r.ledger.length, 1);
  assert.equal(r.ledger[0].fired, true);
  assert.equal(r.ledger[0].context, 240000);
});

test('end to end: once per 50k growth on the same session', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-size-shared-'));
  const env = { SESSION_SIZE_LEDGER: path.join(dir, 'l.jsonl'), SESSION_SIZE_STATE_DIR: path.join(dir, 'st') };
  const at = ctx => run({ session_id: 's2', transcript_path: fixture([usage(ctx)]).f }, env).out;
  assert.notEqual(at(220000), '');
  assert.equal(at(240000), '');
  assert.equal(at(265000), '');
  assert.notEqual(at(271000), '');
  const lines = readFileSync(env.SESSION_SIZE_LEDGER, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.fired), [true, false, false, true]);
});

test('end to end: silent below the limit, in a subagent, when off, and on bad input', () => {
  const { f } = fixture([usage(240000)]);
  assert.equal(run({ session_id: 's3', transcript_path: fixture([usage(120000)]).f }).out, '');
  const sub = run({ session_id: 's3', transcript_path: f, agent_id: 'a1' });
  assert.equal(sub.out, ''); assert.equal(sub.ledger.length, 0);
  assert.equal(run({ session_id: 's3', transcript_path: f }, { SESSION_SIZE: 'off' }).out, '');
  const bad = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0); assert.equal(bad.stdout, '');
  assert.equal(run({ session_id: 's3', transcript_path: '/nonexistent.jsonl' }).out, '');
});

test('limit is configurable', () => {
  const { f } = fixture([usage(120000)]);
  assert.notEqual(run({ session_id: 's4', transcript_path: f }, { SESSION_SIZE_LIMIT: '100000' }).out, '');
});

test('promptKind tells user prompts from machine messages', () => {
  assert.equal(promptKind('Also add a section on cost'), 'user');
  assert.equal(promptKind('Another Claude session sent a message: <cross-session-message from="x">'), 'machine');
  assert.equal(promptKind('<task-notification>\n<task-id>a1</task-id>'), 'machine');
  assert.equal(promptKind('  [Subagent hand-back] report'), 'machine');
  assert.equal(promptKind('please read <task-notification> later'), 'user');
  assert.equal(promptKind(undefined), 'missing');
});

test('end to end: the ledger records the prompt kind', () => {
  const { f } = fixture([usage(120000)]);
  assert.equal(run({ session_id: 's5', transcript_path: f, prompt: '<task-notification>x' }).ledger[0].prompt_kind, 'machine');
  assert.equal(run({ session_id: 's5', transcript_path: f, prompt: 'hello' }).ledger[0].prompt_kind, 'user');
  assert.equal(run({ session_id: 's5', transcript_path: f }).ledger[0].prompt_kind, 'missing');
});

test('needsWithdraw: only sessions nudged with the old text, once', () => {
  assert.equal(needsWithdraw({}), false);
  assert.equal(needsWithdraw({ firedAt: 210000 }), true);
  assert.equal(needsWithdraw({ firedAt: 210000, withdrawn: true }), false);
  assert.equal(needsWithdraw({ firedAt: 210000, v: 2 }), false);
});

test('end to end: an old-nudged session gets the withdrawal once, silently, then nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-size-old-'));
  const st = path.join(dir, 'st'); mkdirSync(st);
  const h = createHash('sha256').update('old1').digest('hex').slice(0, 12);
  writeFileSync(path.join(st, h + '.json'), JSON.stringify({ firedAt: 210000 }));
  const env = { SESSION_SIZE_LEDGER: path.join(dir, 'l.jsonl'), SESSION_SIZE_STATE_DIR: st };
  const f = fixture([usage(220000)]).f;
  const first = run({ session_id: 'old1', transcript_path: f, prompt: 'go on' }, env);
  const o = JSON.parse(first.out);
  assert.equal(o.hookSpecificOutput.additionalContext, WITHDRAW);
  assert.equal(o.systemMessage, undefined);
  assert.equal(run({ session_id: 'old1', transcript_path: f, prompt: 'go on' }, env).out, '');
});

test('end to end: a session nudged with the new text never gets the withdrawal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-size-new-'));
  const env = { SESSION_SIZE_LEDGER: path.join(dir, 'l.jsonl'), SESSION_SIZE_STATE_DIR: path.join(dir, 'st') };
  assert.notEqual(run({ session_id: 'new1', transcript_path: fixture([usage(240000)]).f }, env).out, '');
  assert.equal(run({ session_id: 'new1', transcript_path: fixture([usage(245000)]).f }, env).out, '');
});
