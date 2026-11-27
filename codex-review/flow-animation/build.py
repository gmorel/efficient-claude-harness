#!/usr/bin/env python3
"""Builds the animated review flow of the ech-codex-review plugin: one script-free SVG (SMIL only, a Matrix look).

Usage: python3 codex-review/flow-animation/build.py <out.svg>

Everything you edit is data near the top: N (nodes), OVAL (which nodes are models), HAIKU (agents whose
frontmatter says `model: haiku`), NOTES (the side notes), paths and the pulse list P.
Every label is checked against plugins/ech-codex-review: the agents, the skills, the scripts and the README.
There are no figures on the nodes and no counters: the plugin measures nothing, so the diagram shows nothing measured.
Python standard library only. Nothing is written outside <out.svg>.
"""
import random
import sys
from xml.sax.saxutils import escape

args = sys.argv[1:]
if not args or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n')
    sys.exit(3)
OUT = args[0]

W, H = 960, 520

# key: (name, cx, cy, w, h, tag, line1, line2, line3)
N = {
    'main':  ('main session',             120, 190, 210, 66, '',          'asks for one review',            'verifies each finding',          ''),
    'skill': ('codex-first-pr-review',    125, 430, 230, 78, 'skill',     'step 1: Codex reads the diff',   'step 2: a fresh check',          'step 3: the verdict'),
    'astra': ('delegate-to-openai-astra', 405,  75, 270, 62, 'ADVISORY',  'only when the user names Astra', 'astra.mjs refuses --write',      ''),
    'plan':  ('openai-gpt-plan-reviewer', 405, 155, 270, 62, 'ADVISORY',  'a written plan, irreversible work', 'returns the critique verbatim', ''),
    'diff':  ('openai-gpt-diff-reviewer', 405, 235, 270, 62, 'ADVISORY',  'a diff, after the normal review', 'returns findings verbatim',     ''),
    'sol':   ('sol-reviewer',             405, 315, 270, 62, 'ADVISORY',  'the diff as a file, never a tree', 'returns findings verbatim',     ''),
    'fresh': ('fresh reviewer',           680, 430, 220, 78, 'read-only', 'no memory of step 1',            "checks only Codex's findings",   'and the project invariants'),
    'gpt':   ('GPT-6-Astra',              695,  75, 170, 50, '',          'codex exec, sandbox read-only',  '',                               ''),
    'codex': ('Codex',                    695, 235, 150, 56, '',          'codex plugin, never --write',    '',                               ''),
}
OVAL = {'gpt', 'codex'}                                # models
HAIKU = {'astra', 'plan', 'diff', 'sol'}               # agents/*.md say `model: haiku`; the others name no model
NOTES = [  # (x, y, lines, class)
    (785, 120, ['findings return verbatim,', 'labelled ADVISORY:', 'a reason to re-examine,', 'never to change code', 'on its own'], 'note'),
    (785, 300, ['Codex down or timed out:', '"WITHOUT cross-model pass"', 'stamped, never silent'], 'note'),
    (802, 410, ['CLEAR or NOT CLEAR,', 'kept + dropped findings,', 'what was not run;', 'no push, no merge,', 'no comment'], 'note'),
]

paths = {
    'p-astra': 'M 225 172 C 250 150, 245 75, 270 75',
    'p-plan':  'M 225 180 C 250 170, 245 155, 270 155',
    'p-diff':  'M 225 200 C 250 210, 245 235, 270 235',
    'p-sol':   'M 225 208 C 250 230, 245 315, 270 315',
    'p-gpt':   'M 540 75 L 610 75',
    'p-cplan': 'M 540 155 C 575 160, 590 225, 620 230',
    'p-cdiff': 'M 540 235 L 620 235',
    'p-csol':  'M 540 315 C 575 310, 590 245, 620 240',
    'p-skill': 'M 120 223 L 120 391',
    'p-ssol':  'M 240 405 C 258 385, 250 330, 270 322',
    'p-fresh': 'M 240 448 C 360 466, 450 466, 570 448',
}
LINK_LABELS = [  # (x, y, text)
    (402, 478, "Codex's findings verbatim, the changed files, the invariants"),
    (96, 315, 'invokes'),
]


