#!/usr/bin/env node
// openai-gpt-reviewer.mjs — the OpenAI cross-check, as a script instead of a recipe.
//
// The two OpenAI reviewer agents used to carry this as ~20 lines of shell each. Every
// step is a place to get it wrong: forget to strip credentials and the spawned
// process inherits the shell's secrets; run it in the foreground and the tool
// ceiling kills it mid-review; poll from another directory and the job reads
// as dead. So the steps live here, once.
//
//   openai-gpt-reviewer.mjs plan <plan-file>  [--effort high|xhigh] --focus "<text>" [--skill <SKILL.md>]... [--print-prompt]
//   openai-gpt-reviewer.mjs diff <patch-file> [--effort high|xhigh] --focus "<text>" [--skill <SKILL.md>]... [--print-prompt]
//   openai-gpt-reviewer.mjs pair <patchA> <patchB> --focus "<spec>"   blind A/B of two implementations (shadow runs)
//   openai-gpt-reviewer.mjs wait <job-id>                   poll until done, print result
//
// Read-only by construction: --write is never passed. Requires the `codex`
// Claude Code plugin; exits 2 with a clear message if it is absent.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Runtime data (logs, ledgers, job state) lives OUTSIDE the plugin: the install
// directory changes on every update. Resolution order: HARNESS_DATA_DIR, then
// CLAUDE_PLUGIN_DATA (the agents pass it in), then ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const opts = (n) => argv.flatMap((a, i) => (a === '--' + n && argv[i + 1] ? [argv[i + 1]] : []));

// Skills travel with the request: --skill <SKILL.md> (repeatable) names the Claude Code skills that
// bear on the review (project conventions, a review checklist). Codex reads the files and follows
// the prose; the note tells it what to skip, since it has none of Claude's tooling.
function skillsBlock() {
  const paths = opts('skill').map((f) => path.resolve(f));
  for (const f of paths) if (!existsSync(f)) { console.error(`--skill: no such file ${f}`); process.exit(2); }
  return paths.length
    ? `\n\nRelevant Claude Code skills — read each file below FIRST and apply its instructions to this review. They were written for Claude Code: ignore anything about Claude-only tooling (Agent, Skill, Artifact, hooks, $ARGUMENTS, allowed-tools) and follow the substance.\n${paths.map((f) => `- ${f}`).join('\n')}\n`
    : '';
}

