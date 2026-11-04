// Replay and live follow for harness-dashboard.html.
// stateOf, makeIndex, countsAt and sparkSvg are injected above this file by build.mjs from the same source the static summary used.
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const M = JSON.parse(document.getElementById('meta').textContent);
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.dataset.theme = theme;
  const OUT = ['ok', 'warn', 'degraded', 'fail', 'start'];
  const STATE_LABEL = { working: 'working', failing: 'not working', degraded: 'degraded', dead: 'dead', idle: 'idle' };
  const BX = M.boxes;
  const boxIdx = Object.fromEntries(BX.map((b, i) => [b.id, i]));
  const T = [], B = D.b, O = D.o, K = D.k, DT = D.d, F = D.f, N = D.n, STR = D.s;
  const strIdx = new Map(STR.map((s, i) => [s, i]));
  let acc = D.t0; for (const d of D.dt) { acc += d; T.push(acc * 1000); }
  const U = K.map(k => STR[k] === 'done' ? 0 : 1);
  const IX = makeIndex(T, B, O, N, BX.length, U);
  // global prefix sums for the status bar
  const P = { ok: [0], fail: [0], any: [0] };
  const pushP = i => { P.any.push(P.any.at(-1) + N[i]); P.ok.push(P.ok.at(-1) + (O[i] === 0 || O[i] === 1 ? N[i] : 0)); P.fail.push(P.fail.at(-1) + (O[i] === 3 ? N[i] : 0)); };
  for (let i = 0; i < T.length; i++) pushP(i);

  const $ = id => document.getElementById(id);
  const els = BX.map(b => $('bx-' + b.id));
  const stage = $('stage'), edges = $('edges'), logEl = $('log');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // arrive at the build time itself, so the tree shows exactly the states the static summary computed with the same functions
  let end = M.now, start = M.defStart, C = end, ptr = 0, arrived = true;
  let playing = false, speed = 600, skip = true, live = false, es = null, lastWall = 0, lastBoxUpdate = 0, skipNote = '';

  const p2 = n => String(n).padStart(2, '0');
  const fmt = (ms, sec) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` + (sec ? ':' + p2(d.getSeconds()) : ''); };
  const ago = (ms, now) => { if (ms == null) return 'never'; const s = (now - ms) / 1000;
    return s < 90 ? Math.max(0, Math.round(s)) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  const fmtDur = ms => ms < 3600e3 ? Math.round(ms / 60e3) + ' min' : ms < 864e5 ? (ms / 3600e3).toFixed(1) + ' h' : (ms / 864e5).toFixed(1) + ' days';
  const ub = v => { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= v) lo = m + 1; else hi = m; } return lo; };
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function updateBoxes() {
    for (let i = 0; i < BX.length; i++) {
      const el = els[i]; if (!el) continue;
      const c = countsAt(IX[i], C), st = stateOf(c, BX[i].expected);
      el.className = el.className.replace(/\bst-\w+/, 'st-' + st);
      el.querySelector('.chip').textContent = STATE_LABEL[st];
      el.querySelector('.bx-last').textContent = c.last != null ? 'last used ' + ago(c.last, C) : 'never in the data';
      const u = el.querySelector('.bx-u'); if (u) u.textContent = '30 d: ' + c.use30.toLocaleString('en-US') + ' ' + (/agent|engine|oncall/.test(BX[i].group) ? 'runs' : 'events');
      el.querySelector('.bx-24').textContent = c.any24.toLocaleString('en-US') + '/24h';
      const mx = Math.max(1, ...c.hours);
      const bars = el.querySelectorAll('.bars i');
      c.hours.forEach((h, k) => { if (bars[k]) bars[k].style.height = (h ? Math.max(8, Math.round(100 * Math.sqrt(h / mx))) : 0) + '%'; });
    }
  }
  function rowHtml(i) {
    const o = OUT[O[i]];
    return `<div class="lr o-${o}"><span class="lt">${fmt(T[i], true).slice(5)}</span><span class="ls">${esc(BX[B[i]].label)}</span><span class="lk">${esc(STR[K[i]].replace(/-/g, ' '))}</span><span class="ld">${esc(STR[DT[i]])}</span><span class="lo">${o}</span></div>`;
  }
  const head = logEl.querySelector('.lh').outerHTML;
  function rebuildLog() {
    const from = Math.max(0, ptr - 60);
    let h = head; for (let i = from; i < ptr; i++) h += rowHtml(i);
    logEl.innerHTML = h; logEl.scrollTop = logEl.scrollHeight;
  }
  function appendLog(i) {
    logEl.insertAdjacentHTML('beforeend', rowHtml(i));
    while (logEl.children.length > 301) logEl.children[1].remove();
  }
  // The onion stage is zoomed to fit the window. getBoundingClientRect reports zoomed pixels,
  // while the .edges SVG draws in the stage's own unzoomed pixels, so every measurement is
  // divided back out — otherwise every edge lands short of its box as soon as the window narrows.
  const zoomOf = () => parseFloat(getComputedStyle(stage).zoom) || 1;
  function center(el) {
    const k = zoomOf(), s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: (r.left - s.left + r.width / 2) / k, y: (r.top - s.top + r.height / 2) / k };
  }
  // An event with a source box is a task handed from one part of the harness to another, so it
  // is drawn as one: the edge lights up and a packet rides along it. The packet is what makes a
  // delegation legible at a glance — the line alone reads as a static diagram.
  let pktSeq = 0;
  function edge(fromBox, toBox, o) {
    if (reduce || fromBox < 0 || !els[fromBox] || !els[toBox] || edges.childElementCount > 40) return;
    const a = center(els[fromBox]), b = center(els[toBox]);
    const my = (a.y + b.y) / 2;
    const NS = 'http://www.w3.org/2000/svg';
    const id = 'pk' + (pktSeq = (pktSeq + 1) % 100000);
    const g = document.createElementNS(NS, 'g');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('id', id);
    p.setAttribute('d', `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`);
    p.setAttribute('class', 'edge e-' + o);
    g.appendChild(p);

    // halo first, core on top: two circles on the same path read as one glowing packet
    const starts = [];
    for (const cls of ['pkt-halo', 'pkt-core']) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', cls === 'pkt-halo' ? 7 : 3);
      c.setAttribute('class', 'pkt ' + cls + ' p-' + o);
      const m = document.createElementNS(NS, 'animateMotion');
      m.setAttribute('dur', '0.62s');
      // "0s" means 0s on the DOCUMENT timeline, which is long past by the time this node is
      // inserted, so the packet would appear already frozen at the end. Start it by hand instead.
      m.setAttribute('begin', 'indefinite');
      m.setAttribute('fill', 'freeze');
      m.setAttribute('keyPoints', '0;1');
      m.setAttribute('keyTimes', '0;1');
      m.setAttribute('calcMode', 'spline');
      m.setAttribute('keySplines', '0.3 0 0.2 1');
      const mp = document.createElementNS(NS, 'mpath');
      mp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + id);
      mp.setAttribute('href', '#' + id);
      m.appendChild(mp);
      c.appendChild(m);
      g.appendChild(c);
      starts.push(m);
    }
    edges.appendChild(g);
    for (const m of starts) m.beginElement();
    p.style.setProperty('--len', p.getTotalLength());
    setTimeout(() => g.remove(), 1000);
  }
  function pulse(bi, o) {
    const el = els[bi]; if (!el) return;
    el.classList.remove('hit', 'hit-fail'); void el.offsetWidth;
    el.classList.add(o === 'fail' ? 'hit-fail' : 'hit');
  }
  function fire(i, animate) {
    appendLog(i);
    if (animate) { const o = OUT[O[i]]; pulse(B[i], o); edge(F[i], B[i], o); }
  }
  function ui() {
    $('cursor').textContent = 'cursor ' + fmt(C, true);
    $('sFrom').textContent = fmt(start); $('sTo').textContent = fmt(end);
    const span = Math.max(1, end - start);
    if (document.activeElement !== $('scrub')) $('scrub').value = String(Math.round(Math.max(0, Math.min(1, (C - start) / span)) * 1000));
    const lo = ub(start - 1), hi = ptr;
    $('stPeriod').textContent = `period ${fmt(start)} → ${fmt(C)}`;
    $('stEv').textContent = `${(P.any[hi] - P.any[lo]).toLocaleString('en-US')} events`;
    $('stOk').textContent = `${(P.ok[hi] - P.ok[lo]).toLocaleString('en-US')} ok`;
    $('stFail').textContent = `${(P.fail[hi] - P.fail[lo]).toLocaleString('en-US')} failed`;
    const where = arrived ? ', showing the build time' : C >= end ? ', at the end of the period (play restarts from the start)' : '';
    $('stSpeed').textContent = live ? 'LIVE, following the ledgers' : `speed ×${speed}, ${playing ? 'playing' : 'paused'}${skip ? ', quiet gaps skipped' : ''}${where}${skipNote ? ' (' + skipNote + ')' : ''}`;
  }
  function seek(t) {
    arrived = false;
    C = Math.max(start, Math.min(end, t)); ptr = ub(C);
    rebuildLog(); updateBoxes(); ui();
  }
  function redrawSpark() { $('sparkwrap').innerHTML = sparkSvg(T, O, N, start, end, 240); }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min(250, now - (lastWall || now)); lastWall = now;
    let nc = C + dt * speed;
    if (skip && ptr < T.length && T[ptr] - C > Math.max(5 * 60e3, speed * 3000)) {
      const target = T[ptr] - speed * 300;
      if (target > nc) { skipNote = 'skipped ' + fmtDur(target - C) + ' of silence'; nc = target; }
    }
    if (nc >= end) { nc = end; playing = false; $('play').textContent = '▶ play'; }
    let fired = 0;
    const pulsed = new Set();
    while (ptr < T.length && T[ptr] <= nc) {
      const i = ptr++;
      const busy = fired++ > 30;
      const key = B[i] + ':' + O[i];
      fire(i, !busy || (O[i] === 3 && !pulsed.has(key)));
      pulsed.add(key);
    }
    if (fired) logEl.scrollTop = logEl.scrollHeight;
    C = nc;
    if (now - lastBoxUpdate > 200 || !playing) { updateBoxes(); lastBoxUpdate = now; }
    ui();
    if (playing) requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    arrived = false;
    if (on && C >= end - 1000) seek(start);
    playing = on; lastWall = 0; skipNote = '';
    $('play').textContent = on ? '❚❚ pause' : '▶ play';
    ui();
    if (on) requestAnimationFrame(frame);
  }

  $('play').addEventListener('click', () => setPlaying(!playing));
  document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
    speed = +b.dataset.speed;
    document.querySelectorAll('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    ui();
  }));
  $('skip').addEventListener('click', () => {
    skip = !skip; $('skip').setAttribute('aria-pressed', String(skip));
    $('skip').textContent = 'skip quiet gaps: ' + (skip ? 'on' : 'off'); skipNote = ''; ui();
  });
  $('next').addEventListener('click', () => {
    arrived = false;
    if (ptr >= T.length || T[ptr] > end) seek(start);           // at the end: wrap to the start of the period
    if (ptr < T.length && T[ptr] <= end) { C = T[ptr]; fire(ptr, true); ptr++; logEl.scrollTop = logEl.scrollHeight; }
    updateBoxes(); ui();
  });
  $('prev').addEventListener('click', () => {
    const target = ptr >= 2 ? T[ptr - 2] : start;
    seek(target);
    if (ptr > 0 && ptr - 1 >= 0) { const i = ptr - 1; pulse(B[i], OUT[O[i]]); edge(F[i], B[i], OUT[O[i]]); }
  });
  $('scrub').addEventListener('input', e => { if (live) return; seek(start + (+e.target.value / 1000) * (end - start)); });
  $('start').addEventListener('change', e => {
    const t = new Date(e.target.value).getTime();
    if (!isFinite(t)) return;
    start = Math.min(t, end - 60e3); redrawSpark(); seek(start);
  });
  addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input')) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 'ArrowRight') $('next').click();
    if (e.key === 'ArrowLeft') $('prev').click();
  });
  // ── layout: onion (default) or the top-down tree ──
  const ONION_W = 1180;
  function fit() {
    const host = stage.parentElement;
    const room = host ? host.clientWidth : ONION_W;
    stage.style.setProperty('--fit', stage.classList.contains('onion') && room < ONION_W
      ? Math.max(0.55, room / ONION_W).toFixed(3) : '1');
  }
  const layoutBtn = $('layout');
  function setLayout(onion) {
    stage.classList.toggle('onion', onion);
    if (layoutBtn) { layoutBtn.setAttribute('aria-pressed', String(onion)); layoutBtn.textContent = 'layout: ' + (onion ? 'onion' : 'tree'); }
    edges.innerHTML = ''; fit();
    try { localStorage.setItem('harness-layout', onion ? 'onion' : 'tree'); } catch {}
  }
  let wantOnion = stage.classList.contains('onion');
  try { const saved = localStorage.getItem('harness-layout'); if (saved) wantOnion = saved === 'onion'; } catch {}
  setLayout(wantOnion);
  layoutBtn?.addEventListener('click', () => setLayout(!stage.classList.contains('onion')));

  addEventListener('resize', () => { edges.innerHTML = ''; fit(); });

  // ── LIVE: only when served by serve.mjs, never from a file ──
  function ingest(ev) {
    const b = boxIdx[ev.box]; if (b == null) return;
    const s = v => { v = v || ''; let i = strIdx.get(v); if (i == null) { i = STR.length; STR.push(v); strIdx.set(v, i); } return i; };
    const t = Math.max(ev.t, T.length ? T[T.length - 1] : ev.t);
    T.push(t); B.push(b); O.push(Math.max(0, OUT.indexOf(ev.outcome))); K.push(s(ev.kind)); DT.push(s(ev.detail));
    F.push(ev.from != null && boxIdx[ev.from] != null ? boxIdx[ev.from] : -1); N.push(ev.n || 1);
    const i = T.length - 1, x = IX[b], n = N[i], o = O[i];
    U.push(ev.kind === 'done' ? 0 : 1);
    x.t.push(t); x.o.push(o); x.any.push(x.any.at(-1) + n); x.use.push(x.use.at(-1) + (U[i] ? n : 0)); x.runs.push(x.runs.at(-1) + (o === 4 ? 0 : n));
    x.fail.push(x.fail.at(-1) + (o === 3 ? n : 0)); x.deg.push(x.deg.at(-1) + (o === 2 ? n : 0));
    pushP(i);
    if (live) { end = Math.max(end, t, Date.now()); C = end; fire(i, true); ptr = i + 1; logEl.scrollTop = logEl.scrollHeight; updateBoxes(); ui(); }
  }
  function setLive(on) {
    live = on; $('live').setAttribute('aria-pressed', String(on)); $('live').textContent = 'LIVE: ' + (on ? 'on' : 'off');
    if (on) {
      setPlaying(false);
      es = new EventSource('events');
      es.onmessage = m => { try { ingest(JSON.parse(m.data)); } catch {} };
      end = Date.now(); seek(end);
      const tick = () => { if (!live) return; end = Date.now(); C = end; updateBoxes(); ui(); setTimeout(tick, 1000); };
      tick();
    } else if (es) { es.close(); es = null; ui(); }
  }
  if (/^https?:$/.test(location.protocol)) {
    fetch('health', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.harnessDashboard) return;
      $('live').hidden = false;
      $('live').addEventListener('click', () => setLive(!live));
    }).catch(() => {});
  }

  seek(C); arrived = true; ui();
  document.documentElement.dataset.statesReady = '1';
})();
