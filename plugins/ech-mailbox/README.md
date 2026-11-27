# ech-mailbox

Messages that other Claude sessions send to this session are held in a mailbox instead of waking it, so they do not break your flow.

## What it does

- A message from another session (origin `peer` or `peer-send-message`) is held: it is not queued, not shown and not read by the model.
- A message whose text starts with `BLOCKING:` passes at once and wakes the session as before.
- The status line shows `mailbox: N waiting` while messages wait.
- When you type your next prompt, the waiting messages ride along with it as context the model reads, and the mailbox empties.
- Once an hour, any waiting messages go out as one digest turn, so the session wakes at most once an hour for them.
- `/mailbox` lists the waiting messages, `/mailbox flush` sends them now as one turn, and `/mailbox clear` drops them.
- The mod is OFF by default: with `enabled` false it registers no hook at all, so every message, prompt and command passes untouched.

## Install

From the repository's marketplace, at the prompt of a terminal session:

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-mailbox@efficient-claude-harness
```

The marketplace file at the repository root must list `ech-mailbox` with `"source": "./plugins/ech-mailbox"` for that install line to find it.

Or for one session only, from the repository root:

```
claude --plugin-dir plugins/ech-mailbox
```

Function hooks are early access: a build that needs it also wants `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment.

## Turn it on

Set the `enabled` option to true: in `/config` (the `ech-mailbox` row), on the options screen the install shows, or in `settings.json` under `pluginConfigs`, keyed by the plugin's name, `"options": { "enabled": true }`.
A change reloads the module; the hourly timer and `/mailbox` then start with the next session, or with the first message the mailbox holds.

## Local copy to switch off while testing

No local copy of this mod exists in ~/.claude; nothing to switch off.

## Rollback

```
/plugin uninstall ech-mailbox@efficient-claude-harness
```

Turning `enabled` off is the softer rollback: the module then registers nothing.

## Test

```
claude plugin validate plugins/ech-mailbox
claude plugin test plugins/ech-mailbox
```

## Design caveats

- A held message can wait up to an hour, so a review answer or a merge can slow down.
- A sender that marks everything `BLOCKING:` brings the wake-ups back; keep it for what the receiver must act on within the hour.
- `BLOCKING:` is matched at the start of the delivered text, after any leading tags the delivery frames it with; a marker later in the text does not count.
- Only the main conversation's peer messages are held; messages to a subagent and agent-team teammate messages pass as before.
- Held messages live in the session's `$.state` and are mirrored to the plugin's `$.store` under the session id, so a resumed session finds them again; the store is capped at 4 MiB for all sessions together, and there is no separate jsonl backup.
- If a hook fails, the message passes (fail-open): a message may then arrive twice. This path has no test yet: treat "never lost" as unverified.
- `/mailbox flush` sends the digest from a timer one millisecond after the command, because a prompt submitted from inside a command would wait on the command's own turn.
- The digest goes out through `$.prompt.submit`, which waits until the session is idle; whether it fires while a lane sits idle in the desktop app is not proven yet.
- Waiting messages join only a prompt you typed (terminal, Remote Control or SDK), never a slash command or another plugin's prompt.
