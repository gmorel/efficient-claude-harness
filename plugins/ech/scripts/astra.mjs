#!/usr/bin/env node
// astra.mjs — hand a task to OpenAI GPT-6-Astra through the Codex CLI, as a script instead of a recipe.
//
// Every manual step is a place to get it wrong (inherit the shell's secrets, get killed by the tool
// ceiling, poll from the wrong directory, let Codex scope itself to a dirty tree). So they live here, once.
//
//   astra.mjs run  "<prompt>" [--effort low|medium|high|xhigh|max|ultra] [--write] [--cwd <dir>] [--skill <SKILL.md>]...
//   astra.mjs wait <job-id> [--timeout <s>]   poll until done, print the answer verbatim + one provenance line
//   astra.mjs status                          list the jobs this script launched
//
// Runs `codex exec` directly, detached, with a log — not the Codex Claude Code plugin's runtime: that
// runtime keeps whatever Codex binary it was started with (an outdated one silently refuses Astra) and
// caps effort at xhigh, while Astra goes to ultra. Read-only unless --write is passed. Default effort: high.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Runtime data (logs, ledgers, job state) lives OUTSIDE the plugin: the install
// directory changes on every update. Resolution order: HARNESS_DATA_DIR, then
// CLAUDE_PLUGIN_DATA (the agents pass it in), then ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');

const MODEL = 'gpt-6-astra';
const MARK = '🌌'; // every line Astra produces is stamped so its words never pass for ours
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const STATE_DIR = path.join(DATA_DIR, 'openai-astra');
const STATE = path.join(STATE_DIR, 'jobs.json');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const opts = (n) => argv.flatMap((a, i) => (a === '--' + n && argv[i + 1] ? [argv[i + 1]] : []));

// Credential-shaped variables never reach the child. Same filter as openai-gpt-reviewer.mjs.
function cleanEnv() {
  const RE = /(PASSW|PASSWD|PASSPHRASE|TOKEN|SECRET|LOGIN|COOKIE|CREDENTIAL|PRIVATE|APIKEY|_KEY$|_KEY_|API_KEY|_SK$|_PAT$|_DSN$|_URI$|_URL$|_AUTH$|AUTH_|_CREDS$)/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!RE.test(k) && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  return env;
}

// Where is `codex`? On macOS/Linux the binary on PATH. On Windows the npm global install puts a
// `codex.cmd` shim on PATH, which cannot be spawned without a shell — and a shell would re-parse the
// prompt. So on Windows we find the shim and run its JS entry point with node directly.
function resolveCodex() {
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'where' : 'sh', isWin ? ['codex'] : ['-c', 'command -v codex'], { encoding: 'utf8', windowsHide: true });
  const found = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  if (r.status !== 0 || !found) return null;
  if (!isWin) return { cmd: found, pre: [] };
  const dir = path.dirname(found);
  for (const entry of [path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) if (existsSync(entry)) return { cmd: process.execPath, pre: [entry] };
  return { cmd: found, pre: [] }; // an .exe on PATH, or a shim we could not unwrap — spawn as-is
}

