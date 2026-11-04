#!/usr/bin/env node
// Backfill agent runs from Claude Code transcripts under ~/.claude/projects (recursive) into cache/agent-runs.jsonl.
// Two kinds of evidence, joined by agent id: an Agent/Task tool_use in any transcript (session or subagent), and a subagent transcript file (<session>/subagents/agent-<id>.jsonl, workflows below it) with its .meta.json.
// The second catches runs no Agent tool_use announces: observers (claim-sentinel) and workflow agents.
// Tool uses are deduplicated by tool_use id: a transcript re-writes the same assistant record verbatim (same uuid) after a resume or compaction, up to 17 times for one id.
// METADATA ONLY: time, agent type, model, duration, status, tokens, tool count, project basename, agent id.
// Prompts, descriptions and results are never read into the output.
// Files are streamed in chunks; a file that only grew is resumed from the byte where the last run stopped, so rebuilds are fast.
//
//   node backfill.mjs [--full] [--days N]
import fs from 'node:fs';
import path from 'node:path';
import { HOME, CACHE_DIR, BACKFILL_OUT, BACKFILL_STATE, safeType } from './lib.mjs';

const PROJECTS = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const full = process.argv.includes('--full');
const dIdx = process.argv.indexOf('--days');
const DAYS = dIdx > 0 ? +process.argv[dIdx + 1] : 90;
const since = Date.now() - DAYS * 864e5;
fs.mkdirSync(CACHE_DIR, { recursive: true });

let state = { files: {} };
if (!full) try { state = JSON.parse(fs.readFileSync(BACKFILL_STATE, 'utf8')); } catch {}

const MARK_USE = [Buffer.from('"name":"Agent"'), Buffer.from('"name":"Task"')];
const MARK_RES = Buffer.from('"resolvedModel"');
const MARK_NOTE = Buffer.from('<task-notification>');
const tag = (s, n) => { const m = s.match(new RegExp('<' + n + '>([^<\\\\]{0,200})</' + n + '>')); return m ? m[1].trim() : null; };
const lastTs = s => { let m, last = null; const re = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]{5,30})"/g; while ((m = re.exec(s))) last = m[1]; return last; };

function scanFile(file, st) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  let off = st.offset || 0;
  const CH = 8 << 20;
  let carry = Buffer.alloc(0);
  const buf = Buffer.alloc(CH);
  while (off < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(CH, size - off), off);
    if (n <= 0) break;
    let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0, nl;
    while ((nl = data.indexOf(10, start)) >= 0) {
      handle(data.subarray(start, nl), st);
      start = nl + 1;
    }
    carry = Buffer.from(data.subarray(start));
    off += n;
  }
  fs.closeSync(fd);
  st.offset = size - carry.length;     // an unterminated last line is re-read next time
  st.size = size;
}

function handle(line, st) {
  const isUse = MARK_USE.some(m => line.indexOf(m) >= 0);
  const isRes = line.indexOf(MARK_RES) >= 0;
  const isNote = line.indexOf(MARK_NOTE) >= 0;
  if (!isUse && !isRes && !isNote) return;
  const s = line.toString('utf8');
  if (isNote) {
    const ts = lastTs(s);
    for (const blk of s.split('<task-notification>').slice(1)) {
      const id = tag(blk, 'tool-use-id'); if (!id || !/^toolu_\w+$/.test(id)) continue;
      if (st.notes[id]) continue;                 // the first notification wins; later ones are replays
      const usage = blk.match(/<usage>([\s\S]{0,400}?)<\/usage>/)?.[1] || '';
      st.notes[id] = { ts, status: (tag(blk, 'status') || '').replace(/\W/g, '').slice(0, 16) || null,
        dur: +tag(usage, 'duration_ms') || null, tokens: +tag(usage, 'subagent_tokens') || null, tools: +tag(usage, 'tool_uses') || null };
    }
  }
  if (!isUse && !isRes) return;
  let r; try { r = JSON.parse(s); } catch { return; }
  const c = r.message?.content;
  if (!Array.isArray(c)) return;
  for (const x of c) {
    if (x?.type === 'tool_use' && (x.name === 'Agent' || x.name === 'Task')) {
      st.raw = (st.raw || 0) + 1;
      if (st.runs[x.id]) continue;
      const inp = x.input || {};
      st.runs[x.id] = { t: Date.parse(r.timestamp) || null, type: safeType(inp.subagent_type || 'general-purpose'),
        model: typeof inp.model === 'string' ? inp.model.replace(/[^\w.@-]/g, '').slice(0, 30) : null,
        bg: !!inp.run_in_background, proj: r.cwd ? path.basename(r.cwd).replace(/[^\w.@-]/g, '').slice(0, 40) : null,
        sess: String(r.sessionId || '').replace(/[^\w-]/g, '').slice(0, 40) || null, depth: st.kind };
    }
    if (x?.type === 'tool_result' && st.runs[x.tool_use_id]) {
      const run = st.runs[x.tool_use_id], u = r.toolUseResult;
      run.rts = Date.parse(r.timestamp) || null;
      if (x.is_error) run.rerr = true;
      if (u && typeof u === 'object') {
        if (u.resolvedModel) run.model = String(u.resolvedModel).replace(/[^\w.@\[\]-]/g, '').slice(0, 40);
        if (u.agentId) run.aid = String(u.agentId).replace(/\W/g, '').slice(0, 40);
        run.rstatus = String(u.status || '').replace(/\W/g, '').slice(0, 20) || null;
        if (u.totalDurationMs) run.dur = u.totalDurationMs;
        if (u.totalTokens) run.tokens = u.totalTokens;
        if (u.totalToolUseCount) run.tools = u.totalToolUseCount;
      }
    }
  }
}

