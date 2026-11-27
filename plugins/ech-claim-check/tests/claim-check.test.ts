import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

type TestOn = Parameters<TestBody>[1]

const CWD = '/work/demo-app'
const USAGE = { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The engine beneath the plugin: the transcript, Haiku's answer, the ledger
// append, the rules file and the bottom of the Stop chain. Returns what the
// test reads back. `files` maps a path to its text; any other read is missing.
function engine(on: TestOn, transcript: SessionMessage[], verdict: string | null, files: Record<string, string> = {}) {
  const seen = { prompts: [] as string[], ledger: [] as string[], reads: [] as string[], stops: 0 }
  on('session.messages', () => ({ value: transcript }))
  on('model.complete', (_, e) => {
    seen.prompts.push(typeof e.prompt === 'string' ? e.prompt : JSON.stringify(e.prompt))
    return { value: verdict === null ? { isAnswered: false, reason: 'aborted', usage: USAGE } : { isAnswered: true, text: verdict, usage: USAGE } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('fs.read', (_, e) => {
    seen.reads.push(e.path)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('process.run', (_, e) => {
    seen.ledger.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.Stop', () => { seen.stops++; return {} })
  return seen
}

const prompt: SessionMessage = { role: 'user', text: 'Run the unit tests and tell me.', toolUses: [] }

test('a false "tests pass" with no test run blocks the stop', async ($, on) => {
  const seen = engine(on, [prompt, { role: 'assistant', text: 'All 1 600 unit tests pass.', toolUses: [] }],
    '{"flag":true,"claim":"All 1 600 unit tests pass.","artifact":"the npm run test:unit output"}')

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'All 1 600 unit tests pass.' })

  expect(r.block).toContain('All 1 600 unit tests pass.')
  expect(r.block).toContain('check the npm run test:unit output or restate it as unverified')
  expect(seen.prompts[0]).toContain('(no tool calls)')
  expect(seen.ledger[0]).toContain('"flagged":true')
  expect(seen.ledger[0]).toContain('"input_tokens":900')
})

test('a claim backed by a test output in the same turn stays silent', async ($, on) => {
  const run: SessionMessage = {
    role: 'assistant', text: '', toolUses: [{
      tool_use_id: 't1', tool: 'Bash', input: { command: 'npm run test:unit' },
      text: 'Test Files 88 passed (88)\n Tests 1600 passed (1600)',
    }],
  }
  const seen = engine(on, [prompt, run, { role: 'assistant', text: 'All 1600 unit tests pass.', toolUses: [] }], '{"flag":false}')

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'All 1600 unit tests pass.' })

  expect(r.block).toBeUndefined()
  expect(seen.stops).toBe(1)
  expect(seen.prompts[0]).toContain('[this] Bash(npm run test:unit) -> Test Files 88 passed')
  expect(seen.ledger[0]).toContain('"flagged":false')
})

test('plain reasoning costs no model call and stays silent', async ($, on) => {
  const text = 'I think the select resets because the server answers after our change event. Next I will read the network log to see the order.'
  const seen = engine(on, [prompt, { role: 'assistant', text, toolUses: [] }], '{"flag":true,"claim":"x","artifact":"y"}')

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: text })

  expect(r.block).toBeUndefined()
  expect(seen.prompts.length).toBe(0)
  expect(seen.ledger[0]).toContain('"skipped":"no-claim-words"')
})

test('the second stop of a turn is never blocked', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":true,"claim":"x","artifact":"y"}')

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: true, last_assistant_message: 'All tests pass.' })

  expect(r.block).toBeUndefined()
  expect(seen.prompts.length).toBe(0)
})

test('a model error fails open', async ($, on) => {
  const seen = engine(on, [prompt], null)

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'All 1600 unit tests pass.' })

  expect(r.block).toBeUndefined()
  expect(seen.ledger[0]).toContain('"skipped":"model-aborted"')
})

test('it runs in any project by default', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":true,"claim":"All 1600 unit tests pass.","artifact":"the test output"}')

  const r = await $.classic.Stop({ cwd: '/tmp/other', stop_hook_active: false, last_assistant_message: 'All 1600 unit tests pass.' })

  expect(r.block).toContain('All 1600 unit tests pass.')
  expect(seen.prompts.length).toBe(1)
})

