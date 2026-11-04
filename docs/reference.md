# Reference

Everything the [README](../README.md) leaves out. Nothing here is needed to install the plugin or to use it on defaults.

## Delegation-service configuration

Every person uses their own delegation-service account and their own key.
Never share a key or reuse someone else's: the service runs jobs on the account behind the key, and Anthropic's consumer terms forbid making an account available to anyone else.
Without your own `config.json`, the delegation lane does not run.

Create `~/.config/claude-delegate/config.json` yourself, readable only by you (`chmod 600`):

```json
{ "baseUrl": "https://…", "apiKey": "<your key>" }
```

`DELEGATE_CONFIG` points the scripts at a different file, and `DELEGATE_CMD` replaces the client script, which is useful for tests.
Never commit this file and never paste the key into a prompt.

## Attaching claim-sentinel

Observer agents are an experimental Claude Code feature, and the plugin documentation does not list `observer:` among the frontmatter fields a plugin agent supports.
So this plugin ships the observer but does not ship a main agent that hosts it, and it does not set a main-thread agent for you — that would silently replace your own.

Add these two lines to the frontmatter of the agent you run as your main thread, for example `~/.claude/agents/main.md`:

```yaml
observer: ech:claim-sentinel
observerMessage: Name the exact claim this turn asserted without a ground-truth check in this session, plus the exact artifact that would settle it. Specific claim or silence.
```

Then select that agent as your main thread (`"agent": "main"` in `~/.claude/settings.json`, or `claude --agent main`) and set `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1`.
The plugin-scoped name `ech:claim-sentinel` in `observer:` has not been tested yet; if it does not attach, copy `plugins/ech/agents/claim-sentinel.md` into `~/.claude/agents/` and use `observer: claim-sentinel`.
The observer costs tokens on every turn, so many people enable it only for risky sessions.

## Hook details

`route-gate` stays silent in subagents, in non-interactive sessions, outside git repositories, and when `cursor-agent` is missing.
Its thresholds (`maxLines`, `guardedMaxLines`, `maxFilesPerPrompt`) live in `<data>/route-gate.json`; `ROUTE_GATE_CONFIG` points it at a file of your choice, and an existing `~/.claude/composer-lane/route-gate.json` works as is.
An unguarded edit with no `cursor-agent` is logged as `lane_missing` and gets no note.

`errand-router` stays silent in subagents and for the eight errands after a helper returns, so you can check what the helper claimed.
`ERRAND_ROUTER_LANE` changes the agent it suggests.
Half the sessions are a silent control group by default, in Jev mode and out of it, logged as `would-warn`; `ERRAND_ROUTER_HOLDOUT=0` nudges every session.

`ROUTE_GATE_AGENT_PREFIX` sets the agent name in `route-gate` messages and its ledger; the default is `ech:`.
An empty value gives the original messages byte for byte, naming `ai-coder` and `ai-coder-high`. Only the owner's parity profile sets it empty, inside its sandbox.

## Jev classification (opt-in, both hooks)

Jev (typesafe.ai) is a fast classifier the two hooks can consult instead of relying on their fixed rules alone.
Without `ERRAND_ROUTER_JEV=1` or `ROUTE_GATE_JEV=1` there is no network call at all and the Jev client is not even loaded.
A Jev failure — no answer, timeout, HTTP error, unreadable body — never blocks a tool call: the fixed-rule result stands.

The key is read from `TYPESAFE_AI_JEV_API_KEY`, or, only when that is empty and `JEV_ENV_FILE` names a file, from the `TYPESAFE_AI_JEV_API_KEY=` line of that file. It is never printed, logged or written.
`JEV_URL` overrides the endpoint, which defaults to `https://api.typesafe.ai/v1/systemone`.

### `errand-router`

