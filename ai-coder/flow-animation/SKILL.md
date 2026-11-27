---
name: flow-animation
description: Build or change the animated delegation diagram for the marketing video. The main session sends all code to ai-coder, which asks Jev and uses ai-coder-average or ai-coder-high. Use when someone asks to regenerate, restyle or extend that animation. Not a plugin skill: it lives in this repository only.
---

# Delegation flow animation

One Python script builds one self-contained HTML page: inline SVG, SMIL pulses on curved links, and a Matrix look over falling green code.

## Build

```bash
python3 ai-coder/flow-animation/build.py /tmp/flow.html
```

For the main README, also write the script-free SVG:

```bash
python3 ai-coder/flow-animation/build.py /tmp/flow.html --svg docs/ai-coder-flow.svg
```

The SVG keeps the Matrix look, the rain, the pulses and the counters with SMIL only, because GitHub shows an SVG in an image tag without running scripts.
The counters there are an odometer that loops every 26 s.

Add `--sentence-divs <file.js>` only when the page is published as an Artifact and every sentence must sit in its own block.
The script uses the Python standard library and writes only the output file.

## What you edit

Everything is data near the top of `build.py`.

- `N` holds the nodes: name, centre, size, tag, two text lines.
- `BR` holds the model tier per node, drawn as one brain whose size shows the tier: tiny, small (haiku), medium (sonnet), large (opus).
- `EX` holds the theoretical saved-dollar counters.
- `paths` holds the links, drawn as cubic curves.
- The pulse list `P` holds who sends what, how long it takes and when it starts.

## Decisions already taken with the owner

- Agents are rectangles. Models (Jev, Cursor Composer, the delegation service, Codex) are ovals with the same dark background and a whitish border, a small mark on the left and a brain on the right.
- The marks are simple stand-ins, not the real logos. Replace them when the logo files exist.
- The orchestration: main sends all code to `ai-coder`, which asks Jev, which decides between `ai-coder-average` (Cursor Composer) and `ai-coder-high` (delegation service). Codex is used for reviews through the codex review agent. The claim sentinel observes the main session. `code-explorer` and `browser-qa` are direct delegates of main.
- Matrix is the default look. Boxes, tags and pulses are square there. Classic stays available behind the button.
- Pulses run at twice the first speed with an ease-in-out curve. The original dashboard uses 0.62 s and `keySplines="0.3 0 0.2 1"` in `plugins/ech/scripts/harness-dashboard/page.js`.
- The saved-dollar lines are theoretical, for the video. They start at 0.00 and each agent adds a fixed amount on its own timer. `ai-coder` shows the sum of its two children. They are not measured and there is no hook behind them.
- The figures on the nodes (runs, events) are sample figures copied from a dashboard screenshot, not live data.

## Checks before you publish

Look at the page in a browser. Two earlier mistakes were only visible there.

1. Serve the file from a local server and add `<meta charset="utf-8">` to the check copy. Without it the emoji and the dots render as garbage.
2. A pulse must stay hidden until its own begin time, or it sits at the top-left corner. The script hides each one and shows it with a `set` element.
3. Marks belong only to the nodes in `LOGO`. Check that no other node shows one.
4. Look at both looks, and at a narrow width: the diagram has a minimum width and scrolls sideways inside its frame.
5. Make sure no label is cut off by a tag or a brain.

## Limits

- The Matrix rain covers the visible width of the frame, not the scrolled part.
- A page with `prefers-reduced-motion` gets still pulses and no counters.
