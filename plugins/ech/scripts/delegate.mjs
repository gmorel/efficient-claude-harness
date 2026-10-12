#!/usr/bin/env node
// Packages files, submits a job, collects artifacts, and applies them only after the
// local files still match what was sent. Never prints file bodies to stdout.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

// DELEGATE_CONFIG overrides the location, the same variable remote-run.mjs honours.
const CONFIG = process.env.DELEGATE_CONFIG || join(homedir(), '.config/claude-delegate/config.json');
const OUT = '.delegate';
const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const die = (msg) => { console.error(msg); process.exit(1); };

function config() {
  if (!existsSync(CONFIG)) die(`Not configured. Expected ${CONFIG} with { "baseUrl": "...", "apiKey": "..." }`);
  const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
  if (!c.baseUrl || !c.apiKey) die(`${CONFIG} needs both baseUrl and apiKey`);
  return c;
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

async function call(path, init = {}) {
  const c = config();
  const res = await fetch(`${c.baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

const PROFILES = {
  implement: 'Make the change in the files provided. Edit them in place. Do not create files you were not asked for.',
  review: 'Review the code provided. Report findings with file, line, severity and a concrete failure scenario. Change nothing.',
  tests: 'Add tests for the behaviour described, in the existing test style. Do not change the implementation.',
  analyse: 'Analyse the problem. Rank the hypotheses and name the single next check that would discriminate between them. Change nothing.',
};

async function submit(args) {
  const f = flags(args);
  const profile = f.profile ?? 'implement';
  if (!PROFILES[profile]) die(`Unknown profile ${profile}. One of: ${Object.keys(PROFILES).join(', ')}`);
  if (!f.task) die('--task <file> is required (a file containing the task and its acceptance criteria)');
  if (!f.files) die('--files a.ts,b.ts is required');

  const root = process.cwd();
  const paths = String(f.files).split(',').map((p) => p.trim()).filter(Boolean);
  const files = paths.map((p) => {
    const abs = resolve(root, p);
    if (relative(root, abs).startsWith('..')) die(`Refusing a path outside the repository: ${p}`);
    if (!existsSync(abs)) die(`No such file: ${p}`);
    const content = readFileSync(abs, 'utf8');
    return { path: relative(root, abs), content, sha256: sha(content) };
  });

  const task = readFileSync(resolve(root, String(f.task)), 'utf8');
  const prompt = [
    PROFILES[profile],
    '',
    'You have a disposable copy of the files below and nothing else. You cannot run anything.',
    'State your assumptions and anything you needed and did not receive.',
    '',
    task,
    '',
    `Files in your workspace: ${files.map((x) => x.path).join(', ')}`,
  ].join('\n');

  const body = { prompt, files };
  if (f['max-turns']) body.maxTurns = Number(f['max-turns']);
  // --model / --effort choose the worker's model and effort (e.g. --model claude-opus-5-5 --effort high); omitted, the service default runs.
  if (f.model) body.model = String(f.model);
  if (f.effort) body.effort = String(f.effort);
  const { status, body: job } = await call('/v1/jobs', { method: 'POST', body: JSON.stringify(body) });

  if (status === 429) die('Both slots are busy. Do something else or run it locally — do not poll for a slot.');
  if (status !== 202) die(`Submit failed (${status}): ${JSON.stringify(job).slice(0, 300)}`);
  const bytes = files.reduce((n, x) => n + Buffer.byteLength(x.content, 'utf8'), 0);
  console.log(`submitted ${job.id}  profile=${profile}  files=${files.length}  bytes=${bytes}  maxTurns=${job.maxTurns}`);
  mkdirSync(join(OUT, job.id), { recursive: true });
  writeFileSync(join(OUT, job.id, 'request.json'), JSON.stringify({ profile, root, files: files.map(({ path, sha256 }) => ({ path, sha256 })) }, null, 2));
}

async function wait(args) {
  const id = args[0];
  if (!id) die('usage: wait <job-id>');
  const deadline = Date.now() + 60 * 60 * 1000;
  let delay = 2000;
  for (;;) {
    const { status, body: job } = await call(`/v1/jobs/${id}`);
    if (status === 404) die('No such job for this key.');
    if (status !== 200) die(`Status failed (${status})`);
    if (!['queued', 'running'].includes(job.status)) return report(id, job);
    if (Date.now() > deadline) die('Gave up after an hour. The job may still be running; check again.');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15000);
  }
}

function report(id, job) {
  const dir = join(OUT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job, null, 2));
  console.log(`status: ${job.status}`);
  if (job.error) console.log(`error: ${job.error}`);
  if (job.result) console.log(`\n--- worker summary ---\n${job.result}\n`);
  for (const t of job.toolLog ?? []) {
    console.log(`tool: ${t.tool} x${t.count}${t.targets ? ` -> ${t.targets.join(' ')}` : ''}`);
  }
  for (const a of job.artifacts ?? []) {
    const target = join(dir, 'artifacts', a.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, a.content, 'utf8');
    console.log(`${a.isNew ? 'NEW  ' : 'EDIT '} ${a.path}`);
  }
  if ((job.artifacts ?? []).some((a) => a.isNew)) {
    console.log('\nNEW files were invented by the worker. Read every line before applying: a new hook, CI file or script runs on your machine.');
  }
  console.log(`\nartifacts in ${dir}/artifacts — nothing has been applied. Next: apply ${id} --dry-run`);
}

function apply(args) {
  const id = args[0];
  if (!id) die('usage: apply <job-id> [--dry-run]');
  const f = flags(args);
  const dir = join(OUT, id);
  const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
  const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
  if (job.status !== 'succeeded') die(`Job is ${job.status}; nothing to apply.`);

  const sent = new Map(request.files.map((x) => [x.path, x.sha256]));
  const plan = [];
  for (const a of job.artifacts ?? []) {
    const abs = resolve(request.root, a.path);
    if (relative(request.root, abs).startsWith('..')) die(`Refusing a path outside the repository: ${a.path}`);
    if (a.isNew) {
      if (existsSync(abs)) die(`${a.path} is flagged new but already exists locally. Refusing.`);
      plan.push({ abs, path: a.path, content: a.content, kind: 'create' });
      continue;
    }
    const expected = sent.get(a.path);
    if (!expected) die(`${a.path} came back edited but was never sent. Refusing.`);
    const current = sha(readFileSync(abs, 'utf8'));
    if (current !== expected) die(`${a.path} changed locally since it was sent. Re-send the job instead of forcing this.`);
    plan.push({ abs, path: a.path, content: a.content, kind: 'edit' });
  }

  for (const p of plan) console.log(`${p.kind === 'create' ? 'create' : 'edit  '} ${p.path}`);
  if (f['dry-run']) {
    console.log('\ndry run, nothing written. Read the artifacts, then run apply without --dry-run.');
    return;
  }
  for (const p of plan) { mkdirSync(dirname(p.abs), { recursive: true }); writeFileSync(p.abs, p.content, 'utf8'); }
  console.log(`\napplied ${plan.length} file(s). The worker never ran anything: run the tests now.`);
}

const [command, ...rest] = process.argv.slice(2);
const commands = { submit, wait, apply };
if (!commands[command]) die('usage: delegate.mjs submit|wait|apply ...');
await commands[command](rest);