From the third errand in a row, the hook asks Jev which helper lane should run the call.
It nudges only when Jev names a lane other than the main thread with a confidence of at least 0.80 (`ERRAND_ROUTER_MIN_CONF`), and it gives Jev 1500 ms (`ERRAND_ROUTER_TIMEOUT_MS`).

`ERRAND_ROUTER_LANES` overrides the lane table, as a JSON object mapping a lane key to its description, for example `{"explore":"Explore: searches or reads several repository files.","main":"main thread, keep it here."}`.
The `main` lane is always kept. A missing or invalid value falls back to the owner's `lanes` from `ERRAND_ROUTER_CONFIG`, then to the generic table (`explore` and `main`).
A lane other than `explore` and `main` is offered to Jev only when its agent file exists in `~/.claude/agents/` or in the nearest `.claude/agents/` above the working directory.

`ERRAND_ROUTER_CONFIG` names a JSON file with the owner's values, read once at start, with an absolute path. Every key is optional: `lanes`, `how` (the Jev HOW text), `sshHosts` (hosts whose `ssh <host> …` calls count as errands in Jev mode) and `liveRunWords` (script names whose `node … <word>` call, run over ssh, stays in the main thread in Jev mode).
A missing or unreadable file means the generic defaults, with no error. The plugin ships no host or lane names of its own.

The command text sent to Jev is the first 500 characters, redacted before it is cut.

### `route-gate`

Jev is asked only after the fixed rules already decided to nudge or block (`size` or `many_files`), so small edits are unaffected.
It picks one lane: `ai-coder`, `ai-coder-high` or `main` (keep the edit in the main session).
A guarded path always stays on `ai-coder-high`, whatever Jev says; Jev can move an ordinary path up to `ai-coder-high`.
In warn mode, `main` removes the nudge; in deny mode, `main` never lifts the block.
A confidence under 0.80 (`ROUTE_GATE_JEV_MIN_CONF`), a timeout of 1500 ms (`ROUTE_GATE_JEV_TIMEOUT_MS`) or any error keeps the fixed-rule result.

By default only metadata goes to Jev: tool, file extension, path relative to the git root, line counts, file count and the guarded flag.
`ROUTE_GATE_JEV_SEND_TEXT=1` also sends up to 400 characters of the new code, after a best-effort secret redaction, redacted before it is cut. Turn it on only if you accept that code leaves your machine.

In Jev mode the ledger record gains `jev_lane`, `jev_conf`, `jev_ms` and `jev_action`; without it, output and ledger are unchanged.

## Parity check against the original hooks

`node tests/parity/run.mjs` runs the original hooks under `~/.claude/hooks/` and the plugin hooks on the same inputs in a temp sandbox, and prints one table row per case.
It is owner-only and exits 3 without `~/.config/harness/errand-router.json`.

`--profile default` or `--profile owner` runs one profile.
Both profiles read the owner config (`ERRAND_ROUTER_CONFIG`) to build their inputs, and the owner profile hands that file to the plugin hook.
The owner profile turns Jev mode on with a dummy key against a local stub, must show zero DIFF, has no allowlist entries, and sets `ROUTE_GATE_AGENT_PREFIX` to empty for the plugin hooks, as the owner's real environment must.
The default profile may show ALLOWED rows, each with its reason printed under the table; any other difference is a DIFF.
The output is compared raw: the only rename of `ech:ai-coder` to `ai-coder` is a scoped allowlist rule for `route-gate` in the default profile.

A PLUGIN-ONLY section after the table runs the one check that needs the owner config, and prints PASS or FAIL; the other plugin checks are in `tests/plugin/run.mjs`.
It exits 1 on any unexplained difference, any failed plugin check, or any line the test itself wrote to a real ledger under `~/.claude` — a line with the test's synthetic session ids or its temp path.
Lines another session appends to those ledgers during a run are printed as `REAL LEDGER info` and never fail the run, so the check works while other sessions are active. `tests/plugin/ledger-guard.test.mjs` checks the split.
