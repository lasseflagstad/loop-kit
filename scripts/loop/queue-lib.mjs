// queue-lib.mjs - the job queue with add-only discipline.
//
// The queue lives in .loop/queue.json. Its core invariants, enforced here, make
// the queue an append-only, tamper-evident ledger:
//   1. Never delete a job. There is no remove operation.
//   2. Never rewrite an immutable field (id, title, spec, createdAt) once set.
//   3. Never un-gate a job: humanGated may go false -> true, never true -> false.
//   4. Never rewrite a shipped job. status 'shipped' is terminal and freezes
//      the whole record.
//   5. Status only moves along the allowed transition graph.
//
// All transforms are pure: they take a queue object and return a NEW queue
// object, never mutating the input. File I/O is isolated to read/write helpers.

const QUEUE_VERSION = 1;
const ID_WIDTH = 3;

const VALID_STATUSES = new Set(['queued', 'in_progress', 'shipped', 'blocked']);

// Fields that may never change after a job is created.
const IMMUTABLE_FIELDS = ['id', 'title', 'spec', 'createdAt'];

// Allowed status transitions. 'shipped' is terminal (no outgoing edges).
const TRANSITIONS = {
  queued: ['in_progress', 'blocked'],
  in_progress: ['shipped', 'blocked', 'queued'],
  blocked: ['queued', 'in_progress'],
  shipped: [],
};

class QueueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueError';
  }
}

export { QueueError, QUEUE_VERSION };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createQueue() {
  return { version: QUEUE_VERSION, jobs: [] };
}

// validateQueue throws if the structure is malformed. Used on read so a
// corrupt queue is caught loudly rather than silently mis-driving the loop.
export function validateQueue(q) {
  if (typeof q !== 'object' || q === null || Array.isArray(q)) {
    throw new QueueError('queue must be an object');
  }
  if (q.version !== QUEUE_VERSION) {
    throw new QueueError(`unsupported queue version: ${q.version}`);
  }
  if (!Array.isArray(q.jobs)) {
    throw new QueueError('queue.jobs must be an array');
  }
  const seen = new Set();
  for (const job of q.jobs) {
    if (typeof job !== 'object' || job === null) {
      throw new QueueError('each job must be an object');
    }
    for (const f of ['id', 'title', 'spec', 'createdAt']) {
      if (typeof job[f] !== 'string' || job[f].length === 0) {
        throw new QueueError(`job is missing required string field "${f}"`);
      }
    }
    if (seen.has(job.id)) {
      throw new QueueError(`duplicate job id: ${job.id}`);
    }
    seen.add(job.id);
    if (!VALID_STATUSES.has(job.status)) {
      throw new QueueError(`job ${job.id} has invalid status: ${job.status}`);
    }
    if (typeof job.humanGated !== 'boolean') {
      throw new QueueError(`job ${job.id} has non-boolean humanGated`);
    }
  }
  return q;
}

// Compute the next zero-padded id from the highest numeric id present.
export function nextId(q) {
  let max = 0;
  for (const job of q.jobs) {
    const n = Number.parseInt(job.id, 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1).padStart(ID_WIDTH, '0');
}

// addJob appends a new queued job and returns a NEW queue. The caller supplies
// createdAt (an ISO timestamp) so this stays a pure transform.
export function addJob(q, { title, spec, humanGated = false, createdAt }) {
  validateQueue(q);
  if (typeof title !== 'string' || title.length === 0) {
    throw new QueueError('addJob requires a non-empty title');
  }
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new QueueError('addJob requires a non-empty spec');
  }
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new QueueError('addJob requires a createdAt timestamp');
  }
  if (typeof humanGated !== 'boolean') {
    throw new QueueError('humanGated must be a boolean');
  }
  const job = {
    id: nextId(q),
    title,
    spec,
    status: 'queued',
    humanGated,
    createdAt,
    branch: null,
    pr: null,
    headSha: null,
    shippedAt: null,
    note: null,
  };
  const next = clone(q);
  next.jobs.push(job);
  return next;
}

export function getJob(q, id) {
  return q.jobs.find((j) => j.id === id);
}

// updateJob applies a patch to one job and returns a NEW queue, enforcing every
// add-only guard. It refuses (throws) rather than silently dropping a forbidden
// change, so a guard violation is always visible.
export function updateJob(q, id, patch) {
  validateQueue(q);
  const idx = q.jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    throw new QueueError(`no job with id ${id}`);
  }
  const job = q.jobs[idx];

  // Guard 4: a shipped job is frozen.
  if (job.status === 'shipped') {
    throw new QueueError(`job ${id} is shipped and cannot be modified`);
  }

  // Guard 2: immutable fields may not be rewritten to a different value.
  for (const f of IMMUTABLE_FIELDS) {
    if (f in patch && patch[f] !== job[f]) {
      throw new QueueError(`cannot rewrite immutable field "${f}" on job ${id}`);
    }
  }

  // Guard 3: a human-gated job may not be un-gated.
  if ('humanGated' in patch) {
    if (typeof patch.humanGated !== 'boolean') {
      throw new QueueError('humanGated must be a boolean');
    }
    if (job.humanGated === true && patch.humanGated === false) {
      throw new QueueError(`cannot un-gate job ${id}: humanGated is true`);
    }
  }

  // Guard 5: status changes must follow the transition graph.
  if ('status' in patch && patch.status !== job.status) {
    if (!VALID_STATUSES.has(patch.status)) {
      throw new QueueError(`invalid status: ${patch.status}`);
    }
    const allowed = TRANSITIONS[job.status] || [];
    if (!allowed.includes(patch.status)) {
      throw new QueueError(
        `illegal status transition for job ${id}: ${job.status} -> ${patch.status}`
      );
    }
  }

  const updated = { ...clone(job), ...clone(patch) };
  const next = clone(q);
  next.jobs[idx] = updated;
  return next;
}

// markShipped is a convenience that records the PR, head SHA, and ship time,
// then transitions to 'shipped' in one guarded step.
export function markShipped(q, id, { pr, headSha, shippedAt }) {
  let next = updateJob(q, id, { pr, headSha });
  next = updateJob(next, id, { status: 'shipped', shippedAt });
  return next;
}

// nextQueuedJob returns the oldest queued job (by insertion order). When
// includeHumanGated is false (the default), human-gated jobs are skipped so the
// autonomous runner never picks one up without explicit authorization.
export function nextQueuedJob(q, { includeHumanGated = false } = {}) {
  for (const job of q.jobs) {
    if (job.status !== 'queued') continue;
    if (job.humanGated && !includeHumanGated) continue;
    return job;
  }
  return undefined;
}
