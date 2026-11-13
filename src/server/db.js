import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  slugify,
  parseMarkdown,
  extractPlainSnippet,
  toggleTaskLine
} from '../core/markdownAst.js';
import { computeLineDiff, computeWordDiff } from '../core/diffEngine.js';
import {
  createEmptyCard,
  scheduleCard,
  previewIntervals,
  buildRetentionForecast
} from '../core/fsrsEngine.js';
import {
  buildKnowledgeGraph,
  findShortestPath,
  findUnlinkedMentions
} from '../core/graphEngine.js';
import { parseSearchQuery } from '../core/searchQuery.js';
import { buildZipBuffer, parseZipBuffer } from './zipVault.js';

function nowIso() {
  return new Date().toISOString();
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TesseraStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT 'Inbox',
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        word_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        id UNINDEXED,
        title,
        tags,
        folder,
        content
      );

      CREATE TABLE IF NOT EXISTS note_links (
        source_id TEXT NOT NULL,
        target_slug TEXT NOT NULL,
        target_id TEXT,
        alias TEXT,
        PRIMARY KEY (source_id, target_slug),
        FOREIGN KEY (source_id) REFERENCES notes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_note_links_target_slug ON note_links(target_slug);
      CREATE INDEX IF NOT EXISTS idx_note_links_target_id ON note_links(target_id);

      CREATE TABLE IF NOT EXISTS note_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, id DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        line_no INTEGER NOT NULL,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        doing INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'normal',
        due_date TEXT,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS flashcards (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 0,
        stability REAL NOT NULL DEFAULT 0,
        difficulty REAL NOT NULL DEFAULT 0,
        elapsed_days REAL NOT NULL DEFAULT 0,
        scheduled_days REAL NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        due_at TEXT NOT NULL,
        last_review_at TEXT,
        UNIQUE(note_id, block_hash),
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS review_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        state_before INTEGER NOT NULL,
        stability REAL NOT NULL,
        difficulty REAL NOT NULL,
        reviewed_at TEXT NOT NULL,
        FOREIGN KEY (card_id) REFERENCES flashcards(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
        nodes_json TEXT NOT NULL DEFAULT '[]',
        edges_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  _withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  }

  _ensureUniqueSlug(baseSlug, excludeId = null) {
    const base = baseSlug || `note-${Date.now()}`;
    let candidate = base;
    let counter = 2;
    while (true) {
      const row = this.db
        .prepare('SELECT id FROM notes WHERE slug = ?')
        .get(candidate);
      if (!row || row.id === excludeId) return candidate;
      candidate = `${base}-${counter++}`;
    }
  }

  _resolveNoteBySlug(slug) {
    return this.db
      .prepare('SELECT id, slug, title, folder, status, pinned, content, tags_json, word_count, created_at, updated_at FROM notes WHERE slug = ?')
      .get(slug) || null;
  }

  _rowToNoteMeta(row) {
    const tags = JSON.parse(row.tags_json || '[]');
    const parsed = parseMarkdown(row.content);
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      folder: row.folder,
      status: row.status,
      pinned: Boolean(row.pinned),
      tags,
      wordCount: row.word_count,
      snippet: extractPlainSnippet(row.content, 130),
      links: parsed.links,
      taskCount: parsed.tasks.length,
      openTaskCount: parsed.tasks.filter((t) => !t.done).length,
      cardCount: parsed.flashcards.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _rowToFullNote(row) {
    if (!row) return null;
    const tags = JSON.parse(row.tags_json || '[]');
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      folder: row.folder,
      status: row.status,
      pinned: Boolean(row.pinned),
      content: row.content,
      tags,
      wordCount: row.word_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _syncDerivedIndices(noteRow, parsed, options = {}) {
    // 1. Update FTS5
    this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(noteRow.id);
    this.db
      .prepare('INSERT INTO notes_fts (id, title, tags, folder, content) VALUES (?, ?, ?, ?, ?)')
      .run(
        noteRow.id,
        noteRow.title,
        parsed.tags.join(' '),
        noteRow.folder,
        noteRow.content
      );

    // 2. Sync outgoing links
    this.db.prepare('DELETE FROM note_links WHERE source_id = ?').run(noteRow.id);
    const insertLink = this.db.prepare(
      'INSERT OR REPLACE INTO note_links (source_id, target_slug, target_id, alias) VALUES (?, ?, ?, ?)'
    );
    for (const link of parsed.links) {
      const targetRow = this.db.prepare('SELECT id FROM notes WHERE slug = ?').get(link.targetSlug);
      insertLink.run(noteRow.id, link.targetSlug, targetRow ? targetRow.id : null, link.alias || null);
    }

    // 3. Resolve incoming links from other notes pointing to this slug
    this.db
      .prepare('UPDATE note_links SET target_id = ? WHERE target_slug = ?')
      .run(noteRow.id, noteRow.slug);

    // 4. Sync tasks
    this.db.prepare('DELETE FROM tasks WHERE note_id = ?').run(noteRow.id);
    const insertTask = this.db.prepare(
      'INSERT INTO tasks (id, note_id, line_no, text, done, doing, priority, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const t of parsed.tasks) {
      insertTask.run(
        `${noteRow.id}:${t.lineNo}`,
        noteRow.id,
        t.lineNo,
        t.text,
        t.done ? 1 : 0,
        t.doing ? 1 : 0,
        t.priority,
        t.dueDate || null
      );
    }

    // 5. Sync flashcards by (note_id, block_hash) preserving FSRS state
    const existingCards = this.db
      .prepare('SELECT id, block_hash FROM flashcards WHERE note_id = ?')
      .all(noteRow.id);
    const existingByHash = new Map(existingCards.map((c) => [c.block_hash, c.id]));
    const keepHashes = new Set();
    const empty = createEmptyCard();

    const insertCard = this.db.prepare(`
      INSERT INTO flashcards (
        id, note_id, block_hash, kind, front, back,
        state, stability, difficulty, elapsed_days, scheduled_days,
        reps, lapses, due_at, last_review_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateCardContent = this.db.prepare(
      'UPDATE flashcards SET kind = ?, front = ?, back = ? WHERE id = ?'
    );

    for (const fc of parsed.flashcards) {
      keepHashes.add(fc.blockHash);
      const existingId = existingByHash.get(fc.blockHash);
      if (existingId) {
        updateCardContent.run(fc.kind, fc.front, fc.back, existingId);
      } else {
        insertCard.run(
          crypto.randomUUID(),
          noteRow.id,
          fc.blockHash,
          fc.kind,
          fc.front,
          fc.back,
          empty.state,
          empty.stability,
          empty.difficulty,
          empty.elapsedDays,
          empty.scheduledDays,
          empty.reps,
          empty.lapses,
          empty.dueAt,
          empty.lastReviewAt
        );
      }
    }

    for (const old of existingCards) {
      if (!keepHashes.has(old.block_hash)) {
        this.db.prepare('DELETE FROM flashcards WHERE id = ?').run(old.id);
      }
    }

    // 6. Snapshot version if requested or content changed significantly
    const latestVersion = this.db
      .prepare('SELECT id, title, content, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1')
      .get(noteRow.id);

    const contentChanged = !latestVersion || latestVersion.content !== noteRow.content || latestVersion.title !== noteRow.title;
    if (contentChanged && (options.forceSnapshot || !latestVersion || options.snapshotLabel)) {
      this._insertVersion(noteRow.id, noteRow.title, noteRow.content, options.snapshotLabel || '');
    } else if (contentChanged) {
      const ageMs = Date.now() - new Date(latestVersion.created_at).getTime();
      if (ageMs >= 120000 || Math.abs(latestVersion.content.length - noteRow.content.length) >= 40) {
        this._insertVersion(noteRow.id, noteRow.title, noteRow.content, '');
      }
    }
  }

  _insertVersion(noteId, title, content, label) {
    this.db
      .prepare('INSERT INTO note_versions (note_id, title, content, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(noteId, title, content, label, nowIso());
    // Prune older snapshots beyond 60 per note
    this.db
      .prepare(`
        DELETE FROM note_versions
        WHERE note_id = ? AND id NOT IN (
          SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 60
        )
      `)
      .run(noteId, noteId);
  }

  createNote(input) {
    return this._withTransaction(() => {
      const parsed = parseMarkdown(input.content || '');
      const title = (input.title && String(input.title).trim()) || parsed.title || 'Untitled Note';
      const slug = this._ensureUniqueSlug(input.slug ? slugify(input.slug) : slugify(title));
      const folder = (input.folder && String(input.folder).trim()) || parsed.frontmatter.folder || 'Inbox';
      const status = (input.status && String(input.status).trim()) || parsed.frontmatter.status || 'active';
      const pinned = input.pinned ?? Boolean(parsed.frontmatter.pinned) ? 1 : 0;
      const mergedTags = [...new Set([
        ...(Array.isArray(input.tags) ? input.tags : []),
        ...parsed.tags
      ])];
      const ts = input.createdAt || nowIso();
      const updated = input.updatedAt || ts;
      const id = input.id || crypto.randomUUID();
      const content = String(input.content ?? `# ${title}\n\n`);

      this.db
        .prepare(`
          INSERT INTO notes (id, slug, title, folder, status, pinned, content, tags_json, word_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          slug,
          title,
          folder,
          status,
          pinned,
          content,
          JSON.stringify(mergedTags),
          parsed.wordCount,
          ts,
          updated
        );

      const noteRow = {
        id,
        slug,
        title,
        folder,
        status,
        pinned,
        content,
        tags_json: JSON.stringify(mergedTags),
        word_count: parsed.wordCount,
        created_at: ts,
        updated_at: updated
      };

      this._syncDerivedIndices(noteRow, { ...parsed, tags: mergedTags, content }, { forceSnapshot: true, snapshotLabel: input.snapshotLabel || 'Initial version' });
      return this.getNote(id);
    });
  }

  updateNote(id, patch) {
    return this._withTransaction(() => {
      const existing = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
      if (!existing) return null;

      const content = patch.content !== undefined ? String(patch.content) : existing.content;
      const parsed = parseMarkdown(content);
      const title = patch.title !== undefined
        ? (String(patch.title).trim() || parsed.title || existing.title)
        : (parsed.title !== 'Untitled Note' ? parsed.title : existing.title);
      const oldSlug = existing.slug;
      const desiredSlug = slugify(title) || oldSlug;
      const slug = this._ensureUniqueSlug(desiredSlug, id);
      const folder = patch.folder !== undefined ? String(patch.folder).trim() || 'Inbox' : (parsed.frontmatter.folder || existing.folder);
      const status = patch.status !== undefined ? String(patch.status).trim() || 'active' : (parsed.frontmatter.status || existing.status);
      const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned;
      const mergedTags = patch.tags !== undefined
        ? [...new Set([...(Array.isArray(patch.tags) ? patch.tags : []), ...parsed.tags])]
        : parsed.tags;
      const updated = nowIso();

      this.db
        .prepare(`
          UPDATE notes
          SET slug = ?, title = ?, folder = ?, status = ?, pinned = ?, content = ?, tags_json = ?, word_count = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(slug, title, folder, status, pinned, content, JSON.stringify(mergedTags), parsed.wordCount, updated, id);

      // If slug changed, keep incoming link target_slugs updated so graph stays intact
      if (oldSlug !== slug) {
        this.db.prepare('UPDATE note_links SET target_slug = ? WHERE target_slug = ?').run(slug, oldSlug);
      }

      const updatedRow = {
        ...existing,
        slug,
        title,
        folder,
        status,
        pinned,
        content,
        tags_json: JSON.stringify(mergedTags),
        word_count: parsed.wordCount,
        updated_at: updated
      };

      this._syncDerivedIndices(updatedRow, { ...parsed, tags: mergedTags, content }, {
        forceSnapshot: Boolean(patch.forceSnapshot || patch.snapshotLabel),
        snapshotLabel: patch.snapshotLabel || ''
      });
      return this.getNote(id);
    });
  }

  deleteNote(id) {
    return this._withTransaction(() => {
      const existing = this.db.prepare('SELECT id, slug FROM notes WHERE id = ?').get(id);
      if (!existing) return false;
      this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
      this.db.prepare('UPDATE note_links SET target_id = NULL WHERE target_id = ?').run(id);
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      return true;
    });
  }

  getNote(idOrSlug) {
    const row =
      this.db.prepare('SELECT * FROM notes WHERE id = ?').get(idOrSlug) ||
      this.db.prepare('SELECT * FROM notes WHERE slug = ?').get(slugify(idOrSlug));
    if (!row) return null;

    const note = this._rowToFullNote(row);
    const parsed = parseMarkdown(note.content, {
      resolveNote: (slug) => this._resolveNoteBySlug(slug)
    });

    const backlinkRows = this.db
      .prepare(`
        SELECT n.id, n.slug, n.title, n.folder, n.content, nl.alias
        FROM note_links nl
        JOIN notes n ON n.id = nl.source_id
        WHERE nl.target_id = ? OR nl.target_slug = ?
      `)
      .all(row.id, row.slug);

    const backlinks = backlinkRows.map((b) => ({
      id: b.id,
      slug: b.slug,
      title: b.title,
      folder: b.folder,
      alias: b.alias,
      snippet: extractPlainSnippet(b.content, 110)
    }));

    const allNotesForMentions = this.db
      .prepare('SELECT id, slug, title, content FROM notes WHERE id != ?')
      .all(row.id)
      .map((n) => ({
        ...n,
        links: parseMarkdown(n.content).links
      }));

    const unlinkedMentions = findUnlinkedMentions(note, allNotesForMentions);
    const versionCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM note_versions WHERE note_id = ?')
      .get(row.id).cnt;

    const ghostLinks = parsed.links
      .filter((l) => !this._resolveNoteBySlug(l.targetSlug))
      .map((l) => ({ targetRaw: l.targetRaw, targetSlug: l.targetSlug }));

    return {
      note,
      parsed,
      backlinks,
      unlinkedMentions,
      ghostLinks,
      versionCount
    };
  }

  listNotes(queryOpts = {}) {
    const rawQ = String(queryOpts.q || '').trim();
    const { ftsMatch, filters } = parseSearchQuery(rawQ);
    const folderFilter = queryOpts.folder ? String(queryOpts.folder).trim() : null;
    const tagFilter = queryOpts.tag ? String(queryOpts.tag).trim().replace(/^#/, '') : null;
    const filterMode = queryOpts.filter || null;

    let rows;
    if (ftsMatch) {
      try {
        rows = this.db
          .prepare(`
            SELECT n.*, bm25(notes_fts, 5.0, 3.0, 1.5, 1.0) AS rank,
                   snippet(notes_fts, 4, '<mark>', '</mark>', '…', 20) AS fts_snippet
            FROM notes_fts
            JOIN notes n ON n.id = notes_fts.id
            WHERE notes_fts MATCH ?
            ORDER BY rank ASC, n.pinned DESC, n.updated_at DESC
          `)
          .all(ftsMatch);
      } catch {
        // Safe fallback to LIKE scan if FTS5 rejects an exotic query
        const likeTerm = `%${rawQ.replace(/[%_]/g, '')}%`;
        rows = this.db
          .prepare('SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY pinned DESC, updated_at DESC')
          .all(likeTerm, likeTerm);
      }
    } else {
      rows = this.db
        .prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC')
        .all();
    }

    let items = rows.map((row) => {
      const meta = this._rowToNoteMeta(row);
      if (row.fts_snippet) meta.ftsSnippet = row.fts_snippet;
      return meta;
    });

    if (folderFilter) {
      items = items.filter((n) => n.folder.toLowerCase() === folderFilter.toLowerCase());
    }
    if (tagFilter) {
      items = items.filter((n) => n.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase()));
    }
    for (const f of filters.folders) {
      items = items.filter((n) => n.folder.toLowerCase().includes(f.toLowerCase()));
    }
    for (const t of filters.tags) {
      items = items.filter((n) => n.tags.some((nt) => nt.toLowerCase().includes(t.toLowerCase())));
    }
    if (filters.status) {
      items = items.filter((n) => n.status.toLowerCase() === filters.status);
    }
    if (filters.hasTasks) {
      items = items.filter((n) => n.taskCount > 0);
    }
    if (filters.hasCards) {
      items = items.filter((n) => n.cardCount > 0);
    }
    if (filterMode === 'pinned') {
      items = items.filter((n) => n.pinned);
    } else if (filterMode === 'orphans') {
      const graph = this.getGraph(false);
      const orphanSet = new Set(graph.orphans.map((o) => o.id));
      items = items.filter((n) => orphanSet.has(n.id));
    }

    // Collect global taxonomy counts
    const allRows = this.db.prepare('SELECT folder, tags_json FROM notes').all();
    const folders = {};
    const tags = {};
    for (const r of allRows) {
      folders[r.folder] = (folders[r.folder] || 0) + 1;
      for (const t of JSON.parse(r.tags_json || '[]')) {
        tags[t] = (tags[t] || 0) + 1;
      }
    }

    return { notes: items, folders, tags, totalCount: allRows.length };
  }

  getOrCreateDailyNote(dateStr = null) {
    const day = dateStr || new Date().toISOString().slice(0, 10);
    const title = `Daily Journal — ${day}`;
    const slug = slugify(title);
    const existing = this.getNote(slug);
    if (existing) return { created: false, ...existing };

    const content = `---
title: ${title}
folder: Daily
tags: [daily, journal]
status: active
---

# ${title}

## Focus & Intent
- [ ] Review due [[FSRS v4.5 Memory Model|Recall Deck]] cards !high @${day}
- [ ] Capture key engineering insights and link to hub notes

## Log & Observations
- 

## Evening Synthesis
- What clicked today?
- What needs deeper review tomorrow?
`;
    const created = this.createNote({ title, folder: 'Daily', content });
    return { created: true, ...created };
  }

  linkUnlinkedMention(targetId, sourceId) {
    const targetRow = this.db.prepare('SELECT id, title, slug FROM notes WHERE id = ?').get(targetId);
    const sourceRow = this.db.prepare('SELECT id, title, content, folder FROM notes WHERE id = ?').get(sourceId);
    if (!targetRow || !sourceRow) return null;

    const re = new RegExp(`(?<!\\[\\[)\\b(${escapeRegex(targetRow.title)})\\b(?![^\\[]*\\]\\])`, 'i');
    if (!re.test(sourceRow.content)) {
      return { linked: false, note: this._rowToFullNote(sourceRow) };
    }
    const updatedContent = sourceRow.content.replace(re, `[[${targetRow.title}]]`);
    const result = this.updateNote(sourceId, {
      content: updatedContent,
      snapshotLabel: `Linked mention -> ${targetRow.title}`
    });
    return { linked: true, ...result };
  }

  getVersions(noteId) {
    const rows = this.db
      .prepare('SELECT id, note_id, title, label, length(content) AS size, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC')
      .all(noteId);
    return rows.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      title: r.title,
      label: r.label,
      size: r.size,
      createdAt: r.created_at
    }));
  }

  getVersionDiff(noteId, fromParam, toParam = 'current') {
    const noteRow = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!noteRow) return null;

    const fromRow = this.db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
      .get(Number(fromParam), noteId);
    if (!fromRow) return null;

    let toContent = noteRow.content;
    let toTitle = noteRow.title;
    let toLabel = 'Current';

    if (toParam && toParam !== 'current') {
      const toRow = this.db
        .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
        .get(Number(toParam), noteId);
      if (!toRow) return null;
      toContent = toRow.content;
      toTitle = toRow.title;
      toLabel = toRow.label || `Snapshot #${toRow.id}`;
    }

    const diff = computeLineDiff(fromRow.content, toContent);
    // Attach intra-line word diffs for paired delete+add hunks
    const enriched = diff.hunks.map((h) => ({ ...h }));
    for (let i = 0; i < enriched.length - 1; i++) {
      if (enriched[i].type === 'delete' && enriched[i + 1].type === 'add') {
        const wordParts = computeWordDiff(enriched[i].text, enriched[i + 1].text);
        enriched[i].wordDiff = wordParts.filter((p) => p.type !== 'add');
        enriched[i + 1].wordDiff = wordParts.filter((p) => p.type !== 'del');
        i++;
      }
    }

    return {
      from: { id: fromRow.id, title: fromRow.title, label: fromRow.label || `Snapshot #${fromRow.id}`, createdAt: fromRow.created_at },
      to: { id: toParam, title: toTitle, label: toLabel },
      diff: { hunks: enriched, stats: diff.stats }
    };
  }

  restoreVersion(noteId, versionId) {
    const ver = this.db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
      .get(Number(versionId), noteId);
    if (!ver) return null;

    return this.updateNote(noteId, {
      title: ver.title,
      content: ver.content,
      forceSnapshot: true,
      snapshotLabel: `Restored from #${ver.id}`
    });
  }

  getGraph(includeGhosts = true) {
    const rows = this.db.prepare('SELECT id, slug, title, folder, tags_json, word_count, content FROM notes').all();
    const notes = rows.map((r) => {
      const parsed = parseMarkdown(r.content);
      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        folder: r.folder,
        tags: JSON.parse(r.tags_json || '[]'),
        wordCount: r.word_count,
        links: parsed.links,
        content: r.content
      };
    });
    return buildKnowledgeGraph(notes, { includeGhosts });
  }

  getGraphPath(sourceId, targetId) {
    const graph = this.getGraph(false);
    return findShortestPath(graph, sourceId, targetId);
  }

  listTasks() {
    const rows = this.db
      .prepare(`
        SELECT t.*, n.title AS note_title, n.slug AS note_slug, n.folder AS note_folder
        FROM tasks t
        JOIN notes n ON n.id = t.note_id
        ORDER BY t.done ASC,
                 CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                 t.due_date ASC NULLS LAST
      `)
      .all();
    const tasks = rows.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      noteTitle: r.note_title,
      noteSlug: r.note_slug,
      noteFolder: r.note_folder,
      lineNo: r.line_no,
      text: r.text,
      done: Boolean(r.done),
      doing: Boolean(r.doing),
      priority: r.priority,
      dueDate: r.due_date
    }));
    return {
      tasks,
      counts: {
        total: tasks.length,
        todo: tasks.filter((t) => !t.done && !t.doing).length,
        doing: tasks.filter((t) => !t.done && t.doing).length,
        done: tasks.filter((t) => t.done).length
      }
    };
  }

  toggleTask(noteId, lineNo, done) {
    const row = this.db.prepare('SELECT id, content FROM notes WHERE id = ?').get(noteId);
    if (!row) return null;
    const res = toggleTaskLine(row.content, Number(lineNo), Boolean(done));
    if (!res.changed) {
      return { changed: false, ...this.getNote(noteId) };
    }
    const updated = this.updateNote(noteId, { content: res.updated });
    return { changed: true, ...updated };
  }

  listFlashcards(now = new Date()) {
    const rows = this.db
      .prepare(`
        SELECT f.*, n.title AS note_title, n.slug AS note_slug, n.folder AS note_folder
        FROM flashcards f
        JOIN notes n ON n.id = f.note_id
        ORDER BY f.due_at ASC
      `)
      .all();

    const nowMs = now.getTime();
    const cards = rows.map((r) => {
      const cardObj = {
        id: r.id,
        noteId: r.note_id,
        noteTitle: r.note_title,
        noteSlug: r.note_slug,
        noteFolder: r.note_folder,
        blockHash: r.block_hash,
        kind: r.kind,
        front: r.front,
        back: r.back,
        state: r.state,
        stability: r.stability,
        difficulty: r.difficulty,
        elapsedDays: r.elapsed_days,
        scheduledDays: r.scheduled_days,
        reps: r.reps,
        lapses: r.lapses,
        dueAt: r.due_at,
        lastReviewAt: r.last_review_at
      };
      cardObj.isDue = new Date(r.due_at).getTime() <= nowMs;
      cardObj.preview = previewIntervals(cardObj, now);
      return cardObj;
    });

    const forecast = buildRetentionForecast(cards, 30, now);

    // 90-day heatmap counts
    const cutoff = new Date(nowMs - 90 * 86400000).toISOString();
    const logs = this.db
      .prepare('SELECT substr(reviewed_at, 1, 10) AS day, COUNT(*) AS count, SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS passed FROM review_logs WHERE reviewed_at >= ? GROUP BY day ORDER BY day ASC')
      .all(cutoff);

    const totalLogs = logs.reduce((acc, l) => acc + l.count, 0);
    const totalPassed = logs.reduce((acc, l) => acc + l.passed, 0);

    return {
      cards,
      dueCards: cards.filter((c) => c.isDue),
      stats: {
        total: cards.length,
        due: cards.filter((c) => c.isDue).length,
        mastered: cards.filter((c) => c.state === 2 && c.stability >= 14).length,
        retentionRate: totalLogs > 0 ? Math.round((totalPassed / totalLogs) * 100) : 100,
        avgStability: cards.length > 0
          ? Number((cards.reduce((a, c) => a + c.stability, 0) / cards.length).toFixed(1))
          : 0
      },
      forecast,
      heatmap: logs
    };
  }

  reviewFlashcard(cardId, rating, now = new Date()) {
    return this._withTransaction(() => {
      const row = this.db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId);
      if (!row) return null;

      const cardInput = {
        state: row.state,
        stability: row.stability,
        difficulty: row.difficulty,
        elapsedDays: row.elapsed_days,
        scheduledDays: row.scheduled_days,
        reps: row.reps,
        lapses: row.lapses,
        dueAt: row.due_at,
        lastReviewAt: row.last_review_at
      };

      const res = scheduleCard(cardInput, Number(rating), now);
      this.db
        .prepare(`
          UPDATE flashcards
          SET state = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?,
              reps = ?, lapses = ?, due_at = ?, last_review_at = ?
          WHERE id = ?
        `)
        .run(
          res.card.state,
          res.card.stability,
          res.card.difficulty,
          res.card.elapsedDays,
          res.card.scheduledDays,
          res.card.reps,
          res.card.lapses,
          res.card.dueAt,
          res.card.lastReviewAt,
          cardId
        );

      this.db
        .prepare('INSERT INTO review_logs (card_id, rating, state_before, stability, difficulty, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cardId, res.log.rating, res.log.stateBefore, res.log.stability, res.log.difficulty, res.log.reviewedAt);

      return {
        card: { ...row, ...res.card, id: cardId },
        intervalDays: res.intervalDays,
        label: res.label
      };
    });
  }

  listBoards() {
    const rows = this.db.prepare('SELECT * FROM boards ORDER BY updated_at DESC').all();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      viewport: JSON.parse(r.viewport_json || '{"x":0,"y":0,"zoom":1}'),
      nodes: JSON.parse(r.nodes_json || '[]'),
      edges: JSON.parse(r.edges_json || '[]'),
      updatedAt: r.updated_at
    }));
  }

  getBoard(id) {
    const r = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      viewport: JSON.parse(r.viewport_json || '{"x":0,"y":0,"zoom":1}'),
      nodes: JSON.parse(r.nodes_json || '[]'),
      edges: JSON.parse(r.edges_json || '[]'),
      updatedAt: r.updated_at
    };
  }

  createBoard(input) {
    const id = input.id || crypto.randomUUID();
    const title = (input.title && String(input.title).trim()) || 'Untitled Spatial Board';
    const description = String(input.description || '');
    const viewport = input.viewport || { x: 0, y: 0, zoom: 1 };
    const nodes = Array.isArray(input.nodes) ? input.nodes : [];
    const edges = Array.isArray(input.edges) ? input.edges : [];
    const ts = nowIso();
    this.db
      .prepare('INSERT INTO boards (id, title, description, viewport_json, nodes_json, edges_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, description, JSON.stringify(viewport), JSON.stringify(nodes), JSON.stringify(edges), ts);
    return this.getBoard(id);
  }

  saveBoard(id, input) {
    const existing = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
    if (!existing) return null;
    const title = input.title !== undefined ? (String(input.title).trim() || existing.title) : existing.title;
    const description = input.description !== undefined ? String(input.description) : existing.description;
    const viewport = input.viewport !== undefined ? input.viewport : JSON.parse(existing.viewport_json);
    const nodes = input.nodes !== undefined ? input.nodes : JSON.parse(existing.nodes_json);
    const edges = input.edges !== undefined ? input.edges : JSON.parse(existing.edges_json);
    const ts = nowIso();
    this.db
      .prepare('UPDATE boards SET title = ?, description = ?, viewport_json = ?, nodes_json = ?, edges_json = ?, updated_at = ? WHERE id = ?')
      .run(title, description, JSON.stringify(viewport), JSON.stringify(nodes), JSON.stringify(edges), ts, id);
    return this.getBoard(id);
  }

  deleteBoard(id) {
    const res = this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    return res.changes > 0;
  }

  exportBundle(format = 'json') {
    const notes = this.db.prepare('SELECT * FROM notes ORDER BY folder, title').all().map((r) => this._rowToFullNote(r));
    const boards = this.listBoards();
    const flashcards = this.db.prepare('SELECT * FROM flashcards').all();
    const bundle = {
      format: 'tessera-vault-v1',
      exportedAt: nowIso(),
      notes,
      boards,
      flashcards
    };

    if (format === 'zip') {
      const entries = [];
      for (const n of notes) {
        const safeFolder = (n.folder || 'Inbox').replace(/[^a-zA-Z0-9_-]/g, '_');
        entries.push({
          name: `notes/${safeFolder}/${n.slug}.md`,
          data: n.content
        });
      }
      entries.push({
        name: '.tessera/boards.json',
        data: JSON.stringify(boards, null, 2)
      });
      entries.push({
        name: '.tessera/vault.json',
        data: JSON.stringify(bundle, null, 2)
      });
      return buildZipBuffer(entries);
    }

    return bundle;
  }

  importBundle(payload) {
    let notesToImport = [];
    let boardsToImport = [];

    if (payload && payload.zipBase64) {
      const buf = Buffer.from(payload.zipBase64, 'base64');
      const entries = parseZipBuffer(buf);
      const vaultJson = entries.find((e) => e.name === '.tessera/vault.json');
      if (vaultJson) {
        const parsed = JSON.parse(vaultJson.data.toString('utf8'));
        notesToImport = parsed.notes || [];
        boardsToImport = parsed.boards || [];
      } else {
        for (const e of entries) {
          if (e.name.endsWith('.md')) {
            const baseName = path.basename(e.name, '.md');
            const folder = path.dirname(e.name).split('/').pop() || 'Imported';
            notesToImport.push({
              title: baseName,
              folder: folder === '.' ? 'Imported' : folder,
              content: e.data.toString('utf8')
            });
          }
        }
      }
    } else if (payload && Array.isArray(payload.notes)) {
      notesToImport = payload.notes;
      boardsToImport = Array.isArray(payload.boards) ? payload.boards : [];
    } else if (payload && Array.isArray(payload.files)) {
      for (const f of payload.files) {
        notesToImport.push({
          title: f.title || path.basename(String(f.name || 'Imported'), '.md'),
          folder: f.folder || 'Imported',
          content: String(f.content || '')
        });
      }
    }

    let importedNotes = 0;
    let importedBoards = 0;

    for (const n of notesToImport) {
      if (!n.content && !n.title) continue;
      this.createNote({
        title: n.title,
        folder: n.folder || 'Imported',
        status: n.status || 'active',
        pinned: Boolean(n.pinned),
        tags: n.tags || [],
        content: n.content || `# ${n.title}\n`
      });
      importedNotes++;
    }

    for (const b of boardsToImport) {
      if (!b.title) continue;
      this.createBoard({
        title: `${b.title} (Imported)`,
        description: b.description || '',
        viewport: b.viewport || { x: 0, y: 0, zoom: 1 },
        nodes: b.nodes || [],
        edges: b.edges || []
      });
      importedBoards++;
    }

    return { importedNotes, importedBoards };
  }

  getStats() {
    const notes = this.db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
    const boards = this.db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
    const cards = this.db.prepare('SELECT COUNT(*) AS c FROM flashcards').get().c;
    const tasks = this.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
    return { notes, boards, cards, tasks };
  }
}
