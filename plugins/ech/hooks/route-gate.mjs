#!/usr/bin/env node
// PreToolUse hook: measure and gate code edits to the Composer coder lane.
//
// Knows when a code edit is big enough to belong in the coder lane, and can
// block it (deny) or just nudge (warn). Writes no-op on pass, additionalContext
// on warn, JSON deny on block. Never breaks an edit, even if the hook crashes.
//
// Shipped warn-only: it never blocks unless you opt in.
//   ROUTE_GATE=off | warn (default) | deny       environment switch, wins over the file
//   <data>/route-gate.json  {"mode":"warn","maxLines":15,"guardedMaxLines":1,"maxFilesPerPrompt":3}
//   ROUTE_GATE_CONFIG / ROUTE_GATE_STATE / ROUTING_LEDGER override each file's location.
//   ROUTE_GATE_AGENT_PREFIX (default "ech:") is put before ai-coder / ai-coder-high in messages and the ledger; set it empty for the original names.
// <data> is HARNESS_DATA_DIR, else CLAUDE_PLUGIN_DATA (exported to plugin hooks), else ~/.claude/harness-data.

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(HERE);
const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(homedir(), '.claude', 'harness-data');
const LANE_SCRIPT = process.env.ROUTE_GATE_LANE_SCRIPT || path.join(PLUGIN_ROOT, 'scripts', 'composer-run.mjs');
const AGENT_PREFIX = process.env.ROUTE_GATE_AGENT_PREFIX ?? 'ech:';

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts',
  '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.kts', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.sql', '.sh', '.bash',
  '.vue', '.svelte', '.scala', '.ex', '.exs', '.lua', '.dart',
]);

const GUARDED = /(^|\/)(migrations?|drizzle|prisma\/migrations|alembic|db\/migrate|\.github\/workflows|\.gitlab-ci|\.circleci|\.git\/hooks|\.githooks|\.husky)\/|(^|\/)\.env(\.|$)|(^|\/)\.gitlab-ci\.yml$/i;
const GUARDED_WORD = /(^|\/)[^/]*(auth|payment|billing)[^/]*(\/|\.[a-z0-9]+$)/i;

const sha = s => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 12);
const out = o => { if (o) process.stdout.write(JSON.stringify(o)); process.exit(0); };

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function lineCount(s) { return s ? (s.match(/\n/g) || []).length + (s.trim() ? 1 : 0) : 0; }

function countOccurrences(text, pattern) {
  if (!text || !pattern) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(pattern, pos)) !== -1) {
    count++;
    pos += pattern.length;
  }
  return count;
}

function getConfig() {
  const envMode = process.env.ROUTE_GATE;
  const cfgFile = process.env.ROUTE_GATE_CONFIG || path.join(DATA_DIR, 'route-gate.json');
  let cfg = { mode: 'warn', maxLines: 15, guardedMaxLines: 1, maxFilesPerPrompt: 3 };
  try {
    const f = readFileSync(cfgFile, 'utf8');
    Object.assign(cfg, JSON.parse(f));
    if (cfg.mode && !['off', 'warn', 'deny'].includes(cfg.mode)) cfg.mode = 'warn';
  } catch {}
  // Env takes precedence
  if (envMode === 'off' || envMode === 'warn' || envMode === 'deny') cfg.mode = envMode;
  return cfg;
}

function getSessionKind(sessionId) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const sessDir = path.join(dir, 'sessions');
  try {
    const files = readdirSync(sessDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const sess = JSON.parse(readFileSync(path.join(sessDir, f), 'utf8'));
        if (sess.sessionId === sessionId) return sess.kind;
      } catch {}
    }
  } catch {}
  return null;
}

function findNearestGitAncestor(fp) {
  let dir = path.dirname(fp);
  // Walk up to find first existing directory
  while (dir && dir !== path.dirname(dir)) {
    if (existsSync(dir)) break;
    dir = path.dirname(dir);
  }
  // If even that doesn't exist, use root attempt
  if (!existsSync(dir)) dir = path.dirname(fp);
  return dir;
}

function isGit(dir) {
  const g = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 2000 });
  return g.status === 0;
}

