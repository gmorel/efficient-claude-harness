#!/usr/bin/env node
// Load the built page twice, JavaScript off and on, and compare every box state in the tree at arrival (before any replay).
// Exit 1 on any mismatch, 2 when no browser is available (never a silent pass).
//   node check-states.mjs [page.html]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VIZ_OUT } from './lib.mjs';

const page = process.argv[2] || VIZ_OUT;
// playwright-core is not a dependency of this plugin. VIZ_PLAYWRIGHT names a copy you already have
// somewhere; otherwise the bare import is tried, and a miss exits 2 (could not check), never 1 (differs).
const lib = [process.env.VIZ_PLAYWRIGHT].filter(Boolean).find(p => fs.existsSync(p));
let chromium;
try { ({ chromium } = await import(lib ?? 'playwright-core')); } catch { console.error('check-states: playwright-core not found, states NOT compared'); process.exit(2); }
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => null);
if (!browser) { console.error('check-states: no Chrome, states NOT compared'); process.exit(2); }
const read = async js => {
  const ctx = await browser.newContext({ javaScriptEnabled: js });
  const p = await ctx.newPage();
  await p.goto('file://' + path.resolve(page));
  if (js) await p.waitForFunction(() => document.documentElement.dataset.statesReady === '1', null, { timeout: 15000 });
  const r = await p.evaluate(() => ({
    tree: Object.fromEntries([...document.querySelectorAll('#stage .bx')].map(b => [b.dataset.box, (b.className.match(/\bst-(\w+)/) || [])[1]])),
    cards: Object.fromEntries([...document.querySelectorAll('#stage .bx')].map(b => [b.dataset.box, [b.querySelector('.bx-last')?.textContent, b.querySelector('.bx-u')?.textContent, b.querySelector('.bx-nudge')?.textContent || ''].join(' | ')])),
    nudges: [...document.querySelectorAll('#nudges tbody tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').trim()),
    table: Object.fromEntries([...document.querySelectorAll('#sum tbody tr')].map(tr => [tr.dataset.box, (tr.className.match(/\bst-(\w+)/) || [])[1]])),
  }));
  await ctx.close();
  return r;
};
const off = await read(false), on = await read(true);
await browser.close();
const ids = Object.keys(off.tree);
const bad = ids.filter(id => off.tree[id] !== on.tree[id]);
const tableBad = ids.filter(id => off.table[id] !== off.tree[id]);
console.log(JSON.stringify({ boxes: ids.length, table_rows: Object.keys(off.table).length, states: off.tree, mismatches: bad.map(id => ({ box: id, js_off: off.tree[id], js_on: on.tree[id] })), table_vs_tree_mismatch: tableBad }));
const nTable = Object.keys(off.table).length;
const cardBad = ids.filter(id => off.cards[id] !== on.cards[id]).map(id => ({ box: id, js_off: off.cards[id], js_on: on.cards[id] }));
const nudgeBad = off.nudges.length !== on.nudges.length || off.nudges.some((r, i) => r !== on.nudges[i]);
console.log(JSON.stringify({ nudge_rows_js_off: off.nudges.length, nudge_rows_js_on: on.nudges.length, nudge_rows_differ: nudgeBad, card_text_mismatches: cardBad }));
process.exit(bad.length || tableBad.length || nTable !== ids.length || nudgeBad || cardBad.length ? 1 : 0);
