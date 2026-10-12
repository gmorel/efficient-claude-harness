#!/usr/bin/env node
// Remote coding job runner — submits work to bounded Claude worker, applies patch,
// writes ledger row. Minimal diff, match existing style, do not invent APIs.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime data (logs, ledgers, job state) lives OUTSIDE the plugin: the install
// directory changes on every update. Resolution order: HARNESS_DATA_DIR, then
// CLAUDE_PLUGIN_DATA (the agents pass it in), then ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');

const LEDGER = process.env.DELEGATE_LEDGER
  || path.join(DATA_DIR, 'delegate.jsonl');
const DELEGATE_CMD = process.env.DELEGATE_CMD
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'delegate.mjs');
const DELEGATE_CONFIG = process.env.DELEGATE_CONFIG
  || path.join(homedir(), '.config', 'claude-delegate', 'config.json');

const MAX_FILES = 40;
const MAX_BYTES = 4 * 1024 * 1024;

// Secret patterns: filenames and content.
const SECRET_FILES = /^(\.env(\.[a-z0-9_]+)?|.*\.(pem|key|p12|pfx|keystore|kdbx)|(id_rsa|id_ed25519).*|\.netrc|\.npmrc|credentials[^/]*\.json)$/i;
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{12,}['"]/i,
];

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

function sha(v) {
  return createHash('sha256').update(String(v ?? ''), 'utf8').digest('hex').slice(0, 12);
}

function writeLedger(row) {
  try {
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    // Never break the session.
  }
}

