# ech-codex-review

Read-only cross-model review through Codex, installable alone.

## What it does

- `sol-reviewer`, `openai-gpt-diff-reviewer` and `openai-gpt-plan-reviewer` forward a diff or a plan to Codex and return the findings verbatim, labelled ADVISORY.
- `delegate-to-openai-astra` (agent and skill) forwards one task to Astra, only when the user names Astra.
- The `codex-first-pr-review` skill: Codex reads the whole PR diff first, then a fresh reviewer checks only Codex's findings and the project's invariants. Invariants come from `.claude/pr-review-invariants.md` or the `Invariants` section of `AGENTS.md`.
- **Read-only, always.** No `--write` (`astra.mjs` refuses it with exit 2), no `codex-rescue`, no `transfer`. `tests/read-only.test.mjs` checks every shipped file.
- Needs the `codex` Claude Code plugin and the `codex` CLI. Without them the scripts say so and stop.

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-codex-review@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-codex-review` from the repository root.

## Switch off your local copy while you test

- `~/.claude/agents/openai-gpt-diff-reviewer.md` and `~/.claude/agents/openai-gpt-plan-reviewer.md` (move them out of `~/.claude/agents/`).
- `~/.claude/skills/delegate-to-openai-astra/` (move the folder out of `~/.claude/skills/`).
- The installed plugin `ech@efficient-claude-harness` also ships the Astra agent and skill: set it to `false` in `enabledPlugins` of `~/.claude/settings.json`.

## Rollback

```
/plugin uninstall ech-codex-review@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`).

## Test it

```
node --test plugins/ech-codex-review/tests/*.test.mjs
claude plugin validate plugins/ech-codex-review
```