const jobs = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
function saveJob(id, rec) { mkdirSync(STATE_DIR, { recursive: true }); const j = jobs(); j[id] = rec; writeFileSync(STATE, JSON.stringify(j, null, 1)); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stamp = (txt) => String(txt).replace(/\s+$/, '').split('\n').map((l) => `${MARK} ${l}`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === 'run') {
  const rawPrompt = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && ['--effort', '--cwd', '--skill'].includes(arr[i - 1])))[0];
  const effort = opt('effort', 'high');
  const write = flag('write');
  const cwd = path.resolve(opt('cwd', process.cwd()));
  if (!rawPrompt) { console.error('usage: astra.mjs run "<prompt>" [--effort low|medium|high|xhigh|max|ultra] [--write] [--cwd <dir>] [--skill <SKILL.md>]...'); process.exit(2); }
  // Claude Code skills that bear on the task travel as file paths: Codex can read a SKILL.md and follow
  // its prose (verified), but it has no Claude tools, so the note tells it what to skip.
  const skills = opts('skill').map((f) => path.resolve(f));
  for (const f of skills) if (!existsSync(f)) { console.error(`--skill: no such file ${f}`); process.exit(2); }
  const prompt = skills.length
    ? `${rawPrompt}\n\nRelevant Claude Code skills — read each file below FIRST and apply its instructions to this task. They were written for Claude Code: ignore anything about Claude-only tooling (Agent, Skill, Artifact, hooks, $ARGUMENTS, allowed-tools) and follow the substance.\n${skills.map((f) => `- ${f}`).join('\n')}\n`
    : rawPrompt;
  if (!EFFORTS.includes(effort)) { console.error(`effort must be one of ${EFFORTS.join('|')}`); process.exit(2); }
  // Spend guard: every run is a Codex call on the ChatGPT plan. A runaway trigger loop must hit a wall
  // before it hits the plan's limits. Default 40 launches per local day; ASTRA_DAILY_CAP=<n> raises it.
  const cap = Number(process.env.ASTRA_DAILY_CAP ?? 40);
  const today = new Date().toDateString();
  const todayRuns = Object.values(jobs()).filter((r) => new Date(r.ts).toDateString() === today).length;
  if (todayRuns >= cap) { console.error(`no Astra pass — daily cap reached (${todayRuns}/${cap} launches today). Raise it with ASTRA_DAILY_CAP=<n> if this is deliberate.`); process.exit(4); }
  const codex = resolveCodex();
  if (!codex) { console.error('codex CLI not on PATH — no Astra pass'); process.exit(2); }
  const version = (spawnSync(codex.cmd, [...codex.pre, '--version'], { encoding: 'utf8', env: cleanEnv(), windowsHide: true }).stdout || '').trim();
  const id = `astra-${Date.now().toString(36)}`;
  mkdirSync(STATE_DIR, { recursive: true });
  const log = path.join(STATE_DIR, `${id}.log`);
  const out = path.join(STATE_DIR, `${id}.out`);
  const args = ['exec', '-m', MODEL, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', write ? 'workspace-write' : 'read-only', '--skip-git-repo-check', '-o', out, prompt];
  const child = spawn(codex.cmd, [...codex.pre, ...args], { cwd, env: cleanEnv(), detached: true, windowsHide: true, stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')] });
  child.unref();
  saveJob(id, { cwd, effort, write, model: MODEL, version, skills, ts: new Date().toISOString(), pid: child.pid, log, out });
  console.log(id);
  console.log(`launched ${MODEL} effort=${effort} ${write ? 'WRITE' : 'read-only'} in ${cwd} (${version}, pid ${child.pid}). Then: node ${process.argv[1]} wait ${id}`);
} else if (cmd === 'wait') {
  const id = argv[1]; const rec = jobs()[id];
  if (!id || !rec) { console.error(`unknown job ${id} — not launched by this script`); process.exit(2); }
  const timeoutMs = Number(opt('timeout', 0)) * 1000 || 0; // 0 = poll until done
  const t0 = Date.now();
  while (alive(rec.pid)) {
    if (timeoutMs && Date.now() - t0 > timeoutMs) { console.log(`still running after ${opt('timeout')}s (pid ${rec.pid}) — run wait again`); process.exit(3); }
    await sleep(5000);
  }
  const logTxt = existsSync(rec.log) ? readFileSync(rec.log, 'utf8') : '';
  const session = (logTxt.match(/session id: ([0-9a-f-]+)/) || [])[1] ?? '?';
  const errs = logTxt.split('\n').filter((l) => /^ERROR/.test(l));
  if (existsSync(rec.out) && readFileSync(rec.out, 'utf8').trim()) console.log(stamp(readFileSync(rec.out, 'utf8')));
  else { console.log(`${MARK} no Astra pass — no final message; log tail:`); console.log(logTxt.slice(-1500)); }
  if (errs.length) console.log('\n' + errs.join('\n'));
  console.log(`\n${MARK} provenance: model=${MODEL} effort=${rec.effort} ${rec.write ? 'WRITE' : 'read-only'} job=${id} codex=${rec.version ?? '?'} codex-session=${session}${rec.skills?.length ? ` skills=${rec.skills.map((f) => path.basename(path.dirname(f))).join(',')}` : ''} log=${rec.log}`);
  process.exit(errs.length || !existsSync(rec.out) ? 1 : 0);
} else if (cmd === 'status') {
  const today = new Date().toDateString();
  console.log(`# launches today: ${Object.values(jobs()).filter((r) => new Date(r.ts).toDateString() === today).length} (cap ${process.env.ASTRA_DAILY_CAP ?? 40})`);
  for (const [id, r] of Object.entries(jobs())) console.log(`${id}\t${r.effort}\t${r.write ? 'WRITE' : 'ro'}\t${r.ts}\t${r.cwd}\t${r.pid ? (alive(r.pid) ? 'running' : 'done') : 'legacy'}`);
} else {
  console.error('usage: astra.mjs run "<prompt>" [--effort ...] [--write] [--cwd <dir>] | wait <job-id> [--timeout <s>] | status');
  process.exit(2);
}
