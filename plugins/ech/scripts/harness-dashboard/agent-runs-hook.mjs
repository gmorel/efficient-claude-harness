#!/usr/bin/env node
// Claude Code hook for SubagentStart and SubagentStop (both exist in the hooks reference, https://code.claude.com/docs/en/hooks, checked 2026-10-13).
// Appends one JSON line per event to <data>/agents.jsonl, where <data> is HARNESS_DATA_DIR, else
// CLAUDE_PLUGIN_DATA (exported to plugin hooks), else ~/.claude/harness-data. AGENT_RUNS_LEDGER overrides the file.
// Payload fields used: hook_event_name, session_id, agent_id, agent_type, cwd, and on stop agent_transcript_path.
// Neither event carries a model, a duration or a status, so: duration_ms comes from a start stamp this hook keeps per agent_id; model is read from the subagent's own transcript (first assistant record); ok is false only when that transcript ends on an API error record.
// last_assistant_message, prompts and transcript text are never written.
// Always exits 0 and never prints to stdout, so it can never block or steer a subagent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'harness-data');
const LEDGER = process.env.AGENT_RUNS_LEDGER || path.join(DATA_DIR, 'agents.jsonl');
const STATE = path.join(path.dirname(LEDGER), 'agents-state');
const clean = (v, n = 80) => v == null ? null : String(v).replace(/[^\w.@:\[\]-]/g, '').slice(0, n) || null;

function readSlice(file, fromEnd, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, len);
    const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, fromEnd ? size - n : 0);
    return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const p = JSON.parse(raw || '{}');
  const ev = p.hook_event_name;
  if (ev !== 'SubagentStart' && ev !== 'SubagentStop') return;
  const aid = clean(p.agent_id, 60);
  const rec = { ts: new Date().toISOString(), event: ev, session_id: clean(p.session_id, 60), agent_id: aid,
    agent_type: p.agent_type === '' ? '(internal)' : clean(p.agent_type, 60), cwd: p.cwd ? clean(path.basename(p.cwd), 60) : null };
  const stamp = aid ? path.join(STATE, aid.replace(/[^\w-]/g, '') + '.start') : null;
  if (ev === 'SubagentStart') {
    if (stamp) { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(stamp, String(Date.now())); }
  } else {
    if (stamp) {
      try { rec.duration_ms = Date.now() - Number(fs.readFileSync(stamp, 'utf8')); fs.unlinkSync(stamp); } catch { rec.duration_ms = null; }
    }
    const tp = typeof p.agent_transcript_path === 'string' ? p.agent_transcript_path.replace(/^~(?=\/)/, os.homedir()) : null;
    if (tp && fs.existsSync(tp)) {
      try {
        const head = readSlice(tp, false, 262144);
        rec.model = clean((head.match(/"model":"(claude-[^"]{1,40})"/) || [])[1], 40);
        const last = readSlice(tp, true, 65536).trimEnd().split('\n').pop() || '';
        rec.ok = !/"isApiErrorMessage":true/.test(last);
      } catch { rec.ok = null; }
    } else rec.ok = null;
  }
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
}

main().catch(() => {}).finally(() => process.exit(0));
