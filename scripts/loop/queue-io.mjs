// queue-io.mjs - filesystem I/O for the queue, kept apart from the pure
// transforms in queue-lib.mjs. Writes are atomic (temp file + rename) so a
// crash mid-write can never leave a half-written, unparseable queue.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createQueue, validateQueue } from './queue-lib.mjs';

export const DEFAULT_QUEUE_PATH = '.loop/queue.json';

export function readQueue(path = DEFAULT_QUEUE_PATH) {
  const abs = resolve(path);
  if (!existsSync(abs)) return createQueue();
  const text = readFileSync(abs, 'utf8');
  const q = JSON.parse(text);
  return validateQueue(q);
}

export function writeQueue(path = DEFAULT_QUEUE_PATH, q) {
  validateQueue(q);
  const abs = resolve(path);
  const tmp = resolve(dirname(abs), `.${basename(abs)}.tmp`);
  writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', 'utf8');
  renameSync(tmp, abs);
  return abs;
}
