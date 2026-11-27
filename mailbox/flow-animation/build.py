#!/usr/bin/env python3
"""Builds the animated mailbox flow: one script-free SVG (SMIL pulses on curved links, a Matrix look over falling green code).

Usage: python3 mailbox/flow-animation/build.py <out.svg>

Everything you edit is data near the top: N (nodes), OVAL (models), PATHS (links), LABELS and STORY (the pulses).
Every step of STORY comes from plugins/ech-mailbox/hooks/register.ts; there are no figures, counters or logos.
Python standard library only. Nothing is written outside <out.svg>.
"""
import random
import sys

args = sys.argv[1:]
if len(args) != 1 or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n')
    sys.exit(3)
OUT = args[0]

W, H = 960, 560
CYCLE = 26.0   # the whole story loops every 26 s

# key: (name, cx, cy, w, h, tag, lines). Agents and hooks are rectangles; tag '' draws no pill.
N = {
    'peer':   ('peer session', 105, 110, 170, 66, '', ['another Claude session', 'sends a message']),
    'gate':   ('receive hook', 335, 110, 180, 66, 'gate', ['starts with BLOCKING: ?', 'no: hold, yes: pass']),
    'digest': ('hourly digest', 590, 110, 180, 66, 'timer', ['every hour, if not empty', 'one turn with them all']),
    'box':    ('mailbox', 590, 270, 200, 80, 'held', ['not shown, not read', 'status: mailbox: N waiting', 'copy kept per session id']),
    'you':    ('you', 105, 410, 170, 66, '', ['type your next prompt', 'or type /mailbox']),
    'prompt': ('prompt hook', 335, 410, 180, 66, 'context', ['adds held messages', 'as context, box empties']),
    'cmd':    ('/mailbox', 590, 440, 200, 66, 'command', ['list, flush or clear', 'flush: one turn now']),
    'model':  ('the model', 850, 270, 170, 60, '', []),
}
OVAL = {'model'}
ORDER = ['peer', 'gate', 'digest', 'box', 'you', 'prompt', 'cmd', 'model']

PATHS = {
    'p-in':     'M 190 110 L 245 110',
    'p-block':  'M 335 77 C 335 20, 850 20, 850 240',
    'p-hold':   'M 335 143 C 335 230, 420 270, 490 270',
    'p-digin':  'M 590 230 L 590 143',
    'p-digout': 'M 680 110 C 740 110, 780 180, 790 249',
    'p-you':    'M 190 410 L 245 410',
    'p-join':   'M 490 290 C 440 300, 410 330, 400 377',
    'p-turn':   'M 425 415 C 520 360, 700 360, 820 296',
    'p-cmd':    'M 120 443 C 140 500, 420 470, 490 455',
    'p-list':   'M 590 407 L 590 310',
    'p-flush':  'M 690 440 C 780 440, 860 380, 860 300',
    'p-clear':  'M 690 462 L 745 488',
}
IDLE = {'p-clear'}

# (x, y, text) small captions next to the links
LABELS = [
    (590, 42, 'BLOCKING: passes at once'),
    (372, 232, 'held'),
    (735, 152, 'once an hour'),
    (440, 330, '+ held'),
    (640, 383, 'your prompt, held messages as context'),
    (300, 500, '/mailbox'),
    (842, 412, 'flush'),
    (770, 502, 'clear: dropped'),
]

# (path, start in the cycle, travel seconds, kind, reverse). kinds: msg = a peer message, block = BLOCKING:, you = your prompt or command.
STORY = [
    ('p-in', 0.0, 1.0, 'msg', False), ('p-hold', 1.0, 1.4, 'msg', False),
    ('p-in', 2.6, 1.0, 'block', False), ('p-block', 3.6, 2.2, 'block', False),
    ('p-in', 5.0, 1.0, 'msg', False), ('p-hold', 6.0, 1.4, 'msg', False),
    ('p-you', 8.0, 1.0, 'you', False), ('p-join', 8.2, 1.2, 'msg', False),
    ('p-turn', 9.4, 1.8, 'you', False), ('p-turn', 9.7, 1.8, 'msg', False),
    ('p-in', 11.6, 1.0, 'msg', False), ('p-hold', 12.6, 1.4, 'msg', False),
    ('p-digin', 14.2, 0.8, 'msg', False), ('p-digout', 15.0, 1.6, 'msg', False),
    ('p-in', 16.8, 1.0, 'msg', False), ('p-hold', 17.8, 1.4, 'msg', False),
    ('p-cmd', 19.4, 1.4, 'you', False), ('p-list', 20.8, 0.7, 'you', False), ('p-list', 21.5, 0.7, 'msg', True),
    ('p-flush', 22.4, 1.6, 'msg', False), ('p-clear', 24.2, 1.0, 'you', False),
]


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def rect_node(k):
    name, cx, cy, w, h, tag, lines = N[k]
    x, y = cx - w / 2, cy - h / 2
    delay = (sum(map(ord, k)) % 14) / 10
    out = [f'<g><rect class="ring" x="{x}" y="{y}" width="{w}" height="{h}" style="animation-delay:{delay:.1f}s"/>',
           f'<rect class="node" x="{x}" y="{y}" width="{w}" height="{h}"/>',
           f'<text class="nm" x="{x + 11}" y="{y + 21}">{esc(name)}</text>']
    if tag:
        pw = round(10 + len(tag) * 6.2)
        px = x + w - pw - 8
        out.append(f'<rect class="pill" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
                   f'<text class="pilltxt" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{esc(tag)}</text>')
    for i, line in enumerate(lines):
        out.append(f'<text class="mute" x="{x + 11}" y="{y + 40 + 14 * i}">{esc(line)}</text>')
    out.append('</g>')
    return ''.join(out)


