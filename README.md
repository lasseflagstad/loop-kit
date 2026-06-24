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
  decisions.json            the append-only two-way decisions ledger
  README.md                 the queue's and ledger's schema and rules
scripts/loop/
  install.mjs               one-step installer: drop the loop into any repo (CLI)
  verify.mjs                confirms an install is live (CLI)
  config.mjs                loads and validates loop.config.json
  green-gate.mjs            pure gate logic: is this SHA green?
  confirm-green.mjs         enforces the gate via the GitHub API (CLI)
  queue-lib.mjs             add-only queue transforms and guards
  queue-io.mjs              atomic read/write for the queue
  queue-cli.mjs             operator CLI: add / list / next
  scout-scan.mjs            read-only scanner that proposes jobs (CLI)
  decisions-lib.mjs         add-only decisions ledger transforms and guards
  decisions-io.mjs          atomic read/write for the ledger
  decisions.mjs             ask, act-on-answer, and the no-bypass safety boundary
  decisions-cli.mjs         operator/runner CLI: list / ask / ask-pending / answer / apply
  policy.mjs                human-gates and migration discipline
  glob.mjs                  dependency-free glob matcher
  notify.mjs                one-way ping when the runner stops (CLI)
  tests/                    the kit's own test suite
.claude/
  commands/run-next.md      the runner procedure
  commands/scout.md         the scout procedure (propose jobs)
  settings.example.json     how to wire the notify Stop hook
.github/workflows/check.yml CI that runs the kit's tests (the gate)
```

## Quick start in a target repo

One command, run from the kit against the repo you want to add the loop to:

```sh
node scripts/loop/install.mjs /path/to/your/repo
```

That copies the machinery in, generates `loop.config.json`, seeds an empty
queue, merges a loop section into the repo's `CLAUDE.md` / `AGENTS.md`, and adds
a baseline CI workflow if the repo has none. Then, from inside the target repo:

```sh
node scripts/loop/verify.mjs   # confirms the install is live
```

Review the few generated config values, wire the optional notify hook, add jobs,
and run the loop. The full walkthrough is in [INSTALL.md](INSTALL.md).

The installer is safe to re-run: it never clobbers your `loop.config.json` or
queue and never double-adds the loop section. See "Installing into a repo" below
for the flags and what each step does.

## Installing into a repo

`scripts/loop/install.mjs <target-repo-path>` does all of the following, and
reports exactly what it created, updated, or left alone:

1. Copies the kit's machinery (`scripts/loop/`, the schema, the runner procedure
   in `.claude/commands/run-next.md`, the notify hook example, and the queue
   README) into the target.
2. Generates `loop.config.json` from flags or sensible defaults. It never
   overwrites an existing one.
3. Seeds an empty `.loop/queue.json` (an existing queue, with its jobs, is left
   untouched).
4. Merges a loop section into the target's `CLAUDE.md` (or `AGENTS.md` if that is
   what the repo uses, or a new `CLAUDE.md` if neither exists): how to verify,
   the branch rule, and the stop-and-ask rule. The section is bounded by markers
   so a re-run replaces it in place rather than adding a second copy.
5. Adds a baseline CI workflow (`.github/workflows/loop-check.yml`) **only if the
   target has no CI yet**. The workflow's check is named after your first
   required check and runs the loop's own tests, so a fresh repo has a working
   green-gate out of the box. If the repo already has CI, no workflow is added
   and the installer tells you to point `requiredChecks` at your real check.

Flags (all optional; everything has a sensible default):

```sh
node scripts/loop/install.mjs /path/to/repo \
  --check <name>            # a required CI check (repeatable; default "check")
  --dangerous-edge <glob>   # a human-gated path (repeatable; sensible default)
  --branch-prefix <prefix>  # default "claude/"
  --notify-channel <c>      # none | file | webhook | command (default none)
  --notify-target <t>       # required for a non-none channel
  --merge-mode <m>          # auto-merge-on-green | tee-up (default auto-merge-on-green)
  --migrations-dir <dir>    # enable migration discipline for this directory
  --migrations-number-width <n>
```

Re-running is safe and idempotent: a second run with the same kit produces no
changes, keeps your config and queue, and does not duplicate the loop section.

## Confirming the install is live

From inside the target repo:

```sh
node scripts/loop/verify.mjs
```

`verify` checks three things and reports a clear pass or a clear list of what is
missing (exit 0 live, 1 incomplete):

- the green-gate can resolve every configured CI check (`loop.config.json` loads
  and validates, and each `requiredChecks` name is produced by some workflow),
- `.loop/queue.json` exists and parses,
- the runner command (`.claude/commands/run-next.md`) is present.

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

  // Optional. The two-way async decision surface. `inbox` is a file the kit
  // reads one-line replies from on its next run. Omit it to answer only via
  // the `loop-decisions answer` command.
  "decisions": { "inbox": ".loop/answers.inbox" },

  // Optional. Only if the repo has migrations.
  "migrations": { "dir": "db/migrations", "numberWidth": 4 }
}
```

