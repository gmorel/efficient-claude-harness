# efficient-claude-harness

![The main session sends all code to ai-coder, which asks Jev and picks ai-coder-average (Cursor Composer) or ai-coder-high (the delegation service); Codex reviews and the claim sentinel observes. The saved dollars are theoretical.](docs/ai-coder-flow.svg)

Agents, skills and hooks for Claude Code that keep your conversation small: each piece of work goes to the cheapest lane that can do it.
Every concept below is a plugin you can install alone, and has its own folder that explains it with its own animated diagram.

## Install

```
/plugin marketplace add gmorel/efficient-claude-harness
/plugin install ech-coder@efficient-claude-harness
```

Swap `ech-coder` for any plugin in the table. The plugin `ech` is the whole harness in one install; it and a split plugin register the same hooks (`route-gate`, `errand-router`), so enable only one.
For a whole team: `claude plugin install <plugin>@efficient-claude-harness --scope project`.

## Pick what you need

| Concept | What it does | Plugin |
|---|---|---|
| [ai-coder](ai-coder/README.md) | Sends all code to Cursor Composer or the delegation service, and commits nothing itself. | `ech-coder` |
| [pre-postmortem](pre-postmortem/README.md) | Imagines a risky change already failed and works back to why. | `ech-pre-postmortem` |
| [claim-check](claim-check/README.md) | A Haiku check at turn end for claims made without a real check. | `ech-claim-check` |
| [errand](errand/README.md) | Nudges long runs of read-only errands toward a cheap Haiku helper. | `ech-errand` |
| [codex-review](codex-review/README.md) | Read-only second opinion from Codex on a diff or a plan. | `ech-codex-review` |
| [mailbox](mailbox/README.md) | Holds messages from other sessions until you ask. Off by default. | `ech-mailbox` |
| [context](context/README.md) | A session-size hint and a guard for compaction. | `ech-context` |
| [eli5](eli5/README.md) | The one-card output style and its Stop hook. | `ech-eli5` |

Each plugin folder, `plugins/<name>/`, has its own README with the install line, what to switch off while you test it, and how to roll back.
Hooks only add a note to Claude's context. None blocks anything unless you opt in.

## More

- [docs/reference.md](docs/reference.md): the flow diagram, every component, the dashboard, engine config, prerequisites per lane, switches, runtime data and security notes.
- [AGENTS.md](AGENTS.md): rules for agents working on this repository.
- `plugins/ech/`, `lib/`, `scripts/`, `tests/` and `.github/`: the plugins, the shared files, the repository tooling, the tests and the CI workflow.

## Tests

```bash
env -u ERRAND_ROUTER_CONFIG HOME="$(mktemp -d)" node tests/plugin/run.mjs   # must exit 0; needs only node and git
node scripts/run-plugin-tests.mjs plugins/<name>                             # one split plugin
node scripts/sync-lib.mjs --check                                            # fails when a shared lib copy drifted
```

## License

MIT. See [LICENSE](LICENSE).
