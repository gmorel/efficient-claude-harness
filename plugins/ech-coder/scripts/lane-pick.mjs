#!/usr/bin/env node
// Asks Jev which coder lane should run a code change: average (Cursor Composer) or high (the delegation service).
// The front agent `ai-coder` runs this, then follows the Run steps of agents/ai-coder-<lane>.md itself.
//
// Usage: node lane-pick.mjs [--brief <file>] [--files a.ts,b.ts] [--repo <root>] [--lines <planned change lines>]
// Prints exactly one JSON line {lane, source, reason, confidence} and always exits 0.
// Jev decides; every failure picks "high" (the safe lane) with source "fallback" and the reason named.
//
// Jev receives metadata only, through redactDeep: extensions, repo-relative paths, line counts, file count, guarded flag.
// The brief is read only to count its lines and, when --files is absent, to find the repo files it names; its text never leaves the machine.
// Switch: AI_CODER_JEV=1 turns Jev on, AI_CODER_JEV=0 turns it off, unset follows ROUTE_GATE_JEV.
// Off, or no key: no network call, and jev-client.mjs is not loaded.
// ROUTE_GATE_JEV_MIN_CONF (default 0.80) and ROUTE_GATE_JEV_TIMEOUT_MS (default 1500) bound the answer and the call.
// Every decision appends one line to <data>/ai-coder-lane.jsonl, without brief text, paths or key.
// <data> is HARNESS_DATA_DIR, else CLAUDE_PLUGIN_DATA, else ~/.claude/harness-data.

import { appendFileSync, mkdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouteGateJevMinConf } from '../hooks/lib/route-gate-jev.mjs';

const LANES = new Set(['average', 'high']);
const MAX_PATHS = 40;
const MAX_READ = 2 * 1024 * 1024;

// Same patterns as GUARDED and GUARDED_WORD in hooks/route-gate.mjs; a test keeps the two identical.
const GUARDED = /(^|\/)(migrations?|drizzle|prisma\/migrations|alembic|db\/migrate|\.github\/workflows|\.gitlab-ci|\.circleci|\.git\/hooks|\.githooks|\.husky)\/|(^|\/)\.env(\.|$)|(^|\/)\.gitlab-ci\.yml$/i;
const GUARDED_WORD = /(^|\/)[^/]*(auth|payment|billing)[^/]*(\/|\.[a-z0-9]+$)/i;

const TASK = 'A developer assistant has a code change to hand to a coder lane. Pick the lane that should run it.';
const HOW = 'average runs Cursor Composer in place on the repository, for ordinary code changes. high sends the job to a stronger remote model at high effort with a written plan first, for guarded paths (auth, payments, billing, migrations, CI, git hooks, secrets), wide cross-cutting changes, or any change where being wrong is expensive. When unsure, pick high.';
const CRITERIA = {
  average: { option: 'Standard lane: Composer in place, for an ordinary code change.' },
  high: { option: 'Guarded lane: remote strong model, plan first, for risky or guarded changes.' },
};

export function dataDir(env = process.env) {
  return env.HARNESS_DATA_DIR || env.CLAUDE_PLUGIN_DATA || path.join(homedir(), '.claude', 'harness-data');
}

export function jevEnabled(env = process.env) {
  const v = env.AI_CODER_JEV;
  if (v === '1') return true;
  if (v !== undefined && v !== '') return false;
  return env.ROUTE_GATE_JEV === '1';
}

export function isGuarded(rel) {
  return GUARDED.test(rel) || GUARDED_WORD.test(rel);
}

function parseArgs(argv) {
  const a = { brief: null, files: null, repo: null, lines: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (!['--brief', '--files', '--repo', '--lines'].includes(k) || v === undefined) return null;
    a[k.slice(2)] = v;
    i++;
  }
  return a;
}

function lineCount(s) { return s ? (s.match(/\n/g) || []).length + (s.endsWith('\n') ? 0 : 1) : 0; }

function repoRoot(repo) {
  const dir = repo || process.cwd();
  const g = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 });
  return g.status === 0 ? g.stdout.trim() : path.resolve(dir);
}

// Resolves symlinks of the deepest existing ancestor, so /var and /private/var (or a mounted volume) compare equal.
function real(p) {
  let dir = p;
  while (dir !== path.dirname(dir)) {
    if (existsSync(dir)) {
      try { return path.join(realpathSync.native(dir), path.relative(dir, p)); } catch { return p; }
    }
    dir = path.dirname(dir);
  }
  return p;
}

