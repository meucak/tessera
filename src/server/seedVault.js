/**
 * Seeds a rich sovereign knowledge base, spatial board, and historical review activity
 * only when the SQLite vault is empty.
 */
export function seedVaultIfEmpty(store) {
  const stats = store.getStats();
  if (stats.notes > 0) return;

  const hub = store.createNote({
    title: 'Tessera Architecture & Philosophy',
    folder: 'Architecture',
    pinned: true,
    content: `---
title: Tessera Architecture & Philosophy
folder: Architecture
tags: [architecture, sovereign, core]
status: active
pinned: true
---

# Tessera Architecture & Philosophy

> [!NOTE] Sovereign Knowledge Engine
> Everything in Tessera lives in a local SQLite WAL database with zero external cloud dependencies and instant bidirectional linking.

## Five Integrated Workspaces
1. **Studio Editor:** Bidirectional Markdown with live transclusions, callouts, and AST-extracted tasks.
2. **Knowledge Graph:** Powered by PageRank centrality and BFS shortest-path analysis in [[Force-Directed Knowledge Graphs]].
3. **Spatial Canvas:** Infinite 8pt-snapped boards described in [[Spatial Canvas Primer]].
4. **Recall Lab:** Automated deck scheduling using [[FSRS v4.5 Memory Model]].
5. **Version Time-Travel:** Myers line diffing across every saved checkpoint.

## Core Data Store
All notes, tasks, and links flow transactionally into [[SQLite WAL & FTS5 Engine]]. Uncreated references like [[Ghost Roadmap]] appear as discoverable ghost nodes until materialized.

## Engineering Tasks
- [x] Implement SQLite FTS5 BM25 weighted search index
- [ ] Add multi-board SVG print sheet export !high @2026-11-20 #doing
- [ ] Benchmark Myers diff on 10,000-line engineering specs !medium @2026-11-28

## Core Concepts
What keeps Tessera's search and graph indices consistent on save? :: Single SQLite BEGIN IMMEDIATE transaction updating FTS5, links, tasks, and cards atomically.
`,
    snapshotLabel: 'v1.0 Architecture draft'
  });

  // Create a crisp second version on hub so Version Diff is immediately rich to explore!
  store.updateNote(hub.note.id, {
    content: hub.note.content + `\n> [!TIP] Keyboard Navigation\n> Press \`Ctrl/Cmd + K\` anywhere to jump across notes, search operators like \`tag:architecture\`, or trigger actions.\n`,
    forceSnapshot: true,
    snapshotLabel: 'v1.1 Added keyboard tip callout'
  });

  const sqliteNote = store.createNote({
    title: 'SQLite WAL & FTS5 Engine',
    folder: 'Systems',
    pinned: true,
    content: `---
title: SQLite WAL & FTS5 Engine
folder: Systems
tags: [database, sqlite, performance]
status: active
pinned: true
---

# SQLite WAL & FTS5 Engine

SQLite in **Write-Ahead Logging (WAL)** mode allows concurrent readers to query without blocking an active writer. This underpins [[Tessera Architecture & Philosophy]].

## Configuration Pragma
\`\`\`sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
SELECT title, bm25(notes_fts, 5.0, 3.0, 1.5, 1.0) AS rank
FROM notes_fts WHERE notes_fts MATCH 'sqlite*';
\`\`\`

## Ranking Weights
| Column | Weight | Purpose |
| :--- | :---: | :--- |
| Title | 5.0 | Direct concept lookup |
| Tags | 3.0 | Taxonomy clustering |
| Folder | 1.5 | Workspace scope |
| Body | 1.0 | Full-text recall |

- [ ] Profile FTS5 prefix indexing latency on 5,000 notes !low @2026-12-01

## Recall Deck
Why does WAL mode improve read concurrency? :: Readers inspect the snapshot prior to uncheckpointed WAL frames without waiting for writers.
SQLite {{bm25}} ranks FTS5 documents using inverse document frequency and {{field weights}}.
`
  });

  const fsrsNote = store.createNote({
    title: 'FSRS v4.5 Memory Model',
    folder: 'Learning',
    content: `---
title: FSRS v4.5 Memory Model
folder: Learning
tags: [fsrs, memory, math]
status: active
---

# FSRS v4.5 Memory Model

Unlike fixed SM-2 multipliers, **FSRS (Free Spaced Repetition Scheduler)** models memory with two explicit state variables: **Stability ($S$)** and **Difficulty ($D$)**. Related to [[Tessera Architecture & Philosophy]] and [[Distributed Consensus Notes]].

> [!IMPORTANT] Retrievability Formula
> Recall probability decays over elapsed days $t$ according to a power-law forgetting curve:

$$R(t, S) = (1 + F \\cdot t / S)^{-0.5}$$

## Key Properties
- **Stability ($S$):** Days required for retrievability to drop from 100% to 90%.
- **Difficulty ($D$):** Inherent complexity clamped between \`1.0\` and \`10.0\`.
- **Mean Reversion:** Prevents ease-hell traps after early lapses.

## Study Cards
What does Stability S represent in FSRS?
??
The interval in days for recall probability (retrievability) to decay from 100% down to 90%.

In FSRS v4.5, Difficulty D is clamped between {{1.0}} and {{10.0}}.
`
  });

  const graphNote = store.createNote({
    title: 'Force-Directed Knowledge Graphs',
    folder: 'Architecture',
    content: `---
title: Force-Directed Knowledge Graphs
folder: Architecture
tags: [graph, algorithms, visualization]
status: active
---

# Force-Directed Knowledge Graphs

Tessera models bidirectional wikilinks as a living graph inside [[Tessera Architecture & Philosophy]], surfacing structural hubs via **PageRank** and semantic bridges via **BFS Shortest Path** toward topics like [[Distributed Consensus Notes]].

## Force Equilibrium
1. **Coulomb Repulsion:** Keeps unconnected clusters spatially legible.
2. **Hooke Spring Attraction:** Pulls linked concepts into coherent neighborhoods.
3. **Center Gravity:** Prevents disconnected orphans from drifting off-canvas.

- [ ] Add cluster hull bounding outlines on graph zoom-out !medium #doing

What algorithm does Tessera use to find the shortest semantic path between two notes? :: Breadth-First Search (BFS) over the undirected wikilink adjacency graph.
`
  });

  const consensusNote = store.createNote({
    title: 'Distributed Consensus Notes',
    folder: 'Systems',
    content: `---
title: Distributed Consensus Notes
folder: Systems
tags: [distributed, raft, consensus]
status: active
---

# Distributed Consensus Notes

Consensus protocols such as **Raft** decompose fault-tolerant state machine replication into leader election, log replication, and safety invariants. Compare log durability with SQLite WAL & FTS5 Engine when building local-first sync.

> [!WARNING] Split-Brain Guard
> A leader must never commit log entries from a previous term purely by counting replicas without confirming a current-term entry.

- [x] Sketch Raft term transition diagram on Spatial Canvas
- [ ] Write property-based test for network partition healing !high @2026-11-22

Raft splits consensus into {{Leader Election}}, {{Log Replication}}, and Safety.
`
  });

  const canvasNote = store.createNote({
    title: 'Spatial Canvas Primer',
    folder: 'Architecture',
    content: `---
title: Spatial Canvas Primer
folder: Architecture
tags: [canvas, spatial, design]
status: active
---

# Spatial Canvas Primer

Spatial boards let you arrange living note cards, color-coded sticky thoughts, group containers, and curved Bézier connectors on an infinite 8pt-snapped workspace. Connected to [[Tessera Architecture & Philosophy]] and [[Force-Directed Knowledge Graphs]].

![[FSRS v4.5 Memory Model]]

- [ ] Export System Architecture board as high-res SVG diagram
`
  });

  store.createNote({
    title: 'Isolated Field Note',
    folder: 'Inbox',
    status: 'draft',
    content: `---
title: Isolated Field Note
folder: Inbox
tags: [inbox, draft]
status: draft
---

# Isolated Field Note

This intentional orphan note has zero inbound or outbound wikilinks yet, demonstrating how Tessera's Graph Health Diagnostics surfaces isolated thoughts ready to be woven into the main knowledge web.

- [ ] Connect this note to a hub in Architecture
`
  });

  const today = new Date().toISOString().slice(0, 10);
  store.createNote({
    title: `Daily Journal — ${today}`,
    folder: 'Daily',
    content: `---
title: Daily Journal — ${today}
folder: Daily
tags: [daily, journal]
status: active
---

# Daily Journal — ${today}

## Morning Focus
- [ ] Run FSRS recall queue in [[FSRS v4.5 Memory Model]] !high @${today} #doing
- [ ] Link unlinked mention inside [[Distributed Consensus Notes]]

## Technical Notes
Exploring how [[SQLite WAL & FTS5 Engine]] powers zero-latency command palette search across notes and spatial boards.
`
  });

  // Seed one rich Spatial Canvas board
  store.createBoard({
    title: 'System Architecture Map',
    description: 'Interactive spatial topology linking Tessera core engines and notes.',
    viewport: { x: 40, y: 40, zoom: 0.95 },
    nodes: [
      {
        id: 'grp_core',
        type: 'group',
        x: 40,
        y: 32,
        w: 640,
        h: 416,
        title: 'Core Storage & Algorithms',
        color: 'neutral'
      },
      {
        id: 'node_hub',
        type: 'note',
        noteId: hub.note.id,
        x: 72,
        y: 88,
        w: 264,
        h: 168,
        title: hub.note.title,
        color: 'terracotta'
      },
      {
        id: 'node_sqlite',
        type: 'note',
        noteId: sqliteNote.note.id,
        x: 384,
        y: 88,
        w: 264,
        h: 168,
        title: sqliteNote.note.title,
        color: 'cobalt'
      },
      {
        id: 'node_fsrs',
        type: 'note',
        noteId: fsrsNote.note.id,
        x: 72,
        y: 280,
        w: 264,
        h: 144,
        title: fsrsNote.note.title,
        color: 'sage'
      },
      {
        id: 'node_graph',
        type: 'note',
        noteId: graphNote.note.id,
        x: 384,
        y: 280,
        w: 264,
        h: 144,
        title: graphNote.note.title,
        color: 'amber'
      },
      {
        id: 'node_sticky',
        type: 'sticky',
        x: 736,
        y: 120,
        w: 240,
        h: 168,
        title: 'Design Principle',
        body: 'Single SQLite truth store + deterministic AST extraction ensures notes, graphs, tasks, and FSRS decks never drift out of sync.',
        color: 'amber'
      }
    ],
    edges: [
      { id: 'e1', from: 'node_hub', to: 'node_sqlite', label: 'WAL + FTS5', style: 'solid' },
      { id: 'e2', from: 'node_hub', to: 'node_fsrs', label: 'Deck Sync', style: 'solid' },
      { id: 'e3', from: 'node_hub', to: 'node_graph', label: 'PageRank', style: 'solid' },
      { id: 'e4', from: 'node_sticky', to: 'node_hub', label: 'Invariant', style: 'dashed' }
    ]
  });

  // Seed historical review activity for realistic heatmap + 1 already-reviewed card
  const fcData = store.listFlashcards();
  if (fcData.cards.length > 0) {
    const now = Date.now();
    // Review one card 3 days ago and keep the rest due now so the study deck has immediate items!
    const sampleCard = fcData.cards[fcData.cards.length - 1];
    store.reviewFlashcard(sampleCard.id, 3, new Date(now - 3 * 86400000));
    const insertLog = store.db.prepare(
      'INSERT INTO review_logs (card_id, rating, state_before, stability, difficulty, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let d = 14; d >= 1; d--) {
      const count = (d % 3) + 1;
      for (let k = 0; k < count; k++) {
        const dt = new Date(now - d * 86400000 - k * 3600000).toISOString();
        insertLog.run(sampleCard.id, k === 2 ? 2 : 3, 2, 4.5, 5.1, dt);
      }
    }
  }
}
