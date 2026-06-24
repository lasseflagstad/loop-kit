// Tests for the dependency-free glob matcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, matchAny, globToRegExp } from '../glob.mjs';

test('* matches within a single segment, not across /', () => {
  assert.equal(matchGlob('a.js', '*.js'), true);
  assert.equal(matchGlob('src/a.js', '*.js'), false);
  assert.equal(matchGlob('src/a.js', 'src/*.js'), true);
  assert.equal(matchGlob('src/sub/a.js', 'src/*.js'), false);
});

test('** matches across path separators, including zero segments', () => {
  assert.equal(matchGlob('a.js', '**/a.js'), true); // zero leading dirs
  assert.equal(matchGlob('x/a.js', '**/a.js'), true);
  assert.equal(matchGlob('x/y/z/a.js', '**/a.js'), true);
  assert.equal(matchGlob('scripts/loop/green-gate.mjs', 'scripts/loop/**'), true);
});

test('** on both sides matches a nested directory anywhere', () => {
  assert.equal(matchGlob('db/migrations/0001.sql', '**/migrations/**'), true);
  assert.equal(matchGlob('migrations/0001.sql', '**/migrations/**'), true);
  assert.equal(matchGlob('src/app.js', '**/migrations/**'), false);
});

test('? matches exactly one non-separator character', () => {
  assert.equal(matchGlob('a.js', '?.js'), true);
  assert.equal(matchGlob('ab.js', '?.js'), false);
  assert.equal(matchGlob('a/b', 'a?b'), false);
});

test('regex metacharacters in the pattern are matched literally', () => {
  assert.equal(matchGlob('loop.config.json', 'loop.config.json'), true);
  assert.equal(matchGlob('loopXconfig.json', 'loop.config.json'), false); // '.' is literal
});

test('a leading ./ is normalized away on both sides', () => {
  assert.equal(matchGlob('./src/a.js', 'src/*.js'), true);
  assert.equal(matchGlob('src/a.js', './src/*.js'), true);
});

test('backslashes are normalized to forward slashes', () => {
  assert.equal(matchGlob('src\\a.js', 'src/*.js'), true);
});

test('matchAny returns the first matching pattern or null', () => {
  assert.equal(matchAny('loop.config.json', ['*.md', 'loop.config.json']), 'loop.config.json');
  assert.equal(matchAny('src/a.js', ['*.md', '*.json']), null);
});

test('globToRegExp anchors the whole string', () => {
  const re = globToRegExp('src/*.js');
  assert.equal(re.test('src/a.js'), true);
  assert.equal(re.test('x/src/a.js'), false);
  assert.equal(re.test('src/a.js.bak'), false);
});
