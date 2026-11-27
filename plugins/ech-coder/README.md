# ech-coder

The coding lanes of the harness, installable alone.

## What it does

- `ai-coder` sends a concrete code change to Cursor Composer, in place, and commits nothing.
- `ai-coder-high` is the guarded lane: migrations, auth, payments, secrets, CI and git hooks go to the delegation service.
- `composer-merger` runs only when `composer-run.mjs check` says ESCALATE, and judges whether a green suite was made green by editing the suite.
- The `route-gate` PreToolUse hook counts the size of a code edit and nudges toward the lane. It is warn-only by default (`ROUTE_GATE=off|warn|deny`).
- The `delegate-heavy-reasoning` skill and the `/ech-coder:delegate-to-external-ai` command send a bounded job to the delegation service.
- Engines are chosen in `config.example.json` (copy it to `~/.config/claude-harness/config.json`).
- Jev mode of the hook is opt-in (`ROUTE_GATE_JEV=1`). The Jev client is a shared copy kept in sync by `node scripts/sync-lib.mjs`.

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-coder@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-coder` from the repository root.

## Switch off your local copy while you test

You will otherwise run two copies of the same hook and agents.
- The installed plugin `ech@efficient-claude-harness`: set it to `false` in `enabledPlugins` of `~/.claude/settings.json` (it ships route-gate, ai-coder, ai-coder-high and composer-merger today).
- `~/.claude/skills/delegate-heavy-reasoning/` (move the folder out of `~/.claude/skills/`).
- `~/.claude/commands/delegate-to-external-ai.md` (move the file out of `~/.claude/commands/`).
- The `ROUTE_GATE_*` entries in the `env` block of `~/.claude/settings.json` only matter if you keep the old hook: leave them, this plugin reads the same names.

## Rollback

```
/plugin uninstall ech-coder@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`). Other writes are described above.

## Test it

```
node --test plugins/ech-coder/tests/*.test.mjs
claude plugin validate plugins/ech-coder
```
