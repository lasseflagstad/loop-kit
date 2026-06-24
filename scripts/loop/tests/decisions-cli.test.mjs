// End-to-end tests for the decisions CLI: ask-pending records + notifies once,
// answer records a reply, and apply acts on answers (promote, skip), idempotently
// and via the configured answers inbox. Everything round-trips through real temp
// files so the IO + notify path is exercised without any network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as decisionsCli } from '../decisions-cli.mjs';
import { writeQueue, readQueue } from '../queue-io.mjs';
import { readLedger } from '../decisions-io.mjs';
import { createQueue, addJob, updateJob } from '../queue-lib.mjs';

const T = '2026-06-24T00:00:00.000Z';
const NOW = Date.parse(T);

// A throwaway workspace: a config, a queue with one parked (proposed) job and one
// human-gated job, and an empty ledger. notify writes to notify.log (file channel).
function setup({ notifyChannel = 'file', inbox } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loopdcli-'));
  const configPath = join(dir, 'loop.config.json');
  const queuePath = join(dir, 'queue.json');
  const decisionsPath = join(dir, 'decisions.json');
  const notifyLog = join(dir, 'notify.log');

  const config = {
    requiredChecks: ['check'],
    branchPrefix: 'claude/',
    mergeMode: 'auto-merge-on-green',
    notify: notifyChannel === 'file' ? { channel: 'file', target: notifyLog } : { channel: 'none' },
  };
  if (inbox) config.decisions = { inbox };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  let q = createQueue();
  q = addJob(q, { title: 'Proposed work', spec: 's', createdAt: T }); // 001
  q = updateJob(q, '001', { status: 'blocked' }); // parked -> proposed
  q = addJob(q, { title: 'Gated work', spec: 's', humanGated: true, createdAt: T }); // 002 gated
  writeQueue(queuePath, q);
  writeFileSync(decisionsPath, JSON.stringify({ version: 1, decisions: [] }, null, 2) + '\n');

  return { dir, configPath, queuePath, decisionsPath, notifyLog };
}

// Run the CLI capturing stdout/stderr.
async function run(args, paths) {
  const argv = [
    ...args,
    '--config', paths.configPath,
    '--queue', paths.queuePath,
    '--decisions', paths.decisionsPath,
  ];
  let out = '';
  let err = '';
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  let code;
  try {
    code = await decisionsCli(argv, process.env, NOW);
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
  return { code, out, err };
}

test('ask-pending records and notifies one question per awaiting job, exactly once', async () => {
  const paths = setup();
  const first = await run(['ask-pending'], paths);
  assert.equal(first.code, 0);
  assert.match(first.out, /asked 001 \(promote, job 001\)/);
  assert.match(first.out, /asked 002 \(go-ahead, job 002\)/);

  // Two notifications were delivered to the file channel.
  const log1 = readFileSync(paths.notifyLog, 'utf8').trimEnd().split('\n');
  assert.equal(log1.length, 2);
  assert.match(log1[0], /Proposed job 001/);
  assert.match(log1[1], /Human-gated job 002/);

  // A second ask-pending re-notifies nothing: the questions are keyed.
  const second = await run(['ask-pending'], paths);
  assert.match(second.out, /already asked/);
  const log2 = readFileSync(paths.notifyLog, 'utf8').trimEnd().split('\n');
  assert.equal(log2.length, 2, 'no new notifications on the second run');

  const ledger = readLedger(paths.decisionsPath);
  assert.equal(ledger.decisions.length, 2);
});

test('answer records a reply that apply then acts on: approve promotes the proposed job', async () => {
  const paths = setup();
  await run(['ask-pending'], paths);

  const answered = await run(['answer', '001', 'approve'], paths);
  assert.equal(answered.code, 0);
  assert.match(answered.out, /answered 001: approve/);

  const applied = await run(['apply'], paths);
  assert.match(applied.out, /applied 001 \(promote approve\) on job 001: promoted/);

  // The parked job is now in the run queue.
  const q = readQueue(paths.queuePath);
  assert.equal(q.jobs.find((j) => j.id === '001').status, 'queued');

  // apply is idempotent: a second run does nothing.
  const again = await run(['apply'], paths);
  assert.match(again.out, /\(no answered decisions to apply\)/);
  const q2 = readQueue(paths.queuePath);
  assert.equal(q2.jobs.find((j) => j.id === '001').status, 'queued');
});

test('a skip answer parks the job and apply does not promote it', async () => {
  const paths = setup();
  await run(['ask-pending'], paths);
  await run(['answer', '001', 'skip'], paths);
  const applied = await run(['apply'], paths);
  assert.match(applied.out, /applied 001 \(promote skip\) on job 001: skipped/);

  const q = readQueue(paths.queuePath);
  const job = q.jobs.find((j) => j.id === '001');
  assert.equal(job.status, 'blocked');
  assert.match(job.note, /skipped via decision 001/);
});

test('approving the go-ahead never un-gates the gated job (merge gate intact)', async () => {
  const paths = setup();
  await run(['ask-pending'], paths);
  // Decision 002 is the go-ahead for the human-gated job 002.
  await run(['answer', '002', 'approve'], paths);
  await run(['apply'], paths);

  const q = readQueue(paths.queuePath);
  const gated = q.jobs.find((j) => j.id === '002');
  assert.equal(gated.humanGated, true, 'the job stays human-gated');
  assert.notEqual(gated.status, 'shipped');
  assert.match(gated.note, /go-ahead recorded via decision 002/);
});

test('apply reads replies from the configured answers inbox on the next run', async () => {
  const inbox = join(mkdtempSync(join(tmpdir(), 'loopinbox-')), 'answers.inbox');
  const paths = setup({ notifyChannel: 'none', inbox });
  await run(['ask-pending'], paths);

  // Reply by appending a one-line answer to the inbox, no CLI answer call.
  writeFileSync(inbox, '# my reply\n001 approve\n');

  const applied = await run(['apply'], paths);
  assert.match(applied.out, /inbox: recorded 001 = approve/);
  assert.match(applied.out, /applied 001 \(promote approve\) on job 001: promoted/);

  const q = readQueue(paths.queuePath);
  assert.equal(q.jobs.find((j) => j.id === '001').status, 'queued');
});

test('answer rejects an answer outside the allowed set', async () => {
  const paths = setup({ notifyChannel: 'none' });
  await run(['ask-pending'], paths);
  const bad = await run(['answer', '001', 'maybe'], paths);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not an allowed answer/);
});

test('list shows decisions and their state', async () => {
  const paths = setup({ notifyChannel: 'none' });
  await run(['ask-pending'], paths);
  await run(['answer', '001', 'approve'], paths);
  const listed = await run(['list'], paths);
  assert.match(listed.out, /001\s+promote\s+job 001\s+answered:approve/);
  assert.match(listed.out, /002\s+go-ahead\s+job 002\s+awaiting answer/);
});
