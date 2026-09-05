import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, buildWorkerPrompt, doctor, parseArgs } from '../astra.mjs';

const ASTRA = {
  enabled: true,
  command: 'codex',
  model: 'gpt-6-astra',
  reasoningEffort: 'high',
  sandbox: 'workspace-write',
};

test('build mode pins GPT-6 Astra and uses workspace-write without bypass flags', () => {
  const args = buildCodexArgs({ cwd: '.', task: 'Implement the endpoint.', mode: 'build', astra: ASTRA });
  assert.deepEqual(args.slice(0, 5), ['exec', '--model', 'gpt-6-astra', '--sandbox', 'workspace-write']);
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.some((value) => value === 'model_reasoning_effort="high"'));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.match(args.at(-1), /Implement the endpoint/);
});

test('plan and review modes are forced read-only', () => {
  for (const mode of ['plan', 'review']) {
    const args = buildCodexArgs({ cwd: '.', task: 'Inspect this.', mode, astra: ASTRA });
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.match(args.at(-1), /Do not edit files/);
  }
});

test('worker prompt sets a bounded handback contract and prevents recursive delegation', () => {
  const prompt = buildWorkerPrompt({ task: 'Review auth.', mode: 'review' });
  assert.match(prompt, /bounded worker for a Claude Code orchestrator/);
  assert.match(prompt, /Do not launch Claude Code, Codex, or another agent/);
  assert.match(prompt, /outcome, files changed, checks run, and blockers/);
});

test('bad modes and empty tasks fail closed', () => {
  assert.throws(() => buildCodexArgs({ cwd: '.', task: 'x', mode: 'unsafe', astra: ASTRA }), /mode/);
  assert.throws(() => buildCodexArgs({ cwd: '.', task: '  ', mode: 'build', astra: ASTRA }), /non-empty/);
});

test('doctor proves install, authentication, and the pinned model without a live call', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 1.2.3\n', stderr: '' };
    return { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
  };
  const result = doctor({ cwd: '.', astra: ASTRA, spawn });
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 3);
  assert.deepEqual(calls.map((call) => call[1]), [['--version'], ['login', 'status']]);
});

test('doctor fails closed when Codex is absent', () => {
  const result = doctor({
    cwd: '.',
    astra: ASTRA,
    spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 1);
});

test('CLI parser accepts a piped review task and live doctor', () => {
  assert.deepEqual(parseArgs(['doctor', '--live']), {
    command: 'doctor', mode: 'build', cwd: '.', live: true,
  });
  assert.deepEqual(parseArgs(['run', '--mode', 'review', '--task', 'Find bugs']), {
    command: 'run', mode: 'review', cwd: '.', live: false, task: 'Find bugs',
  });
});

