#!/usr/bin/env node
// install.mjs - the one-step installer that drops the Loop Kit into any repo.
//
// Run from the kit against a target repo:
//
//   node scripts/loop/install.mjs <target-repo-path> [options]
//
// It copies the kit's machinery into the target, generates a loop.config.json
// (from flags or sensible defaults), seeds an empty queue, merges the loop
// section into the target's CLAUDE.md / AGENTS.md, and adds a baseline CI
// workflow only if the target has no CI yet. It is idempotent: running it twice
// produces no second change, never clobbers an existing loop.config.json or
// queue, and never double-adds the rulebook section.
//
// The pure helpers (buildConfig, loopRulebookSection, mergeRulebook,
// workflowFileContent) are exported and unit-tested without the filesystem; the
// filesystem work is exercised end to end against a throwaway fixture repo.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.mjs';
import { collectWorkflowCheckNames } from './verify.mjs';
import { isDirectInvocation } from './direct.mjs';

// ---------------------------------------------------------------------------
// What the kit copies into a target. These are repo-root-relative paths. A
// directory is copied recursively; a file is copied as-is. loop.config.json and
// .loop/queue.json are NOT here: the first is generated, the second is seeded.
// ---------------------------------------------------------------------------
export const KIT_COPY_PATHS = [
  'scripts/loop', // all machinery + tests, so the target's gate can run them
  'loop.config.schema.json',
  '.loop/README.md',
  '.claude/commands/run-next.md',
  '.claude/commands/scout.md',
  '.claude/commands/astra.md',
  '.claude/settings.example.json',
  'PROOF.md',
];

// The kit's own files that must never be copied verbatim into a target, even if
// they live under a copied directory. (Currently none under scripts/loop, but
// kept explicit so the intent survives future additions.)
const COPY_SKIP = new Set([]);

const LOOP_MARKER_BEGIN = '<!-- BEGIN LOOP KIT -->';
const LOOP_MARKER_END = '<!-- END LOOP KIT -->';

// Sensible default dangerous edges: the CI config, the loop's own config and
// machinery, and any migrations. Touching these makes a job human-gated.
export function defaultDangerousEdges() {
  return [
    '.github/workflows/**',
    'loop.config.json',
    'scripts/loop/**',
    '**/migrations/**',
  ];
}

// ---------------------------------------------------------------------------
// Pure: build the config object to write from the chosen options. Everything
// has a sensible default; flags override. The result is validated so a bad flag
// (e.g. an unknown mergeMode) fails loudly before anything is written.
// ---------------------------------------------------------------------------
export function buildConfig(options = {}) {
  const requiredChecks =
    Array.isArray(options.checks) && options.checks.length > 0
      ? [...options.checks]
      : ['check'];

  const dangerousEdges =
    Array.isArray(options.dangerousEdges) && options.dangerousEdges.length > 0
      ? [...options.dangerousEdges]
      : defaultDangerousEdges();

  const branchPrefix = options.branchPrefix || 'claude/';

  const channel = options.notifyChannel || 'none';
  const notify = { channel };
  if (channel !== 'none') {
    if (!options.notifyTarget) {
      throw new Error(
        `notify channel '${channel}' requires --notify-target <path|url|command>`
      );
    }
    notify.target = options.notifyTarget;
  }

  const mergeMode = options.mergeMode || 'auto-merge-on-green';

  const config = {
    $schema: './loop.config.schema.json',
    requiredChecks,
    dangerousEdges,
    branchPrefix,
    notify,
    mergeMode,
    astra: {
      enabled: true,
      command: 'codex',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
    },
  };

  if (options.migrationsDir) {
    config.migrations = { dir: options.migrationsDir };
    if (options.migrationsNumberWidth !== undefined) {
      config.migrations.numberWidth = options.migrationsNumberWidth;
    }
  }

  // Validate a copy so an invalid combination is rejected up front. validateConfig
  // ignores the extra $schema key and normalizes the rest.
  validateConfig({ ...config });
  return config;
}

