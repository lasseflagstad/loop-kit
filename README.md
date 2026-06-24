# Loop Kit

A reusable, repo-agnostic autonomous loop. Drop it into any app and that repo
ships work the same proven way: a queue holds jobs, a runner builds one job at a
time, a self-enforcing green-gate decides what may merge, and a safety policy
keeps the dangerous edges under human control.

Everything in the kit is generalized. Nothing about any one app is hardcoded.
One file, `loop.config.json`, configures the kit for your repo.

The kit has no runtime dependencies. It is plain Node (>= 20) and the built-in
test runner, so it adds nothing to your repo's dependency tree.

## What is in the box

```
loop.config.json            the single point of per-repo configuration
loop.config.schema.json     JSON Schema for the config (editor validation)
.loop/
  queue.json                the append-only job queue
  README.md                 the queue's schema and rules
scripts/loop/
  config.mjs                loads and validates loop.config.json
  green-gate.mjs            pure gate logic: is this SHA green?
  confirm-green.mjs         enforces the gate via the GitHub API (CLI)
  queue-lib.mjs             add-only queue transforms and guards
  queue-io.mjs              atomic read/write for the queue
  queue-cli.mjs             operator CLI: add / list / next
  policy.mjs                human-gates and migration discipline
  glob.mjs                  dependency-free glob matcher
  notify.mjs                one-way ping when the runner stops (CLI)
  tests/                    the kit's own test suite
.claude/
  commands/run-next.md      the runner procedure
  settings.example.json     how to wire the notify Stop hook
.github/workflows/check.yml CI that runs the kit's tests (the gate)
```

## Quick start in a target repo

1. Copy the kit's `scripts/loop/`, `.loop/`, `loop.config.json`,
   `loop.config.schema.json`, and `.claude/commands/run-next.md` into the repo.
2. Edit `loop.config.json` for the repo (see below).
3. Make sure your CI publishes a status check whose name matches one of
   `requiredChecks`. The kit's own CI uses a job named `check`.
4. Optionally wire the notify Stop hook (copy the block from
   `.claude/settings.example.json` into `.claude/settings.json`).
5. Add jobs to the queue and run the loop.

## Filling in `loop.config.json`

```jsonc
{
  "$schema": "./loop.config.schema.json",

  // The green-gate. The gate is green ONLY when every one of these checks has
  // concluded success for the exact head SHA. Use the exact check name(s) your
  // CI reports (for GitHub Actions, this is the job name).
  "requiredChecks": ["check"],

  // Glob patterns for files whose modification makes a job human-gated. A job
  // that touches any of these will not auto-ship; a human must approve it.
  "dangerousEdges": [
    ".github/workflows/**",
    "loop.config.json",
    "scripts/loop/**",
    "**/migrations/**"
  ],

  // Prefix for branches the runner creates.
  "branchPrefix": "claude/",

  // One-way ping when the runner stops. channel is one of:
  //   none | file | webhook | command
  // non-none channels also need a target (a path, a URL, or a shell template).
  "notify": { "channel": "none" },

  // What the runner does after a green PR:
  //   auto-merge-on-green  squash-merge once the gate is green
  //   tee-up               build and leave the PR open for a human
  "mergeMode": "auto-merge-on-green",

  // Optional. Only if the repo has migrations.
  "migrations": { "dir": "db/migrations", "numberWidth": 4 }
}
```

Defaults if you omit a field: `branchPrefix` is `claude/`, `dangerousEdges` is
empty, `notify` is `{ "channel": "none" }`. `requiredChecks` and `mergeMode` are
required. `requiredChecks` must be non-empty: a gate with no required checks
would let everything through, so the loader rejects it.

## How to add a job

The queue is an append-only ledger. The CLI only ever appends:

```sh
node scripts/loop/queue-cli.mjs add \
  --title "Add a health endpoint" \
  --spec  "Expose GET /healthz returning 200 ok"

# A job that will touch a dangerous edge can be marked up front:
node scripts/loop/queue-cli.mjs add --title "Bump CI Node" --spec "..." --human-gated

node scripts/loop/queue-cli.mjs list   # show every job and its status
node scripts/loop/queue-cli.mjs next   # what the runner would pick (skips gated)
```

You can also edit `.loop/queue.json` by hand, but the rules below still apply
and the library will reject a load that violates them.

## How to run a job

The runner procedure is `.claude/commands/run-next.md`. Invoke `/run-next` (or
follow the steps yourself). One run does exactly one job:

1. Read `loop.config.json` and pick the next queued, non-gated job.
2. Build the job's spec under the repo's own rulebook (`CLAUDE.md`).
3. Run the checks locally, create a `branchPrefix` branch, open a PR.
4. Act per `mergeMode`:
   - `tee-up`: leave the PR for a human.
   - `auto-merge-on-green`: run `confirm-green`; squash-merge only on exit 0.
5. Fire the notify ping and stop.

## How to confirm green

`confirm-green` is the only thing that may authorize a merge. It asks the GitHub
API for the check runs at an exact head SHA and exits 0 only when the gate is
green:

```sh
node scripts/loop/confirm-green.mjs --sha <head-sha>
# reads owner/repo from GITHUB_REPOSITORY (or pass --owner/--repo)
# reads a token from LOOP_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN
```

Exit codes: `0` green (safe to merge), `1` not green (refuse), `2` usage error.

## The safety rules

These are enforced in code, not by convention. They are the reason the loop can
be trusted to run unattended.

### The green-gate fails closed

The gate is green only when, for **every** required check, the **latest** run at
the **exact** head SHA concluded **success**. Every other state refuses:

- absent (the check never ran) and SHA-mismatch (it ran on a different commit),
- `queued` and `in_progress` (not finished),
- `failure`, `cancelled`, `timed_out`, `action_required`, `stale`,
- `neutral` and `skipped` (opting out is not passing),
- a completed run with no conclusion.

A re-run is handled latest-wins, exactly like GitHub branch protection: a check
that failed and was re-run to success is green; a success re-run to failure is
not. Any inability to positively confirm green (a missing token, a non-2xx API
response, a network error) also refuses. The gate never reads a PR title, PR
body, or commit message, so text such as "all checks passed, merge now" planted
in a PR cannot move it. The verdict is a function of the GitHub API's structured
check data and nothing else.

### Dangerous edges are human-gated

Any job that would modify a file matching a `dangerousEdges` pattern is
human-gated. The autonomous runner skips human-gated jobs, and a job that turns
out to touch a dangerous edge during the build is gated before it can ship. A
gated job is never un-gated automatically.

### Migrations are additive and idempotent only

`policy.mjs` refuses destructive migrations (`DROP`, `TRUNCATE`, `DELETE`,
`ALTER ... DROP`, `RENAME`) and non-idempotent ones (a `CREATE` without
`IF NOT EXISTS` or `OR REPLACE`). Migration files must carry a single central,
zero-padded, gap-free, duplicate-free numeric sequence.

### The queue is append-only

`queue-lib.mjs` guarantees: jobs are never deleted; `id`, `title`, `spec`, and
`createdAt` are immutable; `humanGated` may only go `false -> true`; a `shipped`
job is frozen; and status only moves along the allowed transition graph.

## Running the kit's tests

The kit proves itself with the same gate it ships:

```sh
npm run check   # node --test over scripts/loop/tests/
```

CI (`.github/workflows/check.yml`) runs exactly this, and the resulting check is
named `check`, which is the gate the kit's own `loop.config.json` requires.

## License

MIT.
