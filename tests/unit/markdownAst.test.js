import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  parseMarkdown,
  extractPlainSnippet,
  toggleTaskLine
} from '../../src/core/markdownAst.js';

test('slugify normalizes Turkish characters, accents, and punctuation', () => {
  assert.equal(slugify('Dağıtık Sistemler Mimarisi!'), 'dagitik-sistemler-mimarisi');
  assert.equal(slugify('İstanbul Şehir Rehberi 2026'), 'istanbul-sehir-rehberi-2026');
  assert.equal(slugify('  Multiple --- Spaces  '), 'multiple-spaces');
});

test('parseMarkdown extracts YAML frontmatter, title, tags, and headings', () => {
  const md = `---
title: Consensus Protocols
tags: [distributed, raft/leader]
status: active
pinned: true
---

# Overview
Discussing #consensus and #systems/fault-tolerance without matching #ffffff hex colors.

\`\`\`js
const fake = "#not-a-tag [[not-a-link]]";
\`\`\`

## Leader Election
Details here.`;

  const res = parseMarkdown(md);
  assert.equal(res.title, 'Consensus Protocols');
  assert.equal(res.frontmatter.status, 'active');
  assert.equal(res.frontmatter.pinned, true);
  assert.deepEqual(res.tags, ['distributed', 'raft/leader', 'consensus', 'systems/fault-tolerance']);
  assert.equal(res.headings.length, 2);
  assert.equal(res.headings[0].id, 'overview');
  assert.equal(res.headings[1].level, 2);
  assert.equal(res.links.length, 0);
});

test('parseMarkdown extracts wikilinks, aliases, embeds, and prevents embed cycles', () => {
  const notes = {
    'alpha': { id: '1', slug: 'alpha', title: 'Alpha', content: '# Alpha\nSee ![[Beta]]' },
    'beta': { id: '2', slug: 'beta', title: 'Beta', content: '# Beta\nCycle ![[Alpha]]' },
  };
  const md = `# Root
Link to [[Alpha|Alpha Note]] and [[Missing Ghost Note]].
![[Alpha]]`;

  const res = parseMarkdown(md, {
    resolveNote: (slug) => notes[slug] || null
  });

  assert.deepEqual(
    res.links.map((l) => l.targetSlug),
    ['alpha', 'missing-ghost-note']
  );
  assert.equal(res.links[0].alias, 'Alpha Note');
  assert.match(res.html, /class="wikilink is-resolved"/);
  assert.match(res.html, /class="wikilink is-ghost"/);
  assert.match(res.html, /tessera-embed/);
  assert.match(res.html, /Circular transclusion detected|Embed depth limit/i);
});

test('parseMarkdown extracts tasks with exact 1-based line numbers and toggles safely', () => {
  const md = `---
title: Sprint
---
# Tasks
- [ ] First task !high @2026-11-20 #doing
- [x] Completed task
  - [ ] Nested task`;

  const res = parseMarkdown(md);
  assert.equal(res.tasks.length, 3);
  assert.deepEqual(res.tasks[0], {
    lineNo: 5,
    text: 'First task !high @2026-11-20 #doing',
    done: false,
    doing: true,
    priority: 'high',
    dueDate: '2026-11-20'
  });
  assert.equal(res.tasks[1].lineNo, 6);
  assert.equal(res.tasks[1].done, true);
  assert.equal(res.tasks[2].lineNo, 7);

  const toggled = toggleTaskLine(md, 5, true);
  assert.equal(toggled.changed, true);
  assert.match(toggled.updated, /- \[x\] First task/);

  const invalid = toggleTaskLine(md, 4, true);
  assert.equal(invalid.changed, false);
  assert.equal(invalid.updated, md);
});

test('parseMarkdown extracts Q::A, multi-line ??, and {{cloze}} flashcards outside code blocks', () => {
  const md = `# Recall Notes
CAP Theorem :: Consistency, Availability, Partition Tolerance

What is WAL in SQLite?
??
Write-Ahead Logging appends changes before checkpointing.

FSRS tracks {{stability}} and {{difficulty}} independently.

\`\`\`
ignored :: card inside code
\`\`\``;

  const res = parseMarkdown(md);
  assert.equal(res.flashcards.length, 3);
  assert.equal(res.flashcards[0].kind, 'qa');
  assert.equal(res.flashcards[0].front, 'CAP Theorem');
  assert.equal(res.flashcards[0].back, 'Consistency, Availability, Partition Tolerance');
  assert.equal(res.flashcards[1].kind, 'qa');
  assert.match(res.flashcards[1].front, /What is WAL in SQLite/);
  assert.match(res.flashcards[1].back, /Write-Ahead Logging/);
  assert.equal(res.flashcards[2].kind, 'cloze');
  assert.match(res.flashcards[2].front, /\[\.\.\.\]/);
  assert.match(res.flashcards[2].back, /stability/);
  assert.ok(res.flashcards[0].blockHash.length >= 12);
});

test('parseMarkdown renders callouts and tables while strictly sanitizing XSS payloads', () => {
  const md = `> [!WARNING] Watch Out
> Always validate inputs.

| Engine | Speed |
| :--- | ---: |
| FTS5 | 2ms |

<script>alert(1)</script>
<img src="x" onerror="alert(2)">
[Click me](javascript:alert(3))
[Safe](https://example.com)`;

  const res = parseMarkdown(md);
  assert.match(res.html, /callout-warning/);
  assert.match(res.html, /<table>/);
  assert.match(res.html, /text-align:right/);
  assert.doesNotMatch(res.html, /<script>/i);
  assert.doesNotMatch(res.html, /<img\b/i);
  assert.doesNotMatch(res.html, /javascript:/i);
  assert.match(res.html, /href="https:\/\/example\.com"/);

  const amp = parseMarkdown('See [[SQLite WAL & FTS5]] and [Query](https://ex.com?a=1&b=2)');
  assert.equal(amp.links[0].targetSlug, 'sqlite-wal-fts5');
  assert.match(amp.html, /href="https:\/\/ex\.com\?a=1&amp;b=2"/);
});

test('extractPlainSnippet strips frontmatter and markdown markers cleanly', () => {
  const md = `---
title: Test
---
# Heading
This has **bold**, [[Wiki Link|Alias]], and \`code\`.`;
  const snip = extractPlainSnippet(md, 100);
  assert.equal(snip, 'Heading This has bold, Alias, and code.');
});
