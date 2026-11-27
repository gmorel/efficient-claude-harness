// Jev (typesafe.ai) client for the errand-router opt-in classification (ERRAND_ROUTER_JEV=1).
//
// jevChoose({state, task, how, note, criteria, timeoutMs}) asks Jev ONE typed choice question.
// It returns {choice, confidence, probabilities, ms, usage}, or null on ANY failure (no key, timeout, HTTP error, bad body).
// It never throws and never logs; callers decide what to do with null.
//
// Key: process.env.TYPESAFE_AI_JEV_API_KEY (trimmed). Only when that is empty AND JEV_ENV_FILE names a file, the
// TYPESAFE_AI_JEV_API_KEY= line of that file is used (opt-in: there is no default file).
// The key is never printed, logged, returned or written anywhere.
// Endpoint: process.env.JEV_URL, else https://api.typesafe.ai/v1/systemone.
// JEV_URL is read once, when this module is first imported; errand-router imports it lazily in each hook run, so every run sees its own environment.
// A `none` criterion is added when the caller did not list one: Jev can only pick a listed key.
// One retry on 429/503/529 if the timeout budget still allows it.
// Every string in `state` goes through redactSecrets() first (URL passwords, bearer tokens, NAME=secret, known key shapes, long random runs).

import { readFileSync } from 'node:fs';

export const JEV_URL = process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const RETRY_STATUS = new Set([429, 503, 529]);

export function loadKey() {
  const v = (process.env.TYPESAFE_AI_JEV_API_KEY || '').trim();
  if (v) return v;
  const file = process.env.JEV_ENV_FILE;
  if (!file) return null;
  try {
    const env = readFileSync(file, 'utf8');
    const m = env.match(/^\s*(?:export\s+)?TYPESAFE_AI_JEV_API_KEY\s*=\s*(.*)$/m);
    const k = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    return k || null;
  } catch { return null; }
}

