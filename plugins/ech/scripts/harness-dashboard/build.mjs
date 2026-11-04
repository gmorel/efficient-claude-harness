#!/usr/bin/env node
// Merge every harness ledger plus the transcript backfill into one normalized event list and write one self-contained page (HARNESS_DASHBOARD_OUT, by default <data>/harness-dashboard.html).
// The summary, the TL;DR and the box tree are rendered into the markup, so the page reads complete with JavaScript off; JS only drives the replay.
//
//   node build.mjs [--days 60]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  BOXES, PATHS, SWITCHES, AGG_KINDS, BACKFILL_OUT, VIZ_OUT, DIR, SOURCES,
  fromAgentRun, fromSentinelFile, fromAstraLog, readLinesSync, parse, stateOf,
} from './lib.mjs';

const dIdx = process.argv.indexOf('--days');
const DAYS = dIdx > 0 ? +process.argv[dIdx + 1] : 60;
const NOW = Date.now();
const SINCE = NOW - DAYS * 864e5;
const OUTC = ['ok', 'warn', 'degraded', 'fail', 'start'];
const BOX_INDEX = Object.fromEntries(BOXES.map((b, i) => [b.id, i]));

// ── 1 · collect ──────────────────────────────────────────────────────────────────────────────
const perSource = {};
const raw = [];
// per source: lines (records) read, records inside the window, and events emitted per box; one Jev-consulting record emits two events (the hook and the Jev engine), so events can exceed lines
function add(src, evs) {
  const ps = perSource[src] ??= { records: 0, records_in_window: 0, events: 0, by_box: {} };
  ps.records++;
  let inWin = false;
  for (const e of evs) { if (e.t == null || e.t < SINCE || e.t > NOW + 60e3) continue; inWin = true; raw.push(e); ps.events++; ps.by_box[e.box] = (ps.by_box[e.box] || 0) + 1; }
  if (inWin) ps.records_in_window++;
}
const rawLines = {};
for (const s of SOURCES) {
  const f = s.file();
  if (!fs.existsSync(f)) { rawLines[s.key] = 'missing'; continue; }
  const { lines } = readLinesSync(f, 0);
  rawLines[s.key] = lines.length;
  for (const l of lines) { const r = parse(l); if (r) add(s.key, s.fn(r)); }
}
// backfill: drop runs the live hook already recorded (same agent id)
const hookIds = new Set();
if (fs.existsSync(PATHS.agents)) for (const l of readLinesSync(PATHS.agents, 0).lines) { const r = parse(l); if (r?.agent_id) hookIds.add(String(r.agent_id).replace(/^agent-/, '')); }
if (fs.existsSync(BACKFILL_OUT)) {
  const lines = readLinesSync(BACKFILL_OUT, 0).lines; rawLines.backfill = lines.length;
  for (const l of lines) { const r = parse(l); if (r && !(r.aid && hookIds.has(r.aid))) add('transcripts', fromAgentRun(r)); }
} else rawLines.backfill = 'missing (run backfill.mjs)';
for (const [dir, key, fn] of [[PATHS.sentinelDir, 'claim-sentinel', (f, st) => fromSentinelFile(f, st.mtimeMs)], [PATHS.astraDir, 'astra-logs', (f) => fromAstraLog(f)]]) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) {
    if (key === 'claim-sentinel' ? !f.endsWith('.md') : !/^astra-.*\.log$/.test(f)) continue;
    const full = path.join(dir, f); n++;
    add(key, fn(key === 'claim-sentinel' ? f : full, fs.statSync(full)));
  } } catch {}
  rawLines[key] = n + ' files';
}

// ── 2 · aggregate the noisy kinds per minute, keep everything else one by one ────────────────
const KIND_LABEL = { 'edit': 'direct edits', 'gate-pass': 'gate passes', 'delegate-seen': 'agent spawns seen', 'errand-pass': 'not errands', 'errand-count': 'errands counted' };
const buckets = new Map();
const events = [];
for (const e of raw) {
  if (AGG_KINDS.has(e.kind) && e.outcome === 'ok') {
    const k = e.box + '|' + e.kind + '|' + Math.floor(e.t / 60e3);
    const b = buckets.get(k);
    if (b) b.n++; else { const nb = { ...e, t: Math.floor(e.t / 60e3) * 60e3 + 30e3, n: 1 }; buckets.set(k, nb); events.push(nb); }
  } else events.push({ ...e, n: 1 });
}
for (const e of events) if (AGG_KINDS.has(e.kind) && e.outcome === 'ok') e.detail = e.n + ' ' + (KIND_LABEL[e.kind] || e.kind) + ' in this minute';
events.sort((a, b) => a.t - b.t);

// ── 3 · encode compactly ─────────────────────────────────────────────────────────────────────
const strs = [], strIdx = new Map();
const S = s => { s = s || ''; let i = strIdx.get(s); if (i == null) { i = strs.length; strs.push(s); strIdx.set(s, i); } return i; };
const T0 = events.length ? Math.floor(events[0].t / 1000) : Math.floor(SINCE / 1000);
const enc = { t0: T0, dt: [], b: [], k: [], o: [], d: [], f: [], n: [] };
let prev = T0;
for (const e of events) {
  const ts = Math.floor(e.t / 1000);
  enc.dt.push(ts - prev); prev = ts;
  enc.b.push(BOX_INDEX[e.box]); enc.k.push(S(e.kind)); enc.o.push(OUTC.indexOf(e.outcome)); enc.d.push(S(e.detail));
  enc.f.push(e.from != null && BOX_INDEX[e.from] != null ? BOX_INDEX[e.from] : -1); enc.n.push(e.n);
}
enc.s = strs;