// ---------------------------------------------------------------------------
// Pure: the rulebook stub added to the target's CLAUDE.md / AGENTS.md. Bounded
// by sentinel markers so a re-run can find and replace it instead of appending.
// ---------------------------------------------------------------------------
export function loopRulebookSection() {
  return [
    LOOP_MARKER_BEGIN,
    '## The loop',
    '',
    'This repo runs the Loop Kit: a queued, self-gating autonomous loop. Work is',
    'added to `.loop/queue.json`, built one job at a time, and merged only when a',
    'self-enforcing green-gate says it is safe. The runner procedure lives in',
    '`.claude/commands/run-next.md`; every per-repo decision lives in',
    '`loop.config.json`.',
    '',
    '### How to verify',
    '',
    'Confirm the loop is correctly installed:',
    '',
    '```sh',
    'node scripts/loop/verify.mjs',
    '```',
    '',
    'Run the loop tests before relying on the machinery:',
    '',
    '```sh',
    'node --test "scripts/loop/tests/**/*.test.mjs"',
    '```',
    '',
    'A change is shippable only when the CI check(s) named in',
    "`loop.config.json`'s `requiredChecks` have concluded success for the exact",
    'head SHA. Nothing merges until `node scripts/loop/confirm-green.mjs --sha',
    '<head-sha>` exits 0. Never merge on a status badge, a comment, or a PR',
    'description; only `confirm-green` exiting 0 authorizes a merge.',
    '',
    '### Branch rules',
    '',
    'The runner creates a branch under the configured `branchPrefix` for every',
    'job. Do not commit directly to the default branch; open a PR and let the',
    'gate decide.',
    '',
    '### Stop and ask',
    '',
    'Any change that touches a `dangerousEdges` pattern is human-gated: stop and',
    'hand back to a human rather than shipping it. Migrations must be additive',
    'and idempotent only. When in doubt, stop and ask.',
    '',
    'See `.claude/commands/run-next.md` for the full runner procedure.',
    'Use `/astra` to delegate one bounded task to GPT-6 Astra through Codex,',
    'then inspect the diff and run the checks yourself before continuing.',
    LOOP_MARKER_END,
    '',
  ].join('\n');
}

// Pure: merge the loop section into an existing rulebook. If the markers are
// already present, replace the block in place (idempotent and upgradable); if
// not, append it; if there is no existing content, the block stands alone.
export function mergeRulebook(existing, section) {
  const block = section.replace(/\s+$/, '');
  if (!existing || existing.trim() === '') {
    return block + '\n';
  }
  const begin = existing.indexOf(LOOP_MARKER_BEGIN);
  const end = existing.indexOf(LOOP_MARKER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const after = end + LOOP_MARKER_END.length;
    return existing.slice(0, begin) + block + existing.slice(after);
  }
  // Append, ensuring exactly one blank line of separation.
  const trimmed = existing.replace(/\s+$/, '');
  return trimmed + '\n\n' + block + '\n';
}

// Pure: the baseline CI workflow added when the target has no CI. The job's
// check run is named after the configured required check (default "check") so
// the green-gate resolves it immediately, and it runs the loop's own tests so a
// green check proves the loop machinery is intact. The check name is set via the
// job's `name:` so it works even for names that are not valid job ids.
export function workflowFileContent(checkName = 'check') {
  const name = JSON.stringify(checkName);
  return `name: Loop check

# Added by the Loop Kit installer. Runs the loop's own tests so the green-gate
# (the check named ${name}) proves the loop machinery is intact. If your CI
# already provides a check, point loop.config.json's requiredChecks at it and
# remove this file.

on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  loop_check:
    name: ${name}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Run loop tests
        run: node --test "scripts/loop/tests/**/*.test.mjs"
`;
}

// ---------------------------------------------------------------------------
// Filesystem helpers. Each returns an action describing what happened so the
// caller can report it and so idempotency is observable in tests.
// ---------------------------------------------------------------------------

