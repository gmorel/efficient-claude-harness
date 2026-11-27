import type { Register, EngineInterface, SessionMessage } from 'claude-code'

// ech-claim-check: a turn-end check for unverified claims.
// At Stop (main thread) and SubagentStop (every subagent) it hands Haiku the
// final text plus a compact list of the turn's tool calls, and re-prompts the
// agent once when a claim that leaves the turn was never checked.
// An optional project rules file is appended to the prompt when it exists.
// Fail open: any error, timeout or unreadable answer lets the stop through.

const LEDGER_FILE = 'ech-claim-check.jsonl'
const MAX_CALLS = 30
const MAX_TEXT = 6000
const MAX_RULES = 4000
// Observers report to the main thread, which this check already covers;
// checking an observer's own report would re-prompt it.
const SKIP_AGENTS = /(^|:)claim-sentinel$/

// Cheap gate before any model call: a text with none of these words states no
// outcome worth checking, so it costs nothing.
const CLAIM_WORDS = /\b(pass(es|ed|ing)?|green|saved|persist\w*|fixed|fix(es)? (it|the)|verified|confirmed|proven|proved|works?|working|done|succeed\w*|success\w*|merged|committed|pushed|deployed|shipped|live|written|wrote|created|deleted|all \d+|\d+ ?\/ ?\d+|\d+ (tests?|rows?|records?|items?|files?|fields?|lines?|calls?|checks?))\b|✅|🟢|enregistr|vérifi|corrig|réussi/i

export const RULES = `You check one agent turn for an unchecked claim.
Standing rule: never claim success (saved, persisted, passed, fixed, verified, done, or any count) without checking the real artifact in this session: the persisted record read back, a database row, a test's or build's actual output, a log line, a screenshot, the file's real content. A loop's self-count, a 200 response, a zero exit code or a green pill is not a check.

FLAG a claim only when ALL hold:
1. It is an assertion of fact that LEAVES the turn: in the reply to the user, a message to another session, a live system, a database write, a commit message, or a count.
2. It states a success, a fix, "saved", "verified", "tests pass", a count, a root cause, or what a file/doc/API says.
3. No tool call listed below (this turn or the recent one) shows the result that backs it. Also flag when the cited check is narrower than the claim (one test file for "all tests pass", a unit suite for "works live"), or when a tool result says the opposite.

STAY SILENT when: the claim is backed by a listed tool result; the text labels it unverified, assumed, not checked, or "needs checking"; it is a plan, proposal, question, opinion or reasoning about what might be true; it only reports edits made or files read; it repeats what the user said.

Answer with ONE line of JSON and nothing else:
{"flag":false}
or
{"flag":true,"claim":"<the exact words, max 120 chars>","artifact":"<the specific check that would settle it, max 100 chars>"}`

type Call = { turn: 'this' | 'recent'; tool: string; input: string; result: string; isError: boolean }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
// A result keeps its head and its tail: test runners and builds print the
// summary line last.
const ends = (s: string, head: number, tail: number) =>
  s.length > head + tail ? `${s.slice(0, head)} … ${s.slice(-tail)}` : s

function inputOf(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'prompt', 'sql']) {
    const v = input[k]
    if (typeof v === 'string') return clip(v.replace(/\s+/g, ' '), 140)
  }
  return clip(JSON.stringify(input), 140)
}

// The turn is everything after the last user message that is a real prompt
// (text, no tool results); the recent turn is the one before it.
function isPrompt(m: SessionMessage): boolean {
  return m.role === 'user' && m.text.trim() !== '' && !(m.toolResults && m.toolResults.length > 0)
}

export function collectCalls(messages: readonly SessionMessage[]): Call[] {
  const prompts: number[] = []
  messages.forEach((m, i) => { if (isPrompt(m)) prompts.push(i) })
  const thisStart = prompts.at(-1) ?? 0
  const recentStart = prompts.at(-2) ?? 0
  const calls: Call[] = []
  messages.forEach((m, i) => {
    if (i < recentStart || m.role !== 'assistant') return
    for (const u of m.toolUses) {
      calls.push({
        turn: i > thisStart ? 'this' : 'recent',
        tool: u.tool,
        input: inputOf(u.input),
        result: ends((u.text ?? '(no result)').replace(/\s+/g, ' '), 100, 200),
        isError: u.isError === true,
      })
    }
  })
  return calls.slice(-MAX_CALLS)
}

export function buildPrompt(text: string, calls: readonly Call[], projectRules?: string): string {
  const list = calls.length === 0
    ? '(no tool calls)'
    : calls.map((c, i) => `${i + 1}. [${c.turn}] ${c.tool}(${c.input}) -> ${c.isError ? 'ERROR ' : ''}${c.result}`).join('\n')
  const extra = projectRules && projectRules.trim() !== ''
    ? `\n\nPROJECT RULES (from the project's rules file; they add to the rules above, the JSON answer format stays):\n${clip(projectRules.trim(), MAX_RULES)}`
    : ''
  return `${RULES}${extra}\n\nTOOL CALLS:\n${list}\n\nFINAL TEXT OF THE TURN:\n<<<\n${clip(text, MAX_TEXT)}\n>>>`
}

