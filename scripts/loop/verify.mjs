#!/usr/bin/env node
// verify.mjs - confirm a Loop Kit install is live.
//
// Run from inside a target repo:
//
//   node scripts/loop/verify.mjs
//
// It answers one question: is the loop actually wired up here? Three facts must
// hold:
//   1. The green-gate can resolve every configured CI check. loop.config.json
//      loads and validates, and each requiredChecks name is produced by some
//      workflow in .github/workflows (a job id or a name: value).
//   2. The queue file exists and parses.
//   3. The runner command is present (.claude/commands/run-next.md).
//
// It reports a clear pass or a clear list of what is missing.
//
// Exit codes:
//   0  install is live (all checks pass)
//   1  install is incomplete (one or more checks failed)
//   2  usage error

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { readQueue } from './queue-io.mjs';

// ---------------------------------------------------------------------------
// Pure: extract the check names a workflow file can produce. A GitHub check run
// is named after the job's `name:` when set, otherwise the job id. We also
// collect every other `name:` value (workflow name, step names) as a harmless
// superset, so a check referenced by any of those resolves too.
// ---------------------------------------------------------------------------
export function parseWorkflowCheckNames(yaml) {
  const names = new Set();
  const lines = String(yaml).split(/\r?\n/);

  // Every `name:` value anywhere in the file, including the `- name:` list
  // form used by steps.
  for (const line of lines) {
    const m = line.match(/^\s*(?:-\s+)?name:\s*(.+?)\s*$/);
    if (m) {
      const v = unquote(m[1]);
      if (v) names.add(v);
    }
  }

  // Job ids: keys at the first indent level under a top-level `jobs:` block.
  let inJobs = false;
  let jobIndent = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      jobIndent = null;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      // Dedent back to column 0 ends the jobs block.
      inJobs = false;
      continue;
    }
    const m = line.match(/^(\s+)([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*$/);
    if (m) {
      const indent = m[1].length;
      if (jobIndent === null) jobIndent = indent;
      if (indent === jobIndent) names.add(m[2]);
    }
  }

  return [...names];
}

function unquote(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Pure: decide pass/fail from gathered facts. Keeping this pure means the whole
// verdict is testable without a filesystem.
//
// facts = {
//   config:   { ok, error?, requiredChecks? },
//   queue:    { ok, error? },
//   runner:   { present },
//   workflowCheckNames: string[],
// }
// Returns { ok, checks: [{ name, ok, detail }], missing: string[] }.
// ---------------------------------------------------------------------------
export function verifyInstall(facts = {}) {
  const checks = [];
  const config = facts.config ?? { ok: false, error: 'no config result' };
  const queue = facts.queue ?? { ok: false, error: 'no queue result' };
  const runner = facts.runner ?? { present: false };
  const workflowNames = facts.workflowCheckNames ?? [];

  // 1. config loads and validates.
  checks.push({
    name: 'loop.config.json loads and validates',
    ok: !!config.ok,
    detail: config.ok ? 'valid' : `cannot load config: ${config.error}`,
  });

  // 2. every required check resolves to some workflow.
  if (config.ok) {
    const required = config.requiredChecks ?? [];
    const unresolved = required.filter((c) => !workflowNames.includes(c));
    checks.push({
      name: 'green-gate can resolve every required CI check',
      ok: unresolved.length === 0,
      detail:
        unresolved.length === 0
          ? `all resolve (${required.join(', ')})`
          : `no workflow produces: ${unresolved.join(', ')}` +
            (workflowNames.length
              ? ` (found: ${workflowNames.join(', ')})`
              : ' (no workflows found)'),
    });
  } else {
    checks.push({
      name: 'green-gate can resolve every required CI check',
      ok: false,
      detail: 'skipped: config did not load',
    });
  }

  // 3. queue exists and parses.
  checks.push({
    name: '.loop/queue.json exists and parses',
    ok: !!queue.ok,
    detail: queue.ok ? 'parses' : `queue problem: ${queue.error}`,
  });

  // 4. runner command present.
  checks.push({
    name: '.claude/commands/run-next.md is present',
    ok: !!runner.present,
    detail: runner.present ? 'present' : 'missing the runner procedure',
  });

  const missing = checks.filter((c) => !c.ok).map((c) => c.name);
  return { ok: missing.length === 0, checks, missing };
}

// ---------------------------------------------------------------------------
// I/O: gather the facts verifyInstall needs from a target repo on disk.
// ---------------------------------------------------------------------------
export function collectFacts(targetDir = '.') {
  const root = resolve(targetDir);

  // config
  let config;
  try {
    const c = loadConfig(resolve(root, 'loop.config.json'));
    config = { ok: true, requiredChecks: c.requiredChecks };
  } catch (err) {
    config = { ok: false, error: err.message };
  }

  // queue
  let queue;
  try {
    readQueue(resolve(root, '.loop/queue.json'));
    queue = { ok: true };
  } catch (err) {
    queue = { ok: false, error: err.message };
  }
  // readQueue returns an empty queue when the file is absent; require it to
  // actually exist so a missing queue is caught.
  if (!existsSync(resolve(root, '.loop/queue.json'))) {
    queue = { ok: false, error: '.loop/queue.json does not exist' };
  }

  // runner
  const runner = {
    present: existsSync(resolve(root, '.claude/commands/run-next.md')),
  };

  // workflow check names
  const workflowCheckNames = collectWorkflowCheckNames(root);

  return { config, queue, runner, workflowCheckNames };
}

function collectWorkflowCheckNames(root) {
  const dir = resolve(root, '.github/workflows');
  if (!existsSync(dir)) return [];
  const names = new Set();
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    try {
      const yaml = readFileSync(join(dir, f), 'utf8');
      for (const n of parseWorkflowCheckNames(yaml)) names.add(n);
    } catch {
      // An unreadable workflow file contributes no names; verify will report
      // the unresolved check rather than crash.
    }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { dir: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-')) args.dir = a;
  }
  return args;
}

const USAGE = `Usage: verify [target-repo-path]

Confirms a Loop Kit install is live: the green-gate can resolve every configured
CI check, the queue exists and parses, and the runner command is present.

Exit codes: 0 live, 1 incomplete, 2 usage error.`;

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const facts = collectFacts(args.dir);
  const result = verifyInstall(facts);

  for (const c of result.checks) {
    const mark = c.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[${mark}] ${c.name}\n        ${c.detail}\n`);
  }

  if (result.ok) {
    process.stdout.write('\nVERIFIED: the loop is live in this repo.\n');
    return 0;
  }
  process.stdout.write('\nINCOMPLETE: the loop is not fully installed. Missing:\n');
  for (const m of result.missing) process.stdout.write(`  - ${m}\n`);
  return 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

export { main, collectWorkflowCheckNames };
