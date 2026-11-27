# ech-coder

The coding lanes of the harness, installable alone.

## What it does

- `ech-coder:ai-coder` is the single front for every code change: it asks Jev which lane should run it, then runs that lane.
  It commits nothing.
- `ech-coder:ai-coder-average` is the standard lane: Cursor Composer, in place (what `ai-coder` did before it became the front).
- `ech-coder:ai-coder-high` is the guarded lane: the delegation service, a written plan first, for migrations, auth, payments, secrets, CI and git hooks.
- Both lanes stay callable by name, to skip the Jev question.
- `composer-merger` runs only when `composer-run.mjs check` says ESCALATE, and judges whether a green suite was made green by editing the suite.
- The `route-gate` PreToolUse hook counts the size of a code edit and nudges toward the lane. It is warn-only by default (`ROUTE_GATE=off|warn|deny`).
- The `delegate-heavy-reasoning` skill and the `/ech-coder:delegate-to-external-ai` command send a bounded job to the delegation service.
- Engines are chosen in `config.example.json` (copy it to `~/.config/claude-harness/config.json`).
- Jev mode of the hook is opt-in (`ROUTE_GATE_JEV=1`). The Jev client is a shared copy kept in sync by `node scripts/sync-lib.mjs`.

## How the front picks a lane

The front runs `scripts/lane-pick.mjs`, which asks Jev one question and prints one line: `{"lane":"average"|"high","source":"jev"|"fallback","reason":...,"confidence":...}`.
Jev decides; the front does not override it, not even on a guarded path.
Jev sees metadata only, redacted: file extensions, repo-relative paths, line counts, file count, the planned change size, the brief's line count and a guarded-path flag.
It never sees the brief text or a file's content.
Every failure picks `high`, the safe lane, with `source: "fallback"` and the reason named: `jev_off`, `no_key`, `network`, `timeout`, `http_<status>`, `malformed`, `off_menu` (Jev answered neither lane) or `low_confidence`.
So without Jev, every code change goes to the high lane; call `ech-coder:ai-coder-average` by name for an ordinary change if you have no Jev key.

Switches:
- `AI_CODER_JEV=1` turns Jev on for the front, `AI_CODER_JEV=0` turns it off, unset follows `ROUTE_GATE_JEV`.
- The key is `TYPESAFE_AI_JEV_API_KEY` (or the line of that name in the file `JEV_ENV_FILE` names); the endpoint is `JEV_URL`.
- `ROUTE_GATE_JEV_MIN_CONF` (default 0.80) is the confidence under which the answer is ignored; `ROUTE_GATE_JEV_TIMEOUT_MS` (default 1500) bounds the call.
- Off, or without a key, no network call is made and the Jev client is not loaded.

Every decision appends one line to `ai-coder-lane.jsonl` in the data directory: lane, source, reason, confidence, file count, line counts, extensions and the guarded flag.
It never holds the brief text, a path or the key.

**Limitation: a subagent cannot start another subagent.**
So the front does not call `ai-coder-average` or `ai-coder-high`: it reads the chosen lane's agent file and follows its steps itself, in its own context and on its own model.
The lane's own `model:` line does not apply when it runs through the front.

The `route-gate` hook still names `ai-coder` or `ai-coder-high` by its fixed path rule; it does not ask the front's question.

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
