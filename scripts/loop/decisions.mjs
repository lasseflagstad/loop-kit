// decisions.mjs - the async two-way decision surface: ask, act, and the proof
// that an answer can never bypass a gate.
//
// This module ties the pure ledger (decisions-lib.mjs) to the rest of the kit:
// it phrases the question, notifies you through the kit's one-way notify, reads
// your reply on the next run, and ACTS on it against the job queue. It is the
// only place that maps a yes/no answer onto a queue change, and it is written so
// that mapping can NEVER:
//
//   - un-gate a human-gated job (it never sets humanGated),
//   - ship or merge anything (it never calls confirm-green, markShipped, or any
//     merge path; it only moves a job between `blocked` and `queued` and writes
//     a note),
//   - push a human-gated job into the autonomous build path (a gated job stays
//     gated, and the runner's `next` skips gated jobs).
//
// So an `approve` on a human-gated job records a GO-AHEAD TO BUILD only. The
// dangerous-edge gate at merge time is untouched: you still merge it yourself.

import { notify } from './notify.mjs';
import { getJob, updateJob } from './queue-lib.mjs';
import {
  DEFAULT_ANSWERS,
  decisionKey,
  findDecisionByKey,
  nextDecisionId,
  recordDecision,
  answerDecision,
  markApplied,
  actionableDecisions,
} from './decisions-lib.mjs';

// ---------------------------------------------------------------------------
// Phrasing: the plain-English question plus exactly how to answer.
// ---------------------------------------------------------------------------

// decisionQuestion builds the message you receive. It states the decision in
// plain English and gives the exact command to answer it. The answer command
// keys on the DECISION id (not the job id), so it is woven in here once the id
// is known.
export function decisionQuestion({ id, kind, job, jobTitle, answers = DEFAULT_ANSWERS }) {
  const title = jobTitle ? ` "${jobTitle}"` : '';
  const ask =
    kind === 'promote'
      ? `Proposed job ${job}${title} is parked and ready. Approve it into the run queue, or skip it?`
      : `Human-gated job ${job}${title} is awaiting your go-ahead to build. Approve the build, or skip it? ` +
        `Approving authorizes the BUILD only; the change still needs your merge at the gate.`;
  const how =
    `How to answer: run \`node scripts/loop/decisions-cli.mjs answer ${id} <${answers.join('|')}>\` ` +
    `(for example \`answer ${id} ${answers[0]}\`), or reply "${id} ${answers[0]}" in the answers inbox if one is configured.`;
  return `${ask} ${how}`;
}

// ---------------------------------------------------------------------------
// Candidate scan: which jobs warrant a non-merge decision right now.
// ---------------------------------------------------------------------------

