#!/usr/bin/env node
// Golden parity harness for the harness plugin hooks.
// It runs the OLD hooks (the owner's originals under ~/.claude/hooks, read and executed only) and the NEW hooks (plugins/ech/hooks) on identical stdin.
// Per case it compares the hook decision, the exit code, the ledger records and, in the owner profile, the Jev request bodies.
//
// After the parity table, a PLUGIN-ONLY section runs the one check that needs the owner config (no OLD side, so no parity claim).
// The other plugin-only checks, which need no owner config and no originals, live in tests/plugin/run.mjs.
//
// Owner-only: it exits 3 without the owner config. Teammates run tests/plugin/run.mjs instead.
// Usage: node tests/parity/run.mjs [--profile default|owner] [--keep]
//   no --profile runs both profiles.
//   --keep leaves the temp directory in place.
// Exit: 0 all MATCH or allowed and every plugin check PASS, 1 any DIFF / FAIL / line the test wrote to a real ledger, 2 an allowlist entry targets the owner profile, 3 bad usage, a missing OLD hook or a missing owner config.
// Every child gets a minimal environment and a temp HOME. The real ledgers are read before and after: lines another session added are info,
// lines carrying the test's own session ids or temp path fail the run (see ledger-guard.mjs).
// The NEW output reaches the comparison raw: there is no global normalisation, only the scoped allowlist rules below.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { ledgerDelta, splitOwnLines } from './ledger-guard.mjs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Intended differences, default profile only, one line of reason each.
// The owner profile must have none: the harness exits 2 if it does.
// An entry is either an id entry ({ id, profile, reason }: that case may differ in any way) or a scoped entry
// ({ scope: 'rg'|'er', profile, kind, reason }: a case of that hook may differ only in the way `kind` names, see allowedBy).
const ALLOW = [
  { id: 'er-bash-streak', profile: 'default', reason: 'plugin default mode nudges without Jev; original is silent when no key' },
  { id: 'er-read-streak', profile: 'default', reason: 'plugin default mode nudges without Jev; original is silent when no key' },
  { id: 'er-block-streak5', profile: 'default', reason: 'plugin default mode nudges without Jev; original is silent when no key' },
  { id: 'er-ssh-host', profile: 'default', reason: 'plugin default mode counts no ssh host as an errand; only Jev mode with ERRAND_ROUTER_CONFIG does' },
  { scope: 'rg', profile: 'default', kind: 'agent-prefix', reason: 'plugin names its agents ech:ai-coder; the original names them ai-coder' },
];
const allowName = a => a.id || `${a.scope}:${a.kind}`;

// ---------------------------------------------------------------- arguments

const USAGE = 'usage: run.mjs [--profile default|owner] [--keep]\n';
const args = process.argv.slice(2);
let profiles = ['default', 'owner'];
const KEEP = args.includes('--keep');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile') {
    const p = args[++i];
    if (p !== 'default' && p !== 'owner') { process.stderr.write(USAGE); process.exit(3); }
    profiles = [p];
  } else if (args[i] !== '--keep') {
    process.stderr.write(USAGE); process.exit(3);
  }
}

