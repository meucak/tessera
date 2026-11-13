import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff, computeWordDiff } from '../../src/core/diffEngine.js';

test('computeLineDiff handles identical texts with zero edits', () => {
  const diff = computeLineDiff('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma');
  assert.equal(diff.stats.added, 0);
  assert.equal(diff.stats.removed, 0);
  assert.equal(diff.stats.unchanged, 3);
  assert.equal(diff.hunks.length, 3);
  assert.ok(diff.hunks.every((h) => h.type === 'equal'));
});

test('computeLineDiff detects additions, deletions, and preserves line numbers', () => {
  const oldText = 'line 1\nline 2\nline 3\nline 4';
  const newText = 'line 1\nline 2 modified\nline 4\nline 5';

  const diff = computeLineDiff(oldText, newText);
  assert.equal(diff.stats.unchanged, 2);
  assert.equal(diff.stats.removed, 2);
  assert.equal(diff.stats.added, 2);

  const removed = diff.hunks.filter((h) => h.type === 'delete');
  const added = diff.hunks.filter((h) => h.type === 'add');
  assert.deepEqual(removed.map((r) => r.text), ['line 2', 'line 3']);
  assert.deepEqual(added.map((a) => a.text), ['line 2 modified', 'line 5']);
  assert.equal(diff.hunks[0].oldLine, 1);
  assert.equal(diff.hunks[0].newLine, 1);
});

test('computeLineDiff handles empty inputs cleanly', () => {
  const a = computeLineDiff('', 'hello\nworld');
  assert.equal(a.stats.added, 2);
  assert.equal(a.stats.removed, 0);

  const b = computeLineDiff('hello', '');
  assert.equal(b.stats.removed, 1);
  assert.equal(b.stats.added, 0);
});

test('computeWordDiff highlights changed tokens within a line', () => {
  const parts = computeWordDiff('SQLite uses B-tree indexes', 'SQLite uses FTS5 inverted indexes');
  const dels = parts.filter((p) => p.type === 'del').map((p) => p.text.trim()).filter(Boolean);
  const adds = parts.filter((p) => p.type === 'add').map((p) => p.text.trim()).filter(Boolean);
  assert.deepEqual(dels, ['B-tree']);
  assert.deepEqual(adds, ['FTS5', 'inverted']);
});
