/** One held message from another session. */
export type MailboxMessage = { id: string; from: string; at: number; text: string }

declare module 'claude-code' {
  interface PluginState {
    'ech-mailbox': { box: MailboxMessage[] }
  }
}
