# ech-errand

The errand router: stop the main thread from paying for runs of read-only errands.

## What it does

- A PreToolUse hook (`Bash|Read`) spots a run of read-only errands (`cat`, `grep`, `ls`, `git log`, ...) in the main thread.
- From the 3rd errand in a row it nudges toward the Haiku `code-explorer` agent. A helper's own result is never nudged (verify window).
- Default mode is warn, with a holdout: half the sessions are a silent control group, so the nudge can be measured (`ERRAND_ROUTER_HOLDOUT=0` nudges every session).
- Switches: `ERRAND_ROUTER=warn|block|off`, or create `<data>/errand-router.off`.
- Subagents are never routed. Without `ERRAND_ROUTER_JEV=1` nothing leaves the machine.
- `code-explorer` returns `file:line` only: where something is, never what it does.

### Enforce mode (proposed design, not yet ported from the owner's setup)

The owner's enforce key (`enforce.projects` in `~/.config/harness/errand-router.json`) had no reader in any hook file this repository could see, so this plugin defines what it means.
- `enforce.projects` is a list of absolute project directories.
- In a session whose `cwd` is one of them, or inside one, the hook runs in block mode and skips the holdout: the 5th errand in a row is denied, the 3rd and 4th warn.
- `ERRAND_ROUTER=off` and the off file still win. Everywhere else the mode is what `ERRAND_ROUTER` says.
- The ledger line carries `enforced: true`. Tests cover inside, equal, outside, a prefix lookalike (`/a/bc` is not inside `/a/b`) and relative entries (never match).
- If your enforce mode means something else, change `enforcedFor()` in `hooks/errand-router.mjs`.

### Config schema

`ERRAND_ROUTER_CONFIG=<absolute path>` points at a JSON file. Every key is optional. See `errand-router.schema.json` and `config.example.json`.
Keys: `enforce.projects`, `lanes`, `how`, `sshHosts`, `liveRunWords` (the last three matter in Jev mode only).

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-errand@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-errand` from the repository root.

## Switch off your local copy while you test

- The installed plugin `ech@efficient-claude-harness` registers the same `errand-router.mjs` hook: set it to `false` in `enabledPlugins` of `~/.claude/settings.json`.
- The `ERRAND_ROUTER_*` entries in the `env` block of `~/.claude/settings.json` (ledger, state dir, config, Jev) are read by this plugin too: leave them or remove them.
- `~/.claude/hooks/errand-router.mjs` is not registered in `settings.json` today, so there is nothing to switch off there.

## Rollback

```
/plugin uninstall ech-errand@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`).

## Test it

```
node --test plugins/ech-errand/tests/*.test.mjs
claude plugin validate plugins/ech-errand
```
