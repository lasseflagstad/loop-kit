# `.loop/` - the job queue

This directory holds the loop's work queue. `queue.json` is an **append-only
ledger** of jobs. The queue library (`scripts/loop/queue-lib.mjs`) enforces that
discipline in code:

- **Never delete a job.** There is no remove operation. Abandoned work moves to
  `blocked`, it does not disappear.
- **Never rewrite an immutable field.** `id`, `title`, `spec`, and `createdAt`
  are fixed at creation.
- **Never un-gate a job.** `humanGated` may go `false → true`, never back.
- **Never rewrite a shipped job.** Once `status` is `shipped`, the record is
  frozen.
- **Status only moves along the allowed graph:**
  `proposed → queued → in_progress → shipped`, with `blocked` reachable from
  `proposed`, `queued`, and `in_progress`, and recoverable back to
  `queued`/`in_progress`.

## Statuses

- `proposed` - written by the scout (`/scout`), a read-only job-proposer. A
  proposed job is **not runnable**: the runner only ever picks `queued` jobs, so
  a proposal cannot be built until a human promotes it (by changing its status
  from `proposed` to `queued`). The scout may only ADD proposed jobs; it never
  edits or removes a `queued`/`in_progress`/`blocked`/`shipped` job.
- `queued` - approved and waiting for the runner.
- `in_progress` - the runner is building it.
- `shipped` - merged on a green gate; the record is frozen.
- `blocked` - parked; recoverable to `queued`/`in_progress`.

## Job schema

```jsonc
{
  "id": "001",                 // immutable, zero-padded, assigned centrally
  "title": "Short title",      // immutable
  "spec": "What to build",     // immutable (text or a pointer to a spec file)
  "status": "queued",          // proposed | queued | in_progress | shipped | blocked
  "humanGated": false,         // additive: false -> true only
  "createdAt": "2026-06-24T00:00:00.000Z", // immutable
  "branch": null,              // set by the runner
  "pr": null,                  // PR number or URL, set when opened
  "headSha": null,             // head SHA the gate was confirmed against
  "shippedAt": null,           // set on ship
  "note": null                 // mutable free-form
}
```

A `proposed` job carries one extra field, the structured proposal the scout
based it on:

```jsonc
{
  // ...the standard fields above, with "status": "proposed"...
  "proposal": {
    "check": "testsForSources",          // which scout check found it
    "fingerprint": "testsForSources:scripts/loop/queue-cli.mjs", // de-dup key
    "description": "Plain-English why",   // also rendered into `spec`
    "requirements": ["diff-checkable...", "..."], // what "done" looks like
    "evidence": { "check": "...", "file": "...", "line": 12, "excerpt": "...", "occurrences": 1 },
    "impactEffort": "Impact: ... Effort: ..."
  }
}
```

The same content is rendered into the job's `spec`, so promoting a proposal to
`queued` gives the runner a complete, diff-checkable brief.

## Adding a job

Use the CLI (it only ever appends):

```sh
node scripts/loop/queue-cli.mjs add --title "Add health endpoint" \
  --spec "Expose GET /healthz returning 200 ok"
# add --human-gated for jobs that must be approved before they ship
```

List jobs, or see what the runner would pick next:

```sh
node scripts/loop/queue-cli.mjs list
node scripts/loop/queue-cli.mjs next   # skips human-gated jobs
```

## `decisions.json` - the two-way decisions ledger

`decisions.json` is a second append-only ledger, same discipline as the queue.
The loop is fire-and-forget: a scheduled run cannot pause and wait for you to
reply. So the two non-merge decisions it might need (approve a proposed job, or
give a go-ahead on a human-gated one) are handled **asynchronously**: the runner
records a question and notifies you, you answer in your own time, and the next
run reads your answer and acts on it.

It never touches the merge gate. An approved human-gated job still goes through
the human gate at merge time; an approval only records the go-ahead to BUILD.

### Decision schema

```jsonc
{
  "id": "001",                 // immutable, zero-padded, assigned centrally
  "key": "promote:002",        // immutable; makes a question ask-once (kind:job)
  "kind": "promote",           // "promote" (proposed job) | "go-ahead" (human-gated)
  "job": "002",                // the job this decision is about
  "question": "Proposed job 002 ... How to answer: ...",  // plain English + how
  "answers": ["approve", "skip"],  // the allowed answers
  "answer": null,              // null until you reply; then frozen
  "askedAt": "2026-06-24T00:00:00.000Z",  // immutable
  "answeredAt": null,          // set when you answer
  "appliedAt": null            // set when the next run acts on the answer
}
```

### Answering a decision

The always-available way, no GitHub needed:

```sh
node scripts/loop/decisions-cli.mjs list                 # see open decisions
node scripts/loop/decisions-cli.mjs answer 001 approve   # approve / skip by id
```

If `decisions.inbox` is set in `loop.config.json`, you can instead append a
one-line reply (`<decision-id> <answer>`, blank lines and `#` comments ignored)
to that file from the notify channel; the next `apply` reads and records it.
Editing `decisions.json` by hand works too. Acting on an answer is idempotent.
