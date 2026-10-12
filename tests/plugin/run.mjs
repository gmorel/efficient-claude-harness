#!/usr/bin/env node
// Plugin-only checks for the harness plugin hooks. Teammate-runnable: needs node and git, nothing else.
// It runs the NEW hooks (plugins/ech/hooks) alone, against a local Jev stub, in a temp directory with a temp HOME.
// It needs NO ~/.claude/hooks originals and NO owner config (ERRAND_ROUTER_CONFIG is not read here), so it makes no parity claim.
// The owner-only parity table lives in tests/parity/run.mjs.
//
// Usage: node tests/plugin/run.mjs [--keep]
//   --keep leaves the temp directory in place.
// Exit: 0 every check PASS and the ledger-guard unit checks pass, 1 any FAIL, 3 bad usage or a missing hook file.
// Every child gets a minimal environment and a temp HOME, so the result does not depend on the caller's HOME or ERRAND_ROUTER_CONFIG.
// Prove it: env -u ERRAND_ROUTER_CONFIG HOME="$(mktemp -d)" node tests/plugin/run.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const USAGE = 'usage: run.mjs [--keep]\n';
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
if (args.some(a => a !== '--keep')) { process.stderr.write(USAGE); process.exit(3); }

// ---------------------------------------------------------------- paths

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(HERE, '..', '..', 'plugins', 'ech', 'hooks');
const RG = path.join(HOOKS, 'route-gate.mjs');
const ER = path.join(HOOKS, 'errand-router.mjs');
for (const f of [RG, ER]) {
  if (!existsSync(f)) { process.stderr.write(`missing hook file: ${f}\n`); process.exit(3); }
}
const HOOK = { rg: realpathSync(RG), er: realpathSync(ER) };

const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-plugin-')));
const HOME_DIR = path.join(TMP, 'home');
const CLAUDE_DIR = path.join(HOME_DIR, '.claude');
const FIXTURES = path.join(TMP, 'fixtures');
const CONFIG_COPY = path.join(FIXTURES, 'route-gate.json');
const LANE_SCRIPT = path.join(FIXTURES, 'composer-run.mjs');
const CURSOR_BIN = path.join(FIXTURES, 'cursor-agent');
const NO_KEY_FILE = path.join(TMP, 'no-jev-key-file');
const KEY_FILE = path.join(FIXTURES, 'jev.env');
const MISSING = path.join(TMP, 'missing');
const REPO = path.join(TMP, 'repo');
const NONGIT = path.join(TMP, 'nongit');
const DUMMY_KEY = 'harness-dummy-key';

// ---------------------------------------------------------------- session ids (the arm is chosen by the same hash as the hooks)

const firstByte = s => createHash('sha256').update(String(s)).digest()[0];
function pickSid(prefix, parity) {
  for (let i = 0; ; i++) if (firstByte(`${prefix}-${i}`) % 2 === parity) return `${prefix}-${i}`;
}
const SID_NUDGE = pickSid('er-nudge', 0);
const SID_RG = 'rg-session';

// ---------------------------------------------------------------- fixtures

const lines = (n, tag = 'v') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const GIT_ENV = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: HOME_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(...a) {
  const r = spawnSync('git', a, { env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
}
function put(f, s) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); }

function buildFixtures() {
  mkdirSync(path.join(CLAUDE_DIR, 'agents'), { recursive: true });
  mkdirSync(path.join(CLAUDE_DIR, 'sessions'), { recursive: true });
  // route-gate reads the session file to tell an interactive session from a subagent or a scripted one.
  put(path.join(CLAUDE_DIR, 'sessions', `${SID_NUDGE}.json`), JSON.stringify({ sessionId: SID_NUDGE, kind: 'interactive' }));
  put(path.join(CLAUDE_DIR, 'sessions', `${SID_RG}.json`), JSON.stringify({ sessionId: SID_RG, kind: 'interactive' }));
  // Fixed config, the same thresholds the parity fallback uses.
  put(CONFIG_COPY, '{ "mode": "warn", "maxLines": 15, "maxFilesPerPrompt": 3 }\n');
  put(LANE_SCRIPT, '');
  put(CURSOR_BIN, '');
  // A dotenv-style file holding only a dummy key, in the shape the owner's real file uses (export, quotes, a neighbour line).
  put(KEY_FILE, `OTHER_SETTING=1\nexport TYPESAFE_AI_JEV_API_KEY="${DUMMY_KEY}"\n`);

  put(path.join(REPO, 'src', 'a.ts'), lines(5, 'a'));
  put(path.join(REPO, 'src', 'b.ts'), lines(5, 'b'));
  put(path.join(REPO, 'src', 'c.ts'), lines(5, 'c'));
  put(path.join(REPO, 'src', 'd.ts'), lines(5, 'd'));
  put(path.join(REPO, 'src', 'many.ts'), 'foo();\nbar();\n'.repeat(8));
  put(path.join(REPO, 'README.md'), '# fixture\n');
  git('-c', 'init.defaultBranch=main', 'init', '-q', REPO);
  git('-C', REPO, 'add', '-A');
  git('-C', REPO, '-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-q', '-m', 'fixture');
  put(path.join(NONGIT, 'a.ts'), lines(3, 'n'));
}

