import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKnowledgeGraph,
  findShortestPath,
  findUnlinkedMentions
} from '../../src/core/graphEngine.js';

const sampleNotes = [
  {
    id: 'n1',
    slug: 'hub-architecture',
    title: 'Hub Architecture',
    tags: ['architecture'],
    wordCount: 400,
    links: [
      { targetSlug: 'sqlite-wal', targetRaw: 'SQLite WAL' },
      { targetSlug: 'fsrs-memory', targetRaw: 'FSRS Memory' },
      { targetSlug: 'ghost-topic', targetRaw: 'Ghost Topic' }
    ],
    content: 'Connects SQLite WAL and FSRS Memory.'
  },
  {
    id: 'n2',
    slug: 'sqlite-wal',
    title: 'SQLite WAL',
    tags: ['database'],
    wordCount: 250,
    links: [{ targetSlug: 'hub-architecture', targetRaw: 'Hub Architecture' }, { targetSlug: 'fts5-ranking', targetRaw: 'FTS5 Ranking' }],
    content: 'Mentions Hub Architecture and FTS5 Ranking.'
  },
  {
    id: 'n3',
    slug: 'fts5-ranking',
    title: 'FTS5 Ranking',
    tags: ['search'],
    wordCount: 180,
    links: [],
    content: 'Discusses BM25 and SQLite WAL indexing without linking Hub Architecture.'
  },
  {
    id: 'n4',
    slug: 'fsrs-memory',
    title: 'FSRS Memory',
    tags: ['learning'],
    wordCount: 300,
    links: [{ targetSlug: 'hub-architecture', targetRaw: 'Hub Architecture' }],
    content: 'Spaced repetition back to Hub Architecture.'
  },
  {
    id: 'n5',
    slug: 'orphan-note',
    title: 'Orphan Note',
    tags: ['misc'],
    wordCount: 50,
    links: [],
    content: 'Completely isolated.'
  }
];

test('buildKnowledgeGraph computes edges, ghost links, clusters, orphans, and PageRank hubs', () => {
  const graph = buildKnowledgeGraph(sampleNotes, { includeGhosts: true });

  assert.equal(graph.nodes.length, 6); // 5 real notes + 1 ghost node
  assert.equal(graph.ghosts.length, 1);
  assert.equal(graph.ghosts[0].slug, 'ghost-topic');

  const realHub = graph.nodes.find((n) => n.id === 'n1');
  const orphan = graph.nodes.find((n) => n.id === 'n5');
  assert.ok(realHub.pagerank > orphan.pagerank);
  assert.ok(graph.orphans.some((o) => o.id === 'n5'));
  assert.ok(graph.stats.clusterCount >= 2);
});

test('findShortestPath discovers shortest chain across directed/undirected links', () => {
  const graph = buildKnowledgeGraph(sampleNotes, { includeGhosts: false });
  const path = findShortestPath(graph, 'n4', 'n3');
  assert.equal(path.found, true);
  assert.deepEqual(path.pathIds, ['n4', 'n1', 'n2', 'n3']);

  const unreachable = findShortestPath(graph, 'n4', 'n5');
  assert.equal(unreachable.found, false);
  assert.deepEqual(unreachable.pathIds, []);
});

test('findUnlinkedMentions finds plain-text note title references not already wikilinked', () => {
  const target = sampleNotes[0]; // Hub Architecture
  const mentions = findUnlinkedMentions(target, sampleNotes);
  // n3 mentions "Hub Architecture" without [[...]], while n2 & n4 already link to n1
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].sourceId, 'n3');
  assert.match(mentions[0].excerpt, /Hub Architecture/);
});
