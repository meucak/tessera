import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery } from '../../src/core/searchQuery.js';

test('parseSearchQuery extracts operators, phrases, negations, and builds safe FTS5 match string', () => {
  const parsed = parseSearchQuery('tag:docker folder:systems status:active has:tasks "write ahead" -legacy sqlite');
  assert.deepEqual(parsed.filters.tags, ['docker']);
  assert.deepEqual(parsed.filters.folders, ['systems']);
  assert.equal(parsed.filters.status, 'active');
  assert.equal(parsed.filters.hasTasks, true);
  assert.equal(parsed.filters.hasCards, false);
  assert.ok(parsed.ftsMatch.includes('"write ahead"'));
  assert.ok(parsed.ftsMatch.includes('sqlite*'));
  assert.ok(parsed.ftsMatch.includes('NOT legacy'));
});

test('parseSearchQuery sanitizes dangerous punctuation so FTS5 never throws syntax errors', () => {
  const tricky = parseSearchQuery('foo:bar (unbalanced "quote * + /');
  assert.equal(typeof tricky.ftsMatch, 'string');
  assert.doesNotThrow(() => parseSearchQuery('AND OR NOT :::: "" ()'));
});
