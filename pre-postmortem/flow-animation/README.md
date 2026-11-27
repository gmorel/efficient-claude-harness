# pre-postmortem/flow-animation

`build.py` builds the animated pre-post-mortem diagram, a script-free SVG: `python3 pre-postmortem/flow-animation/build.py docs/pre-postmortem-flow.svg`.
It follows the look and the checks of `ai-coder/flow-animation/SKILL.md`; the steps it draws come from `plugins/ech-pre-postmortem`.
`build.test.mjs` tests the generator: `node --test pre-postmortem/flow-animation/build.test.mjs`.
