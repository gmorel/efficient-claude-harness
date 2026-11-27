import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ON = { options: { enabled: true } }
const HOUR = 3_600_000
const PEER = { kind: 'peer-send-message' } as const
const PRESENTATION = { isFullscreen: false, columns: 80 }

/** The engine beneath the plugin: what it queued, what it submitted, the status line. */
const world = (on: On, stored: Record<string, unknown> = {}) => {
  const seen = { queued: [] as string[], prompts: [] as { text: string; context?: readonly string[] }[], status: [] as (string | undefined)[] }
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 27, 10) })
  mock.store(on, stored)
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: { command: 'mailbox' } }))
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.receive', (_, e) => {
    seen.queued.push(e.text)
    return { text: e.text }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })

  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const type = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const mailbox = ($: Engine, args = '') => $.command.run({ command: 'mailbox', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

test('off by default: a peer message passes through and nothing joins a prompt', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  const got = await $.session.receive({ origin: PEER, text: 'review done' })
  expect(got.text).toBe('review done')
  expect(seen.queued).toEqual(['review done'])
  await type($, 'hello')
  expect(seen.prompts).toEqual([{ text: 'hello', context: undefined }])
  await clock.advance(HOUR)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.status).toEqual([])
})

test('a BLOCKING: message passes at once', ON, async ($, on) => {
  const { seen } = world(on)
  await start($)
  const got = await $.session.receive({ origin: PEER, text: 'BLOCKING: the release gate failed' })
  expect(got.text).toBe('BLOCKING: the release gate failed')
  expect(seen.queued).toEqual(['BLOCKING: the release gate failed'])
})

test('another peer message is held and counted in the status line', ON, async ($, on) => {
  const { seen } = world(on)
  await start($)
  const got = await $.session.receive({ origin: PEER, text: 'PR 12 reviewed' })
  expect(got.consumed).toBe('mailbox')
  expect(seen.queued).toEqual([])
  await $.session.receive({ origin: { kind: 'peer' }, text: 'tests green' })
  expect(seen.status.at(-1)).toBe('mailbox: 2 waiting')
  expect((await mailbox($)).text).toMatch(/^2 waiting:\n1\. .* PR 12 reviewed\n2\. .* tests green$/)
})

test('/mailbox lists the waiting messages, and /mailbox clear empties the box', ON, async ($, on) => {
  const { seen } = world(on)
  await start($)
  expect((await mailbox($)).text).toBe('The mailbox is empty.')
  await $.session.receive({ origin: PEER, text: 'PR 12 reviewed\nsecond line' })
  const listed = await mailbox($)
  expect(listed.text).toMatch(/^1 waiting:\n1\. 2026-11-27T10:00:00\.000Z peer-send-message: PR 12 reviewed$/)
  expect((await mailbox($, 'clear')).text).toBe('Cleared 1 message.')
  expect(seen.status.at(-1)).toBeUndefined()
  expect((await mailbox($)).text).toBe('The mailbox is empty.')
})

test('/mailbox flush sends the waiting messages as one turn', ON, async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await $.session.receive({ origin: PEER, text: 'one' })
  await $.session.receive({ origin: PEER, text: 'two' })
  expect((await mailbox($, 'flush')).text).toBe('Sending 2 messages as one turn.')
  await clock.advance(10)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]?.text).toMatch(/2 held messages[\s\S]*one[\s\S]*two/)
  expect(seen.status.at(-1)).toBeUndefined()
})

test('the hourly digest delivers waiting messages once, and skips an empty box', ON, async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await clock.advance(HOUR)
  expect(seen.prompts).toEqual([])
  await $.session.receive({ origin: PEER, text: 'merge ready' })
  await clock.advance(HOUR - 1)
  expect(seen.prompts).toEqual([])
  await clock.advance(1)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]?.text).toMatch(/1 held message from other sessions[\s\S]*merge ready/)
  await clock.advance(HOUR)
  expect(seen.prompts).toHaveLength(1)
})

test('waiting messages join the next prompt as context and are cleared after', ON, async ($, on) => {
  const { seen } = world(on)
  await start($)
  await $.session.receive({ origin: PEER, text: 'deploy finished' })
  const entered = await type($, 'what next?')
  expect(entered.text).toBe('what next?')
  expect(seen.prompts[0]?.text).toBe('what next?')
  expect(seen.prompts[0]?.context?.[0]).toMatch(/deploy finished/)
  expect(seen.status.at(-1)).toBeUndefined()
  await type($, 'and then?')
  expect(seen.prompts[1]?.context).toBeUndefined()
  expect((await mailbox($)).text).toBe('The mailbox is empty.')
})

test('a session that starts again finds the messages it held in the store', ON, async ($, on) => {
  const kept = [{ id: 'k1', from: 'peer-send-message', at: Date.UTC(2026, 10, 27, 9), text: 'still waiting' }]
  const { seen } = world(on, { 'box:s1': kept })
  await start($)
  expect(seen.status.at(-1)).toBe('mailbox: 1 waiting')
  expect((await mailbox($)).text).toMatch(/still waiting/)
})
