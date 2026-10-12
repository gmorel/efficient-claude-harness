# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor) working on this repository.
README.md is for humans; read it for behaviour, switches and install steps.

## What this repo is

A Claude Code plugin marketplace with one plugin, `ech`.
The marketplace manifest is `.claude-plugin/marketplace.json`; the plugin source is `plugins/ech/`.

## Layout

- `plugins/ech/.claude-plugin/plugin.json` is the plugin manifest; it has no `version` field, on purpose.
- `plugins/ech/agents/*.md` are the subagents, namespaced `ech:` (for example `ech:ai-coder`).
- `plugins/ech/skills/<name>/SKILL.md` are the skills.
- `plugins/ech/commands/*.md` are the slash commands.
- `plugins/ech/hooks/hooks.json` registers the PreToolUse hooks `route-gate.mjs` and `errand-router.mjs`.
- `plugins/ech/hooks/lib/jev-client.mjs` is the Jev client, loaded only in Jev mode.
- `plugins/ech/scripts/*.mjs` are the scripts the agents call: `composer-run`, `remote-run`, `delegate`, `astra`, `openai-gpt-reviewer`.
- `tests/plugin/run.mjs` holds the plugin-only checks; `tests/plugin/ledger-guard.test.mjs` tests the ledger guard.
- `tests/parity/run.mjs` compares the plugin hooks to the owner's original hooks.

## Test before you propose a change

Run `node tests/plugin/run.mjs`; it needs only node and git, runs anywhere, and must exit 0.
Clear inherited env first: `env -u ERRAND_ROUTER_JEV -u JEV_ENV_FILE -u ROUTE_GATE_JEV -u TYPESAFE_AI_JEV_API_KEY node tests/plugin/run.mjs`.
Run `claude plugin validate .` from the repo root; it must pass.
One warning that the plugin has no version is expected and intended; do not add a `version` to silence it.
`node tests/parity/run.mjs` is owner-only: it needs the owner's original hooks under `~/.claude/hooks/` and `~/.config/harness/errand-router.json`, and exits 3 without them.
A teammate may skip the parity run; the owner must run it after any change to a hook.

## Invariants

- Hooks always exit 0 and never break an edit or a command, even on a crash.
- Hooks are warn-only by default; blocking is opt-in.
- Any opt-in mode (Jev) must leave default-mode output and ledgers byte-identical.
- Without `ERRAND_ROUTER_JEV=1` (errand-router) or `ROUTE_GATE_JEV=1` (route-gate) there is no network call and `jev-client.mjs` is not loaded.
- Errand-router Jev mode sends the first 500 characters of the command, redacted; route-gate Jev mode sends metadata only by default, and code text leaves the machine only with `ROUTE_GATE_JEV_SEND_TEXT=1`, and it is redacted before it is cut.
- `plugins/ech/hooks/lib/route-gate-jev.mjs` holds the pure Jev coder logic; keep hook I/O out of it.
- No npm dependencies; use Node built-ins only.
- Agent names are namespaced `ech:`.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are substituted in Markdown and `hooks.json`, but are not set in the Bash environment.
- In agent Markdown, pass the data dir explicitly: `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/…"`.
- Runtime data goes to the plugin data directory or `HARNESS_DATA_DIR`, never into the repo.
- Never commit keys, `.env` files, ledgers (`*.jsonl`), `.delegate/` output or personal config.
- Never print, log or write the Jev key (`TYPESAFE_AI_JEV_API_KEY`) or a delegation-service key.
- Never put the owner's host names, lane names or paths in plugin code; they belong in `ERRAND_ROUTER_CONFIG`.

## Git

- Work on a branch and open a pull request.
- Never push to `main` and never force-push.
- Do not commit unless the user asked you to.

## Style

- ESM `.mjs`, small functions, Node built-ins only.
- Match the comment density and header style of the file you edit.
- In Markdown, write one sentence per line and never hard-wrap prose.

## When you change behaviour

Update README.md in the same change, for the humans who read it.
Update this file if a rule above changed.
