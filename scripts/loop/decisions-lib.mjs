// decisions-lib.mjs - the two-way decisions ledger with add-only discipline.
//
// The loop is fire-and-forget: a scheduled cloud run cannot pause and wait for
// you to text back. So the only two genuinely-additive decisions left (approve a
// proposed job, or give a go-ahead on a human-gated one) are handled ASYNC. The
// runner records a question here, notifies you, and a LATER run reads your
// answer and acts on it.
//
// The ledger lives in .loop/decisions.json. It mirrors the queue's discipline:
//   1. Never delete a decision. There is no remove operation.
//   2. Never ask the same question twice. Each entry carries a stable `key`
//      (kind + job); recording a duplicate key is a no-op, so you are pinged
//      exactly once per question.
//   3. Never rewrite an immutable field (id, key, kind, job, question, answers,
//      askedAt) once set.
//   4. Never rewrite an answer. `answer` may go null -> one of the allowed
//      answers, and after that it is frozen (re-answering the same value is a
//      no-op; a different value is refused). This keeps the ledger tamper-evident.
//
// Every transform is pure: it takes a ledger and returns a NEW ledger, never
// mutating the input. File I/O is isolated to decisions-io.mjs.

const DECISIONS_VERSION = 1;
const ID_WIDTH = 3;

// The two decision kinds this ledger handles. Both are NON-merge decisions:
//   promote   a proposed (parked / blocked) job you may approve into the queue
//   go-ahead  a human-gated job you may authorize to BUILD (never to merge:
//             the merge-time human gate is untouched, see decisions.mjs)
const VALID_KINDS = new Set(['promote', 'go-ahead']);

// The default allowed answers. A decision always offers exactly these unless a
// caller overrides them with another non-empty set.
export const DEFAULT_ANSWERS = ['approve', 'skip'];

// Fields fixed at the moment a decision is recorded are never rewritten: the
// only mutations exposed are answerDecision (sets answer + answeredAt once) and
// markApplied (sets appliedAt once). There is no generic patch path, so id, key,
// kind, job, question, answers, and askedAt are immutable by construction.

class DecisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionError';
  }
}

export { DecisionError, DECISIONS_VERSION, VALID_KINDS };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createLedger() {
  return { version: DECISIONS_VERSION, decisions: [] };
}

// The stable key that makes a question ask-once. The same kind for the same job
// is the same question, forever.
export function decisionKey(kind, job) {
  return `${kind}:${job}`;
}

// validateLedger throws if the structure is malformed. Used on read so a corrupt
// ledger is caught loudly rather than silently mis-driving the loop.
export function validateLedger(l) {
  if (typeof l !== 'object' || l === null || Array.isArray(l)) {
    throw new DecisionError('decisions ledger must be an object');
  }
  if (l.version !== DECISIONS_VERSION) {
    throw new DecisionError(`unsupported decisions version: ${l.version}`);
  }
  if (!Array.isArray(l.decisions)) {
    throw new DecisionError('decisions ledger .decisions must be an array');
  }
  const seenIds = new Set();
  const seenKeys = new Set();
  for (const d of l.decisions) {
    if (typeof d !== 'object' || d === null) {
      throw new DecisionError('each decision must be an object');
    }
    for (const f of ['id', 'key', 'kind', 'job', 'question', 'askedAt']) {
      if (typeof d[f] !== 'string' || d[f].length === 0) {
        throw new DecisionError(`decision is missing required string field "${f}"`);
      }
    }
    if (!VALID_KINDS.has(d.kind)) {
      throw new DecisionError(`decision ${d.id} has invalid kind: ${d.kind}`);
    }
    if (seenIds.has(d.id)) {
      throw new DecisionError(`duplicate decision id: ${d.id}`);
    }
    seenIds.add(d.id);
    if (seenKeys.has(d.key)) {
      throw new DecisionError(`duplicate decision key: ${d.key}`);
    }
    seenKeys.add(d.key);
    if (!Array.isArray(d.answers) || d.answers.length === 0) {
      throw new DecisionError(`decision ${d.id} must offer a non-empty answers array`);
    }
    if (d.answer !== null && !d.answers.includes(d.answer)) {
      throw new DecisionError(`decision ${d.id} has an answer outside its allowed set`);
    }
  }
  return l;
}

