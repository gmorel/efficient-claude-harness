# plugins

- `ech`: the whole harness in one plugin. Left as it was.
- `ech-coder`: the coding lanes and the ai-coder front that asks Jev.
- `ech-pre-postmortem`: the risk ritual agent and command.
- `ech-claim-check`: a Haiku turn-end check for unverified claims, with an optional observer agent.
- `ech-errand`: the errand router hook and the code-explorer agent.
- `ech-codex-review`: read-only Codex reviews and a Codex-first PR review skill.
- `ech-mailbox`: holds peer-session messages until you ask. Off by default.
- `ech-context`: session-size hint and compact guard.
- `ech-eli5`: the ELI5 output style and its Stop hook.

Each folder has its own README with the install line and the local copy to switch off while you test it.
