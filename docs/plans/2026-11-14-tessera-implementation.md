# Tessera Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build **Tessera**, a Dockerized self-hosted Spatial Knowledge Studio, Bidirectional Wiki, Knowledge Graph Explorer, Infinite Spatial Whiteboard, Version Diff Engine, Task Kanban, and FSRS v4.5 Recall Lab running on port `8092`.

**Architecture:** Node.js 22 (`node:sqlite` + FTS5 + WAL + pure `node:zlib` ZIP + `ws` WebSockets) serves both REST/WS APIs and a modular vanilla ES Modules frontend styled under Apple HIG & Anti-Slop principles (three calibrated themes: Alabaster Daylight, Warm Sepia Focus, Obsidian Studio). Automated testing uses `node:test` for unit/integration suites and a dedicated Dockerized Chromium + Playwright + `axe-core` visual/E2E suite.

**Tech Stack:** `node:22-alpine`, `node:sqlite`, `node:test`, `node:zlib`, `ws`, HTML5 Canvas (HiDPI), SVG, CSS Custom Properties, Docker & Docker Compose, Playwright + `axe-core`.

**Spec:** `docs/specs/2026-11-14-tessera-design.md`

## Global Constraints
- Port `8092`, memory cap `256m`, CPU cap `0.75` in `docker-compose.yml`.
- Zero host pollution: all builds, servers, and headless Chromium E2E tests execute inside Docker containers.
- Strict XSS sanitization in Markdown rendering: no raw `<script>`, event handlers, or `javascript:` URLs emitted.
- All interactive controls meet minimum `44x44px` touch target floor on mobile/touch and WCAG AA/AAA contrast across Light, Sepia, and Dark themes.
- Every core engine and API route is developed TDD-first (`node:test`).

## Review Focus
- Malformed YAML frontmatter, unclosed code fences, cyclic `![[embed]]` transclusions, and XSS payloads inside Markdown links/headings/tables must never crash or execute scripts.
- FTS5 structured queries containing punctuation, quotes, `-` operators, or unbalanced parentheses must never throw SQLite FTS syntax errors.
- Two-way task toggling in Tasks/Kanban must strictly validate `line_no` and preserve surrounding Markdown formatting cleanly even if a note was edited concurrently.
- FSRS v4.5 flashcard resync on note edit must preserve existing scheduling state via deterministic `block_hash` while removing stale cards only when explicitly deleted from source.
- Spatial Canvas zoom/pan coordinate transforms, drag-to-connect port wiring, and multi-tab WebSocket sync must handle out-of-bounds drags, missing target nodes, and mobile viewports without overlapping controls or horizontal scroll.

---

### Task 1: Markdown & Wiki AST Engine (`src/core/markdownAst.js`)
**Files:**
- Create: `src/core/markdownAst.js`
- Test: `tests/unit/markdownAst.test.js`

**Interfaces:**
- Produces:
  - `slugify(text: string): string`
  - `parseMarkdown(content: string, options?: { resolveNote?: (slug: string) => object|null, maxEmbedDepth?: number }): { frontmatter, title, tags, links, embeds, tasks, flashcards, headings, wordCount, html }`
  - `extractPlainSnippet(content: string, maxLen?: number): string`
  - `toggleTaskLine(content: string, lineNo: number, done: boolean): { updated: string, changed: boolean }`

- [ ] **Step 1:** Write failing TDD tests in `tests/unit/markdownAst.test.js` covering YAML frontmatter, headings, callouts, GFM tables, code highlighting, `[[wikilinks]]` with aliases, `![[embeds]]` cycle guard, `#nested/tags`, `- [ ]` task extraction & `toggleTaskLine`, `Q::A` / `??` / `{{cloze}}` flashcard extraction, and XSS sanitization (`<script>`, `onerror=`, `javascript:`).
- [ ] **Step 2:** Run `node --test tests/unit/markdownAst.test.js` and verify RED failure.
- [ ] **Step 3:** Implement `src/core/markdownAst.js`.
- [ ] **Step 4:** Run `node --test tests/unit/markdownAst.test.js` and verify GREEN pass.