function getCursorBin() {
  const env = process.env.ROUTE_GATE_CURSOR_BIN;
  if (env) return existsSync(env) ? env : null;
  const local = path.join(homedir(), '.local', 'bin', 'cursor-agent');
  if (existsSync(local)) return local;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, 'cursor-agent' + e);
    if (existsSync(p)) return p;
  }
  return null;
}

function pruneState(state, now) {
  const ttl = 2 * 60 * 60 * 1000; // 2 hours
  Object.keys(state).forEach(k => {
    if (now - (state[k].ts || 0) > ttl) delete state[k];
  });
}

function getState() {
  const stateFile = process.env.ROUTE_GATE_STATE || path.join(DATA_DIR, 'route-gate-state.json');
  try {
    const s = readFileSync(stateFile, 'utf8');
    return JSON.parse(s);
  } catch { return {}; }
}

function saveState(state) {
  const stateFile = process.env.ROUTE_GATE_STATE || path.join(DATA_DIR, 'route-gate-state.json');
  const dir = path.dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  try {
    const tmpFile = stateFile + '.' + process.pid + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(state), 'utf8');
    renameSync(tmpFile, stateFile);
  } catch {}
}

function getLedger() {
  return process.env.ROUTING_LEDGER || path.join(DATA_DIR, 'routing.jsonl');
}

function isSelfPath(fp) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  try {
    const realConfigDir = realpathSync.native(configDir);
    // Walk up from dirname(fp) to find first existing directory and resolve its realpath
    let checkDir = path.dirname(fp);
    while (checkDir && checkDir !== path.dirname(checkDir)) {
      if (existsSync(checkDir)) {
        const realCheckDir = realpathSync.native(checkDir);
        const rel = path.relative(realConfigDir, realCheckDir);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
        break;
      }
      checkDir = path.dirname(checkDir);
    }
  } catch {}
  // The plugin's own files are never gated.
  try {
    const rel = path.relative(realpathSync.native(PLUGIN_ROOT), realpathSync.native(findNearestGitAncestor(fp)));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  } catch {}
  return false;
}

function writeLedger(rec) {
  const ledger = getLedger();
  mkdirSync(path.dirname(ledger), { recursive: true });
  try { appendFileSync(ledger, JSON.stringify(rec) + '\n', 'utf8'); } catch {}
}

