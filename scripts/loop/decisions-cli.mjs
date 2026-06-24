#!/usr/bin/env node
// decisions-cli.mjs - the operator/runner CLI over the two-way decisions ledger.
//
//   loop-decisions list                         show every decision and its state
//   loop-decisions ask --kind <k> --job <id>    record + notify ONE decision (keyed)
//   loop-decisions ask-pending                  scan the queue and ask for every job
//                                               awaiting a non-merge decision (keyed)
//   loop-decisions answer <id> <approve|skip>   record YOUR reply to a decision
//   loop-decisions apply                        on the next run: ingest the answers
//                                               inbox, act on answered decisions,
//                                               and mark them applied (idempotent)
//
// `ask` / `ask-pending` are the ask-on-stop step the runner calls when it has
// nothing to build but a job is awaiting your decision. `apply` is the
// act-on-answer step the runner calls BEFORE picking a job. `answer` is how you
// reply without opening GitHub; editing .loop/decisions.json by hand works too.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { readQueue, writeQueue, DEFAULT_QUEUE_PATH } from './queue-io.mjs';
import { readLedger, writeLedger, DEFAULT_DECISIONS_PATH } from './decisions-io.mjs';
import { getJob } from './queue-lib.mjs';
import { answerDecision, findDecision } from './decisions-lib.mjs';
import {
  candidateDecisions,
  recordAndNotify,
  applyAnswers,
  ingestInbox,
} from './decisions.mjs';

const USAGE = `Usage:
  loop-decisions list
  loop-decisions ask --kind <promote|go-ahead> --job <job-id>
  loop-decisions ask-pending
  loop-decisions answer <decision-id> <answer>
  loop-decisions apply

Options:
  --config    <path>   loop.config.json (default ${DEFAULT_CONFIG_PATH})
  --queue     <path>   queue file       (default ${DEFAULT_QUEUE_PATH})
  --decisions <path>   ledger file      (default ${DEFAULT_DECISIONS_PATH})`;