// Repo-relative path, or null when the path is outside the repo root.
function inside(root, p) {
  const rel = path.relative(real(root), real(path.resolve(root, p)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Outside the repo only the basename is sent, as route-gate does.
function relPath(root, p) { return inside(root, p) ?? path.basename(p); }

function fileLines(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return lineCount(readFileSync(abs, 'utf8'));
  } catch { return 0; }
}

// Path-looking tokens of the brief that are real files under the repo root; nothing else of the brief is kept.
function pathsFromBrief(text, root) {
  const out = new Set();
  for (const tok of text.match(/[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+/g) || []) {
    const rel = inside(root, tok);
    if (!rel) continue;
    try { if (statSync(path.join(root, rel)).isFile()) out.add(rel); } catch {}
    if (out.size >= MAX_PATHS) break;
  }
  return [...out];
}

export function buildState({ brief, files, repo, lines }) {
  const root = repoRoot(repo);
  let briefText = null;
  if (brief) { try { briefText = readFileSync(brief, 'utf8'); } catch {} }
  let rels = files
    ? files.split(',').map(s => s.trim()).filter(Boolean).map(p => relPath(root, p))
    : briefText ? pathsFromBrief(briefText, root) : [];
  rels = [...new Set(rels)].slice(0, MAX_PATHS);
  const perFile = rels.map(rel => ({ path: rel, ext: path.extname(rel).toLowerCase(), lines: fileLines(path.join(root, rel)) }));
  const guardedCount = perFile.filter(f => isGuarded(f.path)).length;
  const planned = Number(lines);
  return {
    files: perFile,
    exts: [...new Set(perFile.map(f => f.ext).filter(Boolean))],
    file_count: perFile.length,
    total_lines: perFile.reduce((s, f) => s + (f.lines || 0), 0),
    planned_lines: Number.isFinite(planned) && planned >= 0 ? planned : null,
    brief_lines: briefText === null ? null : lineCount(briefText),
    guarded: guardedCount > 0,
    guarded_files: guardedCount,
  };
}

// Wraps fetch so a null from jevChoose can be told apart: timeout, network, HTTP status, or a bad body.
function probedFetch(probe) {
  return async (url, opts) => {
    const fail = e => { probe.error = opts?.signal?.aborted ? 'timeout' : 'network'; throw e; };
    let r;
    try { r = await globalThis.fetch(url, opts); } catch (e) { fail(e); }
    probe.status = r.status;
    return { status: r.status, text: () => r.text().catch(fail) };
  };
}

function failureReason(probe) {
  if (probe.error) return probe.error;
  if (probe.status !== null && (probe.status < 200 || probe.status >= 300)) return `http_${probe.status}`;
  return 'malformed';
}

export function decide(jev, minConf) {
  if (!LANES.has(jev.choice)) return { lane: 'high', source: 'fallback', reason: 'off_menu', confidence: jev.confidence };
  if (typeof jev.confidence !== 'number' || jev.confidence < minConf) return { lane: 'high', source: 'fallback', reason: 'low_confidence', confidence: jev.confidence };
  return { lane: jev.choice, source: 'jev', reason: 'jev', confidence: jev.confidence };
}

export async function pickLane(args, env = process.env) {
  const minConf = parseRouteGateJevMinConf();
  const timeoutMs = Number(env.ROUTE_GATE_JEV_TIMEOUT_MS) || 1500;
  let state = null;
  let jev = null;
  let result;
  try {
    state = buildState(args);
    if (!jevEnabled(env)) result = { lane: 'high', source: 'fallback', reason: 'jev_off', confidence: null };
    else {
      const { loadKey, jevChoose, redactDeep } = await import('../hooks/lib/jev-client.mjs');
      if (!loadKey()) result = { lane: 'high', source: 'fallback', reason: 'no_key', confidence: null };
      else {
        const probe = { status: null, error: null };
        jev = await jevChoose({ state: redactDeep(state), name: 'lane', task: TASK, how: HOW, criteria: { ...CRITERIA }, timeoutMs, fetchImpl: probedFetch(probe) });
        result = jev ? decide(jev, minConf) : { lane: 'high', source: 'fallback', reason: failureReason(probe), confidence: null };
      }
    }
  } catch {
    result = { lane: 'high', source: 'fallback', reason: 'error', confidence: null };
  }
  return { result, state, jev, minConf };
}

function writeLedger({ result, state, jev, minConf }, env = process.env) {
  try {
    const file = path.join(dataDir(env), 'ai-coder-lane.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      kind: 'lane',
      ts: new Date().toISOString(),
      ...result,
      jev_choice: jev?.choice ?? null,
      jev_ms: jev?.ms ?? null,
      min_conf: minConf,
      file_count: state?.file_count ?? null,
      total_lines: state?.total_lines ?? null,
      planned_lines: state?.planned_lines ?? null,
      exts: state?.exts ?? null,
      guarded: state?.guarded ?? null,
    }) + '\n', 'utf8');
  } catch {}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let decision;
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--help')) {
      process.stderr.write('usage: lane-pick.mjs [--brief <file>] [--files a,b] [--repo <root>] [--lines <n>]\n');
      process.exit(0);
    }
    const args = parseArgs(argv);
    decision = args ? await pickLane(args) : { result: { lane: 'high', source: 'fallback', reason: 'bad_args', confidence: null }, state: null, jev: null, minConf: null };
  } catch {
    decision = { result: { lane: 'high', source: 'fallback', reason: 'error', confidence: null }, state: null, jev: null, minConf: null };
  }
  writeLedger(decision);
  process.stdout.write(JSON.stringify(decision.result) + '\n');
  process.exit(0);
}
