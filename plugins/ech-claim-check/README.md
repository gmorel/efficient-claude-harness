# ech-claim-check

A turn-end check that catches success, fix, count and "verified" claims made without a ground-truth check.

## What it does

At `Stop` (the main thread) and `SubagentStop` (every subagent), it reads the final assistant text and a compact list of the turn's tool calls and their short results.
A regex gate skips texts with no claim words at zero cost.
Otherwise Haiku (low effort, 200-token cap) answers whether the text states a success, a count, "saved", "fixed", "verified" or a similar claim that leaves the turn and that no listed tool call backs.
When it does, the hook returns `{ block }`, which re-prompts the agent once in the same turn: « claim » — check <artifact> or restate it as unverified.

- It runs by default, in every project, once the plugin is installed.
- One block per turn at most: a stop with `stop_hook_active` is never checked.
- Fail open: any error, timeout or unreadable answer lets the stop through.
- Reports from a `claim-sentinel` observer are never checked.
- Every decision is one line in `$HARNESS_DATA_DIR/ech-claim-check.jsonl`, or `~/.claude/ledgers/ech-claim-check.jsonl` when that variable is unset (session, event, agent type, flagged, claim, Haiku tokens, ms, rules file).

## Project rules (optional)

The plugin ships generic rules only.
To add rules for one project, write them in `<project>/.claude/claim-check-rules.md`; when that file exists, its text is appended to the Haiku prompt, cut at 4,000 characters.
To read another file, set the `rulesFile` option (`/plugin` config screen, or `pluginConfigs` in settings): an absolute path, a `~/` path, or a path relative to the session's working directory.
An empty `rulesFile` turns project rules off.
Write the rules as plain sentences naming what counts as a check in that project, for example "A deploy is only verified by reading the /health page."

## Install

From this repository as a local marketplace:

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-claim-check@efficient-claude-harness
```

The install needs an `ech-claim-check` entry in the repository's `.claude-plugin/marketplace.json`, with `"source": "./plugins/ech-claim-check"`.

For one session only, without installing:

```
claude --plugin-dir plugins/ech-claim-check
```

Tests: `claude plugin test plugins/ech-claim-check`.

## The claim-sentinel observer (opt-in)

The plugin also ships `agents/claim-sentinel.md`, a background observer that reads each turn's activity digest and reports unverified claims.
Nothing runs it until you opt in.
To opt in, set `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1` and add this one line to the frontmatter of your main agent (for example `~/.claude/agents/main.md`):

```
observer: ech-claim-check:claim-sentinel
```

The observer costs a model call on every turn, so most people keep only the turn-end check.

## Switch off your local copy while testing

If you already run the original claim-check mod, switch it off so the two do not both block the same turn.

- The mod: move `~/.claude/skills/claim-check` out of `~/.claude/skills`, or remove it from the mods folder it loads from.
- The observer, if you pair a local `claim-sentinel` through your main agent: remove or change the `observer: claim-sentinel` line in `~/.claude/agents/main.md`, and move `~/.claude/agents/claim-sentinel.md` aside.

## Rollback

```
/plugin uninstall ech-claim-check@efficient-claude-harness
```

Then put your local copy back: move `~/.claude/skills/claim-check` (and `~/.claude/agents/claim-sentinel.md` with its `observer:` line, if you used it) back where it was.
