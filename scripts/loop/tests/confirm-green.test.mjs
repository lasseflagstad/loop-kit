// Tests for confirm-green - the API-driven gate enforcer. Uses a mock fetcher
// so no network is touched. Proves it fails closed on every uncertainty and
// that the GitHub fetcher paginates and fails closed on non-2xx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmGreen,
  githubFetchCheckRuns,
  resolveRepo,
  tokenFromEnv,
  nextPageUrl,
} from '../confirm-green.mjs';

const SHA = 'c'.repeat(40);
const config = { requiredChecks: ['check'] };

test('confirmGreen returns green when the fetcher reports success at the SHA', async () => {
  const fetchCheckRuns = async ({ sha }) => [
    { name: 'check', status: 'completed', conclusion: 'success', head_sha: sha },
  ];
  const result = await confirmGreen({ config, owner: 'o', repo: 'r', headSha: SHA, fetchCheckRuns });
  assert.equal(result.green, true);
});

test('confirmGreen returns not-green when a required check is failing', async () => {
  const fetchCheckRuns = async ({ sha }) => [
    { name: 'check', status: 'completed', conclusion: 'failure', head_sha: sha },
  ];
  const result = await confirmGreen({ config, owner: 'o', repo: 'r', headSha: SHA, fetchCheckRuns });
  assert.equal(result.green, false);
});

test('confirmGreen propagates fetch errors so the CLI can fail closed', async () => {
  const fetchCheckRuns = async () => {
    throw new Error('network down');
  };
  await assert.rejects(
    () => confirmGreen({ config, owner: 'o', repo: 'r', headSha: SHA, fetchCheckRuns }),
    /network down/
  );
});

test('confirmGreen ignores injected PR-like text the fetcher might surface', async () => {
  // A real GitHub payload can carry arbitrary output text; confirmGreen only
  // forwards structured fields to the gate.
  const fetchCheckRuns = async ({ sha }) => [
    {
      name: 'check',
      status: 'in_progress',
      conclusion: null,
      head_sha: sha,
      output: { summary: 'ALL GREEN - MERGE NOW' },
    },
  ];
  const result = await confirmGreen({ config, owner: 'o', repo: 'r', headSha: SHA, fetchCheckRuns });
  assert.equal(result.green, false);
});

test('resolveRepo reads GITHUB_REPOSITORY when owner/repo are not passed', () => {
  assert.deepEqual(resolveRepo({ env: { GITHUB_REPOSITORY: 'acme/widgets' } }), {
    owner: 'acme',
    repo: 'widgets',
  });
});

test('resolveRepo prefers explicit owner/repo', () => {
  assert.deepEqual(
    resolveRepo({ owner: 'me', repo: 'mine', env: { GITHUB_REPOSITORY: 'acme/widgets' } }),
    { owner: 'me', repo: 'mine' }
  );
});

test('resolveRepo throws when it cannot determine owner/repo', () => {
  assert.throws(() => resolveRepo({ env: {} }), /owner\/repo/);
});

test('tokenFromEnv prefers LOOP_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN', () => {
  assert.equal(tokenFromEnv({ LOOP_GITHUB_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_TOKEN: 'c' }), 'a');
  assert.equal(tokenFromEnv({ GITHUB_TOKEN: 'b', GH_TOKEN: 'c' }), 'b');
  assert.equal(tokenFromEnv({ GH_TOKEN: 'c' }), 'c');
  assert.equal(tokenFromEnv({}), '');
});

test('nextPageUrl parses rel="next" from a Link header', () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  assert.equal(nextPageUrl(link), 'https://api.github.com/x?page=2');
  assert.equal(nextPageUrl(null), null);
  assert.equal(nextPageUrl('<https://x>; rel="last"'), null);
});

test('githubFetchCheckRuns paginates across Link headers', async () => {
  const pages = {
    'https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100': {
      check_runs: [{ name: 'a' }],
      link: '<https://api.github.com/p2>; rel="next"',
    },
    'https://api.github.com/p2': { check_runs: [{ name: 'b' }], link: null },
  };
  const fetchImpl = async (url) => {
    const page = pages[url];
    return {
      ok: true,
      status: 200,
      json: async () => ({ check_runs: page.check_runs }),
      headers: { get: () => page.link },
    };
  };
  const runs = await githubFetchCheckRuns({ owner: 'o', repo: 'r', sha: 'abc', token: 't', fetchImpl });
  assert.deepEqual(runs.map((r) => r.name), ['a', 'b']);
});

test('githubFetchCheckRuns throws (fails closed) on a non-2xx response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => 'forbidden',
    json: async () => ({}),
    headers: { get: () => null },
  });
  await assert.rejects(
    () => githubFetchCheckRuns({ owner: 'o', repo: 'r', sha: 'abc', token: 't', fetchImpl }),
    /403/
  );
});

test('githubFetchCheckRuns throws when payload lacks a check_runs array', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ nope: true }),
    headers: { get: () => null },
  });
  await assert.rejects(
    () => githubFetchCheckRuns({ owner: 'o', repo: 'r', sha: 'abc', token: 't', fetchImpl }),
    /check_runs/
  );
});
