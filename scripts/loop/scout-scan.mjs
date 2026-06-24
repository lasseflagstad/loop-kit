#!/usr/bin/env node
// scout-scan.mjs - the reusable scout: a read-only job-proposer.
//
// The scout scans a repo and writes ranked, diff-checkable jobs into the queue
// as `proposed`, for a human to approve. It is READ-ONLY on code: it never
// modifies source and it builds nothing. Its only write is appending proposed
// jobs to .loop/queue.json (and the PR the scout command opens around that).
//
// Every check it runs is config-driven via the `scout` section of
// loop.config.json (see config.mjs / loop.config.schema.json). Nothing about any
// one repo is hardcoded. The default set is generic and broadly safe:
//
//   emDash                  em-dash characters (the kit forbids them)
//   todoMarkers             leftover task markers (see TODO_MARKERS) in code
//   testsForSources         source files with no matching test
//   oversizedAssets         committed files over a size limit
//   brokenInternalLinks     (site) internal links that resolve to nothing
//   missingMetaDescription  (site) HTML pages with no meta description
//
// The two site checks default OFF: a generic repo is not a website. Turn them
// on (and optionally set `siteDir`) for a repo that builds a site.
//
// Honest scope: a code-scanning scout finds mechanical hygiene. It does NOT
// propose product or feature work - that needs human judgment and data the
// scout cannot see. For a repo whose remaining work is judgment-heavy it will
// propose little. That is expected, not a bug.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { matchGlob } from './glob.mjs';
import { isHumanGated } from './policy.mjs';
import { readQueue, writeQueue, DEFAULT_QUEUE_PATH } from './queue-io.mjs';
import { addProposedJob, fingerprintsInQueue } from './queue-lib.mjs';

// ---------------------------------------------------------------------------
// Defaults. config.mjs validates the shape of a `scout` section if present;
// this module owns the operational defaults so the scanner works whether or not
// a repo configured one. resolveScout merges a (validated) partial over these.
// ---------------------------------------------------------------------------
export const DEFAULT_SCOUT = {
  maxProposals: 5,
  checks: {
    emDash: true,
    todoMarkers: true,
    testsForSources: true,
    oversizedAssets: true,
    brokenInternalLinks: false,
    missingMetaDescription: false,
  },
  // Files to scan, and files to skip. A path is scanned when it matches an
  // `include` and no `exclude`.
  include: ['**/*'],
  exclude: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    'out/**',
    'coverage/**',
    '.loop/**',
    'vendor/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
  ],
  // A committed file larger than this (bytes) is flagged as an oversized asset.
  maxAssetBytes: 512000,
  // Extensions considered "source" for the tests-for-sources check.
  sourceExtensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  // Extensions scanned for task markers (TODO_MARKERS). Documentation (.md) is
  // excluded so a doc that merely mentions the markers is not flagged.
  commentScanExtensions: [
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.py', '.go', '.rs',
  ],
  // When set, the site checks (links, meta description) are scoped to this
  // directory and '/'-rooted links resolve under it. null scopes them to the
  // whole repo.
  siteDir: null,
};

// Ranking weight per check: higher is proposed first when the cap binds.
const CHECK_WEIGHTS = {
  testsForSources: 80,
  oversizedAssets: 75,
  brokenInternalLinks: 70,
  missingMetaDescription: 50,
  todoMarkers: 40,
  emDash: 30,
};

// The em-dash, referenced by escape so this scanner never contains the literal
// character it hunts for (it would otherwise flag its own source).
const EM_DASH = '\u2014';
const EM_DASH_RE = /\u2014/g;

// Marker words assembled from fragments for the same reason: the contiguous
// strings never appear in this file, so the scanner does not flag itself.
const TODO_MARKERS = ['TO' + 'DO', 'FIX' + 'ME'];
const TODO_MARKER_RE = new RegExp('\\b(' + TODO_MARKERS.join('|') + ')\\b', 'g');

const TEXT_READ_CAP = 2_000_000; // do not slurp files larger than this as text

// ---------------------------------------------------------------------------
// resolveScout: a fully defaulted scout config from a (possibly partial) one.
// ---------------------------------------------------------------------------
export function resolveScout(raw = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_SCOUT,
    ...s,
    checks: { ...DEFAULT_SCOUT.checks, ...(s.checks || {}) },
    include: s.include || DEFAULT_SCOUT.include,
    exclude: s.exclude || DEFAULT_SCOUT.exclude,
    sourceExtensions: s.sourceExtensions || DEFAULT_SCOUT.sourceExtensions,
    commentScanExtensions:
      s.commentScanExtensions || DEFAULT_SCOUT.commentScanExtensions,
    siteDir: s.siteDir === undefined ? DEFAULT_SCOUT.siteDir : s.siteDir,
  };
}