const ownerAllow = ALLOW.filter(a => a.profile !== 'default');
if (ownerAllow.length) {
  process.stderr.write(`allowlist entries outside the default profile are forbidden: ${ownerAllow.map(allowName).join(', ')}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------- paths

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_HOME = homedir();
const OLD = {
  rg: path.join(REAL_HOME, '.claude', 'hooks', 'route-gate.mjs'),
  er: path.join(REAL_HOME, '.claude', 'hooks', 'errand-router.mjs'),
};
const OLD_CONFIG = path.join(REAL_HOME, '.claude', 'composer-lane', 'route-gate.json');
const NEW = {
  rg: path.resolve(HERE, '..', '..', 'plugins', 'ech', 'hooks', 'route-gate.mjs'),
  er: path.resolve(HERE, '..', '..', 'plugins', 'ech', 'hooks', 'errand-router.mjs'),
};
for (const f of [...Object.values(OLD), ...Object.values(NEW)]) {
  if (!existsSync(f)) { process.stderr.write(`missing hook file: ${f}\n`); process.exit(3); }
}
// The original errand-router runs main() only when argv[1] equals its own (symlink-resolved) URL, so spawn real paths.
for (const o of [OLD, NEW]) for (const k of Object.keys(o)) o[k] = realpathSync(o[k]);

const REAL_LEDGERS = [
  path.join(REAL_HOME, '.claude', 'composer-lane', 'routing.jsonl'),
  path.join(REAL_HOME, '.claude', 'ledgers', 'errand-router.jsonl'),
];
const readText = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const ledgerBefore = REAL_LEDGERS.map(readText);

const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-parity-')));
const HOME_DIR = path.join(TMP, 'home');
const CLAUDE_DIR = path.join(HOME_DIR, '.claude');
const FIXTURES = path.join(TMP, 'fixtures');
const CONFIG_COPY = path.join(FIXTURES, 'route-gate.json');
const LANE_SCRIPT = path.join(FIXTURES, 'composer-run.mjs');
const CURSOR_BIN = path.join(FIXTURES, 'cursor-agent');
const NO_KEY_FILE = path.join(TMP, 'no-jev-key-file');
const MISSING = path.join(TMP, 'missing');
const REPO = path.join(TMP, 'repo');
const NONGIT = path.join(TMP, 'nongit');
const TRANSCRIPTS = path.join(TMP, 'transcripts');
const DUMMY_KEY = 'harness-dummy-key';

// ---------------------------------------------------------------- owner values (not in this repository)

// The owner's lane names, ssh host and live-run script names live in the owner config that ERRAND_ROUTER_CONFIG names.
// The owner profile hands that file to the plugin hook, and this runner reads the same file to build its own inputs.
// Both profiles need it: the original hooks under ~/.claude/hooks carry the same values.
const OWNER_CFG_FILE = process.env.ERRAND_ROUTER_CONFIG || path.join(REAL_HOME, '.config', 'harness', 'errand-router.json');
let OWNER;
try { OWNER = JSON.parse(readFileSync(OWNER_CFG_FILE, 'utf8')); } catch {
  process.stderr.write(`owner-only: use tests/plugin/run.mjs (owner config missing or unreadable: ${OWNER_CFG_FILE})\n`);
  process.exit(3);
}
const OWNER_LANES = Object.keys(OWNER.lanes || {});
const OTHER_LANE = OWNER_LANES.find(k => k !== 'explore' && k !== 'main');
const SSH_HOST = (OWNER.sshHosts || [])[0];
const LIVE_WORD = (OWNER.liveRunWords || [])[0];
if (!OTHER_LANE || !SSH_HOST || !LIVE_WORD) {
  process.stderr.write(`owner config lacks lanes, sshHosts or liveRunWords: ${OWNER_CFG_FILE}\n`);
  process.exit(3);
}

// A Write into a guarded git-hooks directory must be gated (route-gate guards .githooks/ and .git/hooks/ in both hooks).
const GUARD_WARN = { steps: { 1: { decision: 'warn', contains: 'guarded path' } } };

// ---------------------------------------------------------------- session ids (arm chosen by the same hash as the hooks)

const firstByte = s => createHash('sha256').update(String(s)).digest()[0];
function pickSid(prefix, parity) {
  for (let i = 0; ; i++) if (firstByte(`${prefix}-${i}`) % 2 === parity) return `${prefix}-${i}`;
}
const SID_NUDGE = pickSid('er-nudge', 0);
const SID_CONTROL = pickSid('er-control', 1);
const SID_RG = 'rg-session';
const SID_OTHER = 'rg-session-other';
const SYNTHETIC_SIDS = [SID_NUDGE, SID_CONTROL, SID_RG, SID_OTHER];

// ---------------------------------------------------------------- fixtures

// The owner's lane keys: each gets an agent file, so availableLanes sees all of them in OLD and NEW.
const BUILTIN_LANES = OWNER_LANES;
const lines = (n, tag = 'v') =>Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const GIT_ENV = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: HOME_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(...a) {
  const r = spawnSync('git', a, { env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
}
function put(f, s) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); }

function buildFixtures() {
  mkdirSync(path.join(CLAUDE_DIR, 'agents'), { recursive: true });
  mkdirSync(path.join(CLAUDE_DIR, 'sessions'), { recursive: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  // Every key of the original LANES table, so availableLanes sees all lanes in OLD and NEW.
  for (const k of BUILTIN_LANES) {
    put(path.join(CLAUDE_DIR, 'agents', `${k}.md`), `---\nname: ${k}\n---\nfixture\n`);
  }
  const sids = new Set([SID_NUDGE, SID_CONTROL, SID_RG]);
  for (const sid of sids) put(path.join(CLAUDE_DIR, 'sessions', `${sid}.json`), JSON.stringify({ sessionId: sid, kind: 'interactive' }));
  put(path.join(CLAUDE_DIR, 'sessions', `${SID_OTHER}.json`), JSON.stringify({ sessionId: SID_OTHER, kind: 'other' }));

  let cfg = '{ "mode": "warn", "maxLines": 15, "maxFilesPerPrompt": 3 }\n';
  try { cfg = readFileSync(OLD_CONFIG, 'utf8'); } catch {}
  put(CONFIG_COPY, cfg);
  put(LANE_SCRIPT, '');
  put(CURSOR_BIN, '');

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
const JEV = {
  explore92: answer('explore', 0.92),
  explore79: answer('explore', 0.79),
  main: answer('main', 0.95),
  none: answer('none', 0.95),
  otherLane92: answer(OTHER_LANE, 0.92),
  http500: { status: 500, body: '{"error":"stub"}' },
  badBody: { status: 200, body: 'this is not json' },
};
const stub = { response: JEV.explore92, bodies: [] };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch { body = { unparsable: raw.length }; }
    stub.bodies.push({ body, hasKey: raw.includes(DUMMY_KEY) }); // bodies only, never headers
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

// ---------------------------------------------------------------- transcript lines

const T = {
  prompt: text => ({ type: 'user', message: { role: 'user', content: text } }),
  use: (id, name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } }),
  result: id => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  note: id => ({ type: 'user', message: { role: 'user', content: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` } }),
};

