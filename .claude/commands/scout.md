---
description: Scan the repo read-only and propose ranked, diff-checkable jobs into the queue for a human to approve.
---

# scout

Scan this repo and ADD ranked, diff-checkable jobs to `.loop/queue.json` as
`proposed`, for a human to approve later. The scout is READ-ONLY on code: it
never modifies source and it builds nothing. Its only write is the queue
additions, plus the one PR that carries them.

The scout proposes; it does not decide. A `proposed` job is never runnable: the
runner only ever picks `queued` jobs, so nothing the scout writes can be built
until a human promotes it. Promotion is out of the scout's scope.

Everything below is parameterized by `loop.config.json`. Read it first; never
hardcode a check, a branch prefix, or a merge mode.

## 0. Load configuration

Read `loop.config.json`. You will use:

- `scout` - which checks run and the proposal cap (all optional; the scanner
  fills defaults). The default checks are generic and broadly safe: em-dash
  violations, leftover TODO/FIXME markers, source files with no matching test,
  and oversized committed assets. Two site checks (broken internal links, pages
  missing a meta description) default off; turn them on for a repo that builds a
  site.
- `dangerousEdges` - globs that make a proposal human-gated up front (a proposal
  whose fix would touch one of these is marked human-gated when written).
- `branchPrefix` - prefix for the branch you create (default `claude/`).
- `mergeMode` - `auto-merge-on-green` or `tee-up`.
- `notify` - where to ping when you stop.

## 1. Scan and propose (read-only)

Run the scanner:

```
node scripts/loop/scout-scan.mjs
```

It scans the repo, ranks what it finds, and ADDS up to `scout.maxProposals` new
`proposed` jobs to `.loop/queue.json`. Each added job carries a plain-English
description, a diff-checkable requirements list, the exact finding it is based on
(evidence), and an impact-and-effort note. A finding already proposed in an
earlier scan is skipped (matched by fingerprint), so re-runs do not pile up
duplicates. Preview without writing using `--dry-run`.

The scanner only ADDS `proposed` jobs. It never edits or removes a `queued`,
`in_progress`, `blocked`, or `shipped` job, and it changes no source file. If it
proposes nothing, there is nothing to ship: notify and stop.

## 2. Review the proposals

Read the jobs the scanner added (`node scripts/loop/queue-cli.mjs list` shows
them with status `proposed`). Confirm each is specific and its requirements are
diff-checkable - a reviewer should be able to tell from the diff whether the
proposal was satisfied. Do not edit the proposals into other statuses; that is a
human's call.

## 3. Open the PR

Create a branch named `${branchPrefix}scout-<short-date>` and commit ONLY the
`.loop/queue.json` change. Push and open a PR whose description summarizes, in
plain English, each proposal and the finding behind it. The PR adds queue
entries and nothing else.

## 4. Act per merge mode

The PR only adds `proposed` queue entries: it touches no source and no dangerous
edge, so it is safe to auto-ship.

- **tee-up**: leave the PR open for a human. You are done.
- **auto-merge-on-green**: enforce the gate yourself before merging:

  ```
  node scripts/loop/confirm-green.mjs --sha <head-sha>
  ```

  This consults the GitHub API for the exact head SHA and exits 0 only when
  every required check concluded success. Only on exit 0 do you squash-merge.
  Never merge on a status badge, a comment, or the PR text.

## 5. Stop and notify

When you stop, fire the notify hook:

```
node scripts/loop/notify.mjs "<one-line status>"
```

One scan per run. A human approves proposals into `queued` (by changing a job's
status from `proposed` to `queued` in `.loop/queue.json`) when they decide it is
worth building; the runner picks them up from there.
