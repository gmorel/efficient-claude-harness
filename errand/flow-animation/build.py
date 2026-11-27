#!/usr/bin/env python3
"""Builds the animated errand-router flow as one script-free SVG (SMIL only, Matrix look, falling green code).

Usage: python3 errand/flow-animation/build.py <out.svg>

It shows the real flow of plugins/ech-errand: read-only Bash/Read calls in the main thread go through the
PreToolUse hook errand-router, which counts errands in a row; from the 3rd it nudges toward the Haiku
code-explorer (warn), from the 5th it denies in block mode; code-explorer returns file:line; its result opens a
verify window of 8 errands that are never nudged. Jev is opt-in and drawn as off.
The loop is a walk-through of the rule with five errands, not measured data: there are no figures and no counters.
Everything you edit is data near the top: N (nodes), OVAL, paths and the timeline in story().
Python standard library only. Nothing is written outside <out.svg>.
"""
import sys
import random
from xml.sax.saxutils import escape

args = sys.argv[1:]
if not args or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n'); sys.exit(3)
OUT = args[0]

W, H = 960, 540
T = 18.0                       # one loop of the story, in seconds
EASE = '0.45 0 0.55 1'         # same ease-in-out as ai-coder's pulses

# Rectangles are agents (and the hook, the modes panel, the ledger file).
# key: (name, cx, cy, w, h, pill or None, lines, active)
N = {
 'main':  ('main thread',   120, 200, 200, 70,  None,         ['Bash and Read calls', 'each turn re-reads the chat'], True),
 'hook':  ('errand-router', 450, 205, 240, 130, 'PreToolUse', ['hook on Bash|Read, main thread', 'regex: a read-only errand?'], True),
 'modes': ('modes',         795, 205, 250, 130, 'warn',       ['warn (default): 3rd+ nudged', 'block: 3rd, 4th warn; 5th+ denied', 'off: ERRAND_ROUTER=off, off file', 'enforce project: block, no holdout'], False),
 'expl':  ('code-explorer', 120, 420, 200, 84,  None,         ['returns file:line only', 'at most 15 lines, no prose', 'its own calls: never routed'], True),
 'ledger':('ledger',        795, 420, 250, 70,  'file',       ['errand-router.jsonl, data dir', 'one line per Bash/Read call'], False),
}
# Ovals are models. key: (name, cx, cy, w, h, brain tier or None, off)
OVAL = {
 'haiku': ('Haiku', 360, 420, 130, 48, 1, False),
 'jev':   ('Jev',   450,  60, 170, 50, None, True),
}
BRAIN = {0: 7, 1: 10, 2: 14, 3: 18}   # tiny, haiku, sonnet, opus: the same scale as ai-coder

paths = {
 'p-err':    'M 220 188 C 262 172, 288 172, 330 188',
 'p-nudge':  'M 220 214 C 262 232, 288 232, 330 214',
 'p-jev':    'M 450 140 L 450 85',
 'p-mode':   'M 570 205 L 670 205',
 'p-ledger': 'M 520 270 C 560 360, 620 420, 670 420',
 'p-expl':   'M 120 235 C 108 290, 108 330, 120 378',
 'p-haiku':  'M 220 420 L 295 420',
}
IDLE = {'p-jev'}   # off by default: dashed, no pulse ever runs on it


def show(intervals):
    """Discrete opacity over one loop: visible during each (start, end) interval, in seconds."""
    pts = [(0.0, 0)]
    for a, b in sorted(intervals):
        if a <= 0: pts[0] = (0.0, 1)
        else: pts.append((a, 1))
        if b < T: pts.append((b, 0))
    kt = ';'.join(f'{a / T:.4f}' for a, _ in pts)
    vals = ';'.join(str(v) for _, v in pts)
    return f'<animate attributeName="opacity" values="{vals}" keyTimes="{kt}" calcMode="discrete" dur="{T}s" repeatCount="indefinite"/>'


def label(x, y, text, intervals, cls='mute', anchor='start', size=10):
    return (f'<text class="{cls}" x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" opacity="0">'
            f'{escape(text)}{show(intervals)}</text>')


