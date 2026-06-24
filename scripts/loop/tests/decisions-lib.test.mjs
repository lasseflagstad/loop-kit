// Tests for the decisions ledger's add-only discipline: ask-once keying, the
// frozen-answer guard, idempotent apply marking, and no destructive export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger,
  validateLedger,
  decisionKey,
  nextDecisionId,
  findDecision,
  findDecisionByKey,
  recordDecision,
  answerDecision,
  markApplied,
  actionableDecisions,
  pendingDecisions,
  DEFAULT_ANSWERS,
  DecisionError,
} from '../decisions-lib.mjs';

const T = '2026-06-24T00:00:00.000Z';
const T2 = '2026-06-24T01:00:00.000Z';

function withDecision(extra = {}) {
  const { ledger } = recordDecision(createLedger(), {
    kind: 'promote',
    job: '002',
    question: 'Approve job 002? answer 001 approve|skip',
    askedAt: T,
    ...extra,
  });
  return ledger;
}

test('createLedger produces an empty versioned ledger', () => {
  const l = createLedger();
  assert.equal(l.version, 1);
  assert.deepEqual(l.decisions, []);
});

test('decisionKey is kind:job and makes a question ask-once', () => {
  assert.equal(decisionKey('promote', '002'), 'promote:002');
  assert.equal(decisionKey('go-ahead', '007'), 'go-ahead:007');
});

test('recordDecision appends a keyed decision with the default answers', () => {
  const l = withDecision();
  assert.equal(l.decisions.length, 1);
  const d = l.decisions[0];
  assert.equal(d.id, '001');
  assert.equal(d.key, 'promote:002');
  assert.equal(d.kind, 'promote');
  assert.equal(d.job, '002');
  assert.deepEqual(d.answers, DEFAULT_ANSWERS);
  assert.equal(d.answer, null);
  assert.equal(d.answeredAt, null);
  assert.equal(d.appliedAt, null);
});

test('recordDecision is keyed: the same question is never recorded twice', () => {
  const l1 = withDecision();
  const { ledger: l2, added, decision } = recordDecision(l1, {
    kind: 'promote',
    job: '002',
    question: 'a different phrasing of the same question',
    askedAt: T2,
  });
  assert.equal(added, false);
  assert.equal(l2, l1); // unchanged object
  assert.equal(l2.decisions.length, 1);
  assert.equal(decision.id, '001'); // the pre-existing entry
});

test('recordDecision does not mutate the input ledger (pure transform)', () => {
  const l0 = createLedger();
  const { ledger: l1 } = recordDecision(l0, {
    kind: 'promote',
    job: '002',
    question: 'q',
    askedAt: T,
  });
  assert.equal(l0.decisions.length, 0);
  assert.equal(l1.decisions.length, 1);
});

test('nextDecisionId increments from the highest numeric id', () => {
  let l = withDecision();
  ({ ledger: l } = recordDecision(l, { kind: 'go-ahead', job: '003', question: 'q', askedAt: T }));
  assert.equal(l.decisions[1].id, '002');
  assert.equal(nextDecisionId(l), '003');
});

test('recordDecision validates its inputs', () => {
  const l = createLedger();
  assert.throws(() => recordDecision(l, { kind: 'nope', job: '1', question: 'q', askedAt: T }), DecisionError);
  assert.throws(() => recordDecision(l, { kind: 'promote', job: '', question: 'q', askedAt: T }), DecisionError);
  assert.throws(() => recordDecision(l, { kind: 'promote', job: '1', question: '', askedAt: T }), DecisionError);
  assert.throws(() => recordDecision(l, { kind: 'promote', job: '1', question: 'q' }), DecisionError);
  assert.throws(
    () => recordDecision(l, { kind: 'promote', job: '1', question: 'q', answers: [], askedAt: T }),
    DecisionError
  );
});