// ---------------------------------------------------------------------------
// File collection (read-only). Returns repo-relative, '/'-separated paths with
// size, extension, and cached text (null for binary or oversized files).
// ---------------------------------------------------------------------------
function isExcludedDir(name) {
  return name === '.git' || name === 'node_modules';
}

function walk(absDir, relDir, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (isExcludedDir(ent.name)) continue;
      walk(join(absDir, ent.name), rel, out);
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
}

function readTextSafe(abs, size) {
  if (size > TEXT_READ_CAP) return null;
  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return null; // a NUL byte means binary
  }
  return buf.toString('utf8');
}

export function collectFiles(repoRoot, scout) {
  const root = resolve(repoRoot);
  const rels = [];
  walk(root, '', rels);
  const files = [];
  for (const rel of rels) {
    const included = scout.include.some((p) => matchGlob(rel, p));
    if (!included) continue;
    const excluded = scout.exclude.some((p) => matchGlob(rel, p));
    if (excluded) continue;
    const abs = join(root, rel);
    let size;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    files.push({
      path: rel,
      abs,
      size,
      ext: extname(rel).toLowerCase(),
      text: readTextSafe(abs, size),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------
// Small text helpers.
// ---------------------------------------------------------------------------
function locate(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  const excerpt = text.slice(lineStart, lineEnd).trim().slice(0, 120);
  return { line, excerpt };
}

function countMatches(text, re) {
  re.lastIndex = 0;
  let count = 0;
  let first = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (first === -1) first = m.index;
    count++;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return { count, first };
}

// A test file is one named *.test.* / *.spec.* or living under a tests/
// __tests__ directory. Its "stem" is the basename with the test marker and
// extension stripped, so foo.test.mjs and tests/foo.mjs both map to "foo".
function isTestFile(path) {
  const base = path.split('/').pop();
  if (/\.(test|spec)\./.test(base)) return true;
  return /(^|\/)(tests?|__tests__|__test__)\//.test(path);
}

function testStem(path) {
  let base = path.split('/').pop();
  base = base.replace(/\.(test|spec)\.[^.]+$/, '');
  base = base.replace(/\.[^.]+$/, '');
  return base;
}

function sourceStem(path) {
  const base = path.split('/').pop();
  return base.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// Checks. Each returns an array of findings. A finding is:
//   { check, file, line, excerpt, occurrences, score, fingerprint, targets,
//     title, description, requirements: [...], impactEffort }
// `targets` are the files a fix would likely touch (used to pre-gate proposals
// that would modify a dangerous edge).
// ---------------------------------------------------------------------------
function checkEmDash(files) {
  const findings = [];
  for (const f of files) {
    if (f.text === null) continue;
    const { count, first } = countMatches(f.text, EM_DASH_RE);
    if (count === 0) continue;
    const { line, excerpt } = locate(f.text, first);
    findings.push({
      check: 'emDash',
      file: f.path,
      line,
      excerpt,
      occurrences: count,
      score: CHECK_WEIGHTS.emDash,
      fingerprint: `emDash:${f.path}`,
      targets: [f.path],
      title: `Remove ${count} em-dash character${count > 1 ? 's' : ''} from ${f.path}`,
      description:
        `${f.path} contains ${count} em-dash character${count > 1 ? 's' : ''} ` +
        `(U+2014). The kit's house style forbids em-dashes; replace each with ` +
        `" - ", a colon, or a reworded sentence.`,
      requirements: [
        `Replace every em-dash (U+2014) in ${f.path} with " - ", ": ", or reworded text.`,
        `${f.path} contains zero em-dash (U+2014) characters after the change.`,
        `No meaning is lost: each replacement reads naturally in context.`,
      ],
      impactEffort:
        'Impact: low (style and consistency). Effort: low (mechanical replacement).',
    });
  }
  return findings;
}

function checkTodoMarkers(files, scout) {
  const exts = new Set(scout.commentScanExtensions);
  const findings = [];
  for (const f of files) {
    if (f.text === null) continue;
    if (!exts.has(f.ext)) continue;
    const { count, first } = countMatches(f.text, TODO_MARKER_RE);
    if (count === 0) continue;
    const { line, excerpt } = locate(f.text, first);
    findings.push({
      check: 'todoMarkers',
      file: f.path,
      line,
      excerpt,
      occurrences: count,
      score: CHECK_WEIGHTS.todoMarkers,
      fingerprint: `todoMarkers:${f.path}`,
      targets: [f.path],
      title: `Resolve ${count} ${TODO_MARKERS.join('/')} marker${count > 1 ? 's' : ''} in ${f.path}`,
      description:
        `${f.path} has ${count} leftover ${TODO_MARKERS.join('/')} marker` +
        `${count > 1 ? 's' : ''} (first at line ${line}). Either finish the work ` +
        `the marker describes or remove the marker once it no longer applies.`,
      requirements: [
        `Address each ${TODO_MARKERS.join('/')} marker in ${f.path}: implement it or delete it.`,
        `${f.path} contains no ${TODO_MARKERS.join(' or ')} markers after the change.`,
        `Any behavior a marker implied is either delivered or explicitly dropped in the PR description.`,
      ],
      impactEffort:
        'Impact: low to medium (unfinished work left in the tree). ' +
        'Effort: low to medium (resolve or remove each marker).',
    });
  }
  return findings;
}

function checkTestsForSources(files, scout) {
  const sourceExts = new Set(scout.sourceExtensions);
  const stems = new Set();
  for (const f of files) {
    if (isTestFile(f.path)) stems.add(testStem(f.path));
  }
  const findings = [];
  for (const f of files) {
    if (!sourceExts.has(f.ext)) continue;
    if (isTestFile(f.path)) continue;
    const stem = sourceStem(f.path);
    if (stems.has(stem)) continue;
    findings.push({
      check: 'testsForSources',
      file: f.path,
      line: null,
      excerpt: '',
      occurrences: 1,
      score: CHECK_WEIGHTS.testsForSources,
      fingerprint: `testsForSources:${f.path}`,
      targets: [f.path],
      title: `Add a test for ${f.path}`,
      description:
        `${f.path} has no matching test file (nothing named ${stem}.test.* or ` +
        `${stem}.spec.*, and no tests/${stem}.* sibling). Untested code can ` +
        `regress without the gate noticing. Add a focused test for its behavior.`,
      requirements: [
        `Create a test file for ${f.path} (for example tests/${stem}.test${f.ext} or ${stem}.test${f.ext}).`,
        `The test imports from ${f.path} and exercises its exported behavior, including at least one edge case.`,
        `The repo's check command (for example npm run check) runs the new test and passes.`,
      ],
      impactEffort:
        'Impact: medium to high (untested code can regress silently). ' +
        'Effort: medium (write focused tests).',
    });
  }
  return findings;
}

function checkOversizedAssets(files, scout) {
  const limit = scout.maxAssetBytes;
  const findings = [];
  for (const f of files) {
    if (f.size <= limit) continue;
    const kb = Math.round(f.size / 1024);
    const limitKb = Math.round(limit / 1024);
    findings.push({
      check: 'oversizedAssets',
      file: f.path,
      line: null,
      excerpt: `${kb} KB`,
      occurrences: 1,
      score: CHECK_WEIGHTS.oversizedAssets,
      fingerprint: `oversizedAssets:${f.path}`,
      targets: [f.path],
      title: `Shrink or externalize ${f.path} (${kb} KB)`,
      description:
        `${f.path} is ${kb} KB, over the ${limitKb} KB asset limit. Large ` +
        `committed files bloat the repo and slow clones. Remove it, optimize ` +
        `it, or move it to external storage / Git LFS.`,
      requirements: [
        `Reduce ${f.path} below ${limitKb} KB by optimizing it, or remove it from version control, or move it to external storage / Git LFS.`,
        `If it stays in the repo, it is under the ${limitKb} KB limit after the change.`,
        `Nothing that referenced ${f.path} is broken by the change.`,
      ],
      impactEffort:
        'Impact: medium (repo bloat, slower clones). ' +
        'Effort: low to medium (remove, optimize, or externalize).',
    });
  }
  return findings;
}

// Is a link external / non-file (so we do not try to resolve it)?
function isExternalLink(href) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // scheme: http:, mailto:, tel:, data:
    href.startsWith('//') ||
    href.startsWith('#')
  );
}

function extractLinks(text, ext) {
  const links = []; // { href, index }
  if (ext === '.html' || ext === '.htm' || ext === '.vue' || ext === '.svelte') {
    const re = /(?:href|src)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text)) !== null) links.push({ href: m[1], index: m.index });
  }
  if (ext === '.md' || ext === '.markdown') {
    const inline = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
    let m;
    while ((m = inline.exec(text)) !== null) links.push({ href: m[1], index: m.index });
  }
  return links;
}

