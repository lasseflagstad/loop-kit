// Tests for the one-way notify hook. It must deliver on each channel and, above
// all, never throw out - a broken channel cannot stop the loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../notify.mjs';

const TS = '2026-06-24T00:00:00.000Z';

test('channel none is a no-op', async () => {
  const r = await notify({ notify: { channel: 'none' } }, 'hi', { timestamp: TS });
  assert.deepEqual(r, { sent: false, channel: 'none' });
});

test('file channel appends a timestamped line', async () => {
  let written;
  const r = await notify(
    { notify: { channel: 'file', target: '/x/notify.log' } },
    'runner stopped',
    { timestamp: TS, appendImpl: async (path, data) => { written = { path, data }; } }
  );
  assert.equal(r.sent, true);
  assert.equal(written.path, '/x/notify.log');
  assert.equal(written.data, `${TS} runner stopped\n`);
});

test('webhook channel POSTs JSON and reports failure without throwing', async () => {
  let posted;
  const ok = await notify(
    { notify: { channel: 'webhook', target: 'https://hook' } },
    'done',
    {
      timestamp: TS,
      fetchImpl: async (url, opts) => {
        posted = { url, opts };
        return { ok: true, status: 200 };
      },
    }
  );
  assert.equal(ok.sent, true);
  assert.equal(posted.url, 'https://hook');
  assert.deepEqual(JSON.parse(posted.opts.body), { text: 'done', timestamp: TS });

  const bad = await notify(
    { notify: { channel: 'webhook', target: 'https://hook' } },
    'done',
    { timestamp: TS, fetchImpl: async () => ({ ok: false, status: 500 }) }
  );
  assert.equal(bad.sent, false);
  assert.match(bad.error, /500/);
});

test('command channel passes the message via env, never interpolated', async () => {
  let seen;
  const r = await notify(
    { notify: { channel: 'command', target: 'mycmd' } },
    'hello; rm -rf /',
    {
      timestamp: TS,
      runImpl: async (template, message, env) => {
        seen = { template, message, env };
      },
      env: { PATH: '/usr/bin' },
    }
  );
  assert.equal(r.sent, true);
  assert.equal(seen.template, 'mycmd');
  // The message is handed over as data, not spliced into the command string.
  assert.equal(seen.message, 'hello; rm -rf /');
});

test('notify never throws: a failing side effect becomes a result, not an exception', async () => {
  const r = await notify(
    { notify: { channel: 'file', target: '/nope' } },
    'x',
    { timestamp: TS, appendImpl: async () => { throw new Error('disk full'); } }
  );
  assert.equal(r.sent, false);
  assert.match(r.error, /disk full/);
});

test('an unknown channel is reported, not thrown', async () => {
  const r = await notify({ notify: { channel: 'carrier-pigeon' } }, 'x', { timestamp: TS });
  assert.equal(r.sent, false);
  assert.match(r.error, /unknown channel/);
});