def oval_node(k):
    name, cx, cy, w, h, _, _ = N[k]
    return (f'<g><ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<text class="nm" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{esc(name)}</text></g>')


def pulse(path, start, travel, kind, rev):
    """A square pulse that stays hidden until its begin time, travels once per cycle, then hides until the next cycle."""
    out = []
    for i, (r, op, cls) in enumerate([(10, 1, 'halo'), (4.2, 1, 'dot'), (3.2, .55, 'dot'), (2.4, .3, 'dot')]):
        b = start + max(0, i - 1) * 0.06
        f = travel / CYCLE
        kp = '1;0;0' if rev else '0;1;1'
        out.append(
            f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b:.2f}s" fill="freeze"/>'
            f'<g><animate attributeName="opacity" values="1;0" keyTimes="0;{f:.4f}" calcMode="discrete" dur="{CYCLE}s" begin="{b:.2f}s" repeatCount="indefinite"/>'
            f'<animateMotion dur="{CYCLE}s" begin="{b:.2f}s" repeatCount="indefinite" keyPoints="{kp}" keyTimes="0;{f:.4f};1" '
            f'calcMode="spline" keySplines="0.45 0 0.55 1;0 0 1 1"><mpath href="#{path}"/></animateMotion>'
            f'<rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g></g>')
    return ''.join(out)


def rain():
    rnd = random.Random(7)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    out = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        out += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 {H + 40}" '
                f'dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    return out


CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--msg:#00ff41;--block:#ffd166;--you:#d8ffe0;--off:#1f7a38;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink);font-size:10px}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}
.lbl{fill:var(--ink);font-size:10px;paint-order:stroke;stroke:#000;stroke-width:3px}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke-dasharray:3 5}
.msg{fill:var(--msg)}.block{fill:var(--block)}.you{fill:var(--you)}
.halo{opacity:.35}
.foot{fill:var(--mute);font-size:10.5px}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
"""


def build():
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in PATHS.items())
    links = ''.join(f'<use href="#{k}" class="link{" idle" if k in IDLE else ""}"/>' for k in PATHS)
    labels = ''.join(f'<text class="lbl" x="{x}" y="{y}" text-anchor="middle">{esc(t)}</text>' for x, y, t in LABELS)
    nodes = ''.join(oval_node(k) if k in OVAL else rect_node(k) for k in ORDER)
    pulses = ''.join(pulse(*p) for p in STORY)
    legend = ('<g>'
              f'<rect x="0" y="512" width="{W}" height="{H - 512}" fill="#000" opacity=".85"/>'
              '<rect class="msg" x="20" y="524" width="9" height="9"/><text class="foot" x="35" y="532">peer message</text>'
              '<rect class="block" x="150" y="524" width="9" height="9"/><text class="foot" x="165" y="532">BLOCKING: message</text>'
              '<rect class="you" x="310" y="524" width="9" height="9"/><text class="foot" x="325" y="532">your prompt or command</text>'
              '<text class="foot" x="510" y="532">rectangle = session or hook, oval = model</text>'
              '<text class="foot" x="20" y="550">Off by default: with enabled false the plugin registers no hook, and every message passes untouched.</text>'
              '</g>')
    title = 'ech-mailbox: peer messages wait in a mailbox, then join your next prompt or an hourly digest'
    desc = ('A message from another Claude session reaches the receive hook. '
            'If its text starts with BLOCKING: it passes at once to the model. '
            'Otherwise it is held in the mailbox, which the status line counts. '
            'Your next typed prompt carries the held messages as context and empties the mailbox. '
            'Once an hour, a non-empty mailbox goes out as one digest turn. '
            '/mailbox lists the messages, /mailbox flush sends them now as one turn, /mailbox clear drops them. '
            'The plugin is off by default.')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
            f'<title id="t">{esc(title)}</title><desc id="d">{esc(desc)}</desc>'
            f'<style>{CSS}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
            f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{links}{labels}{nodes}<g>{pulses}</g>{legend}</svg>')


svg = build()
with open(OUT, 'w', encoding='utf-8') as fh:
    fh.write(svg)
print(len(svg))
