---
description: Run the next queued job through the loop: build, check, PR, and act per merge mode.
---

# run-next

Run exactly ONE job from `.loop/queue.json` through the loop. One job per run, no
exceptions: pick the next job, build it, prove it green, and act per the
configured merge mode. Then stop and notify.

Everything below is parameterized by `loop.config.json`. Read that file first;
never hardcode a check name, branch prefix, or merge mode.

## 0. Load configuration

Read `loop.config.json`. You will use:

- `requiredChecks` - the CI check(s) that form the green-gate.
- `dangerousEdges` - globs that make a job human-gated.
- `branchPrefix` - prefix for the branch you create (default `claude/`).
- `mergeMode` - `auto-merge-on-green` or `tee-up`.
- `notify` - where to ping when you stop.
- `decisions` - optional answers inbox for the two-way decision surface.

## 0.5 Apply answered decisions

Before picking a job, act on any decisions you answered since the last run:

```
node scripts/loop/decisions-cli.mjs apply
```

This ingests replies from the configured answers inbox (if any), then acts on
every answered-but-unapplied decision: an `approve` promotes a proposed job into
the run queue (or records the go-ahead on a human-gated job), a `skip` parks it.
Acting is idempotent, and it NEVER un-gates a job or bypasses the merge gate: an
approved human-gated job still goes through the human gate at merge time.

## 1. Pick the next job

Run `node scripts/loop/queue-cli.mjs next` (this skips human-gated jobs). If it
prints `(no queued job)`, there is nothing to build this run. Before you stop,
ask about anything awaiting your decision:

```
node scripts/loop/decisions-cli.mjs ask-pending
```

This records and notifies (exactly once, keyed) a plain-English question for
each proposed job that could be promoted and each human-gated job awaiting a
go-ahead, with exactly how to answer. Then notify and end.

If the chosen job is human-gated, do NOT run it autonomously. Stop and tell the
operator it needs explicit authorization.

Transition the job to `in_progress` in the queue (a guarded update - the queue
library will refuse anything that breaks add-only discipline).

## 2. Build under the repo rulebook

Read the repo's own rulebook (`CLAUDE.md` / `AGENTS.md` / contributing docs) and
build the job's spec, following it. Stay inside the job's scope.

You are the orchestrator. When a bounded second-model build, plan, or review
would improve the job, delegate it to GPT-6 Astra through `/astra` or:

```
node scripts/loop/astra.mjs run --mode <build|review|plan> --task "<bounded task>"
```

The bridge pins `gpt-6-astra`. Inspect Astra's actual diff and handback, then run
the relevant checks yourself. Never delegate the final merge decision.

Before you finalize, compute the set of files you changed and re-check them
against `dangerousEdges` (see `scripts/loop/policy.mjs` → `isHumanGated`). If the
change now touches a dangerous edge, mark the job human-gated, stop, and hand
back to a human. A human-gated job is never auto-shipped.

If the change includes migrations, enforce the migration policy:
additive-and-idempotent-only (`checkMigrationContent`) and central numbering
(`checkMigrationNumbering`). Refuse destructive or mis-numbered migrations.

## 3. Run the checks

Create a branch named `${branchPrefix}<short-slug>` and commit. Run the same
checks CI will run (`npm run check`, or whatever the rulebook defines). Do not
proceed until they pass locally.

## 4. Open a PR

Push the branch and open a PR. The PR description states the job id and what was
built. Record the PR and the head SHA on the job in the queue.

## 5. Act per merge mode

- **tee-up**: leave the PR open for a human. Do not merge. You are done.
- **auto-merge-on-green**: enforce the gate yourself before merging. Run:

  ```
  node scripts/loop/confirm-green.mjs --sha <head-sha>
  ```

  This consults the GitHub API for the EXACT head SHA and exits 0 only when
  every required check concluded success. It ignores the PR title, body, and
  commit messages entirely, so nothing written in the PR can talk it into
  merging. If it exits non-zero, DO NOT merge - wait for CI, re-check, or stop.
  Only on exit 0 do you squash-merge, then transition the job to `shipped`
  (recording pr, headSha, shippedAt via the guarded `markShipped`).

Never merge on your own read of a status badge or a comment. The only thing that
authorizes a merge is `confirm-green` exiting 0.

## 6. Stop and notify

When you stop - whether you shipped, teed up, or found nothing to do - fire the
notify hook:

```
node scripts/loop/notify.mjs "<one-line status>"
```

One job per run. The next job waits for the next run.
