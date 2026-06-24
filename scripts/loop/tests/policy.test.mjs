// Tests for the safety policy: human-gates and migration discipline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHumanGated,
  checkMigrationContent,
  checkMigrationNumbering,
} from '../policy.mjs';

const EDGES = ['.github/workflows/**', 'loop.config.json', 'scripts/loop/**', '**/migrations/**'];

test('isHumanGated flags a change to a dangerous edge', () => {
  const r = isHumanGated(['.github/workflows/check.yml'], EDGES);
  assert.equal(r.gated, true);
  assert.equal(r.matches[0].pattern, '.github/workflows/**');
});

test('isHumanGated flags an exact-file edge', () => {
  assert.equal(isHumanGated(['loop.config.json'], EDGES).gated, true);
});

test('isHumanGated flags a nested migrations path via ** on both sides', () => {
  assert.equal(isHumanGated(['db/migrations/0007_add.sql'], EDGES).gated, true);
});

test('isHumanGated does NOT flag an ordinary source change', () => {
  const r = isHumanGated(['src/app.js', 'README.md'], EDGES);
  assert.equal(r.gated, false);
  assert.deepEqual(r.matches, []);
});

test('isHumanGated reports every matching file', () => {
  const r = isHumanGated(['scripts/loop/green-gate.mjs', 'src/x.js', 'loop.config.json'], EDGES);
  assert.equal(r.matches.length, 2);
});

test('isHumanGated with no patterns never gates', () => {
  assert.equal(isHumanGated(['anything'], []).gated, false);
  assert.equal(isHumanGated(['anything'], undefined).gated, false);
});

// --- migration content discipline ---

test('checkMigrationContent passes an additive, idempotent migration', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (id serial primary key);
    CREATE INDEX IF NOT EXISTS users_id_idx ON users (id);
    ALTER TABLE users ADD COLUMN email text;
  `;
  assert.equal(checkMigrationContent(sql).ok, true);
});

test('checkMigrationContent rejects DROP', () => {
  const r = checkMigrationContent('DROP TABLE users;');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'destructive');
});

test('checkMigrationContent rejects TRUNCATE, DELETE, ALTER...DROP, RENAME', () => {
  for (const sql of [
    'TRUNCATE users;',
    'DELETE FROM users;',
    'ALTER TABLE users DROP COLUMN email;',
    'ALTER TABLE users RENAME TO people;',
  ]) {
    const r = checkMigrationContent(sql);
    assert.equal(r.ok, false, `${sql} should be rejected`);
    assert.equal(r.violations[0].type, 'destructive');
  }
});

test('checkMigrationContent rejects a non-idempotent CREATE', () => {
  const r = checkMigrationContent('CREATE TABLE users (id serial);');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'not-idempotent');
});

test('checkMigrationContent accepts CREATE OR REPLACE VIEW as idempotent', () => {
  assert.equal(checkMigrationContent('CREATE OR REPLACE VIEW v AS SELECT 1;').ok, true);
});

test('checkMigrationContent ignores destructive words hidden in comments', () => {
  const sql = `
    -- this used to DROP TABLE users but no longer does
    /* DROP TABLE archived; */
    CREATE TABLE IF NOT EXISTS keep (id serial);
  `;
  assert.equal(checkMigrationContent(sql).ok, true);
});

test('checkMigrationContent is case-insensitive', () => {
  assert.equal(checkMigrationContent('drop table users;').ok, false);
});

// --- central migration numbering ---

test('checkMigrationNumbering accepts a contiguous zero-padded sequence', () => {
  const r = checkMigrationNumbering(
    ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
    { numberWidth: 4 }
  );
  assert.equal(r.ok, true);
});

test('checkMigrationNumbering detects a gap', () => {
  const r = checkMigrationNumbering(['0001_a.sql', '0003_c.sql'], { numberWidth: 4 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /gap/);
});

test('checkMigrationNumbering detects a duplicate number', () => {
  const r = checkMigrationNumbering(['0001_a.sql', '0001_b.sql'], { numberWidth: 4 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unique/);
});

test('checkMigrationNumbering enforces the configured zero-padded width', () => {
  const r = checkMigrationNumbering(['1_a.sql', '2_b.sql'], { numberWidth: 4 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /digit/);
});

test('checkMigrationNumbering flags a file with no leading number', () => {
  const r = checkMigrationNumbering(['init.sql'], { numberWidth: 4 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /no leading migration number/);
});

test('checkMigrationNumbering handles full paths (uses the basename)', () => {
  const r = checkMigrationNumbering(
    ['db/migrations/0001_a.sql', 'db/migrations/0002_b.sql'],
    { numberWidth: 4 }
  );
  assert.equal(r.ok, true);
});
