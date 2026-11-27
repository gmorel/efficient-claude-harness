# context/flow-animation

`build.py` builds the script-free animated SVG of the ech-context flow: `python3 context/flow-animation/build.py docs/context-flow.svg`.
Every node, link, timing and caption is data near the top of `build.py`; the figures are the defaults in `plugins/ech-context/hooks`.
`build.test.mjs` tests the generator: `node --test context/flow-animation/build.test.mjs`.