// candidateDecisions inspects the queue and returns the questions worth asking:
//   - a human-gated job that is queued or parked  -> a `go-ahead` decision,
//   - a non-gated job that is parked (`blocked`)   -> a `promote` decision.
// A "proposed" job in this kit is a parked (`blocked`) job: it exists in the
// ledger but is not yet in the run queue. Shipped jobs are never candidates.
export function candidateDecisions(queue) {
  const out = [];
  for (const job of queue.jobs) {
    if (job.status === 'shipped') continue;
    if (job.humanGated) {
      if (job.status === 'queued' || job.status === 'blocked') {
        out.push({ kind: 'go-ahead', job: job.id, jobTitle: job.title });
      }
    } else if (job.status === 'blocked') {
      out.push({ kind: 'promote', job: job.id, jobTitle: job.title });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Act on one answer. PURE: takes a queue + a decision, returns a NEW queue and a
// description of what happened. This is the requirement-5 safety boundary.
// ---------------------------------------------------------------------------

export function actOnAnswer(queue, decision) {
  const base = { decision: decision.id, job: decision.job, kind: decision.kind, answer: decision.answer };
  const job = getJob(queue, decision.job);
  if (!job) {
    return { queue, action: { ...base, result: 'job-not-found' } };
  }
  // A shipped job is frozen; there is nothing left to decide.
  if (job.status === 'shipped') {
    return { queue, action: { ...base, result: 'job-already-shipped' } };
  }

  // skip: park the job out of the run queue. Never deleted, just set aside.
  if (decision.answer === 'skip') {
    const note = `skipped via decision ${decision.id}`;
    if (job.status === 'blocked') {
      const next = job.note === note ? queue : updateJob(queue, job.id, { note });
      return { queue: next, action: { ...base, result: 'skipped' } };
    }
    const next = updateJob(queue, job.id, { status: 'blocked', note });
    return { queue: next, action: { ...base, result: 'skipped' } };
  }

  if (decision.answer === 'approve') {
    if (decision.kind === 'promote') {
      // Promote a parked, NON-gated job into the run queue so the runner picks
      // it up. We never touch humanGated, so this cannot un-gate anything.
      const note = `promoted via decision ${decision.id}`;
      if (job.status === 'blocked') {
        const next = updateJob(queue, job.id, { status: 'queued', note });
        return { queue: next, action: { ...base, result: 'promoted' } };
      }
      // Already in the run queue (or in progress): idempotent no-op beyond the note.
      const next = job.note === note ? queue : updateJob(queue, job.id, { note });
      return { queue: next, action: { ...base, result: 'already-promoted' } };
    }

    if (decision.kind === 'go-ahead') {
      // Record the go-ahead for a human-gated job. This authorizes the BUILD,
      // not the merge. We DO NOT un-gate, DO NOT change status, DO NOT touch any
      // merge path. The job stays humanGated, so the autonomous runner still
      // skips it and the merge-time human gate is fully intact.
      const note =
        `go-ahead recorded via decision ${decision.id}: build is authorized but stays ` +
        `human-supervised, and the merge gate is unchanged`;
      const next = job.note === note ? queue : updateJob(queue, job.id, { note });
      return {
        queue: next,
        action: { ...base, result: 'go-ahead-recorded', humanGated: job.humanGated },
      };
    }
  }

  // Defensive: an answer outside the handled set changes nothing.
  return { queue, action: { ...base, result: 'no-op' } };
}

// applyAnswers acts on every answered-but-unapplied decision, returning new
// ledger + queue and the list of actions taken. It is idempotent across runs:
// each decision is marked applied, so a later run skips it. `now` is the ISO
// timestamp recorded as appliedAt.
export function applyAnswers(ledger, queue, now) {
  let l = ledger;
  let q = queue;
  const actions = [];
  for (const d of actionableDecisions(ledger)) {
    const { queue: nextQueue, action } = actOnAnswer(q, d);
    q = nextQueue;
    l = markApplied(l, d.id, now);
    actions.push(action);
  }
  return { ledger: l, queue: q, actions };
}

// ---------------------------------------------------------------------------
// Inbox ingest: read one-line replies from the configured answers file. This is
// the "kit reads your reply from the channel on its next run" path for the file
// provider. Each line is `<decision-id> <answer>`; blank lines and `#` comments
// are ignored. Ingest is idempotent: a same-answer line is a no-op, and a line
// for an unknown or already-differently-answered decision is skipped, not fatal.
// ---------------------------------------------------------------------------

export function ingestInbox(ledger, text, answeredAt) {
  const applied = [];
  const skipped = [];
  let l = ledger;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [id, answer] = line.split(/\s+/);
    if (!id || !answer) {
      skipped.push({ line, reason: 'expected "<decision-id> <answer>"' });
      continue;
    }
    try {
      const before = l;
      l = answerDecision(l, id, answer, answeredAt);
      applied.push({ id, answer, changed: l !== before });
    } catch (err) {
      skipped.push({ line, reason: err.message });
    }
  }
  return { ledger: l, applied, skipped };
}

// ---------------------------------------------------------------------------
// Record + notify: the ask-on-stop step. Keyed, so the same question is asked
// (and you are pinged) exactly once. notify is injectable for tests.
// ---------------------------------------------------------------------------

export async function recordAndNotify({
  ledger,
  config,
  kind,
  job,
  jobTitle,
  askedAt,
  answers = DEFAULT_ANSWERS,
  notifyImpl = notify,
}) {
  const existing = findDecisionByKey(ledger, decisionKey(kind, job));
  if (existing) {
    // Already asked: do not record again and do not ping again.
    return { ledger, decision: existing, added: false, notified: false, message: null };
  }
  // The answer command keys on the id this decision will receive; compute it so
  // the question can name it. recordDecision assigns the same id from the same
  // ledger, so the two agree.
  const id = nextDecisionId(ledger);
  const message = decisionQuestion({ id, kind, job, jobTitle, answers });
  const { ledger: nextLedger, decision, added } = recordDecision(ledger, {
    kind,
    job,
    question: message,
    answers,
    askedAt,
  });
  let notified = false;
  if (added) {
    const result = await notifyImpl(config, message);
    notified = !!(result && result.sent);
  }
  return { ledger: nextLedger, decision, added, notified, message };
}
