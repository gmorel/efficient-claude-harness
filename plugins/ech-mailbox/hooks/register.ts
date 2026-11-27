import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, SessionReceiveInput } from 'claude-code'

import type { MailboxMessage } from '../types'

// Messages other sessions send are held in a mailbox instead of waking this
// session. A message whose text starts with BLOCKING: passes at once. Held
// messages join the person's next prompt as context, or go out as one
// digest every hour, and `/mailbox` lists, flushes or clears them.

const COMMAND = 'mailbox'
const HOUR = 3_600_000
const BLOCKING = /^\s*(?:<[^>]*>\s*)*BLOCKING:/
const PEER_KINDS = new Set(['peer', 'peer-send-message'])
const PERSON_KINDS = new Set(['composer', 'bridge', 'sdk'])

const box = atom({ plugin: 'ech-mailbox', key: 'box' } as const, [] as MailboxMessage[])

/** whether this copy of the module has registered the command and started the timer */
let isReady = false

const storeKey = async ($: EngineInterface) => `box:${await $.session.id()}`

/** Writes the box through, mirrors it to the store and refreshes the status line. */
const save = async ($: EngineInterface, change: (list: MailboxMessage[]) => MailboxMessage[]) => {
  const list = await update($, box, change)
  const key = await storeKey($)
  await (list.length > 0 ? $.store.set(key, list) : $.store.delete(key))
  $.ui.status(list.length > 0 ? `mailbox: ${list.length} waiting` : undefined)

  return list
}

const isHeld = (e: SessionReceiveInput) =>
  e.agentId === undefined && PEER_KINDS.has(e.origin.kind) && !('teammate' in e.origin) && !BLOCKING.test(e.text)

const digest = (list: readonly MailboxMessage[]) =>
  [
    `ech-mailbox: ${list.length} held message${list.length === 1 ? '' : 's'} from other sessions.`,
    ...list.map((m, i) => `\n${i + 1}. ${m.from}, ${new Date(m.at).toISOString()}\n${m.text}`),
  ].join('\n')

const listing = (list: readonly MailboxMessage[]) =>
  list.length === 0
    ? 'The mailbox is empty.'
    : [
        `${list.length} waiting:`,
        ...list.map((m, i) => `${i + 1}. ${new Date(m.at).toISOString()} ${m.from}: ${m.text.split('\n')[0]}`),
      ].join('\n')

/** Takes every waiting message out and submits them as one turn; puts them back if the prompt is dropped. */
const flush = async ($: EngineInterface) => {
  const list = await read($, box)
  if (list.length === 0) return
  const ids = new Set(list.map(m => m.id))
  await save($, all => all.filter(m => !ids.has(m.id)))
  void $.prompt.submit({ text: digest(list) }).then(
    async sent => {
      if (sent.drop !== undefined) await save($, all => [...list, ...all])
    },
    async () => save($, all => [...list, ...all]),
  )
}

/** Registers the command and the hourly timer once per copy of the module (a reload drops both). */
const ensure = async ($: EngineInterface) => {
  if (isReady) return
  isReady = true
  $.clock.every(HOUR, () => void flush($))
  await $.command.register({
    name: COMMAND,
    description: 'Show the messages other sessions sent that wait in the mailbox',
    argumentHint: '[flush|clear]',
  })
}

const isPerson = (origin: PromptOrigin) => PERSON_KINDS.has(origin.kind)

export const register: Register = (on, options) => {
  if (options.enabled !== true) return

  on('session.start', async ($, e, next) => {
    await ensure($)
    const kept = await $.store.get(await storeKey($))
    if (Array.isArray(kept) && (await read($, box)).length === 0) {
      await save($, () => kept as MailboxMessage[])
    }

    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (!isHeld(e)) return next(e)
    await ensure($)
    const at = await $.clock.now()
    const held: MailboxMessage = { id: `${at}-${crypto.randomUUID()}`, from: e.origin.kind, at, text: e.text }
    await save($, list => [...list, held])

    return { consumed: 'mailbox' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || !isPerson(e.origin)) return next(e)
    const list = await read($, box)
    if (list.length === 0) return next(e)
    const entered = await next({ ...e, context: [...(e.context ?? []), digest(list)] })
    if (entered.drop === undefined) {
      const ids = new Set(list.map(m => m.id))
      await save($, all => all.filter(m => !ids.has(m.id)))
    }

    return entered
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      const list = await read($, box)
      await save($, () => [])

      return { text: `Cleared ${list.length} message${list.length === 1 ? '' : 's'}.` }
    }
    if (arg === 'flush') {
      // A prompt submitted from inside the command would wait on the turn the command holds.
      const list = await read($, box)
      $.clock.after(1, () => void flush($))

      return { text: list.length === 0 ? 'The mailbox is empty.' : `Sending ${list.length} message${list.length === 1 ? '' : 's'} as one turn.` }
    }

    return { text: listing(await read($, box)) }
  })
}
