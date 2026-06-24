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

const VALID_STATUSES = new Set([
  'proposed',
  'queued',
  'in_progress',
  'shipped',
  'blocked',
]);

// Fields that may never change after a job is created.
const IMMUTABLE_FIELDS = ['id', 'title', 'spec', 'createdAt'];

// Allowed status transitions. 'shipped' is terminal (no outgoing edges).
//
// 'proposed' is the scout's entry point: a read-only proposer may only ADD
// proposed jobs, and a human promotes one into the runnable backlog ('queued')
// or parks it ('blocked'). A proposed job is never runnable - the runner only
// picks 'queued' jobs (see nextQueuedJob) - so a proposal can never be built
// without a human first approving it into 'queued'.
const TRANSITIONS = {
  proposed: ['queued', 'blocked'],
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

// renderProposalSpec turns a proposal's parts into the human-readable spec the
// runner would build from if a human approves the proposal into the queue. It
// is a pure string transform so it can be tested directly. (No em-dashes: the
// kit forbids them, and the scout itself proposes fixing any it finds.)
export function renderProposalSpec({ description, requirements, evidence, impactEffort }) {
  const lines = [];
  lines.push(description);
  lines.push('');
  lines.push('## Requirements (diff-checkable)');
  for (const r of requirements) lines.push(`- [ ] ${r}`);
  lines.push('');
  lines.push('## Evidence');
  const where = evidence.line ? `${evidence.file} (line ${evidence.line})` : evidence.file;
  const occ = evidence.occurrences && evidence.occurrences > 1
    ? ` [occurrences: ${evidence.occurrences}]`
    : '';
  lines.push(`${evidence.check} in ${where}${occ}`);
  if (evidence.excerpt) lines.push(`  ${evidence.excerpt}`);
  lines.push('');
  lines.push('## Impact and effort');
  lines.push(impactEffort);
  lines.push('');
  lines.push(
    '(Proposed by the scout. A human approves this into the queue before it is built.)'
  );
  return lines.join('\n');
}

// addProposedJob appends a new PROPOSED job and returns a NEW queue. This is the
// only way the scout writes work: it ADDS proposed jobs, it never edits or
// removes existing ones (it shares addJob's pure-append discipline). A proposed
// job carries, beyond the standard fields, a structured `proposal` payload: the
// plain-English description, a diff-checkable requirements list, the exact
// finding it is based on (evidence), an impact-and-effort note, and a stable
// fingerprint used to avoid re-proposing the same finding on a later scan.
export function addProposedJob(q, {
  title,
  description,
  requirements,
  evidence,
  impactEffort,
  fingerprint,
  humanGated = false,
  createdAt,
}) {
  validateQueue(q);
  if (typeof title !== 'string' || title.length === 0) {
    throw new QueueError('addProposedJob requires a non-empty title');
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new QueueError('addProposedJob requires a non-empty description');
  }
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new QueueError('addProposedJob requires a non-empty requirements list');
  }
  for (const r of requirements) {
    if (typeof r !== 'string' || r.length === 0) {
      throw new QueueError('each requirement must be a non-empty string');
    }
  }
  if (typeof evidence !== 'object' || evidence === null) {
    throw new QueueError('addProposedJob requires an evidence object');
  }
  if (typeof evidence.check !== 'string' || evidence.check.length === 0) {
    throw new QueueError('evidence.check must be a non-empty string');
  }
  if (typeof evidence.file !== 'string' || evidence.file.length === 0) {
    throw new QueueError('evidence.file must be a non-empty string');
  }
  if (typeof impactEffort !== 'string' || impactEffort.length === 0) {
    throw new QueueError('addProposedJob requires a non-empty impactEffort note');
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new QueueError('addProposedJob requires a non-empty fingerprint');
  }
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new QueueError('addProposedJob requires a createdAt timestamp');
  }
  if (typeof humanGated !== 'boolean') {
    throw new QueueError('humanGated must be a boolean');
  }

  const spec = renderProposalSpec({ description, requirements, evidence, impactEffort });
  const job = {
    id: nextId(q),
    title,
    spec,
    status: 'proposed',
    humanGated,
    createdAt,
    branch: null,
    pr: null,
    headSha: null,
    shippedAt: null,
    note: null,
    proposal: {
      check: evidence.check,
      fingerprint,
      description,
      requirements: [...requirements],
      evidence: { ...evidence },
      impactEffort,
    },
  };
  const next = clone(q);
  next.jobs.push(job);
  return next;
}

// fingerprintsInQueue returns the set of proposal fingerprints already present
// in the queue (in any status). The scout uses it to propose a finding at most
// once: a finding whose fingerprint is already recorded is skipped, so re-runs
// never pile up duplicate proposals.
export function fingerprintsInQueue(q) {
  const seen = new Set();
  for (const job of q.jobs) {
    const fp = job.proposal && job.proposal.fingerprint;
    if (typeof fp === 'string' && fp.length > 0) seen.add(fp);
  }
  return seen;
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
