# Harness dashboard

One page that shows, for every part of the `ech` harness (main session, the route-gate and errand-router hooks, each agent lane, the claim-sentinel observer, and the engines behind them), whether it is working, failing, degraded, dead or idle, plus a replay of the events that got it there.

It reads the ledgers the harness already writes, and writes nothing back to them.

## The three commands

```bash
cd "$(dirname "$(find ~/.claude/plugins -path '*harness-dashboard/build.mjs' | head -1)")"
node backfill.mjs   # transcripts → <data>/dashboard-cache/agent-runs.jsonl (metadata only; incremental, about 20 s cold and seconds after)
node build.mjs      # all ledgers + backfill → <data>/harness-dashboard.html
node serve.mjs      # http://127.0.0.1:4783/ with a LIVE toggle fed by Server-Sent Events
```

`<data>` is `HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data` — the same directory the rest of the harness writes to.
Nothing is written inside the plugin directory, because Claude Code replaces it on every update.

`backfill.mjs --full` rescans every transcript; `--days N` sets how far back it reads (default 90).
`build.mjs --days N` sets the page window (default 60).
After writing the page it loads it in a real browser and checks that the JS-off markup and the JS-on tree report the same state for every box. That needs `playwright-core` — point `VIZ_PLAYWRIGHT` at an `index.mjs` you already have — and Chrome; without either it says so and the build still succeeds. `--no-check` skips it, and `HARNESS_DASHBOARD_STRICT=1` fails the build when it cannot run.
`HARNESS_DASHBOARD_OUT` changes where the page is written, and `HARNESS_DASHBOARD_PORT` changes the server port.

## The two layouts

The stage opens as an onion: your conversation at the centre, the hooks that sit in front of every edit in the first ring, the lanes it spawns in the second, the engines they run on in the third, and the claim-sentinel observer above everything.
While the replay plays, each delegation is drawn as a packet riding from one box to the next along a line that fades out behind it.

The `layout` button switches to the original top-down tree, which keeps the full label and the nudge sentence on every card. The choice is remembered per browser.

## Nudges

The page also judges route-gate and errand-router nudges over 30 days.
A route-gate warn or deny counts as followed when a coding lane starts in the same session within 15 minutes: `ech:ai-coder` or `ech:ai-coder-high` (whatever prefix they carry) or a `composer-run` run. A run by one of the project's own coding agents counts too, and is reported apart. Anything else is ignored.
An errand-router warn (the control arm's would-warn is never shown and is excluded) is followed when an Explore or code-explorer run starts in the same session within 5 minutes.
Spawn sources: `routing.jsonl` kind=delegate, the transcript backfill, `agents.jsonl`, and `runs.jsonl` (start = ts minus duration).

## Files

- `lib.mjs`: the data directory, the ledger paths (process env, then `~/.claude/settings.json` env), the box list, the per-source normalizers and the state rule.
- `agent-runs-hook.mjs`: SubagentStart/SubagentStop hook writing `<data>/agents.jsonl` (`AGENT_RUNS_LEDGER` overrides).
- `backfill.mjs`, `build.mjs`, `serve.mjs`, `check-states.mjs`: as above.
- `page.css`, `page.js`: inlined into the page by `build.mjs`.
- `<data>/dashboard-cache/`: backfill state and output; safe to delete, the next backfill rebuilds it.

## Hook wiring (not done by these scripts)

Without this hook the page still works: it loses the per-agent run ledger and falls back to the transcript backfill, which is slower and coarser.
Add to the `SubagentStart` and `SubagentStop` arrays in `~/.claude/settings.json`:

```json
{ "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/harness-dashboard/agent-runs-hook.mjs", "timeout": 5 } ] }
```

`CLAUDE_PLUGIN_ROOT` is set for hooks the plugin itself declares. These two arrays are yours, not the plugin's, so write the absolute path of this directory instead if the variable is empty in your setup.

## What never leaves the ledgers

Event details are assembled from enum fields, numbers and basenames only.
Prompt text, command text, file contents, error messages and the subagent's last message are never copied into the cache, the page or the stream.
