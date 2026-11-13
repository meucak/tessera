import { api } from '../apiClient.js';
import { escapeHtml } from '/core/markdownAst.js';
import { openModal } from './toast.js';

/**
 * Universal Command Palette (Ctrl/Cmd + K) combining BM25 FTS5 note search,
 * operator hints (tag:, folder:, has:tasks, has:cards), and quick workspace actions.
 */
export function openCommandPalette({ onNavigateView, onOpenNote, onNewNote, onDailyNote, onCycleTheme }) {
  const actions = [
    { id: 'act-new', label: 'Create New Note', hint: 'N', run: () => onNewNote() },
    { id: 'act-daily', label: "Open Today's Daily Journal", hint: 'D', run: () => onDailyNote() },
    { id: 'act-studio', label: 'Switch to Studio Workspace', hint: '1', run: () => onNavigateView('studio') },
    { id: 'act-graph', label: 'Switch to Knowledge Graph', hint: '2', run: () => onNavigateView('graph') },
    { id: 'act-board', label: 'Switch to Spatial Canvas', hint: '3', run: () => onNavigateView('board') },
    { id: 'act-recall', label: 'Switch to Recall Lab (FSRS)', hint: '4', run: () => onNavigateView('recall') },
    { id: 'act-tasks', label: 'Switch to Tasks & Kanban', hint: '5', run: () => onNavigateView('tasks') },
    { id: 'act-theme', label: 'Cycle Color Theme (Light / Sepia / Dark)', hint: 'T', run: () => onCycleTheme() }
  ];

  openModal(
    `
    <div class="modal-header">
      <input type="search" id="cp-input" class="sidebar-search-input" placeholder="Search notes (try tag:sqlite, has:tasks, &quot;exact phrase&quot;) or type a command…" autocomplete="off" aria-label="Command palette search">
      <button type="button" class="btn-secondary btn-sm" data-modal-close>Esc</button>
    </div>
    <div class="modal-body" id="cp-results" style="max-height: 60vh;"></div>
    `,
    {
      onMount: (dialog, close) => {
        const input = dialog.querySelector('#cp-input');
        const listEl = dialog.querySelector('#cp-results');
        let items = [];
        let activeIdx = 0;

        const renderList = () => {
          if (items.length === 0) {
            listEl.innerHTML = `<p style="color:var(--ink-muted); padding: 12px;">No matching notes or commands.</p>`;
            return;
          }
          listEl.innerHTML = items
            .map(
              (item, idx) => `
              <button type="button" class="ac-item${idx === activeIdx ? ' is-active' : ''}" data-cp-idx="${idx}" style="min-height:44px; border:1px solid var(--hairline);">
                <span>
                  <strong>${escapeHtml(item.label)}</strong>
                  ${item.sub ? `<span style="display:block;font-size:11.5px;color:var(--ink-secondary);">${escapeHtml(item.sub)}</span>` : ''}
                </span>
                <span class="kbd-chip">${escapeHtml(item.hint || '')}</span>
              </button>`
            )
            .join('');

          listEl.querySelectorAll('[data-cp-idx]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const target = items[Number(btn.dataset.cpIdx)];
              close();
              target.run();
            });
          });
        };

        const runQuery = async (q) => {
          const trimmed = q.trim().toLowerCase();
          const matchedActions = actions
            .filter((a) => !trimmed || a.label.toLowerCase().includes(trimmed))
            .map((a) => ({ label: a.label, sub: 'Command', hint: a.hint, run: a.run }));

          try {
            const data = await api.listNotes({ q });
            const matchedNotes = data.notes.slice(0, 8).map((n) => ({
              label: n.title,
              sub: `${n.folder} • ${n.wordCount} words${n.tags.length ? ' • #' + n.tags.slice(0, 3).join(' #') : ''}`,
              hint: 'Note',
              run: () => onOpenNote(n.id)
            }));
            items = [...matchedNotes, ...matchedActions];
          } catch {
            items = matchedActions;
          }
          activeIdx = 0;
          renderList();
        };

        let timer = null;
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => runQuery(input.value), 120);
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(items.length - 1, activeIdx + 1);
            renderList();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(0, activeIdx - 1);
            renderList();
          } else if (e.key === 'Enter' && items[activeIdx]) {
            e.preventDefault();
            const picked = items[activeIdx];
            close();
            picked.run();
          }
        });

        runQuery('');
        setTimeout(() => input.focus(), 20);
      }
    }
  );
}
