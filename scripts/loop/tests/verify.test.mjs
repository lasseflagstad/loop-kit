// Tests for the verify step. The pure verdict (verifyInstall) and the workflow
// name parser are unit-tested; collectFacts is exercised end to end by installing
// into a fixture and verifying it, then by breaking the install and confirming
// verify flags exactly what is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWorkflowCheckNames,
  verifyInstall,
  collectFacts,
} from '../verify.mjs';
import { installLoop, defaultKitRoot } from '../install.mjs';

const KIT_ROOT = defaultKitRoot();

function tmpTarget() {
  return mkdtempSync(join(tmpdir(), 'loopverify-'));
}

// ---------------------------------------------------------------------------
// parseWorkflowCheckNames
// ---------------------------------------------------------------------------

test('parseWorkflowCheckNames finds the workflow name and job ids', () => {
  const yaml = `name: check
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Run loop tests
        run: npm test
`;
  const names = parseWorkflowCheckNames(yaml);
  assert.ok(names.includes('check'));
  assert.ok(names.includes('Run loop tests'));
});

test('parseWorkflowCheckNames picks up multiple jobs and quoted names', () => {
  const yaml = `name: "CI"
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
  test:
    name: 'unit tests'
    runs-on: ubuntu-latest
`;
  const names = parseWorkflowCheckNames(yaml);
  assert.ok(names.includes('lint'));
  assert.ok(names.includes('test'));
  assert.ok(names.includes('unit tests'));
  assert.ok(names.includes('CI'));
});

// ---------------------------------------------------------------------------
// verifyInstall (pure)
// ---------------------------------------------------------------------------

test('verifyInstall passes when every fact holds', () => {
  const result = verifyInstall({
    config: { ok: true, requiredChecks: ['check'] },
    queue: { ok: true },
    runner: { present: true },
    astra: { scriptPresent: true, commandPresent: true },
    workflowCheckNames: ['check'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('verifyInstall flags an unresolvable required check', () => {
  const result = verifyInstall({
    config: { ok: true, requiredChecks: ['check', 'deploy'] },
    queue: { ok: true },
    runner: { present: true },
    astra: { scriptPresent: true, commandPresent: true },
    workflowCheckNames: ['check'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('green-gate can resolve every required CI check'));
  const checkRow = result.checks.find((c) => /resolve every required/.test(c.name));
  assert.match(checkRow.detail, /deploy/);
});

test('verifyInstall flags a missing queue and a missing runner', () => {
  const result = verifyInstall({
    config: { ok: true, requiredChecks: ['check'] },
    queue: { ok: false, error: '.loop/queue.json does not exist' },
    runner: { present: false },
    astra: { scriptPresent: true, commandPresent: true },
    workflowCheckNames: ['check'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('.loop/queue.json exists and parses'));
  assert.ok(result.missing.includes('.claude/commands/run-next.md is present'));
});

test('verifyInstall fails closed when the config does not load', () => {
  const result = verifyInstall({
    config: { ok: false, error: 'not valid JSON' },
    queue: { ok: true },
    runner: { present: true },
    astra: { scriptPresent: true, commandPresent: true },
    workflowCheckNames: ['check'],
  });
  assert.equal(result.ok, false);
  // The check-resolution row is skipped, not silently passed.
  const row = result.checks.find((c) => /resolve every required/.test(c.name));
  assert.equal(row.ok, false);
});

// ---------------------------------------------------------------------------
// End to end: install then verify
// ---------------------------------------------------------------------------

test('a fresh install verifies as live', () => {
  const target = tmpTarget();
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  const result = verifyInstall(collectFacts(target));
  assert.equal(result.ok, true, JSON.stringify(result.missing));
});

test('verify catches a missing CI check (existing CI does not produce the required check)', () => {
  const target = tmpTarget();
  // A pre-existing workflow producing "ci" means the installer adds no baseline.
  mkdirSync(join(target, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(target, '.github/workflows/ci.yml'),
    'name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n'
  );
  // Require "check", which no existing workflow produces.
  installLoop({ targetDir: target, kitRoot: KIT_ROOT, options: { checks: ['check'] } });
  assert.equal(existsSync(join(target, '.github/workflows/loop-check.yml')), false);
  const result = verifyInstall(collectFacts(target));
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('green-gate can resolve every required CI check'));
});

test('verify catches a removed CI workflow', () => {
  const target = tmpTarget();
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  // Remove the workflow the default requiredChecks ("check") relies on.
  rmSync(join(target, '.github/workflows/loop-check.yml'));
  const result = verifyInstall(collectFacts(target));
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('green-gate can resolve every required CI check'));
});

test('verify catches a missing queue and a missing runner', () => {
  const target = tmpTarget();
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  rmSync(join(target, '.loop/queue.json'));
  rmSync(join(target, '.claude/commands/run-next.md'));
  const result = verifyInstall(collectFacts(target));
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('.loop/queue.json exists and parses'));
  assert.ok(result.missing.includes('.claude/commands/run-next.md is present'));
});

test('verify reports the config problem when loop.config.json is invalid', () => {
  const target = tmpTarget();
  installLoop({ targetDir: target, kitRoot: KIT_ROOT });
  writeFileSync(join(target, 'loop.config.json'), '{ not valid json');
  const result = verifyInstall(collectFacts(target));
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('loop.config.json loads and validates'));
});