// ---------------------------------------------------------------- Jev stub

const answer = (choice, confidence) => ({ status: 200, body: JSON.stringify({ answers: { voie: { choice, confidence, probabilities: { [choice]: confidence } } }, usage: { input_tokens: 1, output_tokens: 1 } }) });
const JEV_EXPLORE_92 = answer('explore', 0.92);
const stub = { response: JEV_EXPLORE_92, bodies: [] };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch { body = { unparsable: raw.length }; }
    // hasKey: the key is in the body (a leak). authOk: the bearer token is the dummy key. The value itself is never recorded.
    stub.bodies.push({ body, hasKey: raw.includes(DUMMY_KEY), authOk: req.headers.authorization === `Bearer ${DUMMY_KEY}` });
    const r = stub.response;
    res.writeHead(r.status, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(r.body);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const STUB_URL = `http://127.0.0.1:${server.address().port}/v1/systemone`;
// A port with nothing listening: bind it, read it, release it.
const dead = http.createServer();
await new Promise(r => dead.listen(0, '127.0.0.1', r));
const DEAD_URL = `http://127.0.0.1:${dead.address().port}/v1/systemone`;
await new Promise(r => dead.close(r));

// ---------------------------------------------------------------- cases (only the shapes the checks use)

const R = p => path.join(REPO, p);
const bash = command => ({ tool: 'Bash', input: { command } });
const write = (p, n) => ({ tool: 'Write', input: { file_path: p, content: lines(n) } });
const ERRANDS = [
  `cat ${R('src/a.ts')}`,
  `sed -n 1,20p ${R('src/b.ts')}`,
  `grep -n foo ${R('src')}`,
  `git -C ${REPO} log --oneline -5`,
  `cat ${R('src/c.ts')} | head -n 3`,
  `grep -rn bar ${R('src')}`,
];
const run = n => ERRANDS.slice(0, n).map(bash);

// ---------------------------------------------------------------- one child run

// Every check gets its own root, so a ledger line from one check can never show up in another.
function childEnv(profile, root, extra) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: HOME_DIR,
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    HARNESS_DATA_DIR: path.join(root, 'data'),
    ROUTING_LEDGER: path.join(root, 'routing.jsonl'),
    ROUTE_GATE_STATE: path.join(root, 'route-gate-state.json'),
    ROUTE_GATE_CONFIG: CONFIG_COPY,
    ROUTE_GATE_LANE_SCRIPT: LANE_SCRIPT,
    ROUTE_GATE_CURSOR_BIN: CURSOR_BIN,
    ERRAND_ROUTER_LEDGER: path.join(root, 'errand-router.jsonl'),
    ERRAND_ROUTER_STATE_DIR: path.join(root, 'errand-state'),
    COMPOSER_LANE_LOG: path.join(root, 'runs.jsonl'),
    JEV_ENV_FILE: NO_KEY_FILE,
    JEV_URL: STUB_URL,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  // 'plugin' is Jev mode on with the dummy key; 'default' is the plain mode.
  if (profile === 'plugin') { env.ERRAND_ROUTER_JEV = '1'; env.TYPESAFE_AI_JEV_API_KEY = DUMMY_KEY; }
  for (const [k, v] of Object.entries(extra || {})) { if (v === null) delete env[k]; else env[k] = v; }
  return env;
}

function runNode(file, stdin, env, cwd) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const ch = spawn(process.execPath, [file], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => ch.kill('SIGKILL'), 20000);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', e => finish({ rc: -1, out, err: String(e) }));
    ch.on('close', code => finish({ rc: code, out, err }));
    ch.stdin.on('error', () => {});
    ch.stdin.end(stdin);
  });
}

const readLedger = f => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { unparsable: l }; } }); } catch { return []; } };

function decisionOf(stdout) {
  const s = stdout.trim();
  if (!s) return { kind: 'silent', text: '' };
  let j;
  try { j = JSON.parse(s); } catch { return { kind: 'raw', text: s }; }
  const h = j?.hookSpecificOutput || {};
  if (h.permissionDecision) return { kind: h.permissionDecision, text: h.permissionDecisionReason ?? '', event: h.hookEventName };
  if (h.additionalContext != null) return { kind: 'warn', text: h.additionalContext, event: h.hookEventName };
  return { kind: 'json', text: s };
}

