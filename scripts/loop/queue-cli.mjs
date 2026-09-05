#!/usr/bin/env node
// queue-cli.mjs - a thin operator CLI over the add-only queue.
//
//   loop-queue list                       show all jobs
//   loop-queue next [--include-gated]      show the next job the runner would pick
//   loop-queue add --title T --spec S [--human-gated]    append a queued job
//
// 'add' is the only mutation, and it only ever appends. There is no remove.

import { readQueue, writeQueue, DEFAULT_QUEUE_PATH } from './queue-io.mjs';
import { addJob, nextQueuedJob } from './queue-lib.mjs';
import { isDirectInvocation } from './direct.mjs';

function parseArgs(argv) {
  const args = { _: [], queuePath: DEFAULT_QUEUE_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') args.title = argv[++i];
    else if (a === '--spec') args.spec = argv[++i];
    else if (a === '--human-gated') args.humanGated = true;
    else if (a === '--include-gated') args.includeHumanGated = true;
    else if (a === '--queue') args.queuePath = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

const USAGE = `Usage:
  loop-queue list
  loop-queue next [--include-gated]
  loop-queue add --title <title> --spec <spec> [--human-gated]

Options:
  --queue <path>   queue file (default ${DEFAULT_QUEUE_PATH})`;

function main(argv, env, now) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.help || !cmd) {
    process.stdout.write(USAGE + '\n');
    return args.help ? 0 : 2;
  }

  if (cmd === 'list') {
    const q = readQueue(args.queuePath);
    if (q.jobs.length === 0) {
      process.stdout.write('(queue is empty)\n');
      return 0;
    }
    for (const job of q.jobs) {
      const gate = job.humanGated ? ' [human-gated]' : '';
      process.stdout.write(`${job.id}  ${job.status.padEnd(11)}  ${job.title}${gate}\n`);
    }
    return 0;
  }

  if (cmd === 'next') {
    const q = readQueue(args.queuePath);
    const job = nextQueuedJob(q, { includeHumanGated: !!args.includeHumanGated });
    if (!job) {
      process.stdout.write('(no queued job)\n');
      return 0;
    }
    process.stdout.write(`${job.id}  ${job.title}\n`);
    return 0;
  }

  if (cmd === 'add') {
    if (!args.title || !args.spec) {
      process.stderr.write('error: add requires --title and --spec\n');
      return 2;
    }
    const q = readQueue(args.queuePath);
    const createdAt = new Date(now).toISOString();
    const next = addJob(q, {
      title: args.title,
      spec: args.spec,
      humanGated: !!args.humanGated,
      createdAt,
    });
    writeQueue(args.queuePath, next);
    const added = next.jobs[next.jobs.length - 1];
    process.stdout.write(`added ${added.id}: ${added.title}\n`);
    return 0;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}\n`);
  return 2;
}

if (isDirectInvocation(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env, Date.now()));
}

export { main, parseArgs };
