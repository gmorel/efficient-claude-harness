# errand/flow-animation

`build.py` builds the animated errand-router diagram, a script-free SVG: `python3 errand/flow-animation/build.py docs/errand-flow.svg`.
It follows the visual language of `ai-coder/flow-animation/` (Matrix look, rectangles for agents, ovals for models, square pulses) and shows a walk-through of the rule, not measured data.
`build.test.mjs` tests the generator and checks the figures it draws against `plugins/ech-errand`.
