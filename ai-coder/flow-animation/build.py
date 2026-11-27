#!/usr/bin/env python3
"""Builds the animated delegation flow: one self-contained HTML page (inline SVG, SMIL pulses, a Matrix look).

Usage: python3 ai-coder/flow-animation/build.py <out.html> [--sentence-divs <path-to-js>] [--svg <out.svg>]

Everything you edit is data near the top: N (nodes), BR (model tier per node), EX (theoretical savings), paths
and the pulse list. The figures on the nodes are sample figures copied from a dashboard screenshot, not live data.
The "saved $" lines are theoretical: they count up on fixed timers and are not measured.
Python standard library only. Nothing is written outside <out.html> and <out.svg>.
--svg writes a script-free animated SVG for a README: the same diagram, Matrix look, rain and counters done with SMIL only.
"""
import sys
import os
args = sys.argv[1:]
if not args or args[0].startswith('--'):
    sys.stderr.write('usage: build.py <out.html> [--sentence-divs <js file>] [--svg <out.svg>]\n'); sys.exit(3)
OUT = args[0]
js = ''
if '--sentence-divs' in args:
    js = open(args[args.index('--sentence-divs') + 1]).read()
# key: (name, cx, cy, w, h, state, line1, line2)
N = {
 'main':  ('main session',      100,235,170,66,'working','all code goes to ai-coder','30 d: 3,587 events'),
 'sent':  ('claim sentinel',    100, 90,170,62,'working','observer: haiku, opt-in','flags unchecked claims'),
 'coder': ('ai-coder',          340,140,160,78,'front','asks Jev, then routes','30 d: 594 runs'),
 'expl':  ('code-explorer',     340,290,160,76,'working','last used 65 s ago','30 d: 319 runs'),
 'qa':    ('browser-qa',        340,375,160,76,'idle',   'last used 81 s ago','30 d: 112 runs'),
 'review':('codex review',      340,465,160,76,'working','read-only, advisory only','sol-reviewer · haiku'),
 'jev':   ('Jev',               580, 40,170,56,'classifier','decides the lane','down? use ai-coder-high'),
 'avg':   ('ai-coder-average',  580,130,160,76,'working','wraps Cursor Composer','new agent, to create'),
 'high':  ('ai-coder-high',     580,240,160,76,'working','wraps delegation service','30 d: 161 runs'),
 'codex': ('Codex',             580,465,170,56,'review','review lane, read-only','coder lane: off'),
 'cursor':('Cursor Composer',   820,130,190,56,'working','composer-2.5','30 d: 1,187 runs'),
 'deleg': ('delegation service',820,240,220,56,'working','Claude sonnet, remote','30 d: 596 runs'),
}
GUESS=set()
BR={'jev':0,'codex':2,'main':3,'sent':1,'coder':1,'expl':1,'qa':2,'review':1,'avg':1,'high':1,'cursor':1,'deleg':2}
LOGO={'jev','codex','deleg','cursor'}
def logo(k,x,y):
    if k not in LOGO: return ''
    c='var(--ask)'
    if k=='jev':   # stand-in mark: a J in a ring
        return f'<g><circle cx="{x+7}" cy="{y+7}" r="7" fill="none" stroke="{c}" stroke-width="1.4"/><text x="{x+7}" y="{y+11}" text-anchor="middle" font-size="10" font-weight="700" style="fill:{c}">J</text></g>'
    if k=='cursor':  # stand-in mark: a pointer arrow
        pts=[(0,0),(0,12),(3.5,8.5),(6.2,13.5),(8.4,12.4),(5.8,7.6),(10.5,7.6)]
        d=' '.join(f'{x+1+a:.1f},{y+1+b:.1f}' for a,b in pts)
        return f'<g><polygon points="{d}" fill="none" stroke="{c}" stroke-width="1.4" stroke-linejoin="round"/></g>'
    if k=='codex': # stand-in mark: a terminal prompt in a rounded square
        return f'<g><rect x="{x}" y="{y}" width="14" height="14" rx="3" fill="none" stroke="{c}" stroke-width="1.4"/><path d="M {x+4} {y+4.5} L {x+7.5} {y+7} L {x+4} {y+9.5} M {x+8.5} {y+10} L {x+11} {y+10}" fill="none" stroke="{c}" stroke-width="1.3" stroke-linecap="round"/></g>'
    # stand-in mark for the Claude call: an eight-ray burst
    import math
    rays=''.join(f'<line x1="{x+7+2*math.cos(a*math.pi/4):.1f}" y1="{y+7+2*math.sin(a*math.pi/4):.1f}" x2="{x+7+6.5*math.cos(a*math.pi/4):.1f}" y2="{y+7+6.5*math.sin(a*math.pi/4):.1f}" stroke="{c}" stroke-width="1.5" stroke-linecap="round"/>' for a in range(8))
    return f'<g>{rays}</g>'