test('a subagent claim is checked on its own transcript', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":true,"claim":"5/5 rows saved","artifact":"a read-back of the 5 rows"}')
  on('classic.SubagentStop', () => ({}))

  const r = await $.classic.SubagentStop({
    cwd: CWD, stop_hook_active: false, agent_id: 'a1', agent_type: 'implementer',
    agent_transcript_path: '/x.jsonl', last_assistant_message: '5/5 rows saved.',
  })

  expect(r.block).toContain('5/5 rows saved')
  expect(seen.ledger[0]).toContain('"agentType":"implementer"')
})

test('an observer report is not checked', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":true,"claim":"x","artifact":"y"}')
  on('classic.SubagentStop', () => ({}))

  for (const agent_type of ['ech-claim-check:claim-sentinel', 'ech:claim-sentinel', 'claim-sentinel']) {
    const r = await $.classic.SubagentStop({
      cwd: CWD, stop_hook_active: false, agent_id: 'o1', agent_type,
      agent_transcript_path: '/x.jsonl', last_assistant_message: 'I verified the digest and filed no report.',
    })
    expect(r.block).toBeUndefined()
  }
  expect(seen.prompts.length).toBe(0)
})

test('a long result keeps its summary line', async ($, on) => {
  const out = `${'(pass) some test name [12ms]\n'.repeat(40)} 8 pass\n 0 fail\nRan 8 tests across 1 file.`
  const run: SessionMessage = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'claude plugin test .' }, text: out }] }
  const seen = engine(on, [prompt, run], '{"flag":false}')

  await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: '8 tests passed and 0 failed.' })

  expect(seen.prompts[0]).toContain('Ran 8 tests across 1 file.')
})

// The optional project rules file.

test('the project rules file is appended to the prompt when present', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":false}', {
    [`${CWD}/.claude/claim-check-rules.md`]: 'A staging deploy is only checked by reading the /health page.',
  })

  await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'Deployed to staging, it works.' })

  expect(seen.reads).toEqual([`${CWD}/.claude/claim-check-rules.md`])
  expect(seen.prompts[0]).toContain('PROJECT RULES')
  expect(seen.prompts[0]).toContain('reading the /health page')
  const p = seen.prompts[0] ?? ''
  expect(p.indexOf('PROJECT RULES')).toBeLessThan(p.indexOf('TOOL CALLS:'))
  expect(seen.ledger[0]).toContain(`"rules":"${CWD}/.claude/claim-check-rules.md"`)
})

test('without a rules file the generic rules stand alone', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":false}')

  const r = await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'All 1600 unit tests pass.' })

  expect(r.block).toBeUndefined()
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).not.toContain('PROJECT RULES')
  expect(seen.ledger[0]).toContain('"rules":null')
})

test('the rulesFile option names another file, ~/ under HOME', { options: { rulesFile: '~/rules/claims.md' } }, async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":false}', { '/home/test/rules/claims.md': 'Counts come from the database, never the loop.' })

  await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: '42 rows written.' })

  expect(seen.reads).toEqual(['/home/test/rules/claims.md'])
  expect(seen.prompts[0]).toContain('Counts come from the database, never the loop.')
})

test('an empty rulesFile option reads no file', { options: { rulesFile: '' } }, async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":false}')

  await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: '42 rows written.' })

  expect(seen.reads.length).toBe(0)
  expect(seen.prompts[0]).not.toContain('PROJECT RULES')
})

test('the generic default prompt carries no owner-specific words', async ($, on) => {
  const seen = engine(on, [prompt], '{"flag":false}')

  await $.classic.Stop({ cwd: CWD, stop_hook_active: false, last_assistant_message: 'All 1600 unit tests pass.' })

  expect(seen.prompts.length).toBe(1)
  const p = (seen.prompts[0] ?? '').toLowerCase()
  for (const word of ['/volumes', '/users/', 'harness']) {
    expect(p).not.toContain(word)
  }
})
