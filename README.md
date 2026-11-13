# Tessera — Sovereign Spatial Knowledge Studio

Tessera is a self-hosted, local-first knowledge workspace uniting **Bidirectional Markdown Notes**, a **Live Knowledge Graph**, an **Infinite Spatial Canvas**, **Myers Line/Word Version Diffing**, a **Two-Way Task Kanban**, and an **FSRS v4.5 Spaced Repetition Lab** inside a single sub-second Docker container powered by Node.js 22 native SQLite (WAL + FTS5) and zero frontend build bloat.

## Core Architecture

- **Storage Engine (`node:sqlite` + WAL + FTS5):**
  - Single-file SQLite database at `/app/data/tessera.db` running in `WAL` mode with `NORMAL` synchronous durability and foreign-key enforcement.
  - Full-Text Search (`notes_fts`) with weighted `bm25(...)` ranking across note titles, bodies, and tags, plus safe query parsing for `tag:`, `folder:`, `has:tasks`, `has:cards`, exact `"phrase"` matching, and `-negations`.
- **Isomorphic Parsing & Math Engines (`src/core/`):**
  - Shared identically between Node.js server validation and the browser SPA (`/core/*.js`):
    - **Markdown + Wikilink AST (`markdownAst.js`):** Strict XSS-safe rendering with `[[Wikilinks]]`, `[[Slug|Aliases]]`, cycle-guarded `![[Transclusion Embeds]]`, GitHub callouts (`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), inline/multi-line flashcard extraction (`Q :: A`, `??`, `{{cloze}}`), and line-indexed `- [ ]` task extraction.
    - **Myers Diff Engine (`diffEngine.js`):** Line-level shortest edit script + intraline token diffing for time-travel snapshots and 1-click version restoration.
    - **FSRS v4.5 Engine (`fsrsEngine.js`):** Free Spaced Repetition Scheduler calculating Stability, Difficulty, Retrievability decay, interval previews (`Again / Hard / Good / Easy`), 30-day review workload forecasts, and 90-day consistency heatmaps.
    - **Graph Analytics Engine (`graphEngine.js`):** PageRank centrality scoring, connected component clustering, ghost-node detection, orphan discovery, plain-text unlinked mention mining, and BFS shortest-path tracing.
- **Spatial Whiteboard Canvas:**
  - Infinite dot-grid canvas supporting sticky notes, live note embeds, topic group frames, 8pt snap-to-grid positioning, Bézier connection wiring, Grid/Radial auto-arrangement, 30-step Undo/Redo history, interactive minimap, and vector SVG export.
- **Real-Time Multi-Tab WebSocket Sync (`wsHub.js`):**
  - Broadcasts note, graph, task, board, and review mutations over `/ws` with `X-Client-Id` echo suppression.
- **Portable Lossless ZIP & JSON Backups (`zipVault.js`):**
  - Pure Node `zlib` ZIP archive generator/parser with UTF-8 filenames and CRC-32 checksums—zero host CLI or native dependencies.

## Workspaces & Keyboard Shortcuts

| Workspace | Shortcut | Capabilities |
| :--- | :--- | :--- |
| **Studio** | `1` | Split / Write / Read editor, Serif reading toggle, `[[` & `/` autocomplete, Outline, Backlinks, Unlinked Mentions, Ghost Links, Diff History |
| **Knowledge Graph** | `2` | Force-directed HiDPI Canvas, cluster coloring, PageRank sizing, hover neighborhood isolation, Shortest Path A → B finder |
| **Spatial Canvas** | `3` | Multi-board infinite whiteboard, drag & wire cards, Grid/Radial layout, Undo/Redo, SVG diagram export |
| **Recall Lab (FSRS)** | `4` | Active recall deck, `Space` flip & `1–4` ratings, 30-day retention chart, 90-day consistency heatmap, card browser |
| **Tasks & Daily** | `5` | Cross-note task inbox & 3-column Kanban (`To Do` / `In Progress` / `Completed`) with two-way Markdown checkbox sync |

Additional global shortcuts: `Ctrl / Cmd + K` (Command Palette), `N` (New Note), `D` (Open Today's Daily Journal), `T` (Cycle Light / Sepia / Dark themes).

## Running with Docker (Production)

```bash
docker compose up -d --build
```

Tessera starts on **`http://localhost:8092`** and persists vault data in the Docker named volume `tessera_data` (`/app/data`).

Verify container health:

```bash
curl -s http://localhost:8092/api/health
```

## Verification & Testing

Run the isomorphic unit and API integration suites inside Node 22 Alpine:

```bash
docker run --rm -v "$(pwd):/app" -w /app node:22-alpine node --test tests/unit/*.test.js tests/integration/*.test.js
```

Run the isolated Playwright + Chromium + Axe-core E2E suite against a running instance:

```bash
docker build -f Dockerfile.test -t tessera-test .
docker run --rm --network host -e BASE_URL=http://127.0.0.1:8092 -v "$(pwd)/tests/e2e/run_e2e.mjs:/e2e/run_e2e.mjs:ro" tessera-test:latest node /e2e/run_e2e.mjs
```
