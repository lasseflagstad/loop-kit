// Tests for the queue library's add-only discipline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQueue,
  validateQueue,
  addJob,
  getJob,
  updateJob,
  markShipped,
  nextId,
  nextQueuedJob,
  QueueError,
} from '../queue-lib.mjs';

const T = '2026-06-24T00:00:00.000Z';

function withJob(extra = {}) {
  return addJob(createQueue(), { title: 'A', spec: 'do a', createdAt: T, ...extra });
}

test('createQueue produces an empty versioned queue', () => {
  const q = createQueue();
  assert.equal(q.version, 1);
  assert.deepEqual(q.jobs, []);
});

test('addJob appends a queued job and assigns a zero-padded id', () => {
  const q = withJob();
  assert.equal(q.jobs.length, 1);
  assert.equal(q.jobs[0].id, '001');
  assert.equal(q.jobs[0].status, 'queued');
  assert.equal(q.jobs[0].humanGated, false);
});

test('addJob does not mutate the input queue (pure transform)', () => {
  const q0 = createQueue();
  const q1 = addJob(q0, { title: 'A', spec: 'a', createdAt: T });
  assert.equal(q0.jobs.length, 0);
  assert.equal(q1.jobs.length, 1);
});

test('nextId increments from the highest numeric id', () => {
  let q = withJob();
  q = addJob(q, { title: 'B', spec: 'b', createdAt: T });
  assert.equal(q.jobs[1].id, '002');
  assert.equal(nextId(q), '003');
});

test('addJob requires title, spec, and createdAt', () => {
  assert.throws(() => addJob(createQueue(), { spec: 'a', createdAt: T }), QueueError);
  assert.throws(() => addJob(createQueue(), { title: 'a', createdAt: T }), QueueError);
  assert.throws(() => addJob(createQueue(), { title: 'a', spec: 'a' }), QueueError);
});

test('there is no delete operation (add-only): only add/update are exported', async () => {
  const mod = await import('../queue-lib.mjs');
  for (const name of Object.keys(mod)) {
    assert.ok(!/delete|remove|drop/i.test(name), `unexpected destructive export: ${name}`);
  }
});

test('updateJob allows queued -> in_progress and records mutable fields', () => {
  let q = withJob();
  q = updateJob(q, '001', { status: 'in_progress', branch: 'claude/a', note: 'building' });
  const job = getJob(q, '001');
  assert.equal(job.status, 'in_progress');
  assert.equal(job.branch, 'claude/a');
});

test('updateJob refuses to rewrite immutable fields', () => {
  const q = withJob();
  for (const field of ['id', 'title', 'spec', 'createdAt']) {
    assert.throws(
      () => updateJob(q, '001', { [field]: 'changed' }),
      QueueError,
      `${field} must be immutable`
    );
  }
});

test('updateJob allows a no-op re-set of an immutable field to the same value', () => {
  const q = withJob();
  // Passing the same title back is not a rewrite.
  const q2 = updateJob(q, '001', { title: 'A', status: 'in_progress' });
  assert.equal(getJob(q2, '001').status, 'in_progress');
});

test('updateJob refuses to un-gate a human-gated job (true -> false)', () => {
  const q = withJob({ humanGated: true });
  assert.throws(() => updateJob(q, '001', { humanGated: false }), QueueError);
});

test('updateJob allows gating a job (false -> true)', () => {
  const q = withJob();
  const q2 = updateJob(q, '001', { humanGated: true });
  assert.equal(getJob(q2, '001').humanGated, true);
});

test('updateJob refuses illegal status transitions', () => {
  const q = withJob();
  // queued -> shipped is not allowed; must pass through in_progress.
  assert.throws(() => updateJob(q, '001', { status: 'shipped' }), QueueError);
});

test('a shipped job is frozen: any further update is refused', () => {
  let q = withJob();
  q = updateJob(q, '001', { status: 'in_progress' });
  q = markShipped(q, '001', { pr: 'https://example/pr/1', headSha: 'd'.repeat(40), shippedAt: T });
  assert.equal(getJob(q, '001').status, 'shipped');
  assert.throws(() => updateJob(q, '001', { note: 'too late' }), QueueError);
  assert.throws(() => updateJob(q, '001', { status: 'queued' }), QueueError);
});

test('markShipped records pr, headSha, shippedAt and transitions to shipped', () => {
  let q = withJob();
  q = updateJob(q, '001', { status: 'in_progress' });
  q = markShipped(q, '001', { pr: 42, headSha: 'e'.repeat(40), shippedAt: T });
  const job = getJob(q, '001');
  assert.equal(job.status, 'shipped');
  assert.equal(job.pr, 42);
  assert.equal(job.shippedAt, T);
});

test('updateJob throws for an unknown job id', () => {
  assert.throws(() => updateJob(withJob(), '999', { note: 'x' }), QueueError);
});

test('blocked is reachable and recoverable', () => {
  let q = withJob();
  q = updateJob(q, '001', { status: 'blocked' });
  assert.equal(getJob(q, '001').status, 'blocked');
  q = updateJob(q, '001', { status: 'queued' });
  assert.equal(getJob(q, '001').status, 'queued');
});

test('nextQueuedJob returns the oldest queued job and skips human-gated by default', () => {
  let q = withJob({ humanGated: true }); // 001, gated
  q = addJob(q, { title: 'B', spec: 'b', createdAt: T }); // 002, normal
  const job = nextQueuedJob(q);
  assert.equal(job.id, '002');
  // With includeHumanGated, the gated one is visible and comes first.
  assert.equal(nextQueuedJob(q, { includeHumanGated: true }).id, '001');
});

test('nextQueuedJob returns undefined when nothing is queued', () => {
  let q = withJob();
  q = updateJob(q, '001', { status: 'in_progress' });
  assert.equal(nextQueuedJob(q), undefined);
});

test('validateQueue rejects malformed queues', () => {
  assert.throws(() => validateQueue({ version: 2, jobs: [] }), QueueError);
  assert.throws(() => validateQueue({ version: 1, jobs: 'x' }), QueueError);
  assert.throws(
    () => validateQueue({ version: 1, jobs: [{ id: '001' }] }),
    QueueError
  );
  assert.throws(
    () =>
      validateQueue({
        version: 1,
        jobs: [
          { id: '001', title: 'a', spec: 'a', createdAt: T, status: 'queued', humanGated: false },
          { id: '001', title: 'b', spec: 'b', createdAt: T, status: 'queued', humanGated: false },
        ],
      }),
    /duplicate/
  );
});
