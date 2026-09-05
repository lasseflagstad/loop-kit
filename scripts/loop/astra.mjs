#!/usr/bin/env node
// astra.mjs - the safe Claude Code to GPT-6 Astra bridge.
//
// Claude Code remains the orchestrator. This wrapper gives it one narrow,
// repeatable way to delegate a bounded task to Codex running GPT-6 Astra. It
// never invokes a shell, never enables danger-full-access, and always pins the
// configured model on the command line so the selected worker is auditable.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { isDirectInvocation } from './direct.mjs';

export const DEFAULT_ASTRA = Object.freeze({
  enabled: true,
  command: 'codex',
  model: 'gpt-6-astra',
  reasoningEffort: 'high',
  sandbox: 'workspace-write',
});

const VALID_MODES = new Set(['build', 'review', 'plan']);

export function buildWorkerPrompt({ task, mode = 'build' }) {
  const permission = mode === 'build'
    ? 'You may edit files inside the current workspace and run relevant checks.'
    : 'This is read-only work. Do not edit files.';

  return [
    'You are GPT-6 Astra, acting as a bounded worker for a Claude Code orchestrator.',
    'Complete only the delegated task below. Read the repository rulebook first.',
    'Do not launch Claude Code, Codex, or another agent. Do not expand the scope.',
    permission,
    'Before finishing, verify the work in proportion to its risk.',
    'End with a concise handback containing: outcome, files changed, checks run, and blockers.',
    '',
    `Delegation mode: ${mode}`,
    'Delegated task:',
    task.trim(),
  ].join('\n');
}

export function buildCodexArgs({
  cwd,
  task,
  mode = 'build',
  astra = DEFAULT_ASTRA,
  outputFile,
}) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...VALID_MODES].join(', ')}`);
  }
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('a non-empty delegated task is required');
  }

  const sandbox = mode === 'build' ? astra.sandbox : 'read-only';
  const args = [
    'exec',
    '--model', astra.model,
    '--sandbox', sandbox,
    '--ephemeral',
    '--cd', resolve(cwd),
    '--config', `model_reasoning_effort=${JSON.stringify(astra.reasoningEffort)}`,
  ];
  if (outputFile) args.push('--output-last-message', resolve(outputFile));
  args.push(buildWorkerPrompt({ task, mode }));
  return args;
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

export function doctor({ cwd = '.', live = false, astra = DEFAULT_ASTRA, spawn = spawnSync } = {}) {
  const checks = [];

  const version = spawn(astra.command, ['--version'], { cwd, encoding: 'utf8' });
  checks.push({
    name: 'Codex CLI is installed',
    ok: version.status === 0,
    detail: outputOf(version) || version.error?.message || 'not found',
  });
  if (version.status !== 0) return { ok: false, checks };

  const login = spawn(astra.command, ['login', 'status'], { cwd, encoding: 'utf8' });
  checks.push({
    name: 'Codex CLI is authenticated',
    ok: login.status === 0,
    detail: outputOf(login) || login.error?.message || 'not authenticated',
  });

  checks.push({
    name: 'Worker model is pinned',
    ok: astra.model === 'gpt-6-astra',
    detail: astra.model,
  });

  if (live && checks.every((check) => check.ok)) {
    const temp = mkdtempSync(join(tmpdir(), 'loop-astra-doctor-'));
    const outputFile = join(temp, 'last-message.txt');
    const prompt = 'Reply with exactly ASTRA_OK. Do not use tools.';
    const args = [
      'exec',
      '--model', astra.model,
      '--sandbox', 'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--cd', resolve(cwd),
      '--config', 'model_reasoning_effort="low"',
      '--output-last-message', outputFile,
      prompt,
    ];
    const probe = spawn(astra.command, args, { cwd, encoding: 'utf8' });
    const reply = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').trim() : '';
    checks.push({
      name: 'Live GPT-6 Astra call succeeds',
      ok: probe.status === 0 && reply === 'ASTRA_OK',
      detail: reply || outputOf(probe) || probe.error?.message || 'no response',
    });
    rmSync(temp, { recursive: true, force: true });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

export function parseArgs(argv) {
  const args = { command: 'help', mode: 'build', cwd: '.', live: false };
  let i = 0;
  if (argv[0] === 'run' || argv[0] === 'doctor') args.command = argv[i++];
  else if (argv[0] === '--help' || argv[0] === '-h') return args;

  for (; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--mode') args.mode = argv[++i];
    else if (value === '--task') args.task = argv[++i];
    else if (value === '--task-file') args.taskFile = argv[++i];
    else if (value === '--output') args.outputFile = argv[++i];
    else if (value === '--config') args.configPath = argv[++i];
    else if (value === '--cwd' || value === '--cd') args.cwd = argv[++i];
    else if (value === '--live') args.live = true;
    else if (value === '--help' || value === '-h') args.command = 'help';
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function readTask(args) {
  if (args.task !== undefined) return args.task;
  if (args.taskFile !== undefined) return readFileSync(resolve(args.cwd, args.taskFile), 'utf8');
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  return '';
}

const USAGE = `Usage:
  node scripts/loop/astra.mjs doctor [--live] [--cwd <dir>]
  node scripts/loop/astra.mjs run --mode <build|review|plan> --task "<task>"
  node scripts/loop/astra.mjs run --mode review < task.txt

Options:
  --live               make a real read-only GPT-6 Astra probe
  --cwd, --cd <dir>    target repository (default current directory)
  --config <path>      config path (default <cwd>/loop.config.json)
  --task <text>        bounded task to delegate
  --task-file <path>   read the task from a file
  --output <path>      save Astra's final handback

The build mode uses workspace-write. Plan and review are always read-only.
The wrapper never enables danger-full-access.`;

export function main(argv, { spawn = spawnSync } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`astra bridge: ${err.message}\n`);
    return 2;
  }
  if (args.command === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const cwd = resolve(args.cwd);
  let config;
  try {
    config = loadConfig(args.configPath ? resolve(cwd, args.configPath) : resolve(cwd, 'loop.config.json'));
  } catch (err) {
    process.stderr.write(`astra bridge: ${err.message}\n`);
    return 2;
  }
  const astra = config.astra;
  if (!astra.enabled) {
    process.stderr.write('astra bridge: disabled in loop.config.json\n');
    return 2;
  }

  if (args.command === 'doctor') {
    const result = doctor({ cwd, live: args.live, astra, spawn });
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
    }
    if (!args.live && result.ok) {
      process.stdout.write('READY  Run again with --live to prove model access end to end.\n');
    }
    return result.ok ? 0 : 1;
  }

  let task;
  try {
    task = readTask(args);
    const codexArgs = buildCodexArgs({
      cwd,
      task,
      mode: args.mode,
      astra,
      outputFile: args.outputFile,
    });
    const result = spawn(astra.command, codexArgs, { cwd, stdio: 'inherit' });
    return result.status ?? 1;
  } catch (err) {
    process.stderr.write(`astra bridge: ${err.message}\n`);
    return 2;
  }
}

if (isDirectInvocation(import.meta.url)) process.exit(main(process.argv.slice(2)));
