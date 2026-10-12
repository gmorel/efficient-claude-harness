// Jev coder lane helpers for route-gate (pure logic + question shape).
// Imported by route-gate.mjs and plugin tests; no hook I/O here.

const DEFAULT_MIN_CONF = 0.8;

export function parseRouteGateJevMinConf() {
  const raw = process.env.ROUTE_GATE_JEV_MIN_CONF;
  if (raw === undefined || raw === '') return DEFAULT_MIN_CONF;
  const n = Number(raw);
  if (Number.isNaN(n)) return DEFAULT_MIN_CONF;
  return Math.min(1, Math.max(0, n));
}

export const MIN_CONF = parseRouteGateJevMinConf();

const CODER_TASK = 'A developer assistant is about to apply a code edit in its main session. Pick whether the edit should stay in the main session or go to a coder lane.';
const CODER_HOW = 'main means the edit is small or local enough to do in the main session. ai-coder is the default coder lane for ordinary code paths. ai-coder-high is for guarded paths (auth, payments, migrations, CI, secrets) and must not be downgraded.';
const CODER_CRITERIA = {
  'ai-coder': { option: 'Delegate to the standard coder lane (Composer in place, commits nothing).' },
  'ai-coder-high': { option: 'Delegate to the guarded coder lane (written plan first).' },
  main: { option: 'Keep the edit in the main session; the fixed size gate over-reacted.' },
};

const SEND_TEXT = process.env.ROUTE_GATE_JEV_SEND_TEXT === '1';

export function buildCoderQuestion({ tool, ext, relPath, lines, cumLines, filesInPrompt, guarded, newText }, redactDeep) {
  const base = {
    tool,
    ext,
    path: relPath,
    lines,
    cum_lines: cumLines,
    files_in_prompt: filesInPrompt,
    guarded,
  };
  if (SEND_TEXT) base.new_text = redactDeep(String(newText || '')).slice(0, 400);
  const state = redactDeep(base);
  return { state, name: 'lane', task: CODER_TASK, how: CODER_HOW, criteria: { ...CODER_CRITERIA } };
}

// Pure: apply a Jev coder answer to the fixed-rules warn/deny outcome.
export function decideCoderJev({ verdict, mode, guarded, jev, minConf = MIN_CONF }) {
  const target = guarded ? 'ai-coder-high' : 'ai-coder';
  if (!jev) return { action: 'jev-null', verdict, target };
  if ((jev.confidence ?? 0) < minConf) return { action: 'low-confidence', verdict, target };
  if (guarded) return { action: 'keep-guarded', verdict, target: 'ai-coder-high' };
  if (jev.choice === 'none') return { action: 'keep-none', verdict, target };
  if (jev.choice === 'ai-coder-high') return { action: 'upgrade-high', verdict, target: 'ai-coder-high' };
  if (jev.choice === 'main') {
    if (mode === 'deny' || verdict === 'deny') return { action: 'keep-deny', verdict, target };
    return { action: 'jev-main-silent', verdict: 'pass', target, suppressOutput: true };
  }
  return { action: 'agree', verdict, target };
}
