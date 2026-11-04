#!/usr/bin/env node
// Tiny local server for the harness dashboard: built-ins only, bound to 127.0.0.1.
// GET /         the built page (re-read on every request, so a rebuild shows on reload)
// GET /health   {harnessDashboard:true}; the page shows its LIVE toggle only when this answers
// GET /events   Server-Sent Events: every new ledger line, agents.jsonl line, claim-sentinel report and Astra log, normalized by lib.mjs
// Tailing starts at the current end of each file: only lines appended after the server starts are pushed.
// Ledger paths come from the same env names as the hooks (ROUTING_LEDGER, ERRAND_ROUTER_LEDGER, COMPOSER_LANE_LOG, DELEGATE_LEDGER, AGENT_RUNS_LEDGER, HARNESS_DATA_DIR, CLAIM_SENTINEL_DIR), then settings.json.
//   HARNESS_DASHBOARD_PORT=4783 node serve.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCES, PATHS, VIZ_OUT, readLinesSync, parse, fromSentinelFile, fromAstraLog } from './lib.mjs';

const PORT = +(process.env.HARNESS_DASHBOARD_PORT || 4783);
const POLL_MS = +(process.env.HARNESS_DASHBOARD_POLL_MS || 1000);
const clients = new Set();
let pushed = 0;

function broadcast(ev) {
  const msg = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of clients) res.write(msg);
  pushed++;
}

// ── tail the ledgers ──
const offsets = {};
for (const s of SOURCES) { const f = s.file(); offsets[f] = fs.existsSync(f) ? fs.statSync(f).size : 0; }
function pollFiles() {
  for (const s of SOURCES) {
    const f = s.file();
    let size; try { size = fs.statSync(f).size; } catch { continue; }
    if (size < offsets[f]) offsets[f] = 0;            // truncated or rotated: read it again from the top
    if (size === offsets[f]) continue;
    const { lines, offset } = readLinesSync(f, offsets[f]);
    offsets[f] = offset;
    for (const l of lines) { const r = parse(l); if (r) for (const ev of s.fn(r)) broadcast({ ...ev, n: 1, src: s.key }); }
  }
}
// ── watch the report directories ──
const seen = { sentinel: new Set(), astra: new Set() };
const listDir = d => { try { return fs.readdirSync(d); } catch { return []; } };
for (const f of listDir(PATHS.sentinelDir)) seen.sentinel.add(f);
for (const f of listDir(PATHS.astraDir)) seen.astra.add(f);
function pollDirs() {
  for (const f of listDir(PATHS.sentinelDir)) {
    if (seen.sentinel.has(f) || !f.endsWith('.md')) continue;
    seen.sentinel.add(f);
    try { for (const ev of fromSentinelFile(f, fs.statSync(path.join(PATHS.sentinelDir, f)).mtimeMs)) broadcast({ ...ev, n: 1, src: 'claim-sentinel' }); } catch {}
  }
  for (const f of listDir(PATHS.astraDir)) {
    if (seen.astra.has(f) || !/^astra-.*\.log$/.test(f)) continue;
    seen.astra.add(f);
    for (const ev of fromAstraLog(path.join(PATHS.astraDir, f))) broadcast({ ...ev, n: 1, src: 'astra-logs' });
  }
}
setInterval(pollFiles, POLL_MS).unref();
setInterval(pollDirs, POLL_MS * 2).unref();
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 15000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/harness-dashboard.html') {
    fs.readFile(VIZ_OUT, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not built yet: run node build.mjs'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(buf);
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ harnessDashboard: true, clients: clients.size, pushed, sources: SOURCES.map(s => s.key).concat(['claim-sentinel', 'astra-logs']) }));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => console.error(`harness dashboard on http://127.0.0.1:${PORT}/ (tailing ${SOURCES.length} ledgers + 2 report dirs)`));
