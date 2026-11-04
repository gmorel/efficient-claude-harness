#!/usr/bin/env node
// Synthetic ledgers for the README demo recording.
//
// PROVENANCE: none of this is real telemetry. The dashboard UI is the real one; the events
// under it are generated here so the replay is dense enough to read in a short video. Project
// names are invented on purpose — the real ledgers carry client names that must not ship in a
// public README.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

const DAYS = 7;
const NOW = Date.now();
const START = NOW - DAYS * 86400e3;
const iso = (ms) => new Date(ms).toISOString();

// A deterministic generator, so a re-render produces the same video.
let s = 20261031;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);

const PROJECTS = ['checkout-api', 'billing-worker', 'web-app', 'search-index', 'auth-service', 'reporting'];
const LANES = [
  { type: 'ech:ai-coder',        model: 'composer-2.5', share: 30, dur: [40e3, 260e3] },
  { type: 'ech:ai-coder-high',   model: 'opus',         share: 10, dur: [90e3, 420e3] },
  { type: 'ech:code-explorer',   model: 'haiku',        share: 18, dur: [8e3, 40e3] },
  { type: 'ech:task-reviewer',   model: 'opus',         share: 12, dur: [30e3, 150e3] },
  { type: 'ech:browser-qa',      model: 'sonnet',       share: 8,  dur: [45e3, 200e3] },
  { type: 'ech:pre-post-mortem', model: 'opus',         share: 4,  dur: [120e3, 500e3] },
  { type: 'ech:composer-merger', model: 'sonnet',       share: 6,  dur: [20e3, 90e3] },
  { type: 'ech:claim-sentinel',  model: 'haiku',        share: 12, dur: [5e3, 30e3] },
];
const WEIGHTED = LANES.flatMap((l) => Array(l.share).fill(l));

const agents = [], routing = [], delegate = [], errand = [], runs = [];

// Work arrives in bursts, the way a real day does: a person starts something and several lanes
// light up within seconds of each other. Bursts are what makes "at scale" legible in a replay.
let t = START;
while (t < NOW - 60e3) {
  const hour = new Date(t).getUTCHours();
  const awake = hour >= 7 && hour <= 21;
  if (!awake) { t += between(20 * 60e3, 70 * 60e3); continue; }

  const burst = Math.round(between(2, 7));
  const proj = pick(PROJECTS);
  const t0 = t;

  for (let k = 0; k < burst; k++) {
    const lane = pick(WEIGHTED);
    const startAt = t0 + k * between(300, 2600);
    const dur = Math.round(between(lane.dur[0], lane.dur[1]));
    const r = rnd();
    const ok = r > 0.08;                       // a few failures keep the colours honest
    agents.push({ ts: iso(startAt), event: 'SubagentStart', agent_type: lane.type, model: lane.model, cwd: `/work/${proj}` });
    agents.push({ ts: iso(startAt + dur), event: 'SubagentStop', agent_type: lane.type, model: lane.model, ok, duration_ms: dur });
    routing.push({ ts: iso(startAt - 400), kind: 'delegate', subagent_type: lane.type, cwd_name: proj });

    if (lane.type === 'ech:ai-coder-high' || rnd() > 0.74) {
      const o = rnd() > 0.12 ? 'worked' : rnd() > 0.5 ? 'remote_failed' : 'bad_files';
      delegate.push({
        ts: iso(startAt + 500), outcome: o, profile: pick(['implement', 'review', 'tests', 'analyse']),
        model: lane.type === 'ech:ai-coder-high' ? 'opus' : 'sonnet',
        effort: lane.type === 'ech:ai-coder-high' ? 'high' : 'medium',
        duration_ms: dur,
      });
    }
    if (lane.model === 'composer-2.5') {
      // Two rows, exactly as the real lane writes them: the run itself, then the merge check.
      // fromRuns() reads `ok` / `exit_code` on a code row and `verdict` on a merge row — an
      // `outcome` field is ignored, which silently turned every seeded run into a failure.
      const good = rnd() > 0.1;
      runs.push({ ts: iso(startAt + 800), phase: 'code', task: `${proj}-${k}`, model: 'composer-2.5', engine: 'cursor-agent', ok: good, exit_code: good ? 0 : 1, duration_ms: dur });
      runs.push({ ts: iso(startAt + dur), phase: 'merge', task: `${proj}-${k}`, verdict: good ? 'MERGED' : 'REJECT' });
    }
  }

  // the hooks that sit in front of every edit and every errand
  for (let k = 0; k < Math.round(between(3, 11)); k++) {
    const v = rnd() > 0.78 ? 'warn' : 'pass';
    routing.push({
      ts: iso(t0 + between(-4000, 9000)), kind: 'gate', verdict: v, why: v === 'warn' ? 'composer-lane size' : 'small edit',
      tool: pick(['Edit', 'Write']), ext: pick(['ts', 'tsx', 'mjs', 'php', 'css']),
      lines: Math.round(between(4, 320)), target: v === 'warn' ? 'ech:ai-coder' : null, cwd_name: proj,
    });
  }
  // the conversation itself: the small edits it still makes between delegations
  for (let k = 0; k < Math.round(between(5, 18)); k++) {
    routing.push({ ts: iso(t0 + between(-8000, 20000)), kind: 'direct_edit', tool: pick(['Edit', 'Write']), ext: pick(['ts', 'tsx', 'md', 'mjs', 'json']), cwd_name: proj });
  }
  for (let k = 0; k < Math.round(between(4, 16)); k++) {
    errand.push({ ts: iso(t0 + between(-6000, 12000)), verdict: rnd() > 0.85 ? 'warn' : 'pass', tool: pick(['Bash', 'Read']), cwd_name: proj });
  }

  t = t0 + between(4 * 60e3, 26 * 60e3);
}

// The last frame of the video is its thumbnail, and a box reads "not working" when its most
// recent outcome was a failure. Failures stay in the body of the replay — they are what makes the
// colours mean anything — but the final two hours are clean, so the video does not end on a red box.
const CLEAN_FROM = NOW - 2 * 3600e3;
for (const r of agents) if (Date.parse(r.ts) >= CLEAN_FROM && r.event === 'SubagentStop') r.ok = true;
for (const r of runs) if (Date.parse(r.ts) >= CLEAN_FROM) { if (r.phase === 'merge') r.verdict = 'MERGED'; else { r.ok = true; r.exit_code = 0; } }
for (const r of delegate) if (Date.parse(r.ts) >= CLEAN_FROM) r.outcome = 'worked';
for (const r of routing) if (Date.parse(r.ts) >= CLEAN_FROM && r.verdict) r.verdict = 'pass';
for (const r of errand) if (Date.parse(r.ts) >= CLEAN_FROM) r.verdict = 'pass';

const w = (name, rows) => {
  writeFileSync(join(OUT, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return `${name}: ${rows.length}`;
};
console.log([
  w('agents.jsonl', agents), w('routing.jsonl', routing),
  w('delegate.jsonl', delegate), w('errand-router.jsonl', errand), w('runs.jsonl', runs),
].join('  ·  '));
