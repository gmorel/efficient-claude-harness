# ech-eli5

The ELI5 one-card output style and the Stop hook that enforces it.

## What it does

- The output style `ELI5`: plain words, one idea per sentence, every question asked with the question tool, and the final reply is one blockquote card with a marker on every line.
- The `card-guard` Stop hook refuses a final reply that is not a card. It is **off unless `CARD_GUARD` is set**: `CARD_GUARD=warn` logs, `CARD_GUARD=block` refuses only a reply that is not a card at all.
- `CARD_GUARD_TITLE` and `CARD_GUARD_DEFAULT_PHRASE` change the two strings of the contract that are text, so a card in another language is a setting.
- Pick the style with `outputStyle` in settings (`ech-eli5:ELI5`), or in the app's style menu.

## Install from the local path

```
/plugin marketplace add <path-to-your-clone-of-this-repository>
/plugin install ech-eli5@efficient-claude-harness
```

To try it for one session without installing, run `claude --plugin-dir plugins/ech-eli5` from the repository root.

## Switch off your local copy while you test

- The output style: your own `~/.claude/output-styles/ELI5.md` has the same name. Set `outputStyle` in `~/.claude/settings.json` to the plugin's style instead (`ech-eli5:ELI5`), and keep the local file as the fallback.
- The `eli5@claude-community` plugin is a different style with a similar name. It does not conflict.
- The hook: in `~/.claude/settings.json`, the Stop entry `python3 "$HOME/.claude/hooks/card-guard.py"`. Remove it while you test this plugin's `card-guard.mjs`, or both run.

## Rollback

```
/plugin uninstall ech-eli5@efficient-claude-harness
```

Then switch your local copy back on.
Ledgers and state go to the data directory (`HARNESS_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else `~/.claude/harness-data`).

## Test it

```
node --test plugins/ech-eli5/tests/*.test.mjs
claude plugin validate plugins/ech-eli5
```
