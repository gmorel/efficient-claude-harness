// Checks for the ech-coder route-gate hook, the namespaced agent names, and the copied Jev client.
// Every child gets a temp data directory, a temp Claude config dir and a minimal environment.
// Run: node --test plugins/ech-coder/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'route-gate.mjs');
const SID = 'sess-coder';
const lines = n => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'coder-'));
  const w = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); };
  w(`claude/sessions/${SID}.json`, JSON.stringify({ sessionId: SID, kind: 'interactive' }));
  w('cfg.json', '{ "mode": "warn", "maxLines": 15, "maxFilesPerPrompt": 3 }\n');
  w('lane.mjs', ''); w('cursor', ''); w('repo/src/a.ts', 'x\n'); w('repo/migrations/001.sql', 'x\n');
  const g = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', path.join(dir, 'repo')], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(g.status, 0);
  return dir;
}

function run(dir, input, extra = {}) {
  const env = {
    PATH: process.env.PATH, HARNESS_DATA_DIR: path.join(dir, 'data'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    ROUTE_GATE_CONFIG: path.join(dir, 'cfg.json'), ROUTE_GATE_LANE_SCRIPT: path.join(dir, 'lane.mjs'),
    ROUTE_GATE_CURSOR_BIN: path.join(dir, 'cursor'), ROUTE_GATE_STATE: path.join(dir, `st-${Math.random()}.json`),
    ROUTING_LEDGER: path.join(dir, 'routing.jsonl'), JEV_ENV_FILE: path.join(dir, 'no-key'), ...extra,
  };
  return new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK], { env });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err, json: out.trim() ? JSON.parse(out) : null }));
    p.stdin.end(JSON.stringify({ session_id: SID, prompt_id: 'p1', hook_event_name: 'PreToolUse', cwd: path.join(dir, 'repo'), ...input }));
  });
}
const write = (dir, file, n) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'repo', file), content: lines(n) } });

test('a big code write only warns by default and names the namespaced lane', async () => {
  const dir = fixture();
  const r = await run(dir, write(dir, 'src/new.ts', 40));
  assert.equal(r.code, 0);
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /ech-coder:ai-coder/);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
});

test('a small write passes without a word', async () => {
  const dir = fixture();
  const r = await run(dir, write(dir, 'src/small.ts', 3));
  assert.equal(r.out, '');
});

test('ROUTE_GATE=deny blocks the big write; ROUTE_GATE=off silences it', async () => {
  const dir = fixture();
  const d = await run(dir, write(dir, 'src/new.ts', 40), { ROUTE_GATE: 'deny' });
  assert.equal(d.json.hookSpecificOutput.permissionDecision, 'deny');
  const o = await run(dir, write(dir, 'src/new2.ts', 40), { ROUTE_GATE: 'off' });
  assert.equal(o.out, '');
});

test('a guarded path (migrations) points at the guarded lane', async () => {
  const dir = fixture();
  const r = await run(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'repo', 'migrations', '001.sql'), old_string: 'x', new_string: 'a\nb\nc' } });
  assert.match(JSON.stringify(r.json), /ech-coder:ai-coder-high/);
});

test('bad input fails open', async () => {
  const dir = fixture();
  const code = await new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HARNESS_DATA_DIR: dir } });
    p.on('close', resolve); p.stdin.end('not json');
  });
  assert.equal(code, 0);
});

test('Jev mode: the copied jev-client loads and is called through a local stub (no real network)', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ answers: { lane: { choice: 'composer', confidence: 0.95, probabilities: { composer: 0.95 } } }, usage: {} }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = fixture();
    const r = await run(dir, write(dir, 'src/new.ts', 40), {
      ROUTE_GATE_JEV: '1', TYPESAFE_AI_JEV_API_KEY: 'dummy-test-key', JEV_URL: `http://127.0.0.1:${srv.address().port}/v1/systemone`,
    });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.err, /ERR_MODULE_NOT_FOUND/);
    assert.ok(hits.length >= 1, 'the stub was called, so jev-client.mjs loaded');
  } finally { srv.close(); }
});

test('harness-config prints the default engines and a coder pick, no config file needed', () => {
  const env = { PATH: process.env.PATH, HOME: mkdtempSync(path.join(tmpdir(), 'home-')) };
  const show = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'harness-config.mjs'), 'show'], { env, encoding: 'utf8' });
  assert.equal(show.status, 0);
  assert.match(show.stdout, /composer/);
  const pick = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'harness-config.mjs'), 'pick', 'coder'], { env, encoding: 'utf8' });
  assert.equal(pick.status, 0);
});

test('composer-run, remote-run and delegate print usage without arguments and never crash on import', () => {
  for (const s of ['composer-run', 'remote-run', 'delegate']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', `${s}.mjs`)], { env: { PATH: process.env.PATH, HOME: tmpdir() }, encoding: 'utf8' });
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/, s);
    assert.ok((r.stdout + r.stderr).length > 0, `${s} prints something`);
  }
});

test('agents, command and skill carry their own namespace and nothing from the old plugin', () => {
  const files = [];
  const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => {
    const f = path.join(d, e.name);
    if (e.isDirectory() && e.name !== 'tests') walk(f); else if (/\.(md|mjs|json)$/.test(e.name)) files.push(f);
  });
  walk(ROOT);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bech:[a-z]|plugins\/ech\//, f);
  for (const a of ['ai-coder', 'ai-coder-high', 'composer-merger']) {
    assert.match(readFileSync(path.join(ROOT, 'agents', `${a}.md`), 'utf8'), new RegExp(`^name: ${a}$`, 'm'));
  }
});
