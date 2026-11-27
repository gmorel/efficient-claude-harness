#!/usr/bin/env python3
"""Builds the animated pre-post-mortem flow: one script-free SVG (SMIL pulses on curved links, a Matrix look over falling green code).

Usage: python3 pre-postmortem/flow-animation/build.py <out.svg>

Everything you edit is data near the top: N (nodes), OVAL (models), paths and the pulse list P.
The steps are the ones in plugins/ech-pre-postmortem/agents/pre-post-mortem.md and commands/pre-post-mortem.md; there are no figures and no counters.
The same visual language as ai-coder/flow-animation/build.py: agents and steps are rectangles, models are ovals, pulses are square.
Python standard library only. Nothing is written outside <out.svg>. The rain uses a fixed seed, so the same input gives the same file.
"""
import random
import sys

args = sys.argv[1:]
if not args or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n')
    sys.exit(3)
OUT = args[0]

W, H = 960, 520
# key: (name, cx, cy, w, h, kind, lines); kind is node, warn (the closing output) or in (the input)
N = {
 'change': ('risky change',          95, 260, 160, 70, 'in',   ['prod write, migration', 'destructive, live API']),
 'agent':  ('pre-post-mortem agent', 330, 150, 210, 76, 'node', ['reads the repo first', 'advises, never commits']),
 'cmd':    ('pre-post-mortem command', 330, 370, 210, 76, 'node', ['the session runs it', 'on its own work']),
 'opus':   ('opus',                  330,  40, 170, 50, 'oval', ['effort xhigh']),
 'failed': ('it already failed',     580,  90, 190, 76, 'node', ['weeks from now, in prod', 'work back to the causes']),
 'trace':  ('trace each cause',      830,  90, 190, 76, 'node', ['next: weeks out', 'left behind: months out']),
 'gaps':   ('3 ways it is incomplete', 830, 260, 200, 82, 'node', ['a class not considered', 'an unchecked assumption', 'a part inferred, not read']),
 'attack': ('attack the analysis',   580, 260, 190, 76, 'node', ['find the flaws', 'close the gaps, revise']),
 'watch':  ('WATCH FOR THIS ONE',    700, 440, 280, 82, 'warn', ['the risk most likely dismissed', 'or found too late, and why', 'agent adds: go / no-go']),
}
TAG = {'change': 'input', 'watch': 'output'}
BRAIN = {'opus', 'agent'}          # both run on opus; the command runs on whatever model the session uses, so it has none

paths = {
 'p-agent':  'M 175 248 C 205 248, 195 150, 225 150',
 'p-cmd':    'M 175 272 C 205 272, 195 370, 225 370',
 'p-opus':   'M 330 112 C 340 95, 340 82, 330 65',
 'p-f1':     'M 435 145 C 460 145, 460 82, 485 82',
 'p-f2':     'M 435 365 C 470 365, 452 100, 485 100',
 'p-trace':  'M 675 90 C 700 78, 710 78, 735 90',
 'p-gaps':   'M 830 128 C 852 155, 852 192, 830 219',
 'p-attack': 'M 730 260 C 712 248, 693 248, 675 260',
 'p-revise': 'M 560 222 C 540 195, 540 155, 560 128',
 'p-watch':  'M 580 298 C 580 350, 650 350, 650 399',
}
IDLE = {'p-revise'}                # the revise loop is drawn dashed: it runs only when the attack finds a flaw


def node(k):
    name, cx, cy, w, h, kind, lines = N[k]
    if kind == 'oval':
        brain = f'<text class="br" x="{cx + w / 2 - 22}" y="{cy + 5}" text-anchor="middle" font-size="18">{chr(0x1F9E0)}</text>'
        return (f'<g><ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/><ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
                f'<text class="nm" x="{cx - 10}" y="{cy - 1}" text-anchor="middle">{name}</text>'
                f'<text class="mute dim" x="{cx - 10}" y="{cy + 13}" text-anchor="middle">{lines[0]}</text>{brain}</g>')
    x, y = cx - w / 2, cy - h / 2
    cls = {'node': 'node', 'warn': 'node warn', 'in': 'node in'}[kind]
    ring = f'<rect class="ring{" warn" if kind == "warn" else ""}" x="{x}" y="{y}" width="{w}" height="{h}" style="animation-delay:{(sum(map(ord, k)) % 14) / 10:.1f}s"/>'
    tag = ''
    if k in TAG:
        t = TAG[k]
        pw = round(10 + len(t) * 5.6)
        px = x + w - pw - 8
        tag = f'<rect class="pill" x="{px}" y="{y + 7}" width="{pw}" height="16"/><text class="pilltxt" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{t}</text>'
    text = ''.join(f'<text class="mute dim" x="{x + 11}" y="{y + 40 + 14 * i}">{l}</text>' for i, l in enumerate(lines))
    brain = f'<text class="br" x="{x + w - 9}" y="{y + h - 7}" text-anchor="end" font-size="18">{chr(0x1F9E0)}</text>' if k in BRAIN else ''
    return (f'<g>{ring}<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text class="nm{" hot" if kind == "warn" else ""}" x="{x + 11}" y="{y + 21}">{name}</text>{tag}{text}{brain}</g>')