def pulse(path, dur, begin, kind, rev=False):
    """One square pulse with a short trail and a halo, hidden until its own begin time."""
    dur, begin = dur / 2, begin / 2
    ease = 'keyTimes="0;1" keySplines="0.45 0 0.55 1" calcMode="spline"'
    kp = f' keyPoints="1;0" {ease}' if rev else f' keyPoints="0;1" {ease}'
    out = []
    for i, (r, op, cls) in enumerate([(4.2, 1, 'dot'), (3.2, .55, 'dot'), (2.4, .3, 'dot'), (10, 1, 'halo')]):
        b0 = begin + (i * 0.06 if cls == 'dot' else 0)
        out.append(f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
                   f'<animateMotion dur="{dur}s" begin="{b0:.2f}s" repeatCount="indefinite"{kp}><mpath href="#{path}"/></animateMotion>'
                   f'<rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g>')
    return ''.join(out)


# brief = the request goes out (green), patch = findings come back (amber). Begins are staggered to read as a sequence.
P = [
    pulse('p-astra', 2.6, 0.2, 'brief'), pulse('p-astra', 3.0, 2.0, 'patch', True),
    pulse('p-plan', 2.4, 0.6, 'brief'), pulse('p-plan', 2.8, 2.4, 'patch', True),
    pulse('p-diff', 2.4, 1.0, 'brief'), pulse('p-diff', 2.8, 2.8, 'patch', True),
    pulse('p-sol', 2.6, 1.4, 'brief'), pulse('p-sol', 3.0, 3.2, 'patch', True),
    pulse('p-gpt', 1.6, 0.9, 'brief'), pulse('p-gpt', 2.0, 1.8, 'patch', True),
    pulse('p-cplan', 1.8, 1.3, 'brief'), pulse('p-cplan', 2.2, 2.2, 'patch', True),
    pulse('p-cdiff', 1.6, 1.7, 'brief'), pulse('p-cdiff', 2.0, 2.6, 'patch', True),
    pulse('p-csol', 1.8, 2.1, 'brief'), pulse('p-csol', 2.2, 3.0, 'patch', True),
    pulse('p-skill', 2.4, 0.4, 'brief'), pulse('p-skill', 2.8, 4.4, 'patch', True),
    pulse('p-ssol', 2.0, 1.2, 'brief'), pulse('p-ssol', 2.4, 3.0, 'patch', True),
    pulse('p-fresh', 3.2, 3.4, 'brief'), pulse('p-fresh', 3.6, 4.8, 'patch', True),
]


def ring(k, x, y, w, h, shape):
    """A SMIL pulse ring around a node: it grows a little and fades, every 3 s."""
    delay = (sum(map(ord, k)) % 14) / 10
    anim = (f'<animate attributeName="opacity" values=".5;0" dur="3s" begin="{delay:.1f}s" repeatCount="indefinite"/>'
            f'<animateTransform attributeName="transform" type="scale" values="1 1;1.06 1.16" dur="3s" begin="{delay:.1f}s" repeatCount="indefinite"/>')
    if shape == 'oval':
        el = f'<ellipse class="ring" cx="0" cy="0" rx="{w / 2}" ry="{h / 2}" opacity="0">{anim}</ellipse>'
    else:
        el = f'<rect class="ring" x="{-w / 2}" y="{-h / 2}" width="{w}" height="{h}" opacity="0">{anim}</rect>'
    return f'<g transform="translate({x} {y})">{el}</g>'


def oval(k):
    name, cx, cy, w, h, tag, l1, l2, l3 = N[k]
    return (f'<g>{ring(k, cx, cy, w, h, "oval")}<ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<text class="nm" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{escape(name)}</text>'
            f'<text class="mute dim" x="{cx}" y="{cy + h / 2 + 15}" text-anchor="middle">{escape(l1)}</text></g>')


