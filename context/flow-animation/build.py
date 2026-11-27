#!/usr/bin/env python3
"""Builds the animated flow of the ech-context plugin: one script-free SVG, SMIL only, Matrix look over falling green code.

Usage: python3 context/flow-animation/build.py <out.svg>

Everything you edit is data near the top: N (nodes), OVAL (the two model steps), PATHS (the curved links),
S (the story: which link carries a pulse, when it starts, how long it takes) and PHASES (the caption per step).
The figures shown are the defaults in plugins/ech-context/hooks: a 200k-token limit, a 50k step, a 30 min window, a 10 s hook timeout.
There is no counter and no measured figure in the picture.
Python standard library only. Nothing is written outside <out.svg>.
"""
import random
import sys
from xml.sax.saxutils import escape

args = sys.argv[1:]
if len(args) != 1 or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n')
    sys.exit(3)
OUT = args[0]

W, H = 960, 600
LOOP = 16.0  # one story loop, in seconds

# key: (name, cx, cy, w, h, tag, line1, line2). Agents and hooks are rectangles.
N = {
    'user': ('you',                 110,  60, 190, 64, '',                     'type a prompt',                    'see the size line in the app'),
    'main': ('Claude Code session', 110, 320, 190, 80, '',                     'fires the hook events',            'each hook times out at 10 s'),
    'tail': ('transcript tail',     400,  50, 260, 64, 'read',                 'newest main-thread usage:',        'input + cache tokens'),
    'size': ('session-size',        400, 170, 260, 80, 'UserPromptSubmit',     'at or above 200k tokens: a hint',  'once per 50k of growth'),
    'pre':  ('compact-guard',       400, 320, 260, 80, 'PreCompact',           'auto: adds a keep-verbatim list',  'manual: logged, nothing added'),
    'post': ('compact-guard',       400, 470, 260, 80, 'SessionStart compact', 'within 30 min of an auto compaction:', 'adds a recovery line, once'),
}
# key: (name, cx, cy, w, h, caption under the oval). Models are ovals.
OVAL = {
    'summ':  ('compaction summary', 655, 320, 180, 56, 'keeps a MUST SURVIVE heading'),
    'model': ('Claude',             865, 320, 170, 70, 'reads the added context'),
}
PATHS = {
    'p-prompt': 'M 110 92 L 110 280',
    'p-ups':    'M 205 300 C 240 290, 235 180, 270 180',
    'p-tail':   'M 400 130 L 400 82',
    'p-hint':   'M 530 170 C 640 170, 865 190, 865 285',
    'p-line':   'M 270 160 C 240 150, 240 60, 205 60',
    'p-pre':    'M 205 320 L 270 320',
    'p-keep':   'M 530 320 L 565 320',
    'p-new':    'M 745 320 L 780 320',
    'p-start':  'M 205 340 C 240 350, 235 470, 270 470',
    'p-rec':    'M 530 470 C 700 470, 865 450, 865 355',
}
# Link labels: (x, y, text).
LABELS = [
    (118, 190, 'prompt'),
    (690, 162, 'hint, information only'),
    (690, 456, 'recovery line'),
]
# The story on one loop: (path, begin s, duration s, kind, reverse, node that flashes on arrival).
S = [
    ('p-prompt', 0.3, 1.0, 'brief', False, 'main'),
    ('p-ups',    1.3, 1.0, 'brief', False, 'size'),
    ('p-tail',   2.4, 0.6, 'ask',   False, 'tail'),
    ('p-tail',   3.1, 0.6, 'ask',   True,  None),
    ('p-hint',   3.9, 1.4, 'brief', False, 'model'),
    ('p-line',   3.9, 1.2, 'patch', False, 'user'),
    ('p-pre',    6.6, 0.8, 'brief', False, 'pre'),
    ('p-keep',   7.6, 0.9, 'brief', False, 'summ'),
    ('p-new',    8.7, 0.9, 'patch', False, 'model'),
    ('p-start', 10.2, 1.0, 'brief', False, 'post'),
    ('p-rec',   11.4, 1.5, 'brief', False, 'model'),
]
# Caption per step of the story: (from s, to s, line1, line2).
PHASES = [
    (0.0,  6.2,  'step 1 of 3: every prompt',             'at or above 200k, once per 50k of growth'),
    (6.2,  9.9,  'step 2 of 3: automatic compaction',     'the summary is told what to keep verbatim'),
    (9.9,  LOOP, 'step 3 of 3: after the compaction',     'within 30 min of the auto compaction'),
]
FOOTER = [
    'Off: SESSION_SIZE=off, COMPACT_GUARD=off, or a session-size.off / compact-guard.off file in the data directory.',
    'Both fail open: a crash exits 0 and prints nothing. A prompt is never refused; subagent prompts are skipped.',
    'A subagent compaction gets its own keep list. Ledgers: session-size.jsonl and compact.jsonl in the data directory.',
]


