// node --test plugins/ech-context/tests/compact-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'compact-guard.mjs');

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'compact-guard-'));
  const t = path.join(dir, 't.jsonl');
  writeFileSync(t, JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 216000 } } }) + '\n');
  const env = { ...process.env, COMPACT_GUARD: '', HARNESS_DATA_DIR: dir, COMPACT_GUARD_LEDGER: path.join(dir, 'l.jsonl'), COMPACT_GUARD_STATE_DIR: path.join(dir, 'st') };
  const run = (inp, extra = {}) => {
    const r = spawnSync('node', [HOOK], { input: typeof inp === 'string' ? inp : JSON.stringify(inp), env: { ...env, ...extra }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };
  const ledger = () => existsSync(env.COMPACT_GUARD_LEDGER) ? readFileSync(env.COMPACT_GUARD_LEDGER, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, t, run, ledger };
}

test('auto PreCompact in the main thread prints the MUST SURVIVE instructions and logs the context', () => {
  const s = sandbox();
  const r = s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'm1', transcript_path: s.t });
  assert.equal(r.code, 0);
  assert.match(r.out, /MUST SURVIVE/);
  assert.match(r.out, /HOLD, NO-PUSH/);
  const [l] = s.ledger();
  assert.equal(l.event, 'pre'); assert.equal(l.trigger, 'auto'); assert.equal(l.context, 217002); assert.equal(l.injected, true);
});

test('auto PreCompact in a subagent keeps the brief, not the lane list', () => {
  const s = sandbox();
  const r = s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'm2', agent_id: 'a1', agent_type: 'implementer', transcript_path: s.t });
  assert.match(r.out, /original brief/);
  assert.doesNotMatch(r.out, /MUST SURVIVE/);
  assert.equal(s.ledger()[0].agent_id, 'a1');
});

test('manual PreCompact prints nothing but is logged', () => {
  const s = sandbox();
  assert.equal(s.run({ hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'm3', transcript_path: s.t }).out, '');
  assert.equal(s.ledger()[0].injected, false);
});

test('SessionStart(compact) after an auto compaction adds the recovery line once', () => {
  const s = sandbox();
  s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'm4', transcript_path: s.t });
  const r = s.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'm4' });
  const o = JSON.parse(r.out);
  assert.equal(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(o.hookSpecificOutput.additionalContext, /compacted AUTOMATICALLY/);
  assert.equal(s.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'm4' }).out, '');
});

test('SessionStart(compact) after a manual compaction, or with no PreCompact, stays silent', () => {
  const s = sandbox();
  s.run({ hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'm5', transcript_path: s.t });
  assert.equal(s.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'm5' }).out, '');
  assert.equal(s.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'never' }).out, '');
});

test('a subagent auto compaction does not trigger the main recovery line', () => {
  const s = sandbox();
  s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'm6', agent_id: 'a2', transcript_path: s.t });
  assert.equal(s.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'm6' }).out, '');
});

test('off switch, off file, bad input and a missing transcript all fail open', () => {
  const s = sandbox();
  assert.equal(s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'x', transcript_path: s.t }, { COMPACT_GUARD: 'off' }).out, '');
  const bad = s.run('not json');
  assert.equal(bad.code, 0); assert.equal(bad.out, '');
  const miss = s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'y', transcript_path: '/nope.jsonl' });
  assert.equal(miss.code, 0); assert.match(miss.out, /MUST SURVIVE/);
});

test('the off file silences the hook', () => {
  const s = sandbox();
    writeFileSync(path.join(s.dir, 'compact-guard.off'), '');
  assert.equal(s.run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'z', transcript_path: s.t }).out, '');
  assert.equal(s.ledger().length, 0);
});

