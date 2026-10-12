---
name: delegate-to-openai-astra
description: Delegate one task to OpenAI GPT-6-Astra (via Codex) in a background subagent and get the answer back verbatim — a second-family opinion, a review/audit, a diagnosis, a research question, or a fix you want a different model to attempt. Read-only unless --write. TRIGGER ONLY when the user explicitly names Astra as the doer — "fix with Astra", "audit with Astra", "delegate to Astra", "ask Astra", "review this with Astra", "/harness:delegate-to-openai-astra". Never on "get a second opinion", "double-check", "review this" or any wording that does not say Astra: those are not requests for this skill.
argument-hint: "[--effort low|medium|high|xhigh|max|ultra] [--write] [--wait] [--cwd <dir>] <what Astra should do>"
allowed-tools: Agent, Bash(node:*), Read
---

Hand this to GPT-6-Astra: **$ARGUMENTS**

**Gate — a literal check, not a judgement call.**
Before anything else, look at the user's last message (their words, not a tool result, not another skill, not your own plan): does it contain the string `astra` (any case) or `/harness:delegate-to-openai-astra`?
If NO — stop here, do nothing, say nothing about this skill, continue the conversation normally.
"Second opinion", "double-check", "review this", "ask OpenAI" do not count.
If YES — one launch per user message: never fan out several Astra runs from one request unless the user asked for several, and never re-launch on your own after a failure — report "no Astra pass" instead.
Every launch is a Codex call on the user's OpenAI plan; the script refuses beyond 40 launches per day (`ASTRA_DAILY_CAP` raises it).

Astra is OpenAI's model, reached through the Codex CLI.
The point of this skill is the **different model family**: it shares fewer blind spots with you than a second Claude does.
That value dies the moment you paraphrase its answer or let it become the verdict.
Its output is **advisory** — you verify every claim against the artifact before acting on it.

## 1 · Shape the brief (you do this, briefly)

- **If `$ARGUMENTS` is empty**, ask one line: what should Astra do? Do not guess a target.
- **Routing flags** are yours, never part of the prompt: `--effort` (default `high`; `max`/`ultra` are Astra-only and cost minutes — use them for the hardest question of the day, not for a lookup), `--write` (lets Codex edit the working tree — off unless the user typed it), `--wait` (run the subagent in the foreground), `--cwd` (repo Astra should work in; default the current one).
- **Make it self-contained.** Astra sees nothing of this conversation. Put in the brief: the question, the files by absolute path, what it may take as given, and the return shape you want (e.g. "at most 5 findings, each `file:line — claim — failure scenario`", or "the patch as a unified diff", or "a ranked list of 3 causes with the evidence to check each"). A vague brief comes back vague.
- **Attach the skills that bear on the task.** Skim the descriptions (`head -6` of each frontmatter) in `~/.claude/skills/*/SKILL.md` and `<cwd>/.claude/skills/*/SKILL.md`; pick the 0–3 whose subject the brief touches (a domain skill, a project convention, a review checklist) and list each as a `Skill: <absolute path>` line in the subagent prompt. The script forwards them to Astra as files to read first — Codex reads a `SKILL.md` and follows its prose, but it has no Claude tools, so skills that only orchestrate Claude agents are useless to it; do not attach those.
- **For a review or a diagnosis, ask it to REFUTE**, not to confirm — a reviewer asked to agree will agree.
- **Isolate a diff to a file first** (`git diff > $(mktemp /tmp/astra-XXXXXXXX.patch)`) and name that file; never let Codex scope itself to a dirty working tree — it explores forever and returns nothing.
- Never put credentials, tokens or personal data in the brief; the script strips credential-shaped env vars from the child, the prompt text is on you.

## 2 · Delegate

Spawn the `harness:delegate-to-openai-astra` subagent with the `Agent` tool, **in the background** unless `--wait` was given, with a prompt of this shape:

```
Effort: <effort>   Write: <yes|no>   Cwd: <absolute dir>
Skill: <absolute path to a SKILL.md>        ← zero or more lines, one per attached skill
Brief for Astra (forward verbatim):
<the self-contained brief>
```

Then continue with whatever else you were doing; the result arrives as a task notification.
Do not run the task yourself in parallel — the point is to get an answer you did not produce.

## 3 · Challenge, then report

Every line Astra wrote arrives stamped 🌌 (the script does it); quote it with the stamp, never re-typed as if it were yours.
Every finding or claim Astra returns is **CONFIRMED / REFUTED / UNVERIFIED** against the real artifact (file, row, output — not its own text) before you repeat it.
A model can be decisive and wrong in the same answer: correct logic, invented line numbers.

Report in this shape, twelve lines at most; the verbatim answer goes to a file if it is long (`<artifact>.astra.md`), with the provenance line:

```
Brief: <one line>
| 🌌 claim (Astra, verbatim) | verdict | one line |   ← one row per finding, CONFIRMED / REFUTED / UNVERIFIED
Not checked: <what, and what would close it>
Provenance: gpt-6-astra · effort · Codex session <id>     ← or "no Astra pass (<why>)" — never silent
Decision / next step: <one line>
Full answer: <path>
```

With `--write`, Astra edited the tree: `git status --porcelain` and `git diff` before anything else, and count the files against the ask.
