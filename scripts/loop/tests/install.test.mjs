// Tests for the one-step installer. The pure helpers are unit-tested directly;
// installLoop is exercised end to end against a throwaway fixture repo in a temp
// dir, including a second run to prove idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildConfig,
  defaultDangerousEdges,
  loopRulebookSection,
  mergeRulebook,
  workflowFileContent,
  hasExistingCi,
  rulebookPath,
  installLoop,
  defaultKitRoot,
} from '../install.mjs';
import { loadConfig } from '../config.mjs';
import { readQueue } from '../queue-io.mjs';
import { readLedger } from '../decisions-io.mjs';

// The kit root, resolved by the installer itself (robust regardless of where
// this test file sits in the tree).
const KIT_ROOT = defaultKitRoot();

function tmpTarget() {
  return mkdtempSync(join(tmpdir(), 'loopinstall-'));
}

function actionFor(report, path) {
  const a = report.actions.find((x) => x.path === path);
  return a ? a.action : undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('buildConfig applies sensible defaults', () => {
  const c = buildConfig();
  assert.deepEqual(c.requiredChecks, ['check']);
  assert.equal(c.branchPrefix, 'claude/');
  assert.equal(c.mergeMode, 'auto-merge-on-green');
  assert.deepEqual(c.notify, { channel: 'none' });
  assert.deepEqual(c.dangerousEdges, defaultDangerousEdges());
  assert.equal(c.$schema, './loop.config.schema.json');
  assert.equal(c.astra.model, 'gpt-6-astra');
  assert.equal(c.astra.sandbox, 'workspace-write');
});

test('buildConfig honors flags and validates the result', () => {
  const c = buildConfig({
    checks: ['ci', 'lint'],
    dangerousEdges: ['infra/**'],
    branchPrefix: 'bot/',
    notifyChannel: 'file',
    notifyTarget: '.loop/notify.log',
    mergeMode: 'tee-up',
    migrationsDir: 'db/migrations',
    migrationsNumberWidth: 5,
  });
  assert.deepEqual(c.requiredChecks, ['ci', 'lint']);
  assert.deepEqual(c.dangerousEdges, ['infra/**']);
  assert.equal(c.branchPrefix, 'bot/');
  assert.deepEqual(c.notify, { channel: 'file', target: '.loop/notify.log' });
  assert.equal(c.mergeMode, 'tee-up');
  assert.deepEqual(c.migrations, { dir: 'db/migrations', numberWidth: 5 });
});

test('buildConfig rejects an invalid merge mode and a targetless notify channel', () => {
  assert.throws(() => buildConfig({ mergeMode: 'rebase' }));
  assert.throws(() => buildConfig({ notifyChannel: 'webhook' }), /notify-target/);
});

test('mergeRulebook appends to existing content with one blank line', () => {
  const merged = mergeRulebook('# My repo\n\nSome rules.\n', loopRulebookSection());
  assert.match(merged, /# My repo/);
  assert.match(merged, /## The loop/);
  assert.match(merged, /<!-- BEGIN LOOP KIT -->/);
  assert.match(merged, /<!-- END LOOP KIT -->/);
});

test('mergeRulebook is idempotent: re-merging replaces the block in place', () => {
  const once = mergeRulebook('# Repo\n', loopRulebookSection());
  const twice = mergeRulebook(once, loopRulebookSection());
  assert.equal(once, twice);
  // Exactly one begin marker.
  assert.equal(twice.split('<!-- BEGIN LOOP KIT -->').length - 1, 1);
});

test('mergeRulebook creates standalone content when there is no rulebook', () => {
  const merged = mergeRulebook('', loopRulebookSection());
  assert.match(merged, /^<!-- BEGIN LOOP KIT -->/);
});

test('workflowFileContent names the check run after the required check', () => {
  const wf = workflowFileContent();
  assert.match(wf, /name: "check"/);
  assert.match(wf, /loop_check:/);
  assert.match(wf, /node --test "scripts\/loop\/tests/);
  // A custom check name flows through to the job name.
  assert.match(workflowFileContent('ci'), /name: "ci"/);
});

// ---------------------------------------------------------------------------
// End-to-end install against a fixture
// ---------------------------------------------------------------------------

test('installLoop installs a complete, valid loop into a bare target', () => {
  const target = tmpTarget();
  const report = installLoop({ targetDir: target, kitRoot: KIT_ROOT });

  // Machinery copied.
  for (const f of [
    'scripts/loop/config.mjs',
    'scripts/loop/green-gate.mjs',
    'scripts/loop/confirm-green.mjs',
    'scripts/loop/queue-lib.mjs',
    'scripts/loop/queue-io.mjs',
    'scripts/loop/queue-cli.mjs',
    'scripts/loop/policy.mjs',
    'scripts/loop/glob.mjs',
    'scripts/loop/notify.mjs',
    'scripts/loop/verify.mjs',
    'scripts/loop/install.mjs',
    'scripts/loop/astra.mjs',
    'loop.config.schema.json',
    '.claude/commands/run-next.md',
    '.claude/commands/astra.md',
    'PROOF.md',
  ]) {
    assert.ok(existsSync(join(target, f)), `expected ${f} to be copied`);
  }

  // Config generated and valid.
  const cfg = loadConfig(join(target, 'loop.config.json'));
  assert.deepEqual(cfg.requiredChecks, ['check']);
  assert.equal(cfg.mergeMode, 'auto-merge-on-green');

  // Queue seeded and parses.
  const q = readQueue(join(target, '.loop/queue.json'));
  assert.deepEqual(q.jobs, []);

  // Decisions ledger seeded and parses.
  assert.ok(existsSync(join(target, '.loop/decisions.json')), 'expected decisions ledger seeded');
  const ledger = readLedger(join(target, '.loop/decisions.json'));
  assert.deepEqual(ledger.decisions, []);
  assert.equal(actionFor(report, '.loop/decisions.json'), 'created');

  // Decisions machinery copied.
  for (const f of [
    'scripts/loop/decisions-lib.mjs',
    'scripts/loop/decisions-io.mjs',
    'scripts/loop/decisions.mjs',
    'scripts/loop/decisions-cli.mjs',
  ]) {
    assert.ok(existsSync(join(target, f)), `expected ${f} to be copied`);
  }

  // Rulebook created with the loop section.
  const rb = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
  assert.match(rb, /## The loop/);

  // Baseline CI added (target had none).
  assert.ok(existsSync(join(target, '.github/workflows/loop-check.yml')));
  assert.equal(actionFor(report, '.github/workflows/loop-check.yml'), 'created');
  assert.equal(report.warnings.length, 0);
});

test('installLoop honors config flags when generating loop.config.json', () => {
  const target = tmpTarget();
  installLoop({
    targetDir: target,
    kitRoot: KIT_ROOT,
    options: { checks: ['build'], branchPrefix: 'ai/', mergeMode: 'tee-up' },
  });
  const cfg = loadConfig(join(target, 'loop.config.json'));
  assert.deepEqual(cfg.requiredChecks, ['build']);
  assert.equal(cfg.branchPrefix, 'ai/');
  assert.equal(cfg.mergeMode, 'tee-up');
});

test('installLoop is idempotent: a second run changes nothing and keeps config + queue', () => {
  const target = tmpTarget();
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });

  // Add a job so we can prove the queue is preserved across re-install.
  const queuePath = join(target, '.loop/queue.json');
  writeFileSync(
    queuePath,
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            id: '001',
            title: 'pre-existing',
            spec: 's',
            status: 'queued',
            humanGated: false,
            createdAt: '2026-06-24T00:00:00.000Z',
            branch: null,
            pr: null,
            headSha: null,
            shippedAt: null,
            note: null,
          },
        ],
      },
      null,
      2
    ) + '\n'
  );

  const before = readFileSync(join(target, 'loop.config.json'), 'utf8');
  const rbBefore = readFileSync(join(target, 'CLAUDE.md'), 'utf8');

  const report2 = installLoop({ targetDir: target, kitRoot: KIT_ROOT });

  // No file created or updated on the second run; only unchanged/kept/skipped.
  for (const { path, action } of report2.actions) {
    assert.ok(
      ['unchanged', 'kept-existing', 'skipped-existing-ci'].includes(action),
      `second run should not create/update ${path}, got ${action}`
    );
  }

  // Config untouched.
  assert.equal(readFileSync(join(target, 'loop.config.json'), 'utf8'), before);
  assert.equal(actionFor(report2, 'loop.config.json'), 'kept-existing');

  // Queue preserved (the job survives).
  const q = readQueue(queuePath);
  assert.equal(q.jobs.length, 1);
  assert.equal(q.jobs[0].title, 'pre-existing');
  assert.equal(actionFor(report2, '.loop/queue.json'), 'kept-existing');

  // Rulebook not double-added.
  const rbAfter = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
  assert.equal(rbAfter, rbBefore);
  assert.equal(rbAfter.split('<!-- BEGIN LOOP KIT -->').length - 1, 1);
});

