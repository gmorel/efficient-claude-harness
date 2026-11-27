# eli5/flow-animation

`build.py` builds the script-free animated SVG of the ELI5 flow, published as `docs/eli5-flow.svg`: `python3 eli5/flow-animation/build.py docs/eli5-flow.svg`.
It uses the Python standard library only and writes only that file; the nodes, links and pulses are data near the top.
`build.test.mjs` tests the generator: `node --test eli5/flow-animation/build.test.mjs`.
