#!/usr/bin/env node
// Stop hook — the final reply of a turn must be one card: a single blockquote, one marker per
// paragraph, one bold verdict.
//
// It exists because a reply the reader scrolls past is a reply that did not happen. The card shape
// is enforceable, so a hook enforces it instead of hoping the model remembers 60 lines of prompt.
// It is the mechanical half of the `ELI5` output style this plugin ships; the style describes the
// card, this hook refuses a reply that is not one.
//
// OFF BY DEFAULT, like every other hook here. `CARD_GUARD` is unset for most people and the hook
// exits immediately, before it reads anything: a Stop hook that blocked by default would refuse
// every ordinary reply of every person who installed this plugin.
//   CARD_GUARD=block   refuse what is not a card at all (no blockquote, HTML) and log the rest
//   CARD_GUARD=strict  refuse every fault
//   CARD_GUARD=log     never refuse, only write the ledger
//   CARD_GUARD=off     (default) do nothing
// Also off when `<data>/card-guard.off` exists (this machine) or `.claude/card-guard.off` exists in
// the working directory (this project only — for CI and `claude -p` pipelines).
//
// A refused reply stays on screen and the rewrite is added under it, so every refusal is a duplicate
// for the reader. That is why `block` refuses only a reply that is not a card at all.
//
// Every fault, refused or not, is appended to `<data>/card-guard.jsonl`, one JSON object per line.
// The hook always exits 0: a crash here must never cost a turn.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.env.CARD_GUARD || 'off';
if (!['block', 'strict', 'log'].includes(MODE)) process.exit(0);

const DATA_DIR = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'harness-data');
const LEDGER = process.env.CARD_GUARD_LEDGER || path.join(DATA_DIR, 'card-guard.jsonl');
if (fs.existsSync(path.join(DATA_DIR, 'card-guard.off'))
  || fs.existsSync(path.join(process.cwd(), '.claude', 'card-guard.off'))) process.exit(0);

// The two strings the card contract names. Override them to match the output style you actually run:
// a card written in another language needs its own title and its own default-answer phrase.
const TITLE = process.env.CARD_GUARD_TITLE || '> **👉 For you**';
const DEFAULT_PHRASE = process.env.CARD_GUARD_DEFAULT_PHRASE || 'If you say nothing';
const MARKER = '(🟢|🟡|🔴|⚠️?|▫️?|ℹ️?)';

const log = (entry, data = {}) => {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({
      ts: new Date().toISOString(), mode: MODE, session: data.session_id, cwd: process.cwd(), ...entry,
    }) + '\n');
  } catch { /* a ledger that cannot be written must not cost a turn */ }
};

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let data;
try { data = JSON.parse(raw); } catch { process.exit(0); }
if (data.stop_hook_active) process.exit(0);           // already rewriting because of a stop hook
if (!('last_assistant_message' in data)) {
  // Protocol changed, or an older CLI: fail open, but leave a trace so "it never fires" is diagnosable.
  log({ warning: 'last_assistant_message missing from the Stop input — the guard is inactive' }, data);
  process.exit(0);
}
const msg = (data.last_assistant_message || '').trim();
if (!msg) process.exit(0);

const lines = msg.split('\n').filter(l => l.trim());
const problems = [];
const hard = [];
const marked = m => lines.filter(l => new RegExp('^>\\s*' + m).test(l));

if (lines.some(l => !l.startsWith('>'))) {
  hard.push('every line of the reply belongs to one blockquote (each line starts with "> ")');
}

// HTML is refused because a chat client that renders Markdown only prints the tags as text.
// Only real tag names, and only outside code spans and fences: `<me@example.com>` and `Vec<T>` are not HTML.
const plain = msg.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
if (/<\/?(details|summary|div|span|p|br|b|i|u|em|strong|a|img|table|tr|td|th|ul|ol|li|h[1-6]|hr|pre|code|mark|section|style|script|iframe)\b[^>]*>/i.test(plain)) {
  hard.push('no HTML: the chat client prints the tags as plain text');
}