def kt(t):
    return f'{t / LOOP:.4f}'


def flash(shape, k, at):
    """A ring that lights up when a pulse reaches node k, then fades while it grows. SMIL only."""
    a, b = at / LOOP, min(at + 1.2, LOOP - 0.05) / LOOP
    times = f'0;{a - 0.002:.4f};{a:.4f};{b:.4f};1'
    op = f'<animate attributeName="opacity" values="0;0;.7;0;0" keyTimes="{times}" dur="{LOOP}s" repeatCount="indefinite"/>'
    if shape == 'rect':
        name, cx, cy, w, h = N[k][:5]
        x, y = cx - w / 2, cy - h / 2
        grow = ''.join(f'<animate attributeName="{att}" values="{v0};{v0};{v0};{v1};{v1}" keyTimes="{times}" dur="{LOOP}s" repeatCount="indefinite"/>'
                       for att, v0, v1 in (('x', x, x - 6), ('y', y, y - 5), ('width', w, w + 12), ('height', h, h + 10)))
        return f'<rect class="ring" x="{x}" y="{y}" width="{w}" height="{h}" opacity="0">{op}{grow}</rect>'
    name, cx, cy, w, h = OVAL[k][:5]
    grow = ''.join(f'<animate attributeName="{att}" values="{v0};{v0};{v0};{v0 + d};{v0 + d}" keyTimes="{times}" dur="{LOOP}s" repeatCount="indefinite"/>'
                   for att, v0, d in (('rx', w / 2, 7), ('ry', h / 2, 6)))
    return f'<ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}" opacity="0">{op}{grow}</ellipse>'


def rect_node(k):
    name, cx, cy, w, h, tag, l1, l2 = N[k]
    x, y = cx - w / 2, cy - h / 2
    pill = ''
    if tag:
        pw = round(10 + len(tag) * 5.8)
        px = x + w - pw - 8
        pill = (f'<rect class="pill" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
                f'<text class="pilltxt" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{escape(tag)}</text>')
    return (f'<g><rect class="node" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text class="nm" x="{x + 11}" y="{y + 21}">{escape(name)}</text>{pill}'
            f'<text class="mute" x="{x + 11}" y="{y + 40}">{escape(l1)}</text>'
            f'<text class="mute" x="{x + 11}" y="{y + 54}">{escape(l2)}</text></g>')


def oval_node(k):
    name, cx, cy, w, h, cap = OVAL[k]
    return (f'<g><ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<text class="nm on" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{escape(name)}</text>'
            f'<text class="mute free" x="{cx}" y="{cy + h / 2 + 18}" text-anchor="middle">{escape(cap)}</text></g>')


