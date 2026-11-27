#!/usr/bin/env python3
"""Builds the animated claim-check flow: one script-free SVG (SMIL pulses on curved links, a Matrix look over falling green code).

Usage: python3 claim-check/flow-animation/build.py <out.svg>

It draws the real flow of plugins/ech-claim-check/hooks/register.ts:
a Stop (main session) or SubagentStop (any subagent) event reaches the turn-end hook, which skips a stop with stop_hook_active
and any claim-sentinel report, then the regex gate lets a text with no claim word through at no cost;
otherwise Haiku reads the final text, the turn's last 30 tool calls and the optional project rules file,
and answers flag:true (the hook blocks once and the agent is re-prompted) or flag:false (the stop goes through).
Any error, timeout or unreadable answer also lets the stop through. Every decision is one ledger line.
The figures on the nodes (30 calls, 200 tokens, 4,000 characters) are the constants in that file, not measurements.

Agents and hook steps are rectangles, the model is an oval, pulses are squares.
Everything you edit is data near the top: N (nodes), OVAL, BR (model size), paths and the pulse list P.
Python standard library only. Nothing is written outside <out.svg>.
"""
import random
import sys

args = sys.argv[1:]
if not args or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.svg>\n'); sys.exit(3)
OUT = args[0]

W, H = 960, 520
# key: (name, cx, cy, w, h, tag, line1, line2); tag '' draws no pill, a tag starting with '~' is drawn idle (dashed)
N = {
 'sent':   ('claim-sentinel',     100,  60, 170, 62, '~',        'opt-in observer',        'its stops are skipped'),
 'main':   ('main session',       100, 170, 170, 66, '',         'turn ends: Stop',        'sends its final text'),
 'sub':    ('any subagent',       100, 330, 170, 66, '',         'turn ends: SubagentStop', 'sends its final text'),
 'hook':   ('turn-end hook',      340, 250, 170, 78, 'hook',     'skips stop_hook_active', 'so it blocks once a turn'),
 'gate':   ('regex gate',         550, 250, 170, 78, 'free',     'no claim word: pass',    'no model call'),
 'ctx':    ('turn context',       775, 405, 170, 76, 'input',    'last 30 tool calls',     '+ project rules file'),
 'block':  ('block once',         775,  95, 180, 78, 'flag:true', 're-prompts the agent',  'check it or restate it'),
 'pass':   ('stop goes through',  550, 405, 180, 76, '',         'flag:false, or error,',  'timeout: fail open'),
 'ledger': ('ledger',             340, 405, 170, 76, 'jsonl',    'one line per decision',  'flag, claim, tokens, ms'),
 'haiku':  ('Haiku',              775, 250, 190, 64, '',         'low effort, 200 tokens', ''),
}
OVAL = {'haiku'}
BR = {'haiku': 1, 'sent': 1}   # model size per node: 1 = haiku (both run on haiku in the plugin)
order = ['sent', 'main', 'sub', 'hook', 'gate', 'ctx', 'block', 'pass', 'ledger', 'haiku']

paths = {
 'p-sent':  'M 100 137 L 100 92',
 'p-main':  'M 185 175 C 220 175, 220 240, 255 240',
 'p-sub':   'M 185 330 C 220 330, 220 262, 255 262',
 'p-gate':  'M 425 250 L 465 250',
 'p-haiku': 'M 635 250 L 680 250',
 'p-ctx':   'M 775 367 L 775 282',
 'p-block': 'M 775 218 L 775 134',
 'p-back':  'M 685 100 C 560 100, 420 140, 380 211',
 'p-pass1': 'M 550 289 L 550 367',
 'p-pass2': 'M 712 274 C 690 330, 670 395, 640 395',
 'p-ledger': 'M 340 289 L 340 367',
}
IDLE = {'p-sent'}


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def brain(k, x, y, anchor):
    if k not in BR:
        return ''
    size = {0: 7, 1: 10, 2: 14, 3: 18}[BR[k]]
    return f'<text class="br" x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}">{chr(0x1F9E0)}</text>'


def ring_delay(k):
    return f'{(sum(map(ord, k)) % 14) / 10:.1f}s'


def oval(k):
    name, cx, cy, w, h, tag, l1, l2 = N[k]
    return (f'<g><ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}" style="animation-delay:{ring_delay(k)}"/>'
            f'<ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w / 2}" ry="{h / 2}"/>'
            f'<text class="nm" x="{cx - 8}" y="{cy - 2}" text-anchor="middle">{esc(name)}</text>'
            f'<text class="mute dim" x="{cx - 8}" y="{cy + 13}" text-anchor="middle">{esc(l1)}</text>'
            f'{brain(k, cx + w / 2 - 20, cy + 5, "middle")}</g>')


def node(k):
    if k in OVAL:
        return oval(k)
    name, cx, cy, w, h, tag, l1, l2 = N[k]
    x, y = cx - w / 2, cy - h / 2
    idle = tag.startswith('~')
    tag = tag.lstrip('~')
    ring = '' if idle else f'<rect class="ring" x="{x}" y="{y}" width="{w}" height="{h}" style="animation-delay:{ring_delay(k)}"/>'
    pill = ''
    if tag:
        pw = round(10 + len(tag) * 5.6)
        px = x + w - pw - 8
        off = ' off' if idle else ''
        pill = (f'<rect class="pill{off}" x="{px}" y="{y + 7}" width="{pw}" height="16"/>'
                f'<text class="pilltxt{off}" x="{px + pw / 2}" y="{y + 18.5}" text-anchor="middle">{esc(tag)}</text>')
    return (f'<g>{ring}<rect class="node{" off" if idle else ""}" x="{x}" y="{y}" width="{w}" height="{h}"/>'
            f'<text class="nm" x="{x + 11}" y="{y + 21}">{esc(name)}</text>{pill}'
            f'<text class="mute dim" x="{x + 11}" y="{y + 40}">{esc(l1)}</text>'
            f'<text class="mute dim" x="{x + 11}" y="{y + 54}">{esc(l2)}</text>'
            f'{brain(k, x + w - 9, y + h - 7, "end")}</g>')