// ── 4 · window counts: one implementation, run here for the static summary and in the page for the replay ──
// U[i] is 1 when event i is a use (anything but an agent's "done" event), so a run counts once
function makeIndex(T, B, O, N, nBoxes, U) {
  const ix = [];
  for (let b = 0; b < nBoxes; b++) ix.push({ t: [], o: [], any: [0], use: [0], runs: [0], fail: [0], deg: [0] });
  for (let i = 0; i < T.length; i++) {
    const x = ix[B[i]], n = N[i], o = O[i];
    x.t.push(T[i]); x.o.push(o);
    x.any.push(x.any[x.any.length - 1] + n);
    x.use.push(x.use[x.use.length - 1] + (U[i] ? n : 0));
    x.runs.push(x.runs[x.runs.length - 1] + (o === 4 ? 0 : n));
    x.fail.push(x.fail[x.fail.length - 1] + (o === 3 ? n : 0));
    x.deg.push(x.deg[x.deg.length - 1] + (o === 2 ? n : 0));
  }
  return ix;
}
function countsAt(x, C) {
  const lb = v => { let lo = 0, hi = x.t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x.t[m] < v) lo = m + 1; else hi = m; } return lo; };
  const hi = (() => { let lo = 0, h = x.t.length; while (lo < h) { const m = (lo + h) >> 1; if (x.t[m] <= C) lo = m + 1; else h = m; } return lo; })();
  const H = 3600e3, D = 24 * H;
  const w = (from, arr) => arr[hi] - arr[lb(from)];
  const l24 = lb(C - D);
  let lastRunOutcome = null, lastFailI = -1;
  for (let i = hi - 1; i >= l24; i--) if (x.o[i] !== 4) { lastRunOutcome = ['ok', 'warn', 'degraded', 'fail'][x.o[i]]; break; }
  for (let i = hi - 1; i >= 0 && i >= hi - 5000; i--) if (x.o[i] === 3) { lastFailI = i; break; }
  const hours = [];
  for (let h = 23; h >= 0; h--) hours.push(w(C - (h + 1) * H, x.any) - w(C - h * H, x.any));
  return {
    any24: x.any[hi] - x.any[l24], runs24: x.runs[hi] - x.runs[l24], fail24: x.fail[hi] - x.fail[l24], deg24: x.deg[hi] - x.deg[l24],
    any7: w(C - 7 * D, x.any), any30: w(C - 30 * D, x.any), use30: w(C - 30 * D, x.use), fail7: w(C - 7 * D, x.fail), deg7: w(C - 7 * D, x.deg),
    last: hi > 0 ? x.t[hi - 1] : null, lastRunOutcome, lastFailI, hours,
  };
}
const T = [], Bv = enc.b, Ov = enc.o, Nv = enc.n;
{ let acc = T0; for (const d of enc.dt) { acc += d; T.push(acc * 1000); } }
const Uv = events.map(e => e.kind === 'done' ? 0 : 1);
const IX = makeIndex(T, Bv, Ov, Nv, BOXES.length, Uv);
// map each box-local index back to the global event, for "last failure" detail
const globalOf = BOXES.map(() => []);
for (let i = 0; i < T.length; i++) globalOf[Bv[i]].push(i);

// ── 5 · static summary at build time ─────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtT = ms => { if (ms == null) return 'never'; const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function ago(ms, C) { if (ms == null) return 'never'; const s = (C - ms) / 1000;
  return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
const fmtN = n => n.toLocaleString('en-US');

// other agents: top types in 7 days
function topTypes(boxId, days) {
  const c = {};
  for (const e of events) if (e.box === boxId && e.kind === 'spawn' && e.t >= NOW - days * 864e5) { const ty = (e.detail || '').split(' · ')[0]; c[ty] = (c[ty] || 0) + e.n; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4);
}
function verdictOf(box, c, st) {
  const last = c.last != null ? ago(c.last, NOW) : null;
  const lastFail = c.lastFailI >= 0 ? strs[enc.d[globalOf[BOX_INDEX[box.id]][c.lastFailI]]] : null;
  let v;
  if (st === 'failing') v = `Failing: the last run in 24 h failed (${lastFail || 'no detail'}).`;
  else if (st === 'degraded') v = `Degraded: ${fmtN(c.fail24)} failed and ${fmtN(c.deg24)} degraded of ${fmtN(c.runs24)} outcomes in 24 h.`;
  else if (st === 'working') v = `Working: ${fmtN(c.any24)} events in 24 h, last ${last}.` + (c.fail7 ? ` ${fmtN(c.fail7)} failed in 7 days, the latest ${lastFail || 'without detail'}.` : '');
  else if (st === 'dead') v = `Dead: switched on (${box.why}) yet no event in 7 days.` + (last ? ` Last seen ${last}.` : ' Never seen in any ledger.');
  else v = `Idle: nothing in the last 24 h (${box.why}).` + (last ? ` Last used ${last}, ${fmtN(c.use30)} ${unitOf(box)} in 30 days.` : ` Never in the data (${DAYS} days).`);
  if (box.id === 'other') { const tt = topTypes('other', 7); if (tt.length) v += ' Top types in 7 days: ' + tt.map(([k, n]) => `${k} ×${n}`).join(', ') + '.'; }
  if (box.id === 'workflow') v += ` ${fmtN(wfUntyped)} of ${fmtN(wfTotal)} workflow runs in the ${DAYS}-day window carry no type; ${fmtN(wfTotal - wfUntyped)} got a role label from the workflow journal.`;
  return v;
}
let wfTotal = 0, wfUntyped = 0;
for (const e of events) if (e.box === 'workflow' && e.kind === 'spawn') { wfTotal += e.n; if (/no label/.test(e.detail)) wfUntyped += e.n; }