// One check's steps through the NEW hook only. c: { id, hook: 'rg'|'er', env?, steps }.
async function runSide(c, profile) {
  const root = path.join(TMP, 'runs', profile, c.id);
  mkdirSync(root, { recursive: true });
  const ledgerFile = path.join(root, c.hook === 'rg' ? 'routing.jsonl' : 'errand-router.jsonl');
  const out = [];
  let seen = 0;
  for (let i = 0; i < c.steps.length; i++) {
    const st = c.steps[i];
    const id = `toolu_${c.id}_${i + 1}`;
    const inp = c.hook === 'rg'
      ? { session_id: st.sid || SID_RG, prompt_id: `p-${c.id}`, cwd: REPO, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input, tool_use_id: id }
      : { session_id: st.sid || SID_NUDGE, cwd: REPO, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input, tool_use_id: id };
    stub.response = c.jev || JEV_EXPLORE_92;
    stub.bodies = [];
    const env = childEnv(profile, root, { ...(c.env || {}) });
    const t0 = Date.now();
    const r = await runNode(HOOK[c.hook], JSON.stringify(inp), env, REPO);
    const ms = Date.now() - t0;
    const all = readLedger(ledgerFile);
    const recs = all.slice(seen);
    seen = all.length;
    out.push({ rc: r.rc, ms, decision: decisionOf(r.out), ledger: recs, bodies: stub.bodies, raw: r.out + r.err });
  }
  return out;
}

// ---------------------------------------------------------------- comparison helpers

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function ledgerView(rec) {
  const o = {};
  for (const k of Object.keys(rec).sort()) {
    const v = rec[k];
    if (k === 'ts' || k.endsWith('_id')) o[k] = '<skip>';
    else if (typeof v === 'string' && (TS_RE.test(v) || v.startsWith(TMP))) o[k] = '<skip>';
    else if (k === 'jev_ms') o[k] = v === null ? null : typeof v;
    else o[k] = v;
  }
  return o;
}
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function stepEqual(o, n) {
  return o.rc === n.rc
    && o.decision.kind === n.decision.kind && o.decision.text === n.decision.text && o.decision.event === n.decision.event
    && same(o.ledger.map(ledgerView), n.ledger.map(ledgerView))
    && same(o.bodies.map(b => b.body), n.bodies.map(b => b.body));
}
// Criteria keys of every stub request, each sorted and joined. The body is { model, state, questions: { voie: { type, instructions, criteria } } }.
const critKeys = steps => steps.flatMap(s => s.bodies).map(b => Object.keys(b.body?.questions?.voie?.criteria || {}).sort().join(','));
const sentKeys = (steps, want) => { const k = critKeys(steps); return k.length === 1 && k[0] === [...want].sort().join(','); };
const callsOf = steps => steps.reduce((s, x) => s + x.bodies.length, 0);
const GENERIC_LANES = ['explore', 'main'];
const NONE_CRITERION = { when: 'no lane in the list fits this call' };

// ---------------------------------------------------------------- the checks

