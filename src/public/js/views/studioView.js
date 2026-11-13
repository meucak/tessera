/**
 * Tessera Studio View:
 *  - Left sidebar: Search, filter pills (All/Pinned/Recent), folder & tag facets, note list
 *  - Center workspace: Title bar, pinned toggle, Split/Write/Read mode switch, Serif reading toggle,
 *    Diff modal trigger, formatting toolbar, editor with [[wikilink]] & /slash autocomplete,
 *    live HTML preview with clickable links, tags, embeds, copyable code, two-way task checkboxes
 *  - Right inspector: Outline, Properties (folder/status/metrics), Backlinks,
 *    Unlinked Mentions (1-click auto-link), Ghost Links (1-click create)
 */

import {
  escapeHtml,
  parseFrontmatter,
  parseMarkdown,
  slugify,
  toggleTaskLine
} from '/core/markdownAst.js';
import { api } from '../apiClient.js';
import { openModal, showToast } from '../components/toast.js';

const SLASH_COMMANDS = [
  {
    id: 'h2',
    label: 'Heading 2',
    hint: '## Section',
    snippet: '## '
  },
  {
    id: 'flashcard',
    label: 'Flashcard (Q ?? A)',
    hint: 'FSRS card block',
    snippet: 'What is the core invariant?\n??\nExplain the invariant concisely.\n'
  },
  {
    id: 'cloze',
    label: 'Cloze Deletion',
    hint: '{{hidden}}',
    snippet: 'Key principle: {{the answer inside braces}} enables active recall.'
  },
  {
    id: 'callout-tip',
    label: 'Callout: Tip',
    hint: '> [!TIP]',
    snippet: '> [!TIP] Key Takeaway\n> Concise insight here.\n'
  },
  {
    id: 'callout-important',
    label: 'Callout: Important',
    hint: '> [!IMPORTANT]',
    snippet: '> [!IMPORTANT] Design Constraint\n> State non-negotiable invariant.\n'
  },
  {
    id: 'callout-warning',
    label: 'Callout: Warning',
    hint: '> [!WARNING]',
    snippet: '> [!WARNING] Watch Out\n> Edge case or pitfall.\n'
  },
  {
    id: 'task-list',
    label: 'Task Checklist',
    hint: '- [ ] item',
    snippet: '- [ ] First actionable step !high @2026-11-20\n- [ ] Follow-up check #doing\n'
  },
  {
    id: 'code-js',
    label: 'Code Block (JS)',
    hint: '```js',
    snippet: '```js\nfunction example(input) {\n  return input;\n}\n```\n'
  },
  {
    id: 'table',
    label: 'Comparison Table',
    hint: '| A | B |',
    snippet: '| Dimension | Option A | Option B |\n| :--- | :--- | :--- |\n| Latency | Low | Medium |\n| Complexity | Simple | Rich |\n'
  },
  {
    id: 'embed',
    label: 'Embed Note',
    hint: '![[Note]]',
    snippet: '![['
  }
];

function formatRelativeDate(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

/**
 * Update or insert simple frontmatter keys cleanly while preserving markdown body.
 */
function updateFrontmatterKey(content, key, value) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  const { hasFrontmatter, bodyLines } = parseFrontmatter(normalized);
  if (!hasFrontmatter) {
    return `---\n${key}: ${value}\n---\n\n${normalized}`;
  }
  const lines = normalized.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return `---\n${key}: ${value}\n---\n\n${normalized}`;
  }
  const fmLines = lines.slice(1, closeIdx);
  const keyPrefix = `${key}:`;
  const existingIdx = fmLines.findIndex((l) => l.trim().startsWith(keyPrefix));
  if (existingIdx !== -1) {
    fmLines[existingIdx] = `${key}: ${value}`;
  } else {
    fmLines.push(`${key}: ${value}`);
  }
  return ['---', ...fmLines, '---', ...bodyLines].join('\n');
}