def pulse(path, dur, begin, kind, rev=False):
    dur, begin = dur / 2, begin / 2   # the same doubled speed as ai-coder
    ease = 'keyTimes="0;1" keySplines="0.45 0 0.55 1" calcMode="spline"'
    kp = f' keyPoints="1;0" {ease}' if rev else f' keyPoints="0;1" {ease}'
    out = []

    def head(r, op, b0, cls):
        # hidden until its own begin time, or it sits at the top-left corner
        return (f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
                f'<animateMotion dur="{dur}s" begin="{b0:.2f}s" repeatCount="indefinite"{kp}><mpath href="#{path}"/></animateMotion>'
                f'<rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g>')
    for i, (r, op) in enumerate([(4.2, 1), (3.2, .55), (2.4, .3)]):
        out.append(head(r, op, begin + i * 0.06, 'dot'))
    out.append(head(10, 1, begin, 'halo'))
    return ''.join(out)


# green: the analysis moves on; amber: the revise loop and the closing warning; white: the agent and its model
P = [pulse('p-agent', 2.4, 0, 'brief'), pulse('p-cmd', 2.4, 1.2, 'brief'),
     pulse('p-opus', 1.6, 0.6, 'ask'), pulse('p-opus', 1.8, 1.4, 'ask', True),
     pulse('p-f1', 2.2, 0.8, 'brief'), pulse('p-f2', 2.6, 1.8, 'brief'),
     pulse('p-trace', 1.6, 1.2, 'brief'), pulse('p-gaps', 1.8, 1.6, 'brief'),
     pulse('p-attack', 1.6, 2.0, 'brief'), pulse('p-revise', 2.2, 2.4, 'patch'),
     pulse('p-watch', 2.4, 2.6, 'patch')]

CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.dim{font-size:10px}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}.nm.hot{fill:var(--patch)}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.node.warn{stroke:var(--patch);filter:drop-shadow(0 0 5px #b8860b)}
.node.in{stroke:var(--mute);stroke-dasharray:4 3;filter:none}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
.ring.warn{stroke:var(--patch)}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}
.br{filter:grayscale(1) sepia(1) hue-rotate(60deg) saturate(4)}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke-dasharray:3 5}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}.dot.ask,.halo.ask{fill:var(--ask)}
.halo{opacity:.35}
.lg{font-size:10px;fill:var(--mute)}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
"""


def rain():
    rnd = random.Random(7)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    out = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        out += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 560" dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    return out


def build():
    order = ['opus', 'change', 'agent', 'cmd', 'failed', 'trace', 'gaps', 'attack', 'watch']
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
    links = ''.join(f'<use href="#{k}" class="link{" idle" if k in IDLE else ""}"/>' for k in paths)
    labels = '<text class="lg" x="536" y="179" text-anchor="end">revise</text>'
    legend = ('<rect x="10" y="492" width="940" height="20" fill="#000" opacity=".85"/><text class="lg" x="20" y="506">green: the analysis moves on · amber: revise, and the closing warning · white: the agent and its model · oval = model, rectangle = agent or step</text>')
    desc = ('A risky change, such as a production write, a schema migration, a destructive script or a run against a live external system, goes to the pre-post-mortem agent, which runs on opus, '
            'or to the pre-post-mortem command, which the current session runs on its own work. '
            'Both imagine the change has already failed, trace each cause to what it causes next, weeks out, and what it leaves behind, months out, '
            'name three ways the analysis is incomplete, attack the analysis and revise it, and end with WATCH FOR THIS ONE: the risk most likely dismissed or found too late. '
            'The agent also ranks the causes, turns them into mitigations and gives a go or no-go.')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
            '<title id="t">Pre-post-mortem: imagine the change already failed, then work back</title>'
            f'<desc id="d">{desc}</desc>'
            f'<style>{CSS}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
            f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{links}{labels}{"".join(node(k) for k in order)}<g>{"".join(P)}</g>{legend}</svg>\n')


svg = build()
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(svg)
print(len(svg))