function companion() {
  const root = path.join(homedir(), '.claude', 'plugins', 'cache');
  const r = spawnSync('sh', ['-c', `find ${JSON.stringify(root)} -path "*codex*/scripts/codex-companion.mjs" 2>/dev/null | sort -V | tail -1`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  if (!p) { console.error('codex plugin not installed on this machine — no cross-model pass'); process.exit(2); }
  return p;
}

// Credential-shaped variables never reach the child. This mirrors the wrapper.
function cleanEnv() {
  const RE = /(PASSW|PASSWD|PASSPHRASE|TOKEN|SECRET|LOGIN|COOKIE|CREDENTIAL|PRIVATE|APIKEY|_KEY$|_KEY_|API_KEY|_SK$|_PAT$|_DSN$|_URI$|_URL$|_AUTH$|AUTH_|_CREDS$)/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!RE.test(k) && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  return env;
}

// Job state is namespaced by the working directory the job was launched from.
// Remember it beside the job id so `wait` polls from the same place.
const STATE = path.join(DATA_DIR, 'openai-gpt-reviewer-jobs.json');
const jobs = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };

if (cmd === 'pair') {
  // Two patches of the same brief, unlabelled, in an order fixed by the file
  // names' hash — the judge must not learn which engine sits in slot A.
  const [a, b] = [argv[1], argv[2]]; const focus = opt('focus', ''); const effort = opt('effort', 'high');
  if (!a || !b || !focus) { console.error('usage: openai-gpt-reviewer.mjs pair <patchA> <patchB> --focus "<spec>"'); process.exit(2); }
  const flip = (a + b).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 1;
  const [A, B] = flip ? [b, a] : [a, b];
  const tmp = path.join(DATA_DIR, 'shadows', `pair-${Date.now()}.txt`);
  mkdirSync(path.dirname(tmp), { recursive: true });
  writeFileSync(tmp, `# TASK SPEC

${focus}

Two independent implementations of that spec follow. You are NOT told who wrote which.

===== CANDIDATE A =====
${readFileSync(A, 'utf8')}

===== CANDIDATE B =====
${readFileSync(B, 'utf8')}
`);
  const C = companion();
  const prompt = `Read ${tmp}. Two implementations of one spec, A and B. Judge ONLY the code. Answer: 1. VERDICT: A better / B better / equivalent  2. One sentence why.  3. Any correctness bug in either, with the line.  4. What you cannot judge from a diff alone. Say equivalent if they are — do not manufacture a preference.` + skillsBlock();
  const r = spawnSync('node', [C, 'task', '--json', '--effort', effort, '--background', prompt], { encoding: 'utf8', env: cleanEnv(), cwd: process.cwd() });
  let id = null; try { id = JSON.parse(r.stdout).jobId; } catch {}
  if (!id) { console.error('launch failed:', (r.stderr || r.stdout || '').slice(0, 400)); process.exit(1); }
  const j = jobs(); j[id] = { cwd: process.cwd(), kind: 'pair', effort, A_is: flip ? 'second-arg' : 'first-arg', ts: new Date().toISOString() };
  try { writeFileSync(STATE, JSON.stringify(j, null, 1)); } catch {}
  console.log(id); console.log(`launched pair (A = ${flip ? path.basename(b) : path.basename(a)}). Then: node ${process.argv[1]} wait ${id}`);
} else if (cmd === 'plan' || cmd === 'diff') {
  const file = argv[1]; const focus = opt('focus', ''); const effort = opt('effort', 'high');
  if (!file || !focus) { console.error(`usage: openai-gpt-reviewer.mjs ${cmd} <file> [--effort high|xhigh] --focus "<text>"`); process.exit(2); }
  if (!['high', 'xhigh'].includes(effort)) { console.error('effort must be high or xhigh'); process.exit(2); }
  const abs = path.resolve(file);
  const prompt = (cmd === 'plan'
    ? `Read ${abs} and critique the plan in it. Do NOT run git. ${focus}`
    : `Read ${abs} and review the diff in it. Do NOT run git — read the patch only. ${focus}`) + skillsBlock();
  if (argv.includes('--print-prompt')) { process.stdout.write(prompt + '\n'); process.exit(0); }   // dry run
  const C = companion();
  const r = spawnSync('node', [C, 'task', '--json', '--effort', effort, '--background', prompt],
                      { encoding: 'utf8', env: cleanEnv(), cwd: process.cwd() });
  let id = null; try { id = JSON.parse(r.stdout).jobId; } catch {}
  if (!id) { console.error('launch failed:', (r.stderr || r.stdout || '').slice(0, 400)); process.exit(1); }
  const j = jobs(); j[id] = { cwd: process.cwd(), kind: cmd, effort, ts: new Date().toISOString() };
  try { writeFileSync(STATE, JSON.stringify(j, null, 1)); } catch {}
  console.log(id);
  console.log(`launched (${cmd}, effort ${effort}). Then: node ${process.argv[1]} wait ${id}`);
} else if (cmd === 'wait') {
  const id = argv[1]; if (!id) { console.error('usage: openai-gpt-reviewer.mjs wait <job-id>'); process.exit(2); }
  const C = companion();
  const cwd = (jobs()[id] || {}).cwd || process.cwd();
  const deadline = Date.now() + 25 * 60 * 1000;
  for (;;) {
    const res = spawnSync('node', [C, 'result', id], { encoding: 'utf8', cwd, env: cleanEnv() });
    const out = (res.stdout || '') + (res.stderr || '');
    if (!/No job found|still running|pending|queued/i.test(out) && out.trim()) { process.stdout.write(out.endsWith('\n') ? out : out + '\n'); process.exit(0); }
    if (Date.now() > deadline) { console.error(`timed out waiting for ${id} — report "WITHOUT cross-model pass"`); process.exit(3); }
    spawnSync('sleep', ['30']);
  }
} else {
  console.error('usage: openai-gpt-reviewer.mjs plan|diff <file> [--effort high|xhigh] --focus "<text>" [--skill <SKILL.md>]... [--print-prompt]  |  pair <patchA> <patchB> --focus "<spec>" [--skill ...]  |  wait <job-id>');
  process.exit(2);
}