test('installLoop never clobbers an existing loop.config.json', () => {
  const target = tmpTarget();
  const custom = JSON.stringify(
    { $schema: './loop.config.schema.json', requiredChecks: ['mine'], mergeMode: 'tee-up' },
    null,
    2
  ) + '\n';
  writeFileSync(join(target, 'loop.config.json'), custom);

  const report = installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  assert.equal(readFileSync(join(target, 'loop.config.json'), 'utf8'), custom);
  assert.equal(actionFor(report, 'loop.config.json'), 'kept-existing');
});

test('installLoop merges into an existing AGENTS.md when there is no CLAUDE.md', () => {
  const target = tmpTarget();
  writeFileSync(join(target, 'AGENTS.md'), '# Agents\n\nExisting guidance.\n');
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Existing guidance\./);
  assert.match(agents, /## The loop/);
  // CLAUDE.md should not have been created since AGENTS.md existed.
  assert.equal(existsSync(join(target, 'CLAUDE.md')), false);
});

test('installLoop does not add CI when the target already has a workflow, and warns', () => {
  const target = tmpTarget();
  mkdirSync(join(target, '.github/workflows'), { recursive: true });
  writeFileSync(join(target, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n');

  const report = installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  assert.equal(existsSync(join(target, '.github/workflows/loop-check.yml')), false);
  assert.equal(actionFor(report, '.github/workflows/loop-check.yml'), 'skipped-existing-ci');
  assert.ok(report.warnings.some((w) => /requiredChecks/.test(w)));
});

test('installLoop refuses to install the kit into itself', () => {
  assert.throws(
    () => installLoop({ targetDir: KIT_ROOT, kitRoot: KIT_ROOT }),
    /into itself/
  );
});

test('hasExistingCi and rulebookPath behave as documented', () => {
  const target = tmpTarget();
  assert.equal(hasExistingCi(target), false);
  mkdirSync(join(target, '.github/workflows'), { recursive: true });
  writeFileSync(join(target, '.github/workflows/x.yaml'), 'name: x\n');
  assert.equal(hasExistingCi(target), true);

  const t2 = tmpTarget();
  assert.equal(rulebookPath(t2), resolve(t2, 'CLAUDE.md'));
  writeFileSync(join(t2, 'AGENTS.md'), '#\n');
  assert.equal(rulebookPath(t2), resolve(t2, 'AGENTS.md'));
  writeFileSync(join(t2, 'CLAUDE.md'), '#\n');
  assert.equal(rulebookPath(t2), resolve(t2, 'CLAUDE.md'));
});

test('defaultKitRoot resolves to the repo root holding the schema', () => {
  assert.ok(existsSync(join(defaultKitRoot(), 'loop.config.schema.json')));
});
