#!/usr/bin/env node
// UserPromptSubmit hook: nudge a long main session towards a fresh start (token-burn H1).
//
// Every main turn re-reads the whole context; past ~200k that re-read is most of the turn's cost.
// On each user prompt this reads the LAST main-thread assistant `usage` from the tail of the transcript
// (seeking from the end: transcripts reach 700 MB) and, above the limit, adds context asking Claude to
// finish the step, save with your notes-saving routine, and tell the user to start a fresh session.
// Fires at most once per SESSION_SIZE_STEP of growth; a compaction (context falls back) re-arms it.
//
// Switches: SESSION_SIZE=warn (default) | off, or create <data>/session-size.off.
// A user prompt is never refused, so there is no block mode: `block` behaves like `warn`.
// SESSION_SIZE_LIMIT (default 200000), SESSION_SIZE_STEP (default 50000).
// Ledger: <data>/session-size.jsonl, one line per main-thread prompt.
// Fails open: any crash exits 0 and prints nothing.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, fstatSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

// Runtime data lives outside the plugin: HARNESS_DATA_DIR, else CLAUDE_PLUGIN_DATA (exported to plugin hooks), else ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), '.claude', 'harness-data');
const LEDGER = process.env.SESSION_SIZE_LEDGER || path.join(DATA_DIR, 'session-size.jsonl');
const STATE_DIR = process.env.SESSION_SIZE_STATE_DIR || path.join(DATA_DIR, 'session-size-state');
const OFF_FILE = path.join(DATA_DIR, 'session-size.off');
const LIMIT = Number(process.env.SESSION_SIZE_LIMIT) || 200000; // lower to 150000 only together with autoCompactWindow 250000 (compacts at 217k)
const STEP = Number(process.env.SESSION_SIZE_STEP) || 50000;
const CHUNK = 256 * 1024;
const MAX_SCAN = 64 * 1024 * 1024; // give up (silently) past this much tail without a usage line

const sha = s => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 12);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function mode() {
  if (existsSync(OFF_FILE)) return 'off';
  return process.env.SESSION_SIZE === 'off' ? 'off' : 'warn';
}

function log(rec) {
  try {
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch {}
}

// Returns {context, source} for the newest main-thread line that says how big the context is:
// an assistant `usage` (input + cache_creation + cache_read) or a compact_boundary (postTokens).
// Returns null when nothing is found within MAX_SCAN bytes of the end.
export function lastContext(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < MAX_SCAN) {
      const n = Math.min(CHUNK, pos);
      pos -= n;
      scanned += n;
      const chunk = Buffer.alloc(n);
      readSync(fd, chunk, 0, n, pos);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const hit = parseLine(buf, i + 1, end);
        if (hit) return hit;
        end = i;
      }
      carry = buf.subarray(0, end); // first line is partial unless we reached the file start
    }
    if (pos === 0 && carry.length) return parseLine(carry, 0, carry.length);
    return null;
  } catch { return null; } finally { try { if (fd !== undefined) closeSync(fd); } catch {} }
}

function parseLine(buf, start, end) {
  if (end <= start) return null;
  const line = buf.toString('utf8', start, end);
  const isCompact = line.includes('"compact_boundary"');
  if (!isCompact && !line.includes('"usage"')) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.isSidechain === true) return null;
  if (isCompact && d.type === 'system' && d.subtype === 'compact_boundary') {
    const post = Number(d.compactMetadata?.postTokens);
    return { context: Number.isFinite(post) ? post : 0, source: 'compact' };
  }
  const u = d.type === 'assistant' && d.message?.usage;
  if (!u) return null;
  const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return ctx > 0 ? { context: ctx, source: 'usage' } : null; // <synthetic> messages carry zeros
}

const stateFile = sid => path.join(STATE_DIR, sha(sid) + '.json');

function loadState(sid) {
  try { return JSON.parse(readFileSync(stateFile(sid), 'utf8')); } catch { return {}; }
}

