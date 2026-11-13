import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlainSnippet,
  parseFrontmatter,
  parseMarkdown,
  sanitizeUrl,
  toggleTaskLine
} from '../../src/core/markdownAst.js';
import { WsHub } from '../../src/server/wsHub.js';

test('sanitizeUrl blocks javascript/data/vbscript protocols and permits http/https/relative hashes', () => {
  assert.equal(sanitizeUrl('https://example.com/a(b)'), 'https://example.com/a(b)');
  assert.equal(sanitizeUrl('/notes/sqlite'), '/notes/sqlite');
  assert.equal(sanitizeUrl('#heading-1'), '#heading-1');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#blocked');
  assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), '#blocked');
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#blocked');
  assert.equal(sanitizeUrl('vbscript:msgbox(1)'), '#blocked');
});

test('toggleTaskLine ignores out-of-range lines, non-task lines, and idempotent states cleanly', () => {
  const md = '- First\n- [ ] Action A\n- [x] Action B\n';
  assert.deepEqual(toggleTaskLine(md, 0, true), { updated: md.trimEnd() + '\n', changed: false });
  assert.deepEqual(toggleTaskLine(md, 1, true), { updated: md, changed: false });
  assert.deepEqual(toggleTaskLine(md, 2, false), { updated: md, changed: false });
  const res = toggleTaskLine(md, 2, true);
  assert.equal(res.changed, true);
  assert.ok(res.updated.includes('- [x] Action A'));
});

test('parseFrontmatter parses CRLF, boolean, bracket lists, and hyphenated lists', () => {
  const md = '---\r\ntitle: "Test Title"\r\ntags: [alpha, beta]\r\npinned: true\r\n---\r\n\r\nBody line\r\n';
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.frontmatter.title, 'Test Title');
  assert.deepEqual(parsed.frontmatter.tags, ['alpha', 'beta']);
  assert.equal(parsed.frontmatter.pinned, true);
  assert.equal(parsed.bodyStartLine, 6);
});

test('parseMarkdown handles nested task lists, code blocks without parsing flashcards inside them, and snippets', () => {
  const md = [
    '# Heading',
    '```js',
    'const x = "What :: Not a flashcard {{nope}}";',
    '```',
    '- [ ] Outer task !high @2026-12-15',
    '  - [x] Nested done #doing'
  ].join('\n');

  const out = parseMarkdown(md);
  assert.equal(out.flashcards.length, 0);
  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[0].priority, 'high');
  assert.equal(out.tasks[0].dueDate, '2026-12-15');
  assert.equal(out.tasks[1].done, true);
  assert.equal(out.tasks[1].doing, true);
  assert.ok(extractPlainSnippet(md, 50).length <= 50);
});

test('WsHub broadcasts JSON events to open sockets excluding originator clientId cleanly', () => {
  const hub = new WsHub();
  const sentA = [];
  const sentB = [];
  const fakeA = { clientId: 'c-other', readyState: 1, send: (msg) => sentA.push(msg), close: () => {} };
  const fakeOrigin = { clientId: 'c-1', readyState: 1, send: (msg) => sentB.push(msg), close: () => {} };
  const fakeClosed = { clientId: 'c-closed', readyState: 3, send: (msg) => sentB.push(msg), close: () => {} };

  hub.clients.add(fakeA);
  hub.clients.add(fakeOrigin);
  hub.clients.add(fakeClosed);
  hub.broadcast({ type: 'note.updated', id: 'n1' }, 'c-1');
  hub.close();

  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 0);
  const decoded = JSON.parse(sentA[0]);
  assert.equal(decoded.type, 'note.updated');
  assert.equal(decoded.id, 'n1');
});