// ── nudges: did a route-gate warn or an errand-router warn get followed? ──────────────────────
// Rule (gate): a route-gate verdict warn or deny is "followed by ai-coder" when an ai-coder, ai-coder-high (any ech:/harness: prefix), composer-coder run, or a composer runs.jsonl run, starts in the same session_id within 15 min after it; else "followed by a project coder" when an implementer or feature-crew-coder run starts there in that window; else "ignored".
// Rule (errand): an errand-router action "warn" (shown to the session; the control arm's would-warn is never shown and is excluded) is "followed" when an Explore or code-explorer run starts in the same session within 5 min; else "ignored".
// A nudge with no session_id cannot be judged; a nudge younger than its window at build time is "pending".
const NUDGE_DAYS = 30, GATE_WIN = 15 * 60e3, ERR_WIN = 5 * 60e3, N_SINCE = process.env.NUDGE_SINCE ? Date.parse(process.env.NUDGE_SINCE) : NOW - NUDGE_DAYS * 864e5;   // NUDGE_SINCE (ISO date) is for ad hoc queries only
const bare = t => String(t || '').replace(/^(ech|harness):/, '');
const classOf = t => { const b = bare(t);
  if (b === 'ai-coder' || b === 'ai-coder-high' || b === 'composer-coder') return 'coder';
  if (b === 'implementer' || b === 'feature-crew-coder') return 'pcoder';
  if (b === 'code-explorer' || b === 'Explore' || b === 'explore') return 'explore';
  return null; };
const starts = new Map();   // session -> [{t, cls}]
const addStart = (sess, t, cls) => { if (!sess || !cls || !isFinite(t)) return; let a = starts.get(sess); if (!a) starts.set(sess, a = []); a.push({ t, cls }); };
const projOfSess = new Map();
const readJsonl = f => fs.existsSync(f) ? readLinesSync(f, 0).lines.map(parse).filter(Boolean) : [];
const routingRows = readJsonl(PATHS.routing), errandRows = readJsonl(PATHS.errand), runRows = readJsonl(PATHS.runs), hookRows = readJsonl(PATHS.agents);
const backRows = fs.existsSync(BACKFILL_OUT) ? readLinesSync(BACKFILL_OUT, 0).lines.map(parse).filter(Boolean) : [];
const pbase = v => v ? path.basename(String(v)).replace(/[^\w.@-]/g, '').slice(0, 40) : null;
for (const r of routingRows) {
  if (r.session_id && r.cwd_name && !projOfSess.has(r.session_id)) projOfSess.set(r.session_id, pbase(r.cwd_name));
  if (r.kind === 'delegate') addStart(r.session_id, Date.parse(r.ts), classOf(r.subagent_type));
}
for (const r of backRows) { addStart(r.sess, r.t, classOf(r.type)); if (r.sess && r.proj && !projOfSess.has(r.sess)) projOfSess.set(r.sess, pbase(r.proj)); }
for (const r of hookRows) if (r.event === 'SubagentStart') addStart(r.session_id, Date.parse(r.ts), classOf(r.agent_type));
for (const r of runRows) if (r.session_id && r.phase !== 'merge') addStart(r.session_id, Date.parse(r.ts) - (r.duration_ms || r.wall_ms || 0), 'coder');
// sessions with no routing row and no agent run: read cwd from the head of their own transcript (projects/<slug>/<session>.jsonl), basename only
const PROJ_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
let slugDirs = null;
function projFromTranscript(sid) {
  if (!/^[0-9a-f-]{36}$/.test(sid || '')) return null;
  slugDirs ??= (() => { try { return fs.readdirSync(PROJ_DIR); } catch { return []; } })();
  for (const d of slugDirs) {
    const f = path.join(PROJ_DIR, d, sid + '.jsonl');
    if (!fs.existsSync(f)) continue;
    try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
      const m = b.subarray(0, n).toString('utf8').match(/"cwd":"([^"]{1,300})"/); return m ? pbase(m[1]) : null; } catch { return null; }
  }
  return null;
}
const projFor = sid => { if (!projOfSess.has(sid)) projOfSess.set(sid, projFromTranscript(sid)); return projOfSess.get(sid); };
const firstIn = (sess, t, win, classes) => { const a = starts.get(sess) || []; let best = null;
  for (const s of a) if (s.t >= t && s.t <= t + win && classes.includes(s.cls)) { const rank = classes.indexOf(s.cls); if (best == null || rank < best) best = rank; }
  return best == null ? null : classes[best]; };
const NUD = { gate: { total: 0, coder: 0, pcoder: 0, ignored: 0, unjudged: 0, pending: 0 }, errand: { total: 0, followed: 0, ignored: 0, unjudged: 0, pending: 0 },
  control: { total: 0, followed: 0 } };
