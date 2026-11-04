// Shared by backfill.mjs, build.mjs and serve.mjs: where the ledgers live, which boxes exist, and how one ledger line becomes zero or more normalized events.
// A normalized event is { t (ms), box, kind, outcome, detail, from, n }.
// outcome: ok | warn | degraded | fail | start.
// detail is short and safe by construction: it is assembled only from enum-like fields, numbers and basenames, never from prompt, command, file-content or error text.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const DIR = path.dirname(new URL(import.meta.url).pathname);

let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')); } catch {}
export const SETTINGS_ENV = settings.env || {};
export const ENABLED_PLUGINS = settings.enabledPlugins || {};
// process env wins (lets tests point at temp copies), then settings.json env, then the default
const envOf = (k, d) => process.env[k] || SETTINGS_ENV[k] || d;

// The same data directory the rest of the harness writes to, resolved the same way: HARNESS_DATA_DIR,
// then CLAUDE_PLUGIN_DATA (exported to plugin hooks and scripts), then ~/.claude/harness-data.
// Nothing is written inside the plugin directory, because Claude Code replaces it on every update.
export const DATA_DIR = envOf('HARNESS_DATA_DIR', process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'harness-data'));
export const CACHE_DIR = path.join(DATA_DIR, 'dashboard-cache');
export const BACKFILL_OUT = path.join(CACHE_DIR, 'agent-runs.jsonl');
export const BACKFILL_STATE = path.join(CACHE_DIR, 'backfill-state.json');
export const VIZ_OUT = process.env.HARNESS_DASHBOARD_OUT || path.join(DATA_DIR, 'harness-dashboard.html');

export const PATHS = {
  routing: envOf('ROUTING_LEDGER', path.join(DATA_DIR, 'routing.jsonl')),
  errand: envOf('ERRAND_ROUTER_LEDGER', path.join(DATA_DIR, 'errand-router.jsonl')),
  runs: envOf('COMPOSER_LANE_LOG', path.join(DATA_DIR, 'runs.jsonl')),
  delegate: envOf('DELEGATE_LEDGER', path.join(DATA_DIR, 'delegate.jsonl')),
  agents: envOf('AGENT_RUNS_LEDGER', path.join(DATA_DIR, 'agents.jsonl')),
  astraDir: path.join(DATA_DIR, 'openai-astra'),
  sentinelDir: process.env.CLAIM_SENTINEL_DIR || '/tmp/claim-sentinel',
};

const echOn = ENABLED_PLUGINS['ech@efficient-claude-harness'] === true;
const env1 = k => (process.env[k] ?? SETTINGS_ENV[k]) === '1';

// expected = switched on AND meant to fire in normal daily use.
// An expected box with no event for 7 days is "dead".
// On-demand boxes are never dead, only idle.
export const SWITCHES = {
  ech: echOn,
  ROUTE_GATE_JEV: env1('ROUTE_GATE_JEV'),
  ERRAND_ROUTER_JEV: env1('ERRAND_ROUTER_JEV'),
  OBSERVERS: env1('CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS'),
};
export const BOXES = [
  { id: 'main', label: 'main session', group: 'main', expected: true, why: 'every session' },
  { id: 'route-gate', label: 'route-gate', group: 'hook', expected: echOn, why: 'ech hook, PreToolUse Edit|Write' },
  { id: 'errand-router', label: 'errand-router', group: 'hook', expected: echOn, why: 'ech hook, PreToolUse Bash|Read' },
  { id: 'ai-coder', label: 'ech:ai-coder', group: 'agent', expected: echOn, why: 'default coding lane' },
  { id: 'ai-coder-high', label: 'ech:ai-coder-high', group: 'agent', expected: false, why: 'guarded paths only' },
  { id: 'project-coder', label: 'project coders', group: 'agent', expected: false, why: 'implementer, feature-crew-coder (project agents)' },
  { id: 'composer-merger', label: 'ech:composer-merger', group: 'agent', expected: false, why: 'only on ESCALATE' },
  { id: 'code-explorer', label: 'ech:code-explorer', group: 'agent', expected: false, why: 'on demand' },
  { id: 'browser-qa', label: 'ech:browser-qa', group: 'agent', expected: false, why: 'after UI changes' },
  { id: 'task-reviewer', label: 'ech:task-reviewer', group: 'agent', expected: false, why: 'on demand' },
  { id: 'pre-post-mortem', label: 'ech:pre-post-mortem', group: 'agent', expected: false, why: 'risky changes only' },
  { id: 'astra-agent', label: 'ech:delegate-to-openai-astra', group: 'agent', expected: false, why: 'only when Astra is named' },
  { id: 'other', label: 'other agents', group: 'agent', expected: false, why: 'Explore, general-purpose, user agents' },
  { id: 'workflow', label: 'workflow agents (untyped)', group: 'agent', expected: false, why: 'Workflow tool agents; meta type is the placeholder workflow-subagent' },
  { id: 'claim-sentinel', label: 'claim-sentinel', group: 'oncall', expected: SWITCHES.OBSERVERS, why: 'observer paired with every main loop' },
  { id: 'cursor', label: 'Cursor Composer', group: 'engine', expected: echOn, why: 'engine behind ai-coder' },
  { id: 'delegation', label: 'delegation service', group: 'engine', expected: false, why: 'ai-coder-high and fallbacks' },
  { id: 'astra', label: 'Astra / Codex', group: 'engine', expected: false, why: 'on demand' },
  { id: 'jev-errand', label: 'Jev (errand mode)', group: 'engine', expected: SWITCHES.ERRAND_ROUTER_JEV, why: 'ERRAND_ROUTER_JEV=' + (SWITCHES.ERRAND_ROUTER_JEV ? '1' : 'off') },
  { id: 'jev-coder', label: 'Jev (coder mode)', group: 'engine', expected: SWITCHES.ROUTE_GATE_JEV, why: 'ROUTE_GATE_JEV=' + (SWITCHES.ROUTE_GATE_JEV ? '1' : 'off') },
];
export const BOX_IDS = new Set(BOXES.map(b => b.id));