def pulse(path, begin, flight, kind, rev=False):
    """A square pulse that waits hidden until `begin`, flies along `path` for `flight` s, then waits for the next loop."""
    f = flight / T
    kp = '1;0;0' if rev else '0;1;1'
    out = []
    for i, (r, op, cls) in enumerate([(10, 1, 'halo'), (4.2, 1, 'dot'), (3.2, .55, 'dot'), (2.4, .3, 'dot')]):
        b0 = begin + max(0, i - 1) * 0.06
        out.append(
            f'<g visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
            f'<g><animateMotion dur="{T}s" begin="{b0:.2f}s" repeatCount="indefinite" keyPoints="{kp}" keyTimes="0;{f:.4f};1" '
            f'keySplines="{EASE};0 0 1 1" calcMode="spline"><mpath href="#{path}"/></animateMotion>'
            f'<animate attributeName="opacity" values="1;0" keyTimes="0;{f:.4f}" calcMode="discrete" dur="{T}s" begin="{b0:.2f}s" repeatCount="indefinite"/>'
            f'<rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}" opacity="{op}"/></g></g>')
    return ''.join(out)


def node(k):
    name, cx, cy, w, h, pill, lines, active = N[k]
    x, y = cx - w / 2, cy - h / 2
    ring = f'<rect class="ring" x="{x}" y="{y}" width="{w}" height="{h}" style="animation-delay:{(sum(map(ord, k)) % 14) / 10:.1f}s"/>' if active else ''
    tag = ''
    if pill:
        pw = round(10 + len(pill) * 6.2)
        px = x + w - pw - 8
        tag = (f'<rect class="pill" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
               f'<text class="pilltxt" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{escape(pill)}</text>')
    body = ''.join(f'<text class="mute" x="{x + 11}" y="{y + 40 + 15 * i}" font-size="10">{escape(t)}</text>' for i, t in enumerate(lines))
    return (f'<g>{ring}<rect class="node" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text x="{x + 11}" y="{y + 21}" font-size="12.5" font-weight="700">{escape(name)}</text>{tag}{body}</g>')


def oval(k):
    name, cx, cy, w, h, tier, off = OVAL[k]
    ring = '' if off else f'<ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
    brain = (f'<text class="br" x="{cx + w / 2 - 22}" y="{cy + 5}" text-anchor="middle" font-size="{BRAIN[tier]}">{chr(0x1F9E0)}</text>'
             if tier is not None else '')
    return (f'<g>{ring}<ellipse class="oval{" off" if off else ""}" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<text class="nm" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{escape(name)}</text>{brain}</g>')


def story():
    """Five errands in a row, the nudges, the hand-off to code-explorer and the verify window. Returns (pulses, labels)."""
    P, L = [], []
    hx, hy = N['hook'][1] - N['hook'][3] / 2 + 11, N['hook'][2] - N['hook'][4] / 2
    cmds = ['Read', 'grep -rn', 'git log', 'sed -n', 'rg']          # all classified as errands by classify()
    said = ['counted, nothing shown', 'counted, nothing shown', 'nudge toward code-explorer',
            'nudge toward code-explorer', 'warn: nudge; block: denied']
    gap, t0 = 2.2, 0.4
    ts = [t0 + i * gap for i in range(5)]
    for i, t in enumerate(ts):
        nxt = ts[i + 1] if i < 4 else t + gap
        P.append(pulse('p-err', t, 0.8, 'brief'))                     # the errand reaches the hook
        P.append(pulse('p-ledger', t + 0.9, 0.8, 'ask'))              # one ledger line per call
        L.append(label(275, 166, cmds[i], [(t, nxt)], cls='cmd', anchor='middle'))
        L.append(label(hx, hy + 88, f'errands in a row: {i + 1}', [(t + 0.8, nxt + 0.8 if i < 4 else 11.6)], cls='live'))
        end = nxt + 0.8 if i < 4 else 14.8
        L.append(label(hx, hy + 104, said[i], [(t + 0.8, end)], cls='live' if i < 2 else 'warn'))
        if i >= 2:
            P.append(pulse('p-nudge', t + 0.9, 0.8, 'patch', rev=True))   # additionalContext back to main
    # hand the rest of the run to code-explorer, which runs on Haiku and returns file:line
    P.append(pulse('p-expl', 11.2, 1.0, 'brief'))
    P.append(pulse('p-haiku', 12.3, 0.6, 'brief'))
    P.append(pulse('p-haiku', 13.0, 0.6, 'patch', rev=True))
    P.append(pulse('p-expl', 13.8, 1.0, 'patch', rev=True))
    L.append(label(128, 312, 'where is X?', [(11.2, 13.8)], cls='cmd'))
    L.append(label(128, 312, 'file:line', [(13.8, 17.6)], cls='warn'))
    L.append(label(hx, hy + 88, 'another tool ran: run resets', [(11.6, T), (0, ts[0] + 0.8)], cls='live'))
    L.append(label(hx, hy + 104, 'verify window: next 8 not nudged', [(14.8, T)], cls='live'))
    return P, L