---

### Task 2: Myers Diff Engine (`src/core/diffEngine.js`)
**Files:**
- Create: `src/core/diffEngine.js`
- Test: `tests/unit/diffEngine.test.js`

**Interfaces:**
- Produces:
  - `computeLineDiff(oldText: string, newText: string): { hunks: Array, stats: { added: number, removed: number, unchanged: number } }`
  - `computeWordDiff(oldLine: string, newLine: string): Array<{ type: 'eq'|'add'|'del', text: string }>`

- [ ] **Step 1:** Write failing TDD tests covering identical texts, insertions, deletions, multi-hunk edits, empty inputs, and intra-line word diffing.
- [ ] **Step 2:** Run test to verify RED.
- [ ] **Step 3:** Implement `src/core/diffEngine.js`.
- [ ] **Step 4:** Verify GREEN pass.

---

### Task 3: FSRS v4.5 Spaced Repetition Engine (`src/core/fsrsEngine.js`)
**Files:**
- Create: `src/core/fsrsEngine.js`
- Test: `tests/unit/fsrsEngine.test.js`

**Interfaces:**
- Produces:
  - `Rating` (`{ Again: 1, Hard: 2, Good: 3, Easy: 4 }`)
  - `State` (`{ New: 0, Learning: 1, Review: 2, Relearning: 3 }`)
  - `createEmptyCard(now?: Date): object`
  - `scheduleCard(card: object, rating: number, now?: Date): { card: object, log: object, intervalDays: number }`
  - `previewIntervals(card: object, now?: Date): Record<1|2|3|4, { label: string, days: number, card: object }>`
  - `retrievability(card: object, now?: Date): number`
  - `buildRetentionForecast(cards: Array, days?: number, now?: Date): Array<{ day: number, date: string, dueCount: number, avgRetrievability: number }>`

- [ ] **Step 1:** Write failing TDD tests covering new card first reviews, interval monotonicity (`Again < Hard <= Good < Easy`), lapse transitions to Relearning, retrievability decay math, and 30-day forecast aggregation.
- [ ] **Step 2:** Verify RED.
- [ ] **Step 3:** Implement `src/core/fsrsEngine.js`.
- [ ] **Step 4:** Verify GREEN pass.

---

### Task 4: Knowledge Graph Engine (`src/core/graphEngine.js`)
**Files:**
- Create: `src/core/graphEngine.js`
- Test: `tests/unit/graphEngine.test.js`

**Interfaces:**
- Produces:
  - `buildKnowledgeGraph(notes: Array, options?: { includeGhosts?: boolean }): { nodes, edges, ghosts, clusters, orphans, hubs, stats }`
  - `findShortestPath(graph: object, sourceId: string, targetId: string): { found: boolean, pathIds: string[], edgeKeys: string[] }`
  - `findUnlinkedMentions(note: object, allNotes: Array): Array<{ sourceId: string, sourceTitle: string, targetId: string, targetTitle: string, excerpt: string, count: number }>`

- [ ] **Step 1:** Write failing TDD tests covering resolved edges, ghost target detection, PageRank ordering (hub beats leaf), connected component cluster assignment, BFS shortest path (`A -> B -> C`), disconnected node handling, and unlinked mention detection excluding already-linked mentions.
- [ ] **Step 2:** Verify RED.
- [ ] **Step 3:** Implement `src/core/graphEngine.js`.
- [ ] **Step 4:** Verify GREEN pass.

---

### Task 5: FTS5 Search Query Parser & Pure-Zlib ZIP Vault (`src/core/searchQuery.js`, `src/server/zipVault.js`)
**Files:**
- Create: `src/core/searchQuery.js`, `src/server/zipVault.js`
- Test: `tests/unit/searchQuery.test.js`, `tests/unit/zipVault.test.js`

