// Tests for loop.config.json validation and defaulting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig, ConfigError } from '../config.mjs';

const MINIMAL = { requiredChecks: ['check'], mergeMode: 'tee-up' };

test('validateConfig accepts a minimal config and applies defaults', () => {
  const c = validateConfig(MINIMAL);
  assert.deepEqual(c.requiredChecks, ['check']);
  assert.equal(c.branchPrefix, 'claude/');
  assert.deepEqual(c.dangerousEdges, []);
  assert.deepEqual(c.notify, { channel: 'none' });
  assert.equal(c.mergeMode, 'tee-up');
  assert.equal('migrations' in c, false);
});

test('requiredChecks must be a non-empty array of unique non-empty strings', () => {
  assert.throws(() => validateConfig({ ...MINIMAL, requiredChecks: [] }), ConfigError);
  assert.throws(() => validateConfig({ ...MINIMAL, requiredChecks: 'check' }), ConfigError);
  assert.throws(() => validateConfig({ ...MINIMAL, requiredChecks: [''] }), ConfigError);
  assert.throws(
    () => validateConfig({ ...MINIMAL, requiredChecks: ['a', 'a'] }),
    /duplicate/
  );
});

test('mergeMode must be one of the two supported modes', () => {
  assert.throws(() => validateConfig({ requiredChecks: ['c'], mergeMode: 'rebase' }), ConfigError);
  assert.throws(() => validateConfig({ requiredChecks: ['c'] }), ConfigError);
  assert.equal(
    validateConfig({ requiredChecks: ['c'], mergeMode: 'auto-merge-on-green' }).mergeMode,
    'auto-merge-on-green'
  );
});

test('dangerousEdges must be an array of non-empty strings', () => {
  assert.throws(() => validateConfig({ ...MINIMAL, dangerousEdges: 'x' }), ConfigError);
  assert.throws(() => validateConfig({ ...MINIMAL, dangerousEdges: [''] }), ConfigError);
  assert.deepEqual(
    validateConfig({ ...MINIMAL, dangerousEdges: ['a/**'] }).dangerousEdges,
    ['a/**']
  );
});

test('notify.channel is validated and target is required for non-none channels', () => {
  assert.throws(() => validateConfig({ ...MINIMAL, notify: { channel: 'slack' } }), ConfigError);
  assert.throws(() => validateConfig({ ...MINIMAL, notify: { channel: 'file' } }), /target/);
  const c = validateConfig({ ...MINIMAL, notify: { channel: 'file', target: '.loop/notify.log' } });
  assert.deepEqual(c.notify, { channel: 'file', target: '.loop/notify.log' });
});

test('decisions is optional and, when present, validates an optional inbox path', () => {
  // Absent by default.
  assert.equal('decisions' in validateConfig(MINIMAL), false);
  // An empty decisions block is allowed (no inbox configured).
  assert.deepEqual(validateConfig({ ...MINIMAL, decisions: {} }).decisions, {});
  // A configured inbox is carried through.
  assert.deepEqual(
    validateConfig({ ...MINIMAL, decisions: { inbox: '.loop/answers.inbox' } }).decisions,
    { inbox: '.loop/answers.inbox' }
  );
  // A non-object decisions block, or an empty inbox string, is rejected.
  assert.throws(() => validateConfig({ ...MINIMAL, decisions: 'x' }), ConfigError);
  assert.throws(() => validateConfig({ ...MINIMAL, decisions: { inbox: '' } }), ConfigError);
});

test('migrations defaults numberWidth to 4 and requires dir', () => {
  const c = validateConfig({ ...MINIMAL, migrations: { dir: 'db/migrations' } });
  assert.deepEqual(c.migrations, { dir: 'db/migrations', numberWidth: 4 });
  assert.throws(() => validateConfig({ ...MINIMAL, migrations: {} }), ConfigError);
  assert.throws(
    () => validateConfig({ ...MINIMAL, migrations: { dir: 'd', numberWidth: 0 } }),
    ConfigError
  );
});

test('validateConfig rejects non-objects', () => {
  assert.throws(() => validateConfig(null), ConfigError);
  assert.throws(() => validateConfig([]), ConfigError);
});

test('loadConfig reads and validates a file, ignoring $schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loopcfg-'));
  const path = join(dir, 'loop.config.json');
  writeFileSync(
    path,
    JSON.stringify({ $schema: './x.json', requiredChecks: ['check'], mergeMode: 'tee-up' })
  );
  const c = loadConfig(path);
  assert.equal(c.mergeMode, 'tee-up');
});

test('loadConfig throws a ConfigError for missing or invalid JSON files', () => {
  assert.throws(() => loadConfig('/nonexistent/loop.config.json'), ConfigError);
  const dir = mkdtempSync(join(tmpdir(), 'loopcfg-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => loadConfig(path), /not valid JSON/);
});

test('the repo loop.config.json loads and is valid', () => {
  // Guard against this repo's own config drifting out of spec. Stated as a
  // generic invariant so the suite stays correct when the installer copies it
  // into a target repo whose config differs: the config must load, list at
  // least one required check, and pick a supported merge mode.
  const c = loadConfig(new URL('../../../loop.config.json', import.meta.url).pathname);
  assert.ok(Array.isArray(c.requiredChecks) && c.requiredChecks.length > 0);
  assert.ok(['auto-merge-on-green', 'tee-up'].includes(c.mergeMode));
});