const byProj = new Map();
const P = name => { let x = byProj.get(name); if (!x) byProj.set(name, x = { g: 0, gc: 0, gp: 0, gi: 0, e: 0, ef: 0, ei: 0 }); return x; };
for (const r of routingRows) {
  if (r.kind !== 'gate' || !(r.verdict === 'warn' || r.verdict === 'deny')) continue;
  const t = Date.parse(r.ts); if (!(t >= N_SINCE)) continue;
  NUD.gate.total++;
  if (!r.session_id) { NUD.gate.unjudged++; continue; }
  if (t > NOW - GATE_WIN) { NUD.gate.pending++; continue; }
  const x = P(pbase(r.cwd_name) || projFor(r.session_id) || '(no project recorded)'); x.g++;
  const f = firstIn(r.session_id, t, GATE_WIN, ['coder', 'pcoder']);
  if (f === 'coder') { NUD.gate.coder++; x.gc++; } else if (f === 'pcoder') { NUD.gate.pcoder++; x.gp++; } else { NUD.gate.ignored++; x.gi++; }
}
for (const r of errandRows) {
  const t = Date.parse(r.ts); if (!(t >= N_SINCE)) continue;
  if (r.action === 'would-warn') { if (r.session_id && t <= NOW - ERR_WIN) { NUD.control.total++; if (firstIn(r.session_id, t, ERR_WIN, ['explore'])) NUD.control.followed++; } continue; }
  if (r.action !== 'warn') continue;
  NUD.errand.total++;
  if (!r.session_id) { NUD.errand.unjudged++; continue; }
  if (t > NOW - ERR_WIN) { NUD.errand.pending++; continue; }
  const x = P(projFor(r.session_id) || '(no project recorded)'); x.e++;
  if (firstIn(r.session_id, t, ERR_WIN, ['explore'])) { NUD.errand.followed++; x.ef++; } else { NUD.errand.ignored++; x.ei++; }
}
const projRowsAll = [...byProj.entries()].sort((a, b) => (b[1].gi + b[1].ei) - (a[1].gi + a[1].ei) || (b[1].g + b[1].e) - (a[1].g + a[1].e));
const PROJ_TOP = 12;
const projRows = projRowsAll.slice(0, PROJ_TOP);
if (projRowsAll.length > PROJ_TOP) { const o = { g: 0, gc: 0, gp: 0, gi: 0, e: 0, ef: 0, ei: 0 }; for (const [, x] of projRowsAll.slice(PROJ_TOP)) for (const k in o) o[k] += x[k]; projRows.push([`${projRowsAll.length - PROJ_TOP} other projects`, o]); }
const nudgeLine = { 'route-gate': `nudges 30 d: ${NUD.gate.total}, → ai-coder ${NUD.gate.coder}, → project coder ${NUD.gate.pcoder}, ignored ${NUD.gate.ignored}`,
  'errand-router': `nudges 30 d: ${NUD.errand.total}, followed ${NUD.errand.followed}, ignored ${NUD.errand.ignored}` };
const SUM = BOXES.map((b, i) => { const c = countsAt(IX[i], NOW); const st = stateOf(c, b.expected); return { b, c, st, verdict: verdictOf(b, c, st) }; });
const by = st => SUM.filter(x => x.st === st);
const names = a => a.map(x => x.b.label).join(', ');

