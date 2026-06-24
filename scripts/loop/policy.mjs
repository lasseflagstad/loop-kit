// policy.mjs - the safety policy: human-gates and migration discipline.
//
// Two independent concerns, both pure and both driven by configuration:
//   1. Human-gates: a job that touches any configured dangerous-edge pattern
//      must be approved by a human before it ships.
//   2. Migration discipline: migrations must be additive-and-idempotent-only,
//      and numbered by a single central sequence (no gaps, no duplicates).

import { matchAny } from './glob.mjs';

// ---------------------------------------------------------------------------
// Human-gates
// ---------------------------------------------------------------------------

// isHumanGated(changedFiles, dangerousEdges) -> { gated, matches }
// changedFiles: array of repo-relative paths a job would modify.
// dangerousEdges: array of glob patterns from loop.config.json.
// A job is human-gated if ANY changed file matches ANY dangerous-edge pattern.
export function isHumanGated(changedFiles, dangerousEdges) {
  if (!Array.isArray(changedFiles)) {
    throw new Error('changedFiles must be an array');
  }
  const patterns = dangerousEdges ?? [];
  const matches = [];
  for (const file of changedFiles) {
    const pattern = matchAny(file, patterns);
    if (pattern) matches.push({ file, pattern });
  }
  return { gated: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// Migration discipline
// ---------------------------------------------------------------------------

// Strip SQL comments so they cannot hide or fake-trigger pattern matches.
function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' '); // line comments
}

// Split into individual statements on ';'. Good enough for discipline scanning;
// we are matching leading verbs, not fully parsing SQL.
function splitStatements(sql) {
  return stripSqlComments(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

// Destructive operations break "additive-only". Each entry: a matcher and the
// rule name reported on violation.
const DESTRUCTIVE = [
  { re: /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE|VIEW|SEQUENCE|TYPE|CONSTRAINT|TRIGGER|FUNCTION|MATERIALIZED\s+VIEW)\b/i, rule: 'no DROP' },
  { re: /\bTRUNCATE\b/i, rule: 'no TRUNCATE' },
  { re: /\bDELETE\s+FROM\b/i, rule: 'no DELETE' },
  { re: /\bALTER\s+TABLE\s+\S+\s+DROP\b/i, rule: 'no ALTER ... DROP' },
  { re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i, rule: 'no RENAME (not additive)' },
];

// CREATE statements that must be idempotent. A create is idempotent if it
// includes IF NOT EXISTS, or (for replaceable objects) OR REPLACE.
const GUARDED_CREATE = /^CREATE\s+(?:UNIQUE\s+)?(?:OR\s+REPLACE\s+)?(TABLE|INDEX|SCHEMA|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b/i;

function isIdempotentCreate(statement) {
  return /\bIF\s+NOT\s+EXISTS\b/i.test(statement) || /\bOR\s+REPLACE\b/i.test(statement);
}

// checkMigrationContent(sql) -> { ok, violations }
// Each violation: { type: 'destructive' | 'not-idempotent', rule, statement }.
export function checkMigrationContent(sql) {
  const violations = [];
  for (const statement of splitStatements(sql)) {
    for (const { re, rule } of DESTRUCTIVE) {
      if (re.test(statement)) {
        violations.push({ type: 'destructive', rule, statement });
      }
    }
    if (GUARDED_CREATE.test(statement) && !isIdempotentCreate(statement)) {
      violations.push({
        type: 'not-idempotent',
        rule: 'CREATE must use IF NOT EXISTS (or OR REPLACE)',
        statement,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Central migration numbering
// ---------------------------------------------------------------------------

// checkMigrationNumbering(filenames, { numberWidth }) -> { ok, errors }
// Enforces a single central sequence: every file carries a zero-padded numeric
// prefix of exactly numberWidth digits, all numbers are unique, and they form a
// contiguous run with no gaps.
export function checkMigrationNumbering(filenames, { numberWidth = 4 } = {}) {
  const errors = [];
  const numbers = [];

  for (const name of filenames) {
    const base = String(name).split('/').pop();
    const m = base.match(/^(\d+)/);
    if (!m) {
      errors.push(`"${base}" has no leading migration number`);
      continue;
    }
    const digits = m[1];
    if (digits.length !== numberWidth) {
      errors.push(
        `"${base}" has a ${digits.length}-digit number; expected ${numberWidth}-digit zero-padded`
      );
    }
    numbers.push({ base, n: Number.parseInt(digits, 10) });
  }

  // Duplicates.
  const counts = new Map();
  for (const { n } of numbers) counts.set(n, (counts.get(n) || 0) + 1);
  for (const [n, c] of counts) {
    if (c > 1) errors.push(`migration number ${n} is used ${c} times (must be unique)`);
  }

  // Gaps: the unique numbers must be contiguous.
  const unique = [...counts.keys()].sort((a, b) => a - b);
  if (unique.length > 1) {
    const min = unique[0];
    const max = unique[unique.length - 1];
    if (max - min + 1 !== unique.length) {
      const present = new Set(unique);
      const missing = [];
      for (let i = min; i <= max; i++) if (!present.has(i)) missing.push(i);
      errors.push(`gap in migration numbering; missing: ${missing.join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
