// Tests for decisions-ledger persistence. Round-trips through a real temp file
// so the atomic write + validation path is exercised end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, writeLedger } from '../decisions-io.mjs';
import { createLedger, recordDecision } from '../decisions-lib.mjs';

const T = '2026-06-24T00:00:00.000Z';

function tmpLedger() {
  return join(mkdtempSync(join(tmpdir(), 'loopd-')), 'decisions.json');
}

test('readLedger returns an empty ledger when the file does not exist', () => {
  const l = readLedger(join(mkdtempSync(join(tmpdir(), 'loopd-')), 'absent.json'));
  assert.deepEqual(l.decisions, []);
});

test('writeLedger then readLedger round-trips a decision', () => {
  const path = tmpLedger();
  const { ledger } = recordDecision(createLedger(), {
    kind: 'promote',
    job: '002',
    question: 'Approve job 002?',
    askedAt: T,
  });
  writeLedger(path, ledger);
  assert.ok(existsSync(path));
  const back = readLedger(path);
  assert.equal(back.decisions[0].job, '002');
  assert.equal(back.decisions[0].kind, 'promote');
});

test('writeLedger rejects a malformed ledger (validation on write)', () => {
  assert.throws(() => writeLedger(tmpLedger(), { version: 1, decisions: 'x' }));
});
