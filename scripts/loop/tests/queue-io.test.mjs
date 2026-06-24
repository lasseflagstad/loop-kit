// Tests for queue persistence and the operator CLI. Round-trips through a real
// temp file so the atomic write + validation path is exercised end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueue, writeQueue } from '../queue-io.mjs';
import { addJob, createQueue } from '../queue-lib.mjs';
import { main as queueCli } from '../queue-cli.mjs';

const T = '2026-06-24T00:00:00.000Z';

function tmpQueue() {
  return join(mkdtempSync(join(tmpdir(), 'loopq-')), 'queue.json');
}

test('readQueue returns an empty queue when the file does not exist', () => {
  const q = readQueue(join(mkdtempSync(join(tmpdir(), 'loopq-')), 'absent.json'));
  assert.deepEqual(q.jobs, []);
});

test('writeQueue then readQueue round-trips a job', () => {
  const path = tmpQueue();
  const q = addJob(createQueue(), { title: 'A', spec: 'a', createdAt: T });
  writeQueue(path, q);
  assert.ok(existsSync(path));
  const back = readQueue(path);
  assert.equal(back.jobs[0].title, 'A');
});

test('writeQueue rejects a malformed queue (validation on write)', () => {
  assert.throws(() => writeQueue(tmpQueue(), { version: 1, jobs: 'x' }));
});

test('CLI add appends and CLI list shows it', () => {
  const path = tmpQueue();
  let out = '';
  const write = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try {
    const addCode = queueCli(['add', '--title', 'Health endpoint', '--spec', 'GET /healthz', '--queue', path], {}, Date.parse(T));
    assert.equal(addCode, 0);
    const listCode = queueCli(['list', '--queue', path], {}, Date.parse(T));
    assert.equal(listCode, 0);
  } finally {
    process.stdout.write = write;
  }
  assert.match(out, /added 001/);
  assert.match(out, /Health endpoint/);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.jobs[0].title, 'Health endpoint');
});

test('CLI next skips human-gated jobs unless --include-gated', () => {
  const path = tmpQueue();
  queueCli(['add', '--title', 'Gated', '--spec', 's', '--human-gated', '--queue', path], {}, Date.parse(T));
  queueCli(['add', '--title', 'Normal', '--spec', 's', '--queue', path], {}, Date.parse(T));
  let out = '';
  const write = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try {
    queueCli(['next', '--queue', path], {}, Date.parse(T));
  } finally {
    process.stdout.write = write;
  }
  assert.match(out, /002\s+Normal/);
  assert.doesNotMatch(out, /Gated/);
});