test('answerDecision records a valid answer and stamps answeredAt', () => {
  const l = answerDecision(withDecision(), '001', 'approve', T2);
  const d = findDecision(l, '001');
  assert.equal(d.answer, 'approve');
  assert.equal(d.answeredAt, T2);
});

test('answerDecision rejects an answer outside the allowed set', () => {
  assert.throws(() => answerDecision(withDecision(), '001', 'maybe', T2), DecisionError);
});

test('answerDecision is idempotent for the same answer and refuses a different one', () => {
  const l = answerDecision(withDecision(), '001', 'approve', T2);
  // Same answer again: no-op, returns the same ledger object.
  assert.equal(answerDecision(l, '001', 'approve', T2), l);
  // Different answer: refused (the ledger is tamper-evident).
  assert.throws(() => answerDecision(l, '001', 'skip', T2), DecisionError);
});

test('answerDecision throws for an unknown decision id', () => {
  assert.throws(() => answerDecision(withDecision(), '999', 'approve', T2), DecisionError);
});

test('markApplied stamps appliedAt once and is idempotent thereafter', () => {
  let l = answerDecision(withDecision(), '001', 'approve', T2);
  l = markApplied(l, '001', T2);
  assert.equal(findDecision(l, '001').appliedAt, T2);
  // A second markApplied is a no-op, returning the same ledger object.
  assert.equal(markApplied(l, '001', '2099-01-01T00:00:00.000Z'), l);
});

test('actionableDecisions are answered-but-unapplied; pendingDecisions are unanswered', () => {
  let l = withDecision(); // 001 promote:002, unanswered
  ({ ledger: l } = recordDecision(l, { kind: 'go-ahead', job: '003', question: 'q', askedAt: T })); // 002
  l = answerDecision(l, '001', 'approve', T2);
  assert.deepEqual(actionableDecisions(l).map((d) => d.id), ['001']);
  assert.deepEqual(pendingDecisions(l).map((d) => d.id), ['002']);
  l = markApplied(l, '001', T2);
  assert.deepEqual(actionableDecisions(l), []);
});

test('findDecisionByKey locates by kind:job', () => {
  const l = withDecision();
  assert.equal(findDecisionByKey(l, 'promote:002').id, '001');
  assert.equal(findDecisionByKey(l, 'promote:999'), undefined);
});

test('the ledger is add-only: no delete/remove/drop is exported', async () => {
  const mod = await import('../decisions-lib.mjs');
  for (const name of Object.keys(mod)) {
    assert.ok(!/delete|remove|drop/i.test(name), `unexpected destructive export: ${name}`);
  }
});

test('validateLedger rejects malformed ledgers', () => {
  assert.throws(() => validateLedger({ version: 2, decisions: [] }), DecisionError);
  assert.throws(() => validateLedger({ version: 1, decisions: 'x' }), DecisionError);
  assert.throws(() => validateLedger({ version: 1, decisions: [{ id: '001' }] }), DecisionError);
  // Duplicate id.
  assert.throws(
    () =>
      validateLedger({
        version: 1,
        decisions: [
          { id: '001', key: 'promote:1', kind: 'promote', job: '1', question: 'q', answers: ['approve'], answer: null, askedAt: T, answeredAt: null, appliedAt: null },
          { id: '001', key: 'promote:2', kind: 'promote', job: '2', question: 'q', answers: ['approve'], answer: null, askedAt: T, answeredAt: null, appliedAt: null },
        ],
      }),
    /duplicate decision id/
  );
  // Duplicate key.
  assert.throws(
    () =>
      validateLedger({
        version: 1,
        decisions: [
          { id: '001', key: 'promote:1', kind: 'promote', job: '1', question: 'q', answers: ['approve'], answer: null, askedAt: T, answeredAt: null, appliedAt: null },
          { id: '002', key: 'promote:1', kind: 'promote', job: '1', question: 'q', answers: ['approve'], answer: null, askedAt: T, answeredAt: null, appliedAt: null },
        ],
      }),
    /duplicate decision key/
  );
});