EX={'coder':106,'avg':84,'high':22,'expl':31,'qa':9,'review':14}
OVAL={'jev','cursor','deleg','codex'}
def oval(k):
    name,cx,cy,w,h,state,l1,l2 = N[k]
    on = state!='idle'
    ring = f'<ellipse class="ring" cx="{cx}" cy="{cy}" rx="{w/2}" ry="{h/2}" style="animation-delay:{(sum(map(ord,k))%14)/10:.1f}s"/>' if on else ''
    nw = len(name)*7.2
    lg = logo(k, cx-nw/2-20+(8 if k in LOGO else 0), cy-7) if k in LOGO else ''
    bx = cx+w/2-22
    brain = f'<text class="br" x="{bx}" y="{cy+5}" text-anchor="middle" font-size="{ {0:7,1:10,2:14,3:18}[BR[k]] }">{chr(0x1F9E0)}{"<tspan font-size=\'10\'>?</tspan>" if k in GUESS else ""}</text>' if k in BR else ''
    return f'''<g>{ring}<ellipse class="oval" cx="{cx}" cy="{cy}" rx="{w/2}" ry="{h/2}"/>
{lg}<text class="ot nm" x="{cx+(10 if k in LOGO else 0)}" y="{cy+4.5}" text-anchor="middle" font-size="12.5" font-weight="700">{name}</text>
{brain}</g>'''
def node(k):
    if k in OVAL: return oval(k)
    name,cx,cy,w,h,state,l1,l2 = N[k]
    x=cx-w/2; y=cy-h/2
    on = state!='idle'
    kind = 'node' if on else 'node off'
    BLUE={'jev','codex','deleg'}
    if k in BLUE: kind='node ask'+('' if on else ' off')
    ring = f'<rect class="ring{" ask" if k=="jev" else ""}" x="{x}" y="{y}" width="{w}" height="{h}" rx="9" style="animation-delay:{(sum(map(ord,k))%14)/10:.1f}s"/>' if on else ''
    pw = round(10+len(state)*5.6)
    px = x+w-pw-8
    pc = 'pill ask' if k=='jev' else ('pill' if on else 'pill off')
    tc = 'pilltxt ask' if k=='jev' else ('pilltxt' if on else 'pilltxt off')
    extra = f'<text class="save" id="sv-{k}" x="{x+11}" y="{y+70}" font-size="10.5" font-weight="700">saved $ 0.00</text>' if k in EX else ''
    brain = f'<text class="br" x="{x+w-9}" y="{y+h-7}" text-anchor="end" font-size="{ {0:7,1:10,2:14,3:18}[BR[k]] }">{chr(0x1F9E0)}{"<tspan font-size='10'>?</tspan>" if k in GUESS else ""}</text>' if k in BR else ''
    extra += brain
    tag = '' if state=='working' else f'<rect class="{pc}" x="{px}" y="{y+7}" width="{pw}" height="16" rx="4"/><text class="{tc}" x="{px+pw/2}" y="{y+18.5}" text-anchor="middle">{state}</text>'
    return f'''<g>{ring}<rect class="{kind}" x="{x}" y="{y}" width="{w}" height="{h}" rx="9"/>
{logo(k,x+11,y+10)}<text x="{x+(31 if k in LOGO else 11)}" y="{y+21}" font-size="12.5" font-weight="700">{name}</text>
{tag}
<text class="mute" x="{x+11}" y="{y+40}" font-size="10">{l1}</text>
<text class="mute" x="{x+11}" y="{y+54}" font-size="10">{l2}</text>{extra}</g>'''
paths = {
 'p-sent':   'M 100 202 L 100 121',
 'p-coder':  'M 185 220 C 225 200, 225 140, 260 140',
 'p-expl':   'M 185 245 C 225 260, 225 290, 260 290',
 'p-qa':     'M 185 258 C 225 320, 225 375, 260 375',
 'p-rev':    'M 150 268 C 190 380, 215 465, 260 465',
 'p-jev':    'M 420 122 C 450 110, 450 40, 495 40',
 'p-avg':    'M 420 150 C 460 150, 465 130, 500 130',
 'p-high':   'M 420 158 C 460 200, 465 240, 500 240',
 'p-cursor': 'M 660 130 L 725 130',
 'p-deleg':  'M 660 240 L 710 240',
 'p-revc':   'M 420 465 L 495 465',
}
def pulse(path, dur, begin, kind, rev=False):
    dur, begin = dur/2, begin/2   # twice as fast
    ease = 'keyTimes="0;1" keySplines="0.45 0 0.55 1" calcMode="spline"'
    kp = f' keyPoints="1;0" {ease}' if rev else f' keyPoints="0;1" {ease}'
    mp = f'<mpath href="#{path}"/>'
    out=[]
    def head(r, op, b0, cls):
        return (f'<g style="opacity:{op}" visibility="hidden"><set attributeName="visibility" to="visible" begin="{b0:.2f}s" fill="freeze"/>'
                f'<animateMotion dur="{dur}s" begin="{b0:.2f}s" repeatCount="indefinite"{kp}>{mp}</animateMotion>'
                f'<circle r="{r}" class="ci {cls} {kind}"/><rect class="sq {cls} {kind}" x="{-r}" y="{-r}" width="{2*r}" height="{2*r}"/></g>')
    for i,(r,op) in enumerate([(4.2,1),(3.2,.55),(2.4,.3)]):
        out.append(head(r,op,begin+i*0.06,'dot'))
    out.append(head(10,1,begin,'halo'))
    return ''.join(out)
