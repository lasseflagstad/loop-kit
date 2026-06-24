// config.mjs - load and validate the single per-repo configuration file.
//
// The Loop Kit is parameterized entirely by loop.config.json. This module is
// the only place that knows the config's shape. Validation is a pure function
// (validateConfig) so it can be tested without touching the filesystem;
// loadConfig wraps it with a file read.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = 'loop.config.json';

const VALID_NOTIFY_CHANNELS = new Set(['none', 'file', 'webhook', 'command']);
const VALID_MERGE_MODES = new Set(['auto-merge-on-green', 'tee-up']);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export { ConfigError };

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

// validateConfig takes the parsed JSON and returns a normalized, fully
// defaulted config object. It throws ConfigError on any problem rather than
// silently coercing, because a misread gate is a safety failure.
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('config must be a JSON object');
  }

  // requiredChecks: the gate. Must be a non-empty array of unique non-empty
  // strings. An empty gate would let everything through, so it is rejected.
  const { requiredChecks } = raw;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new ConfigError('requiredChecks must be a non-empty array of check names');
  }
  const seenChecks = new Set();
  for (const name of requiredChecks) {
    requireNonEmptyString(name, 'each requiredChecks entry');
    if (seenChecks.has(name)) {
      throw new ConfigError(`requiredChecks contains a duplicate: ${name}`);
    }
    seenChecks.add(name);
  }

  // dangerousEdges: optional glob patterns. Default to no dangerous edges.
  let dangerousEdges = [];
  if (raw.dangerousEdges !== undefined) {
    if (!Array.isArray(raw.dangerousEdges)) {
      throw new ConfigError('dangerousEdges must be an array of glob patterns');
    }
    dangerousEdges = raw.dangerousEdges.map((p, i) =>
      requireNonEmptyString(p, `dangerousEdges[${i}]`)
    );
  }

  // branchPrefix: default claude/.
  let branchPrefix = 'claude/';
  if (raw.branchPrefix !== undefined) {
    branchPrefix = requireNonEmptyString(raw.branchPrefix, 'branchPrefix');
  }

  // notify: default { channel: 'none' }.
  let notify = { channel: 'none' };
  if (raw.notify !== undefined) {
    if (!isPlainObject(raw.notify)) {
      throw new ConfigError('notify must be an object');
    }
    const channel = raw.notify.channel;
    if (!VALID_NOTIFY_CHANNELS.has(channel)) {
      throw new ConfigError(
        `notify.channel must be one of: ${[...VALID_NOTIFY_CHANNELS].join(', ')}`
      );
    }
    notify = { channel };
    if (channel !== 'none') {
      if (raw.notify.target === undefined) {
        throw new ConfigError(`notify.target is required when notify.channel is '${channel}'`);
      }
      notify.target = requireNonEmptyString(raw.notify.target, 'notify.target');
    } else if (raw.notify.target !== undefined) {
      // Allow a target alongside 'none' but ignore it; surface no error.
      notify.target = raw.notify.target;
    }
  }

  // mergeMode: required, one of the two supported modes.
  const { mergeMode } = raw;
  if (!VALID_MERGE_MODES.has(mergeMode)) {
    throw new ConfigError(
      `mergeMode must be one of: ${[...VALID_MERGE_MODES].join(', ')}`
    );
  }

  // migrations: optional. When present, dir is required and numberWidth
  // defaults to 4.
  let migrations;
  if (raw.migrations !== undefined) {
    if (!isPlainObject(raw.migrations)) {
      throw new ConfigError('migrations must be an object');
    }
    const dir = requireNonEmptyString(raw.migrations.dir, 'migrations.dir');
    let numberWidth = 4;
    if (raw.migrations.numberWidth !== undefined) {
      numberWidth = raw.migrations.numberWidth;
      if (!Number.isInteger(numberWidth) || numberWidth < 1) {
        throw new ConfigError('migrations.numberWidth must be a positive integer');
      }
    }
    migrations = { dir, numberWidth };
  }

  return {
    requiredChecks: [...requiredChecks],
    dangerousEdges,
    branchPrefix,
    notify,
    mergeMode,
    ...(migrations ? { migrations } : {}),
  };
}

// loadConfig reads loop.config.json from disk and validates it.
export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  const abs = resolve(path);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read config at ${abs}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config at ${abs} is not valid JSON: ${err.message}`);
  }
  // The optional $schema key is metadata, not config; drop it before validation.
  if (isPlainObject(raw)) delete raw.$schema;
  return validateConfig(raw);
}
