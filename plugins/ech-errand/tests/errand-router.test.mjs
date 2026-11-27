// Checks for the ech-errand hook: the enforce mode, the default warn mode, and that the copied Jev client loads.
// Every child gets its own data directory and a minimal environment, so nothing depends on the caller's HOME or env.
// Run: node --test plugins/ech-errand/tests/errand-router.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'hooks', 'errand-router.mjs');
const PROJECT = '/work/example-project';

function sandbox(config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'errand-'));
  const cfg = path.join(dir, 'errand-router.json');
  if (config) writeFileSync(cfg, JSON.stringify(config));
  return { dir, cfg };
}

function runHook(sb, input, extra = {}) {
  const env = {
    PATH: process.env.PATH, HARNESS_DATA_DIR: sb.dir, ERRAND_ROUTER_HOLDOUT: '0',
    JEV_ENV_FILE: path.join(sb.dir, 'no-key'), ...extra,
  };
  if (existsSync(sb.cfg)) env.ERRAND_ROUTER_CONFIG = sb.cfg;
  return new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK], { env });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err, json: out.trim() ? JSON.parse(out) : null }));
    p.stdin.end(JSON.stringify(input));
  });
}

const errand = (n, cwd, sid = 's1') => ({
  session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `t${n}`,
  tool_input: { command: `grep -rn needle${n} src` },
});
const decisionOf = r => r.json?.hookSpecificOutput?.permissionDecision ?? (r.json?.hookSpecificOutput?.additionalContext ? 'warn' : 'none');

async function streak(sb, cwd, n, extra) {
  const seen = [];
  for (let i = 1; i <= n; i++) seen.push(decisionOf(await runHook(sb, errand(i, cwd), extra)));
  return seen;
}

test('enforce project: the 5th errand in a row is denied, the 3rd and 4th only warn', async () => {
  const sb = sandbox({ enforce: { projects: [PROJECT] } });
  assert.deepEqual(await streak(sb, PROJECT + '/sub/dir', 5), ['none', 'none', 'warn', 'warn', 'deny']);
});

test('the same run outside an enforce project only warns, never denies', async () => {
  const sb = sandbox({ enforce: { projects: [PROJECT] } });
  assert.deepEqual(await streak(sb, '/work/other-project', 6), ['none', 'none', 'warn', 'warn', 'warn', 'warn']);
});

test('no config file: default warn mode, exit 0', async () => {
  const sb = sandbox();
  assert.deepEqual(await streak(sb, PROJECT, 5), ['none', 'none', 'warn', 'warn', 'warn']);
});

test('ERRAND_ROUTER=off wins over enforce', async () => {
  const sb = sandbox({ enforce: { projects: [PROJECT] } });
  const r = await runHook(sb, errand(1, PROJECT), { ERRAND_ROUTER: 'off' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('the enforce ledger line says so, and a subagent call passes untouched', async () => {
  const sb = sandbox({ enforce: { projects: [PROJECT] } });
  await runHook(sb, errand(1, PROJECT));
  const led = readFileSync(path.join(sb.dir, 'errand-router.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(led[0].enforced, true);
  assert.equal(led[0].mode, 'block');
  const sub = await runHook(sb, { ...errand(2, PROJECT), agent_id: 'a1' });
  assert.equal(sub.out, '');
});

test('bad input and an unreadable config fail open', async () => {
  const sb = sandbox();
  writeFileSync(sb.cfg, '{not json');
  const r = await runHook(sb, errand(1, PROJECT));
  assert.equal(r.code, 0);
  const junk = await new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HARNESS_DATA_DIR: sb.dir } });
    p.on('close', code => resolve(code));
    p.stdin.end('not json');
  });
  assert.equal(junk, 0);
});

test('enforcedFor: inside, equal, outside, relative entries, bad cwd', async () => {
  const { enforcedFor } = await import(HOOK);
  const cfg = { enforce: { projects: ['/a/b', 'relative/path'] } };
  assert.equal(enforcedFor('/a/b', cfg), true);
  assert.equal(enforcedFor('/a/b/c/d', cfg), true);
  assert.equal(enforcedFor('/a/bc', cfg), false);
  assert.equal(enforcedFor('/a', cfg), false);
  assert.equal(enforcedFor('relative/path', cfg), false);
  assert.equal(enforcedFor(undefined, cfg), false);
  assert.equal(enforcedFor('/a/b', {}), false);
});

test('Jev mode: the copied jev-client loads and answers through a local stub (no real network)', async () => {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      bodies.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ answers: { voie: { choice: 'explore', confidence: 0.95, probabilities: { explore: 0.95 } } }, usage: {} }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const sb = sandbox();
    const extra = { ERRAND_ROUTER_JEV: '1', TYPESAFE_AI_JEV_API_KEY: 'dummy-test-key', JEV_URL: `http://127.0.0.1:${srv.address().port}/v1/systemone` };
    let last;
    for (let i = 1; i <= 3; i++) last = await runHook(sb, errand(i, PROJECT), extra);
    assert.equal(last.code, 0);
    assert.doesNotMatch(last.err, /ERR_MODULE_NOT_FOUND|Cannot find/);
    assert.ok(bodies.length >= 1, 'the stub received a Jev call, so jev-client.mjs loaded');
    assert.equal(decisionOf(last), 'warn');
  } finally { srv.close(); }
});

test('the shipped example config conforms to the shipped schema and loads in the hook', async () => {
  const root = path.join(HERE, '..');
  const schema = JSON.parse(readFileSync(path.join(root, 'errand-router.schema.json'), 'utf8'));
  const example = JSON.parse(readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const known = Object.keys(schema.properties);
  for (const k of Object.keys(example)) assert.ok(known.includes(k), `unknown key ${k}`);
  assert.ok(Array.isArray(example.enforce.projects) && example.enforce.projects.every(p => path.isAbsolute(p)));
  assert.ok(Object.values(example.lanes).every(v => typeof v === 'string'));
  const { loadConfig } = await import(HOOK);
  assert.deepEqual(loadConfig(path.join(root, 'config.example.json')), example);
});
