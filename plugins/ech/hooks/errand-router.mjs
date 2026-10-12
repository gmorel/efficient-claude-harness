#!/usr/bin/env node
// PreToolUse hook (Bash|Read): notice RUNS of main-thread errands and suggest handing the run to a helper.
//
// Every main-thread turn re-reads the whole conversation, so a long run of read-only errands (cat, sed -n, grep,
// rg, ls, find, git log|diff|show|status|blame) in the main thread is paid for again on every later turn. One helper
// call that returns only the few facts needed is cheaper, but a single helper call is itself a main turn, so only a
// RUN is worth handing over. This hook:
//   1. classifies the call as errand / not errand with a free regex (copes with `rtk …` rewritten commands);
//   2. keeps reading a helper's own tasks/*.output file in main (that is verification, not an errand);
//   3. keeps a per-session streak of errands in a state file (a real user prompt, any other tool, or a non-errand
//      Bash/Read in between resets it; the transcript tail is checked for what happened since the last errand);
//   4. from the 3rd errand in a row, nudges toward ech:code-explorer (warn), or denies at N >= 5 in block mode;
//   5. verify window: once a helper's result arrives, the next ERRAND_ROUTER_VERIFY_WINDOW (8) errands are checks of
//      the helper's claims and are never nudged; a real user prompt closes the window.
// Main thread only: a call with agent_id (inside a subagent) passes untouched. Nothing leaves the machine unless Jev mode is on.
//
// Shipped warn-only. Switches: ERRAND_ROUTER=warn (default) | block | off, or create <data>/errand-router.off.
// ERRAND_ROUTER_MIN_STREAK (3), ERRAND_ROUTER_BLOCK_STREAK (5), ERRAND_ROUTER_VERIFY_WINDOW (8),
// ERRAND_ROUTER_LANE (agent to suggest, default ech:code-explorer),
// Holdout, as the original: half the sessions are a silent control group (logged as would-warn), so the nudge can be measured.
// ERRAND_ROUTER_HOLDOUT=0 nudges every session; unset and =1 both give the half split.
//
// Jev mode (opt-in): ERRAND_ROUTER_JEV=1 AND a key from lib/jev-client.mjs loadKey(): TYPESAFE_AI_JEV_API_KEY, else (only when that is empty) the line of the JEV_ENV_FILE file.
// From the 3rd errand in a row Jev (lib/jev-client.mjs) picks the lane. It nudges (warn) or denies (block, N >= 5)
// only at confidence >= ERRAND_ROUTER_MIN_CONF (0.80) and lane != main; ERRAND_ROUTER_TIMEOUT_MS (1500) bounds the call.
// The ssh and live-run rules of ERRAND_ROUTER_CONFIG apply in Jev mode only.
// ERRAND_ROUTER_LANES replaces the lane table with a JSON object (lane key -> description); `main` is always kept.
// Without Jev mode the Jev client is never loaded and no network call is made; any Jev failure is silent.
//
// ERRAND_ROUTER_CONFIG=<absolute path to a JSON file> holds the owner's values, read once at start. Every key is optional:
//   "lanes":        lane key -> description, replaces the generic lane table (ERRAND_ROUTER_LANES still wins)
//   "how":          the Jev HOW text, replaces the generic one
//   "sshHosts":     hosts whose `ssh <host> ...` calls count as errands (Jev mode)
//   "liveRunWords": script names whose `node ... <word>` call, when run over ssh, stays in the main thread (Jev mode)
// A missing or unreadable file means the generic defaults, with no error. The plugin ships no host or lane names of its own.
// Ledger: <data>/errand-router.jsonl, one line per main-thread Bash/Read call. ERRAND_ROUTER_LEDGER / _STATE_DIR override.
// <data> is HARNESS_DATA_DIR, else CLAUDE_PLUGIN_DATA (exported to plugin hooks), else ~/.claude/harness-data.
// Fails open: any crash exits 0 and prints nothing.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');
const LEDGER = process.env.ERRAND_ROUTER_LEDGER || path.join(DATA_DIR, 'errand-router.jsonl');
const STATE_DIR = process.env.ERRAND_ROUTER_STATE_DIR || path.join(DATA_DIR, 'errand-router-state');
const OFF_FILE = path.join(DATA_DIR, 'errand-router.off');
const LANE = process.env.ERRAND_ROUTER_LANE || 'ech:code-explorer';
const MIN_STREAK = Number(process.env.ERRAND_ROUTER_MIN_STREAK) || 3;
const BLOCK_STREAK = Number(process.env.ERRAND_ROUTER_BLOCK_STREAK) || 5;
const IDLE_RESET_MS = 15 * 60 * 1000; // only used when the transcript cannot tell us what happened in between
const TAIL_BYTES = 2 * 1024 * 1024;
const VERIFY_WINDOW = Number(process.env.ERRAND_ROUTER_VERIFY_WINDOW) || 8;
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
const MIN_CONF = Number(process.env.ERRAND_ROUTER_MIN_CONF) || 0.8;
const TIMEOUT_MS = Number(process.env.ERRAND_ROUTER_TIMEOUT_MS) || 1500;
// The client is imported only when ERRAND_ROUTER_JEV=1, so the default mode never loads it.
export const JEV = process.env.ERRAND_ROUTER_JEV === '1' && !!(await import('./lib/jev-client.mjs')).loadKey();

