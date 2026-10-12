// Unit checks for ledger-guard.mjs: the guard must fail on the test's own lines and must not fail on foreign ones.
// Run: node tests/plugin/ledger-guard.test.mjs
import assert from 'node:assert/strict';
import { ledgerDelta, splitOwnLines } from '../parity/ledger-guard.mjs';

const SYN = ['er-nudge-0', 'er-control-3', 'rg-session', 'rg-session-other'];
const TMP = '/private/var/folders/xx/T/hook-parity-abc123';
const REAL = '6c313ccc-3320-4f1e-9a4b-000000000001';
const opts = { syntheticSids: SYN, cwdPrefix: TMP };

// ledgerDelta
assert.equal(ledgerDelta('a\n', 'a\n').kind, 'same');
{
  const d = ledgerDelta('a\n', 'a\nb\nc\n');
  assert.equal(d.kind, 'added');
  assert.deepEqual(d.added, ['b', 'c']);
}
assert.equal(ledgerDelta('a\nb\n', 'x\n').kind, 'rewritten');
assert.deepEqual(ledgerDelta('', '').added, []);

// splitOwnLines: the test's own lines (synthetic session id, or a path under its temp dir) are `own`
{
  const s = splitOwnLines([
    JSON.stringify({ session_id: 'rg-session', tool: 'Write' }),
    JSON.stringify({ session_id: REAL, tool: 'Bash' }),
  ], opts);
  assert.equal(s.own.length, 1);
  assert.equal(s.own[0].sid, 'rg-session');
  assert.equal(s.foreign.length, 1);
  assert.equal(s.foreign[0].sid, REAL);
}
{
  const s = splitOwnLines([JSON.stringify({ session_id: REAL, file: `${TMP}/repo/src/a.ts` })], opts);
  assert.equal(s.own.length, 1, 'a line that names the temp directory is the test\'s');
}
{
  const s = splitOwnLines(['{"session_id":"', JSON.stringify({ session_id: REAL })], opts);
  assert.equal(s.own.length, 0);
  assert.equal(s.foreign.length, 2, 'a partial or unparsable line is foreign, never a failure');
}
{
  const s = splitOwnLines([JSON.stringify({ session_id: REAL })], { syntheticSids: SYN, cwdPrefix: undefined });
  assert.equal(s.own.length, 0, 'with no temp prefix only synthetic ids count');
}

console.log('ledger-guard: all checks pass');
