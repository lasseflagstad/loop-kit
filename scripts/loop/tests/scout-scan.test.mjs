// Tests for the scout: a read-only job-proposer. A fixture repo in a temp dir
// holds one known instance of every check; the suite proves the scanner finds
// them, that proposals carry diff-checkable requirements, and that the scout
// only ADDS proposed jobs - it touches no protected job and no source.
//
// The fixture's em-dash and marker strings are assembled at runtime (never
// written as literals in this file) so this test file is itself clean under the
// very checks it exercises.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, resolveScout, runScout, DEFAULT_SCOUT } from '../scout-scan.mjs';
import { readQueue } from '../queue-io.mjs';

const T = '2026-06-24T00:00:00.000Z';
const NOW = Date.parse(T);
const EM = String.fromCharCode(0x2014); // em-dash, built so this file stays clean
const MARKER = 'TO' + 'DO'; // a task marker, likewise assembled

// The files the fixture creates, with content. Anything not listed must remain
// untouched by the scout (it is read-only on source).
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'scout-'));
  const files = {
    'src/widget.mjs':
      `export function widget(x) {\n  // ${MARKER}: handle negative input\n  return x * 2;\n}\n`,
    'src/helper.mjs': 'export const helper = () => 1;\n',
    'src/helper.test.mjs': "import { helper } from './helper.mjs';\nhelper();\n",
    'notes.md': `# Notes\n\nThis sentence has an em-dash ${EM} right here.\n`,
    'big.bin': 'a'.repeat(8192),
    'site/index.html':
      '<!doctype html>\n<html><head><title>Home</title></head>\n<body>\n' +
      '<a href="about.html">About</a>\n<a href="missing.html">Missing</a>\n' +
      '</body></html>\n',
    'site/about.html':
      '<!doctype html>\n<html><head><title>About</title>\n' +
      '<meta name="description" content="About this fixture site and what it covers.">\n' +
      '</head><body><a href="index.html">Home</a></body></html>\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  // Seed a queue with protected jobs the scout must never touch.
  mkdirSync(join(root, '.loop'), { recursive: true });
  const seedJobs = [
    {
      id: '001', title: 'pre-queued', spec: 's', status: 'queued',
      humanGated: false, createdAt: T, branch: null, pr: null,
      headSha: null, shippedAt: null, note: null,
    },
    {
      id: '002', title: 'pre-shipped', spec: 's', status: 'shipped',
      humanGated: false, createdAt: T, branch: 'b', pr: 5,
      headSha: 'x'.repeat(40), shippedAt: T, note: null,
    },
  ];
  writeFileSync(
    join(root, '.loop/queue.json'),
    JSON.stringify({ version: 1, jobs: seedJobs }, null, 2) + '\n'
  );
  return { root, files, seedJobs };
}

// A scout config that turns every check on (including the two site checks) and
// sets a small asset limit so only big.bin trips it.
function allChecksConfig() {
  return {
    dangerousEdges: ['src/**'],
    scout: {
      maxProposals: 50,
      checks: {
        emDash: true,
        todoMarkers: true,
        testsForSources: true,
        oversizedAssets: true,
        brokenInternalLinks: true,
        missingMetaDescription: true,
      },
      maxAssetBytes: 4096,
    },
  };
}

function findingFor(findings, check, file) {
  return findings.find((f) => f.check === check && f.file === file);
}

// ---------------------------------------------------------------------------
// resolveScout / defaults
// ---------------------------------------------------------------------------
test('resolveScout fills defaults and merges a partial checks object', () => {
  const r = resolveScout({ checks: { emDash: false } });
  assert.equal(r.checks.emDash, false); // overridden
  assert.equal(r.checks.todoMarkers, true); // default kept
  assert.equal(r.maxProposals, DEFAULT_SCOUT.maxProposals);
  assert.equal(r.checks.brokenInternalLinks, false); // site check default off
});

test('the two site checks default off', () => {
  const r = resolveScout({});
  assert.equal(r.checks.brokenInternalLinks, false);
  assert.equal(r.checks.missingMetaDescription, false);
});

// ---------------------------------------------------------------------------
// The scanner finds the known issues in the fixture (requirement 6)
// ---------------------------------------------------------------------------
test('scan finds one known instance of every check', () => {
  const { root } = buildFixture();
  const { findings } = scan(root, allChecksConfig().scout);

  assert.ok(findingFor(findings, 'emDash', 'notes.md'), 'em-dash in notes.md');
  assert.ok(findingFor(findings, 'todoMarkers', 'src/widget.mjs'), 'marker in widget');
  assert.ok(findingFor(findings, 'testsForSources', 'src/widget.mjs'), 'widget has no test');
  assert.ok(findingFor(findings, 'oversizedAssets', 'big.bin'), 'big.bin is oversized');
  assert.ok(
    findingFor(findings, 'brokenInternalLinks', 'site/index.html'),
    'broken link in index.html'
  );
  assert.ok(
    findingFor(findings, 'missingMetaDescription', 'site/index.html'),
    'index.html has no meta description'
  );

  // helper.mjs has a matching test, so it is not flagged; about.html has a meta
  // description and only valid links, so it is not flagged either.
  assert.equal(findingFor(findings, 'testsForSources', 'src/helper.mjs'), undefined);
  assert.equal(findingFor(findings, 'missingMetaDescription', 'site/about.html'), undefined);
  assert.equal(findingFor(findings, 'brokenInternalLinks', 'site/about.html'), undefined);
});

