# Tessera — Sovereign Spatial Knowledge Studio & Recall Engine

**Date:** 2026-11-14  
**Workspace:** `/home/kasa/apps/tessera`  
**Port:** `8092` (Docker isolated on `node:22-alpine`)  
**Repository:** `https://github.com/meucak/tessera`  

---

## 1. Vision & Scope

**Tessera** is a self-hosted, zero-cloud, multi-modal personal knowledge studio running in a lightweight Docker container on Kasa (`:8092`). It fuses five tightly integrated workspaces over a single SQLite (WAL + FTS5) truth store with real-time WebSocket synchronization:

1. **Studio (Bidirectional Markdown Editor & Live Inspector):** Split/Write/Read Markdown workspace with YAML frontmatter, GFM tables, alerts/callouts (`> [!NOTE]`/`TIP`/`WARNING`/`IMPORTANT`/`CAUTION`), syntax-highlighted code blocks, inline math blocks, interactive checklists, live `[[wikilink]]` autocomplete, `/slash` command palette, embedded `![[note]]` transclusions (cycle-safe), Document Outline, Backlinks, Unlinked Mention detection with 1-click linking, and Ghost Link quick-create.
2. **Knowledge Graph (Analytics & Physics Explorer):** HiDPI HTML5 Canvas force-directed graph powered by PageRank centrality, connected component clustering, degree metrics, ghost-link visibility, live search filtering, physics tuning, and **BFS Shortest Path Finder (`A -> B`)**.
3. **Spatial Canvas (Infinite Whiteboard & Architecture Boards):** Multiple persistent boards supporting pan/zoom (`0.2x`–`2.5x`), Note Embed cards (with live rendered excerpts), Sticky Note cards (semantic terracotta/sage/amber/cobalt/neutral), Group Frames, interactive drag-to-wire Bézier connectors with labels and dashed/solid edge styles, 8pt snap-to-grid, auto-arrange (Grid / Radial / Flow), Undo/Redo stack, minimap, and SVG export.
4. **Recall Lab (FSRS v4.5 Spaced Repetition):** Extracts `Q::A`, multi-line `??`, and `{{cloze}}` flashcards directly from Markdown notes (keyed by deterministic `block_hash` so note edits preserve scheduling history). Runs real FSRS v4.5 state transitions (`New`, `Learning`, `Review`, `Relearning`), displays exact next-interval previews for `Again` / `Hard` / `Good` / `Easy`, renders SVG 30-day Retrievability & Workload Forecast charts and a 90-day Review Heatmap, plus a filterable Card Browser.
5. **Tasks & Daily Journal (Cross-Note Execution):** Aggregates `- [ ]` / `- [x]` checkboxes across all notes into Inbox and Kanban views (`Todo`, `Doing` via `#doing`, `Done`), supports two-way toggling directly mutating the exact Markdown source line, and generates structured Daily Journal notes in 1 click.

Additionally:
- **Time-Travel Version Diff Engine:** Myers `O((N+M)D)` line diff + intra-line word highlights across persistent note snapshots (`note_versions`), with Side-by-Side and Unified views and 1-click non-destructive Restore.
- **Universal Command Palette (`Ctrl/Cmd+K`):** BM25 FTS5 full-text search with structured query operators (`tag:`, `folder:`, `status:`, `has:tasks`, `has:cards`, `"phrase"`, `-exclude`) plus instant navigation and actions.
- **Lossless Vault Export/Import:** Pure Node.js `zlib` ZIP archive exporter (Markdown files + YAML frontmatter + `.tessera/boards.json` + `.tessera/fsrs.json`) and JSON bundle import/export.

---

## 2. Design Constitution (Apple HIG & Anti-Slop)

