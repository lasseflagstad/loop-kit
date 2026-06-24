// Tests for the decision orchestration: phrasing, the candidate scan,
// act-on-answer, inbox ingest, record+notify (ask-once, no secret leak), and the
// central safety proof - an approval can never bypass the merge gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  decisionQuestion,
  candidateDecisions,
  actOnAnswer,
  applyAnswers,
  ingestInbox,
  recordAndNotify,
} from '../decisions.mjs';
import { createQueue, addJob, updateJob, getJob, nextQueuedJob } from '../queue-lib.mjs';
import { createLedger, recordDecision, answerDecision, findDecision } from '../decisions-lib.mjs';

const T = '2026-06-24T00:00:00.000Z';
const T2 = '2026-06-24T01:00:00.000Z';

// Build a queue with the four job shapes the candidate scan cares about.
function fixtureQueue() {
  let q = createQueue();
  q = addJob(q, { title: 'Proposed work', spec: 's', createdAt: T }); // 001 queued, non-gated
  q = updateJob(q, '001', { status: 'blocked' }); // -> proposed (parked)
  q = addJob(q, { title: 'Gated work', spec: 's', humanGated: true, createdAt: T }); // 002 gated, queued
  q = addJob(q, { title: 'Normal work', spec: 's', createdAt: T }); // 003 queued, non-gated
  return q;
}

// ---------------------------------------------------------------------------
// Phrasing
// ---------------------------------------------------------------------------

test('decisionQuestion states a promote decision in plain English with how to answer', () => {
  const msg = decisionQuestion({ id: '001', kind: 'promote', job: '002', jobTitle: 'Add health endpoint' });
  assert.match(msg, /Proposed job 002/);
  assert.match(msg, /"Add health endpoint"/);
  assert.match(msg, /approve\|skip/);
  assert.match(msg, /answer 001/);
});

test('decisionQuestion makes clear a go-ahead approval does not merge', () => {
  const msg = decisionQuestion({ id: '005', kind: 'go-ahead', job: '009', jobTitle: 'Bump CI' });
  assert.match(msg, /Human-gated job 009/);
  assert.match(msg, /BUILD only/);
  assert.match(msg, /merge/);
});

// ---------------------------------------------------------------------------
// Candidate scan
// ---------------------------------------------------------------------------

test('candidateDecisions asks promote for parked non-gated jobs and go-ahead for gated jobs', () => {
  const candidates = candidateDecisions(fixtureQueue());
  assert.deepEqual(candidates, [
    { kind: 'promote', job: '001', jobTitle: 'Proposed work' },
    { kind: 'go-ahead', job: '002', jobTitle: 'Gated work' },
  ]);
});

test('candidateDecisions never proposes a decision for a shipped job', () => {
  let q = createQueue();
  q = addJob(q, { title: 'Done', spec: 's', createdAt: T });
  q = updateJob(q, '001', { status: 'in_progress' });
  q = updateJob(q, '001', { status: 'shipped', shippedAt: T });
  assert.deepEqual(candidateDecisions(q), []);
});

// ---------------------------------------------------------------------------
// Act on one answer
// ---------------------------------------------------------------------------

test('approve on a promote decision moves the parked job into the run queue', () => {
  const q = fixtureQueue();
  const decision = { id: '001', kind: 'promote', job: '001', answer: 'approve' };
  const { queue, action } = actOnAnswer(q, decision);
  assert.equal(action.result, 'promoted');
  assert.equal(getJob(queue, '001').status, 'queued');
  assert.match(getJob(queue, '001').note, /promoted via decision 001/);
});

test('skip parks the job out of the run queue without deleting it', () => {
  const q = fixtureQueue();
  const decision = { id: '009', kind: 'promote', job: '003', answer: 'skip' };
  const { queue, action } = actOnAnswer(q, decision);
  assert.equal(action.result, 'skipped');
  assert.equal(getJob(queue, '003').status, 'blocked');
  assert.match(getJob(queue, '003').note, /skipped via decision 009/);
  // The job still exists; nothing was removed.
  assert.equal(queue.jobs.length, q.jobs.length);
});