test('disabled checks produce no findings', () => {
  const { root } = buildFixture();
  const { findings } = scan(root, {
    checks: {
      emDash: false, todoMarkers: false, testsForSources: false,
      oversizedAssets: false, brokenInternalLinks: false, missingMetaDescription: false,
    },
  });
  assert.equal(findings.length, 0);
});

// ---------------------------------------------------------------------------
// Proposals carry diff-checkable requirements (requirement 3 / 6)
// ---------------------------------------------------------------------------
test('every proposal carries a diff-checkable requirements list rendered into the spec', () => {
  const { root } = buildFixture();
  const config = allChecksConfig();
  const report = runScout({ repoRoot: root, config, queuePath: join(root, '.loop/queue.json'), now: NOW });

  const q = readQueue(join(root, '.loop/queue.json'));
  const proposed = q.jobs.filter((j) => j.status === 'proposed');
  assert.ok(proposed.length >= 6, 'all fixture findings became proposals');

  for (const job of proposed) {
    assert.ok(Array.isArray(job.proposal.requirements), 'requirements is an array');
    assert.ok(job.proposal.requirements.length > 0, 'requirements is non-empty');
    for (const r of job.proposal.requirements) {
      assert.equal(typeof r, 'string');
      assert.ok(r.length > 0);
      assert.ok(job.spec.includes(r), 'each requirement is rendered into the spec');
    }
    // Evidence points at the exact finding.
    assert.ok(job.proposal.evidence.check);
    assert.ok(job.proposal.evidence.file);
    assert.ok(job.proposal.impactEffort.length > 0);
    assert.ok(job.proposal.fingerprint.length > 0);
  }
  assert.equal(report.proposed.length, proposed.length);
});

// ---------------------------------------------------------------------------
// The scout only ADDS proposed jobs: no protected job, no source (req 3 / 4)
// ---------------------------------------------------------------------------
test('runScout adds only proposed jobs and never touches a protected job', () => {
  const { root, seedJobs } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW });

  const q = readQueue(queuePath);
  // The two seeded jobs survive byte-for-byte.
  for (const original of seedJobs) {
    const after = q.jobs.find((j) => j.id === original.id);
    assert.deepEqual(after, original, `protected job ${original.id} unchanged`);
  }
  // Every job the scout added is 'proposed'.
  const added = q.jobs.filter((j) => !seedJobs.some((s) => s.id === j.id));
  assert.ok(added.length > 0);
  for (const j of added) assert.equal(j.status, 'proposed');
});

test('runScout modifies no source file (read-only on code)', () => {
  const { root, files } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW });

  for (const [rel, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(root, rel), 'utf8'), content, `${rel} untouched`);
  }
});

test('--dry-run writes nothing to the queue', () => {
  const { root } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  const before = readFileSync(queuePath, 'utf8');
  const report = runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW, dryRun: true });
  assert.ok(report.proposed.length > 0, 'it still reports what it would add');
  assert.equal(readFileSync(queuePath, 'utf8'), before, 'but the file is unchanged');
});

// ---------------------------------------------------------------------------
// Human-gating, dedupe, and the proposal cap
// ---------------------------------------------------------------------------
test('a proposal whose fix would touch a dangerous edge is human-gated', () => {
  const { root } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW });
  const q = readQueue(queuePath);

  const widgetTest = q.jobs.find(
    (j) => j.proposal && j.proposal.fingerprint === 'testsForSources:src/widget.mjs'
  );
  assert.equal(widgetTest.humanGated, true, 'src/** is a dangerous edge');

  const notesEmDash = q.jobs.find(
    (j) => j.proposal && j.proposal.fingerprint === 'emDash:notes.md'
  );
  assert.equal(notesEmDash.humanGated, false, 'notes.md is not a dangerous edge');
});

test('a second scan proposes nothing new (dedupe by fingerprint)', () => {
  const { root } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  const first = runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW });
  assert.ok(first.proposed.length > 0);

  const second = runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW });
  assert.equal(second.proposed.length, 0, 'already-proposed findings are skipped');
  assert.equal(second.alreadyProposed, first.totalFindings);
});

test('the proposal cap bounds a run and defers the rest, highest-ranked first', () => {
  const { root } = buildFixture();
  const queuePath = join(root, '.loop/queue.json');
  const report = runScout({ repoRoot: root, config: allChecksConfig(), queuePath, now: NOW, max: 2 });
  assert.equal(report.proposed.length, 2);
  assert.ok(report.deferred > 0);
  // testsForSources (80) and oversizedAssets (75) outrank the rest.
  const checks = report.proposed.map((p) => p.check);
  assert.deepEqual(checks, ['testsForSources', 'oversizedAssets']);
});

// ---------------------------------------------------------------------------
// Guard: the kit's own tree carries no em-dashes (requirement 6: "No em-dashes")
// ---------------------------------------------------------------------------
test('the kit\'s own source contains no em-dashes', () => {
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const { findings } = scan(repoRoot, { checks: {
    emDash: true, todoMarkers: false, testsForSources: false,
    oversizedAssets: false, brokenInternalLinks: false, missingMetaDescription: false,
  } });
  assert.deepEqual(
    findings.map((f) => f.file),
    [],
    'no tracked file may contain an em-dash (U+2014)'
  );
});