// ── 6 · render ───────────────────────────────────────────────────────────────────────────────
const STATE_LABEL = { working: 'working', failing: 'not working', degraded: 'degraded', dead: 'dead', idle: 'idle' };
const GROUP_LABEL = { main: 'session', hook: 'hook', agent: 'agent', oncall: 'observer', engine: 'engine' };
function lastUsed(t, C) { return t == null ? 'never in the data' : 'last used ' + ago(t, C); }
function unitOf(b) { return b.group === 'agent' || b.group === 'engine' || b.group === 'oncall' ? 'runs' : 'events'; }
// ── box marks ────────────────────────────────────────────────────────────────────────────────
// A mark is here to make a box findable at a glance while packets are flying between twenty of
// them — not decoration. Only the boxes that stand for a named outside engine get one, plus the
// observer, whose whole job is one idea (it guards) that a shield says faster than its label.
// Each is an inline <svg> so the page still shows them with JavaScript off and over file://.
const MARK = {
  // Claude's sunburst, for the delegation service: Claude Code running on another account.
  delegation: `<svg class="mk mk-claude" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.23,9.52L12.00,1.00L12.77,9.52ZM13.01,9.60L17.40,5.57L14.19,10.59ZM14.31,10.81L22.83,10.09L14.58,12.33ZM14.54,12.58L19.27,16.20L13.77,13.91ZM13.57,14.07L15.76,22.34L12.13,14.60ZM11.87,14.60L9.13,19.89L10.43,14.07ZM10.23,13.91L2.47,17.50L9.46,12.58ZM9.42,12.33L3.73,10.54L9.69,10.81ZM9.81,10.59L4.93,3.57L10.99,9.60ZM12 9.1a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8Z"/></svg>`,
  // a pointer, for Cursor
  cursor: `<svg class="mk mk-cursor" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 2.6 20 12.1l-7.1.9-3.2 6.6z"/></svg>`,
  // three crossed capsules: the interlocking knot OpenAI's mark is built from, for Codex / Astra
  astra: `<svg class="mk mk-codex" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.2" y="9.1" width="17.6" height="5.8" rx="2.9"/><rect x="3.2" y="9.1" width="17.6" height="5.8" rx="2.9" transform="rotate(60 12 12)"/><rect x="3.2" y="9.1" width="17.6" height="5.8" rx="2.9" transform="rotate(120 12 12)"/></g></svg>`,
  // a shield, for the observer that checks every claim before it reaches you
  'claim-sentinel': `<svg class="mk mk-shield" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4 20 5.3v6.1c0 4.7-3.2 8.8-8 10.2-4.8-1.4-8-5.5-8-10.2V5.3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8.2 12.1 2.6 2.7 5-5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
MARK['astra-agent'] = MARK.astra;          // the lane and the engine behind it carry the same mark
// ── onion geometry ───────────────────────────────────────────────────────────────────────────
// The tree reads top-down, which says "a pipeline". The onion says the true thing instead: the
// conversation is the middle, and every ring out from it is work that left the conversation.
// Positions are computed here, not in the browser, so the layout survives with JavaScript off.
// The DOM is unchanged — the rows become `display:contents` — so edge() and center() still work.
//
// The rings are ellipses, because a screen is wide and not tall: perfect circles big enough to
// hold eleven lane cards without touching would need 1,485px of height. And because card text
// changes length, the ring positions are only a starting point — relax() then pushes apart any
// pair that still overlaps, so adding a lane can never silently produce two cards on top of each
// other. BW/BH are the card plus the air it has to keep; they must match page.css.
const ONION = { w: 1340, h: 1000, cx: 670, cy: 500 };
const BW = 158 + 20, BH = 93 + 16;
const RING = {                    // rx, ry, and the bearing (deg, 0 = straight up) of the first card
  // Each ring starts at a different bearing on purpose. With every ring starting at 0 the cards
  // line up in a column straight above the centre and the rings stop reading as rings.
  hook:   { rx: 210, ry: 132, from: 90 },   // the two hooks sit left and right of the conversation
  agent:  { rx: 400, ry: 252, from: 16 },
  engine: { rx: 548, ry: 372, from: 52 },
  oncall: { rx: 575, ry: 435, from: 0 },    // the shield, straight above everything
};
function ringPos(group, i, n) {
  if (group === 'main') return { x: ONION.cx, y: ONION.cy, fixed: true };
  const r = RING[group];
  if (!r) return null;
  const a = ((r.from + (i * 360) / n) - 90) * Math.PI / 180;
  return { x: ONION.cx + r.rx * Math.cos(a), y: ONION.cy + r.ry * Math.sin(a), fixed: false };
}
// Separating axis, resolved on whichever axis is cheaper, until nothing overlaps.
function relax(pts) {
  for (let pass = 0; pass < 80; pass++) {
    let hits = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      const ox = BW - Math.abs(a.x - b.x), oy = BH - Math.abs(a.y - b.y);
      if (ox <= 0 || oy <= 0) continue;
      hits++;
      const ax = a.fixed ? 0 : 1, bx = b.fixed ? 0 : 1, tot = ax + bx || 1;
      if (ox / BW <= oy / BH) {
        const s = (a.x >= b.x ? 1 : -1) * ox / tot;
        a.x += s * ax; b.x -= s * bx;
      } else {
        const s = (a.y >= b.y ? 1 : -1) * oy / tot;
        a.y += s * ay_(ax); b.y -= s * ay_(bx);
      }
    }
    if (!hits) break;
  }
  const mx = BW / 2 + 4, my = BH / 2 + 4;
  for (const q of pts) if (!q.fixed) {
    q.x = Math.min(ONION.w - mx, Math.max(mx, q.x));
    q.y = Math.min(ONION.h - my, Math.max(my, q.y));
  }
}
const ay_ = v => v;   // readability only: the y branch moves each box by its own weight
const POS = {};
{
  const all = [];
  for (const g of ['main', 'hook', 'agent', 'engine', 'oncall']) {
    const list = SUM.filter(x => x.b.group === g);
    list.forEach((x, i) => { const q = ringPos(g, i, list.length); if (q) { q.id = x.b.id; all.push(q); } });
  }
  relax(all);
  for (const q of all) POS[q.id] = q;
}
const ringsHtml = ['hook', 'agent', 'engine']
  .map(g => `<i class="ring" style="--rx:${RING[g].rx}px;--ry:${RING[g].ry}px" aria-hidden="true"></i>`).join('');
function boxHtml(x, i, all) {
  const max = Math.max(1, ...x.c.hours);
  const bars = x.c.hours.map(h => `<i style="height:${h ? Math.max(8, Math.round(100 * Math.sqrt(h / max))) : 0}%"></i>`).join('');
  const o = POS[x.b.id];
  const at = o ? ` style="--ox:${o.x.toFixed(1)}px;--oy:${o.y.toFixed(1)}px"` : '';
  return `<div class="bx st-${x.st}" data-box="${x.b.id}" id="bx-${x.b.id}"${at}>
  <div class="bx-h">${MARK[x.b.id] || ''}<span class="bx-n" title="${esc(x.b.label)}">${esc(x.b.label)}</span><span class="chip">${STATE_LABEL[x.st]}</span></div>
  <div class="bx-m"><span class="bx-last">${lastUsed(x.c.last, NOW)}</span><span class="bx-24">${fmtN(x.c.any24)}/24h</span></div>
  <div class="bx-u">30 d: ${fmtN(x.c.use30)} ${unitOf(x.b)}</div>${nudgeLine[x.b.id] ? `<div class="bx-nudge">${esc(nudgeLine[x.b.id])}</div>` : ''}
  <div class="bars" aria-hidden="true">${bars}</div>
</div>`;
}
const G = g => SUM.filter(x => x.b.group === g);
const OC_NOTE = 'Observer paired with every main loop. A report in /tmp/claim-sentinel is a flag it raised; observer runs come from subagent transcripts.';
const stageHtml = `<div class="stage-top"><button type="button" id="layout" class="btn" aria-pressed="true">layout: onion</button><p class="onion-legend">Rings out from the middle: <b>your conversation</b> · the hooks in front of every edit · the lanes it spawns · the engines they run on · and, above everything, the observer that checks what comes back.</p></div>
<div class="stage onion" id="stage" data-no-split>
  ${ringsHtml}
  <aside class="oncall"><div class="lbl">on call</div>${G('oncall').map(boxHtml).join('')}<p class="oc-note">${esc(OC_NOTE)}</p></aside>
  <div class="tree">
    <div class="lbl">session</div><div class="row r-main">${G('main').map(boxHtml).join('')}</div>
    <div class="lbl">hooks</div><div class="row r-hook">${G('hook').map(boxHtml).join('')}</div>
    <div class="lbl">lanes</div><div class="row r-agent">${G('agent').map(boxHtml).join('')}</div>
    <div class="lbl">engines</div><div class="row r-engine">${G('engine').map(boxHtml).join('')}</div>
  </div>
  <svg class="edges" id="edges" aria-hidden="true"></svg>
</div>`;

const tableRows = SUM.map(x => `<tr class="st-${x.st}" data-box="${x.b.id}"><th scope="row">${esc(x.b.label)}<span class="grp">${GROUP_LABEL[x.b.group]}</span></th><td><span class="chip">${STATE_LABEL[x.st]}</span></td><td class="num">${x.c.last == null ? 'never in the data' : fmtT(x.c.last) + '<span class="ago">' + ago(x.c.last, NOW) + '</span>'}</td><td class="num">${fmtN(x.c.any24)}</td><td class="num">${fmtN(x.c.any7)}</td><td class="num">${fmtN(x.c.any30)}</td><td class="num">${fmtN(x.c.use30)} <span class="unit">${unitOf(x.b)}</span></td><td class="num">${x.c.fail7 ? '<b>' + fmtN(x.c.fail7) + '</b>' : '0'}${x.c.deg7 ? ' <span class="degn">+' + fmtN(x.c.deg7) + ' degraded</span>' : ''}</td><td class="verdict">${esc(x.verdict)}</td></tr>`).join('\n');

// TL;DR
const fails = by('failing'), degs = by('degraded'), deads = by('dead'), works = by('working');
const why = x => { const lf = x.c.lastFailI >= 0 ? strs[enc.d[globalOf[BOX_INDEX[x.b.id]][x.c.lastFailI]]] : ''; return `${x.b.label}${lf ? ' (' + lf.split(' · ').slice(0, 3).join(' · ') + ')' : ''}`; };
const coderLanes = ['ai-coder', 'ai-coder-high', 'project-coder', 'cursor'].map(id => SUM.find(x => x.b.id === id));
const failed24 = SUM.filter(x => x.c.fail24 > 0 && x.st !== 'failing');
const degWhy = x => `${x.b.label} (${fmtN(x.c.deg24 + x.c.fail24)} of ${fmtN(x.c.runs24)} outcomes in 24 h)`;
const fail7 = SUM.filter(x => x.c.fail7 > 0);
const lastFailOf = x => x.c.lastFailI >= 0 ? strs[enc.d[globalOf[BOX_INDEX[x.b.id]][x.c.lastFailI]]] : '';
const tldr = [
  fails.length ? `<p class="lede"><b>Not working now: ${esc(fails.map(why).join('; '))}.</b></p>`
    : failed24.length ? `<p class="lede"><b>No box is failing now, but ${esc(failed24.map(x => `${x.b.label} failed ${fmtN(x.c.fail24)}×`).join(', '))} in the past 24 h</b> and succeeded afterwards.</p>`
    : `<p class="lede"><b>No failure in the past 24 h</b>: zero fail outcomes in any box's ledger events.</p>`,
  degs.length ? `<p><b>Degraded</b>: ${esc(degs.map(degWhy).join('; '))}. For Jev that means a null answer or a confidence under the threshold, so the hook fell back to its fixed rules.</p>` : '',
  `<p>${deads.length ? `<b>Dead</b>, switched on but silent for 7 days: <b>${esc(names(deads))}</b>.` : 'Nothing switched on has been silent for 7 days.'} ${fail7.length ? `Failures in the last 7 days: ${esc(fail7.map(x => `${x.b.label} ×${fmtN(x.c.fail7)} (latest ${lastFailOf(x).split(' · ').slice(-2).join(' · ')})`).join('; '))}.` : 'No failure recorded in the last 7 days.'}</p>`,
  `<p><b>Coder lanes</b>: ${coderLanes.map(x => `${x.b.label} ${x.c.last == null ? 'never in the data' : 'last used ' + ago(x.c.last, NOW)} (${fmtN(x.c.use30)} runs in 30 d)`).join(', ')}. In 30 days route-gate nudged ${fmtN(NUD.gate.total)} edits toward a coder lane: <b>${fmtN(NUD.gate.ignored)} ignored</b>, ${fmtN(NUD.gate.coder)} followed by ai-coder, ${fmtN(NUD.gate.pcoder)} by a project coder.</p>`,
  `<p class="act">Working in the last 24 h: ${esc(names(works)) || 'nothing'}.</p>`,
].filter(Boolean).join('\n');


