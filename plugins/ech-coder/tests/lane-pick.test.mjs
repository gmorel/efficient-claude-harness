// Checks for scripts/lane-pick.mjs: Jev picks the lane, every failure picks high, the brief text never leaves.
// Every child gets a temp data directory, a minimal environment and, when it talks to Jev, a local http stub; never a real key or the real network.
// Run: node --test plugins/ech-coder/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'lane-pick.mjs');
const KEY = 'dummy-test-key-not-real';
const MARKER = 'BRIEF-MARKER-do-not-send-7c1f';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lane-pick-'));
  const w = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); };
  w('repo/src/a.ts', 'const a = 1;\nconst b = 2;\n');
  w('repo/migrations/001.sql', 'select 1;\n');
  w('brief.md', `Goal: ${MARKER} rename the helper in src/a.ts.\nVerify with npm test.\n`);
  const g = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', path.join(dir, 'repo')], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(g.status, 0);
  return dir;
}

// A local Jev stand-in: `reply(body)` returns {status, text} or null to never answer.
async function stub(reply) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      hits.push({ body, auth: req.headers.authorization });
      const r = reply(body);
      if (!r) return;
      res.writeHead(r.status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(r.text);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${srv.address().port}/v1/systemone`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

const answer = (choice, confidence) => () => ({ status: 200, text: JSON.stringify({ answers: { lane: { choice, confidence, probabilities: { [choice]: confidence } } }, usage: {} }) });

function run(dir, extra = {}, args = ['--brief', path.join(dir, 'brief.md'), '--repo', path.join(dir, 'repo')]) {
  const env = {
    PATH: process.env.PATH, HOME: dir, HARNESS_DATA_DIR: path.join(dir, 'data'),
    JEV_ENV_FILE: path.join(dir, 'no-key'), ...extra,
  };
  const t0 = Date.now();
  return new Promise(resolve => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0, json: out.trim() ? JSON.parse(out.trim()) : null }));
  });
}

const jevOn = url => ({ AI_CODER_JEV: '1', TYPESAFE_AI_JEV_API_KEY: KEY, JEV_URL: url });
const ledger = dir => readFileSync(path.join(dir, 'data', 'ai-coder-lane.jsonl'), 'utf8');

test('Jev says average with confidence >= 0.80: the average lane runs', async () => {
  const s = await stub(answer('average', 0.92));
  try {
    const dir = fixture();
    const r = await run(dir, jevOn(s.url));
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { lane: 'average', source: 'jev', reason: 'jev', confidence: 0.92 });
    assert.equal(s.hits.length, 1);
  } finally { s.close(); }
});

test('Jev says high: the high lane runs', async () => {
  const s = await stub(answer('high', 0.88));
  try {
    const r = await run(fixture(), jevOn(s.url));
    assert.deepEqual(r.json, { lane: 'high', source: 'jev', reason: 'jev', confidence: 0.88 });
  } finally { s.close(); }
});

test('low confidence falls back to high', async () => {
  const s = await stub(answer('average', 0.55));
  try {
    const r = await run(fixture(), jevOn(s.url));
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'low_confidence', confidence: 0.55 });
  } finally { s.close(); }
});

test('ROUTE_GATE_JEV_MIN_CONF moves the threshold', async () => {
  const s = await stub(answer('average', 0.55));
  try {
    const r = await run(fixture(), { ...jevOn(s.url), ROUTE_GATE_JEV_MIN_CONF: '0.5' });
    assert.equal(r.json.lane, 'average');
  } finally { s.close(); }
});

test('an answer outside {average, high} falls back to high', async () => {
  const s = await stub(answer('none', 0.99));
  try {
    const r = await run(fixture(), jevOn(s.url));
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'off_menu', confidence: 0.99 });
  } finally { s.close(); }
});

test('an unreachable port falls back to high within the timeout', async () => {
  const s = await stub(answer('average', 0.9));
  const url = s.url;
  s.close();
  const r = await run(fixture(), { ...jevOn(url), ROUTE_GATE_JEV_TIMEOUT_MS: '1500' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'network', confidence: null });
  assert.ok(r.ms < 1500 + 1500, `took ${r.ms} ms`);
});

test('a Jev that never answers is cut at the timeout and falls back to high', async () => {
  const s = await stub(() => null);
  try {
    const r = await run(fixture(), { ...jevOn(s.url), ROUTE_GATE_JEV_TIMEOUT_MS: '300' });
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'timeout', confidence: null });
    assert.ok(r.ms < 300 + 1500, `took ${r.ms} ms`);
  } finally { s.close(); }
});

test('an HTTP error falls back to high and names the status', async () => {
  const s = await stub(() => ({ status: 500, text: '{"error":"boom"}' }));
  try {
    const r = await run(fixture(), jevOn(s.url));
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'http_500', confidence: null });
  } finally { s.close(); }
});

test('a malformed body falls back to high', async () => {
  const s = await stub(() => ({ status: 200, text: 'not json at all' }));
  try {
    const r = await run(fixture(), jevOn(s.url));
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'malformed', confidence: null });
  } finally { s.close(); }
});

test('no key: high, and the stub receives zero requests', async () => {
  const s = await stub(answer('average', 0.99));
  try {
    const r = await run(fixture(), { AI_CODER_JEV: '1', JEV_URL: s.url });
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'no_key', confidence: null });
    assert.equal(s.hits.length, 0);
  } finally { s.close(); }
});

test('Jev off: high, and no request even with a key set', async () => {
  const s = await stub(answer('average', 0.99));
  try {
    const r = await run(fixture(), { TYPESAFE_AI_JEV_API_KEY: KEY, JEV_URL: s.url });
    assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'jev_off', confidence: null });
    const r0 = await run(fixture(), { AI_CODER_JEV: '0', ROUTE_GATE_JEV: '1', TYPESAFE_AI_JEV_API_KEY: KEY, JEV_URL: s.url });
    assert.equal(r0.json.reason, 'jev_off');
    assert.equal(s.hits.length, 0);
  } finally { s.close(); }
});

test('ROUTE_GATE_JEV=1 turns the front on when AI_CODER_JEV is unset', async () => {
  const s = await stub(answer('average', 0.9));
  try {
    const r = await run(fixture(), { ROUTE_GATE_JEV: '1', TYPESAFE_AI_JEV_API_KEY: KEY, JEV_URL: s.url });
    assert.equal(r.json.lane, 'average');
    assert.equal(s.hits.length, 1);
  } finally { s.close(); }
});

test('the request body holds metadata only: no brief text, no key', async () => {
  const s = await stub(answer('average', 0.9));
  try {
    const dir = fixture();
    await run(dir, jevOn(s.url));
    assert.equal(s.hits.length, 1);
    const { body, auth } = s.hits[0];
    assert.ok(!body.includes(MARKER), 'brief text left the machine');
    assert.ok(!body.includes('rename the helper'), 'brief text left the machine');
    assert.ok(!body.includes(KEY), 'key is in the body');
    assert.equal(auth, `Bearer ${KEY}`);
    const st = JSON.parse(body).state;
    assert.deepEqual(st.files, [{ path: 'src/a.ts', ext: '.ts', lines: 2 }]);
    assert.equal(st.file_count, 1);
    assert.equal(st.guarded, false);
    assert.equal(st.brief_lines, 2);
    assert.ok(!JSON.stringify(st).includes(dir), 'an absolute path left the machine');
  } finally { s.close(); }
});

test('--files with a guarded path sets the flag, paths stay repo-relative', async () => {
  const s = await stub(answer('high', 0.9));
  try {
    const dir = fixture();
    await run(dir, jevOn(s.url), ['--repo', path.join(dir, 'repo'), '--files', `${path.join(dir, 'repo', 'migrations', '001.sql')},src/a.ts`, '--lines', '12']);
    const st = JSON.parse(s.hits[0].body).state;
    assert.deepEqual(st.files.map(f => f.path), ['migrations/001.sql', 'src/a.ts']);
    assert.equal(st.guarded, true);
    assert.equal(st.guarded_files, 1);
    assert.equal(st.planned_lines, 12);
  } finally { s.close(); }
});

test('the ledger line is written without brief text, paths or key', async () => {
  const s = await stub(answer('average', 0.9));
  try {
    const dir = fixture();
    await run(dir, jevOn(s.url));
    await run(dir, { AI_CODER_JEV: '1' });
    const lines = ledger(dir).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].lane, 'average');
    assert.equal(lines[0].source, 'jev');
    assert.equal(lines[0].jev_choice, 'average');
    assert.equal(lines[1].reason, 'no_key');
    const raw = ledger(dir);
    for (const bad of [MARKER, 'rename the helper', KEY, 'src/a.ts', dir]) assert.ok(!raw.includes(bad), `ledger holds ${bad}`);
  } finally { s.close(); }
});

test('bad arguments still print one fallback line and exit 0', async () => {
  const dir = fixture();
  const r = await run(dir, {}, ['--nope']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { lane: 'high', source: 'fallback', reason: 'bad_args', confidence: null });
  assert.ok(existsSync(path.join(dir, 'data', 'ai-coder-lane.jsonl')));
});

test('the guarded-path patterns match route-gate.mjs exactly', () => {
  const src = f => readFileSync(f, 'utf8').split('\n').filter(l => /^const GUARDED(_WORD)? = /.test(l));
  const gate = src(path.join(ROOT, 'hooks', 'route-gate.mjs'));
  assert.equal(gate.length, 2);
  assert.deepEqual(src(SCRIPT), gate);
});

test('the front names lane-pick and both lane files exist under their own names', () => {
  const front = readFileSync(path.join(ROOT, 'agents', 'ai-coder.md'), 'utf8');
  assert.match(front, /^name: ai-coder$/m);
  assert.match(front, /scripts\/lane-pick\.mjs/);
  assert.match(front, /agents\/ai-coder-<lane>\.md/);
  for (const lane of ['average', 'high']) {
    assert.match(readFileSync(path.join(ROOT, 'agents', `ai-coder-${lane}.md`), 'utf8'), new RegExp(`^name: ai-coder-${lane}$`, 'm'));
  }
  assert.match(readFileSync(path.join(ROOT, 'agents', 'ai-coder-high.md'), 'utf8'), /Else → `ech-coder:ai-coder-average`/);
});
