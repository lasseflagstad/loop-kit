// decisions-io.mjs - filesystem I/O for the decisions ledger, kept apart from
// the pure transforms in decisions-lib.mjs. Writes are atomic (temp file +
// rename) so a crash mid-write can never leave a half-written, unparseable
// ledger. This mirrors queue-io.mjs exactly: same shape, same guarantees.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createLedger, validateLedger } from './decisions-lib.mjs';

export const DEFAULT_DECISIONS_PATH = '.loop/decisions.json';

export function readLedger(path = DEFAULT_DECISIONS_PATH) {
  const abs = resolve(path);
  if (!existsSync(abs)) return createLedger();
  const text = readFileSync(abs, 'utf8');
  const l = JSON.parse(text);
  return validateLedger(l);
}

export function writeLedger(path = DEFAULT_DECISIONS_PATH, l) {
  validateLedger(l);
  const abs = resolve(path);
  const tmp = resolve(dirname(abs), `.${basename(abs)}.tmp`);
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n', 'utf8');
  renameSync(tmp, abs);
  return abs;
}
