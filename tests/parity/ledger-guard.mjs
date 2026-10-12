// Pure helpers for the real-ledger check in run.mjs.
//
// The test's hooks write to temp ledgers (ROUTING_LEDGER, ERRAND_ROUTER_LEDGER), so a line of the test's own can reach a
// real ledger only if a redirect fails. Such a line carries one of the test's synthetic session ids, or a path under its
// temp directory. Any other line added during the run came from another process (for example a live Claude session),
// and is reported as information, never as a failure.

// What a run added to a ledger file: 'same', 'added' (with the complete new lines) or 'rewritten' (not an append).
export function ledgerDelta(before, after) {
  if (after === before) return { kind: 'same', added: [] };
  if (!after.startsWith(before)) return { kind: 'rewritten', added: [] };
  return { kind: 'added', added: after.slice(before.length).split('\n').filter(Boolean) };
}

// Split added lines into `own` (the test could have written them) and `foreign` (anything else, including lines that do not parse).
export function splitOwnLines(lines, { syntheticSids, cwdPrefix }) {
  const own = [];
  const foreign = [];
  for (const raw of lines) {
    let rec;
    try { rec = JSON.parse(raw); } catch { foreign.push({ sid: '<unparsable>', raw }); continue; }
    const sid = rec?.session_id ?? null;
    const underTemp = !!cwdPrefix && JSON.stringify(rec).includes(cwdPrefix);
    (syntheticSids.includes(sid) || underTemp ? own : foreign).push({ sid, raw });
  }
  return { own, foreign };
}
