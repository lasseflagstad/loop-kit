# What you can honestly claim

> We wired Claude Code to delegate bounded software tasks to GPT-6 Astra through
> the Codex CLI, then verify the work before it can ship.

That sentence is the public claim this package supports.

## Why the claim is defensible

1. Claude Code receives the `/astra` command and remains the orchestrator.
2. `scripts/loop/astra.mjs` launches `codex exec` as a child process.
3. The command pins `--model gpt-6-astra`; it does not rely on a user's default.
4. `doctor --live` makes a real read-only call and requires the exact
   `ASTRA_OK` response.
5. Build delegations use Codex's `workspace-write` sandbox. Plan and review
   delegations are forced to `read-only`. The bridge never enables
   danger-full-access.
6. Claude must inspect the diff and rerun checks. The existing Loop Kit gate
   still controls whether work may merge.

OpenAI lists `gpt-6-astra` as the model ID and documents support for coding,
reasoning, tool use, and Codex automation:

- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/codex/noninteractive

## What this does not claim

- Astra does not replace the model running Claude Code.
- Claude and Astra do not share hidden reasoning or memory.
- A successful install does not guarantee every account has Astra access. The
  live doctor checks the current account and fails clearly if access is absent.
- Two models do not make a result correct. The diff, tests, CI, and merge gate
  are the evidence.

## Reproduce the proof

From a repository with the kit installed:

```sh
node scripts/loop/astra.mjs doctor --live
```

Expected final line:

```text
PASS  Live GPT-6 Astra call succeeds: ASTRA_OK
```

Then open Claude Code and run `/astra` with a small review task. The exact model
selection remains visible in the spawned command and the bridge's source.
