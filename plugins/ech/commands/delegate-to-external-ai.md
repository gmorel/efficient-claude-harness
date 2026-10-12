---
description: Send a bounded coding, review, test-writing or analysis job to the delegation service — Claude Code running elsewhere, not this session — then verify the patch here
argument-hint: "what to do, and on which files — or nothing to be asked"
---

## Arguments received

`$ARGUMENTS`

# /ech:delegate-to-external-ai — hand this job to the delegation service

The delegation service is Claude Code running elsewhere, with the same models and effort levels you have.
It works on a throwaway copy of exactly the files you send it, and it **cannot run anything** — no tests, no build, no shell.
It edits and reasons; you execute and verify.

Load the `ech:delegate-heavy-reasoning` skill and follow it.
This file only settles what to do before and after.

## Refuse, and say why, when

- **The job is a binary or needs its output looked at** — recording, cutting or blurring a video, reading a screenshot. The service has no shell and gets text files only; sending a binary, or asking it to reason about one, burns tokens for nothing. Delegate only the CODE that does such work (a script, a harness flag), then run and check it here.
- The service is not configured — no `~/.config/claude-delegate/config.json` (or `DELEGATE_CONFIG`). Say so; do not guess a URL.
- The job needs a shell, a browser, the live repository, or iteration against real output. Do it here instead.
- The job is a one-line edit, or the files are small. The round trip costs more than the work. The rule is **source size ÷ summary size**: delegation pays when the files you would otherwise read here are large and the answer you need back is small.

## Before sending

1. **Name the files.** Every file the change touches, plus the ones it must stay consistent with. A file you omit is a file the worker will invent assumptions about. If you cannot name them, do not delegate.
2. **Write acceptance criteria.** The worker cannot ask you a question, so every ambiguity becomes an assumption in the patch. Say what must *not* change.
3. **Pick model and effort deliberately, and pass them** — `node "$S" submit … --model <haiku|sonnet|opus> --effort <low…max>` (omitted, the service default runs). `haiku` for mechanical work, `sonnet` for ordinary implementation, `opus` when judgment matters: a design choice, a subtle bug, a review of a risky diff, anything where a wrong assumption is expensive. Ask the user if the choice is not obvious from the task. The service maps each alias to a model; if the exact model matters, ask the worker to report its model id.
4. **Never include a credential.** No `.env`, key, token or certificate, and no file containing one. Hand that part back to the user.

If `$ARGUMENTS` does not name a task and its files, ask for both before doing anything.

## Choosing model and effort

Model is about how much judgment the task needs.
Effort is about **how many edge cases hide in it** — that is the axis that pays, not difficulty in general.

| Effort | Use it for |
| --- | --- |
| `low` | quick work you will read yourself straight away — sketching, an easy change, a first draft of a patch |
| `medium` | regular engineering: a new feature, an ordinary implementation. **The usual service default.** |
| `high` | anywhere verification matters or edge cases lurk — a bug in an unfamiliar codebase, auth, a migration, anything touching money or secrets |
| `max` | a hard problem you cannot check with a test command. Expensive in wall time. |

## The two-pass recipe — prefer this for anything non-trivial

Two cheap passes usually beat one expensive one, and when the service runs jobs in parallel a second pass costs wall time only.

1. **Write it.** `--model sonnet --effort low`. Fast, and you are about to read it anyway.
2. **Apply it here** — `apply --dry-run`, read it, apply.
3. **Run the real tests.** The service cannot. This is the step that makes the whole arrangement honest.
4. **Review it.** Send the *applied* diff back as a second job: `--profile review --model opus --effort high`. This pass is where effort earns its keep, because reviewing is exactly the edge-case hunt.

Skip pass 4 for a one-file cosmetic change.
Never skip pass 3.

## After it returns

1. `apply --dry-run` first, and read what it plans to touch.
2. Read every `NEW` file line by line before writing it. A new hook, CI file or script runs on this machine.
3. **Run the project's real tests.** This is the whole point of the arrangement — the worker could not, and said so.
4. If `apply` refuses because a local file changed after being sent, do **not** merge by hand. Redo the job.

## Report back

One short report.
Which model and effort ran · files edited, and which were `NEW` · the worker's own assumptions and what it said it could not verify · the test command you ran and its real output · what you did **not** check.

Never write that it works because the job says `succeeded`.
`succeeded` means the worker finished, not that the code is right.