// ---------------------------------------------------------------- cases

const R = p => path.join(REPO, p);
const bash = command => ({ tool: 'Bash', input: { command } });
const read = file_path => ({ tool: 'Read', input: { file_path } });
const write = (p, n) => ({ tool: 'Write', input: { file_path: p, content: lines(n) } });
const edit = (p, n) => ({ tool: 'Edit', input: { file_path: p, old_string: lines(n, 'o'), new_string: lines(n, 'w') } });
const ERRANDS = [
  `cat ${R('src/a.ts')}`,
  `sed -n 1,20p ${R('src/b.ts')}`,
  `grep -n foo ${R('src')}`,
  `git -C ${REPO} log --oneline -5`,
  `cat ${R('src/c.ts')} | head -n 3`,
  `grep -rn bar ${R('src')}`,
];
const run = n => ERRANDS.slice(0, n).map(bash);
const BOTH = ['default', 'owner'];

// A case: { id, hook: 'rg'|'er', profiles, env?, steps: [{ tool, input, sid?, prompt?, agent?, env?, transcript? }], jev?, expect? }.
// expect (checked on OLD and NEW): { calls, steps: { <1-based step>: { decision, contains? } } }.
const CASES = [
  // ---- route-gate, both profiles
  { id: 'rg-nongit-write', hook: 'rg', steps: [write(path.join(NONGIT, 'a.ts'), 20)] },
  { id: 'rg-git-small-edit', hook: 'rg', steps: [edit(R('src/a.ts'), 1)] },
  { id: 'rg-git-write-large', hook: 'rg', steps: [write(R('src/a.ts'), 20)] },
  { id: 'rg-replace-all', hook: 'rg', steps: [{ tool: 'Edit', input: { file_path: R('src/many.ts'), old_string: 'foo();\nbar();', new_string: 'baz();\nqux();', replace_all: true } }] },
  { id: 'rg-multiedit', hook: 'rg', steps: [{ tool: 'MultiEdit', input: { file_path: R('src/many.ts'), edits: [{ old_string: lines(10, 'o'), new_string: lines(10, 'w') }, { old_string: 'foo();', new_string: 'zap();', replace_all: true }] } }] },
  { id: 'rg-notebook-ipynb', hook: 'rg', steps: [{ tool: 'NotebookEdit', input: { notebook_path: R('nb/analysis.ipynb'), new_source: lines(20) } }] },
  { id: 'rg-notebook-py', hook: 'rg', steps: [{ tool: 'NotebookEdit', input: { notebook_path: R('src/cell.py'), new_source: lines(20) } }] },
  { id: 'rg-md-silent', hook: 'rg', steps: [write(R('README.md'), 30)] },
  { id: 'rg-guard-migration', hook: 'rg', steps: [write(R('migrations/0001.sql'), 3)] },
  { id: 'rg-guard-auth', hook: 'rg', steps: [edit(R('src/auth/login.ts'), 1)] },
  { id: 'rg-guard-payments', hook: 'rg', steps: [edit(R('src/payments/x.ts'), 1)] },
  { id: 'rg-guard-billing', hook: 'rg', steps: [edit(R('billing/invoice.ts'), 1)] },
  { id: 'rg-guard-dotenv', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.env'), content: 'DEBUG=1\n' } }] },
  { id: 'rg-guard-gh-workflow', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.github/workflows/ci.yml'), content: 'on: push\n' } }] },
  { id: 'rg-guard-gitlab-ci', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.gitlab-ci.yml'), content: 'stages: [test]\n' } }] },
  { id: 'rg-guard-git-hooks', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.git/hooks/pre-commit'), content: '#!/bin/sh\nexit 0\n' } }] },
  { id: 'rg-githooks-pre-commit', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.githooks/pre-commit'), content: '#!/bin/sh\nexit 0\n' } }], expect: GUARD_WARN },
  { id: 'rg-githooks-pre-push', hook: 'rg', steps: [{ tool: 'Write', input: { file_path: R('.githooks/pre-push'), content: '#!/bin/sh\nexit 0\n' } }], expect: GUARD_WARN },
  { id: 'rg-files-per-prompt', hook: 'rg', steps: ['a', 'b', 'c', 'd'].map(f => ({ ...edit(R(`src/${f}.ts`), 1), prompt: 'p-many' })) },
  ...['off', 'warn', 'deny'].flatMap(m => [
    { id: `rg-mode-${m}-small`, hook: 'rg', env: { ROUTE_GATE: m }, steps: [edit(R('src/a.ts'), 1)] },
    { id: `rg-mode-${m}-large`, hook: 'rg', env: { ROUTE_GATE: m }, steps: [write(R('src/a.ts'), 20)] },
  ]),
  { id: 'rg-deny-guarded', hook: 'rg', env: { ROUTE_GATE: 'deny' }, steps: [write(R('migrations/0002.sql'), 3)] },
  { id: 'rg-subagent', hook: 'rg', steps: [{ ...write(R('src/a.ts'), 20), agent: 'agent-1' }] },
  { id: 'rg-not-interactive', hook: 'rg', steps: [{ ...write(R('src/a.ts'), 20), sid: SID_OTHER }] },
  { id: 'rg-self-path', hook: 'rg', steps: [write(path.join(CLAUDE_DIR, 'hooks', 'x.mjs'), 20)] },
  { id: 'rg-lane-missing-cursor', hook: 'rg', env: { ROUTE_GATE_CURSOR_BIN: path.join(MISSING, 'cursor-agent') }, steps: [write(R('src/a.ts'), 20)] },
  { id: 'rg-lane-missing-script', hook: 'rg', env: { ROUTE_GATE_LANE_SCRIPT: path.join(MISSING, 'composer-run.mjs') }, steps: [write(R('src/a.ts'), 20)] },
  { id: 'rg-nested-new-dir', hook: 'rg', steps: [write(R('src/new/deeper/x.ts'), 20)] },

  // ---- errand-router, both profiles (owner: Jev answers explore at 0.92 unless the case says otherwise)
  { id: 'er-bash-streak', hook: 'er', steps: run(6) },
  { id: 'er-read-streak', hook: 'er', steps: ['a', 'b', 'c', 'd', 'many', 'a'].map(f => read(R(`src/${f}.ts`))) },
  { id: 'er-task-output', hook: 'er', steps: [...run(2), read(R('tasks/abc.output')), bash(`tail -n 20 ${R('tasks/abc.output')}`)] },
  { id: 'er-git-commit', hook: 'er', steps: [...run(2), bash('git commit -m wip'), bash(ERRANDS[0])] },
  { id: 'er-redirect', hook: 'er', steps: [...run(2), bash(`grep -n foo ${R('src')} > ${R('out.txt')}`), bash(ERRANDS[0])] },
  { id: 'er-task-notification', hook: 'er', steps: [
    { ...bash(ERRANDS[0]), transcript: [T.prompt('go'), T.use('n1', 'Bash')] },
    { ...bash(ERRANDS[1]), transcript: [T.prompt('go'), T.use('n1', 'Bash'), T.result('n1'), T.use('n2', 'Bash')] },
    { ...bash(ERRANDS[2]), transcript: [T.prompt('go'), T.use('n1', 'Bash'), T.result('n1'), T.use('n2', 'Bash'), T.result('n2'), T.use('A2', 'Agent'), T.note('A2'), T.use('n3', 'Bash')] },
    { ...bash(ERRANDS[3]), transcript: [T.prompt('go'), T.use('n1', 'Bash'), T.result('n1'), T.use('n2', 'Bash'), T.result('n2'), T.use('A2', 'Agent'), T.note('A2'), T.use('n3', 'Bash'), T.result('n3'), T.use('n4', 'Bash')] },
    { ...bash(ERRANDS[4]), transcript: [T.prompt('go'), T.use('n1', 'Bash'), T.result('n1'), T.use('n2', 'Bash'), T.result('n2'), T.use('A2', 'Agent'), T.note('A2'), T.use('n3', 'Bash'), T.result('n3'), T.use('n4', 'Bash'), T.result('n4'), T.use('n5', 'Bash')] },
  ], ids: ['n1', 'n2', 'n3', 'n4', 'n5'] },
  { id: 'er-verify-window', hook: 'er', steps: [
    { ...bash(ERRANDS[0]), transcript: [T.prompt('go'), T.use('v1', 'Bash')] },
    { ...bash(ERRANDS[1]), transcript: [T.prompt('go'), T.use('v1', 'Bash'), T.result('v1'), T.use('v2', 'Bash')] },
    { ...bash(ERRANDS[2]), transcript: [T.prompt('go'), T.use('v1', 'Bash'), T.result('v1'), T.use('v2', 'Bash'), T.result('v2'), T.use('A1', 'Agent'), T.result('A1'), T.use('v3', 'Bash')] },
    { ...bash(ERRANDS[3]), transcript: [T.prompt('go'), T.use('v1', 'Bash'), T.result('v1'), T.use('v2', 'Bash'), T.result('v2'), T.use('A1', 'Agent'), T.result('A1'), T.use('v3', 'Bash'), T.result('v3'), T.use('v4', 'Bash')] },
    { ...bash(ERRANDS[4]), transcript: [T.prompt('go'), T.use('v1', 'Bash'), T.result('v1'), T.use('v2', 'Bash'), T.result('v2'), T.use('A1', 'Agent'), T.result('A1'), T.use('v3', 'Bash'), T.result('v3'), T.use('v4', 'Bash'), T.result('v4'), T.use('v5', 'Bash')] },
    { ...bash(ERRANDS[5]), transcript: [T.prompt('go'), T.use('v1', 'Bash'), T.result('v1'), T.use('v2', 'Bash'), T.result('v2'), T.use('A1', 'Agent'), T.result('A1'), T.use('v3', 'Bash'), T.result('v3'), T.use('v4', 'Bash'), T.result('v4'), T.use('v5', 'Bash'), T.result('v5'), T.prompt('next question'), T.use('v6', 'Bash')] },
  ], ids: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'] },
  { id: 'er-subagent', hook: 'er', steps: run(3).map(s => ({ ...s, agent: 'agent-1' })) },
  { id: 'er-off', hook: 'er', env: { ERRAND_ROUTER: 'off' }, steps: run(3) },
  { id: 'er-block-streak5', hook: 'er', env: { ERRAND_ROUTER: 'block' }, steps: run(5) },

  // ---- errand-router, default profile only: the holdout switch, read from the `arm` field of every record
  { id: 'er-holdout-1', hook: 'er', profiles: ['default'], env: { ERRAND_ROUTER_HOLDOUT: '1' }, steps: run(2).map(s => ({ ...s, sid: SID_CONTROL })) },
  { id: 'er-holdout-0', hook: 'er', profiles: ['default'], env: { ERRAND_ROUTER_HOLDOUT: '0' }, steps: run(2).map(s => ({ ...s, sid: SID_CONTROL })) },
  { id: 'er-holdout-unset', hook: 'er', profiles: ['default'], steps: run(2).map(s => ({ ...s, sid: SID_CONTROL })) },
  // The original counts the owner's ssh host as an errand whether or not Jev is on; the plugin does only in Jev mode.
  { id: 'er-ssh-host', hook: 'er', profiles: ['default'], steps: [...run(2), bash('ssh ' + SSH_HOST + ' "cat ~/app/log.txt"')] },

  // ---- errand-router, owner profile only: the Jev path
  { id: 'jev-explore-092', hook: 'er', profiles: ['owner'], jev: JEV.explore92, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'warn', contains: 'to Explore in one call' } } } },
  { id: 'jev-explore-079', hook: 'er', profiles: ['owner'], jev: JEV.explore79, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-main', hook: 'er', profiles: ['owner'], jev: JEV.main, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-none', hook: 'er', profiles: ['owner'], jev: JEV.none, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-http500', hook: 'er', profiles: ['owner'], jev: JEV.http500, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-bad-body', hook: 'er', profiles: ['owner'], jev: JEV.badBody, steps: run(3), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-block-other-lane', hook: 'er', profiles: ['owner'], env: { ERRAND_ROUTER: 'block' }, jev: JEV.otherLane92, steps: run(5),
    expect: { calls: 3, steps: { 3: { decision: 'warn', contains: OTHER_LANE }, 5: { decision: 'deny', contains: OTHER_LANE } } } },
  { id: 'jev-holdout-split', hook: 'er', profiles: ['owner'], jev: JEV.explore92,
    steps: [...run(3).map(s => ({ ...s, sid: SID_NUDGE })), ...run(3).map(s => ({ ...s, sid: SID_CONTROL }))],
    expect: { calls: 2, steps: { 3: { decision: 'warn', contains: 'Explore' }, 6: { decision: 'silent' } } } },
  { id: 'jev-holdout-1', hook: 'er', profiles: ['owner'], env: { ERRAND_ROUTER_HOLDOUT: '1' }, jev: JEV.explore92, steps: run(3).map(s => ({ ...s, sid: SID_CONTROL })), expect: { calls: 1, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-holdout-0', hook: 'er', profiles: ['owner'], env: { ERRAND_ROUTER_HOLDOUT: '0' }, jev: JEV.explore92, steps: run(3).map(s => ({ ...s, sid: SID_CONTROL })), expect: { calls: 1, steps: { 3: { decision: 'warn', contains: 'Explore' } } } },
  { id: 'jev-live-run', hook: 'er', profiles: ['owner'], jev: JEV.explore92, steps: [...run(2), bash('ssh ' + SSH_HOST + ' "node ' + LIVE_WORD + '.mjs"')], expect: { calls: 0, steps: { 3: { decision: 'silent' } } } },
  { id: 'jev-ssh-errand', hook: 'er', profiles: ['owner'], jev: JEV.explore92, steps: [...run(2), bash('ssh ' + SSH_HOST + ' "cat ~/app/log.txt"')], expect: { calls: 1, steps: { 3: { decision: 'warn', contains: 'Explore' } } } },
];

// ---------------------------------------------------------------- plugin-only checks (NEW hook alone, profile 'plugin')

// Criteria keys of every stub request, each sorted and joined. The body is { model, state, questions: { voie: { type, instructions, criteria } } }.
const critKeys = steps => steps.flatMap(s => s.bodies).map(b => Object.keys(b.body?.questions?.voie?.criteria || {}).sort().join(','));
const sentKeys = (steps, want) => { const k = critKeys(steps); return k.length === 1 && k[0] === [...want].sort().join(','); };

const PLUGIN_CHECKS = [
  { id: 'po-config-owner', hook: 'er', what: 'ERRAND_ROUTER_CONFIG names the owner file: request criteria are the owner lanes + none',
    env: { ERRAND_ROUTER_CONFIG: OWNER_CFG_FILE }, steps: run(3),
    check: s => sentKeys(s, [...OWNER_LANES, 'none']) },
];

// ---------------------------------------------------------------- one child run

function childEnv(sb, profile, extra) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: HOME_DIR,
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    HARNESS_DATA_DIR: sb.data,
    ROUTING_LEDGER: sb.routing,
    ROUTE_GATE_STATE: sb.rgState,
    ROUTE_GATE_CONFIG: CONFIG_COPY,
    ROUTE_GATE_LANE_SCRIPT: LANE_SCRIPT,
    ROUTE_GATE_CURSOR_BIN: CURSOR_BIN,
    ERRAND_ROUTER_LEDGER: sb.errand,
    ERRAND_ROUTER_STATE_DIR: sb.erState,
    COMPOSER_LANE_LOG: sb.composerLog,
    JEV_ENV_FILE: NO_KEY_FILE,
    JEV_URL: STUB_URL,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  // 'plugin' is the PLUGIN-ONLY section: Jev mode on with the dummy key, route-gate prefix left at its default.
  if (profile === 'owner' || profile === 'plugin') { env.ERRAND_ROUTER_JEV = '1'; env.TYPESAFE_AI_JEV_API_KEY = DUMMY_KEY; }
  // The owner's own environment sets the prefix to empty, so route-gate prints ai-coder like the original (which ignores this variable).
  if (profile === 'owner') env.ROUTE_GATE_AGENT_PREFIX = '';
  // The owner profile names the owner config, as the owner's environment does.
  if (profile === 'owner') env.ERRAND_ROUTER_CONFIG = OWNER_CFG_FILE;
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

async function runSide(side, c, profile) {
  const sb = {};
  const root = path.join(TMP, 'runs', profile, c.id, side);
  Object.assign(sb, {
    data: path.join(root, 'data'),
    routing: path.join(root, 'routing.jsonl'),
    rgState: path.join(root, 'route-gate-state.json'),
    errand: path.join(root, 'errand-router.jsonl'),
    erState: path.join(root, 'errand-state'),
    composerLog: path.join(root, 'runs.jsonl'),
  });
  mkdirSync(root, { recursive: true });
  const ledgerFile = c.hook === 'rg' ? sb.routing : sb.errand;
  const transcript = path.join(TRANSCRIPTS, `${profile}-${c.id}.jsonl`);
  const out = [];
  let seen = 0;
  for (let i = 0; i < c.steps.length; i++) {
    const st = c.steps[i];
    const id = c.ids ? c.ids[i] : `toolu_${c.id}_${i + 1}`;
    if (st.transcript) writeFileSync(transcript, st.transcript.map(x => JSON.stringify(x)).join('\n') + '\n');
    const inp = c.hook === 'rg'
      ? { session_id: st.sid || SID_RG, prompt_id: st.prompt || `p-${c.id}`, cwd: REPO, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input, tool_use_id: id }
      : { session_id: st.sid || SID_NUDGE, cwd: REPO, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input, tool_use_id: id };
    if (st.agent) inp.agent_id = st.agent;
    if (c.hook === 'er' && st.transcript) inp.transcript_path = transcript;
    stub.response = c.jev || JEV.explore92;
    stub.bodies = [];
    const env = childEnv(sb, profile, { ...(c.env || {}), ...(st.env || {}) });
    const t0 = Date.now();
    const r = await runNode(c.hook === 'rg' ? (side === 'old' ? OLD.rg : NEW.rg) : (side === 'old' ? OLD.er : NEW.er), JSON.stringify(inp), env, REPO);
    const ms = Date.now() - t0;
    const all = readLedger(ledgerFile);
    const recs = all.slice(seen);
    seen = all.length;
    out.push({ rc: r.rc, ms, decision: decisionOf(r.out), ledger: recs, bodies: stub.bodies });
  }
  return out;
}

// ---------------------------------------------------------------- comparison

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function ledgerView(rec) {
  const o = {};
  for (const k of Object.keys(rec).sort()) {
    const v = rec[k];
    if (k === 'ts' || k.endsWith('_id')) o[k] = '<skip>';
    else if (typeof v === 'string' && (TS_RE.test(v) || v.startsWith(TMP))) o[k] = '<skip>';
    else if (k === 'jev_ms') o[k] = v === null ? null : typeof v; // a duration: only its presence is compared
    else o[k] = v;
  }
  return o;
}
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const summary = d => d.kind === 'silent' ? 'silent' : `${d.kind}:${d.text.slice(0, 40)}`;
const shape = recs => recs.length ? recs.map(r => r.action || `${r.verdict}/${r.why}`).join(',') : '-';
const cell = (s, n) => s ? `s${n} ${summary(s.decision)} rc${s.rc} [${shape(s.ledger)}]` : `s${n} (no step)`;

function stepEqual(o, n) {
  return o.rc === n.rc
    && o.decision.kind === n.decision.kind && o.decision.text === n.decision.text && o.decision.event === n.decision.event
    && same(o.ledger.map(ledgerView), n.ledger.map(ledgerView))
    && same(o.bodies.map(b => b.body), n.bodies.map(b => b.body));
}

// kind 'agent-prefix': the ONLY change is the plugin's ech:ai-coder(-high) renamed to ai-coder(-high), applied to the NEW
// decision text and the NEW ledger `target` field, here and nowhere else.
const unprefix = s => typeof s === 'string' ? s.replaceAll('ech:ai-coder', 'ai-coder') : s;
const agentUnprefixed = s => ({
  ...s,
  decision: { ...s.decision, text: unprefix(s.decision.text) },
  ledger: s.ledger.map(r => 'target' in r ? { ...r, target: unprefix(r.target) } : r),
});

// The allowlist entry that covers this DIFF case, or null. A scoped rule must make EVERY step equal.
function allowedBy(c, profile, o, n) {
  for (const a of ALLOW) {
    if (a.profile !== profile) continue;
    if (a.id) { if (a.id === c.id) return a; continue; }
    if (a.scope !== c.hook) continue;
    if (a.kind === 'agent-prefix' && c.steps.every((_, i) => stepEqual(o[i], agentUnprefixed(n[i])))) return a;
  }
  return null;
}

function checkExpect(c, side, steps) {
  const bad = [];
  const ex = c.expect;
  if (!ex) return bad;
  const calls = steps.reduce((s, x) => s + x.bodies.length, 0);
  if (ex.calls !== undefined && calls !== ex.calls) bad.push(`${side} calls ${calls}!=${ex.calls}`);
  for (const [k, want] of Object.entries(ex.steps || {})) {
    const s = steps[Number(k) - 1];
    if (!s || s.decision.kind !== want.decision || (want.contains && !s.decision.text.includes(want.contains))) bad.push(`${side} s${k} not ${want.decision}`);
  }
  return bad;
}

// ---------------------------------------------------------------- main

const rows = [];
const counts = { MATCH: 0, DIFF: 0, ALLOWED: 0, FAIL: 0 };
const calls = { default: 0, owner: 0 };
const usedAllow = new Set();
const allowReasons = new Set();
const pluginRows = [];
let exit = 0;
try {
  buildFixtures();
  for (const profile of profiles) {
    for (const c of CASES) {
      if (!(c.profiles || BOTH).includes(profile)) continue;
      const o = await runSide('old', c, profile);
      const n = await runSide('new', c, profile);
      const problems = [];
      for (const [side, steps] of [['old', o], ['new', n]]) {
        const nCalls = steps.reduce((s, x) => s + x.bodies.length, 0);
        calls[profile] += nCalls;
        if (profile === 'default' && nCalls) problems.push(`${side} called Jev ${nCalls}x`);
        if (steps.some(x => x.bodies.some(b => b.hasKey))) problems.push(`${side} sent the key in a body`);
        if (profile === 'owner') problems.push(...checkExpect(c, side, steps));
      }
      let first = -1;
      for (let i = 0; i < c.steps.length; i++) if (!stepEqual(o[i], n[i])) { first = i; break; }
      const at = first >= 0 ? first : c.steps.length - 1;
      let status, rule = null;
      if (problems.length) status = `FAIL(${problems.join('; ')})`;
      else if (first < 0) status = 'MATCH';
      else if (profile === 'default' && (rule = allowedBy(c, profile, o, n))) { status = 'ALLOWED'; usedAllow.add(rule); allowReasons.add(rule.reason); }
      else status = 'DIFF';
      counts[status.startsWith('FAIL') ? 'FAIL' : status]++;
      rows.push([c.id, profile, cell(o[at], at + 1), cell(n[at], at + 1), status]);
    }
  }
  for (const pc of PLUGIN_CHECKS) {
    const steps = await runSide('new', pc, 'plugin');
    let ok = false;
    try { ok = !steps.some(x => x.bodies.some(b => b.hasKey)) && await pc.check(steps, pc); } catch { ok = false; }
    pluginRows.push(`${ok ? 'PASS' : 'FAIL'} ${pc.id} — ${pc.what}`);
  }
} catch (e) {
  process.stderr.write(`harness error: ${e && e.stack || e}\n`);
  exit = 1;
}

const ledgerReport = REAL_LEDGERS.map((f, i) => {
  const d = ledgerDelta(ledgerBefore[i], readText(f));
  return { f, ...d, ...splitOwnLines(d.added, { syntheticSids: SYNTHETIC_SIDS, cwdPrefix: TMP }) };
});
const leaked = ledgerReport.filter(r => r.own.length);

const head = ['case', 'profile', 'old', 'new', 'MATCH|DIFF'];
const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
const line = r => '| ' + r.map((x, i) => String(x).padEnd(w[i])).join(' | ') + ' |';
const outLines = [line(head), '|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|', ...rows.map(line)];
outLines.push('');
outLines.push(`MATCH ${counts.MATCH} · DIFF ${counts.DIFF} · ALLOWED ${counts.ALLOWED} · FAIL ${counts.FAIL} · cases ${rows.length}`);
outLines.push(`Jev stub requests: default ${calls.default} (must be 0) · owner ${calls.owner}`);
if (allowReasons.size) {
  outLines.push('ALLOWED because:');
  for (const r of allowReasons) outLines.push(`  - ${r}`);
}
const unused = ALLOW.filter(a => profiles.includes(a.profile) && !usedAllow.has(a)).map(allowName);
if (unused.length) outLines.push(`unused allowlist entries: ${unused.join(', ')}`);
outLines.push('');
outLines.push('PLUGIN-ONLY (NEW hooks alone, Jev mode with the dummy key and the stub; not parity)');
outLines.push(...pluginRows);
const pluginFail = pluginRows.filter(r => !r.startsWith('PASS')).length + (pluginRows.length < PLUGIN_CHECKS.length ? 1 : 0);
if (pluginRows.length < PLUGIN_CHECKS.length) outLines.push(`FAIL ${PLUGIN_CHECKS.length - pluginRows.length} plugin check(s) did not run`);
const sidsOf = list => {
  const c = new Map();
  for (const x of list) { const k = String(x.sid).slice(0, 8); c.set(k, (c.get(k) || 0) + 1); }
  return [...c].map(([k, n]) => k + ' x' + n).join(' ');
};
for (const r of ledgerReport) {
  const name = '~/' + path.relative(REAL_HOME, r.f);
  if (r.kind === 'rewritten') outLines.push('REAL LEDGER info: ' + name + ' was rewritten by another process during the run (the test never rewrites it)');
  if (r.foreign.length) outLines.push('REAL LEDGER info: ' + name + ' gained ' + r.foreign.length + ' line(s) from other sessions during the run: ' + sidsOf(r.foreign));
  if (r.own.length) outLines.push('REAL LEDGER LEAK: ' + name + ' gained ' + r.own.length + " line(s) with the test's session ids or temp path: " + sidsOf(r.own));
}

if (counts.DIFF || counts.FAIL || pluginFail || leaked.length) exit = 1;
try { server.closeAllConnections?.(); server.close(); } catch {}
if (!KEEP) { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
// A pipe is asynchronous on macOS: exit only once the table is flushed.
process.stdout.write(outLines.join('\n') + '\n', () => process.exit(exit));
