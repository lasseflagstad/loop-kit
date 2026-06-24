#!/usr/bin/env node
// notify.mjs - a one-way ping for when the runner stops.
//
// "One-way" means fire-and-forget: it never blocks the loop and never throws
// out. Any failure to deliver is swallowed and reported in the return value, so
// a broken notify channel can never take down a run. The channel is chosen
// entirely by loop.config.json (notify.channel + notify.target):
//
//   none      do nothing
//   file      append a timestamped line to the target file
//   webhook   POST { text, timestamp } as JSON to the target URL
//   command   run the target shell template with the message in
//             $LOOP_NOTIFY_MESSAGE (passed via env, never interpolated, so the
//             message cannot inject shell)

import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';

function runCommand(template, message, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(template, {
      shell: true,
      env: { ...env, LOOP_NOTIFY_MESSAGE: message },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`notify command exited ${code}`))
    );
  });
}

// notify(config, message, deps) -> { sent, channel, error? }
// deps lets tests inject the side effects without real I/O.
export async function notify(config, message, deps = {}) {
  const channel = config?.notify?.channel ?? 'none';
  const target = config?.notify?.target;
  const timestamp = deps.timestamp ?? new Date().toISOString();
  const line = `${timestamp} ${message}`;

  const {
    appendImpl = appendFile,
    fetchImpl = fetch,
    runImpl = runCommand,
    env = process.env,
  } = deps;

  try {
    if (channel === 'none') {
      return { sent: false, channel };
    }
    if (channel === 'file') {
      await appendImpl(target, line + '\n', 'utf8');
      return { sent: true, channel };
    }
    if (channel === 'webhook') {
      const res = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, timestamp }),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return { sent: true, channel };
    }
    if (channel === 'command') {
      await runImpl(target, message, env);
      return { sent: true, channel };
    }
    return { sent: false, channel, error: `unknown channel: ${channel}` };
  } catch (err) {
    // Never propagate: a failed ping must not stop the loop.
    return { sent: false, channel, error: err.message };
  }
}

async function main(argv, env) {
  const configPath =
    argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : DEFAULT_CONFIG_PATH;
  const message =
    argv.filter((a, i) => a !== '--config' && argv[i - 1] !== '--config').join(' ').trim() ||
    'loop runner stopped';
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    // If config can't load, default to silent: never fail the stop hook.
    config = { notify: { channel: 'none' } };
  }
  const result = await notify(config, message, { env });
  if (result.error) {
    process.stderr.write(`notify (${result.channel}) failed: ${result.error}\n`);
  }
  // Always exit 0: notify is best-effort and must not fail a Stop hook.
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}

export { main, runCommand };