function checkBrokenInternalLinks(files, scout, repoRoot) {
  const siteRootAbs = scout.siteDir ? join(resolve(repoRoot), scout.siteDir) : resolve(repoRoot);
  const findings = [];
  for (const f of files) {
    if (f.text === null) continue;
    if (scout.siteDir && !f.path.startsWith(scout.siteDir.replace(/\/+$/, '') + '/')) continue;
    if (!['.html', '.htm', '.md', '.markdown', '.vue', '.svelte'].includes(f.ext)) continue;
    const baseDirAbs = dirname(f.abs);
    for (const { href, index } of extractLinks(f.text, f.ext)) {
      if (isExternalLink(href)) continue;
      const clean = href.split('#')[0].split('?')[0];
      if (clean === '') continue;
      const targetAbs = clean.startsWith('/')
        ? join(siteRootAbs, clean.slice(1))
        : resolve(baseDirAbs, clean);
      const candidates = [targetAbs, join(targetAbs, 'index.html'), `${targetAbs}.html`];
      if (candidates.some((c) => existsSync(c))) continue;
      const { line, excerpt } = locate(f.text, index);
      findings.push({
        check: 'brokenInternalLinks',
        file: f.path,
        line,
        excerpt,
        occurrences: 1,
        score: CHECK_WEIGHTS.brokenInternalLinks,
        fingerprint: `brokenInternalLinks:${f.path}:${line}:${clean}`,
        targets: [f.path],
        title: `Fix broken internal link to ${clean} in ${f.path}`,
        description:
          `${f.path} (line ${line}) links to "${clean}", which does not resolve ` +
          `to any file or route. A broken internal link is a dead end for users.`,
        requirements: [
          `Update or remove the link to "${clean}" in ${f.path} at line ${line}.`,
          `The link resolves to an existing file or a valid route after the change.`,
          `No other internal links in ${f.path} are broken by the edit.`,
        ],
        impactEffort:
          'Impact: medium to high (broken navigation for users). ' +
          'Effort: low (fix or remove the link).',
      });
    }
  }
  return findings;
}