function parseArgs(argv) {
  const args = {
    _: [],
    configPath: DEFAULT_CONFIG_PATH,
    queuePath: DEFAULT_QUEUE_PATH,
    decisionsPath: DEFAULT_DECISIONS_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') args.kind = argv[++i];
    else if (a === '--job') args.job = argv[++i];
    else if (a === '--config') args.configPath = argv[++i];
    else if (a === '--queue') args.queuePath = argv[++i];
    else if (a === '--decisions') args.decisionsPath = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

// Load config, defaulting to a silent (no-notify) config if it cannot be read,
// exactly like notify.mjs: a missing config must never break the decision flow.
function loadConfigOrSilent(configPath) {
  try {
    return loadConfig(configPath);
  } catch {
    return { notify: { channel: 'none' } };
  }
}

async function cmdList(args, out) {
  const ledger = readLedger(args.decisionsPath);
  if (ledger.decisions.length === 0) {
    out('(no decisions)\n');
    return 0;
  }
  for (const d of ledger.decisions) {
    const state = d.appliedAt
      ? `answered:${d.answer} (applied)`
      : d.answer
        ? `answered:${d.answer}`
        : 'awaiting answer';
    out(`${d.id}  ${d.kind.padEnd(8)}  job ${d.job}  ${state}\n`);
  }
  return 0;
}

async function cmdAsk(args, out, err, now) {
  if (!args.kind || !args.job) {
    err('error: ask requires --kind <promote|go-ahead> and --job <job-id>\n');
    return 2;
  }
  const config = loadConfigOrSilent(args.configPath);
  const queue = readQueue(args.queuePath);
  const job = getJob(queue, args.job);
  const jobTitle = job ? job.title : undefined;
  const askedAt = new Date(now).toISOString();
  const ledger = readLedger(args.decisionsPath);
  const res = await recordAndNotify({
    ledger,
    config,
    kind: args.kind,
    job: args.job,
    jobTitle,
    askedAt,
  });
  if (res.added) {
    writeLedger(args.decisionsPath, res.ledger);
    out(`asked ${res.decision.id} (${res.decision.kind}, job ${res.decision.job}); notified=${res.notified}\n`);
  } else {
    out(`already asked (${res.decision.id}, ${res.decision.kind}, job ${res.decision.job}); not re-notified\n`);
  }
  return 0;
}

async function cmdAskPending(args, out, now) {
  const config = loadConfigOrSilent(args.configPath);
  const queue = readQueue(args.queuePath);
  const askedAt = new Date(now).toISOString();
  let ledger = readLedger(args.decisionsPath);
  const candidates = candidateDecisions(queue);
  if (candidates.length === 0) {
    out('(no jobs awaiting a decision)\n');
    return 0;
  }
  let asked = 0;
  for (const c of candidates) {
    const res = await recordAndNotify({ ledger, config, ...c, askedAt });
    ledger = res.ledger;
    if (res.added) {
      asked++;
      out(`asked ${res.decision.id} (${res.decision.kind}, job ${res.decision.job}); notified=${res.notified}\n`);
    }
  }
  if (asked > 0) writeLedger(args.decisionsPath, ledger);
  if (asked === 0) out('(all pending jobs were already asked)\n');
  return 0;
}

function cmdAnswer(args, out, err, now) {
  const id = args._[1];
  const answer = args._[2];
  if (!id || !answer) {
    err('error: answer requires <decision-id> and <answer>\n');
    return 2;
  }
  const ledger = readLedger(args.decisionsPath);
  const decision = findDecision(ledger, id);
  if (!decision) {
    err(`error: no decision with id ${id}\n`);
    return 2;
  }
  let next;
  try {
    next = answerDecision(ledger, id, answer, new Date(now).toISOString());
  } catch (e) {
    err(`error: ${e.message}\n`);
    return 2;
  }
  writeLedger(args.decisionsPath, next);
  out(`answered ${id}: ${answer}\n`);
  return 0;
}

// Resolve the configured answers-inbox path, or null if none is configured.
function inboxPath(config) {
  const inbox = config && config.decisions && config.decisions.inbox;
  return inbox ? String(inbox) : null;
}

function cmdApply(args, out, now) {
  const config = loadConfigOrSilent(args.configPath);
  const answeredAt = new Date(now).toISOString();
  let ledger = readLedger(args.decisionsPath);

  // 1. Ingest replies from the configured answers inbox, if any. Reading the
  //    inbox is best-effort: a missing or unreadable file simply yields nothing.
  const inbox = inboxPath(config);
  if (inbox) {
    const abs = resolve(inbox);
    if (existsSync(abs)) {
      let text = '';
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        text = '';
      }
      const ingest = ingestInbox(ledger, text, answeredAt);
      ledger = ingest.ledger;
      for (const a of ingest.applied) {
        if (a.changed) out(`inbox: recorded ${a.id} = ${a.answer}\n`);
      }
      for (const s of ingest.skipped) {
        out(`inbox: skipped "${s.line}" (${s.reason})\n`);
      }
    }
  }

  // 2. Act on every answered-but-unapplied decision against the queue, and mark
  //    each applied so this is idempotent across runs.
  const queue = readQueue(args.queuePath);
  const { ledger: nextLedger, queue: nextQueue, actions } = applyAnswers(ledger, queue, answeredAt);

  // Persist whatever changed. validateQueue/validateLedger run on write.
  writeLedger(args.decisionsPath, nextLedger);
  writeQueue(args.queuePath, nextQueue);

  if (actions.length === 0) {
    out('(no answered decisions to apply)\n');
    return 0;
  }
  for (const a of actions) {
    out(`applied ${a.decision} (${a.kind} ${a.answer}) on job ${a.job}: ${a.result}\n`);
  }
  return 0;
}

export async function main(argv, env, now) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);

  if (args.help || !cmd) {
    out(USAGE + '\n');
    return args.help ? 0 : 2;
  }

  switch (cmd) {
    case 'list':
      return cmdList(args, out);
    case 'ask':
      return cmdAsk(args, out, err, now);
    case 'ask-pending':
      return cmdAskPending(args, out, now);
    case 'answer':
      return cmdAnswer(args, out, err, now);
    case 'apply':
      return cmdApply(args, out, now);
    default:
      err(`unknown command: ${cmd}\n\n${USAGE}\n`);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, Date.now()).then((code) => process.exit(code));
}

export { parseArgs };
