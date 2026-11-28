# AGENTS.md

Rules for AI coding agents (Claude Code, Codex, Cursor) working on this repository.
README.md is for humans: behaviour, switches, install steps.

## What this repo is

A Claude Code plugin marketplace.
The plugin `ech` is the original and stays untouched by the split.
Eight small plugins were split out of it: `ech-coder`, `ech-pre-postmortem`, `ech-claim-check`, `ech-errand`, `ech-codex-review`, `ech-mailbox`, `ech-context`, `ech-eli5`.
The marketplace manifest is `.claude-plugin/marketplace.json`; every plugin lives in `plugins/<name>/`.
The top-level folders `ai-coder/`, `claim-check/`, `errand/` and the like are docs only: a README and an animation builder each, never installed.

## Commands

Run these before you propose a change; each must exit 0:

```bash
env -u ERRAND_ROUTER_JEV -u JEV_ENV_FILE -u ROUTE_GATE_JEV -u TYPESAFE_AI_JEV_API_KEY node tests/plugin/run.mjs
node scripts/sync-lib.mjs --check
node scripts/run-plugin-tests.mjs plugins/<name>
claude plugin validate .
claude plugin validate plugins/<name>
```

- `tests/plugin/run.mjs` needs only node and git. The env flags above clear inherited Jev settings so the run is clean.
- `claude plugin validate` may print warnings and still pass. The warning that `ech` has no `version` is intended: do not add one.
- `node tests/parity/run.mjs` is owner-only: it needs the owner's original hooks under `~/.claude/hooks/` and `~/.config/harness/errand-router.json`, and exits 3 without them.
- The owner must run the parity check after any change to a hook. A teammate may skip it.
- `.github/workflows/plugins.yml` runs the per-plugin test and validate for every plugin.

## Where things go

- `plugins/ech/hooks/hooks.json` registers the PreToolUse hooks `route-gate.mjs` and `errand-router.mjs`.
- `plugins/ech/hooks/lib/route-gate-jev.mjs` holds the pure Jev coder logic. Keep hook I/O out of it.
- `plugins/ech/hooks/lib/jev-client.mjs` is the Jev client, loaded only in Jev mode.
- `plugins/ech/scripts/harness-dashboard/` is a status page that a person runs by hand. It only reads the ledgers and the transcripts, and `lib.mjs` holds every path it uses.
- `docs/reference.md` holds everything the README leaves out. Put a new switch, flag or edge case there.
- Change the README only when the headline behaviour changes.

## The split plugins

- Each `plugins/ech-<name>/` installs alone: its own `.claude-plugin/plugin.json` (version `0.1.0`), README, hooks, agents, scripts and `tests/`.
- A plugin cannot import from a sibling.
- Files that two plugins share live in `lib/shared/`. `node scripts/sync-lib.mjs` copies them into each plugin.
- Edit the copy in `lib/shared/`, never the plugin's copy. `tests/lib-sync.test.mjs` fails on drift.
- `ech-codex-review` is read-only: never add `--write` or `codex-rescue` there.
- Project rules never go in a plugin. They plug in through a rules file or `userConfig`.

## Invariants

- Hooks always exit 0 and never break an edit or a command, even on a crash.
- Hooks are warn-only by default. Blocking is opt-in.
- An opt-in mode (Jev) must leave default-mode output and ledgers byte-identical.
- Without `ERRAND_ROUTER_JEV=1` (errand-router) or `ROUTE_GATE_JEV=1` (route-gate) there is no network call, and `jev-client.mjs` is not loaded.
- Errand-router Jev mode sends the first 500 characters of the command, redacted.
- Route-gate Jev mode sends metadata only. Code text leaves the machine only with `ROUTE_GATE_JEV_SEND_TEXT=1`, redacted before it is cut.
- Agent names carry their plugin's namespace: `ech:ai-coder`, `ech-coder:ai-coder`.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are substituted in Markdown and `hooks.json`. They are not set in the Bash environment.
- In agent Markdown, pass the data dir explicitly: `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/…"`.
- Runtime data goes to the plugin data directory or `HARNESS_DATA_DIR`, never into the repo.
- Never commit keys, `.env` files, ledgers (`*.jsonl`), `.delegate/` output or personal config.
- Never print, log or write the Jev key (`TYPESAFE_AI_JEV_API_KEY`) or a delegation-service key.
- Never put the owner's host names, lane names or paths in plugin code. They belong in `ERRAND_ROUTER_CONFIG`.

## Code style

- ESM `.mjs`, small functions, Node built-ins only, no npm dependencies.
- Match the comment density and header style of the file you edit.
- In Markdown, write one sentence per line and never hard-wrap prose.

## Git

- Work on a branch and open a pull request.
- Never push to `main` and never force-push.
- Do not commit unless the user asked you to.

## When you change behaviour

Update README.md in the same change.
Update this file if a rule above changed.