function saveState(sid, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const f = stateFile(sid);
    writeFileSync(f + '.tmp', JSON.stringify(state));
    renameSync(f + '.tmp', f);
  } catch {}
}

// Measurement only (no behaviour change yet): was this prompt typed by the user or sent by a machine
// (a subagent hand-back, another session, a task notification)? Only the kind is logged, never the text.
const MACHINE = /^\s*(Another Claude session sent a message|<task-notification|<cross-session-message|<agent-message|\[Subagent hand-back\])/;
export function promptKind(prompt) {
  if (typeof prompt !== 'string') return 'missing';
  return MACHINE.test(prompt.slice(0, 300)) ? 'machine' : 'user';
}

// Pure decision, exported for the tests.
export function decide(context, state) {
  let firedAt = state.firedAt ?? null;
  if (firedAt !== null && context < firedAt - STEP) firedAt = null; // compacted since: re-arm
  if (context < LIMIT) return { fire: false, firedAt };
  if (firedAt !== null && context < firedAt + STEP) return { fire: false, firedAt };
  return { fire: true, firedAt: context };
}

function nudge(context) {
  const k = Math.round(context / 1000);
  return [
    `SESSION SIZE (information only): this main session's context is ${k}k tokens. The user sees this number and decides when to start a fresh session.`,
    'Do the user\'s request in full, as usual. Do not refuse, shrink, postpone or redirect any work because of session size, do not tell the user to start a fresh session, and do not create handoff commands for it. Do not mention session size in your reply unless the user asks.',
  ].join('\n');
}

// Sessions nudged before 2026-10-02 hold the old commanding text ("finish the step, start no new one,
// tell the user to start a fresh session") in their context. On their next prompt, withdraw it once.
export const WITHDRAW = 'SESSION SIZE UPDATE (2026-10-02): the earlier SESSION SIZE instructions in this conversation are withdrawn: finish the step and start no new one, run your notes-saving routine, tell the user to start a fresh session or to type a /continue-... command. Ignore all of them. Do the user\'s requests in full, here, as usual. Do not refuse, shrink or postpone work because of session size, and do not mention it.';
export function needsWithdraw(state) {
  return state.firedAt != null && state.v !== 2 && !state.withdrawn;
}

async function main() {
  const t0 = process.hrtime.bigint();
  if (mode() === 'off') return;
  const inp = await readStdin();
  if (!inp || inp.agent_id || !inp.transcript_path) return;
  const sid = inp.session_id || inp.transcript_path;
  const last = lastContext(inp.transcript_path);
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  if (!last) { log({ session: sid, context: null, fired: false, reason: 'no-usage', prompt_kind: promptKind(inp.prompt), jev: null, ms: ms() }); return; }
  const state = loadState(sid);
  const d = decide(last.context, state);
  const withdraw = needsWithdraw(state);
  const next = { ...state, firedAt: d.firedAt };
  if (withdraw) next.withdrawn = true;
  if (d.fire) next.v = 2;
  if (JSON.stringify(next) !== JSON.stringify(state)) saveState(sid, next);
  log({ session: sid, cwd: inp.cwd, context: last.context, source: last.source, limit: LIMIT, fired: d.fire, withdrawn: withdraw, prompt_kind: promptKind(inp.prompt), jev: null, ms: Math.round(ms() * 10) / 10 });
  if (!d.fire && !withdraw) return;
  const ctx = [withdraw ? WITHDRAW : null, d.fire ? nudge(last.context) : null].filter(Boolean).join('\n');
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } };
  // systemMessage is shown to the user in the app; the withdrawal stays silent.
  if (d.fire) out.systemMessage = `Session size: ${Math.round(last.context / 1000)}k tokens (limit ${Math.round(LIMIT / 1000)}k). A fresh session would be cheaper; your call.`;
  process.stdout.write(JSON.stringify(out));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {}).finally(() => process.exit(0));
}