const sha = s => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- Jev mode: lanes and the Jev question (INSTR=2 wording)

// Generic lane table: the two lanes every install has. The owner's lanes come from ERRAND_ROUTER_CONFIG.
export const LANES = {
  'explore': 'Explore: searches or reads several repository files to answer where or how something is done.',
  'main': 'main thread, keep it here: git commit / push / merge, and any call that has to stay in the main thread, such as reading a helper\'s own tasks/*.output file.',
};
// Read once. An absent or unreadable file, or one that is not a JSON object, gives {}.
export function loadConfig(file = process.env.ERRAND_ROUTER_CONFIG) {
  if (!file) return {};
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
const CFG = loadConfig();
export const TASK = 'A developer assistant is about to run this tool call in its expensive main thread. Pick the helper lane that should run it instead, or the main thread if it must stay there.';
const GENERIC_HOW = 'Decide by what the call ACTS on, not by the words it mentions. A call that only reads, greps or lists files goes to explore. git commit, push and merge stay in main.';
export const HOW = typeof CFG.how === 'string' && CFG.how.trim() ? CFG.how : GENERIC_HOW;
export const NONE_WHEN = 'no lane in the list fits this call';
// Lane key -> the subagent_type to spawn.
export const AGENT_TYPE = { explore: 'Explore' };
const ALWAYS = new Set(['explore', 'main']);

// A lane object (lane key -> description) as a table: `none` is reserved for Jev, `main` is always kept, an empty or invalid object gives null.
function asTable(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const t = {};
  for (const [k, v] of Object.entries(o)) if (k && k !== 'none' && typeof v === 'string' && v.trim()) t[k] = v;
  if (!Object.keys(t).length) return null;
  if (!('main' in t)) t.main = LANES.main;
  return t;
}
// ERRAND_ROUTER_LANES (JSON), else the owner's "lanes" from ERRAND_ROUTER_CONFIG, else the generic table.
export function laneTable(raw = process.env.ERRAND_ROUTER_LANES) {
  if (raw) {
    try { const t = asTable(JSON.parse(raw)); if (t) return t; } catch {}
  }
  return asTable(CFG.lanes) || LANES;
}
const LANE_TABLE = laneTable();

// The prompt builder of the original hook; returns the argument object for jevChoose (minus timeoutMs).
export function buildErrandQuestion({ tool, cmd, lanes = Object.keys(LANE_TABLE), table = LANE_TABLE }) {
  const criteria = {};
  for (const k of Object.keys(table)) if (lanes.includes(k)) criteria[k] = { option: table[k] };
  criteria.none = { when: NONE_WHEN };
  return { state: { outil: tool, appel: cmd }, name: 'voie', task: TASK, how: HOW, criteria };
}

// Project lanes exist only where their agent file does (walk up from cwd to find .claude/agents).
export function availableLanes(cwd, table = LANE_TABLE) {
  const have = new Set(ALWAYS);
  const dirs = [path.join(CLAUDE, 'agents')];
  try {
    let d = cwd ? path.resolve(cwd) : null;
    for (let i = 0; d && i < 8; i++) {
      const a = path.join(d, '.claude', 'agents');
      if (existsSync(a)) { dirs.push(a); break; }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  } catch {}
  for (const k of Object.keys(table)) {
    if (have.has(k)) continue;
    if (dirs.some(dir => existsSync(path.join(dir, k + '.md')))) have.add(k);
  }
  return Object.keys(table).filter(k => have.has(k));
}

// ---------------------------------------------------------------- classification (free regex)

// Jev mode only: a live run over `ssh <host>` stays in the main thread. Hosts and words come from ERRAND_ROUTER_CONFIG;
// with none configured the rules never match, so the plugin names no host and no script of its own.
const NEVER = /(?!)/;
const alternation = list => list.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const cfgList = v => (Array.isArray(v) ? v : []).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
const LIVE_WORDS = cfgList(CFG.liveRunWords);
const SSH_HOSTS = cfgList(CFG.sshHosts);
export const LIVE_RUN = LIVE_WORDS.length ? new RegExp('\\bnode\\b[^;|&\\n]*?(' + alternation(LIVE_WORDS) + ')') : NEVER;
const SSH_RE = SSH_HOSTS.length ? new RegExp('^ssh\\s+(-\\S+\\s+)*(' + alternation(SSH_HOSTS) + ')\\b') : NEVER;
const TASK_OUTPUT = /(^|[\/\s'"])tasks\/[^\s'"|;&]*\.output\b/;
const GIT_WRITE = /\bgit\s+(-C\s+\S+\s+)?(commit|push|merge|rebase|tag|cherry-pick|reset|checkout|switch|stash|am|apply)\b/;
const GIT_RO = new Set(['log', 'diff', 'show', 'status', 'blame', 'ls-files', 'grep']);
const CORE = new Set(['cat', 'sed', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'ls', 'find', 'wc', 'awk', 'read', 'tree', 'git']);
const FILTERS = new Set(['sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'xargs', 'file', 'stat', 'du', 'pwd', 'echo', 'printf', 'cd', 'true', 'basename', 'dirname', 'realpath', 'diff', 'md5', 'shasum', 'sha256sum', 'fold', 'less', 'more']);

// Quote-aware split on unquoted && || ; | and newlines. Also reports an unquoted output redirection to a file.
export function splitSegments(cmd) {
  const segs = [];
  let cur = '', q = null, redirect = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) {
      if (c === '\\' && q === '"') { cur += c + (n ?? ''); i++; continue; }
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '\\') { cur += c + (n ?? ''); i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { segs.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '\n' || c === '|') { segs.push(cur); cur = ''; continue; }
    if (c === '>') {
      const rest = cmd.slice(i + 1).replace(/^>/, '').trimStart();
      const toFd = rest.startsWith('&');
      const toNull = rest.startsWith('/dev/null') || rest.startsWith('/dev/stderr') || rest.startsWith('/dev/stdout');
      if (!toFd && !toNull) redirect = true;
    }
    cur += c;
  }
  segs.push(cur);
  return { segments: segs.map(s => s.trim()).filter(Boolean), redirect };
}

function words(seg) {
  const w = seg.replace(/^\(+/, '').trim().split(/\s+/);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // env assignments
  if (w[0] === 'rtk') w.shift(); // rtk-rewrite.sh output: `rtk read|grep|ls|find|wc|git …`
  if (w[0] === 'command' || w[0] === 'builtin') w.shift();
  return w;
}

function segmentKind(seg) {
  const w = words(seg);
  const cmd = (w[0] || '').replace(/^.*\//, '');
  if (!cmd) return 'filter';
  if (cmd === 'git') {
    let i = 1;
    while (w[i] && w[i].startsWith('-')) { i += (w[i] === '-C' || w[i] === '-c') ? 2 : 1; }
    return GIT_RO.has(w[i]) ? 'git' : null;
  }
  if (cmd === 'sed') return /(^|\s)-[a-zA-Z]*n/.test(seg) && !/(^|\s)(-[a-zA-Z]*i|--in-place)/.test(seg) ? 'read' : null;
  if (cmd === 'find') return /\s-(delete|exec|execdir|ok|okdir|fprint\S*)\b/.test(seg) ? null : 'read';
  if (cmd === 'awk') return /-i\s*inplace/.test(seg) ? null : 'read';
  if (cmd === 'tail') return /(^|\s)-[a-zA-Z]*[fF]\b|--follow/.test(seg) ? null : 'read';
  if (cmd === 'xargs') return 'filter';
  if (CORE.has(cmd)) return 'read';
  if (FILTERS.has(cmd)) return 'filter';
  return null;
}

// -> {errand, kind, hard, why}. hard = 'main' when a hard rule keeps the call in the main thread.
// `jev` adds the ssh rules of ERRAND_ROUTER_CONFIG (errand, LIVE_RUN hard rule, git write over ssh); the default mode has none.
export function classify(tool, input = {}, jev = JEV) {
  if (tool === 'Read') {
    const fp = String(input.file_path || '');
    if (!fp) return { errand: false, kind: null, hard: null, why: 'no-path' };
    if (/(^|\/)tasks\/[^/]+\.output$/.test(fp)) return { errand: false, kind: 'read', hard: 'main', why: 'helper-output' };
    return { errand: true, kind: 'read', hard: null, why: 'read-file' };
  }
  if (tool !== 'Bash') return { errand: false, kind: null, hard: null, why: 'other-tool' };
  const raw = String(input.command || '').trim();
  if (!raw) return { errand: false, kind: null, hard: null, why: 'empty' };
  const cmd = raw.replace(/^rtk\s+/, '');
  const sshRule = jev ? SSH_RE.exec(cmd) : null;
  if (sshRule) {
    if (LIVE_RUN.test(cmd)) return { errand: false, kind: 'ssh', hard: 'main', why: 'live-run' };
    if (GIT_WRITE.test(cmd)) return { errand: false, kind: 'ssh', hard: null, why: 'git-write' };
    return { errand: true, kind: 'ssh', hard: null, why: 'ssh-' + sshRule[2] };
  }
  if (GIT_WRITE.test(cmd)) return { errand: false, kind: 'git', hard: null, why: 'git-write' };
  const { segments, redirect } = splitSegments(cmd);
  if (redirect) return { errand: false, kind: null, hard: null, why: 'writes-file' };
  let core = 0, git = 0;
  for (const s of segments) {
    const k = segmentKind(s);
    if (k === null) return { errand: false, kind: null, hard: null, why: 'not-read-only' };
    if (k === 'git') git++;
    if (k === 'read' || k === 'git') core++;
  }
  if (!core) return { errand: false, kind: null, hard: null, why: 'no-read' };
  if (TASK_OUTPUT.test(cmd)) return { errand: false, kind: 'read', hard: 'main', why: 'helper-output' };
  return { errand: true, kind: git ? 'git' : 'read', hard: null, why: git ? 'git-read' : 'read-only' };
}

// ---------------------------------------------------------------- streak logic

// Scan the main-thread transcript tail backwards from the newest line down to `boundId` (the previous hooked
// Bash/Read call), a real user prompt, or the start of the tail. Returns:
//   since: 'none' (only Bash/Read since boundId) | 'break' (another tool or a real user prompt) | 'unknown' (boundId not found)
//   event: the NEWEST of 'agent' (a helper's result arrived: a tool_result of an Agent/Task call, or a
//          <task-notification> naming one) or 'prompt' (a real user prompt), else null
//   agentId: the Agent/Task tool_use id behind an 'agent' event (so one result opens one window only)
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const isPrompt = d => {
  const c = d.message?.content;
  const p = (typeof c === 'string' && !c.startsWith('<')) || (Array.isArray(c) && c.some(b => b?.type === 'text' && !String(b.text || '').startsWith('<')) && !c.some(b => b?.type === 'tool_result'));
  return p && !d.isMeta && !d.isCompactSummary;
};
export function scanTail(transcriptPath, boundId, currentId) {
  const res = { since: 'unknown', event: null, agentId: null };
  if (!transcriptPath) return res;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (size > n) lines.shift(); // partial first line
    const results = new Set(); // tool_use ids whose result (or completion notice) is newer than where we are
    let other = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const note = line.includes('<task-notification>');
      if (!note && !line.includes('"tool_use"') && !line.includes('"user"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.isSidechain === true) continue;
      if (note) for (const mm of line.matchAll(/<tool-use-id>\s*([A-Za-z0-9_-]+)\s*<\/tool-use-id>/g)) results.add(mm[1]);
      const m = d.message;
      if (d.type === 'user' && m) {
        if (isPrompt(d)) { res.since = 'break'; res.event ??= 'prompt'; return res; }
        if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
        continue;
      }
      if (d.type !== 'assistant' || !Array.isArray(m?.content)) continue;
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b?.type !== 'tool_use' || b.id === currentId) continue;
        if (boundId && b.id === boundId) { res.since = other ? 'break' : 'none'; return res; }
        if (AGENT_TOOLS.has(b.name) && results.has(b.id) && !res.event) { res.event = 'agent'; res.agentId = b.id; }
        if (b.name !== 'Bash' && b.name !== 'Read') other = true;
      }
    }
    if (other) res.since = 'break';
    return res;
  } catch { return res; } finally { try { if (fd !== undefined) closeSync(fd); } catch {} }
}

// Kept for callers and tests: 'none' | 'break' | 'unknown'.
export function sinceLastErrand(transcriptPath, lastId, currentId) {
  if (!lastId) return 'unknown';
  return scanTail(transcriptPath, lastId, currentId).since;
}

// Pure: the verify window after a helper's result. -> {left, from, open}
// A new helper result opens VERIFY_WINDOW errands with no nudge; a real user prompt closes it; each errand uses one.
export function nextVerify(state, cls, scan) {
  let left = Number(state?.verifyLeft) || 0;
  let from = state?.verifyFrom ?? null;
  if (scan?.event === 'prompt') left = 0;
  if (scan?.event === 'agent' && scan.agentId && scan.agentId !== from) { left = VERIFY_WINDOW; from = scan.agentId; }
  const open = cls.errand && left > 0;
  if (open) left -= 1;
  return { left, from, open };
}

// Pure: next streak for this call. `since` is the result of sinceLastErrand ('none'|'break'|'unknown').
export function nextStreak(state, cls, since, now = Date.now()) {
  if (!cls.errand) return 0;
  const prev = Number(state?.streak) || 0;
  if (!prev) return 1;
  if (since === 'break') return 1;
  if (since === 'unknown' && (!state.ts || now - state.ts > IDLE_RESET_MS)) return 1;
  return prev + 1;
}

// Holdout, as the original: half the sessions are a silent control group unless ERRAND_ROUTER_HOLDOUT=0 (every session nudged).
// Jev mode and the default mode share it.
export function armFor(sessionId, holdout = process.env.ERRAND_ROUTER_HOLDOUT) {
  if (holdout === '0') return 'nudge';
  return createHash('sha256').update(String(sessionId ?? '')).digest()[0] % 2 === 0 ? 'nudge' : 'control';
}

// Pure: what to do at this streak. -> {action, message?}
export function decide({ streak, mode, lane = LANE, blockStreak = BLOCK_STREAK }) {
  const message = `errand-router: This is errand ${streak} in a row. Hand the rest of this run to ${lane} in one call, or write one script. Skip this if you are checking a claim a helper made; read that yourself. (Each main-thread turn re-reads the whole context; one ${lane} call returning the few facts you need is cheaper than more errands here.)`;
  if (mode === 'block' && streak >= blockStreak) return { action: 'deny', message };
  return { action: 'warn', message };
}

// Pure, Jev mode: what to do once Jev answered (or not). -> {action, message?}
export function decideJev({ streak, mode, jev, minConf = MIN_CONF, blockStreak = BLOCK_STREAK }) {
  if (!jev) return { action: 'jev-null' };
  if (jev.choice === 'main' || jev.choice === 'none') return { action: 'keep-' + jev.choice };
  if ((jev.confidence ?? 0) < minConf) return { action: 'low-confidence' };
  const agent = AGENT_TYPE[jev.choice] || jev.choice;
  const message = `errand-router: This is errand ${streak} in a row. Hand the rest of this run to ${agent} in one call, or write one script. Skip this if you are checking a claim a helper made; read that yourself. (Each main-thread turn re-reads the whole context; one ${agent} call returning the few facts you need is cheaper than more errands here.)`;
  if (mode === 'block' && streak >= blockStreak) return { action: 'deny', message };
  return { action: 'warn', message };
}

// ---------------------------------------------------------------- IO

function mode() {
  if (existsSync(OFF_FILE)) return 'off';
  const m = process.env.ERRAND_ROUTER;
  return ['off', 'warn', 'block'].includes(m) ? m : 'warn';
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
    const tmp = f + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, f);
  } catch {}
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function head(tool, input) {
  if (tool === 'Read') return 'Read ' + path.extname(String(input.file_path || '')).toLowerCase();
  const w = words(String(input.command || '').trim().replace(/^cd\s+[^;&|]*&&\s*/, ''));
  return w.slice(0, w[0] === 'git' || w[0] === 'ssh' ? 2 : 1).join(' ').slice(0, 40);
}

async function main() {
  const m = mode();
  if (m === 'off') return;
  const inp = await readStdin();
  if (!inp || inp.agent_id) return; // subagents are the helpers: never route them
  const tool = inp.tool_name || '';
  if (tool !== 'Bash' && tool !== 'Read') return;
  const input = inp.tool_input || {};
  const sid = inp.session_id || inp.transcript_path || '-';
  const cls = classify(tool, input);
  const state = loadState(sid);
  const arm = armFor(sid);
  // One tail scan per errand, bounded by the previous hooked call: streak break + helper results + user prompts.
  const scan = cls.errand ? scanTail(inp.transcript_path, state.lastCallId || null, inp.tool_use_id) : null;
  const since = cls.errand && state.streak ? (state.lastCallId && state.lastCallId === state.lastId ? scan.since : 'unknown') : null;
  const streak = nextStreak(state, cls, since);
  const v = cls.errand ? nextVerify(state, cls, scan) : { left: Number(state.verifyLeft) || 0, from: state.verifyFrom ?? null, open: false };
  saveState(sid, { streak, lastId: cls.errand ? (inp.tool_use_id || null) : null, lastCallId: inp.tool_use_id || null, verifyLeft: v.left, verifyFrom: v.from, ts: Date.now() });

  const text = tool === 'Read' ? input.file_path : input.command;
  const base = { session_id: sid, arm, tool, head: head(tool, input), cmd_sha: sha(text), kind: cls.kind, why: cls.why, streak, since, verify_left: v.left, mode: m };
  if (cls.hard) { log({ ...base, lane: 'main', action: 'hard-main' }); return; }
  if (!cls.errand) { log({ ...base, action: 'not-errand' }); return; }
  if (streak < MIN_STREAK) { log({ ...base, action: 'count', ...(v.open ? { verify: true } : {}) }); return; }
  if (v.open) { log({ ...base, action: 'suppressed-verify', helper: scan?.event === 'agent' ? 'new' : 'window' }); return; }

  if (!JEV) {
    const d = decide({ streak, mode: m });
    const action = arm === 'control' ? 'would-warn' : d.action;
    log({ ...base, lane: LANE, action });
    if (action === 'would-warn') return; // control arm: everything ran, nothing is shown
    emit(d);
    return;
  }

  // Jev mode: the original path.
  const { jevChoose } = await import('./lib/jev-client.mjs');
  const lanes = availableLanes(inp.cwd);
  const jev = await jevChoose({ ...buildErrandQuestion({ tool, cmd: String(text || '').slice(0, 500), lanes }), timeoutMs: TIMEOUT_MS });
  const d = decideJev({ streak, mode: m, jev });
  const action = arm === 'control' && (d.action === 'warn' || d.action === 'deny') ? 'would-warn' : d.action;
  log({ ...base, lanes: lanes.length, lane: jev?.choice ?? null, confidence: jev?.confidence ?? null, jev_ms: jev?.ms ?? null, action });
  if (action === 'would-warn') return; // control arm: everything ran, nothing is shown
  emit(d);
}

function emit(d) {
  if (d.action === 'deny') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.message } }));
  } else if (d.action === 'warn') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.message } }));
  }
}

let isMain = false;
try { isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); } catch {}
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}