const t0 = Date.now();
let scanned = 0, skipped = 0, bytes = 0;
const seenFiles = new Set();
// Where a transcript sits: "session" (projects/<slug>/<session>.jsonl), "subagent" (<session>/subagents/), "workflow" (<session>/subagents/workflows/<wf>/).
const kindOf = rel => /\/subagents\/workflows\//.test(rel) ? 'workflow' : /\/subagents\//.test(rel) ? 'subagent' : 'session';
// A subagent transcript is itself one run: type and observer flag from .meta.json, start/end from its first and last timestamps, model from its first assistant record.
function agentFileMeta(file, size) {
  const m = { aid: path.basename(file).replace(/^agent-|\.jsonl$/g, '').replace(/\W/g, '').slice(0, 40),
    sess: (file.match(/\/([0-9a-f-]{36})\/subagents\//) || [])[1] || null };
  try { const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    m.type = safeType(meta.agentType); m.observer = !!meta.isObserver; m.bg = meta.requestShape === 'background'; } catch {}
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 262144)); fs.readSync(fd, head, 0, head.length, 0);
    const tailLen = Math.min(size, 65536); const tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const h = head.toString('utf8'), tl = tail.toString('utf8');
    m.t0 = Date.parse((h.match(/"timestamp":"([^"]{10,40})"/) || [])[1]) || null;
    m.t1 = Date.parse(lastTs(tl)) || m.t0;
    m.model = ((h.match(/"model":"(claude-[\w.@\[\]-]{1,40})"/) || [])[1]) || null;
    const lastLine = tl.trimEnd().split('\n').pop() || '';
    m.err = /"isApiErrorMessage":true/.test(lastLine);
    m.cwd = ((h.match(/"cwd":"([^"]{1,300})"/) || [])[1]) || null;
  } finally { fs.closeSync(fd); }
  return m;
}
// Workflow agents mostly carry the placeholder type "workflow-subagent" in .meta.json; the workflow's own journal.jsonl names each agent with the label the script gave agent().
// Only the label's role prefix (text before the first ":", e.g. "audit" from "audit:<item>") is kept, so per-item names never reach the output.
const journals = new Map();
function journalLabel(file, aid) {
  const j = path.join(path.dirname(file), 'journal.jsonl');
  if (!journals.has(j)) {
    const m = new Map();
    try { for (const l of fs.readFileSync(j, 'utf8').split('\n')) { if (!l.includes('"started"')) continue;
      try { const o = JSON.parse(l); if (o.type === 'started' && o.agentId && o.label) m.set(String(o.agentId), String(o.label)); } catch {} } } catch {}
    journals.set(j, m);
  }
  const lab = journals.get(j).get(aid);
  return lab ? lab.split(':')[0].replace(/[^\w-]/g, '').slice(0, 24) || null : null;
}
function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) { walk(file); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    let stt; try { stt = fs.statSync(file); } catch { continue; }
    if (!stt.isFile() || stt.mtimeMs < since) continue;
    seenFiles.add(file);
    let st = state.files[file];
    if (st && st.size === stt.size) { skipped++; continue; }
    const kind = kindOf(file.slice(PROJECTS.length));
    if (!st || stt.size < st.size) st = state.files[file] = { offset: 0, size: 0, kind, runs: {}, notes: {}, raw: 0 };
    st.kind = kind;
    bytes += stt.size - st.offset;
    scanFile(file, st);
    if (kind !== 'session' && /^agent-/.test(e.name)) {
      st.agent = agentFileMeta(file, stt.size);
      if (kind === 'workflow' && (!st.agent.type || st.agent.type === 'workflow-subagent')) st.agent.wlabel = journalLabel(file, st.agent.aid);
    }
    scanned++;
  }
}
for (const d of fs.readdirSync(PROJECTS)) walk(path.join(PROJECTS, d));
for (const k of Object.keys(state.files)) if (!seenFiles.has(k)) delete state.files[k];
fs.writeFileSync(BACKFILL_STATE, JSON.stringify(state));