def pulse(pid, begin, dur, kind, rev):
    """A square pulse with a short trail; hidden until its begin time in every loop, eased in and out."""
    out = []
    for i, (r, op, cls) in enumerate([(10, 1, 'halo'), (4.2, 1, 'dot'), (3.2, .55, 'dot'), (2.4, .3, 'dot')]):
        b0 = begin + max(0, i - 1) * 0.06
        t1, t2 = kt(b0), kt(b0 + dur)
        kp = '1;1;0;0' if rev else '0;0;1;1'
        out.append(
            f'<g style="opacity:{op}" visibility="hidden">'
            f'<animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;{t1};{t2}" calcMode="discrete" dur="{LOOP}s" begin="0s" repeatCount="indefinite"/>'
            f'<animateMotion dur="{LOOP}s" begin="0s" repeatCount="indefinite" calcMode="spline" keyTimes="0;{t1};{t2};1" keyPoints="{kp}" keySplines="0 0 1 1;0.45 0 0.55 1;0 0 1 1"><mpath href="#{pid}"/></animateMotion>'
            f'<rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g>')
    return ''.join(out)


def phase(t0, t1, l1, l2):
    vis = (f'<animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;{kt(t0)};{kt(t1)}" calcMode="discrete" dur="{LOOP}s" begin="0s" repeatCount="indefinite"/>'
           if t0 > 0 else
           f'<animate attributeName="visibility" values="visible;hidden" keyTimes="0;{kt(t1)}" calcMode="discrete" dur="{LOOP}s" begin="0s" repeatCount="indefinite"/>')
    start = 'visible' if t0 == 0 else 'hidden'
    return (f'<g visibility="{start}">{vis}<text class="ph" x="945" y="36" text-anchor="end">{escape(l1)}</text>'
            f'<text class="mute free" x="945" y="54" text-anchor="end">{escape(l2)}</text></g>')


def rain():
    rnd = random.Random(7)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    out = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        out += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 {H}" dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    return out


CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{font-size:10px;fill:var(--mute)}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}.nm.on{fill:var(--ink)}
.ph{font-size:12.5px;font-weight:700;fill:var(--ask)}
.lb{font-size:10px;fill:var(--ask)}
.ft{font-size:10px;fill:var(--mute)}
.lb,.ph,.ft,.free{paint-order:stroke;stroke:#000;stroke-width:4px;stroke-linejoin:round}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}
.link{fill:none;stroke:var(--line);stroke-width:1.3}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}.dot.ask,.halo.ask{fill:var(--ask)}
.halo{opacity:.35}
"""


def build():
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in PATHS.items())
    fade = '<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient>'
    links = ''.join(f'<use href="#{k}" class="link"/>' for k in PATHS)
    labels = ''.join(f'<text class="lb" x="{x}" y="{y}">{escape(t)}</text>' for x, y, t in LABELS)
    rings = ''.join(flash('oval' if k in OVAL else 'rect', k, b + d) for _, b, d, _, _, k in S if k)
    nodes = ''.join(rect_node(k) for k in N) + ''.join(oval_node(k) for k in OVAL)
    pulses = ''.join(pulse(p, b, d, kind, rev) for p, b, d, kind, rev, _ in S)
    phases = ''.join(phase(*p) for p in PHASES)
    footer = ''.join(f'<text class="ft" x="15" y="{548 + 16 * i}">{escape(t)}</text>' for i, t in enumerate(FOOTER))
    title = 'ech-context: the session-size hint and the compact guard'
    desc = ('On every prompt, session-size reads the newest main-thread token usage from the transcript tail; at or above 200k tokens it adds an '
            'information-only hint for Claude and shows you the size, at most once per 50k of growth. Before an automatic compaction, '
            'compact-guard tells the summary what to keep verbatim under a MUST SURVIVE heading. When the session resumes within 30 minutes '
            'of that automatic compaction, compact-guard adds a recovery line once. Both hooks can be switched off and fail open.')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
            f'<title id="t">{escape(title)}</title><desc id="d">{escape(desc)}</desc>'
            f'<style>{CSS}</style><defs>{defs}{fade}</defs>'
            f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{links}{labels}{rings}{nodes}{phases}<rect x="0" y="532" width="{W}" height="{H - 532}" fill="#000" opacity=".78"/>{footer}<g>{pulses}</g></svg>')


if __name__ == '__main__':
    svg = build()
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(svg)
    print(len(svg))