Defaults if you omit a field: `branchPrefix` is `claude/`, `dangerousEdges` is
empty, `notify` is `{ "channel": "none" }`, and `decisions` is absent (answer
only via the CLI). `requiredChecks` and `mergeMode` are required.
`requiredChecks` must be non-empty: a gate with no required checks would let
everything through, so the loader rejects it.

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

## The scout: proposing jobs

The scout is a read-only job-proposer. It scans the repo, ranks what it finds,
and ADDS up to `scout.maxProposals` jobs to the queue as `proposed`, for a human
to approve. The runner procedure is `.claude/commands/scout.md` (invoke
`/scout`); the scanner is `scripts/loop/scout-scan.mjs`.

```sh
node scripts/loop/scout-scan.mjs            # scan and write proposed jobs
node scripts/loop/scout-scan.mjs --dry-run  # scan and print, write nothing
```

Every check is config-driven via the `scout` section of `loop.config.json` and
individually toggleable. The defaults are generic and broadly safe:

- **emDash** - em-dash characters (the kit forbids them).
- **todoMarkers** - leftover TODO/FIXME markers in code.
- **testsForSources** - source files with no matching test.
- **oversizedAssets** - committed files over `maxAssetBytes` (default 500 KB).
- **brokenInternalLinks** - internal links that resolve to nothing *(off by
  default; for repos that build a site)*.
- **missingMetaDescription** - HTML pages with no meta description *(off by
  default; for repos that build a site)*.

Each proposed job carries a plain-English description, a **diff-checkable**
requirements list, the exact finding it is based on (evidence), and an
impact-and-effort note. A finding already proposed is skipped on later scans
(matched by a fingerprint), so re-runs do not pile up duplicates.

Two guarantees make the scout safe to run unattended:

- **It only ADDS `proposed` jobs.** It never edits or removes a `queued`,
  `in_progress`, `blocked`, or `shipped` job, and it modifies no source file.
- **A proposal is never auto-built.** The runner only picks `queued` jobs, so a
  proposal sits inert until a human promotes it (changing its status from
  `proposed` to `queued`). Auto-promotion is deliberately out of scope.

The scout's PR adds only queue entries, so it touches no dangerous edge and
auto-ships on green.

**Honest scope.** A code-scanning scout finds mechanical hygiene (lint, missing
tests, dead links, SEO, oversized assets). It does **not** propose product or
feature work, which needs human judgment and data the scout cannot see. For a
repo whose remaining work is judgment-heavy, it will propose little. That is
expected, not a bug.

The scout section of `loop.config.json` (all fields optional; omitted fields use
the defaults above):

```jsonc
"scout": {
  "maxProposals": 5,
  "checks": {
    "emDash": true,
    "todoMarkers": true,
    "testsForSources": true,
    "oversizedAssets": true,
    "brokenInternalLinks": false,
    "missingMetaDescription": false
  }
  // also optional: include, exclude, maxAssetBytes, sourceExtensions,
  // commentScanExtensions, siteDir
}
```

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

## Two-way decisions (answer the loop asynchronously)

The most common decision the loop needs (should this ready PR ship) you already
answer by merging it on your phone, and notify pings you to do it. The decisions
ledger covers the two that are not just "merge this PR": **approving a proposed
job** and **giving a go-ahead on a human-gated job**, without you opening GitHub.

Because scheduled cloud runs are fire-and-forget, this is **asynchronous**: the
loop asks, you answer in the channel, and the *next* run acts on your answer.

- When the runner has nothing to build but a job is awaiting your decision, it
  records a keyed entry in `.loop/decisions.json` and notifies you (through the
  same `notify`) with the plain-English question and exactly how to answer. The
  same question is never asked, or pinged, twice.
- You answer without GitHub. The always-available way is the CLI:

  ```sh
  node scripts/loop/decisions-cli.mjs list                 # open decisions
  node scripts/loop/decisions-cli.mjs answer 001 approve   # approve / skip by id
  ```

  Optionally set `decisions.inbox` in `loop.config.json` to a file path; append
  a one-line reply (`<decision-id> <answer>`) to it from your channel and the
  next run reads it. Editing `.loop/decisions.json` by hand also works.
- On the next run, before picking a job, the runner runs `decisions-cli.mjs
  apply`: an `approve` promotes the proposed job into the run queue (or records
  the go-ahead on a human-gated job); a `skip` parks it. Acting is idempotent.

**An approval never bypasses the merge gate.** Approving a human-gated job
records the go-ahead to BUILD only: the job stays human-gated, the autonomous
runner still skips it, and the dangerous-edge human gate at merge time is
untouched. `decisions.mjs` never sets `humanGated`, never ships, and never
calls `confirm-green`. See `.loop/README.md` for the ledger schema.

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
