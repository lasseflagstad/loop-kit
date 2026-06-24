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
  `queued → in_progress → shipped`, with `blocked` reachable from `queued` and
  `in_progress`, and recoverable back to `queued`/`in_progress`.

## Job schema

```jsonc
{
  "id": "001",                 // immutable, zero-padded, assigned centrally
  "title": "Short title",      // immutable
  "spec": "What to build",     // immutable (text or a pointer to a spec file)
  "status": "queued",          // queued | in_progress | shipped | blocked
  "humanGated": false,         // additive: false -> true only
  "createdAt": "2026-06-24T00:00:00.000Z", // immutable
  "branch": null,              // set by the runner
  "pr": null,                  // PR number or URL, set when opened
  "headSha": null,             // head SHA the gate was confirmed against
  "shippedAt": null,           // set on ship
  "note": null                 // mutable free-form
}
```

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
