---
name: delegate-heavy-reasoning
description: Send a bounded coding, review, test-writing or analysis job to the delegation service instead of doing it in this conversation, and get back a patch you verify and apply locally. Use when a task needs several whole files in context and would otherwise burn the orchestrator's own window - "the delegation service", "send this to the delegation service", "delegate this", "offload this refactor", "have the remote agent review this diff". Do NOT use for a one-line edit, for anything needing a shell, a browser, tests, or the live repository, or when the service is not configured.
---

# Delegate heavy reasoning

The service is called **the delegation service**.
It is Claude Code running elsewhere (a deployment you operate), with the same models and effort levels you have.

The worker inside it is a Claude Code process with a **disposable copy** of the files you send it.
It can read, search and edit inside that copy.
It has **no shell, no tests, no network, no repository, and no memory of this conversation**.
It returns changed files.
You verify and apply them here.

Everything it does not receive, it does not know.
A file you forget is a file it will invent assumptions about.

## Before anything

The helper reads its configuration from `~/.config/claude-delegate/config.json` (or the path in `DELEGATE_CONFIG`):

```json
{ "baseUrl": "https://<service>", "apiKey": "<your key>" }
```

Never put the key in a prompt, a commit, a report, or this file.
If the file is missing, stop and tell the user the service is not configured — do not guess a URL.

## The three steps, in order

```bash
S="${CLAUDE_PLUGIN_ROOT}/scripts/delegate.mjs"

# 1. Send. Paths are relative to the repository root and are sent verbatim.
node "$S" submit --profile implement --task /tmp/task.md --files src/cart.ts,src/tax.ts,src/cart.test.ts [--model haiku|sonnet|opus] [--effort low|medium|high|max]

# 2. Wait. Artifacts land under .delegate/<job-id>/ and are NOT applied.
node "$S" wait <job-id>

# 3. Look, then apply. Never skip the look.
node "$S" apply <job-id> --dry-run
node "$S" apply <job-id>
```

Pass the model as an alias (`haiku`, `sonnet`, `opus`); what each alias runs is decided by the service, so ask the worker for its model id if it matters.

## Profiles

| Profile | Send it | You get back |
| --- | --- | --- |
| `implement` | Target files, the interfaces they import, the requirement, representative tests | Edited files plus a rationale |
| `review` | The diff, the complete affected functions, the callers that matter | Findings with location, severity and a failure scenario |
| `tests` | The behaviour, the implementation, the test config, one example test | New tests, plus the coverage gaps it could not fill |
| `analyse` | Constraints, relevant code, sanitised logs, what you already ruled out | Ranked hypotheses and the next check that would discriminate |

Write the task file yourself, with acceptance criteria.
"Fix the bug" returns a guess.

## Rules that are not negotiable

- **It never ran anything.** If the answer says tests pass, it is wrong; the worker has no way to run them. Run them here.
- **Verify before applying.** `apply` refuses when a local file changed after you sent it. Do not force it; re-send instead.
- **A created file is not a verified change.** Files the worker invented come back flagged `NEW`. Read every line of those before applying — a new `.git/hooks/*`, CI file or script is code that runs on your machine.
- **Respect the service's concurrency limit.** When it answers `429`, do something else or run it yourself; never poll in a loop waiting for a slot.
- **Two failed repair rounds, then stop** and investigate locally. A third round is usually a missing file, not a stubborn bug.
- **Do not paste file contents into your own conversation** to prepare a job. The helper reads the bytes from disk; that is the whole point.