const nudgeTable = `<h2>Ignored nudges by project, last ${NUDGE_DAYS} days</h2>
<p class="note">A route-gate warn counts as followed when an ai-coder or ai-coder-high run (any ech: or harness: prefix, composer-coder, or a composer-run run) starts in the same session within 15 minutes, or, reported apart, an implementer or feature-crew-coder run. An errand-router warn counts as followed when an Explore or code-explorer run starts in the same session within 5 minutes. Every nudge had a session id (${fmtN(NUD.gate.unjudged + NUD.errand.unjudged)} could not be judged); ${fmtN(NUD.gate.pending + NUD.errand.pending)} were still inside their window at build time and are left out. Projects named aicoder-shadow-* are the coder engine's own worktree sessions (${fmtN(projRowsAll.filter(([k]) => /^aicoder-shadow-/.test(k)).reduce((a, [, x]) => a + x.g, 0))} gate nudges): there the gate fired inside the coder, not in a main session that ignored it.</p>
<div class="tablewrap"><table class="sum nud" id="nudges">
<thead><tr><th scope="col">project</th><th scope="col">gate nudges</th><th scope="col">→ ai-coder</th><th scope="col">→ project coder</th><th scope="col">gate ignored</th><th scope="col">errand nudges</th><th scope="col">→ explore</th><th scope="col">errand ignored</th></tr></thead>
<tbody>
${projRows.map(([name, x]) => `<tr data-proj="${esc(name)}"><th scope="row">${esc(name)}</th><td class="num">${fmtN(x.g)}</td><td class="num">${fmtN(x.gc)}</td><td class="num">${fmtN(x.gp)}</td><td class="num">${x.gi ? '<b>' + fmtN(x.gi) + '</b>' : '0'}</td><td class="num">${fmtN(x.e)}</td><td class="num">${fmtN(x.ef)}</td><td class="num">${x.ei ? '<b>' + fmtN(x.ei) + '</b>' : '0'}</td></tr>`).join('\n')}
<tr class="tot" data-proj="(total)"><th scope="row">total</th><td class="num">${fmtN(NUD.gate.coder + NUD.gate.pcoder + NUD.gate.ignored)}</td><td class="num">${fmtN(NUD.gate.coder)}</td><td class="num">${fmtN(NUD.gate.pcoder)}</td><td class="num"><b>${fmtN(NUD.gate.ignored)}</b></td><td class="num">${fmtN(NUD.errand.followed + NUD.errand.ignored)}</td><td class="num">${fmtN(NUD.errand.followed)}</td><td class="num"><b>${fmtN(NUD.errand.ignored)}</b></td></tr>
</tbody></table></div>`;
const rangeFirst = events.length ? events[0].t : SINCE, rangeLast = events.length ? events.at(-1).t : NOW;
const failTotal = events.filter(e => e.outcome === 'fail').length;
const staticLog = events.slice(-40).map(e => `<div class="lr o-${e.outcome}"><span class="lt">${fmtT(e.t).slice(5)}</span><span class="ls">${esc(BOXES[BOX_INDEX[e.box]].label)}</span><span class="lk">${esc(e.kind.replace(/-/g, ' '))}</span><span class="ld">${esc(e.detail)}</span><span class="lo">${e.outcome}</span></div>`).join('');

