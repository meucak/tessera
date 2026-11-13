/**
 * Tessera Application Bootstrap & Workspace Orchestrator:
 *  - Manages theme switching (Light / Sepia / Dark) persisted in localStorage
 *  - Hosts WebSocket real-time sync with reconnect backoff & live status indicator
 *  - Switches workspaces cleanly (studio / graph / board / recall / tasks)
 *  - Handles global hotkeys (Ctrl/Cmd+K Command Palette, 1-5 tabs, N new note, D daily note)
 */

import { api, CLIENT_ID } from './apiClient.js';
import { openCommandPalette } from './components/commandPalette.js';
import { openDiffModal } from './components/diffModal.js';
import { openModal, showToast } from './components/toast.js';
import { openVaultModal } from './components/vaultModal.js';
import { mountBoardView } from './views/boardView.js';
import { mountGraphView } from './views/graphView.js';
import { mountRecallView } from './views/recallView.js';
import { mountStudioView } from './views/studioView.js';
import { mountTasksView } from './views/tasksView.js';

const THEMES = [
  { id: 'light', label: 'Light', themeColor: '#B83B14' },
  { id: 'sepia', label: 'Sepia', themeColor: '#9A3412' },
  { id: 'dark', label: 'Dark', themeColor: '#121315' }
];

const VIEW_LABELS = {
  studio: 'Studio',
  graph: 'Knowledge Graph',
  board: 'Spatial Canvas',
  recall: 'Recall Lab (FSRS)',
  tasks: 'Tasks & Daily'
};

const state = {
  activeView: localStorage.getItem('tessera.activeView') || 'studio',
  activeNoteId: localStorage.getItem('tessera.lastNoteId') || null,
  theme: localStorage.getItem('tessera.theme') || 'light',
  notes: [],
  notesBySlug: new Map(),
  noteCache: new Map(),
  isMobileSidebarOpen: false
};

let activeController = null;
let ws = null;
let wsReconnectTimer = null;

const viewHostEl = document.getElementById('view-host');
const crumbEl = document.getElementById('active-workspace-crumb');
const syncPillEl = document.getElementById('ws-sync-pill');
const themeLabelEl = document.getElementById('theme-label');
const dueBadgeEl = document.getElementById('badge-due-cards');
const taskBadgeEl = document.getElementById('badge-open-tasks');

function applyTheme(themeId) {
  const valid = THEMES.find((t) => t.id === themeId) || THEMES[0];
  state.theme = valid.id;
  document.documentElement.setAttribute('data-theme', valid.id);
  localStorage.setItem('tessera.theme', valid.id);
  if (themeLabelEl) themeLabelEl.textContent = valid.label;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', valid.themeColor);
}

function cycleTheme() {
  const idx = THEMES.findIndex((t) => t.id === state.theme);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next.id);
  showToast(`Theme: ${next.label}`);
}

async function syncNotesIndex() {
  try {
    const res = await api.listNotes();
    state.notes = res.notes || [];
    state.notesBySlug = new Map(state.notes.map((n) => [n.slug, n]));
  } catch {
    // offline fallback kept
  }
}

async function refreshCounts() {
  try {
    const [flashRes, tasksRes] = await Promise.all([api.listFlashcards(), api.listTasks()]);
    const dueCount = flashRes.stats?.due ?? 0;
    const openTasks = (tasksRes.counts?.todo ?? 0) + (tasksRes.counts?.doing ?? 0);

    if (dueBadgeEl) {
      dueBadgeEl.textContent = String(dueCount);
      dueBadgeEl.hidden = dueCount <= 0;
    }
    if (taskBadgeEl) {
      taskBadgeEl.textContent = String(openTasks);
      taskBadgeEl.hidden = openTasks <= 0;
    }
  } catch {
    // ignore transient offline state
  }
}

function mountActiveView(viewName) {
  const validView = VIEW_LABELS[viewName] ? viewName : 'studio';
  state.activeView = validView;
  localStorage.setItem('tessera.activeView', validView);

  if (crumbEl) crumbEl.textContent = VIEW_LABELS[validView];

  document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
    const active = btn.dataset.view === validView;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (activeController?.destroy) {
    activeController.destroy();
  }
  viewHostEl.innerHTML = '';

  const ctx = {
    container: viewHostEl,
    state,
    actions
  };

  if (validView === 'studio') activeController = mountStudioView(ctx);
  else if (validView === 'graph') activeController = mountGraphView(ctx);
  else if (validView === 'board') activeController = mountBoardView(ctx);
  else if (validView === 'recall') activeController = mountRecallView(ctx);
  else if (validView === 'tasks') activeController = mountTasksView(ctx);
}

