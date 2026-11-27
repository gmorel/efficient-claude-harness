# claim-check/flow-animation

`build.py` builds the animated claim-check diagram, a script-free SVG: `python3 claim-check/flow-animation/build.py docs/claim-check-flow.svg`.
It draws the flow of `plugins/ech-claim-check/hooks/register.ts`; when that file changes, change the data at the top of `build.py` and rebuild.
`build.test.mjs` tests the generator: `node --test claim-check/flow-animation/build.test.mjs`.