const first = lines[0].trim();
const opensWithTitle = first.startsWith(TITLE);
// A card opens with the title (when something needs a decision) or with a bold verdict on a marker:
// 🟢 a task done, ⚠️ the warning is the point, ▫️ an answer, an explanation, a finding.
if (!(opensWithTitle || /^>\s*(🟢|⚠️?|▫️?)\s*\*\*/.test(first))) {
  problems.push(`the first line is "${TITLE}" (when a 🟡 or a 🔴 is in the card) or a bold verdict on a marker: "> 🟢 **…**" (a task done), "> ▫️ **…**" (an answer, an explanation), "> ⚠️ **…**" (a warning)`);
}

// A paragraph start needs a marker. A wrapped line (no blank quote line before it) and fenced code do not.
const body = opensWithTitle ? lines.slice(1) : lines;
let inFence = false, prevBlank = true;
const unmarked = [];
for (const l of body) {
  const content = l.replace(/^>\s?/, '');
  if (content.trim().startsWith('```')) { inFence = !inFence; prevBlank = false; continue; }
  if (inFence) continue;
  if (!content.trim()) { prevBlank = true; continue; }
  if (prevBlank && !new RegExp('^(' + MARKER + '|\\|)').test(content.trim())) unmarked.push(l);
  prevBlank = false;
}
if (unmarked.length) {
  problems.push(`every paragraph of the card starts with a marker: 🟢 a task done · 🟡 you must decide · 🔴 blocked · ⚠️ you must read this · ▫️ information · ℹ️ a detail you can skip (the line at fault: "${unmarked[0].slice(0, 60)}")`);
}

if (marked('⚠️?').length > 2) problems.push('two ⚠️ lines per card at most, or the marker stops meaning anything');
const yellow = marked('🟡'), red = marked('🔴');
if (yellow.length > 1) problems.push('one 🟡 line per turn at most; the other open points go on the page, not in the card');
if (opensWithTitle && !yellow.length && !red.length) problems.push(`"${TITLE}" with no 🟡 or 🔴 line: open with the bold verdict instead (🟢, ▫️ or ⚠️)`);
if ((yellow.length || red.length) && !opensWithTitle) problems.push(`there is a 🟡 or 🔴 line, so the card opens with "${TITLE}"`);

// One bold verdict per card. The title line does not count, and bold inside a code span is not bold.
const boldText = lines.filter(l => !l.trim().startsWith(TITLE)).join('\n').replace(/`[^`]*`/g, '');
if ((boldText.match(/\*\*[^*\n]+\*\*/g) || []).length > 1) problems.push('one bold verdict per card; everything else in plain text');
// One 🟢 = one task. A very long 🟢 line is almost always several tasks glued together with semicolons.
if (marked('🟢').some(l => l.length > 260)) problems.push('one 🟢 line = one task; a 🟢 line over 260 characters merges several tasks — give each its own line');
if (yellow.length && !msg.includes(DEFAULT_PHRASE)) problems.push(`the 🟡 line says what happens with no answer: "${DEFAULT_PHRASE}: …" ("I wait" is a valid default)`);

const toBlock = MODE === 'strict' ? [...hard, ...problems] : MODE === 'block' ? hard : [];
const toLog = [...hard, ...problems].filter(p => !toBlock.includes(p));
if (toBlock.length || toLog.length) log({ blocked: toBlock, logged: toLog, head: msg.slice(0, 120) }, data);
if (toBlock.length) {
  console.log(JSON.stringify({
    decision: 'block',
    reason: 'The final reply is not a valid card — write it again: ' + toBlock.join(' ; ')
      + '. Shape: one blockquote, a marker at the start of every paragraph, one bold verdict.',
  }));
}
process.exit(0);
