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
const VALID_ASTRA_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_ASTRA_SANDBOXES = new Set(['read-only', 'workspace-write']);

// The closed set of scout checks. A typo'd check name is rejected rather than
// silently ignored. The operational defaults for each (and for everything else
// in the scout section) live in scout-scan.mjs; this validates shape only.
const VALID_SCOUT_CHECKS = new Set([
  'emDash',
  'todoMarkers',
  'testsForSources',
  'oversizedAssets',
  'brokenInternalLinks',
  'missingMetaDescription',
]);

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

function requireStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array of non-empty strings`);
  }
  return value.map((v, i) => requireNonEmptyString(v, `${field}[${i}]`));
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${field} must be a positive integer`);
  }
  return value;
}

// Validate the optional `scout` section's shape. Defaults for omitted fields are
// applied by scout-scan.mjs (resolveScout), so this returns only the keys the
// repo actually set. Toggle names are checked against a closed set so a typo is
// caught rather than silently doing nothing.
function validateScout(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('scout must be an object');
  }
  const scout = {};
  if (raw.maxProposals !== undefined) {
    scout.maxProposals = requirePositiveInteger(raw.maxProposals, 'scout.maxProposals');
  }
  if (raw.checks !== undefined) {
    if (!isPlainObject(raw.checks)) {
      throw new ConfigError('scout.checks must be an object of booleans');
    }
    const checks = {};
    for (const [name, on] of Object.entries(raw.checks)) {
      if (!VALID_SCOUT_CHECKS.has(name)) {
        throw new ConfigError(`unknown scout check: ${name}`);
      }
      if (typeof on !== 'boolean') {
        throw new ConfigError(`scout.checks.${name} must be a boolean`);
      }
      checks[name] = on;
    }
    scout.checks = checks;
  }
  if (raw.include !== undefined) scout.include = requireStringArray(raw.include, 'scout.include');
  if (raw.exclude !== undefined) scout.exclude = requireStringArray(raw.exclude, 'scout.exclude');
  if (raw.sourceExtensions !== undefined) {
    scout.sourceExtensions = requireStringArray(raw.sourceExtensions, 'scout.sourceExtensions');
  }
  if (raw.commentScanExtensions !== undefined) {
    scout.commentScanExtensions = requireStringArray(
      raw.commentScanExtensions,
      'scout.commentScanExtensions'
    );
  }
  if (raw.maxAssetBytes !== undefined) {
    scout.maxAssetBytes = requirePositiveInteger(raw.maxAssetBytes, 'scout.maxAssetBytes');
  }
  if (raw.siteDir !== undefined && raw.siteDir !== null) {
    scout.siteDir = requireNonEmptyString(raw.siteDir, 'scout.siteDir');
  }
  return scout;
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

  // decisions: optional. The two-way async decision surface. When present, an
  // optional `inbox` names a file the kit reads one-line replies from on its
  // next run ("<decision-id> <answer>" per line). Omit it and the only way to
  // answer is the `loop-decisions answer` command (or editing the ledger).
  let decisions;
  if (raw.decisions !== undefined) {
    if (!isPlainObject(raw.decisions)) {
      throw new ConfigError('decisions must be an object');
    }
    decisions = {};
    if (raw.decisions.inbox !== undefined) {
      decisions.inbox = requireNonEmptyString(raw.decisions.inbox, 'decisions.inbox');
    }
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

  // scout: optional. When present, its shape is validated here; operational
  // defaults are filled by scout-scan.mjs so the scanner works with or without
  // a configured section.
  let scout;
  if (raw.scout !== undefined) {
    scout = validateScout(raw.scout);
  }

  // astra: the Claude Code to Codex worker bridge. Defaults pin GPT-6 Astra and
  // stay inside Codex's workspace-write sandbox. danger-full-access is
  // deliberately not accepted here.
  let astra = {
    enabled: true,
    command: 'codex',
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    sandbox: 'workspace-write',
  };
  if (raw.astra !== undefined) {
    if (!isPlainObject(raw.astra)) {
      throw new ConfigError('astra must be an object');
    }
    astra = { ...astra };
    if (raw.astra.enabled !== undefined) {
      if (typeof raw.astra.enabled !== 'boolean') {
        throw new ConfigError('astra.enabled must be a boolean');
      }
      astra.enabled = raw.astra.enabled;
    }
    if (raw.astra.command !== undefined) {
      astra.command = requireNonEmptyString(raw.astra.command, 'astra.command');
    }
    if (raw.astra.model !== undefined) {
      astra.model = requireNonEmptyString(raw.astra.model, 'astra.model');
    }
    if (raw.astra.reasoningEffort !== undefined) {
      if (!VALID_ASTRA_EFFORTS.has(raw.astra.reasoningEffort)) {
        throw new ConfigError(
          `astra.reasoningEffort must be one of: ${[...VALID_ASTRA_EFFORTS].join(', ')}`
        );
      }
      astra.reasoningEffort = raw.astra.reasoningEffort;
    }
    if (raw.astra.sandbox !== undefined) {
      if (!VALID_ASTRA_SANDBOXES.has(raw.astra.sandbox)) {
        throw new ConfigError(
          `astra.sandbox must be one of: ${[...VALID_ASTRA_SANDBOXES].join(', ')}`
        );
      }
      astra.sandbox = raw.astra.sandbox;
    }
  }

  return {
    requiredChecks: [...requiredChecks],
    dangerousEdges,
    branchPrefix,
    notify,
    mergeMode,
    ...(decisions ? { decisions } : {}),
    ...(migrations ? { migrations } : {}),
    ...(scout ? { scout } : {}),
    astra,
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
