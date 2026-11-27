# ech-context

Keep a long session useful: a size hint and a compaction guard.

## What it does

- `session-size` (UserPromptSubmit): reads the last main-thread token usage from the transcript tail. Above `SESSION_SIZE_LIMIT` (200000) it adds a line asking Claude to finish the step and save notes, once per `SESSION_SIZE_STEP` (50000) of growth. It never refuses a prompt.
- `compact-guard` (PreCompact, SessionStart `compact`): on an automatic compaction it adds instructions telling the summary what to keep verbatim, and after it adds a recovery line.
- Switches: `SESSION_SIZE=off`, `COMPACT_GUARD=off`, or create `<data>/session-size.off` / `<data>/compact-guard.off`. Both fail open.

### The `autoCompactWindow` setting

Claude Code compacts on its own when the context reaches a window size. The setting `autoCompactWindow` in `settings.json` moves that size.
- Raising it (for example to 700000) lets sessions run long, and the session-size hint is then your only prompt to start fresh.
- Lowering `SESSION_SIZE_LIMIT` to 150000 only makes sense together with `autoCompactWindow` 250000, which compacts at about 217k.
- This plugin never edits your settings. Change the value yourself.

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-context@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-context` from the repository root.

## Switch off your local copy while you test

- In `~/.claude/settings.json` the hooks `node "$HOME/.claude/hooks/session-size.mjs"` (UserPromptSubmit) and `node "$HOME/.claude/hooks/compact-guard.mjs"` (PreCompact, and SessionStart with matcher `compact`): remove those entries, or the hooks fire twice.
- The files `~/.claude/hooks/session-size.mjs` and `~/.claude/hooks/compact-guard.mjs` can stay; nothing runs them once the entries are gone.

## Rollback

```
/plugin uninstall ech-context@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`).

## Test it

```
node --test plugins/ech-context/tests/*.test.mjs
claude plugin validate plugins/ech-context
```