def pulse(path, dur, begin, kind, rev=False):
    """A square pulse with a trail and a halo, hidden until its own begin time, eased like the ai-coder pulses."""
    dur, begin = dur / 2, begin / 2   # twice the first speed, as in ai-coder
    ease = 'keyTimes="0;1" keySplines="0.45 0 0.55 1" calcMode="spline"'
    kp = f' keyPoints="1;0" {ease}' if rev else f' keyPoints="0;1" {ease}'
    out = []

    def head(r, op, b0, cls):
        return (f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
                f'<animateMotion dur="{dur}s" begin="{b0:.2f}s" repeatCount="indefinite"{kp}><mpath href="#{path}"/></animateMotion>'
                f'<rect class="{cls} {kind}" x="{-r}" y="{-r}" width="{2 * r}" height="{2 * r}"/></g>')
    for i, (r, op) in enumerate([(4.2, 1), (3.2, .55), (2.4, .3)]):
        out.append(head(r, op, begin + i * 0.06, 'dot'))
    out.append(head(10, 1, begin, 'halo'))
    return ''.join(out)


# brief = the turn's text and tool calls going forward, ask = the question to Haiku and its verdict,
# patch = the block going back to the agent that stopped
P = [pulse('p-main', 2.4, 0.0, 'brief'), pulse('p-main', 2.8, 3.4, 'patch', True),
     pulse('p-sub', 2.6, 1.2, 'brief'), pulse('p-sub', 3.0, 4.2, 'patch', True),
     pulse('p-gate', 1.4, 0.6, 'brief'),
     pulse('p-pass1', 1.8, 1.4, 'brief'),
     pulse('p-haiku', 1.4, 1.0, 'ask'),
     pulse('p-ctx', 1.6, 0.8, 'brief'),
     pulse('p-block', 1.4, 1.8, 'patch'),
     pulse('p-back', 2.6, 2.4, 'patch'),
     pulse('p-pass2', 2.0, 2.0, 'ask'),
     pulse('p-ledger', 1.8, 1.6, 'brief')]


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


def legend():
    items = [('brief', 'final text and tool calls'), ('ask', 'question to Haiku, its verdict'),
             ('patch', 'block: the agent is re-prompted')]
    out, x = f'<rect x="0" y="474" width="{W}" height="{H - 474}" fill="#000" opacity=".85"/>', 16
    for kind, label in items:
        out += f'<rect class="dot {kind}" x="{x + 2}" y="483" width="10" height="10"/><text class="mute dim" x="{x + 20}" y="492">{label}</text>'
        x += 40 + len(label) * 6.2
    out += (f'<line class="link idle" x1="18" y1="506" x2="30" y2="506"/><text class="mute dim" x="36" y="510">opt-in, off by default</text>'
            f'<text class="mute dim" x="{W - 16}" y="510" text-anchor="end">rectangle = agent or hook step, oval = model</text>')
    return out


CSS = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--off:#1f7a38;--off-bg:#061a0b;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.dim{font-size:10px}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5;filter:drop-shadow(0 0 4px #0f8f2e)}
.node.off{stroke:var(--off);stroke-dasharray:4 3;filter:none}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}.pill.off{fill:var(--off-bg);stroke:var(--off)}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}.pilltxt.off{fill:var(--off)}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke:var(--off);stroke-dasharray:3 5}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}.dot.ask,.halo.ask{fill:var(--ask)}
.halo{opacity:.35}
.br{filter:grayscale(1) sepia(1) hue-rotate(60deg) saturate(4)}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
"""

TITLE = 'claim-check: a turn-end check for unverified claims'
DESC = ('When the main session (Stop) or any subagent (SubagentStop) ends its turn, the turn-end hook skips a stop that is already '
        're-prompted and any claim-sentinel report. A regex gate lets a text with no claim word through without a model call. '
        'Otherwise Haiku reads the final text, the last 30 tool calls and the optional project rules file. '
        'If it flags a claim no tool call backs, the hook blocks once and the agent is re-prompted to check it or restate it as unverified. '
        'Otherwise, and on any error or timeout, the stop goes through. Every decision is one ledger line. '
        'The claim-sentinel observer is opt-in.')

defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
links = ''.join(f'<use href="#{k}" class="link{" idle" if k in IDLE else ""}"/>' for k in paths)
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
       f'<title id="t">{esc(TITLE)}</title><desc id="d">{esc(DESC)}</desc>'
       f'<style>{CSS}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">'
       '<stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient></defs>'
       f'<rect width="{W}" height="{H}" fill="#000"/><g>{rain()}</g>{links}{"".join(node(k) for k in order)}'
       f'<g>{"".join(P)}</g>{legend()}</svg>\n')

with open(OUT, 'w', encoding='utf-8') as f:
    f.write(svg)
print(len(svg))