const CHECKS = [
  { id: 'po-lanes-override', hook: 'er', what: 'ERRAND_ROUTER_LANES override: request criteria are exactly explore, main, none',
    env: { ERRAND_ROUTER_LANES: '{"explore":"Explore: custom text.","main":"main thread."}' }, profile: 'plugin', steps: run(3),
    check: s => sentKeys(s, ['explore', 'main', 'none']) },
  { id: 'po-lanes-not-json', hook: 'er', what: 'ERRAND_ROUTER_LANES not JSON: request criteria are the generic lanes + none',
    env: { ERRAND_ROUTER_LANES: 'not json' }, profile: 'plugin', steps: run(3),
    check: s => sentKeys(s, [...GENERIC_LANES, 'none']) },
  { id: 'po-lanes-none-reserved', hook: 'er', what: 'ERRAND_ROUTER_LANES {"none":"x"}: none is not taken, the generic lanes apply',
    env: { ERRAND_ROUTER_LANES: '{"none":"x"}' }, profile: 'plugin', steps: run(3),
    check: s => sentKeys(s, [...GENERIC_LANES, 'none']) && same(s[2].bodies[0].body.questions.voie.criteria.none, NONE_CRITERION) },
  { id: 'po-jev-no-key', hook: 'er', what: 'ERRAND_ROUTER_JEV=1 without a key: no stub call, same output as the default mode (nudge at streak 3)',
    env: { TYPESAFE_AI_JEV_API_KEY: null }, profile: 'plugin', steps: run(3),
    check: async (s, c) => {
      const d = await runSide({ ...c, id: c.id + '-default-twin', env: {} }, 'default');
      return callsOf(s) === 0 && s[2].decision.kind === 'warn' && s.every((x, i) => stepEqual(x, d[i]));
    } },
  { id: 'po-jev-dead-url', hook: 'er', what: 'ERRAND_ROUTER_JEV=1, key, JEV_URL on a closed port: silent, exit 0, each run under 3 s',
    env: { JEV_URL: DEAD_URL }, profile: 'plugin', steps: run(3),
    check: s => s.every(x => x.rc === 0 && x.decision.kind === 'silent' && x.ms < 3000) && s[2].ledger.some(r => r.action === 'jev-null') },
  { id: 'po-jev-file-key', hook: 'er', what: 'JEV_ENV_FILE supplies the key only when TYPESAFE_AI_JEV_API_KEY is empty; without JEV_ENV_FILE no file is read; the key never reaches stdout, stderr or a ledger',
    env: { TYPESAFE_AI_JEV_API_KEY: null, JEV_ENV_FILE: KEY_FILE }, profile: 'plugin', steps: run(3),
    check: async (s, c) => {
      const noFile = await runSide({ ...c, id: c.id + '-no-file', env: { TYPESAFE_AI_JEV_API_KEY: null, JEV_ENV_FILE: null } }, 'plugin');
      const fromFile = callsOf(s) === 1 && s[2].bodies[0]?.authOk === true && s[2].decision.kind === 'warn';
      const noDefault = callsOf(noFile) === 0 && noFile[2].decision.kind === 'warn';
      const leak = s.some(x => x.raw.includes(DUMMY_KEY) || JSON.stringify(x.ledger).includes(DUMMY_KEY));
      return fromFile && noDefault && !leak;
    } },
  { id: 'po-rg-prefix-unset', hook: 'rg', what: 'ROUTE_GATE_AGENT_PREFIX unset: deny reason names ech:ai-coder',
    env: { ROUTE_GATE: 'deny' }, profile: 'default', steps: [write(R('src/a.ts'), 20)],
    check: s => s[0].decision.kind === 'deny' && s[0].decision.text.includes('through the ech:ai-coder agent') },
  { id: 'po-rg-prefix-empty', hook: 'rg', what: 'ROUTE_GATE_AGENT_PREFIX empty: deny reason names ai-coder',
    env: { ROUTE_GATE: 'deny', ROUTE_GATE_AGENT_PREFIX: '' }, profile: 'default', steps: [write(R('src/a.ts'), 20)],
    check: s => s[0].decision.kind === 'deny' && s[0].decision.text.includes('through the ai-coder agent') && !s[0].decision.text.includes('harness:') },
  { id: 'po-config-absent', hook: 'er', what: 'ERRAND_ROUTER_CONFIG names a missing file: no error, request criteria are the generic lanes + none',
    env: { ERRAND_ROUTER_CONFIG: path.join(MISSING, 'errand-router.json') }, profile: 'plugin', steps: run(3),
    check: s => s.every(x => x.rc === 0) && sentKeys(s, [...GENERIC_LANES, 'none']) },
];

// ---------------------------------------------------------------- main

const results = [];
let exit = 0;
try {
  buildFixtures();
  for (const c of CHECKS) {
    const steps = await runSide(c, c.profile);
    let ok = false;
    try { ok = !steps.some(x => x.bodies.some(b => b.hasKey)) && await c.check(steps, c); } catch { ok = false; }
    results.push(`${ok ? 'PASS' : 'FAIL'} ${c.id} — ${c.what}`);
  }
  // The ledger-guard unit checks live next to the parity tool, which uses the same module.
  const g = spawnSync(process.execPath, [path.join(HERE, 'ledger-guard.test.mjs')], { encoding: 'utf8' });
  results.push(`${g.status === 0 ? 'PASS' : 'FAIL'} ledger-guard — unit checks for the parity ledger split (tests/plugin/ledger-guard.test.mjs)`);
} catch (e) {
  process.stderr.write(`harness error: ${e && e.stack || e}\n`);
  exit = 1;
}

const failed = results.filter(r => !r.startsWith('PASS')).length;
const out = ['PLUGIN-ONLY checks (NEW hooks alone, no originals, no owner config)', ...results,
  `PASS ${results.length - failed} · FAIL ${failed}`];
if (failed || results.length < CHECKS.length + 1) exit = 1;
try { server.closeAllConnections?.(); server.close(); } catch {}
if (!KEEP) { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
// A pipe is asynchronous on macOS: exit only once the table is flushed.
process.stdout.write(out.join('\n') + '\n', () => process.exit(exit));
