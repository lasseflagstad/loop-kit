# Add the Claude + Astra loop to a new app

This is the short version. To put the loop into a brand-new app, you run one
command, fill in a few config values, and confirm it is live. That is the whole
setup.

## 0. Prerequisites

- Git and Node.js 20 or newer
- Claude Code installed and authenticated
- Codex CLI installed and authenticated with GPT-6 Astra access

The bridge works with ChatGPT-based Codex login or an API-backed Codex setup.
It does not copy, read, or store either provider's credentials.

## 1. Run the one command

From the target app, install directly from GitHub:

```sh
npm exec --yes --package=github:lasseflagstad/loop-kit -- loop-install "$PWD"
```

Or, from a local clone of this kit, point the installer at the app:

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
- adds `/astra`, `/run-next`, and `/scout` commands for Claude Code,
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
- **`astra`** - the worker bridge. Keep `model` as `gpt-6-astra` to reproduce
  the TrustOS claim. Plan and review are always read-only even when the build
  sandbox is `workspace-write`.

You can also set any of these at install time with flags (see
`node scripts/loop/install.mjs --help`), so the generated file already has them.

## 3. Confirm it is live

From inside your app:

```sh
node scripts/loop/verify.mjs
node scripts/loop/astra.mjs doctor --live
```

The first command verifies the local loop files, queue, runner, and CI mapping.
The live doctor verifies Codex installation, authentication, the exact pinned
model, and a real read-only GPT-6 Astra call. If access has not reached the
current account, it fails clearly and does not substitute another model.

## 4. Delegate one task

Open Claude Code and run `/astra`, or use the bridge directly:

```sh
node scripts/loop/astra.mjs run --mode review \
  --task "Review the current diff for correctness. Do not edit files."
```

Claude remains responsible for inspecting the worker's output, rerunning tests,
and deciding whether the work continues through the merge gate.

## 5. Run the full loop

Add a job and run the loop:

```sh
node scripts/loop/queue-cli.mjs add --title "Add a health endpoint" \
  --spec "Expose GET /healthz returning 200 ok"
```

Then invoke `/run-next` (or follow `.claude/commands/run-next.md`). One run does
one job: it builds the job, proves it green, and acts per your `mergeMode`.

That is it. The loop has no dependencies; it is plain Node (>= 20). For the full
reference, see [README.md](README.md).