const actions = {
  navigateView: (viewName) => {
    mountActiveView(viewName);
  },
  openNote: async (idOrSlug) => {
    state.activeNoteId = idOrSlug;
    if (state.activeView !== 'studio') {
      mountActiveView('studio');
    } else if (activeController?.openNoteByIdOrSlug) {
      await activeController.openNoteByIdOrSlug(idOrSlug);
    }
  },
  openNewNoteDialog: () => {
    openModal(
      `
        <div class="modal-header">
          <h2 style="margin:0;font-size:17px">New Vault Note</h2>
          <button type="button" class="btn-ghost btn-sm" data-modal-close>Cancel</button>
        </div>
        <form id="new-note-modal-form" class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label for="new-note-title" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px">Title</label>
            <input id="new-note-title" class="sidebar-search-input" required placeholder="e.g. Distributed Consensus Notes">
          </div>
          <div>
            <label for="new-note-folder" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px">Folder</label>
            <input id="new-note-folder" class="sidebar-search-input" value="Inbox" placeholder="Inbox, Concepts, Architecture…">
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
            <button type="button" class="btn-secondary" data-modal-close>Cancel</button>
            <button type="submit" class="btn-primary">Create Note</button>
          </div>
        </form>
      `,
      {
        onMount: (card, close) => {
          const titleEl = card.querySelector('#new-note-title');
          const folderEl = card.querySelector('#new-note-folder');
          titleEl?.focus();
          card.querySelector('#new-note-modal-form')?.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const title = titleEl.value.trim() || 'Untitled Note';
            const folder = folderEl.value.trim() || 'Inbox';
            const res = await api.createNote({
              title,
              folder,
              status: 'seedling',
              content: `---\nfolder: ${folder}\nstatus: seedling\ntags: []\n---\n\n# ${title}\n\n`
            });
            close();
            await syncNotesIndex();
            await refreshCounts();
            await actions.openNote(res.note.id);
            showToast(`Created "${res.note.title}"`);
          });
        }
      }
    );
  },
  openDailyNote: async () => {
    try {
      const res = await api.openDailyNote();
      await syncNotesIndex();
      await refreshCounts();
      await actions.openNote(res.note.id);
      showToast(res.created ? `Created today's journal: ${res.note.title}` : `Opened ${res.note.title}`);
    } catch (err) {
      showToast(`Daily journal error: ${err.message}`);
    }
  },
  openDiff: (noteId, noteTitle, onRestored) => {
    openDiffModal(noteId, noteTitle, async () => {
      await syncNotesIndex();
      await refreshCounts();
      if (onRestored) await onRestored();
    });
  },
  refreshCounts,
  syncNotesIndex
};

function setSyncStatus(mode, label) {
  if (!syncPillEl) return;
  syncPillEl.classList.remove('is-live', 'is-connecting', 'is-offline');
  syncPillEl.classList.add(mode);
  const textEl = syncPillEl.querySelector('.sync-text');
  if (textEl) textEl.textContent = label;
}

function connectWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setSyncStatus('is-connecting', 'Syncing');
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    setSyncStatus('is-live', 'Live Sync');
    try {
      ws.send(JSON.stringify({ type: 'hello', clientId: CLIENT_ID }));
    } catch {
      // ignore closed socket
    }
  });

  ws.addEventListener('message', async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.clientId && msg.clientId === CLIENT_ID) return;
      if (msg.type === 'connected') return;

      await syncNotesIndex();
      await refreshCounts();
      if (activeController?.refreshList) await activeController.refreshList();
      else if (activeController?.refresh) await activeController.refresh();
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener('close', () => {
    setSyncStatus('is-offline', 'Offline');
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener('error', () => {
    setSyncStatus('is-offline', 'Reconnecting');
  });
}

function openPal() {
  openCommandPalette({
    onNavigateView: actions.navigateView,
    onOpenNote: actions.openNote,
    onNewNote: actions.openNewNoteDialog,
    onDailyNote: actions.openDailyNote,
    onCycleTheme: cycleTheme
  });
}

// Navigation Rail & Header Bindings
document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    actions.navigateView(btn.dataset.view);
  });
});

document.getElementById('btn-command-palette')?.addEventListener('click', openPal);
document.getElementById('btn-global-search-trigger')?.addEventListener('click', openPal);
document.getElementById('btn-theme-cycle')?.addEventListener('click', cycleTheme);
document.getElementById('btn-new-note')?.addEventListener('click', actions.openNewNoteDialog);
document.getElementById('btn-daily-note')?.addEventListener('click', actions.openDailyNote);

document.getElementById('btn-mobile-sidebar')?.addEventListener('click', () => {
  if (state.activeView !== 'studio') {
    actions.navigateView('studio');
    state.isMobileSidebarOpen = true;
    return;
  }
  if (activeController?.toggleMobileSidebar) {
    activeController.toggleMobileSidebar();
  }
});

document.getElementById('btn-vault-modal')?.addEventListener('click', () => {
  openVaultModal({
    onImported: async () => {
      await syncNotesIndex();
      await refreshCounts();
      mountActiveView(state.activeView);
    }
  });
});

// Global Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPal();
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (modalRoot && !modalRoot.hidden) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

  if (e.key === '1') actions.navigateView('studio');
  else if (e.key === '2') actions.navigateView('graph');
  else if (e.key === '3') actions.navigateView('board');
  else if (e.key === '4') actions.navigateView('recall');
  else if (e.key === '5') actions.navigateView('tasks');
  else if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    actions.openNewNoteDialog();
  } else if (e.key.toLowerCase() === 'd') {
    e.preventDefault();
    actions.openDailyNote();
  } else if (e.key.toLowerCase() === 't') {
    cycleTheme();
  }
});

// Boot Sequence
(async () => {
  applyTheme(state.theme);
  await syncNotesIndex();
  await refreshCounts();
  mountActiveView(state.activeView);
  connectWebSocket();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