// join completions across files (a resumed session can complete a run started elsewhere)
const notes = {};
for (const st of Object.values(state.files)) for (const [id, n] of Object.entries(st.notes)) if (!notes[id]) notes[id] = n;
const rows = new Map();
for (const st of Object.values(state.files)) for (const [id, run] of Object.entries(st.runs)) {
  if (rows.has(id) || !run.t) continue;   // replayed tool_use in a resumed transcript
  const n = notes[id];
  let end = null, status = null;
  if (run.rerr) { end = run.rts; status = 'error'; }
  else if (run.rstatus === 'completed') { end = run.rts; status = 'completed'; }
  else if (n && n.ts) { end = Date.parse(n.ts) || null; status = n.status || 'completed'; }
  rows.set(id, { t: run.t, end, type: run.type, model: run.model, bg: run.bg, dur: run.dur ?? n?.dur ?? (end ? end - run.t : null),
    status, tokens: run.tokens ?? n?.tokens ?? null, tools: run.tools ?? n?.tools ?? null, proj: run.proj, aid: run.aid || null, sess: run.sess || null });
}
const byAid = new Set([...rows.values()].map(r => r.aid).filter(Boolean));
let fileOnly = 0;
for (const st of Object.values(state.files)) {
  const a = st.agent; if (!a || !a.t0) continue;
  // the Agent tool_use already carries this run: only fill an end it never got
  if (byAid.has(a.aid)) continue;
  fileOnly++;
  rows.set('file:' + a.aid, { t: a.t0, end: a.t1, type: a.type || (a.observer ? 'observer' : 'general-purpose'),
    model: a.model, bg: !!a.bg, dur: a.t1 - a.t0, status: a.err ? 'error' : 'completed', tokens: null, tools: null,
    proj: a.cwd ? path.basename(a.cwd).replace(/[^\w.@-]/g, '').slice(0, 40) : null, aid: a.aid, sess: a.sess, src: st.kind + '-file', observer: a.observer || undefined, wlabel: a.wlabel || undefined });
}
const out = [...rows.values()].sort((a, b) => a.t - b.t);
// per-depth accounting: files, raw Agent/Task tool_use blocks (with replays), unique tool_use ids first seen at that depth, file-only runs
const depth = {};
const firstSeen = new Set();
for (const st of Object.values(state.files)) {
  const d = depth[st.kind || 'session'] ??= { files: 0, raw_tool_uses: 0, unique_tool_uses: 0, agent_files: 0 };
  d.files++; d.raw_tool_uses += st.raw || 0; if (st.agent) d.agent_files++;
  for (const id of Object.keys(st.runs)) if (!firstSeen.has(id)) { firstSeen.add(id); d.unique_tool_uses++; }
}
fs.writeFileSync(BACKFILL_OUT, out.map(r => JSON.stringify(r)).join('\n') + '\n');
const byStatus = {};
for (const r of out) byStatus[r.status || 'no-completion'] = (byStatus[r.status || 'no-completion'] || 0) + 1;
console.log(JSON.stringify({ transcripts_scanned: scanned, unchanged_skipped: skipped, mb_read: +(bytes / 1e6).toFixed(1),
  workflow_placeholder_type: out.filter(r => r.type === 'workflow-subagent').length,
  workflow_placeholder_with_journal_label: out.filter(r => r.type === 'workflow-subagent' && r.wlabel).length,
  agent_runs: out.length, from_tool_use: out.length - fileOnly, from_agent_file_only: fileOnly, depth, by_status: byStatus, first: out[0] && new Date(out[0].t).toISOString(), last: out.at(-1) && new Date(out.at(-1).t).toISOString(),
  secs: +((Date.now() - t0) / 1000).toFixed(1), out: BACKFILL_OUT }));