async function run(args) {
  const f = flags(args);
  const workspace = f.workspace;
  const taskFile = f.task;
  const filesList = f.files;
  const profile = f.profile ?? 'implement';
  const model = f.model ?? 'opus';
  const effort = f.effort ?? 'medium';
  const testCmd = f['test-cmd'];
  const dryRun = f['dry-run'];
  let sessionId = process.env.CLAUDE_SESSION_ID || null;

  const row = {
    kind: 'delegate_job',
    ts: new Date().toISOString(),
    job_id: null,
    workspace: workspace ? path.basename(workspace) : null,
    profile,
    model,
    effort,
    files_sent: 0,
    bytes_sent: 0,
    task_len: 0,
    task_sha: null,
    status: null,
    tools: {},
    edits: 0,
    new_files: 0,
    applied: false,
    tests_before: null,
    tests_after: null,
    duration_ms: 0,
    outcome: null,
    error: null,
    session_id: sessionId,
  };

  try {
    if (!workspace || !taskFile || !filesList) {
      console.error('Usage: node remote-run.mjs run --workspace <dir> --task <file> --files a.ts,b.ts');
      process.exit(1);
    }

    const start = Date.now();

    // Validate and read files.
    const filePaths = filesList.split(',').map(p => p.trim()).filter(Boolean);
    if (filePaths.length > MAX_FILES) {
      row.outcome = 'too_big';
      writeLedger(row);
      console.error(`Too many files: ${filePaths.length} > ${MAX_FILES}`);
      process.exit(3);
    }

    let totalBytes = 0;
    const files = [];
    const editedFiles = [];

    for (const p of filePaths) {
      // Check for .. and leading /.
      if (p.startsWith('/') || p.includes('..')) {
        row.outcome = 'bad_files';
        writeLedger(row);
        console.error(`Bad path: ${p}`);
        process.exit(3);
      }

      const abs = path.resolve(workspace, p);
      if (!existsSync(abs)) {
        row.outcome = 'bad_files';
        writeLedger(row);
        console.error(`Missing file: ${p}`);
        process.exit(3);
      }

      // Check for secrets in filename.
      const basename = path.basename(p);
      if (SECRET_FILES.test(basename)) {
        row.outcome = 'refused_secret';
        writeLedger(row);
        console.error(`Refused secret (filename): ${p}`);
        process.exit(2);
      }

      // Read and check content.
      const content = readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of SECRET_CONTENT) {
          if (pattern.test(line)) {
            row.outcome = 'refused_secret';
            writeLedger(row);
            console.error(`Refused secret (content): ${p}:${i + 1}`);
            process.exit(2);
          }
        }
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      totalBytes += bytes;
      files.push({ path: p, content, bytes });
      editedFiles.push(p);
    }

    if (totalBytes > MAX_BYTES) {
      row.outcome = 'too_big';
      writeLedger(row);
      console.error(`Total too large: ${totalBytes} > ${MAX_BYTES}`);
      process.exit(3);
    }

    row.files_sent = files.length;
    row.bytes_sent = totalBytes;

    // Read task file.
    const taskPath = path.resolve(workspace, taskFile);
    if (!existsSync(taskPath)) {
      row.outcome = 'bad_files';
      writeLedger(row);
      console.error(`Task file not found: ${taskFile}`);
      process.exit(3);
    }
    const taskContent = readFileSync(taskPath, 'utf8');
    row.task_len = taskContent.length;
    row.task_sha = sha(taskContent);

    // Tests before.
    if (testCmd) {
      try {
        execSync(testCmd, { cwd: workspace, timeout: 10 * 60 * 1000, stdio: 'inherit' });
        row.tests_before = 'pass';
      } catch {
        row.tests_before = 'fail';
      }
    }

    // Submit job.
    let jobId = null;
    let submitOutput = '';
    try {
      submitOutput = execSync(
        `node "${DELEGATE_CMD}" submit --profile "${profile}" --task "${taskFile}" --files "${filesList}" --model "${model}" --effort "${effort}"`,
        { cwd: workspace, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = submitOutput.match(/submitted\s+([a-f0-9-]+)\s+/);
      if (!match) throw new Error('No job ID in output');
      jobId = match[1];
      row.job_id = jobId;
    } catch (e) {
      row.outcome = 'remote_failed';
      row.error = String(e.message || e).slice(0, 200);
      row.duration_ms = Date.now() - start;
      writeLedger(row);
      console.error('Submit failed:', e.message);
      process.exit(4);
    }

    console.log(`Submitted ${jobId}`);

    // Wait for job.
    try {
      execSync(`node "${DELEGATE_CMD}" wait "${jobId}"`, { cwd: workspace, stdio: 'inherit' });
    } catch (e) {
      row.outcome = 'remote_failed';
      row.error = String(e.message || e).slice(0, 200);
      row.duration_ms = Date.now() - start;
      writeLedger(row);
      console.error('Wait failed:', e.message);
      process.exit(4);
    }

    // Read job.json to check status.
    const jobPath = path.join(workspace, '.delegate', jobId, 'job.json');
    const job = JSON.parse(readFileSync(jobPath, 'utf8'));
    row.status = job.status;

    if (job.status !== 'succeeded') {
      row.outcome = 'remote_failed';
      row.error = (job.error || 'Unknown error').slice(0, 200);
      row.duration_ms = Date.now() - start;
      writeLedger(row);
      console.error(`Job failed: ${job.status}`);
      if (job.error) console.error(`Error: ${job.error}`);
      process.exit(4);
    }

    // Count tools and edits from toolLog.
    if (job.toolLog) {
      for (const t of job.toolLog) {
        row.tools[t.tool] = (row.tools[t.tool] || 0) + t.count;
      }
    }

    // Count edits and new files from artifacts.
    if (job.artifacts) {
      for (const a of job.artifacts) {
        if (a.isNew) row.new_files++;
        else row.edits++;
      }
    }

    // Apply patch.
    const applyCmd = dryRun
      ? `node "${DELEGATE_CMD}" apply "${jobId}" --dry-run`
      : `node "${DELEGATE_CMD}" apply "${jobId}"`;

    try {
      execSync(applyCmd, { cwd: workspace, stdio: 'inherit' });
      if (!dryRun) row.applied = true;
    } catch (e) {
      row.outcome = dryRun ? 'dry_run' : 'stale';
      row.duration_ms = Date.now() - start;
      writeLedger(row);
      console.error('Apply failed:', e.message);
      process.exit(dryRun ? 0 : 5);
    }

    if (dryRun) {
      row.outcome = 'dry_run';
      row.duration_ms = Date.now() - start;
      writeLedger(row);
      console.log('\nDry run completed. No files written.');
      process.exit(0);
    }

    // Tests after.
    if (testCmd) {
      try {
        execSync(testCmd, { cwd: workspace, timeout: 10 * 60 * 1000, stdio: 'inherit' });
        row.tests_after = 'pass';
      } catch {
        row.tests_after = 'fail';
      }
    }

    // Determine outcome.
    if (row.tests_after === null) {
      row.outcome = 'applied_unverified';
    } else if (row.tests_after === 'pass') {
      row.outcome = 'worked';
    } else {
      row.outcome = 'bad_patch';
    }

    row.duration_ms = Date.now() - start;
    writeLedger(row);

    // Print summary and UNDO line.
    console.log(`\n=== Result ===`);
    console.log(`Job: ${jobId}`);
    console.log(`Outcome: ${row.outcome}`);
    console.log(`Tests: before=${row.tests_before} after=${row.tests_after}`);
    console.log(`Artifacts in ${workspace}/.delegate/${jobId}/artifacts`);
    console.log(`\nUNDO: git checkout -- ${editedFiles.join(' ')}`);
    if (testCmd) {
      console.log('the worker ran nothing — the only evidence of correctness is the test command above');
    } else {
      console.log('the worker ran nothing and no test command was given — nothing here is evidence of correctness');
    }

    process.exit(row.outcome === 'bad_patch' ? 6 : 0);
  } catch (e) {
    row.outcome = 'error';
    row.error = String(e.message || e).slice(0, 200);
    row.duration_ms = Date.now() - (row.duration_ms || 0);
    writeLedger(row);
    console.error('Unexpected error:', e.message);
    process.exit(7);
  }
}

function doctorLine(name, status, detail) {
  if (status === 'OK') return `${name.padEnd(20)}OK  (${detail})`;
  return `${name.padEnd(20)}FAIL  ${detail}`;
}

async function doctor() {
  let failed = false;

  if (!existsSync(DELEGATE_CONFIG)) {
    console.log(doctorLine('config', 'FAIL', `not found: ${DELEGATE_CONFIG}`));
    failed = true;
  } else {
    console.log(doctorLine('config', 'OK', DELEGATE_CONFIG));
  }

  if (!existsSync(DELEGATE_CMD)) {
    console.log(doctorLine('delegate helper', 'FAIL', `not found: ${DELEGATE_CMD}`));
    failed = true;
  } else {
    console.log(doctorLine('delegate helper', 'OK', DELEGATE_CMD));
  }

  let baseUrl = null;
  if (existsSync(DELEGATE_CONFIG)) {
    try {
      const config = JSON.parse(readFileSync(DELEGATE_CONFIG, 'utf8'));
      baseUrl = config.baseUrl;
    } catch (e) {
      console.log(doctorLine('service', 'FAIL', e.message || String(e)));
      process.exit(1);
    }
  }

  if (!baseUrl) {
    console.log(doctorLine('service', 'FAIL', 'no baseUrl in config'));
    process.exit(1);
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(doctorLine('service', 'FAIL', String(res.status)));
      process.exit(1);
    }
    const body = await res.json();
    const checks = body.checks && typeof body.checks === 'object' ? body.checks : {};
    const passing = [];
    const failing = [];
    for (const [name, value] of Object.entries(checks)) {
      if (value) passing.push(name);
      else failing.push(name);
    }
    if (failing.length > 0) {
      console.log(doctorLine('service', 'FAIL', failing.join(', ')));
      process.exit(1);
    }
    console.log(doctorLine('service', 'OK', passing.join(', ')));
  } catch (e) {
    console.log(doctorLine('service', 'FAIL', e.message || String(e)));
    process.exit(1);
  }

  process.exit(failed ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') await run(rest);
else if (command === 'doctor') await doctor();
else {
  console.error('Usage: node remote-run.mjs run|doctor ...');
  process.exit(1);
}