- **Zero AI Slop:** No generic purple/indigo radial `blur-3xl` dark themes, no `Inter` font dependency, no hollow slogan cards.
- **Three Calibrated Themes (WCAG AA/AAA Contrast):**
  - **Alabaster Daylight (Default):** Limestone `#F7F6F2` canvas, `#FFFFFF` paper cards, `#181816` deep ink, terracotta `#C2410C` primary accent, forest `#15803D` and slate-blue `#1D4ED8` semantic tokens.
  - **Warm Sepia Focus:** Archival parchment `#F4ECD8` / `#FAF4E6`, `#2B2118` espresso ink, `#9A3412` copper accent.
  - **Obsidian Studio (Dark):** Graphite `#111214` canvas, `#191B1F` surface, `#F2EFE9` bone ink, warm amber-terracotta `#EA580C` / `#F59E0B`.
- **Typography:** System SF Pro / humanist sans for chrome, clean editorial serif toggle for long-form reading mode, system monospace (`JetBrains Mono` / `SF Mono` / `ui-monospace`) with `tabular-nums` for metrics, timestamps, and diffs.
- **Spatial & Touch Discipline:** 8pt spatial grid (`4, 8, 16, 24, 32px`), minimum `44x44px` interactive touch targets, responsive desktop (3-pane) -> laptop -> mobile (`390x844`) bottom-rail + drawer layout with zero horizontal overflow, full `prefers-reduced-motion` support, semantic status never conveyed by color alone (always icon + text + contrast).

---

## 3. Data Model (SQLite WAL + FTS5 via `node:sqlite`)

- `notes`: `id TEXT PK, slug TEXT UNIQUE, title TEXT, folder TEXT, status TEXT, pinned INTEGER, content TEXT, tags_json TEXT, word_count INTEGER, created_at TEXT, updated_at TEXT`
- `notes_fts`: `VIRTUAL TABLE USING fts5(id UNINDEXED, title, tags, folder, content)`
- `note_links`: `source_id TEXT, target_slug TEXT, target_id TEXT NULL, context TEXT, PRIMARY KEY (source_id, target_slug)`
- `note_versions`: `id INTEGER PK AUTOINCREMENT, note_id TEXT, title TEXT, content TEXT, label TEXT, created_at TEXT`
- `tasks`: `id TEXT PK, note_id TEXT, line_no INTEGER, text TEXT, done INTEGER, doing INTEGER, priority TEXT, due_date TEXT`
- `flashcards`: `id TEXT PK, note_id TEXT, block_hash TEXT UNIQUE, kind TEXT, front TEXT, back TEXT, state INTEGER, stability REAL, difficulty REAL, reps INTEGER, lapses INTEGER, elapsed_days REAL, scheduled_days REAL, due_at TEXT, last_review_at TEXT`
- `review_logs`: `id INTEGER PK AUTOINCREMENT, card_id TEXT, rating INTEGER, state_before INTEGER, stability REAL, difficulty REAL, reviewed_at TEXT`
- `boards`: `id TEXT PK, title TEXT, description TEXT, viewport_json TEXT, nodes_json TEXT, edges_json TEXT, updated_at TEXT`

---

## 4. Security & Reliability Guardrails

- Strict HTML escaping & URL scheme whitelist (`http:`, `https:`, `mailto:`, `#`, `/`) in Markdown AST renderer — zero raw `<script>` / `onerror=` / `javascript:` execution.
- SQLite `busy_timeout = 5000`, `journal_mode = WAL`, `foreign_keys = ON`, transactional writes, bounded JSON payload limits (`5MB` for notes/boards, `25MB` for vault import).
- Single-port Docker container (`8092`), memory cap `256m`, CPU cap `0.75`, `/api/health` readiness probe, clean graceful shutdown closing WS + SQLite handles.

---

## 5. Multi-Revision Quality & Visual Inspection Plan

We will build systematically using TDD (`node:test`), then run **multiple formal revisions** against the live Docker container, inspecting real Playwright Chromium screenshots (`1440x900`, `1280x800`, `390x844` across Light/Sepia/Dark themes and all 5 workspaces + modals), running `axe-core` WCAG accessibility checks and layout overlap checks, diagnosing every visual or functional flaw via systematic root-cause debugging, and iterating until all checks and visual audits pass cleanly.
