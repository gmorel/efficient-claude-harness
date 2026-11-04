#!/usr/bin/env node
// node tests/lint.mjs
//
// The repository rules that a reviewer cannot hold in their head, checked mechanically.
//
// Every rule here exists because the thing it checks for actually shipped once. The plugin was
// extracted from one person's private setup, so the recurring failure is not a bug in the logic:
// it is a path, a name or a claim that only resolves on the machine it was written on, and that
// nobody notices because it keeps working there. `node --check` does not see those, and neither
// does a test suite run by the same person on the same machine.
//
// Node built-ins only, like the rest of the repository. Exit 0 clean, 1 on any finding.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
const findings = [];
const flag = (file, line, rule, msg) => findings.push({ file, line, rule, msg });
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lines = f => read(f).split('\n');
const isText = f => /\.(mjs|js|json|md|css)$/.test(f);

// 1 ── a file that does not parse is not a finding, it is a broken release
for (const f of tracked.filter(f => f.endsWith('.mjs') || f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status !== 0) flag(f, 0, 'syntax', (r.stderr.split('\n').find(l => l.includes('Error')) || 'does not parse').trim());
}

// 2 ── an absolute path into somebody's home directory. It works for its author and for nobody
//      else, and the failure is an ENOENT the author never sees.
const HOME_PATH = /(\/Users\/[a-z]|\/home\/[a-z]|\/Volumes\/)/i;
for (const f of tracked.filter(isText)) {
  if (f === 'tests/lint.mjs') continue;                       // the rule has to name what it forbids
  lines(f).forEach((l, i) => {
    if (!HOME_PATH.test(l)) return;
    if (/^\s*(\/\/|#|\*)/.test(l) && /for example|e\.g\./i.test(l)) return;   // an illustration, not a path
    flag(f, i + 1, 'home-path', l.trim().slice(0, 110));
  });
}

// 3 ── a path into a tool that is not part of this repository. `~/.claude/skills/...` and
//      `~/.local/lib/...` are the two that shipped: both read fine on the author's machine and
//      threw ENOENT everywhere else.
const FOREIGN = /homedir\(\)[^)]*\)?\s*,?\s*['"`][^'"`]*(\.claude\/(skills|composer-lane|ledgers|state)|\.local\/lib)/;
for (const f of tracked.filter(f => f.endsWith('.mjs'))) {
  if (f === 'tests/lint.mjs') continue;
  lines(f).forEach((l, i) => { if (FOREIGN.test(l)) flag(f, i + 1, 'foreign-tool', l.trim().slice(0, 110)); });
}

// 4 ── a credential, in any file
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/;
for (const f of tracked.filter(isText)) {
  if (f === 'tests/lint.mjs') continue;
  lines(f).forEach((l, i) => { if (SECRET.test(l)) flag(f, i + 1, 'secret', 'credential-shaped string'); });
}

// 5 ── a ledger. Runtime data belongs in the data directory, never in the repository.
for (const f of tracked) if (/\.(jsonl|log)$/.test(f) || /(^|\/)\.env/.test(f)) flag(f, 0, 'runtime-data', 'tracked runtime data');

// 6 ── a shebang without the executable bit, or the reverse. Harmless until someone runs the file
//      the way its own first line says to.
const modes = execFileSync('git', ['-C', ROOT, 'ls-files', '-s'], { encoding: 'utf8' }).trim().split('\n')
  .map(l => l.split(/\s+/)).reduce((m, [mode, , , f]) => (m[f] = mode, m), {});
for (const f of tracked.filter(f => f.endsWith('.mjs'))) {
  const hasShebang = read(f).startsWith('#!');
  const isExec = modes[f] === '100755';
  if (hasShebang && !isExec) flag(f, 1, 'exec-bit', 'has a shebang but is not executable');
  if (!hasShebang && isExec) flag(f, 1, 'exec-bit', 'is executable but has no shebang');
}

// 7 ── a Markdown link to a file that is not there. Cheap to break in a rename, invisible until a
//      reader clicks it.
for (const f of tracked.filter(f => f.endsWith('.md'))) {
  const dir = path.dirname(f);
  lines(f).forEach((l, i) => {
    for (const m of l.matchAll(/]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|#|\$\{)/.test(href)) continue;
      const target = path.resolve(ROOT, dir, href.split('#')[0]);
      if (!fs.existsSync(target)) flag(f, i + 1, 'dead-link', href);
    }
  });
}

// ── report ───────────────────────────────────────────────────────────────────────────────────
const RULES = { syntax: 'does not parse', 'home-path': "absolute path into somebody's home directory",
  'foreign-tool': 'reads a tool this repository does not ship', secret: 'credential-shaped string',
  'runtime-data': 'runtime data tracked in the repository', 'exec-bit': 'shebang and executable bit disagree',
  'dead-link': 'Markdown link to a file that is not there' };
for (const rule of Object.keys(RULES)) {
  const hits = findings.filter(x => x.rule === rule);
  if (!hits.length) { console.log(`PASS ${rule} — ${RULES[rule]}`); continue; }
  console.log(`FAIL ${rule} — ${RULES[rule]} (${hits.length})`);
  for (const h of hits) console.log(`       ${h.file}:${h.line}  ${h.msg}`);
}
console.log(`\n${findings.length ? `FAIL ${findings.length} finding(s)` : `PASS · ${tracked.length} tracked files clean`}`);
process.exit(findings.length ? 1 : 0);