def rain():
    rnd = random.Random(7)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    out = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        out += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 {H + 40}" dur="{dur:.1f}s" '
                f'begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    return out


CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--off:#1f7a38;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.live{fill:var(--ink);font-weight:700}.warn{fill:var(--patch);font-weight:700}.cmd{fill:var(--ask);font-weight:700}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.oval.off{stroke:var(--off);stroke-dasharray:4 3;filter:none}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke-dasharray:3 5}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}.dot.ask,.halo.ask{fill:var(--ask)}
.halo{opacity:.35}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}
.br{filter:grayscale(1) sepia(1) hue-rotate(60deg) saturate(4)}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
"""


def build():
    P, L = story()
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
    links = ''.join(f'<use href="#{k}" class="link{" idle" if k in IDLE else ""}"/>' for k in paths)
    nodes = ''.join(node(k) for k in N) + ''.join(oval(k) for k in OVAL)
    hook_holdout = (f'<text class="mute" x="{N["hook"][1] - N["hook"][3] / 2 + 11}" y="{N["hook"][2] + N["hook"][4] / 2 - 8}" '
                    f'font-size="9.5">half the sessions: silent control</text>')
    static = (
        '<text class="nm" x="20" y="30" font-size="14">ech-errand: the errand router</text>'
        '<text class="mute" x="552" y="50" font-size="10">opt-in: ERRAND_ROUTER_JEV=1</text>'
        '<text class="mute" x="552" y="64" font-size="10">Jev picks the lane; nudges</text>'
        '<text class="mute" x="552" y="78" font-size="10">only at confidence 0.80 or more</text>'
        '<text class="mute" x="275" y="248" font-size="10" text-anchor="middle">nudge</text>'
        '<text class="mute" x="20" y="506" font-size="10">green: tool call · amber: nudge or result back · white: ledger line · dashed: off by default</text>'
        '<text class="mute" x="20" y="522" font-size="10">A walk-through of the rule with five errands in a row, not measured data. A subagent\'s calls are never routed.</text>'
    )
    title = 'ech-errand: read-only errands in the main thread, the errand-router hook and code-explorer'
    desc = ('The main thread runs read-only Bash and Read calls. The PreToolUse hook errand-router classifies each call with a regex '
            'and counts errands in a row; a user prompt, another tool or a non-errand call resets the run. The 1st and 2nd are only counted. '
            'From the 3rd it nudges toward the Haiku code-explorer; in block mode, and in an enforce project, the 5th and later are denied. '
            'Half the sessions are a silent control group. code-explorer returns file:line only, and its result opens a verify window '
            'of 8 errands that are never nudged. Every call adds one ledger line. Jev is opt-in and off by default.')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
           f'<title id="t">{escape(title)}</title><desc id="d">{escape(desc)}</desc>'
           f'<style>{CSS}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
           f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{links}{nodes}{hook_holdout}{static}'
           f'<g>{"".join(L)}</g><g>{"".join(P)}</g></svg>\n')
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(svg)
    print(len(svg))


build()