try {
  const inp = await readStdin();
  if (!inp) process.exit(0);

  const tool = inp.tool_name;
  const ti = inp.tool_input || {};

  // Step 1: Only code files
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) process.exit(0);
  const fp = ti.file_path || ti.notebook_path;
  if (!fp) process.exit(0);
  // A guarded path is gated whatever its extension: .env, CI workflows and git
  // hooks carry no code extension and used to exit here, never reaching GUARDED.
  const isGuarded = GUARDED.test(fp) || GUARDED_WORD.test(fp);
  if (!isGuarded && !CODE_EXT.has(path.extname(fp).toLowerCase())) process.exit(0);

  const cfg = getConfig();
  let size = 0;

  if (tool === 'Write') {
    size = lineCount(ti.content);
  } else if (tool === 'Edit') {
    if (ti.replace_all) {
      let fileContent = '';
      let occurrences = 1;
      if (existsSync(fp)) {
        try {
          const stat = statSync(fp);
          if (stat.size <= 2 * 1024 * 1024) {
            fileContent = readFileSync(fp, 'utf8');
            occurrences = countOccurrences(fileContent, ti.old_string || '');
          }
        } catch {}
      }
      const olines = Math.max(lineCount(ti.old_string), lineCount(ti.new_string));
      size = Math.max(1, occurrences) * olines;
    } else {
      size = Math.max(lineCount(ti.old_string), lineCount(ti.new_string));
    }
  } else if (tool === 'MultiEdit') {
    size = (ti.edits || []).reduce((s, e) => {
      if (e.replace_all) {
        let fileContent = '';
        let occurrences = 1;
        if (existsSync(fp)) {
          try {
            const stat = statSync(fp);
            if (stat.size <= 2 * 1024 * 1024) {
              fileContent = readFileSync(fp, 'utf8');
              occurrences = countOccurrences(fileContent, e.old_string || '');
            }
          } catch {}
        }
        const olines = Math.max(lineCount(e.old_string), lineCount(e.new_string));
        return s + (Math.max(1, occurrences) * olines);
      }
      return s + Math.max(lineCount(e.old_string), lineCount(e.new_string));
    }, 0);
  } else if (tool === 'NotebookEdit') {
    size = lineCount(ti.new_source);
  }

  const sessionId = inp.session_id;
  const promptId = inp.prompt_id || null;
  const promptKey = inp.prompt_id || '-';
  const cwd = inp.cwd;
  const agentId = inp.agent_id;

  // Step 4: Decision tree
  const target = AGENT_PREFIX + (isGuarded ? 'ai-coder-high' : 'ai-coder');
  let why = 'unknown';
  let verdict = 'pass';
  let warnOutput = null;
  let cumLines = 0;
  let filesInPrompt = 0;

  if (cfg.mode === 'off') {
    why = 'env_off';
  } else if (agentId) {
    why = 'subagent';
  } else if (isSelfPath(fp)) {
    why = 'self';
  } else if (getSessionKind(sessionId) !== 'interactive') {
    why = 'not_interactive';
  } else if (!existsSync(LANE_SCRIPT)) {
    why = 'lane_missing';
  } else if (!isGuarded && !getCursorBin()) {
    why = 'lane_missing';
  } else if (!isGit(findNearestGitAncestor(fp))) {
    why = 'not_git';
  } else {
    // Step 5: Size check
    const state = getState();
    const now = Date.now();
    pruneState(state, now);

    const pathKey = `${sessionId}|${promptKey}|${fp}`;

    if (!state[pathKey]) state[pathKey] = { lines: 0, ts: now };
    state[pathKey].lines += size;
    state[pathKey].ts = now;

    cumLines = state[pathKey].lines;
    filesInPrompt = 0;
    Object.keys(state).forEach(k => {
      const [sid, pk] = k.split('|');
      if (sid === sessionId && pk === promptKey) filesInPrompt++;
    });

    const lineBudget = isGuarded ? cfg.guardedMaxLines : cfg.maxLines;

    if (cumLines >= lineBudget) {
      why = 'size';
      verdict = cfg.mode === 'deny' ? 'deny' : 'warn';
    } else if (filesInPrompt >= cfg.maxFilesPerPrompt) {
      why = 'many_files';
      verdict = cfg.mode === 'deny' ? 'deny' : 'warn';
    } else {
      why = 'small';
    }

    // Only save state if verdict is not 'deny'
    if (verdict !== 'deny') {
      saveState(state);
    }

    if (verdict === 'warn') {
      const basename = path.basename(fp);
      const delegateMsg = isGuarded
        ? `File is a guarded path (auth, payments, migrations, CI, or secrets). Changes of this size there go to the ${target} agent, which needs a written plan first.`
        : `Delegate changes of this size to the ${target} agent (Cursor Composer 2.5, in place on the current branch, commits nothing) instead of editing directly.`;
      warnOutput = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `route-gate: this edit is Composer-lane size (${size} lines now, ${cumLines} in ${basename} this turn, ${filesInPrompt} code files this turn). ${delegateMsg}`,
        },
      };
    } else if (verdict === 'deny') {
      const basename = path.basename(fp);
      warnOutput = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `code changes of this size go through the ${target} agent. Blocked file: ${basename} (${cumLines} lines this turn). If ${target} hands the task back (not a git repo, guarded path, or engine unavailable), say so and the caller will decide what to do.`,
        },
      };
    }
  }

  // Step 7: Log
  const rec = {
    kind: 'gate',
    verdict,
    why,
    target,
    mode: cfg.mode,
    tool,
    ext: path.extname(fp).toLowerCase(),
    lines: size,
    cum_lines: cumLines,
    files_in_prompt: filesInPrompt,
    guarded: isGuarded,
    path_sha: sha(fp),
    basename_len: path.basename(fp).length,
    session_id: sessionId,
    prompt_id: promptId,
    cwd_name: cwd ? path.basename(cwd) : null,
    ts: new Date().toISOString(),
  };
  writeLedger(rec);

  if (warnOutput) out(warnOutput);
  process.exit(0);
} catch {
  process.exit(0);
}