// ---------------------------------------------------------------- secret redaction (every string in `state`)
// Jev only needs the SHAPE of a call to route it, so anything that looks like a credential is replaced by *** before it leaves the machine.
// Over-redaction is accepted; a leak is not.
// Long-run guard: a run of 32+ chars of [A-Za-z0-9+=_-] (no "/", so paths split into segments) is redacted when it is hex of any length other than exactly 40 or 64 (git SHA-1 / SHA-256 stay readable).
// When >= 10 % of the run is - or _ (slugs, UUIDs), it is redacted only when >= 20 % digits (UUIDs go, kebab path segments stay).
// Otherwise it is redacted when it mixes upper and lower case or is >= 20 % digits (random keys); long lower-case identifiers stay, 32+ camelCase ones are redacted.
// `-p<pass>` is redacted only after mysql/mariadb/mysqldump/mysqladmin (and `sshpass -p <pass>`), because find's -print/-path/-perm and perl -pe share the shape.
const SECRET_NAME = '[A-Za-z_][A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Za-z0-9_]*';
const RULES = [
  // scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:'"]+:[^\s\/@'"]*@/gi, '$1***@'],
  // Authorization: <scheme> <token>   (header, curl -H, JSON)
  [/(\bAuthorization["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token|Digest)\s+)?[^\s"',;]+/gi, (m, pre, sch) => pre + (sch ? sch + ' ' : '') + '***'],
  // Bearer <token> anywhere else
  [/\b(Bearer)\s+(?!\*\*\*)[A-Za-z0-9._~+\/=-]+/gi, '$1 ***'],
  // NAME=value where NAME names a secret; a $VAR / ${VAR} reference is not a secret
  [new RegExp('\\b(' + SECRET_NAME + ')(\\s*=\\s*)(["\']?)(?!\\$)(?!\\*\\*\\*)[^\\s"\'&;|]+', 'gi'), '$1$2$3***'],
  // --password=value / --password value / --passwd=value
  [/(--(?:password|passwd)(?:=|\s+))(["']?)(?!\$)[^\s"']+/gi, '$1$2***'],
  // mysql-family -p<pass> (attached), sshpass -p <pass>
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]*?\s-p)(?!\s)(["']?)[^\s"']+/g, '$1$2***'],
  [/(\bsshpass\s+-p\s*)(["']?)[^\s"']+/g, '$1$2***'],
  // provider key shapes
  [/\b(sk|pk|rk)([-_])[A-Za-z0-9_-]{16,}/g, '$1$2***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***'],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/g, 'xox-***'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '***jwt***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  // long-run guard for unknown keys
  [/[A-Za-z0-9+=_-]{32,}/g, m => {
    if (/^[0-9a-fA-F]+$/.test(m)) return m.length === 40 || m.length === 64 ? m : '***';
    const up = /[A-Z]/.test(m), lo = /[a-z]/.test(m), dg = (m.match(/[0-9]/g) || []).length / m.length;
    const sep = (m.match(/[-_]/g) || []).length / m.length; // base64url has ~3 % of - and _; slugs have far more
    if (sep >= 0.1) return (up || lo) && dg >= 0.2 ? '***' : m; // slug / UUID: redact only when digit-heavy
    if (up && lo) return '***';
    if ((up || lo) && dg >= 0.2) return '***';
    return m;
  }],
];

export function redactSecrets(str) {
  if (typeof str !== 'string' || !str) return str;
  let t = str;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  return t;
}

export function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redactSecrets(v);
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x, depth + 1);
  return o;
}

export function buildQuestions({ task, how, note, criteria, name = 'choice' }) {
  const instructions = { task };
  if (how) instructions.how = how;
  if (note) instructions.note = note;
  const crit = { ...criteria };
  if (!('none' in crit)) crit.none = { when: 'none of the listed options fits' };
  return { [name]: { type: 'choice', instructions, criteria: crit } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function jevChoose({ state, task, how, note, criteria, name = 'choice', timeoutMs = 1500, fetchImpl, key } = {}) {
  const t0 = Date.now();
  try {
    const k = key || loadKey();
    if (!k || !task || !criteria || typeof criteria !== 'object') return null;
    const f = fetchImpl || globalThis.fetch;
    const body = JSON.stringify({ model: 'jev-latest', state: redactDeep(state ?? {}), questions: buildQuestions({ task, how, note, criteria, name }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = timeoutMs - (Date.now() - t0);
      if (left <= 0) return null;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), left);
      let status, txt;
      try {
        const r = await f(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body, signal: ac.signal });
        status = r.status;
        txt = await r.text();
      } catch { return null; } finally { clearTimeout(timer); }
      if (RETRY_STATUS.has(status)) {
        if (attempt === 0) {
          const wait = Math.min(250, timeoutMs - (Date.now() - t0) - 50);
          if (wait < 0) return null;
          await sleep(wait);
          continue;
        }
        return null;
      }
      if (status < 200 || status >= 300) return null;
      let j;
      try { j = JSON.parse(txt); } catch { return null; }
      const a = j?.answers?.[name];
      if (!a || typeof a.choice !== 'string') return null;
      return {
        choice: a.choice,
        confidence: typeof a.confidence === 'number' ? a.confidence : null,
        probabilities: a.probabilities ?? null,
        ms: Date.now() - t0,
        usage: j.usage ?? null,
      };
    }
    return null;
  } catch { return null; }
}

// `node jev-client.mjs probe`: one live call, prints the answer (never the key).
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === 'probe') {
  const r = await jevChoose({
    state: { tool: 'Bash', command: 'grep -rn foo src' },
    task: 'Which lane should run this developer tool call?',
    criteria: {
      explore: { option: 'Explore: search or read several repo files' },
      main: { option: 'keep in the main thread' },
    },
    timeoutMs: 5000,
  });
  console.log(JSON.stringify(r));
}
