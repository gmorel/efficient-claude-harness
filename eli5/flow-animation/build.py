#!/usr/bin/env python3
"""Builds the animated ELI5 flow as one script-free SVG: SMIL pulses on curved links, a Matrix look over falling green code.

Usage: python3 eli5/flow-animation/build.py <out.svg>

The flow is the real one of plugins/ech-eli5: the output style ELI5 shapes every reply, the card-guard Stop hook checks
that the final reply is one blockquote card, a fault goes to the ledger, and in block mode a refused reply is sent back
to be written again, once. The hook is off unless CARD_GUARD is set. There are no figures and no counters on purpose.
Everything you edit is data near the top: N (nodes), OVAL (models), paths, LABELS and the pulse list P.
Python standard library only. Nothing is written outside <out.svg>.
"""
import random
import sys

args = sys.argv[1:]
if len(args) != 1 or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n'); sys.exit(3)
OUT = args[0]

# key: (name, cx, cy, w, h, tag, line1, line2). Rectangles are parts of the flow, ovals are models.
N = {
 'you':    ('you',               95, 260, 150, 70, '',            'send a prompt',         'read one card'),
 'style':  ('output style ELI5', 330,  95, 200, 70, 'style',       'plain words, one idea', 'reply = one card'),
 'claude': ('Claude',            330, 260, 170, 56, '',            '',                      ''),
 'switch': ('CARD_GUARD',        600,  95, 180, 70, 'unset = off', 'log · block · strict',  'unset: exit, read nothing'),
 'guard':  ('card-guard',        600, 260, 180, 78, 'Stop hook',   'is it one card?',       'always exits 0'),
 'ledger': ('card-guard.jsonl',  850, 260, 170, 70, '',            'every fault, one line', 'log · block · strict'),
}
OVAL = {'claude'}
IDLE = {'switch'}   # dashed: the switch is unset by default, so the hook does nothing

paths = {
 'p-ask':   'M 170 255 L 245 255',
 'p-style': 'M 330 130 L 330 232',
 'p-reply': 'M 415 250 C 450 238, 475 238, 510 250',
 'p-sw':    'M 600 130 L 600 221',
 'p-log':   'M 690 260 L 765 260',
 'p-block': 'M 560 299 C 540 350, 400 350, 360 287',
 'p-shown': 'M 650 299 C 650 445, 95 445, 95 295',
}
IDLE_LINKS = {'p-sw'}

# (x, y, text, anchor)
LABELS = [
 (340, 186, 'shapes every reply', 'start'),
 (462, 228, 'final reply', 'middle'),
 (608, 180, 'set it to switch on', 'start'),
 (727, 250, 'fault', 'middle'),
 (460, 360, 'block: write it again, once', 'middle'),
 (372, 432, 'the reply is shown to you', 'middle'),
]


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def tag(x, y, w, text, idle):
    pw = round(10 + len(text) * 5.8)
    px = x + w - pw - 8
    off = ' off' if idle else ''
    return (f'<rect class="pill{off}" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
            f'<text class="pilltxt{off}" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{esc(text)}</text>')


def node(k):
    name, cx, cy, w, h, t, l1, l2 = N[k]
    delay = f'{(sum(map(ord, k)) % 14) / 10:.1f}'
    if k in OVAL:
        return (f'<g><ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}" style="animation-delay:{delay}s"/>'
                f'<ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
                f'<text class="nm" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{esc(name)}</text></g>')
    x, y = cx - w / 2, cy - h / 2
    idle = k in IDLE
    ring = '' if idle else f'<rect class="ring" x="{x}" y="{y}" width="{w}" height="{h}" style="animation-delay:{delay}s"/>'
    return (f'<g>{ring}<rect class="node{" off" if idle else ""}" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text class="nm" x="{x + 11}" y="{y + 21}">{esc(name)}</text>{tag(x, y, w, t, idle) if t else ""}'
            f'<text class="mute" x="{x + 11}" y="{y + 42}">{esc(l1)}</text>'
            f'<text class="mute" x="{x + 11}" y="{y + 57}">{esc(l2)}</text></g>')


