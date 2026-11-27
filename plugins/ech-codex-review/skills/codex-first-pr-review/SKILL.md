---
name: codex-first-pr-review
description: Review a pull request head in two steps. Codex reads the whole diff first (read-only, through the sol-reviewer agent), then a fresh reviewer checks only Codex's findings and the project's hard invariants. Use when asked to review a PR or a head SHA before merge. Read-only, advisory, no push, no merge, no comment.
---

# Codex-first PR review

Review by SHA, before or without a PR.
The review is read-only: no push, no merge, no GitHub comment, no secrets or customer data in any message.
The verdict goes to whoever asked for the review.

## Project rules plug in here, not in this skill

Hard invariants belong to the project, not to this plugin.
Read them from the first of these that exists:
1. `.claude/pr-review-invariants.md` in the project root (one invariant per line).
2. The `Invariants` section of `AGENTS.md` at the project root.
If neither exists, ask the requester for the invariants. Never invent them.

## Step 1 — Codex reads the whole diff (read-only)

Use the `ech-codex-review:sol-reviewer` agent.
Never `--write`, never `codex-rescue`, never `transfer`.

- **Codex must read the head, not your worktree.** Export the head with `git archive`: `mkdir <scratch>/head-<sha> && git archive <head> | tar -x -C <scratch>/head-<sha>`, copy the current `AGENTS.md` into it, and run the reviewer from that folder.
  A reviewer that runs in a worktree on another commit reports "the file does not exist" about files that exist at the real head.
  Use `git archive`, not `git worktree add`: worktree metadata is shared between machines that share a disk.
- Give Codex the diff as a file: `git --no-pager diff --no-ext-diff --no-color <base>...<head> > <scratch>/<name>.patch`. Never review a dirty working tree.
- Codex reads `AGENTS.md` at the root of its working directory for the rules. Do not paste the rules in.
- Ask for at most 8 findings, each `file:line — severity — failure scenario`.
- Use `--effort high`. Use `xhigh` only for the path the project calls irreversible.
- If Codex is unavailable, stamp **"reviewed WITHOUT cross-model pass"** and fall back to step 2 on the whole diff. Never skip this silently.

## Step 2 — a fresh reviewer checks only the findings

Spawn a new read-only reviewer subagent with no memory of step 1 (your own diff reviewer, or the general-purpose agent told to stay read-only).
Give it exactly three things:
1. The Codex findings, verbatim.
2. The changed file list (`git diff --name-only <base>...<head>`), plus the base and head SHAs.
3. The invariants checklist from the project rules above.

It reproduces or rejects each finding at `file:line`, and checks each invariant on the changed files.
It reads the whole diff only when a finding needs it.
A finding it did not reproduce is not a finding.

## Step 3 — post the verdict

`CLEAR` or `NOT CLEAR`, plus the findings kept, each with `file:line` and severity (CRITICAL / MAJOR / MEDIUM / MINOR / LOW).
List the Codex findings that were dropped, with the reason.
Say what was not run.

## What does not change

Gates are read from the lane's own log file; no log means unverified.
A claim you did not check against the real artifact is not a verdict.
Codex findings stay advisory.