// agent type → box.
// Pre-ech names (no prefix, harness:*) land in the same boxes.
const AGENT_BOX = {
  'ai-coder': 'ai-coder', 'ai-coder-high': 'ai-coder-high', 'composer-merger': 'composer-merger',
  'code-explorer': 'code-explorer', 'browser-qa': 'browser-qa', 'task-reviewer': 'task-reviewer',
  'pre-post-mortem': 'pre-post-mortem', 'delegate-to-openai-astra': 'astra-agent', 'openai-astra': 'astra-agent', 'claim-sentinel': 'claim-sentinel',
  'workflow-subagent': 'workflow', 'implementer': 'project-coder', 'feature-crew-coder': 'project-coder',
};
export function agentBox(type) {
  const t = String(type || '').replace(/^(ech|harness):/, '');
  return AGENT_BOX[t] || 'other';
}
// agent type names are identifiers; anything else is dropped rather than echoed
export const safeType = t => /^[\w:.@-]{1,60}$/.test(String(t || '')) ? String(t) : (t ? '(unnamed)' : 'general-purpose');
const safeTok = v => (v == null ? '' : String(v).replace(/\[(\w+)\]/g, '-$1').replace(/[^\w.@:+-]/g, '').slice(0, 40));
const base = p => p ? safeTok(path.basename(String(p))) : '';
export const fmtDur = ms => ms == null || !isFinite(ms) ? '' : ms < 1000 ? Math.round(ms) + 'ms'
  : ms < 60e3 ? Math.round(ms / 1000) + 's' : ms < 3600e3 ? Math.round(ms / 60e3) + 'm' : (ms / 3600e3).toFixed(1) + 'h';
const join = (...a) => a.filter(x => x !== '' && x != null).join(' · ');
const T = ts => { const t = Date.parse(ts); return isFinite(t) ? t : null; };

// Noisy kinds are bucketed per minute by the builder; everything else is kept one by one.
export const AGG_KINDS = new Set(['edit', 'gate-pass', 'delegate-seen', 'errand-pass', 'errand-count']);

// ── routing.jsonl (route-gate) ─────────────────────────────────────────────────────────────
export function fromRouting(r) {
  const t = T(r.ts); if (t == null) return [];
  const proj = base(r.cwd_name);
  if (r.kind === 'direct_edit') return [{ t, box: 'main', kind: 'edit', outcome: 'ok', detail: join(safeTok(r.tool), safeTok(r.ext), proj), from: null }];
  if (r.kind === 'delegate') return [{ t, box: 'route-gate', kind: 'delegate-seen', outcome: 'ok', detail: join('saw spawn', safeType(r.subagent_type)), from: 'main' }];
  if (r.kind !== 'gate') return [];
  const v = safeTok(r.verdict) || 'pass';
  const out = [{ t, box: 'route-gate', kind: v === 'pass' ? 'gate-pass' : 'gate-' + v, outcome: v === 'pass' ? 'ok' : 'warn',
    detail: join(v + ' ' + safeTok(r.why), safeTok(r.tool) + ' ' + safeTok(r.ext), r.lines != null ? r.lines + ' lines' : '', r.target ? '→ ' + safeType(r.target) : '', proj), from: 'main' }];
  if (r.jev_action != null || r.jev_ms != null) {
    const a = safeTok(r.jev_action) || 'jev-null';
    out.push({ t, box: 'jev-coder', kind: 'jev', outcome: (a === 'jev-null' || a === 'low-confidence') ? 'degraded' : 'ok',
      detail: join(a, r.jev_lane ? 'lane ' + safeType(r.jev_lane) : 'no lane', r.jev_conf != null ? 'conf ' + (+r.jev_conf).toFixed(2) : '', fmtDur(r.jev_ms)), from: 'route-gate' });
  }
  return out;
}