// Write a file only when its content would change. Returns 'created',
// 'updated', or 'unchanged'.
function writeFileChanged(absPath, content) {
  if (existsSync(absPath)) {
    const current = readFileSync(absPath, 'utf8');
    if (current === content) return 'unchanged';
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
    return 'updated';
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
  return 'created';
}

// Recursively list every file (not directory) under a directory.
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// Copy one kit path (file or directory) from kitRoot into targetDir, comparing
// content so unchanged files are left untouched. Returns an array of
// { path, action } relative to the target.
function copyKitPath(relPath, kitRoot, targetDir) {
  const src = resolve(kitRoot, relPath);
  const actions = [];
  if (!existsSync(src)) return actions;

  const sources = statSync(src).isDirectory() ? walkFiles(src) : [src];
  for (const srcFile of sources) {
    const rel = relative(kitRoot, srcFile);
    if (COPY_SKIP.has(rel)) continue;
    const dest = resolve(targetDir, rel);
    const content = readFileSync(srcFile);
    const action = writeBufferChanged(dest, content);
    actions.push({ path: rel, action });
  }
  return actions;
}

// Buffer-aware variant of writeFileChanged (kit files are read as buffers so an
// accidental encoding round-trip cannot corrupt them).
function writeBufferChanged(absPath, buffer) {
  if (existsSync(absPath)) {
    const current = readFileSync(absPath);
    if (current.equals(buffer)) return 'unchanged';
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, buffer);
    return 'updated';
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buffer);
  return 'created';
}

// Does the target already have any CI workflow? True if .github/workflows holds
// at least one .yml / .yaml file.
export function hasExistingCi(targetDir) {
  const dir = resolve(targetDir, '.github/workflows');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => /\.ya?ml$/i.test(f));
}

// Pick the rulebook file to merge into: an existing CLAUDE.md, else an existing
// AGENTS.md, else CLAUDE.md (created). Returns an absolute path.
export function rulebookPath(targetDir) {
  const claude = resolve(targetDir, 'CLAUDE.md');
  const agents = resolve(targetDir, 'AGENTS.md');
  if (existsSync(claude)) return claude;
  if (existsSync(agents)) return agents;
  return claude;
}

// ---------------------------------------------------------------------------
// The installer. Performs all of requirement 1 against targetDir, sourcing kit
// files from kitRoot. Returns a structured report of every action and any
// warnings the operator should act on.
// ---------------------------------------------------------------------------
export function installLoop({ targetDir, kitRoot, options = {} } = {}) {
  if (!targetDir) throw new Error('installLoop requires a targetDir');
  const target = resolve(targetDir);
  const kit = resolve(kitRoot ?? defaultKitRoot());

  if (target === kit) {
    throw new Error('refusing to install the kit into itself; choose a different target');
  }
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }

  const actions = [];
  const warnings = [];

  // 1. Copy the machinery.
  for (const relPath of KIT_COPY_PATHS) {
    actions.push(...copyKitPath(relPath, kit, target));
  }

  // 2. Generate loop.config.json, never clobbering an existing one.
  const config = buildConfig(options);
  const configPath = resolve(target, 'loop.config.json');
  if (existsSync(configPath)) {
    actions.push({ path: 'loop.config.json', action: 'kept-existing' });
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    actions.push({ path: 'loop.config.json', action: 'created' });
  }

  // 3. Seed an empty queue, never overwriting an existing one (it may hold jobs).
  const queuePath = resolve(target, '.loop/queue.json');
  if (existsSync(queuePath)) {
    actions.push({ path: '.loop/queue.json', action: 'kept-existing' });
  } else {
    mkdirSync(dirname(queuePath), { recursive: true });
    writeFileSync(queuePath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + '\n', 'utf8');
    actions.push({ path: '.loop/queue.json', action: 'created' });
  }

  // 3b. Seed an empty decisions ledger, never overwriting an existing one (it
  //     may hold recorded answers).
  const decisionsPath = resolve(target, '.loop/decisions.json');
  if (existsSync(decisionsPath)) {
    actions.push({ path: '.loop/decisions.json', action: 'kept-existing' });
  } else {
    mkdirSync(dirname(decisionsPath), { recursive: true });
    writeFileSync(decisionsPath, JSON.stringify({ version: 1, decisions: [] }, null, 2) + '\n', 'utf8');
    actions.push({ path: '.loop/decisions.json', action: 'created' });
  }

  // 4. Merge the loop section into the rulebook.
  const rbPath = rulebookPath(target);
  const existing = existsSync(rbPath) ? readFileSync(rbPath, 'utf8') : '';
  const merged = mergeRulebook(existing, loopRulebookSection());
  const rbRel = relative(target, rbPath);
  if (merged === existing) {
    actions.push({ path: rbRel, action: 'unchanged' });
  } else {
    writeFileSync(rbPath, merged, 'utf8');
    actions.push({ path: rbRel, action: existing ? 'updated' : 'created' });
  }

  // 5. Add a baseline CI workflow only if the target has no CI yet. When CI
  // already exists, warn only if no existing workflow actually produces the
  // required check(s); otherwise (for example, our own workflow on a re-run) the
  // gate is already resolvable and no action is needed.
  if (hasExistingCi(target)) {
    actions.push({ path: '.github/workflows/loop-check.yml', action: 'skipped-existing-ci' });
    const existingNames = collectWorkflowCheckNames(target);
    const unresolved = config.requiredChecks.filter((c) => !existingNames.includes(c));
    if (unresolved.length > 0) {
      warnings.push(
        'The target already has CI, so no workflow was added. No existing workflow ' +
          `produces required check(s): ${unresolved.join(', ')}. Set requiredChecks in ` +
          "loop.config.json to your CI's actual check name, or add a workflow that emits it."
      );
    }
  } else {
    const wfPath = resolve(target, '.github/workflows/loop-check.yml');
    const action = writeFileChanged(wfPath, workflowFileContent(config.requiredChecks[0]));
    actions.push({ path: '.github/workflows/loop-check.yml', action });
  }

  return { target, kit, config, actions, warnings };
}

