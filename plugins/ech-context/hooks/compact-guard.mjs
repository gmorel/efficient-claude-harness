#!/usr/bin/env node
// PreCompact + SessionStart(compact) hook: make automatic compactions safe to lower the window (token-burn H1).
//
// An automatic compaction runs with no your notes-saving routine save, and its summary can drop the
// things a lane acts on (HOLD rules, in-flight agents, live-run state). This hook:
// 1. PreCompact, trigger "auto": prints custom instructions (the engine adds hook stdout to the summary
//    prompt) telling the summary what to keep verbatim; a subagent gets its own list. Never blocks.
// 2. PreCompact, any trigger: logs {session, agent_id, trigger, context} to the ledger.
// 3. SessionStart, source "compact", right after an AUTO compaction of this main session: adds a
//    recovery line (re-read the resume note before any push, tag, live run or cross-lane message).
//
// Switches: COMPACT_GUARD=warn (default) | off, or create <data>/compact-guard.off.
// Ledger: <data>/compact.jsonl. Fails open: any crash exits 0 and prints nothing.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lastContext } from './session-size.mjs';

// Runtime data lives outside the plugin: HARNESS_DATA_DIR, else CLAUDE_PLUGIN_DATA (exported to plugin hooks), else ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), '.claude', 'harness-data');
const LEDGER = process.env.COMPACT_GUARD_LEDGER || path.join(DATA_DIR, 'compact.jsonl');
const STATE_DIR = process.env.COMPACT_GUARD_STATE_DIR || path.join(DATA_DIR, 'compact-state');
const OFF_FILE = path.join(DATA_DIR, 'compact-guard.off');
const RECOVERY_WINDOW_MS = 30 * 60 * 1000; // a SessionStart(compact) this soon after an auto PreCompact belongs to it

const sha = s => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 12);

export const MAIN_KEEP = [
  'This is an AUTOMATIC compaction: no 2nd-brain save ran before it. In the summary, keep VERBATIM, under a heading "MUST SURVIVE":',
  '- the path of every resume note / lane note this session reads or writes;',
  '- every HOLD, NO-PUSH, do-not or wait-for rule still in force, and who set it;',
  '- in-flight agents, workflows and background jobs: their IDs and where they write their output;',
  '- the user\'s requests not yet done, in their words;',
  '- any live run on a real portal or account: which account, which step it reached, whether a single-use token or OTP was already spent (never copy a password, token, key or OTP value into the summary);',
  '- files changed and not committed, and the last commit or tag made.',
  'Mark anything you are not sure of as "unverified". Do not describe a save or a check as done unless the transcript shows it done.',
].join('\n');

export const AGENT_KEEP = [
  'This is an AUTOMATIC compaction of a subagent mid-task. In the summary, keep VERBATIM:',
  '- the original brief, in full;',
  '- every file changed, and every evidence reference (file:line, command output) gathered so far;',
  '- what is left to do.',
  'State at the top of the summary: "This run was compacted; findings from before compaction come from the summary, re-check them before reporting them as verified."',
].join('\n');

export const RECOVERY = [
  'COMPACT GUARD: this session was just compacted AUTOMATICALLY, with no 2nd-brain save before it.',
  'Before any push, tag, deploy, live run, or message to another lane: read this lane\'s resume note and re-check the HOLD / NO-PUSH rules in force.',
  'If the summary does not name the resume note or looks thin, run your notes-saving routine and rebuild the open threads from the transcript before continuing.',
].join('\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function mode() {
  if (existsSync(OFF_FILE)) return 'off';
  return process.env.COMPACT_GUARD === 'off' ? 'off' : 'warn';
}

function log(rec) {
  try {
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch {}
}

const stateFile = sid => path.join(STATE_DIR, sha(sid) + '.json');
function loadState(sid) { try { return JSON.parse(readFileSync(stateFile(sid), 'utf8')); } catch { return {}; } }
function saveState(sid, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const f = stateFile(sid);
    writeFileSync(f + '.tmp', JSON.stringify(state));
    renameSync(f + '.tmp', f);
  } catch {}
}

async function main() {
  if (mode() === 'off') return;
  const inp = await readStdin();
  if (!inp) return;
  const sid = inp.session_id || inp.transcript_path;
  const ev = inp.hook_event_name;

  if (ev === 'PreCompact') {
    const trigger = inp.trigger || 'unknown';
    const last = inp.transcript_path ? lastContext(inp.transcript_path) : null;
    const agent = inp.agent_id || null;
    const keep = trigger === 'auto' ? (agent ? AGENT_KEEP : MAIN_KEEP) : null;
    log({ event: 'pre', session: sid, agent_id: agent, agent_type: inp.agent_type || null, trigger, context: last?.context ?? null, user_instructions: !!inp.custom_instructions, injected: !!keep });
    if (!agent) saveState(sid, { lastTrigger: trigger, at: Date.now() });
    if (keep) process.stdout.write(keep);
    return;
  }

  if (ev === 'SessionStart' && inp.source === 'compact') {
    const st = loadState(sid);
    const auto = st.lastTrigger === 'auto' && Date.now() - (st.at || 0) < RECOVERY_WINDOW_MS;
    log({ event: 'post', session: sid, trigger: st.lastTrigger || null, recovery: auto });
    if (!auto) return;
    saveState(sid, { ...st, lastTrigger: 'auto-recovered' });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RECOVERY } }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {}).finally(() => process.exit(0));
}
