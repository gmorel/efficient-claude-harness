# ech-pre-postmortem

The pre-post-mortem risk ritual, installable alone.

## What it does

- The `pre-post-mortem` agent (Opus) imagines a risky change has already failed in production and works back to the causes, then proposes mitigations.
- The `/ech-pre-postmortem:pre-post-mortem` command asks the current session to run the same ritual on its own work, ending with **WATCH FOR THIS ONE**.
- Use it for production writes, schema migrations, destructive scripts and anything driving a live external system. Do not use it for routine edits.

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-pre-postmortem@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-pre-postmortem` from the repository root.

## Switch off your local copy while you test

- The installed plugin `ech@efficient-claude-harness` ships the same agent and command: set it to `false` in `enabledPlugins` of `~/.claude/settings.json`.
- The skill `ech:pre-post-mortem` that this session lists comes from that same plugin and goes away with it.

## Rollback

```
/plugin uninstall ech-pre-postmortem@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`).

## Test it

```
node --test plugins/ech-pre-postmortem/tests/*.test.mjs
claude plugin validate plugins/ech-pre-postmortem
```