// ── errand-router.jsonl ────────────────────────────────────────────────────────────────────
export function fromErrand(r) {
  const t = T(r.ts); if (t == null) return [];
  const a = safeTok(r.action) || '?';
  const jev = r.jev_ms != null || r.lane !== undefined || a === 'jev-null' || a === 'low-confidence';
  const kind = a === 'not-errand' ? 'errand-pass' : (a === 'count' && !jev) ? 'errand-count' : 'errand-' + a;
  const outcome = /warn|hard-main/.test(a) ? 'warn' : 'ok';
  const out = [{ t, box: 'errand-router', kind, outcome, detail: join(a, safeTok(r.why), safeTok(r.kind)), from: 'main' }];
  if (jev) out.push({ t, box: 'jev-errand', kind: 'jev', outcome: (a === 'jev-null' || a === 'low-confidence') ? 'degraded' : 'ok',
    detail: join(a, r.lane ? 'lane ' + safeType(r.lane) : 'no lane', r.confidence != null ? 'conf ' + (+r.confidence).toFixed(2) : '', fmtDur(r.jev_ms)), from: 'errand-router' });
  return out;
}

// ── runs.jsonl (composer-run) ──────────────────────────────────────────────────────────────
function engineBox(r) {
  const e = r.engine || '', m = String(r.model || ''), arm = String(r.arm || '');
  if (e === 'codex' || /^codex|sol/.test(m) || /^sol/.test(arm)) return 'astra';
  if (e === 'claude-code' || /^(opus|sonnet)@/.test(m) || /-claude$|^(opus|sonnet)@/.test(arm)) return 'delegation';
  return 'cursor';
}
// error text is never copied: it is reduced to a fixed code
function errCode(s) {
  if (!s) return '';
  s = String(s);
  if (/no stdin/i.test(s)) return 'no-stdin';
  if (/reported success but/i.test(s)) return 'false-success';
  if (/connection lost/i.test(s)) return 'connection-lost';
  if (/worktree/i.test(s)) return 'bad-worktree';
  if (/timed? ?out|timeout/i.test(s)) return 'timeout';
  if (/max_turns/i.test(s)) return 'max-turns';
  if (/cancel/i.test(s)) return 'cancelled';
  return 'error';
}
export function fromRuns(r) {
  const t = T(r.ts); if (t == null) return [];
  const box = engineBox(r);
  if (r.phase === 'merge') {
    const v = safeTok(r.verdict);
    return [{ t, box: 'cursor', kind: 'check', outcome: v === 'MERGED' ? 'ok' : v === 'REJECT' ? 'fail' : 'warn', detail: join('check', v || 'no verdict'), from: 'ai-coder' }];
  }
  const ok = r.ok === true && !(r.error && /reported success but/i.test(r.error));
  const fail = r.ok === false || (r.exit_code != null && r.exit_code !== 0) || !ok;
  return [{ t, box, kind: 'run-' + safeTok(r.phase || 'code'), outcome: fail ? 'fail' : 'ok',
    detail: join(safeTok(r.phase), safeTok(r.model || r.arm), fmtDur(r.duration_ms ?? r.wall_ms), r.cost_usd ? '$' + (+r.cost_usd).toFixed(2) : '',
      fail ? errCode(r.error) || ('exit ' + r.exit_code) : '', base(r.repo)), from: 'ai-coder' }];
}

// ── delegate.jsonl (delegation service) ─────────────────────────────────────────────────────
export function fromDelegate(r) {
  const t = T(r.ts); if (t == null) return [];
  const o = safeTok(r.outcome || r.status);
  const outcome = o === 'worked' || o === 'succeeded' ? 'ok' : /refused|bad_files|cancel/.test(o) ? 'degraded' : 'fail';
  return [{ t, box: 'delegation', kind: 'job', outcome, detail: join(o, safeTok(r.profile) + '/' + safeTok(r.model) + (r.effort ? '@' + safeTok(r.effort) : ''), fmtDur(r.duration_ms)), from: 'ai-coder-high' }];
}

