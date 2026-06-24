# Add the loop to a new app

This is the short version. To put the loop into a brand-new app, you run one
command, fill in a few config values, and confirm it is live. That is the whole
setup.

## 1. Run the one command

From the Loop Kit, point the installer at the repo you want to add the loop to:

```sh
node scripts/loop/install.mjs /path/to/your/app
```

It prints every file it created, updated, or left alone. In one pass it:

- copies the loop machinery into your app (`scripts/loop/`, the schema, the
  runner procedure, the notify hook example),
- creates `loop.config.json`,
- seeds an empty job queue at `.loop/queue.json` and an empty decisions ledger
  at `.loop/decisions.json`,
- adds a loop section to your app's `CLAUDE.md` (or `AGENTS.md`),
- adds a CI workflow that runs the loop's tests, but only if your app has no CI
  yet.

Running it again later is safe. It will not overwrite your config, wipe your
queue, or add the loop section twice.

## 2. Fill in these few config values

Open `loop.config.json` in your app and confirm or adjust:

- **`requiredChecks`** - the name(s) of the CI check that must pass before
  anything merges. If the installer added a workflow for you, this is already
  set to `"check"` and matches it. If your app already had CI, set this to your
  CI's actual check name.
- **`dangerousEdges`** - file patterns that make a job stop and ask a human (for
  example CI config, the loop's own files, migrations). The default set is
  sensible; widen it to anything in your app that should never ship unattended.
- **`branchPrefix`** - the prefix for branches the loop creates. Default
  `claude/`.
- **`notify`** - where to ping when the runner stops. Default `none`. Set it to
  `file`, `webhook`, or `command` with a `target` if you want a heads-up.
- **`mergeMode`** - `auto-merge-on-green` (squash-merge once the gate is green)
  or `tee-up` (build and leave the PR for a human). Default
  `auto-merge-on-green`.

You can also set any of these at install time with flags (see
`node scripts/loop/install.mjs --help`), so the generated file already has them.

## 3. Confirm it is live

From inside your app:

```sh
node scripts/loop/verify.mjs
```

A pass means the loop is wired up: the gate can resolve your CI check, the queue
is in place, and the runner procedure is present. If anything is missing, it
tells you exactly what.

## 4. Use it

Add a job and run the loop:

```sh
node scripts/loop/queue-cli.mjs add --title "Add a health endpoint" \
  --spec "Expose GET /healthz returning 200 ok"
```

Then invoke `/run-next` (or follow `.claude/commands/run-next.md`). One run does
one job: it builds the job, proves it green, and acts per your `mergeMode`.

That is it. The loop has no dependencies; it is plain Node (>= 20). For the full
reference, see [README.md](README.md).
