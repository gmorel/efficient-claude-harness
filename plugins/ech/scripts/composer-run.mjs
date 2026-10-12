#!/usr/bin/env node
/**
 * composer-run.mjs — run a Composer task and record what it cost, in time and money.
 *
 * Node, not bash, deliberately: this has to run on Windows too, and
 * Claude Code already guarantees a Node runtime. (Same reason the codex plugin
 * ships .mjs scripts.)
 *
 * Subcommands:
 *   code   — run an engine on a brief, log the result
 *   check  — decide MERGE / MERGE_UNVERIFIED / REJECT / ESCALATE deterministically
 *   doctor — free environment check
 *
 * Everything lands in one JSONL file so timing, cost and gate outcomes can be
 * read back later without re-running anything.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFile, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Runtime data (logs, ledgers, job state) lives OUTSIDE the plugin: the install
// directory changes on every update. Resolution order: HARNESS_DATA_DIR, then
// CLAUDE_PLUGIN_DATA (the agents pass it in), then ~/.claude/harness-data.
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');

/**
 * Locate an executable on PATH, cross-platform.
 *
 * NOT `shell: true`. On Windows, Node's spawn will not resolve a `.cmd`/`.bat`
 * shim and fails with ENOENT — the obvious fix is shell:true, but that would
 * re-open the injection hole this script deliberately avoids by passing an args
 * array (the brief is arbitrary user text and reaches argv directly). So
 * resolve the real path ourselves and keep spawning without a shell.
 *
 * NOTE: not exercised on Windows in CI; `doctor` checks the environment there.
 */
function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (existsSync(p)) return p; } catch { /* unreadable dir */ }
    }
  }
  return null;
}

// Check cursor.com/docs/models-and-pricing when updating.
// USD per million tokens. Fast is the SAME model at 6x the price — Cursor's
// own wording is "a faster variant with the same intelligence".
const RATES = {
  'composer-2.5':      { in: 0.50, out: 2.50 },
  'composer-2.5-fast': { in: 3.00, out: 15.00 },
};

const LOG = process.env.COMPOSER_LANE_LOG
  || path.join(DATA_DIR, 'runs.jsonl');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const args_ = (name) => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));

/**
 * Skills travel with the brief. A Claude Code SKILL.md is prose any engine can read
 * (Composer, Claude, Codex all read files), so the caller names the 0-3 that bear on the
 * task with --skill <path> and the block below is appended to the brief. The engine is
 * told what to skip: Claude-only tooling means nothing to Composer or Codex.
 */
function skillsBlock(paths) {
  if (!paths.length) return '';
  return '\n\nRelevant skills — read each file below FIRST and apply its instructions to this task. '
    + 'They were written for Claude Code: ignore anything about Claude-only tooling (Agent, Skill, Artifact, hooks, $ARGUMENTS, allowed-tools) and follow the substance.\n'
    + paths.map((f) => `- ${f}`).join('\n') + '\n';
}