def node(k):
    if k in OVAL:
        return oval(k)
    name, cx, cy, w, h, tag, l1, l2, l3 = N[k]
    x, y = cx - w / 2, cy - h / 2
    pill = ''
    if tag:
        pw = round(10 + len(tag) * 6)
        px = x + w - pw - 8
        pill = (f'<rect class="pill" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
                f'<text class="pilltxt" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{escape(tag)}</text>')
    lines = ''.join(f'<text class="mute dim" x="{x + 11}" y="{y + 40 + 14 * i}">{escape(t)}</text>' for i, t in enumerate((l1, l2, l3)) if t)
    brain = f'<text x="{x + w - 9}" y="{y + h - 7}" text-anchor="end" font-size="10">{chr(0x1F9E0)}</text>' if k in HAIKU else ''
    return (f'<g>{ring(k, cx, cy, w, h, "rect")}<rect class="node" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text class="nm" x="{x + 11}" y="{y + 21}">{escape(name)}</text>{pill}{lines}{brain}</g>')


def rain():
    rnd = random.Random(7)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    out = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        out += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 {H + 40}" dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    return out


CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.dim{font-size:10px}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}
.link{fill:none;stroke:var(--line);stroke-width:1.3}
.lbl{font-size:9.5px;fill:var(--mute)}
.note{font-size:10px;fill:var(--ink)}
.banner{font-size:12px;font-weight:700;fill:var(--ok)}
.legend{font-size:9.5px;fill:var(--mute)}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}
.halo{opacity:.35}
.panel{fill:#000;opacity:.82}
"""

ORDER = ['gpt', 'codex', 'astra', 'plan', 'diff', 'sol', 'fresh', 'skill', 'main']


def build():
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
    links = ''.join(f'<use href="#{k}" class="link"/>' for k in paths)
    labels = ''.join(f'<rect class="panel" x="{x - len(t) * 2.9 - 4}" y="{y - 10}" width="{len(t) * 5.8 + 8}" height="13"/>' for x, y, t in LINK_LABELS)
    labels += ''.join(f'<text class="lbl" x="{x}" y="{y}" text-anchor="middle">{escape(t)}</text>' for x, y, t in LINK_LABELS)
    notes = ''
    for x, y, lines, cls in NOTES:
        notes += f'<rect class="panel" x="{x - 6}" y="{y - 13}" width="{966 - x}" height="{14 * len(lines) + 8}"/>'
        notes += ''.join(f'<text class="{cls}" x="{x}" y="{y + 14 * i}">{escape(t)}</text>' for i, t in enumerate(lines))
    banner = '<rect class="panel" x="0" y="0" width="960" height="34"/><text class="banner" x="20" y="24">ech-codex-review · READ-ONLY: no --write, no codex-rescue, no transfer</text>'
    legend = (f'<rect class="panel" x="0" y="{H - 26}" width="960" height="26"/><text class="legend" x="20" y="{H - 12}">rectangle = agent or step · oval = model · green = request goes out · '
              f'amber = findings come back · {chr(0x1F9E0)} = model: haiku</text>')
    nodes = ''.join(node(k) for k in ORDER)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 520" width="960" height="520" role="img" aria-labelledby="t d">'
            '<title id="t">ech-codex-review: read-only cross-model review through Codex</title>'
            '<desc id="d">The main session asks sol-reviewer, openai-gpt-diff-reviewer or openai-gpt-plan-reviewer for a review. '
            'Each forwards the diff or the plan to Codex and returns the findings verbatim, labelled ADVISORY. '
            'delegate-to-openai-astra forwards one task to GPT-6-Astra, only when the user names Astra. '
            "The codex-first-pr-review skill has Codex read the diff first through sol-reviewer, then a fresh reviewer checks only Codex's findings and the project invariants, "
            'and returns CLEAR or NOT CLEAR. Nothing in the plugin writes: no --write, no codex-rescue, no transfer.</desc>'
            f'<style>{CSS}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
            f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{banner}{links}{labels}{nodes}{notes}<g>{"".join(P)}</g>{legend}</svg>')


svg = build()
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(svg)
print(len(svg))