export function parseVerdict(raw: string): { flag: boolean; claim?: string; artifact?: string } | undefined {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0]) as { flag?: unknown; claim?: unknown; artifact?: unknown }
    if (v.flag === true && typeof v.claim === 'string' && v.claim.trim() !== '') {
      return { flag: true, claim: v.claim.trim(), artifact: typeof v.artifact === 'string' ? v.artifact.trim() : 'the real artifact' }
    }
    if (v.flag === false) return { flag: false }
  } catch { /* unreadable: fail open */ }
  return undefined
}

// Absolute as given, ~/ under HOME, anything else under the session's cwd.
export function resolveRulesPath(file: string, cwd: string, home: string | undefined): string | undefined {
  const f = file.trim()
  if (f === '') return undefined
  if (f.startsWith('/')) return f
  if (f.startsWith('~/')) return home ? `${home}/${f.slice(2)}` : undefined
  return `${cwd.replace(/\/+$/, '')}/${f}`
}

async function readRules($: EngineInterface, file: string, cwd: string): Promise<{ path?: string; text?: string }> {
  try {
    const path = resolveRulesPath(file, cwd, await $.env.get('HOME'))
    if (!path) return {}
    const text = await $.fs.read(path)
    return typeof text === 'string' && text.trim() !== '' ? { path, text } : {}
  } catch { return {} } // no rules file: the generic rules alone
}

async function log($: EngineInterface, row: Record<string, unknown>): Promise<void> {
  try {
    const dir = (await $.env.get('HARNESS_DATA_DIR')) ?? (await $.env.get('HOME').then((h) => (h ? `${h}/.claude/ledgers` : undefined)))
    if (!dir) return
    const path = `${dir}/${LEDGER_FILE}`
    await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], {
      stdin: `${JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...row })}\n`,
      timeoutMs: 5000,
    })
  } catch { /* a ledger failure never blocks a stop */ }
}

type StopLike = {
  session_id: string
  cwd: string
  stop_hook_active: boolean
  last_assistant_message?: string
  agent_type?: string
  agent_id?: string
}

async function check($: EngineInterface, e: StopLike, event: 'Stop' | 'SubagentStop', rulesFile: string): Promise<string | undefined> {
  const base = { session: e.session_id, event, agentType: e.agent_type ?? 'main', agentId: e.agent_id }
  if (e.agent_type && SKIP_AGENTS.test(e.agent_type)) return undefined
  if (e.stop_hook_active) {
    await log($, { ...base, flagged: false, skipped: 'stop_hook_active' })
    return undefined
  }
  const text = (e.last_assistant_message ?? '').trim()
  if (text.length < 8 || !CLAIM_WORDS.test(text)) {
    await log($, { ...base, flagged: false, skipped: 'no-claim-words', tokens: null })
    return undefined
  }
  const got = e.agent_id ? await $.session.messages({ agentId: e.agent_id }) : await $.session.messages()
  const calls = 'deny' in got ? [] : collectCalls(got)
  const rules = await readRules($, rulesFile, e.cwd)
  const started = await $.clock.now()
  const r = await $.model.complete({ model: 'haiku', prompt: buildPrompt(text, calls, rules.text), effort: 'low', maxTokens: 200, timeoutMs: 20000 })
  const tokens = r.usage
  const ms = (await $.clock.now()) - started
  const ctx = { tokens, ms, calls: calls.length, rules: rules.path ?? null }
  if (!r.isAnswered) {
    await log($, { ...base, flagged: false, skipped: `model-${r.reason}`, ...ctx })
    return undefined
  }
  const v = parseVerdict(r.text)
  if (!v) {
    await log($, { ...base, flagged: false, skipped: 'unreadable-verdict', raw: clip(r.text, 200), ...ctx })
    return undefined
  }
  await log($, { ...base, flagged: v.flag, claim: v.claim, artifact: v.artifact, ...ctx })
  if (!v.flag) return undefined
  return `claim-check: unverified claim — « ${v.claim} » — check ${v.artifact} or restate it as unverified. (Turn-end check by Haiku, not a verdict; it blocks once per turn.)`
}

export const register: Register = (on, options) => {
  const rulesFile = typeof options.rulesFile === 'string' ? options.rulesFile : ''
  on('classic.Stop', async ($, e, next) => {
    try {
      const reason = await check($, e, 'Stop', rulesFile)
      if (reason) return { block: reason }
    } catch { /* fail open */ }
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStop', async ($, e, next) => {
    try {
      const reason = await check($, e, 'SubagentStop', rulesFile)
      if (reason) return { block: reason }
    } catch { /* fail open */ }
    return next(e)
  }).catch(($, e, next) => next(e))
}