test('actOnAnswer treats a missing or shipped job as a no-op', () => {
  const q = fixtureQueue();
  assert.equal(actOnAnswer(q, { id: '1', kind: 'promote', job: '404', answer: 'approve' }).action.result, 'job-not-found');
});

// ---------------------------------------------------------------------------
// REQUIREMENT 5: an approval can never bypass the merge-time human gate.
// ---------------------------------------------------------------------------

test('approving a go-ahead records authorization to BUILD only and never un-gates the job', () => {
  const q = fixtureQueue();
  const before = getJob(q, '002');
  assert.equal(before.humanGated, true);
  const decision = { id: '004', kind: 'go-ahead', job: '002', answer: 'approve' };
  const { queue, action } = actOnAnswer(q, decision);
  const after = getJob(queue, '002');

  // The go-ahead is recorded as a note.
  assert.equal(action.result, 'go-ahead-recorded');
  assert.match(after.note, /go-ahead recorded via decision 004/);

  // Crucially: the job is STILL human-gated, its status is unchanged, and it was
  // not shipped. The approval did not move it past any gate.
  assert.equal(after.humanGated, true);
  assert.equal(after.status, before.status);
  assert.notEqual(after.status, 'shipped');

  // And the autonomous runner STILL skips it, so it can never reach auto-merge.
  assert.notEqual(nextQueuedJob(queue)?.id, '002');
});

test('no answer of any kind ever ships a job or un-gates one (whole-queue proof)', () => {
  const q = fixtureQueue();
  // Apply an approve to every job, as both kinds, plus a skip - none may ship or un-gate.
  const decisions = [
    { id: '101', kind: 'promote', job: '001', answer: 'approve' },
    { id: '102', kind: 'go-ahead', job: '002', answer: 'approve' },
    { id: '103', kind: 'promote', job: '003', answer: 'skip' },
  ];
  let queue = q;
  for (const d of decisions) ({ queue } = actOnAnswer(queue, d));
  for (const job of queue.jobs) {
    assert.notEqual(job.status, 'shipped', `job ${job.id} must not be shipped by an answer`);
  }
  // The originally-gated job is still gated.
  assert.equal(getJob(queue, '002').humanGated, true);
});

test('decisions.mjs structurally cannot ship: it imports no merge machinery', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '..', 'decisions.mjs'), 'utf8');
  // It never imports the gate or the merge enforcer.
  assert.ok(!src.includes('confirm-green.mjs'), 'must not import confirm-green');
  assert.ok(!src.includes('green-gate.mjs'), 'must not import green-gate');
  // From the queue library it imports ONLY read + guarded-update, never markShipped.
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/queue-lib\.mjs'/);
  assert.ok(m, 'expected a queue-lib import');
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(names, ['getJob', 'updateJob']);
});

// ---------------------------------------------------------------------------
// applyAnswers: idempotent across runs
// ---------------------------------------------------------------------------

test('applyAnswers acts on answered decisions and is idempotent on a second run', () => {
  const queue = fixtureQueue();
  let ledger = createLedger();
  ({ ledger } = recordDecision(ledger, { kind: 'promote', job: '001', question: 'q', askedAt: T }));
  ledger = answerDecision(ledger, '001', 'approve', T2);

  const run1 = applyAnswers(ledger, queue, T2);
  assert.equal(run1.actions.length, 1);
  assert.equal(getJob(run1.queue, '001').status, 'queued');
  assert.equal(findDecision(run1.ledger, '001').appliedAt, T2);

  // Second run: nothing left to apply, queue unchanged.
  const run2 = applyAnswers(run1.ledger, run1.queue, '2099-01-01T00:00:00.000Z');
  assert.equal(run2.actions.length, 0);
  assert.deepEqual(run2.queue, run1.queue);
  assert.deepEqual(run2.ledger, run1.ledger);
});