P=[pulse('p-coder',2.6,0,'brief'),pulse('p-coder',3.0,1.4,'patch',True),
   pulse('p-jev',1.8,0.3,'ask'),pulse('p-jev',2.2,1.6,'ask',True),
   pulse('p-avg',2.2,0.8,'brief'),pulse('p-avg',2.6,1.8,'patch',True),
   pulse('p-high',2.6,1.9,'brief'),pulse('p-high',3.0,0.5,'patch',True),
   pulse('p-cursor',1.2,0.2,'brief'),pulse('p-cursor',1.6,0.9,'patch',True),
   pulse('p-deleg',1.4,0.6,'brief'),pulse('p-deleg',1.8,1.3,'patch',True),
   pulse('p-expl',3.2,0.9,'brief'),pulse('p-expl',3.6,2.2,'patch',True),
   pulse('p-rev',3.4,1.1,'brief'),pulse('p-rev',3.8,2.6,'patch',True),
   pulse('p-revc',1.6,0.4,'brief'),pulse('p-revc',2.0,1.2,'patch',True),
   pulse('p-sent',2.2,0.3,'ask'),pulse('p-sent',2.6,1.5,'patch',True)]
order=['jev','codex','review','sent','cursor','avg','high','deleg','coder','expl','qa','main']
body = f'''<title>Orchestrator and Coder Flow</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: left to right. main session, then its delegates, then ai-coder's lanes. Jev sits above ai-coder and answers its question. */
:root{{--oval-line:#a9b6af;--bg:#f2f5f3;--ink:#16211b;--mute:#5d6b63;--node:#ffffff;--line:#bccac2;--ok:#1d8a52;--ok-bg:#dff3e6;--brief:#1d8a52;--patch:#b26a00;--ask:#0b5cab;--ask-bg:#dbe9f8;--off:#8a9690;--off-bg:#e6eae8}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--oval-line:#eef5f0;--bg:#090d0b;--ink:#dcebe2;--mute:#86a093;--node:#0e1712;--line:#27402f;--ok:#4ade80;--ok-bg:#11301e;--brief:#4ade80;--patch:#f0b25a;--ask:#6db3ff;--ask-bg:#112338;--off:#8a9690;--off-bg:#1b2420;color-scheme:dark}}}}
:root[data-theme="dark"]{{--oval-line:#eef5f0;--bg:#090d0b;--ink:#dcebe2;--mute:#86a093;--node:#0e1712;--line:#27402f;--ok:#4ade80;--ok-bg:#11301e;--brief:#4ade80;--patch:#f0b25a;--ask:#6db3ff;--ask-bg:#112338;--off:#8a9690;--off-bg:#1b2420;color-scheme:dark}}
body{{background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 40px}}
.wrap{{max-width:1000px;margin:0 auto;display:flex;flex-direction:column;gap:14px}}
h1{{font-size:1.25rem;margin:0}}
.legend{{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--mute);font-size:.9rem}}
.legend span{{display:inline-flex;align-items:center;gap:7px}}
.legend i{{width:10px;height:10px;border-radius:50%;display:inline-block}}
.box{{border:1px solid var(--line);border-radius:12px;padding:6px;min-width:0;overflow-x:auto}}
svg{{display:block;width:100%;min-width:760px;height:auto}}
svg text{{font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;fill:var(--ink)}}
.mute{{fill:var(--mute)!important}}
.save{{fill:var(--brief)!important}}
.oval{{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6}}
.box.mx .oval{{filter:drop-shadow(0 0 4px #d8ffe0);stroke:#eaffef}}
.node{{fill:var(--node);stroke:var(--ok);stroke-width:1.5}}
.node.ask{{stroke:var(--ask)}}
.node.ask.off{{stroke:var(--ask)}}
.node.off{{stroke:var(--off);stroke-dasharray:4 3}}
.ring{{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}}
.ring.ask{{stroke:var(--ask)}}
@keyframes ring{{0%{{opacity:.5;transform:scale(1)}}100%{{opacity:0;transform:scale(1.08,1.16)}}}}
.pill{{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}}.pill.ask{{fill:var(--ask-bg);stroke:var(--ask)}}.pill.off{{fill:var(--off-bg);stroke:var(--off)}}
.pilltxt{{fill:var(--ok)!important;font-size:9.5px;font-weight:700}}.pilltxt.ask{{fill:var(--ask)!important}}.pilltxt.off{{fill:var(--off)!important}}
.link{{fill:none;stroke:var(--line);stroke-width:1.4}}
.link.idle{{stroke-dasharray:3 5}}
.dot.brief{{fill:var(--brief)}}.dot.patch{{fill:var(--patch)}}.dot.ask{{fill:var(--ask)}}
.halo{{opacity:.18;filter:blur(3px)}}.halo.brief{{fill:var(--brief)}}.halo.patch{{fill:var(--patch)}}.halo.ask{{fill:var(--ask)}}
.tog{{display:flex;gap:8px;align-items:center;color:var(--mute);font-size:.88rem}}
.tog button{{font:inherit;color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:6px;padding:5px 12px;cursor:pointer}}
.tog button[aria-pressed="true"]{{border-color:var(--ok);color:var(--ok);font-weight:700}}
.tog button:focus-visible{{outline:2px solid var(--ask);outline-offset:2px}}
.box{{position:relative}}
.box canvas{{display:none;position:absolute;inset:0;width:100%;height:100%;opacity:.5}}
.box svg{{position:relative}}
.box.mx{{--node:rgba(0,14,4,.86);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--ask-bg:#0b3a18;--off:#1f7a38;--off-bg:#061a0b;background:#000;border-color:#0f8f2e}}
.box.mx canvas{{display:block}}
.box.mx svg text{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}}
.box.mx .node{{filter:drop-shadow(0 0 4px #0f8f2e)}}
.box.mx .node.off{{filter:none}}
.box.mx .br{{filter:grayscale(1) sepia(1) hue-rotate(60deg) saturate(4)}}
.box.mx .halo{{opacity:.35}}
.sq{{display:none}}
.box.mx .sq{{display:block}}
.box.mx .ci{{display:none}}
.box.mx rect{{rx:0;ry:0}}
@media (prefers-reduced-motion:reduce){{.ring{{animation:none}}}}
</style>
<div class="wrap">
<h1>Main session, ai-coder, Jev and the two coder lanes</h1>
<div class="legend"><span><i style="background:var(--brief)"></i>brief goes out</span><span><i style="background:var(--patch)"></i>result comes back</span><span><i style="background:var(--ask)"></i>question to Jev and its answer</span><span><i style="background:var(--off)"></i>idle</span><span>white oval = model, rectangle = agent</span><span>saved $ = cost avoided versus the same work done by opus 5.5 at high effort. Theoretical: it counts up by a fixed amount on a timer and is not measured.</span><span><span style="font-size:.5em">🧠</span> tiny · <span style="font-size:.7em">🧠</span> haiku · 🧠 sonnet · <span style="font-size:1.45em">🧠</span> opus</span></div>
<div class="tog"><span>Look:</span><button type="button" id="b-classic" aria-pressed="false">Classic</button><button type="button" id="b-matrix" aria-pressed="true">Matrix</button></div>
<div class="box mx" id="box"><canvas id="rain" aria-hidden="true"></canvas>
<svg viewBox="0 0 960 520" role="img" aria-labelledby="t d" id="flow">
<title id="t">The main session sends all code to ai-coder, which asks Jev and sends the work to ai-coder-average or ai-coder-high</title>
<desc id="d">The main session sends all code to ai-coder. ai-coder asks Jev, which decides the lane. ai-coder-average wraps Cursor Composer and ai-coder-high wraps the delegation service, a Claude sonnet run elsewhere. Codex is used for reviews through the codex review agent. The claim sentinel observes the main session. code-explorer and browser-qa are direct delegates of the main session; browser-qa is idle.</desc>
<defs>{''.join(f'<path id="{k}" d="{v}"/>' for k,v in paths.items())}</defs>
<path d="M 185 258 C 230 300, 240 370, 280 370" class="link idle"/>
{''.join(f'<use href="#{k}" class="link{" idle" if k in ("p-sent",) else ""}"/>' for k in paths)}
{''.join(node(k) for k in order)}
<g>{''.join(P)}</g>
</svg>
</div>
</div>
<script>
(function(){{
  var box=document.getElementById('box'),c=document.getElementById('rain'),bC=document.getElementById('b-classic'),bM=document.getElementById('b-matrix'),svg=document.getElementById('flow');
  var x=c.getContext('2d'),chars='ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'.split(''),fs=14,cols,drops,W,H,timer=null;
  var calm=false;try{{calm=window.matchMedia('(prefers-reduced-motion: reduce)').matches}}catch(e){{}}
  if(calm&&svg&&svg.pauseAnimations)svg.pauseAnimations();
  function size(){{var r=box.getBoundingClientRect();W=c.width=Math.max(300,r.width);H=c.height=Math.max(200,r.height);cols=Math.floor(W/fs);drops=[];for(var i=0;i<cols;i++)drops[i]=Math.random()*H/fs;}}
  function step(){{x.fillStyle='rgba(0,0,0,.09)';x.fillRect(0,0,W,H);x.font=fs+'px monospace';
    for(var i=0;i<cols;i++){{x.fillStyle=Math.random()>.97?'#d8ffe0':'#00ff41';x.fillText(chars[Math.floor(Math.random()*chars.length)],i*fs,drops[i]*fs);
      if(drops[i]*fs>H&&Math.random()>.975)drops[i]=0;drops[i]+=.5;}}}}
  function stop(){{if(timer){{clearInterval(timer);timer=null;}}}}
  function start(){{stop();size();x.fillStyle='#000';x.fillRect(0,0,W,H);for(var k=0;k<90;k++)step();if(!calm)timer=setInterval(step,60);}}
  function setMode(m){{var mx=m==='matrix';box.classList.toggle('mx',mx);bC.setAttribute('aria-pressed',String(!mx));bM.setAttribute('aria-pressed',String(mx));
    if(mx)start();else stop();try{{localStorage.setItem('flow-look',m)}}catch(e){{}}}}
  bC.addEventListener('click',function(){{setMode('classic')}});bM.addEventListener('click',function(){{setMode('matrix')}});
  window.addEventListener('resize',function(){{if(box.classList.contains('mx'))start();}});
  var saved=null;try{{saved=localStorage.getItem('flow-look')}}catch(e){{}}
  if(saved==='classic')setMode('classic');else setMode('matrix');
}})();
</script>
<script>
(function(){{
  var calm=false;try{{calm=window.matchMedia('(prefers-reduced-motion: reduce)').matches}}catch(e){{}}
  if(calm)return;
  var per={{avg:[1.3,0.42],high:[1.5,0.18],expl:[1.8,0.09],review:[1.9,0.06]}},tot={{avg:0,high:0,expl:0,review:0}};
  function put(id,v){{var t=document.getElementById('sv-'+id);if(t)t.textContent='saved $ '+v.toFixed(2);}}
  Object.keys(per).forEach(function(k){{setInterval(function(){{tot[k]+=per[k][1];put(k,tot[k]);put('coder',tot.avg+tot.high);}},per[k][0]*1000);}});
}})();
</script>
{('<script>'+js+'</script>') if js else ''}
'''
open(OUT,'w').write(body)
print(len(body))