async function log(record) {
  await mkdir(path.dirname(LOG), { recursive: true });
  await appendFile(LOG, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Cost in USD, or null when we cannot know it.
 *
 * Returns null — never 0 — when the rate or the usage block is missing. A
 * missing usage block means "we don't know what this cost", and reporting that
 * as $0 understates real spend. (Found by the OpenAI review pass: a run that
 // (A run with a large token count once logged as $0 because of this.)
 */
function cost(model, usage) {
  const r = RATES[model];
  if (!r || !usage) return null;
  const i = usage.inputTokens, o = usage.outputTokens;
  if (typeof i !== 'number' || typeof o !== 'number') return null;
  return +(((i / 1e6) * r.in) + ((o / 1e6) * r.out)).toFixed(6);
}

/**
 * Branch names reach a shell in the merge step, and git accepts characters a
 * shell also interprets — `composer/x;id` is a VALID ref name (verified). Allow
 * only an unambiguous charset so nothing downstream has to get quoting right.
 *
 * No `/` either: cursor-agent's own --worktree validator is STRICTER than git's
 * ref rules and rejects slashes outright ("Use only letters, numbers, '.', '_',
 * or '-'"). Found by real execution  — the obvious `composer/<slug>`
 * convention fails at the CLI. Match its rule exactly.
 */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function runCode() {
  // Default is standard, NOT fast. Fast measured 1.05x (a tie) on real-repo
  // In the first deployment Fast cost several times more per task for no measured speed gain.
  const model     = arg('model', 'composer-2.5');
  const workspace = arg('workspace', process.cwd());
  const branch    = arg('branch');
  const base      = arg('base');      // start the worktree from this commit (default HEAD)
  const shadow    = arg('shadow');    // e.g. opus@medium — run the same brief in a throwaway worktree, save the pair
  const briefFile = arg('brief');
  const taskId    = arg('task', 'untitled');

  // IN-PLACE IS THE DEFAULT.
  //
  // The worktree was originally mandatory. It cost 30ms, which is nothing — but
  // it also forced a machine commit ("composer: <task>") plus a --no-ff merge,
  // turning one logical change into two commits with a message that says
  // nothing. Verified: run in place, Composer does NOT touch git
  // (HEAD unchanged), leaves exactly the briefed files modified, and
  // `git checkout -- .` restores a clean tree. Same safety, better history —
  // the caller commits once, with a real message.
  //
  // Worktrees are still required for `race` (parallel arms cannot share a tree)
  // and are worth opting into when the working tree is dirty or the run is
  // backgrounded. Pass --branch to get one.
  const inPlace = !branch;
  if (!briefFile) { console.error('composer-run: --brief <file> is required'); process.exit(2); }
  if (!inPlace && !SAFE_BRANCH.test(branch)) {
    console.error(`composer-run: unsafe branch name ${JSON.stringify(branch)} — allowed: letters, digits, . _ - (no slash — cursor-agent rejects it)`);
    process.exit(2);
  }
  // model@effort routes to Claude Code instead of cursor-agent. Effort is pinned
  // in the name so a timing is never reported without it. The earlier claim that
  // effort was "1.9x-5.1x monotonic" is withdrawn: that sweep had
  // one run per cell and every gap except `max` sat inside single-run noise.
  const CLAUDE_CODER = model.match(/^(opus|sonnet)@(low|medium|high|xhigh|max)$/);
  // codex@<effort> routes to OpenAI Codex through the codex plugin, WITH write
  // access, in place — a coding engine for the guarded lane that draws on an
  // OpenAI subscription instead of the Claude one. The review agents keep using
  // the plugin read-only; this is the one place --write is passed on purpose.
  const CODEX_CODER = model.match(/^codex@(low|medium|high|xhigh)$/);
  if (!CLAUDE_CODER && !CODEX_CODER && !RATES[model]) {
    console.error(`composer-run: refusing unknown model ${JSON.stringify(model)}. `
      + `Known: ${Object.keys(RATES).join(', ')}, or opus@<effort> / sonnet@<effort>.\n`
      + `(cursor-agent treats an unrecognised word as a PROMPT and starts a billed session — verified.)`);
    process.exit(2);
  }

  let brief;
  try { brief = await readFile(briefFile, 'utf8'); }
  catch { console.error(`composer-run: --brief expects a PATH to a file containing the brief (got ${JSON.stringify(briefFile.slice(0, 60))})`); process.exit(2); }
  const skills = args_('skill').map((f) => path.resolve(f));
  for (const f of skills) if (!existsSync(f)) { console.error(`composer-run: --skill: no such file ${f}`); process.exit(2); }
  brief += skillsBlock(skills);
  if (has('print-brief')) { process.stdout.write(brief); process.exit(0); }   // dry run: show what the engine would get


  // Strip credentials from the child environment. A spawned Composer inherits
  // this shell, and project secrets frequently live only in env.
  //
  // KEEP CURSOR_API_KEY: it matches /_KEY/ but it is the credential
  // cursor-agent needs to authenticate. Stripping it broke the API-key login
  // path the install guide recommends (verified by probe).

  // A dirty tree is fine — the engine does not need a clean one. What needs
  // care is the UNDO: `git checkout -- .` would wipe the user's own uncommitted
  // work along with the engine's. So snapshot the tree first (`git stash create`
  // records the working state without touching it) and undo by restoring only
  // the files the engine touched from that snapshot.
  let preSha = null; const preUntracked = new Set();
  if (inPlace) {
    const st = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
    if (st.status !== 0) { console.error('composer-run: not a git repository — refusing'); process.exit(2); }
    for (const l of (st.stdout || '').split('\n')) if (l.startsWith('??')) preUntracked.add(l.slice(3).trim());
    const sc = spawnSync('git', ['-C', workspace, 'stash', 'create'], { encoding: 'utf8' });
    preSha = (sc.stdout || '').trim() || (spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim() || null;
  }

  const KEEP = new Set(['CURSOR_API_KEY']);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (KEEP.has(k)) continue;
    if (/^ANTHROPIC_API_KEY$/.test(k) || /(PASS|TOKEN|SECRET|LOGIN|_KEY)/i.test(k)) delete env[k];
  }

  // --sandbox enabled: a git worktree is a working-directory convention, NOT a
  // security boundary. Both review passes independently flagged that --force
  // grants unrestricted shell with the user's real permissions, so an absolute
  // path write or an npm postinstall escapes the worktree while every git check
  // stays green. The sandbox is the only actual containment on offer.
  const sandbox = arg('sandbox', 'enabled');

  const args = [
    '-p', '--force', '--trust',
    '--sandbox', sandbox,
    ...(inPlace ? [] : ['-w', branch]),
    '--model', model,
    '--output-format', 'json',
    '--workspace', workspace,
    brief,
    skills,
  ];

  let codexCompanion = null;
  if (CODEX_CODER) {
    const f = spawnSync('sh', ['-c', `find ${JSON.stringify(path.join(homedir(), '.claude', 'plugins', 'cache'))} -path "*codex*/scripts/codex-companion.mjs" 2>/dev/null | sort -V | tail -1`], { encoding: 'utf8' });
    codexCompanion = (f.stdout || '').trim() || null;
    if (!codexCompanion) { console.error('composer-run: codex plugin not installed on this machine — cannot run codex@<effort>'); process.exit(2); }
  }
  const bin = CODEX_CODER ? process.execPath : which(CLAUDE_CODER ? 'claude' : 'cursor-agent');
  if (!bin) {
    console.error(`composer-run: ${CLAUDE_CODER ? 'claude' : 'cursor-agent'} not found on PATH.\n`
      + 'Run `composer-run.mjs doctor` to diagnose.');
    process.exit(1);
  }

  // An optional routing hook (not shipped with this plugin) honours this and
  // would otherwise block a Claude coder from editing anything.
  if (CLAUDE_CODER) env.COMPOSER_LANE_OFF = '1';

  const spawnArgs = CODEX_CODER
    ? [codexCompanion, 'task', '--json', '--write', '--fresh', '--effort', CODEX_CODER[1], brief]
    : CLAUDE_CODER
    ? ['-p', '--model', CLAUDE_CODER[1], '--effort', CLAUDE_CODER[2],
       '--output-format', 'json', '--permission-mode', 'acceptEdits', brief]
    : args;
  // cursor-agent creates its own worktree via -w. A Claude coder has no such
  // flag, so when --branch is given we must create the worktree ourselves and
  // run inside it — otherwise the "isolated" run would edit the main tree.
  let claudeCwd = workspace;
  if ((CLAUDE_CODER || CODEX_CODER) && !inPlace) {
    const wt = path.join(tmpdir(), `aicoder-${branch}`);
    spawnSync('git', ['-C', workspace, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
    const add = spawnSync('git', ['-C', workspace, 'worktree', 'add', '-q', '-b', branch, wt, ...(base ? [base] : [])],
                          { encoding: 'utf8' });
    if (add.status !== 0) {
      console.error(`composer-run: could not create worktree for ${branch}: ${(add.stderr||'').trim()}`);
      process.exit(1);
    }
    claudeCwd = wt;
  }
  const spawnOpts = (CODEX_CODER || CLAUDE_CODER) ? { cwd: claudeCwd, env } : { env };

  const t0 = performance.now();
  const child = spawn(bin, spawnArgs, spawnOpts);

  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  const exitCode = await new Promise((res) => {
    child.on('close', res);
    child.on('error', () => res(-1));   // e.g. cursor-agent not on PATH
  });
  const wallMs = Math.round(performance.now() - t0);

  // With -w the CLI prints a "Using worktree: ..." preamble before the JSON, so
  // stdout as a whole is not valid JSON.
  //
  // Match on type === 'result' specifically, NOT merely "the last parseable
  // object". Taking the last one let a trailing {"type":"warning","usage":{}}
  // (A run with a large token count once logged as $0 because of this.)
  // ok=true, cost $0, session null. (OpenAI review pass, reproduced .)
  let parsed = null;
  for (const line of out.split('\n').map(s => s.trim()).filter(Boolean).reverse()) {
    if (!line.startsWith('{')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'result') { parsed = o; break; }
  }

  const usage  = parsed?.usage ?? null;
  let   failed = CODEX_CODER ? exitCode !== 0 : (exitCode !== 0 || !parsed || parsed.is_error === true);
  // Best-effort id from the codex runtime's JSON, if any; cost is not exposed.
  let codexId = null;
  if (CODEX_CODER) { try { const o = JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop() || 'null'); codexId = o?.threadId ?? o?.sessionId ?? o?.jobId ?? null; } catch {} }

  // Prove the worktree is real before anyone acts on it. A leftover directory
  // at ~/.cursor/worktrees/<repo>/<branch> can outlive its repository and be
  // reused by name, serving stale files while git knows nothing about it
  // (verified). Record the branch tip so the merger can prove it
  // tests the same commit it merges.
  const git = (...a) => {
    const r = spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  let branchSha = null, worktreePath = null, committed = false;
  if (!failed && inPlace) {
    // Deliberately leave the changes UNCOMMITTED. The caller reviews them and
    // commits with a message describing the change, not "composer: <task>".
    const d = spawnSync('git', ['-C', workspace, 'diff', '--quiet', preSha || 'HEAD'], { encoding: 'utf8' });
    const st = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
    const newU = (st.stdout || '').split('\n').filter(l => l.startsWith('??') && !preUntracked.has(l.slice(3).trim()));
    if (d.status === 0 && !newU.length) {
      failed = true;
      err += '\nComposer reported success but changed nothing in the working tree.';
    }
  } else if (!failed) {
    // Composer is told not to run git, so it leaves its work UNCOMMITTED in the
    // worktree and the branch tip stays equal to the base commit. Verified
    // : an end-to-end run reported BRANCH_SHA == main, the branch had
    // zero commits, and `git merge <branch>` would have merged nothing. The
    // downstream "did I test what I merge?" check compared two identical
    // commits that contained none of the work — it passed vacuously.
    //
    // Commit here, in the worktree, so the branch actually carries the change
    // and its SHA means something. The gate must never have to do this itself.
    const wtRoot = git('worktree', 'list', '--porcelain') || '';
    const blk = wtRoot.split('\n\n').find(b => b.includes(`branch refs/heads/${branch}`));
    const wtDir = blk ? (blk.match(/^worktree (.+)$/m)?.[1] ?? null) : null;
    if (wtDir) {
      const inWt = (...a) => spawnSync('git', ['-C', wtDir, ...a], { encoding: 'utf8' });
      const dirty = (inWt('status', '--porcelain').stdout || '').trim();
      if (dirty) {
        inWt('add', '-A');
        const c = inWt('-c', 'user.email=composer@lane', '-c', 'user.name=composer-lane',
                       'commit', '-m', `composer: ${taskId}`);
        committed = c.status === 0;
        if (!committed) {
          failed = true;
          err += `\ncould not commit Composer's work in ${wtDir}: ${(c.stderr||'').trim()}`;
        }
      }
    }
    branchSha = git('rev-parse', '--verify', `refs/heads/${branch}`);
    const wt = git('worktree', 'list', '--porcelain') || '';
    const m = wt.split('\n\n').find(b => b.includes(`branch refs/heads/${branch}`));
    worktreePath = m ? (m.match(/^worktree (.+)$/m)?.[1] ?? null) : null;
    if (!branchSha || !worktreePath) {
      failed = true;
      err += `\nworktree isolation failed: branch=${branchSha ? 'ok' : 'MISSING'} `
           + `registered-worktree=${worktreePath ? 'ok' : 'MISSING'}. `
           + `Remove ~/.cursor/worktrees/*/${branch} and retry.`;
    }
  }

  // ── Per-run diff footprint ────────────────────────────────────────────────
  // Before this, a run's file count could only be recovered
  // from its branch — which fails for in-place runs (no branch) and over-counts
  // when two runs share one branch. In the first deployment more than half the
  // runs were unrecoverable that way, and matching runs to commits by timestamp
  // produced a demonstrably wrong match — history mining is not a substitute.
  // Capture it at the source.
  //
  // `numstat_complete` is deliberately part of the record: in place, untracked
  // new files appear in the file list but contribute no line counts, so the
  // data says out loud when its own line totals are partial.
  let footprint = { files_changed: null, insertions: null, deletions: null,
                    paths: null, numstat_complete: null };
  if (!failed) {
    const dir = inPlace ? workspace : (worktreePath || workspace);
    const run = (...a) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout : null;
    };
    // in place: work sits uncommitted against HEAD. worktree: we committed it above.
    const raw = inPlace ? run('diff', '--numstat', preSha || 'HEAD')
                        : run('show', '--numstat', '--format=', 'HEAD');
    const rows = (raw || '').split('\n').filter(Boolean).map(l => l.split('\t'));
    let ins = 0, del = 0, binary = false;
    const paths = new Set();
    for (const [a, d, f] of rows) {
      if (!f) continue;
      paths.add(f);
      if (a === '-' || d === '-') { binary = true; continue; }
      ins += Number(a) || 0; del += Number(d) || 0;
    }
    let untracked = 0; const newFiles = [];
    if (inPlace) {
      const st = run('status', '--porcelain') || '';
      for (const l of st.split('\n')) {
        if (!l.startsWith('??')) continue;
        const f = l.slice(3).trim();
        if (!preUntracked.has(f)) { untracked++; paths.add(f); newFiles.push(f); }
      }
      try { writeFileSync(path.join(workspace, '.git', 'coder-lane-last.json'),
        JSON.stringify({ ts: new Date().toISOString(), task: taskId, pre_sha: preSha, paths: [...paths].sort(), new_files: newFiles })); } catch {}
    }
    footprint = {
      files_changed: paths.size,
      insertions: ins,
      deletions: del,
      paths: [...paths].sort().slice(0, 100),
      new_files: newFiles,
      numstat_complete: !binary && untracked === 0,
    };
  }

  const record = {
    ts: new Date().toISOString(),
    phase: 'code',
    task: taskId,
    model,
    effort: CODEX_CODER ? CODEX_CODER[1] : CLAUDE_CODER ? CLAUDE_CODER[2] : 'n/a',
    engine: CODEX_CODER ? 'codex' : CLAUDE_CODER ? 'claude-code' : 'cursor-agent',
    branch: inPlace ? null : branch,
    in_place: inPlace,
    pre_sha: preSha,
    ...footprint,
    branch_sha: branchSha,
    committed,
    worktree: worktreePath,
    sandbox,
    workspace,
    ok: !failed,
    exit_code: exitCode,
    // wall_ms is ours (includes process spawn); duration_ms / duration_api_ms
    // come from the CLI itself and are the precise instrument.
    wall_ms: wallMs,
    duration_ms: parsed?.duration_ms ?? null,
    duration_api_ms: parsed?.duration_api_ms ?? null,
    session_id: parsed?.session_id ?? codexId,
    tokens_in: usage?.inputTokens ?? null,
    tokens_out: usage?.outputTokens ?? null,
    cache_read: usage?.cacheReadTokens ?? null,
    cache_write: usage?.cacheWriteTokens ?? null,
    // Claude Code reports real dollars; cursor arms are priced from the rate card.
    cost_usd: parsed?.total_cost_usd ?? cost(model, usage),
    error: failed ? (err.trim() || parsed?.result || 'unknown failure').slice(0, 500) : null,
  };
  await log(record);

  if (failed) {
    console.error(`FAILED (exit ${exitCode}) — logged. ${record.error}`);
    process.exit(1);
  }

  // Human/agent-readable summary. The agent reports the `result` verbatim.
  console.log(parsed?.result ?? (CODEX_CODER ? out.trim().slice(-1500) : ''));
  console.log('---');
  console.log(`model=${model} branch=${branch} sha=${(branchSha||'').slice(0,8)} sandbox=${sandbox} api_ms=${record.duration_ms} `
    + `tokens=${record.tokens_in}/${record.tokens_out} `
    + `cost=${record.cost_usd === null ? 'unknown' : '$' + record.cost_usd.toFixed(4)} `
    + `session=${record.session_id}`);
  if (inPlace) {
    const st = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
    console.log('CHANGED FILES (by the engine, uncommitted, on your current branch):');
    for (const f of (footprint.paths || [])) console.log(`  ${(footprint.new_files || []).includes(f) ? 'A' : 'M'} ${f}`);
    console.log('Review, then commit with a message describing the change.');
    {
      const nf = footprint.new_files || [];
      const tracked = (footprint.paths || []).filter(f => !nf.includes(f));
      const q = a => a.map(x => JSON.stringify(x)).join(' ');
      const parts = [];
      if (tracked.length) parts.push(`git -C ${workspace} checkout ${(preSha || 'HEAD').slice(0, 12)} -- ${q(tracked)}`);
      if (nf.length) parts.push(`rm -f ${q(nf.map(f => path.join(workspace, f)))}`);
      console.log('UNDO: ' + (parts.join(' && ') || '(nothing to undo)') + '   # only the files the engine touched; your other edits stay');
    }

  // ── Shadow run: the paired measurement on real work ──────────────────────
  // One task in five (the caller rolls it), the same brief is ALSO given to a
  // second engine in a throwaway worktree started from the exact pre-run
  // snapshot. The shadow never ships. Its diff and the primary's are saved as
  // a pair for a blind judge — paired data on the team's own tasks, with no
  // production exposure. This replaces routing the holdout to the expensive
  // lane, which produced unpaired data and spent the expensive engine on work
  // that shipped.
  if (shadow && inPlace && !failed) {
    const sb = `shadow-${taskId}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-');
    console.log(`\nSHADOW: running ${shadow} on the same brief in a throwaway worktree (never ships)…`);
    const r = spawnSync(process.execPath, [process.argv[1], 'code', '--branch', sb, '--base', preSha || 'HEAD',
      '--model', shadow, '--brief', briefFile, '--workspace', workspace, '--task', taskId + '-shadow', ...skills.flatMap((f) => ['--skill', f])],
      { encoding: 'utf8', env: process.env, timeout: 3600000 });
    const g = (...a) => spawnSync('git', ['-C', workspace, ...a], { encoding: 'utf8' }).stdout || '';
    const nf = footprint.new_files || [];
    if (nf.length) spawnSync('git', ['-C', workspace, 'add', '-N', '--', ...nf]);
    const primaryPatch = g('diff', preSha || 'HEAD', '--', ...(footprint.paths || []));
    if (nf.length) spawnSync('git', ['-C', workspace, 'reset', '-q', '--', ...nf]);
    const shadowPatch = g('diff', `${preSha || 'HEAD'}..${sb}`);
    const dir = path.join(path.dirname(LOG), 'shadows'); await mkdir(dir, { recursive: true });
    const stem = path.join(dir, `${taskId}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-'));
    await writeFile(stem + '.primary.patch', primaryPatch, 'utf8');
    await writeFile(stem + '.shadow.patch', shadowPatch, 'utf8');
    await writeFile(stem + '.brief.txt', brief, 'utf8');
    await appendFile(path.join(dir, 'pairs.jsonl'), JSON.stringify({ ts: new Date().toISOString(), task: taskId,
      primary: model, shadow, primary_patch: stem + '.primary.patch', shadow_patch: stem + '.shadow.patch',
      brief: stem + '.brief.txt', shadow_ok: r.status === 0, shadow_lines: shadowPatch.split('\n').length }) + '\n', 'utf8');
    // The worktree may live wherever the engine put it; find it by branch and remove it.
    const wl = g('worktree', 'list', '--porcelain').split('\n\n').find(b => b.includes(`branch refs/heads/${sb}`));
    const wtp = wl ? (wl.match(/^worktree (.+)$/m) || [])[1] : null;
    if (wtp) spawnSync('git', ['-C', workspace, 'worktree', 'remove', '--force', wtp]);
    spawnSync('git', ['-C', workspace, 'branch', '-D', sb]);
    console.log(`SHADOW PAIR saved: ${stem}.{primary,shadow}.patch (shadow ${r.status === 0 ? 'ok' : 'FAILED'}, worktree removed)`);
    console.log(`  judge blind: node ${path.join(HERE, 'openai-gpt-reviewer.mjs')} pair "${stem}.primary.patch" "${stem}.shadow.patch" --focus "<the brief's goal>"`);
  }
  } else {
    console.log(`WORKTREE=${worktreePath}`);
    console.log(`BRANCH_SHA=${branchSha}`);
    console.log('NOT MERGED — see the decision from check.');
  }
}

/**
 * doctor — prove the environment works, without spending a Composer call.
 *
 * This exists because the lane has not been exercised on Windows in CI; run `doctor` first.
 * on Windows. Rather than guess, it exercises the real mechanism (executable
 * resolution, auth, model availability, and an actual git worktree create/
 * remove) and reports exactly what is wrong. Every check is free.
 */
async function runDoctor() {
  const rows = [];
  const add = (name, ok, detail) => { rows.push({ name, ok, detail }); };

  add('platform', true, `${process.platform} ${process.arch}, node ${process.versions.node}`);

  const gitBin = which('git');
  add('git on PATH', !!gitBin, gitBin || 'NOT FOUND — git is mandatory; worktree isolation needs it');

  const bin = which('cursor-agent');
  add('cursor-agent on PATH', !!bin,
    bin || 'NOT FOUND. macOS/Linux: curl https://cursor.com/install -fsS | bash. '
         + 'Windows: use Cursor\'s official PowerShell installer, then reopen the shell so PATH updates.');

  if (bin) {
    const st = spawnSync(bin, ['status'], { encoding: 'utf8' });
    const authed = st.status === 0 && /logged in/i.test((st.stdout || '') + (st.stderr || ''));
    add('authenticated', authed,
      authed ? (st.stdout || '').trim().split('\n')[0]
             : 'Not logged in. The USER must run `cursor-agent login` themselves in a browser. Never do this for them.');

    const ml = spawnSync(bin, ['models'], { encoding: 'utf8' });
    const models = (ml.stdout || '');
    const hasStd = /\bcomposer-2\.5\b/.test(models);
    const hasFast = /composer-2\.5-fast/.test(models);
    add('composer-2.5 available', hasStd, hasStd ? 'yes' : 'NOT in the model list — this is a Cursor plan question, not a bug');
    add('composer-2.5-fast available', hasFast, hasFast ? 'yes (6x the token price of standard)' : 'not listed');
  }

  // The real mechanism, exercised for free: can we make and remove a worktree?
  if (gitBin) {
    const dir = path.join(tmpdir(), `composer-doctor-${process.pid}`);
    const g = (d, ...a) => spawnSync(gitBin, ['-C', d, ...a], { encoding: 'utf8' });
    let ok = false, detail = '';
    try {
      await mkdir(dir, { recursive: true });
      spawnSync(gitBin, ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
      await writeFile(path.join(dir, 'f.txt'), 'x');
      g(dir, 'add', '-A');
      g(dir, '-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'init');
      const wt = path.join(dir, '..', `composer-doctor-wt-${process.pid}`);
      const add1 = g(dir, 'worktree', 'add', '-q', '--detach', wt);
      ok = add1.status === 0 && existsSync(wt);
      detail = ok ? 'created and removed a git worktree successfully'
                  : `git worktree add failed: ${(add1.stderr || '').trim().slice(0, 200)}`;
      g(dir, 'worktree', 'remove', '--force', wt);
    } catch (e) {
      detail = `threw: ${e.message}`;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    add('git worktree works', ok, detail);
  }

  // Can we write the log?
  let logOk = false, logDetail = '';
  try {
    await mkdir(path.dirname(LOG), { recursive: true });
    await appendFile(LOG, '', 'utf8');
    logOk = true; logDetail = LOG;
  } catch (e) { logDetail = `cannot write ${LOG}: ${e.message}`; }
  add('run log writable', logOk, logDetail);

  const pad = Math.max(...rows.map(r => r.name.length));
  console.log('composer-lane doctor\n');
  for (const r of rows) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
  const bad = rows.filter(r => !r.ok);
  console.log(bad.length ? `\n${bad.length} problem(s) above. Fix those before running a task.`
                         : '\nAll checks passed — the lane can run here.');
  console.log('\nNOTE: not exercised on Windows in CI. If a check fails on Windows, trust the error over the docs.');
  process.exit(bad.length ? 1 : 0);
}

/**
 * check — decide the verdict deterministically, and say whether an LLM is needed.
 *
 * The gate used to be a Sonnet agent for EVERY merge. On the first real project
 * that cost 95s against 107s of actual coding — 47% of wall clock — and it
 * escalated because the repo had no tests, which is precisely the case where an
 * LLM review can verify nothing. It said so itself: "a read, not a verification".
 *
 * An LLM earns its 95s in exactly one situation: the tests pass AND the diff
 * touched the tests, or the config that selects them. That is the only case
 * needing judgement, because a green suite proves nothing if the suite was
 * edited. Everything else is a script.
 */
async function runCheck() {
  const repo     = arg('repo', process.cwd());
  const worktree = arg('worktree');
  const branch   = arg('branch');
  const base     = arg('base', 'main');
  const testCmd  = arg('test-cmd');
  // In-place: no branch, no worktree — judge the uncommitted working tree.
  const inPlace = has('in-place') || (!branch && !worktree);

  const gitBin = which('git');
  const g  = (dir, ...a) => spawnSync(gitBin, ['-C', dir, ...a], { encoding: 'utf8' });
  const ok = (r) => r.status === 0 ? r.stdout.trim() : null;

  const tip    = inPlace ? null : ok(g(repo, 'rev-parse', '--verify', 'refs/heads/' + branch));
  const mb     = inPlace ? null : (tip ? ok(g(repo, 'merge-base', base, branch)) : null);
  const wtHead = inPlace ? null : ok(g(worktree, 'rev-parse', 'HEAD'));

  const out = (decision, why, extra) => {
    extra = extra || {};
    console.log(JSON.stringify({
      decision, why,
      branch: branch || null,
      in_place: inPlace,
      files: extra.files == null ? null : extra.files,
      touched_tests: !!extra.touched,
      test_cmd: testCmd || null,
      tests_passed: extra.passed == null ? null : extra.passed,
    }, null, 2));
    process.exit(0);
  };

  if (!inPlace) {
    if (!tip)           out('REJECT', 'branch ' + branch + ' does not exist');
    if (tip === mb)     out('REJECT', 'empty branch — the work was never committed');
    if (wtHead !== tip) out('REJECT', 'worktree HEAD ' + String(wtHead).slice(0,8)
                            + ' != branch tip ' + tip.slice(0,8)
                            + ' — you would not be merging what you tested');
  }

  // In place, the engine's files come from the snapshot the last `code` run left
  // behind — never from `git status`, which on a dirty tree would blame the
  // user's own edits on the engine.
  let last = null; try { last = JSON.parse(readFileSync(path.join(repo, '.git', 'coder-lane-last.json'), 'utf8')); } catch {}
  const files = inPlace
    ? (last ? (last.paths || [])
            : (ok(g(repo, 'status', '--porcelain')) || '').split('\n').filter(Boolean).map(l => l.slice(3).trim()).filter(Boolean))
    : (ok(g(repo, 'diff', '--name-only', mb + '..' + tip)) || '').split('\n').filter(Boolean);

  if (inPlace && !files.length) out('REJECT', 'nothing changed in the working tree');

  const FORBIDDEN = /(^|\/)(\.env|\.npmrc|\.netrc|id_rsa)|\.git\/hooks\//i;
  const TESTISH = /(\.test\.|\.spec\.|_test\.|(^|\/)(tests?|spec|__tests__)\/|(^|\/)(package\.json|jest\.config|vitest\.config|pytest\.ini|pyproject\.toml|tox\.ini|setup\.cfg|conftest\.py|Makefile|justfile|phpunit\.xml|\.mocharc|karma\.conf|Cargo\.toml|go\.mod)|\.github\/workflows\/|\.gitlab-ci\.yml)/i;

  const bad = files.filter(f => FORBIDDEN.test(f));
  if (bad.length) out('REJECT', 'diff touches credential or hook files: ' + bad.join(', '),
                      { files: files.length });

  const touched = files.some(f => TESTISH.test(f));

  if (!testCmd) {
    out('MERGE_UNVERIFIED',
        'no test command: nothing can prove this works, so it merges with the unverified stamp. '
      + 'An LLM review is deliberately SKIPPED — without tests it can only read the diff, which '
      + 'does not verify behaviour, and previously cost 95s for exactly nothing.',
        { files: files.length, touched });
  }

  const t = spawnSync(testCmd, { cwd: inPlace ? repo : worktree, shell: true, encoding: 'utf8' });
  const passed = t.status === 0;
  if (!passed) out('REJECT',
      'tests failed: ' + ((t.stdout || '') + (t.stderr || '')).trim().slice(-400),
      { files: files.length, touched, passed });

  if (touched) out('ESCALATE',
      'tests pass BUT the diff touched tests or the config that selects them. A green suite '
    + 'proves nothing if the suite was edited. This is the ONE case worth an LLM — spawn '
    + 'the caller to look for weakened assertions.',
      { files: files.length, touched, passed });

  out('MERGE', inPlace
      ? 'tests pass and nothing test-deciding was touched — commit it with a real message'
      : 'tests pass and nothing test-deciding was touched',
      { files: files.length, touched, passed });
}

const cmd = process.argv[2];
if (cmd === 'code')       await runCode();
else if (cmd === 'doctor') await runDoctor();
else if (cmd === 'check')  await runCheck();
else {
  console.error(`usage:
  composer-run.mjs code   --brief <file> [--workspace <dir>] [--model composer-2.5|opus@<effort>|codex@<effort>] [--task <id>]
                          [--skill <SKILL.md>]...  append these skills to the brief as files the engine must read first
                          [--print-brief]          dry run: print the assembled brief (skills included) and exit
                          [--shadow opus@medium]   also run the brief with a second engine in a throwaway worktree; save the pair
                          ^ IN PLACE: edits the working tree, commits nothing. Works on a dirty tree —
                            the printed UNDO restores only the files the engine touched.
  composer-run.mjs check  --repo <dir> --test-cmd "<verify command>"
                          ^ deterministic verdict: MERGE / MERGE_UNVERIFIED / REJECT / ESCALATE
  composer-run.mjs doctor
                          ^ free environment check. Run this FIRST on a new machine.

log file: ${LOG}   (override with COMPOSER_LANE_LOG)`);
  process.exit(2);
}