// Resolve the kit root (two levels up from scripts/loop/install.mjs).
export function defaultKitRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const options = { checks: [], dangerousEdges: [] };
  let targetDir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') options.checks.push(argv[++i]);
    else if (a === '--dangerous-edge') options.dangerousEdges.push(argv[++i]);
    else if (a === '--branch-prefix') options.branchPrefix = argv[++i];
    else if (a === '--notify-channel') options.notifyChannel = argv[++i];
    else if (a === '--notify-target') options.notifyTarget = argv[++i];
    else if (a === '--merge-mode') options.mergeMode = argv[++i];
    else if (a === '--migrations-dir') options.migrationsDir = argv[++i];
    else if (a === '--migrations-number-width')
      options.migrationsNumberWidth = Number.parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') options.help = true;
    else if (!a.startsWith('-') && targetDir === undefined) targetDir = a;
  }
  return { targetDir, options };
}

const USAGE = `Usage: install <target-repo-path> [options]

Installs the Loop Kit into a target repo. Re-running is safe (idempotent).

Options:
  --check <name>             a required CI check name (repeatable; default "check")
  --dangerous-edge <glob>    a human-gated path pattern (repeatable; sensible default)
  --branch-prefix <prefix>   branch prefix for the runner (default "claude/")
  --notify-channel <c>       none | file | webhook | command (default none)
  --notify-target <t>        target for a non-none channel (path, URL, or command)
  --merge-mode <m>           auto-merge-on-green | tee-up (default auto-merge-on-green)
  --migrations-dir <dir>     enable migration discipline for this directory
  --migrations-number-width <n>   zero-padded width of migration numbers (default 4)
  -h, --help                 show this help

After installing, run:  node scripts/loop/verify.mjs   (from the target repo)`;

function main(argv) {
  const { targetDir, options } = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (!targetDir) {
    process.stderr.write('error: a target repo path is required\n\n' + USAGE + '\n');
    return 2;
  }

  let report;
  try {
    report = installLoop({ targetDir, options });
  } catch (err) {
    process.stderr.write(`install failed: ${err.message}\n`);
    return 2;
  }

  process.stdout.write(`Installed the Loop Kit into ${report.target}\n\n`);
  for (const { path, action } of report.actions) {
    process.stdout.write(`  ${action.padEnd(20)} ${path}\n`);
  }
  process.stdout.write('\nConfiguration written to loop.config.json:\n');
  process.stdout.write(`  requiredChecks  ${report.config.requiredChecks.join(', ')}\n`);
  process.stdout.write(`  branchPrefix    ${report.config.branchPrefix}\n`);
  process.stdout.write(`  mergeMode       ${report.config.mergeMode}\n`);
  process.stdout.write(`  notify          ${report.config.notify.channel}\n`);

  if (report.warnings.length > 0) {
    process.stdout.write('\nACTION REQUIRED:\n');
    for (const w of report.warnings) process.stdout.write(`  - ${w}\n`);
  }

  process.stdout.write(
    '\nNext: review loop.config.json, then run from the target repo:\n' +
      '  node scripts/loop/verify.mjs\n'
  );
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
