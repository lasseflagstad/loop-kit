---
description: Delegate one bounded build, review, or planning task to GPT-6 Astra through Codex, then verify the handback.
---

# astra

You are the orchestrator. Delegate one bounded task to GPT-6 Astra, inspect its
handback and diff, run the relevant checks yourself, and then continue the job.
Never treat the worker's prose as proof that its changes are correct.

## 1. Confirm the bridge

Run this once per machine or when model access may have changed:

```sh
node scripts/loop/astra.mjs doctor --live
```

Stop if any check fails. Do not silently substitute another model.

## 2. Write a bounded delegation

Give Astra one task with a concrete outcome, relevant file or directory
boundaries, acceptance criteria, and checks to run. Do not delegate secrets,
publishing, destructive operations, or the final merge decision.

Choose one mode:

- `build`: Astra may edit the workspace and run checks.
- `review`: Astra inspects and reports in a read-only sandbox.
- `plan`: Astra produces an implementation plan in a read-only sandbox.

Run it with a task argument:

```sh
node scripts/loop/astra.mjs run --mode build \
  --task "Implement the queued job. Stay inside src/feature-x. Run the focused tests."
```

For a longer task, pipe the text on stdin:

```sh
node scripts/loop/astra.mjs run --mode review <<'ASTRA_TASK'
Review the current diff for correctness and regressions.
Focus on the authentication boundary and cite file paths and line numbers.
Do not edit files.
ASTRA_TASK
```

## 3. Verify as orchestrator

After the worker exits:

1. Inspect the actual diff and reject scope expansion.
2. Run the relevant local checks independently.
3. Apply the Loop Kit dangerous-edge and green-gate rules.
4. Record that Astra was used in the PR handback when it materially contributed.

Claude owns orchestration and the shipping decision. Astra owns only the task
it was delegated.