# ---------------------------------------------------------------- script-free SVG for a README
def write_svg(out):
    import random, re
    rnd = random.Random(7)
    STEP, STEPS = 1.3, 20          # one counter tick every 1.3 s, a 26 s loop
    inc = {'avg': (1, 0.42), 'high': (2, 0.36), 'expl': (2, 0.18), 'review': (4, 0.24)}   # (ticks per step, amount)
    def val(k, i):
        if k == 'coder': return val('avg', i) + val('high', i)
        every, amt = inc[k]
        return (i // every) * amt
    defs = ''.join(f'<path id="{k}" d="{v}"/>' for k, v in paths.items())
    clips, strips = '', {}
    nodes = ''.join(node(k) for k in order)
    def odometer(m):
        k, x, y = m.group(1), float(m.group(2)), float(m.group(3))
        nonlocal clips
        clips += f'<clipPath id="cl-{k}"><rect x="{x + 47}" y="{y - 11}" width="64" height="14"/></clipPath>'
        lines = ''.join(f'<text class="save" x="{x + 47}" y="{y + 14 * i}">{val(k, i):.2f}</text>' for i in range(STEPS))
        kt = ';'.join(f'{i / STEPS:.4f}' for i in range(STEPS))
        vv = ';'.join(f'0 {-14 * i}' for i in range(STEPS))
        anim = f'<animateTransform attributeName="transform" type="translate" calcMode="discrete" values="{vv}" keyTimes="{kt}" dur="{STEP * STEPS}s" repeatCount="indefinite"/>'
        return f'<text class="save" x="{x}" y="{y}">saved $</text><g clip-path="url(#cl-{k})"><g>{lines}{anim}</g></g>'
    nodes = re.sub(r'<text class="save" id="sv-(\w+)" x="([\d.]+)" y="([\d.]+)"[^>]*>saved \$ 0\.00</text>',
                   lambda m: odometer(m) if m.group(1) in inc or m.group(1) == 'coder' else m.group(0).replace(' id="sv-' + m.group(1) + '"', ''), nodes)
    links = ''.join(f'<use href="#{k}" class="link{" idle" if k == "p-sent" else ""}"/>' for k in paths)
    glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
    rain = ''
    for c in range(40):
        x = 6 + c * 24
        dur = rnd.uniform(7, 15)
        chars = ''.join(f'<tspan x="{x}" dy="15">{rnd.choice(glyphs)}</tspan>' for _ in range(18))
        rain += (f'<text class="rn" x="{x}" y="0" fill="url(#fade)">{chars}'
                 f'<animateTransform attributeName="transform" type="translate" from="0 -280" to="0 560" dur="{dur:.1f}s" begin="-{rnd.uniform(0, dur):.1f}s" repeatCount="indefinite"/></text>')
    css = """
svg{--node:rgba(0,14,4,.88);--ink:#9dffb5;--mute:#2fbf55;--line:#12702a;--ok:#00ff41;--ok-bg:#063d14;--brief:#00ff41;--patch:#ffd166;--ask:#d8ffe0;--ask-bg:#0b3a18;--off:#1f7a38;--off-bg:#061a0b;--oval-line:#eaffef}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.rn{font-size:14px;opacity:.5}
.mute{fill:var(--mute)}.save{font-size:10.5px;font-weight:700;fill:var(--brief)}
rect,.ring{rx:0;ry:0}
.node{fill:var(--node);stroke:var(--ok);stroke-width:1.5}
.node.off{stroke:var(--off);stroke-dasharray:4 3}
.oval{fill:var(--node);stroke:var(--oval-line);stroke-width:1.6;filter:drop-shadow(0 0 4px #d8ffe0)}
.ring{fill:none;stroke:var(--ok);stroke-width:1.2;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3s ease-out infinite}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.08,1.16)}}
.pill{fill:var(--ok-bg);stroke:var(--ok);stroke-width:1}.pill.off{fill:var(--off-bg);stroke:var(--off)}
.pilltxt{fill:var(--ok);font-size:9.5px;font-weight:700}.pilltxt.off{fill:var(--off)}
.link{fill:none;stroke:var(--line);stroke-width:1.3}.link.idle{stroke-dasharray:3 5}
.dot.brief,.halo.brief{fill:var(--brief)}.dot.patch,.halo.patch{fill:var(--patch)}.dot.ask,.halo.ask{fill:var(--ask)}
.halo{opacity:.35}.ci{display:none}
.nm{font-size:12.5px;font-weight:700;fill:var(--ok)}.dim{font-size:10px}
"""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 520" width="960" height="520" role="img" aria-labelledby="t d">'
           '<title id="t">Main session, ai-coder, Jev and the two coder lanes</title>'
           '<desc id="d">The main session sends all code to ai-coder. ai-coder asks Jev, which decides between ai-coder-average (Cursor Composer) and ai-coder-high (the delegation service). Codex is used for reviews and the claim sentinel observes the main session. The saved dollars are theoretical.</desc>'
           f'<style>{css}</style><defs>{defs}<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff41" stop-opacity="0"/><stop offset="1" stop-color="#00ff41" stop-opacity="1"/></linearGradient>{clips}</defs>'
           f'<rect width="960" height="520" fill="#000"/><g>{rain}</g>{links}{nodes}<g>{"".join(P)}</g></svg>')
    open(out, 'w').write(svg)

if '--svg' in args:
    write_svg(args[args.index('--svg') + 1])