// sparkline: pure function, also used by the page
function sparkSvg(T, O, N, from, to, bins) {
  const W = 1000, Hh = 46, c = new Array(bins).fill(0), fails = [];
  const span = Math.max(1, to - from);
  for (let i = 0; i < T.length; i++) { const t = T[i]; if (t < from || t > to) continue; const k = Math.min(bins - 1, Math.floor((t - from) / span * bins)); c[k] += N[i]; if (O[i] === 3) fails.push((t - from) / span * W); }
  const mx = Math.max(1, ...c);
  let d = 'M0,' + Hh;
  for (let k = 0; k < bins; k++) { const y = Hh - Math.sqrt(c[k] / mx) * (Hh - 4); d += 'L' + (k * W / bins).toFixed(1) + ',' + y.toFixed(1) + 'L' + ((k + 1) * W / bins).toFixed(1) + ',' + y.toFixed(1); }
  d += 'L' + W + ',' + Hh + 'Z';
  const ticks = [...new Set(fails.map(x => Math.round(x)))].map(x => `<line x1="${x}" x2="${x}" y1="${Hh}" y2="${Hh + 12}" class="ft"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${Hh + 12}" preserveAspectRatio="none" class="spark" role="img" aria-label="event density over the period, failures as red ticks"><path d="${d}" class="sp"/>${ticks}</svg>`;
}
const defStart = NOW - 7 * 864e5;
const staticSpark = sparkSvg(T, Ov, Nv, defStart, NOW, 240);

const kit = fs.readFileSync(path.join(os.homedir(), '.claude/skills/visualizer/assets/sentence-divs.js'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'page.css'), 'utf8');
const pageJs = fs.readFileSync(path.join(DIR, 'page.js'), 'utf8');
const META = { now: NOW, boxes: BOXES.map(b => ({ id: b.id, label: b.label, group: b.group, expected: b.expected, why: b.why })), defStart };
const sourcesLine = `routing.jsonl (route-gate), errand-router.jsonl, runs.jsonl (composer-run), delegate.jsonl, agents.jsonl (SubagentStart/Stop hook${fs.existsSync(PATHS.agents) ? '' : ', not yet written'}), session and subagent transcripts (metadata backfill), /tmp/claim-sentinel reports, Astra probe logs, settings.json switches (ech ${SWITCHES.ech ? 'on' : 'off'}, ROUTE_GATE_JEV=${SWITCHES.ROUTE_GATE_JEV ? 1 : 0}, ERRAND_ROUTER_JEV=${SWITCHES.ERRAND_ROUTER_JEV ? 1 : 0})`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness dashboard</title>
<meta name="viz-kind" content="dashboard replay">
<meta name="viz-subject" content="ech harness: hooks, lanes, engines, observer — state now and replay">
<meta name="viz-sources" content="${esc(sourcesLine)}">
<style>${css}</style>
</head><body>
<main class="wrap">
<header class="top"><h1>Harness dashboard</h1><p class="sub">ech harness on this Mac · built ${fmtT(NOW)} (${esc(tz)}) · ${fmtN(events.length)} events from ${fmtT(rangeFirst).slice(0, 10)} to ${fmtT(rangeLast).slice(0, 10)}</p></header>

<section data-tldr class="tldr">
${tldr}
</section>

<h2>State of every part, now</h2>
<div class="tablewrap"><table class="sum" id="sum">
<thead><tr><th scope="col">box</th><th scope="col">state now</th><th scope="col">last used</th><th scope="col">events 24 h</th><th scope="col">7 d</th><th scope="col">30 d</th><th scope="col">runs 30 d</th><th scope="col">failed 7 d</th><th scope="col">verdict</th></tr></thead>
<tbody>
${tableRows}
</tbody></table></div>

${nudgeTable}

<details class="legend" open><summary>How a state is decided</summary>
<ul class="lg">
<li><span class="chip c-working">working</span> At least one event in the 24 h before the cursor, and the last outcome was a success.</li>
<li><span class="chip c-failing">not working</span> The last outcome in those 24 h was a failure (error, REJECT, timeout, exit not 0, failed or crashed run), or at least half the outcomes failed.</li>
<li><span class="chip c-degraded">degraded</span> The last outcome was degraded (Jev returned null or low confidence, a run was killed, a delegation was refused), or a quarter of outcomes were bad.</li>
<li><span class="chip c-dead">dead</span> Installed and switched on in settings.json, meant to fire in normal use, and no event at all for 7 days.</li>
<li><span class="chip c-idle">idle</span> Nothing in the last 24 h; see last used. Idle does not mean never used: every box shows when it was last used and how many runs it had in 30 days.</li>
</ul>
<p class="note">Counts are events: one per ledger line, except direct edits, gate passes, spawn sightings and read-only errands, which are bucketed per minute and counted by their size. Every failure, agent run, Jev call and gate warn is kept one by one. Agent spawns count as activity, not as outcomes.</p>
</details>

<h2>Replay</h2>
<div class="controls" id="controls" data-no-split>
  <label class="ctl">start <input type="datetime-local" id="start" value="${fmtT(defStart).replace(' ', 'T')}"></label>
  <button id="play" type="button" class="btn">▶ play</button>
  <span class="seg" role="group" aria-label="speed">${[1, 10, 60, 600, 3600].map(s => `<button type="button" class="btn sp-b" data-speed="${s}" aria-pressed="${s === 600 ? 'true' : 'false'}">×${s}</button>`).join('')}</span>
  <button type="button" class="btn" id="skip" aria-pressed="true">skip quiet gaps: on</button>
  <button type="button" class="btn" id="prev">◀ step</button>
  <button type="button" class="btn" id="next" data-next>step ▶</button>
  <button type="button" class="btn live" id="live" aria-pressed="false" hidden>LIVE: off</button>
</div>
<div class="scrub" data-no-split>
  <div id="sparkwrap">${staticSpark}</div>
  <input type="range" id="scrub" min="0" max="1000" value="1000" aria-label="replay cursor">
  <div class="scrub-ends"><span id="sFrom">${fmtT(defStart)}</span><span id="cursor">cursor ${fmtT(NOW)}</span><span id="sTo">${fmtT(NOW)}</span></div>
</div>
${stageHtml}
<div class="status" id="status" data-no-split><span id="stPeriod">period ${fmtT(defStart)} → ${fmtT(NOW)}</span><span id="stEv">${fmtN(events.length)} events in the build</span><span id="stOk">${fmtN(events.filter(e => e.outcome === 'ok').length)} ok</span><span id="stFail">${fmtN(failTotal)} failed</span><span id="stSpeed">speed ×600, paused</span></div>
<div class="log" id="log" data-no-split aria-live="off"><div class="lr lh"><span class="lt">time</span><span class="ls">source</span><span class="lk">event</span><span class="ld">detail</span><span class="lo">outcome</span></div>${staticLog}</div>

<h2>What this page cannot tell you</h2>
<ul class="gaps">
<li>Agent runs before the SubagentStart/Stop hook exist only as far as transcripts survive. A deleted transcript is a missing run, not an idle box.</li>
<li>Hooks run in warn mode: a gate warn shows the advice was given, not whether the session followed it.</li>
<li>A claim-sentinel report is a flag raised. Whether the flagged claim was wrong is not recorded anywhere this page reads.</li>
<li>${fmtN(wfUntyped)} workflow agent runs carry only the placeholder type, so they cannot be split by role.</li>
</ul>
<p class="src">Sources: ${esc(sourcesLine)}. Details are built from enum fields, numbers and basenames only; no instruction, command, file or error text is copied.</p>
</main>
<script type="application/json" id="data">${JSON.stringify(enc)}</script>
<script type="application/json" id="meta">${JSON.stringify(META)}</script>
<script>
${stateOf.toString()}
${makeIndex.toString()}
${countsAt.toString()}
${sparkSvg.toString()}
${pageJs}
</script>
<script>${kit}</script>
</body></html>
`;
fs.mkdirSync(path.dirname(VIZ_OUT), { recursive: true });
fs.writeFileSync(VIZ_OUT, html);
const states = {}; for (const x of SUM) states[x.b.id] = x.st;
// fail the build when the JS-on tree at arrival disagrees with the JS-off markup (skip with --no-check)
if (!process.argv.includes('--no-check')) {
  const r = spawnSync(process.execPath, [path.join(DIR, 'check-states.mjs'), VIZ_OUT], { encoding: 'utf8' });
  process.stderr.write(r.stdout + r.stderr);
  if (r.status !== 0) { console.error(r.status === 2 ? 'build: state check could not run' : 'build: FAILED, JS-on states differ from the static markup'); process.exitCode = 1; }
}
console.log(JSON.stringify({ out: VIZ_OUT, bytes: Buffer.byteLength(html), mb: +(Buffer.byteLength(html) / 1e6).toFixed(2), events: events.length, raw_events: raw.length,
  events_per_source: perSource, ledger_lines: rawLines, range: [new Date(rangeFirst).toISOString(), new Date(rangeLast).toISOString()], boxes: BOXES.length, states, nudges: NUD, nudges_by_project: Object.fromEntries(projRowsAll) }, null, 1));