def pulse(path, dur, begin, kind):
    """A square pulse with a short tail and a halo. It stays hidden until its own begin time."""
    dur, begin = dur / 2, begin / 2   # same speed as the ai-coder flow
    ease = 'keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.55 1" calcMode="spline"'
    out = []
    for r, op, b0, cls in [(4.2, 1, begin, 'dot'), (3.2, .55, begin + .06, 'dot'), (2.4, .3, begin + .12, 'dot'), (10, 1, begin, 'halo')]:
        out.append(f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
                   f'<animateMotion dur="{dur}s" begin="{b0:.2f}s" repeatCount="indefinite" {ease}><mpath href="#{path}"/></animateMotion>'
                   f'<rect class="{cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g>')
    return ''.join(out)


# who sends what: a prompt and a reply (green), a fault to the ledger (amber), a refusal sent back (red)
P = [pulse('p-ask', 1.6, 0.0, 'reply'),
     pulse('p-style', 2.0, 0.4, 'style'),
     pulse('p-reply', 1.8, 1.2, 'reply'),
     pulse('p-log', 1.6, 2.4, 'fault'),
     pulse('p-block', 2.6, 3.0, 'block'),
     pulse('p-shown', 4.2, 2.0, 'reply')]

glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
rnd = random.Random(7)
rain = ''
for c in range(40):
    x = 6 + c * 24
    dur = rnd.uniform(7, 15)
    chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
    rain += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
             f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 560" dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')

legend = [
 (20, 478, 'reply', 'reply', 'prompt and reply'),
 (190, 478, 'style', 'style', 'the style shapes it'),
 (380, 478, 'fault', 'fault', 'fault logged'),
 (540, 478, 'block', 'block', 'block: rewrite, once'),
]
leg = '<rect x="0" y="462" width="960" height="58" fill="#000" opacity=".82"/>'
leg += ''.join(f'<rect class="dot {k}" x="{x}" y="{y - 8}" width="9" height="9"/><text class="mute" x="{x + 15}" y="{y}">{t}</text>' for x, y, k, _, t in legend)
leg += '<text class="mute" x="740" y="478">rectangle = part, oval = model</text>'
leg += ('<text class="mute" x="20" y="500">CARD_GUARD unset (default): the hook exits before it reads anything. log: ledger only, never refuses.</text>'
        '<text class="mute" x="20" y="514">block: refuses a reply with a line outside the quote, or HTML. strict: refuses every fault.</text>')

css = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--reply:#00ff41;--style:#d8ffe0;--fault:#ffd166;--block:#ff5c5c;--off:#1f7a38;--off-bg:#061a0b;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink);font-size:10px}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.lbl{fill:var(--mute);font-size:9.5px}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.node.off{stroke:var(--off);stroke-dasharray:4 3;filter:none}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}.pill.off{fill:var(--off-bg);stroke:var(--off)}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}.pilltxt.off{fill:var(--off)}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke-dasharray:3 5}
.dot.reply,.halo.reply{fill:var(--reply)}.dot.style,.halo.style{fill:var(--style)}.dot.fault,.halo.fault{fill:var(--fault)}.dot.block,.halo.block{fill:var(--block)}
.halo{opacity:.35}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
"""

defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
links = ''.join(f'<use href="#{k}" class="link{" idle" if k in IDLE_LINKS else ""}"/>' for k in paths)
labels = ''.join(f'<text class="lbl" x="{x}" y="{y}" text-anchor="{a}">{esc(t)}</text>' for x, y, t, a in LABELS)
nodes = ''.join(node(k) for k in N)
svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 520" width="960" height="520" role="img" aria-labelledby="t d">'
       '<title id="t">The ELI5 output style and the card-guard Stop hook</title>'
       '<desc id="d">You send a prompt to Claude. The output style ELI5 shapes every reply into one blockquote card. '
       'When CARD_GUARD is set, the card-guard Stop hook checks that the final reply is one card. '
       'In log mode a fault goes to the card-guard.jsonl ledger and the reply is shown. '
       'In block mode a reply that is not a card at all is sent back to be written again, once. '
       'CARD_GUARD is unset by default, and then the hook does nothing.</desc>'
       f'<style>{css}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
       f'<rect width="960" height="520" fill="#000"/><g>{rain}</g>{links}{labels}{nodes}<g>{"".join(P)}</g>{leg}</svg>')
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(svg)
print(len(svg))
