#!/usr/bin/env node
// confirm-green.mjs - self-enforce the green-gate via the GitHub API.
//
// This is the only thing that may authorize a merge. It fetches the check runs
// for an EXACT head SHA from the GitHub API, hands them to the pure evaluateGate
// (green-gate.mjs), and exits 0 only if the gate is green. It NEVER reads the PR
// title, body, or commit message, so injected instructions cannot move it.
//
// Any uncertainty fails closed: a network error, a non-2xx response, a missing
// token, or an unparseable payload all exit non-zero. The gate is green only
// when the API positively confirms every required check concluded success for
// the given SHA.
//
// Exit codes:
//   0  gate is green (safe to merge)
//   1  gate is not green (refuse)
//   2  usage / configuration error

import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { evaluateGate, GateError } from './green-gate.mjs';
import { isDirectInvocation } from './direct.mjs';

const GITHUB_API = 'https://api.github.com';

function tokenFromEnv(env) {
  return (
    env.LOOP_GITHUB_TOKEN ||
    env.GITHUB_TOKEN ||
    env.GH_TOKEN ||
    ''
  );
}

// Resolve owner/repo from "owner/repo" form (GITHUB_REPOSITORY) or explicit args.
function resolveRepo({ owner, repo, env }) {
  if (owner && repo) return { owner, repo };
  const slug = env.GITHUB_REPOSITORY || '';
  const [o, r] = slug.split('/');
  if (o && r) return { owner: o, repo: r };
  throw new Error(
    'could not determine owner/repo; pass --owner and --repo or set GITHUB_REPOSITORY=owner/repo'
  );
}

// Default fetcher: pull every check run for the SHA from the GitHub API,
// following pagination. Fails closed by throwing on any non-2xx.
export async function githubFetchCheckRuns({ owner, repo, sha, token, fetchImpl = fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'loop-kit-confirm-green',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const runs = [];
  let url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
  // Bound pagination to avoid an unbounded loop on a misbehaving endpoint.
  for (let page = 0; url && page < 50; page++) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `GitHub API returned ${res.status} for ${owner}/${repo}@${sha}: ${body.slice(0, 200)}`
      );
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.check_runs)) {
      throw new Error('GitHub API response did not contain a check_runs array');
    }
    runs.push(...json.check_runs);
    url = nextPageUrl(res.headers?.get?.('link'));
  }
  return runs;
}

// Parse the RFC 5988 Link header for rel="next".
function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// confirmGreen - the testable core. Fetches check runs (via the injected
// fetcher) and evaluates the gate. Returns the gate result; throws on fetch
// failure so the caller can fail closed.
export async function confirmGreen({ config, owner, repo, headSha, fetchCheckRuns }) {
  const checkRuns = await fetchCheckRuns({ owner, repo, sha: headSha });
  return evaluateGate({
    requiredChecks: config.requiredChecks,
    checkRuns,
    headSha,
  });
}

function parseArgs(argv) {
  const args = { configPath: DEFAULT_CONFIG_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') args.sha = argv[++i];
    else if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--config') args.configPath = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.sha) args.sha = a;
  }
  return args;
}

const USAGE = `Usage: confirm-green --sha <head-sha> [--owner <o>] [--repo <r>] [--config <path>]

Confirms the green-gate for an exact head SHA via the GitHub API.
Exits 0 only when every required check concluded success for that SHA.

Environment:
  GITHUB_REPOSITORY   owner/repo (used if --owner/--repo omitted)
  LOOP_GITHUB_TOKEN | GITHUB_TOKEN | GH_TOKEN   API token`;

async function main(argv, env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (!args.sha) {
    process.stderr.write('error: --sha <head-sha> is required\n\n' + USAGE + '\n');
    return 2;
  }

  let config;
  try {
    config = loadConfig(args.configPath);
  } catch (err) {
    process.stderr.write(`config error: ${err.message}\n`);
    return 2;
  }

  let owner, repo;
  try {
    ({ owner, repo } = resolveRepo({ owner: args.owner, repo: args.repo, env }));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }

  const token = tokenFromEnv(env);
  const fetchCheckRuns = ({ owner, repo, sha }) =>
    githubFetchCheckRuns({ owner, repo, sha, token });

  let result;
  try {
    result = await confirmGreen({ config, owner, repo, headSha: args.sha, fetchCheckRuns });
  } catch (err) {
    // Fail closed: any inability to positively confirm green refuses the merge.
    if (err instanceof GateError) {
      process.stderr.write(`gate error: ${err.message}\n`);
    } else {
      process.stderr.write(`could not confirm green (failing closed): ${err.message}\n`);
    }
    return 1;
  }

  if (result.green) {
    process.stdout.write(
      `GREEN: ${owner}/${repo}@${result.headSha} - all required checks concluded success ` +
        `(${config.requiredChecks.join(', ')})\n`
    );
    return 0;
  }

  process.stdout.write(`NOT GREEN: ${owner}/${repo}@${result.headSha}\n`);
  for (const reason of result.reasons) {
    process.stdout.write(`  - ${reason}\n`);
  }
  return 1;
}

// Run as a CLI when invoked directly (not when imported by tests).
if (isDirectInvocation(import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`unexpected error (failing closed): ${err.stack || err}\n`);
      process.exit(1);
    });
}

export { main, parseArgs, resolveRepo, tokenFromEnv, nextPageUrl };