// ── agent runs (backfill cache rows and agents.jsonl hook rows) ──────────────────────────────
// backfill row: { t, end, type, model, bg, dur, status, tokens, tools, proj, aid }
export function fromAgentRun(r) {
  const out = [];
  const box = agentBox(r.type), type = safeType(r.type);
  const tag = box === 'other' ? type : box === 'workflow' ? (r.wlabel ? 'label ' + safeTok(r.wlabel) : 'no label') : r.observer ? 'observer' : '';
  if (r.t) out.push({ t: r.t, box, kind: 'spawn', outcome: 'start', detail: join(tag, safeTok(r.model), r.bg ? 'background' : '', base(r.proj)), from: 'main' });
  if (r.end) {
    const s = r.status;
    const outcome = s === 'completed' ? 'ok' : s === 'failed' || s === 'error' ? 'fail' : 'degraded';
    out.push({ t: r.end, box, kind: 'done', outcome, detail: join(tag, s || 'done', fmtDur(r.dur), r.tokens ? Math.round(r.tokens / 1000) + 'k tok' : '', r.tools ? r.tools + ' tools' : ''), from: 'main' });
  }
  return out;
}
// agents.jsonl rows written by agent-runs-hook.mjs
export function fromAgentHook(r) {
  const t = T(r.ts); if (t == null) return [];
  if (r.event === 'SubagentStart') return fromAgentRun({ t, type: r.agent_type, model: r.model, proj: r.cwd });
  if (r.event === 'SubagentStop') {
    const ev = fromAgentRun({ end: t, type: r.agent_type, status: r.ok === false ? 'error' : 'completed', dur: r.duration_ms, model: r.model });
    return ev;
  }
  return [];
}

// ── files in a directory: claim-sentinel reports, Astra probe logs ─────────────────────────
export function fromSentinelFile(name, mtimeMs) {
  const slug = name.replace(/\.md$/, '').replace(/^\d{8}(-\d{6})?-?/, '').replace(/[^\w-]/g, '').slice(0, 40);
  return [{ t: mtimeMs, box: 'claim-sentinel', kind: 'report', outcome: 'ok', detail: join('flagged', slug), from: 'main' }];
}
export function fromAstraLog(file) {
  try {
    const st = fs.statSync(file);
    const outFile = file.replace(/\.log$/, '.out');
    const outOk = fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
    // only scan for an error marker; nothing from the log is copied
    const txt = fs.readFileSync(file, 'utf8');
    const bad = /\bERROR\b|error:|failed|timed out/i.test(txt);
    return [{ t: st.mtimeMs, box: 'astra', kind: 'codex-exec', outcome: outOk && !bad ? 'ok' : 'fail', detail: outOk && !bad ? 'codex exec answered' : 'codex exec no answer', from: 'astra-agent' }];
  } catch { return []; }
}

// line-by-line reader over a Buffer range; yields complete lines only and the next offset
export function readLinesSync(file, offset = 0) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset: size < offset ? 0 : offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const last = buf.lastIndexOf(10);
    if (last < 0) return { lines: [], offset };
    const lines = buf.subarray(0, last).toString('utf8').split('\n');
    return { lines, offset: offset + last + 1 };
  } finally { fs.closeSync(fd); }
}
export const parse = l => { try { return JSON.parse(l); } catch { return null; } };

export const SOURCES = [
  { key: 'routing', file: () => PATHS.routing, fn: fromRouting },
  { key: 'errand', file: () => PATHS.errand, fn: fromErrand },
  { key: 'runs', file: () => PATHS.runs, fn: fromRuns },
  { key: 'delegate', file: () => PATHS.delegate, fn: fromDelegate },
  { key: 'agents', file: () => PATHS.agents, fn: fromAgentHook },
];

// ── state rule: shared verbatim with the page (build.mjs injects its source) ────────────────
// counts: { runs24, fail24, deg24, any24, last, lastRun, lastRunOutcome, any7 }
export function stateOf(c, expected) {
  if (c.any24 > 0) {
    if (c.runs24 > 0) {
      if (c.lastRunOutcome === 'fail' || (c.runs24 >= 2 && c.fail24 / c.runs24 >= 0.5)) return 'failing';
      if (c.lastRunOutcome === 'degraded' || (c.fail24 + c.deg24) / c.runs24 >= 0.25) return 'degraded';
    }
    return 'working';
  }
  if (expected && c.any7 === 0) return 'dead';
  return 'idle';
}