export function mountStudioView(ctx) {
  const { container, state, actions } = ctx;
  const savedMode = localStorage.getItem('tessera.editorMode') || 'split';
  const savedSerif = localStorage.getItem('tessera.serifPreview') === '1';

  let filterState = {
    q: '',
    filter: 'all',
    folder: '',
    tag: ''
  };
  let listData = { notes: state.notes || [], folders: {}, tags: {}, totalCount: (state.notes || []).length };
  let activeDetail = null;
  let dirty = false;
  let saving = false;
  let saveTimer = null;
  let inspectorCollapsed = localStorage.getItem('tessera.inspectorCollapsed') === '1';
  let destroyed = false;

  // Autocomplete state
  let acState = {
    open: false,
    kind: null, // 'wikilink' | 'slash'
    startIdx: 0,
    endIdx: 0,
    items: [],
    selectedIndex: 0
  };

  container.innerHTML = `
    <div id="studio-shell" class="studio-shell${inspectorCollapsed ? ' is-inspector-collapsed' : ''}">
      <aside id="studio-sidebar" class="studio-sidebar${state.isMobileSidebarOpen ? ' is-mobile-open' : ''}" aria-label="Vault Notes">
        <div class="sidebar-header">
          <input
            type="search"
            id="studio-search-input"
            class="sidebar-search-input"
            placeholder="Search notes, tags, titles…"
            aria-label="Filter vault notes"
          >
          <div class="filter-pills" role="group" aria-label="Note filters">
            <button type="button" class="filter-pill is-active" data-filter="all">All</button>
            <button type="button" class="filter-pill" data-filter="pinned">Pinned</button>
            <button type="button" class="filter-pill" data-filter="recent">Recent</button>
          </div>
        </div>
        <div id="sidebar-taxonomy" class="sidebar-taxonomy"></div>
        <div id="studio-note-list" class="note-list" role="listbox" aria-label="Notes"></div>
      </aside>

      <section class="studio-main" aria-label="Note Editor and Preview">
        <header class="studio-topbar">
          <div class="note-title-wrap">
            <input
              type="text"
              id="note-title-input"
              class="note-title-input"
              aria-label="Note title"
              placeholder="Select or create a note…"
            >
            <button type="button" id="btn-toggle-pin" class="icon-btn" title="Pin note to top" aria-label="Pin note" aria-pressed="false">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
            </button>
          </div>

          <div class="studio-controls">
            <div class="segmented-control" role="group" aria-label="Editor View Mode">
              <button type="button" class="seg-btn${savedMode === 'split' ? ' is-active' : ''}" data-mode="split">Split</button>
              <button type="button" class="seg-btn${savedMode === 'write' ? ' is-active' : ''}" data-mode="write">Write</button>
              <button type="button" class="seg-btn${savedMode === 'read' ? ' is-active' : ''}" data-mode="read">Read</button>
            </div>
            <button type="button" id="btn-toggle-serif" class="btn-secondary btn-sm" aria-pressed="${savedSerif ? 'true' : 'false'}" title="Toggle Serif Reading Typography">Serif</button>
            <button type="button" id="btn-note-history" class="btn-secondary btn-sm" title="Compare Version History">History</button>
            <button type="button" id="btn-toggle-inspector" class="btn-secondary btn-sm" aria-expanded="${!inspectorCollapsed}" title="Toggle Right Inspector">Inspector</button>
            <button type="button" id="btn-delete-note" class="icon-btn" title="Delete Note" aria-label="Delete Note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </header>

        <div class="editor-toolbar">
          <div class="toolbar-group" role="toolbar" aria-label="Markdown Formatting">
            <button type="button" class="tool-btn" data-fmt="h2" title="Heading 2">H2</button>
            <button type="button" class="tool-btn" data-fmt="bold" title="Bold"><strong>B</strong></button>
            <button type="button" class="tool-btn" data-fmt="italic" title="Italic"><em>I</em></button>
            <button type="button" class="tool-btn" data-fmt="link" title="Insert Wikilink [[...]]">[[Link]]</button>
            <button type="button" class="tool-btn" data-fmt="task" title="Insert Checklist Task">Task</button>
            <button type="button" class="tool-btn" data-fmt="card" title="Insert Flashcard Block">Card</button>
            <button type="button" class="tool-btn" data-fmt="callout" title="Insert Tip Callout">Callout</button>
            <button type="button" class="tool-btn" data-fmt="code" title="Insert Code Fence">Code</button>
            <button type="button" class="tool-btn" data-fmt="slash" title="Insert Block Menu (/)">/ Block</button>
          </div>
          <div class="editor-status-line">
            <span id="studio-save-status">Ready</span>
            <span id="studio-word-stats" class="tabular">0 words</span>
          </div>
        </div>

        <div id="editor-split-area" class="editor-split-area" data-mode="${savedMode}">
          <div class="editor-pane">
            <textarea
              id="markdown-editor"
              class="markdown-textarea"
              aria-label="Markdown note content"
              placeholder="Write in Markdown… Type [[ to link notes or / for structured blocks."
              spellcheck="false"
            ></textarea>
            <div id="editor-autocomplete" class="editor-autocomplete" role="listbox" aria-label="Suggestions" hidden></div>
          </div>
          <div id="preview-pane" class="preview-pane${savedSerif ? ' is-serif' : ''}">
            <article id="markdown-preview" class="markdown-prose"></article>
          </div>
        </div>
      </section>

      <aside id="studio-inspector" class="studio-inspector" aria-label="Note Context and Graph Inspector">
        <div id="inspector-content"></div>
      </aside>
    </div>
  `;

  const shellEl = container.querySelector('#studio-shell');
  const sidebarEl = container.querySelector('#studio-sidebar');
  const searchInput = container.querySelector('#studio-search-input');
  const taxonomyEl = container.querySelector('#sidebar-taxonomy');
  const noteListEl = container.querySelector('#studio-note-list');
  const titleInput = container.querySelector('#note-title-input');
  const pinBtn = container.querySelector('#btn-toggle-pin');
  const serifBtn = container.querySelector('#btn-toggle-serif');
  const historyBtn = container.querySelector('#btn-note-history');
  const inspectorToggleBtn = container.querySelector('#btn-toggle-inspector');
  const deleteBtn = container.querySelector('#btn-delete-note');
  const splitAreaEl = container.querySelector('#editor-split-area');
  const editorEl = container.querySelector('#markdown-editor');
  const previewPaneEl = container.querySelector('#preview-pane');
  const previewEl = container.querySelector('#markdown-preview');
  const acEl = container.querySelector('#editor-autocomplete');
  const inspectorContentEl = container.querySelector('#inspector-content');
  const saveStatusEl = container.querySelector('#studio-save-status');
  const wordStatsEl = container.querySelector('#studio-word-stats');

  function buildResolver() {
    const slugMap = new Map();
    for (const n of state.notes || []) {
      const cached = state.noteCache.get(n.slug);
      slugMap.set(n.slug, cached || n);
    }
    if (activeDetail?.note) {
      slugMap.set(activeDetail.note.slug, {
        ...activeDetail.note,
        title: titleInput.value.trim() || activeDetail.note.title,
        content: editorEl.value
      });
    }
    return (slug) => slugMap.get(slug) || null;
  }

  function renderPreview(parsedOverride = null) {
    if (!activeDetail?.note) {
      previewEl.innerHTML = `<p style="color:var(--ink-muted)">No note selected. Pick a note on the left or click <strong>New Note</strong>.</p>`;
      wordStatsEl.textContent = '0 words';
      return null;
    }

    const parsed = parsedOverride || parseMarkdown(editorEl.value, { resolveNote: buildResolver() });
    previewEl.innerHTML = parsed.html;
    wordStatsEl.textContent = `${parsed.wordCount} words · ${parsed.readingTimeMinutes} min read`;

    // Lazy-fetch embedded notes whose content isn't cached yet
    if (parsed.embeds && parsed.embeds.length > 0) {
      for (const emb of parsed.embeds) {
        if (!state.noteCache.has(emb.targetSlug) && (state.notesBySlug?.has(emb.targetSlug))) {
          api.getNote(emb.targetSlug).then((res) => {
            if (destroyed || !res?.note) return;
            state.noteCache.set(res.note.slug, res.note);
            if (activeDetail?.note) renderPreview();
          }).catch(() => {});
        }
      }
    }
    return parsed;
  }

  function renderInspector(parsed = null) {
    if (!activeDetail?.note) {
      inspectorContentEl.innerHTML = `<div class="inspector-section"><span class="inspector-heading">Inspector</span><p style="color:var(--ink-muted);font-size:13px">Select a note to inspect outline, properties, and backlinks.</p></div>`;
      return;
    }
    const note = activeDetail.note;
    const activeParsed = parsed || activeDetail.parsed || { headings: [], flashcards: [], tasks: [] };
    const headings = activeParsed.headings || [];
    const backlinks = activeDetail.backlinks || [];
    const mentions = activeDetail.unlinkedMentions || [];
    const ghosts = activeDetail.ghostLinks || [];

    const outlineHtml = headings.length
      ? headings
          .map(
            (h) => `
              <button
                type="button"
                class="inspector-link-btn"
                style="padding-left:${8 + (h.level - 1) * 12}px;font-weight:${h.level === 1 ? 700 : 500}"
                data-jump-heading="${escapeHtml(h.id)}"
                data-jump-line="${h.lineNo}"
              >${escapeHtml(h.text)}</button>
            `
          )
          .join('')
      : `<span style="font-size:12.5px;color:var(--ink-muted)">No headings yet</span>`;

    const backlinksHtml = backlinks.length
      ? backlinks
          .map(
            (bl) => `
              <div class="inspector-card">
                <button type="button" class="inspector-link-btn" data-open-note="${escapeHtml(bl.id)}">
                  ${escapeHtml(bl.title)}
                </button>
                <span style="font-size:12px;color:var(--ink-muted)">${escapeHtml(bl.snippet || bl.folder || '')}</span>
              </div>
            `
          )
          .join('')
      : `<span style="font-size:12.5px;color:var(--ink-muted)">No incoming links yet</span>`;

    const mentionsHtml = mentions.length
      ? mentions
          .map(
            (m) => `
              <div class="inspector-card">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
                  <button type="button" class="inspector-link-btn" data-open-note="${escapeHtml(m.sourceId)}">
                    ${escapeHtml(m.sourceTitle)}
                  </button>
                  <button type="button" class="btn-secondary" style="min-height:32px;padding:0 10px;font-size:11.5px" data-link-mention="${escapeHtml(m.sourceId)}">
                    Link
                  </button>
                </div>
                <span style="font-size:11.5px;color:var(--ink-muted)">${escapeHtml(m.excerpt || '')}</span>
              </div>
            `
          )
          .join('')
      : `<span style="font-size:12.5px;color:var(--ink-muted)">All mentions already linked</span>`;

    const ghostsHtml = ghosts.length
      ? ghosts
          .map(
            (g) => `
              <div class="inspector-card" style="flex-direction:row;align-items:center;justify-content:space-between">
                <span style="font-weight:600;color:var(--ink-secondary)">[[${escapeHtml(g.targetRaw)}]]</span>
                <button type="button" class="btn-secondary" style="min-height:32px;padding:0 10px;font-size:11.5px" data-create-ghost="${escapeHtml(g.targetRaw)}">
                  + Create
                </button>
              </div>
            `
          )
          .join('')
      : `<span style="font-size:12.5px;color:var(--ink-muted)">None</span>`;

    const folderOptions = [...new Set(['Inbox', 'Concepts', 'Architecture', 'Journal', 'Projects', ...Object.keys(listData.folders || {})])];

    inspectorContentEl.innerHTML = `
      <section class="inspector-section">
        <div class="inspector-heading">
          <span>Outline</span>
          <span class="tabular">${headings.length}</span>
        </div>
        <div class="inspector-list">${outlineHtml}</div>
      </section>

      <section class="inspector-section">
        <div class="inspector-heading"><span>Properties</span></div>
        <div class="prop-grid">
          <label for="prop-folder">Folder</label>
          <input id="prop-folder" class="prop-input" list="tessera-folder-list" value="${escapeHtml(note.folder || 'Inbox')}">
          <datalist id="tessera-folder-list">
            ${folderOptions.map((f) => `<option value="${escapeHtml(f)}"></option>`).join('')}
          </datalist>

          <label for="prop-status">Status</label>
          <select id="prop-status" class="prop-input">
            <option value="seedling"${note.status === 'seedling' ? ' selected' : ''}>Seedling</option>
            <option value="budding"${note.status === 'budding' ? ' selected' : ''}>Budding</option>
            <option value="evergreen"${note.status === 'evergreen' ? ' selected' : ''}>Evergreen</option>
            <option value="archived"${note.status === 'archived' ? ' selected' : ''}>Archived</option>
          </select>

          <span>Versions</span>
          <span class="tabular">${activeDetail.versionCount ?? 0} snapshots</span>

          <span>Cards / Tasks</span>
          <span class="tabular">${(activeParsed.flashcards || []).length} cards · ${(activeParsed.tasks || []).length} tasks</span>

          <span>Updated</span>
          <span>${formatRelativeDate(note.updatedAt)}</span>
        </div>
      </section>

      <section class="inspector-section">
        <div class="inspector-heading">
          <span>Backlinks</span>
          <span class="tabular">${backlinks.length}</span>
        </div>
        <div class="inspector-list">${backlinksHtml}</div>
      </section>

      <section class="inspector-section">
        <div class="inspector-heading">
          <span>Unlinked Mentions</span>
          <span class="tabular">${mentions.length}</span>
        </div>
        <div class="inspector-list">${mentionsHtml}</div>
      </section>

      <section class="inspector-section">
        <div class="inspector-heading">
          <span>Ghost Links</span>
          <span class="tabular">${ghosts.length}</span>
        </div>
        <div class="inspector-list">${ghostsHtml}</div>
      </section>
    `;

    // Wire inspector inputs & actions
    const propFolder = inspectorContentEl.querySelector('#prop-folder');
    const propStatus = inspectorContentEl.querySelector('#prop-status');
    propFolder?.addEventListener('change', async () => {
      if (!activeDetail?.note) return;
      const newFolder = propFolder.value.trim() || 'Inbox';
      await saveCurrentNote({ folder: newFolder });
      await loadNoteList();
    });
    propStatus?.addEventListener('change', async () => {
      if (!activeDetail?.note) return;
      const newStatus = propStatus.value;
      editorEl.value = updateFrontmatterKey(editorEl.value, 'status', newStatus);
      await saveCurrentNote({ status: newStatus });
      await loadNoteList();
    });
  }

  function renderTaxonomy() {
    const folders = Object.entries(listData.folders || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const tags = Object.entries(listData.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 14);

    taxonomyEl.innerHTML = `
      <div>
        <div class="tax-group-label">Folders</div>
        <div class="tax-chips">
          <button type="button" class="tax-chip${!filterState.folder ? ' is-active' : ''}" data-folder="">
            All (${listData.totalCount ?? listData.notes.length})
          </button>
          ${folders
            .map(
              ([name, count]) => `
              <button type="button" class="tax-chip${filterState.folder === name ? ' is-active' : ''}" data-folder="${escapeHtml(name)}">
                ${escapeHtml(name)} (${count})
              </button>
            `
            )
            .join('')}
        </div>
      </div>
      ${
        tags.length
          ? `<div>
              <div class="tax-group-label">Tags</div>
              <div class="tax-chips">
                ${tags
                  .map(
                    ([tag, count]) => `
                    <button type="button" class="tax-chip${filterState.tag === tag ? ' is-active' : ''}" data-tag="${escapeHtml(tag)}">
                      #${escapeHtml(tag)} (${count})
                    </button>
                  `
                  )
                  .join('')}
              </div>
            </div>`
          : ''
      }
    `;
  }

  function renderNoteList() {
    const notes = listData.notes || [];
    if (notes.length === 0) {
      noteListEl.innerHTML = `<div style="padding:18px;text-align:center;color:var(--ink-muted);font-size:13px">No notes match this filter.</div>`;
      return;
    }

    const activeId = state.activeNoteId;
    noteListEl.innerHTML = notes
      .map((n) => {
        const isSelected = activeId && n.id === activeId;
        return `
          <button
            type="button"
            class="note-list-item${isSelected ? ' is-selected' : ''}"
            data-note-id="${escapeHtml(n.id)}"
            role="option"
            aria-selected="${isSelected ? 'true' : 'false'}"
          >
            <div class="note-item-top">
              <span class="note-item-title">${n.pinned ? '★ ' : ''}${escapeHtml(n.title)}</span>
              ${n.openTaskCount > 0 ? `<span class="meta-badge">${n.openTaskCount} todo</span>` : `<span class="meta-badge">${escapeHtml(n.folder)}</span>`}
            </div>
            <div class="note-item-snippet">${escapeHtml(n.snippet || '')}</div>
            <div class="note-item-meta">
              <span class="tabular">${n.wordCount}w</span>
              ${n.cardCount > 0 ? `<span>· ${n.cardCount} cards</span>` : ''}
              <span>· ${formatRelativeDate(n.updatedAt)}</span>
            </div>
          </button>
        `;
      })
      .join('');
  }

  async function loadNoteList() {
    const res = await api.listNotes({
      q: filterState.q || undefined,
      folder: filterState.folder || undefined,
      tag: filterState.tag || undefined,
      filter: filterState.filter !== 'all' ? filterState.filter : undefined
    });
    if (destroyed) return;
    listData = res;
    if (!filterState.q && !filterState.folder && !filterState.tag && filterState.filter === 'all') {
      state.notes = res.notes;
      state.notesBySlug = new Map(res.notes.map((n) => [n.slug, n]));
    }
    renderTaxonomy();
    renderNoteList();
  }

  async function openNoteByIdOrSlug(idOrSlug) {
    if (dirty && activeDetail?.note) {
      await flushSave();
    }
    const detail = await api.getNote(idOrSlug);
    if (destroyed || !detail?.note) return;

    activeDetail = detail;
    state.activeNoteId = detail.note.id;
    localStorage.setItem('tessera.lastNoteId', detail.note.id);
    state.noteCache.set(detail.note.slug, detail.note);

    titleInput.value = detail.note.title;
    editorEl.value = detail.note.content;
    pinBtn.setAttribute('aria-pressed', detail.note.pinned ? 'true' : 'false');
    pinBtn.style.color = detail.note.pinned ? 'var(--accent)' : '';
    dirty = false;
    saveStatusEl.textContent = 'Saved';

    renderPreview(detail.parsed);
    renderInspector(detail.parsed);
    renderNoteList();

    // Close mobile sidebar after choosing note
    if (state.isMobileSidebarOpen) {
      state.isMobileSidebarOpen = false;
      sidebarEl.classList.remove('is-mobile-open');
    }
  }

  async function saveCurrentNote(extraPatch = {}) {
    if (!activeDetail?.note) return null;
    saving = true;
    saveStatusEl.textContent = 'Saving…';
    try {
      const nextTitle = titleInput.value.trim() || 'Untitled Note';
      const updatedDetail = await api.updateNote(activeDetail.note.id, {
        title: nextTitle,
        content: editorEl.value,
        folder: extraPatch.folder ?? activeDetail.note.folder,
        status: extraPatch.status ?? activeDetail.note.status,
        pinned: extraPatch.pinned ?? activeDetail.note.pinned
      });
      if (destroyed) return null;
      activeDetail = updatedDetail;
      state.noteCache.set(updatedDetail.note.slug, updatedDetail.note);
      dirty = false;
      saveStatusEl.textContent = 'Saved';
      pinBtn.setAttribute('aria-pressed', updatedDetail.note.pinned ? 'true' : 'false');
      pinBtn.style.color = updatedDetail.note.pinned ? 'var(--accent)' : '';
      renderPreview(updatedDetail.parsed);
      renderInspector(updatedDetail.parsed);
      await actions.refreshCounts();
      await loadNoteList();
      return updatedDetail;
    } catch (err) {
      saveStatusEl.textContent = 'Save error';
      showToast(`Failed to save: ${err.message}`);
      return null;
    } finally {
      saving = false;
    }
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (dirty && !saving) {
      await saveCurrentNote();
    }
  }

  function scheduleSave() {
    dirty = true;
    saveStatusEl.textContent = 'Unsaved';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveCurrentNote();
    }, 650);
  }

  function insertTextAtCursor(snippet, selectOffsetStart = null, selectOffsetEnd = null) {
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    const val = editorEl.value;
    const selected = val.slice(start, end);
    const replacement = typeof snippet === 'function' ? snippet(selected) : snippet;
    editorEl.value = val.slice(0, start) + replacement + val.slice(end);
    const nextPos = start + replacement.length;
    editorEl.focus();
    if (selectOffsetStart !== null && selectOffsetEnd !== null) {
      editorEl.setSelectionRange(start + selectOffsetStart, start + selectOffsetEnd);
    } else {
      editorEl.setSelectionRange(nextPos, nextPos);
    }
    const parsed = renderPreview();
    renderInspector(parsed);
    scheduleSave();
  }

  function renderAutocomplete() {
    if (!acState.open || acState.items.length === 0) {
      acEl.hidden = true;
      acEl.innerHTML = '';
      return;
    }
    acEl.hidden = false;
    acEl.style.left = '24px';
    acEl.style.bottom = '16px';
    acEl.innerHTML = acState.items
      .map(
        (item, idx) => `
          <button
            type="button"
            class="ac-item${idx === acState.selectedIndex ? ' is-active' : ''}"
            data-ac-idx="${idx}"
            role="option"
            aria-selected="${idx === acState.selectedIndex ? 'true' : 'false'}"
          >
            <span>${escapeHtml(item.label)}</span>
            <span style="font-size:11px;color:var(--ink-muted)">${escapeHtml(item.hint || '')}</span>
          </button>
        `
      )
      .join('');
  }

  function closeAutocomplete() {
    acState.open = false;
    acState.items = [];
    acEl.hidden = true;
  }

  function acceptAutocomplete(index = acState.selectedIndex) {
    const item = acState.items[index];
    if (!item) return;
    const val = editorEl.value;
    const replacement = acState.kind === 'wikilink' ? `[[${item.title}]]` : item.snippet;
    editorEl.value = val.slice(0, acState.startIdx) + replacement + val.slice(acState.endIdx);
    const pos = acState.startIdx + replacement.length;
    editorEl.focus();
    editorEl.setSelectionRange(pos, pos);
    closeAutocomplete();
    const parsed = renderPreview();
    renderInspector(parsed);
    scheduleSave();
  }

  function checkAutocomplete() {
    const cursor = editorEl.selectionStart;
    if (editorEl.selectionEnd !== cursor) {
      closeAutocomplete();
      return;
    }
    const before = editorEl.value.slice(0, cursor);
    const wikiMatch = before.match(/\[\[([^\]\n]{0,40})$/);
    if (wikiMatch) {
      const q = wikiMatch[1].toLowerCase().trim();
      const notes = (state.notes || [])
        .filter((n) => n.id !== activeDetail?.note?.id)
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.slug.includes(q))
        .slice(0, 8)
        .map((n) => ({ label: n.title, hint: n.folder, title: n.title }));
      if (notes.length > 0) {
        acState = {
          open: true,
          kind: 'wikilink',
          startIdx: cursor - wikiMatch[0].length,
          endIdx: cursor,
          items: notes,
          selectedIndex: 0
        };
        renderAutocomplete();
        return;
      }
    }

    const slashMatch = before.match(/(?:^|\n)\/([a-z0-9-]{0,18})$/i);
    if (slashMatch) {
      const q = slashMatch[1].toLowerCase();
      const cmds = SLASH_COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q));
      if (cmds.length > 0) {
        const leadingNewlineLen = slashMatch[0].startsWith('\n') ? 1 : 0;
        acState = {
          open: true,
          kind: 'slash',
          startIdx: cursor - slashMatch[0].length + leadingNewlineLen,
          endIdx: cursor,
          items: cmds,
          selectedIndex: 0
        };
        renderAutocomplete();
        return;
      }
    }

    closeAutocomplete();
  }

  async function createAndOpenGhost(rawTitleOrSlug) {
    const cleanTitle = rawTitleOrSlug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const created = await api.createNote({
      title: cleanTitle,
      folder: activeDetail?.note?.folder || 'Concepts',
      content: `# ${cleanTitle}\n\nLinked from [[${activeDetail?.note?.title || 'Vault'}]].\n`
    });
    showToast(`Created [[${created.note.title}]]`);
    await actions.syncNotesIndex();
    await loadNoteList();
    await openNoteByIdOrSlug(created.note.id);
  }

  // Sidebar search & filters
  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    filterState.q = searchInput.value.trim();
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadNoteList, 160);
  });

  sidebarEl.addEventListener('click', (e) => {
    const filterBtn = e.target.closest('.filter-pill');
    if (filterBtn) {
      filterState.filter = filterBtn.dataset.filter;
      sidebarEl.querySelectorAll('.filter-pill').forEach((b) => b.classList.toggle('is-active', b === filterBtn));
      loadNoteList();
      return;
    }

    const folderBtn = e.target.closest('.tax-chip[data-folder]');
    if (folderBtn) {
      filterState.folder = folderBtn.dataset.folder;
      loadNoteList();
      return;
    }

    const tagBtn = e.target.closest('.tax-chip[data-tag]');
    if (tagBtn) {
      const t = tagBtn.dataset.tag;
      filterState.tag = filterState.tag === t ? '' : t;
      loadNoteList();
      return;
    }

    const noteBtn = e.target.closest('.note-list-item[data-note-id]');
    if (noteBtn) {
      openNoteByIdOrSlug(noteBtn.dataset.noteId);
    }
  });

  // Topbar controls
  titleInput.addEventListener('input', scheduleSave);
  pinBtn.addEventListener('click', async () => {
    if (!activeDetail?.note) return;
    await saveCurrentNote({ pinned: !activeDetail.note.pinned });
  });

  container.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      splitAreaEl.dataset.mode = mode;
      localStorage.setItem('tessera.editorMode', mode);
      container.querySelectorAll('.seg-btn[data-mode]').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });

  serifBtn.addEventListener('click', () => {
    const next = !previewPaneEl.classList.contains('is-serif');
    previewPaneEl.classList.toggle('is-serif', next);
    serifBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    localStorage.setItem('tessera.serifPreview', next ? '1' : '0');
  });

  historyBtn.addEventListener('click', () => {
    if (!activeDetail?.note) return;
    actions.openDiff(activeDetail.note.id, activeDetail.note.title, async () => {
      await openNoteByIdOrSlug(activeDetail.note.id);
      await loadNoteList();
    });
  });

  inspectorToggleBtn.addEventListener('click', () => {
    inspectorCollapsed = !inspectorCollapsed;
    shellEl.classList.toggle('is-inspector-collapsed', inspectorCollapsed);
    inspectorToggleBtn.setAttribute('aria-expanded', inspectorCollapsed ? 'false' : 'true');
    localStorage.setItem('tessera.inspectorCollapsed', inspectorCollapsed ? '1' : '0');
  });

  deleteBtn.addEventListener('click', () => {
    if (!activeDetail?.note) return;
    const doomed = activeDetail.note;
    openModal(
      `
        <div class="modal-header">
          <h2 style="margin:0;font-size:17px">Delete Note</h2>
          <button type="button" class="btn-ghost btn-sm" data-modal-close>Cancel</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
          <p style="margin:0">Permanently delete <strong>${escapeHtml(doomed.title)}</strong>? This cannot be undone.</p>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn-secondary" data-modal-close>Keep Note</button>
            <button type="button" id="confirm-delete-note" class="btn-danger">Delete Forever</button>
          </div>
        </div>
      `,
      {
        onMount: (card, close) => {
          card.querySelector('#confirm-delete-note')?.addEventListener('click', async () => {
            await api.deleteNote(doomed.id);
            close();
            showToast(`Deleted "${doomed.title}"`);
            activeDetail = null;
            state.activeNoteId = null;
            await actions.syncNotesIndex();
            await actions.refreshCounts();
            await loadNoteList();
            if (listData.notes.length > 0) {
              await openNoteByIdOrSlug(listData.notes[0].id);
            } else {
              titleInput.value = '';
              editorEl.value = '';
              renderPreview();
              renderInspector();
            }
          });
        }
      }
    );
  });

  // Formatting toolbar
  container.querySelector('.editor-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tool-btn[data-fmt]');
    if (!btn || !activeDetail?.note) return;
    const fmt = btn.dataset.fmt;
    if (fmt === 'h2') insertTextAtCursor('\n## ');
    else if (fmt === 'bold') insertTextAtCursor((sel) => `**${sel || 'bold text'}**`, 2, 2 + (editorEl.selectionEnd - editorEl.selectionStart || 9));
    else if (fmt === 'italic') insertTextAtCursor((sel) => `*${sel || 'italic text'}*`, 1, 1 + (editorEl.selectionEnd - editorEl.selectionStart || 11));
    else if (fmt === 'link') {
      insertTextAtCursor('[[');
      checkAutocomplete();
    } else if (fmt === 'task') insertTextAtCursor('\n- [ ] ');
    else if (fmt === 'card') insertTextAtCursor('\nPrompt question?\n??\nConcise answer.\n');
    else if (fmt === 'callout') insertTextAtCursor('\n> [!TIP] Insight\n> Concise explanation.\n');
    else if (fmt === 'code') insertTextAtCursor('\n```js\n\n```\n');
    else if (fmt === 'slash') {
      insertTextAtCursor('\n/');
      checkAutocomplete();
    }
  });

  // Markdown editor live preview + autosave + autocomplete
  editorEl.addEventListener('input', () => {
    const parsed = renderPreview();
    renderInspector(parsed);
    checkAutocomplete();
    scheduleSave();
  });

  editorEl.addEventListener('keydown', (e) => {
    if (acState.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acState.selectedIndex = (acState.selectedIndex + 1) % acState.items.length;
        renderAutocomplete();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        acState.selectedIndex = (acState.selectedIndex - 1 + acState.items.length) % acState.items.length;
        renderAutocomplete();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptAutocomplete();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flushSave();
    }
  });

  acEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.ac-item[data-ac-idx]');
    if (!btn) return;
    acceptAutocomplete(Number(btn.dataset.acIdx));
  });

  // Preview interactive delegation
  previewEl.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-code]');
    if (copyBtn) {
      const code = copyBtn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1400);
      } catch {
        showToast('Clipboard permission unavailable');
      }
      return;
    }

    const ghostBtn = e.target.closest('[data-create-ghost]');
    if (ghostBtn) {
      await createAndOpenGhost(ghostBtn.dataset.createGhost);
      return;
    }

    const wikiLink = e.target.closest('.wikilink[data-wikilink-slug]');
    if (wikiLink) {
      e.preventDefault();
      const targetSlug = wikiLink.dataset.wikilinkSlug;
      if (wikiLink.classList.contains('is-ghost')) {
        await createAndOpenGhost(wikiLink.textContent || targetSlug);
      } else {
        await openNoteByIdOrSlug(targetSlug);
      }
      return;
    }

    const tagBtn = e.target.closest('.inline-tag[data-tag]');
    if (tagBtn) {
      const t = tagBtn.dataset.tag;
      filterState.tag = filterState.tag === t ? '' : t;
      loadNoteList();
    }
  });

  previewEl.addEventListener('change', async (e) => {
    const checkbox = e.target.closest('input[type="checkbox"][data-task-line]');
    if (!checkbox || !activeDetail?.note) return;
    const lineNo = Number(checkbox.dataset.taskLine);
    const done = checkbox.checked;
    const localToggle = toggleTaskLine(editorEl.value, lineNo, done);
    if (localToggle.changed) {
      editorEl.value = localToggle.updated;
    }
    try {
      const res = await api.toggleTask(activeDetail.note.id, lineNo, done);
      if (res?.note) {
        activeDetail = res;
        state.noteCache.set(res.note.slug, res.note);
        dirty = false;
        saveStatusEl.textContent = 'Saved';
        renderPreview(res.parsed);
        renderInspector(res.parsed);
        await actions.refreshCounts();
        await loadNoteList();
      }
    } catch (err) {
      showToast(`Task update failed: ${err.message}`);
    }
  });

  // Inspector click delegation
  inspectorContentEl.addEventListener('click', async (e) => {
    const jumpBtn = e.target.closest('[data-jump-heading]');
    if (jumpBtn) {
      const headingEl = previewEl.querySelector(`#${CSS.escape(jumpBtn.dataset.jumpHeading)}`);
      headingEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const lineNo = Number(jumpBtn.dataset.jumpLine || 1);
      const lines = editorEl.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(lineNo - 1, lines.length); i++) {
        pos += lines[i].length + 1;
      }
      editorEl.focus();
      editorEl.setSelectionRange(pos, pos);
      return;
    }

    const openBtn = e.target.closest('[data-open-note]');
    if (openBtn) {
      await openNoteByIdOrSlug(openBtn.dataset.openNote);
      return;
    }

    const linkBtn = e.target.closest('[data-link-mention]');
    if (linkBtn && activeDetail?.note) {
      const sourceId = linkBtn.dataset.linkMention;
      try {
        await api.linkMention(activeDetail.note.id, sourceId);
        showToast('Linked unlinked mention');
        await openNoteByIdOrSlug(activeDetail.note.id);
        await loadNoteList();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const ghostBtn = e.target.closest('[data-create-ghost]');
    if (ghostBtn) {
      await createAndOpenGhost(ghostBtn.dataset.createGhost);
    }
  });

  // Initialize Studio data
  (async () => {
    await loadNoteList();
    if (destroyed) return;
    const preferred =
      state.activeNoteId ||
      localStorage.getItem('tessera.lastNoteId') ||
      (listData.notes[0] && listData.notes[0].id);
    if (preferred) {
      const exists =
        listData.notes.some((n) => n.id === preferred || n.slug === preferred) ||
        state.notesBySlug?.has(slugify(preferred));
      const target = exists ? preferred : listData.notes[0]?.id;
      if (target) await openNoteByIdOrSlug(target);
    }
  })();

  return {
    refreshList: async () => {
      await loadNoteList();
      if (activeDetail?.note && !dirty) {
        try {
          await openNoteByIdOrSlug(activeDetail.note.id);
        } catch {
          // ignore if deleted remotely
        }
      }
    },
    openNoteByIdOrSlug,
    getActiveNoteId: () => activeDetail?.note?.id || null,
    toggleMobileSidebar: () => {
      state.isMobileSidebarOpen = !state.isMobileSidebarOpen;
      sidebarEl.classList.toggle('is-mobile-open', state.isMobileSidebarOpen);
    },
    destroy: () => {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
    }
  };
}