**Interfaces:**
- Produces:
  - `parseSearchQuery(raw: string): { ftsMatch: string|null, filters: { tags: string[], folders: string[], status: string|null, hasTasks: boolean, hasCards: boolean }, freeTerms: string[] }`
  - `buildZipBuffer(entries: Array<{ name: string, data: Buffer|string }>): Buffer`
  - `parseZipBuffer(buf: Buffer): Array<{ name: string, data: Buffer }>`

- [ ] **Step 1:** Write failing TDD tests for `parseSearchQuery` (operators + dangerous punctuation sanitization like `foo:bar`, quotes, `-negation`) and `zipVault` roundtrip (UTF-8 filenames, Turkish characters, compressed deflate entries, CRC32 check).
- [ ] **Step 2:** Verify RED.
- [ ] **Step 3:** Implement `searchQuery.js` and `zipVault.js`.
- [ ] **Step 4:** Verify GREEN pass.

---

### Task 6: SQLite Persistence, Seed Vault, WebSocket Hub & HTTP API (`src/server/*`)
**Files:**
- Create: `src/server/db.js`, `src/server/seedVault.js`, `src/server/wsHub.js`, `src/server/api.js`, `src/server/index.js`
- Test: `tests/integration/api.test.js`

**Interfaces:**
- Produces full REST API + WS server on `PORT` (default `8092`).

- [ ] **Step 1:** Write comprehensive integration tests in `tests/integration/api.test.js` covering health check, note CRUD + FTS5 BM25 search + operator filters, version snapshot & Myers diff & restore, backlinks + unlinked mentions + 1-click link mutation, graph & shortest-path endpoint, task extraction + two-way task line toggle, flashcard extraction + FSRS review + forecast, spatial board CRUD, ZIP/JSON vault export/import, and live WebSocket broadcast.
- [ ] **Step 2:** Verify RED.
- [ ] **Step 3:** Implement `db.js`, `seedVault.js`, `wsHub.js`, `api.js`, `index.js`.
- [ ] **Step 4:** Verify GREEN pass across all unit + integration tests.

---

### Task 7: Docker & Isolated Playwright/Axe-Core E2E Harness
**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `Dockerfile.test`, `docker-compose.test.yml`

- [ ] **Step 1:** Write production `Dockerfile` (`node:22-alpine`), `docker-compose.yml` (port `8092`, `256m` memory limit, `0.75` CPU, `/app/data` volume, healthcheck), and isolated `Dockerfile.test` (`node:22-alpine` + `chromium` + `playwright-core` + `axe-core` + fonts).
- [ ] **Step 2:** Build and boot `tessera` container and verify `/api/health` + `npm test` inside container.

---

### Task 8–10: Apple HIG Frontend Architecture (`src/public/*`)
**Files:**
- Create: `src/public/index.html`, `manifest.json`, `sw.js`, `icons/tessera.svg`
- Create: `src/public/styles/{tokens,base,layout,components}.css`
- Create: `src/public/js/{main,apiClient}.js`
- Create: `src/public/js/views/{studioView,graphView,boardView,recallView,tasksView}.js`
- Create: `src/public/js/components/{commandPalette,diffModal,vaultModal,toast}.js`

---

### Task 11: Comprehensive Playwright E2E, Axe-Core A11y & 10-Cycle Visual Screenshot Refinement Loop
**Files:**
- Create: `tests/e2e/run_e2e.mjs`

- [ ] Run end-to-end flows in headless Chromium inside Docker across Desktop (`1440x900`), Laptop (`1280x800`), Mobile (`390x844`), and Light / Sepia / Dark themes.
- [ ] Capture screenshots of every view, modal, and interactive state.
- [ ] Inspect screenshots via `read_file`, run `axe-core` WCAG audits and DOM overlap/overflow checks, diagnose root causes, and iterate across multiple dedicated revisions until completely clean!

---

### Task 12: Final Delivery
- [ ] Copy final project to `/home/kasa/Depo/agy/apps/tessera`.
- [ ] Update `/home/kasa/Depo/agy/apps_list.txt` with `tessera`.
- [ ] Create public GitHub repository `meucak/tessera` and push `main` + tags.
- [ ] Leave live Docker container running cleanly on port `8092`.