// Compute the next zero-padded id from the highest numeric id present.
export function nextDecisionId(l) {
  let max = 0;
  for (const d of l.decisions) {
    const n = Number.parseInt(d.id, 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1).padStart(ID_WIDTH, '0');
}

export function findDecision(l, id) {
  return l.decisions.find((d) => d.id === id);
}

export function findDecisionByKey(l, key) {
  return l.decisions.find((d) => d.key === key);
}

// recordDecision appends one decision, keyed so the same question is never asked
// twice. It returns { ledger, decision, added }:
//   added true   a NEW decision was appended (ledger is a new object).
//   added false  the key already existed; ledger is returned unchanged and
//                decision is the pre-existing entry.
// The caller supplies askedAt (an ISO timestamp) so this stays a pure transform.
// The question is supplied fully formed (plain English plus how to answer) so
// the wording lives with the surface that knows how the channel reads replies.
export function recordDecision(
  l,
  { kind, job, question, answers = DEFAULT_ANSWERS, askedAt }
) {
  validateLedger(l);
  if (!VALID_KINDS.has(kind)) {
    throw new DecisionError(`recordDecision requires a valid kind; got ${kind}`);
  }
  if (typeof job !== 'string' || job.length === 0) {
    throw new DecisionError('recordDecision requires a non-empty job id');
  }
  if (typeof question !== 'string' || question.length === 0) {
    throw new DecisionError('recordDecision requires a non-empty question');
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new DecisionError('recordDecision requires a non-empty answers array');
  }
  for (const a of answers) {
    if (typeof a !== 'string' || a.length === 0) {
      throw new DecisionError('each allowed answer must be a non-empty string');
    }
  }
  if (typeof askedAt !== 'string' || askedAt.length === 0) {
    throw new DecisionError('recordDecision requires an askedAt timestamp');
  }

  const key = decisionKey(kind, job);
  const existing = findDecisionByKey(l, key);
  if (existing) {
    // Ask-once: the same question is never recorded (or notified) a second time.
    return { ledger: l, decision: existing, added: false };
  }

  const decision = {
    id: nextDecisionId(l),
    key,
    kind,
    job,
    question,
    answers: [...answers],
    answer: null,
    askedAt,
    answeredAt: null,
    appliedAt: null,
  };
  const next = clone(l);
  next.decisions.push(decision);
  return { ledger: next, decision, added: true };
}

// answerDecision records your reply, returning a NEW ledger. It enforces:
//   - the decision exists,
//   - the answer is one of the decision's allowed answers,
//   - an already-answered decision is frozen: the same answer is a no-op, a
//     different answer is refused (tamper-evident).
// answeredAt is supplied by the caller so this stays a pure transform.
export function answerDecision(l, id, answer, answeredAt) {
  validateLedger(l);
  const idx = l.decisions.findIndex((d) => d.id === id);
  if (idx === -1) {
    throw new DecisionError(`no decision with id ${id}`);
  }
  const d = l.decisions[idx];
  if (!d.answers.includes(answer)) {
    throw new DecisionError(
      `"${answer}" is not an allowed answer for decision ${id} (allowed: ${d.answers.join(', ')})`
    );
  }
  if (d.answer !== null) {
    if (d.answer === answer) {
      // Idempotent: re-recording the same answer changes nothing.
      return l;
    }
    throw new DecisionError(
      `decision ${id} is already answered "${d.answer}" and cannot be changed to "${answer}"`
    );
  }
  if (typeof answeredAt !== 'string' || answeredAt.length === 0) {
    throw new DecisionError('answerDecision requires an answeredAt timestamp');
  }
  const updated = { ...clone(d), answer, answeredAt };
  const next = clone(l);
  next.decisions[idx] = updated;
  return next;
}

// markApplied stamps a decision as acted-upon, returning a NEW ledger. It is the
// idempotency marker for act-on-answer: a decision is acted on at most once.
// Re-marking an already-applied decision is a no-op.
export function markApplied(l, id, appliedAt) {
  validateLedger(l);
  const idx = l.decisions.findIndex((d) => d.id === id);
  if (idx === -1) {
    throw new DecisionError(`no decision with id ${id}`);
  }
  const d = l.decisions[idx];
  if (d.appliedAt !== null) {
    return l; // already applied; idempotent.
  }
  if (typeof appliedAt !== 'string' || appliedAt.length === 0) {
    throw new DecisionError('markApplied requires an appliedAt timestamp');
  }
  const updated = { ...clone(d), appliedAt };
  const next = clone(l);
  next.decisions[idx] = updated;
  return next;
}

// actionableDecisions returns the decisions that are answered but not yet acted
// upon. These are exactly what the next run must apply before picking a job.
export function actionableDecisions(l) {
  return l.decisions.filter((d) => d.answer !== null && d.appliedAt === null);
}

// pendingDecisions returns the decisions still awaiting your reply.
export function pendingDecisions(l) {
  return l.decisions.filter((d) => d.answer === null);
}
