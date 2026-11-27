# codex-review/flow-animation

`build.py` builds the animated review diagram as a script-free SVG: `python3 codex-review/flow-animation/build.py docs/codex-review-flow.svg`.
Every label is checked against `plugins/ech-codex-review`; there are no figures, counters or logos, because the plugin measures nothing.
`build.test.mjs` tests the generator: `node --test codex-review/flow-animation/build.test.mjs`.