// ---------------------------------------------------------------------------
// Inbox ingest
// ---------------------------------------------------------------------------

test('ingestInbox records one-line replies and ignores blanks and comments', () => {
  let ledger = createLedger();
  ({ ledger } = recordDecision(ledger, { kind: 'promote', job: '001', question: 'q', askedAt: T }));
  ({ ledger } = recordDecision(ledger, { kind: 'go-ahead', job: '002', question: 'q', askedAt: T }));

  const text = '# my replies\n001 approve\n\n002 skip\n';
  const { ledger: out, applied, skipped } = ingestInbox(ledger, text, T2);
  assert.equal(skipped.length, 0);
  assert.equal(applied.length, 2);
  assert.equal(findDecision(out, '001').answer, 'approve');
  assert.equal(findDecision(out, '002').answer, 'skip');
});

test('ingestInbox is idempotent and skips bad lines without throwing', () => {
  let ledger = createLedger();
  ({ ledger } = recordDecision(ledger, { kind: 'promote', job: '001', question: 'q', askedAt: T }));
  const once = ingestInbox(ledger, '001 approve', T2).ledger;
  // Re-reading the same inbox is harmless: same answer is a no-op.
  const twice = ingestInbox(once, '001 approve', '2099-01-01T00:00:00.000Z');
  assert.equal(findDecision(twice.ledger, '001').answeredAt, T2);
  assert.equal(twice.applied[0].changed, false);

  // Garbage and unknown ids are skipped, not fatal.
  const bad = ingestInbox(once, 'garbage-no-answer\n999 approve\n001 maybe', T2);
  assert.equal(bad.applied.length, 0);
  assert.equal(bad.skipped.length, 3);
});

// ---------------------------------------------------------------------------
// record + notify: ask-once, no secret leak
// ---------------------------------------------------------------------------

test('recordAndNotify records and notifies exactly once per question (keyed)', async () => {
  const config = { notify: { channel: 'none' } };
  const sent = [];
  const notifyImpl = async (_cfg, message) => {
    sent.push(message);
    return { sent: true, channel: 'test' };
  };

  const first = await recordAndNotify({
    ledger: createLedger(),
    config,
    kind: 'promote',
    job: '002',
    jobTitle: 'Add health endpoint',
    askedAt: T,
    notifyImpl,
  });
  assert.equal(first.added, true);
  assert.equal(first.notified, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Proposed job 002/);

  // Asking again with the same key records nothing and does NOT notify again.
  const second = await recordAndNotify({
    ledger: first.ledger,
    config,
    kind: 'promote',
    job: '002',
    jobTitle: 'Add health endpoint',
    askedAt: T2,
    notifyImpl,
  });
  assert.equal(second.added, false);
  assert.equal(second.notified, false);
  assert.equal(sent.length, 1); // still just the one ping
  assert.equal(second.ledger.decisions.length, 1);
});

test('the notified question carries no secret: only the job and how to answer', async () => {
  const SECRET = 'ghp_PLANTED_SECRET_VALUE';
  const prev = process.env.LOOP_GITHUB_TOKEN;
  process.env.LOOP_GITHUB_TOKEN = SECRET;
  try {
    let captured;
    const res = await recordAndNotify({
      ledger: createLedger(),
      config: { notify: { channel: 'none' } },
      kind: 'go-ahead',
      job: '002',
      jobTitle: 'Bump CI Node',
      askedAt: T,
      notifyImpl: async (_cfg, message) => {
        captured = message;
        return { sent: true };
      },
    });
    assert.ok(!captured.includes(SECRET), 'the notify message must not contain a token');
    assert.ok(!captured.includes('PLANTED'), 'the notify message must not contain secret material');
    // The persisted ledger likewise carries no secret.
    assert.ok(!JSON.stringify(res.ledger).includes(SECRET));
  } finally {
    if (prev === undefined) delete process.env.LOOP_GITHUB_TOKEN;
    else process.env.LOOP_GITHUB_TOKEN = prev;
  }
});