function checkMissingMetaDescription(files, scout) {
  const findings = [];
  for (const f of files) {
    if (f.text === null) continue;
    if (f.ext !== '.html' && f.ext !== '.htm') continue;
    if (scout.siteDir && !f.path.startsWith(scout.siteDir.replace(/\/+$/, '') + '/')) continue;
    const re = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i;
    const tag = f.text.match(re);
    const hasContent = tag && /content\s*=\s*["'][^"']*\S[^"']*["']/i.test(tag[0]);
    if (hasContent) continue;
    findings.push({
      check: 'missingMetaDescription',
      file: f.path,
      line: 1,
      excerpt: '',
      occurrences: 1,
      score: CHECK_WEIGHTS.missingMetaDescription,
      fingerprint: `missingMetaDescription:${f.path}`,
      targets: [f.path],
      title: `Add a meta description to ${f.path}`,
      description:
        `${f.path} has no <meta name="description"> with content. A missing ` +
        `description weakens search results and link previews for this page.`,
      requirements: [
        `Add a <meta name="description" content="..."> to the <head> of ${f.path}.`,
        `The description is a concise, unique summary of the page (roughly 50 to 160 characters).`,
        `The page still renders correctly after the change.`,
      ],
      impactEffort:
        'Impact: medium (weaker SEO and link previews). ' +
        'Effort: low (add one meta tag).',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Ranking: highest score first, then more occurrences, then path, then check,
// for a stable, deterministic order.
// ---------------------------------------------------------------------------
export function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.check < b.check ? -1 : a.check > b.check ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// scan: run every enabled check over the repo and return ranked findings.
// Pure with respect to the queue: it reads files only, writes nothing.
// ---------------------------------------------------------------------------
export function scan(repoRoot, rawScout) {
  const scout = resolveScout(rawScout);
  const files = collectFiles(repoRoot, scout);
  const findings = [];
  if (scout.checks.emDash) findings.push(...checkEmDash(files));
  if (scout.checks.todoMarkers) findings.push(...checkTodoMarkers(files, scout));
  if (scout.checks.testsForSources) findings.push(...checkTestsForSources(files, scout));
  if (scout.checks.oversizedAssets) findings.push(...checkOversizedAssets(files, scout));
  if (scout.checks.brokenInternalLinks)
    findings.push(...checkBrokenInternalLinks(files, scout, repoRoot));
  if (scout.checks.missingMetaDescription)
    findings.push(...checkMissingMetaDescription(files, scout));
  return { scout, files: files.map((f) => f.path), findings: rankFindings(findings) };
}

// ---------------------------------------------------------------------------
// runScout: scan, then ADD up to maxProposals new proposed jobs to the queue.
// It never edits or removes existing jobs (addProposedJob is pure-append) and
// it skips any finding already proposed (matched by fingerprint), so re-runs do
// not pile up duplicates. Returns a structured report; performs at most one
// write (the queue) unless dryRun is set.
// ---------------------------------------------------------------------------
export function runScout({
  repoRoot = '.',
  config,
  queuePath = DEFAULT_QUEUE_PATH,
  now,
  max,
  dryRun = false,
} = {}) {
  const { scout, findings, files } = scan(repoRoot, config.scout);
  const cap = Number.isInteger(max) && max > 0 ? max : scout.maxProposals;

  const queueBefore = readQueue(queuePath);
  const seen = fingerprintsInQueue(queueBefore);

  const fresh = findings.filter((f) => !seen.has(f.fingerprint));
  const selected = fresh.slice(0, cap);
  const deferred = fresh.slice(cap);

  const createdAt = new Date(now).toISOString();
  let queue = queueBefore;
  const added = [];
  for (const f of selected) {
    const gated = isHumanGated(f.targets || [f.file], config.dangerousEdges || []).gated;
    queue = addProposedJob(queue, {
      title: f.title,
      description: f.description,
      requirements: f.requirements,
      evidence: {
        check: f.check,
        file: f.file,
        line: f.line,
        excerpt: f.excerpt,
        occurrences: f.occurrences,
      },
      impactEffort: f.impactEffort,
      fingerprint: f.fingerprint,
      humanGated: gated,
      createdAt,
    });
    const job = queue.jobs[queue.jobs.length - 1];
    added.push({ id: job.id, title: job.title, check: f.check, humanGated: gated });
  }

  if (!dryRun && added.length > 0) {
    writeQueue(queuePath, queue);
  }

  return {
    scanned: files.length,
    totalFindings: findings.length,
    alreadyProposed: findings.length - fresh.length,
    proposed: added,
    deferred: deferred.length,
    cap,
    queue,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { repo: '.', configPath: null, queuePath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--config') args.configPath = argv[++i];
    else if (a === '--queue') args.queuePath = argv[++i];
    else if (a === '--max') args.max = Number.parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = `Usage: scout-scan [options]

Scan the repo (read-only) and ADD up to maxProposals ranked, diff-checkable jobs
to the queue as 'proposed', for a human to approve. Modifies no source.

Options:
  --repo <path>     repo root to scan (default ".")
  --config <path>   loop.config.json (default "${DEFAULT_CONFIG_PATH}")
  --queue <path>    queue file (default "${DEFAULT_QUEUE_PATH}")
  --max <n>         cap proposals this run (default scout.maxProposals)
  --dry-run         scan and print, but do not write the queue
  -h, --help        show this help`;

function main(argv, env, now) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  let config;
  try {
    config = loadConfig(args.configPath || join(args.repo, DEFAULT_CONFIG_PATH));
  } catch (err) {
    process.stderr.write(`scout: could not load config: ${err.message}\n`);
    return 2;
  }

  let report;
  try {
    report = runScout({
      repoRoot: args.repo,
      config,
      queuePath: args.queuePath || join(args.repo, DEFAULT_QUEUE_PATH),
      now,
      max: args.max,
      dryRun: !!args.dryRun,
    });
  } catch (err) {
    process.stderr.write(`scout: scan failed: ${err.message}\n`);
    return 2;
  }

  process.stdout.write(
    `Scanned ${report.scanned} files; ${report.totalFindings} finding(s), ` +
      `${report.alreadyProposed} already proposed.\n`
  );
  if (report.proposed.length === 0) {
    process.stdout.write('No new proposals.\n');
  } else {
    const verb = args.dryRun ? 'Would propose' : 'Proposed';
    process.stdout.write(`${verb} ${report.proposed.length} job(s):\n`);
    for (const p of report.proposed) {
      const gate = p.humanGated ? ' [human-gated]' : '';
      process.stdout.write(`  ${p.id}  ${p.check.padEnd(22)}  ${p.title}${gate}\n`);
    }
  }
  if (report.deferred > 0) {
    process.stdout.write(
      `(${report.deferred} more finding(s) over the cap of ${report.cap}; ` +
        `they will surface on a later scan.)\n`
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2), process.env, Date.now()));
}

export { main, parseArgs, EM_DASH, TODO_MARKERS };
