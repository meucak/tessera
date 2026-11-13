/**
 * Tessera Tasks & Daily Hub View:
 *  - Aggregates Markdown tasks across every note in the vault
 *  - 3-Column Kanban (Todo / Doing / Done) synced two-way with source Markdown checkboxes
 *  - Priority & folder filtering + quick Daily Journal task capture
 */

import { escapeHtml } from '/core/markdownAst.js';
import { api } from '../apiClient.js';
import { showToast } from '../components/toast.js';

const PRIORITY_STYLE = {
  high: { label: 'High', color: 'var(--danger)', bg: 'var(--danger-soft)' },
  medium: { label: 'Medium', color: 'var(--amber)', bg: 'var(--amber-soft)' },
  low: { label: 'Low', color: 'var(--cobalt)', bg: 'var(--cobalt-soft)' }
};

export function mountTasksView(ctx) {
  const { container, actions } = ctx;
  let destroyed = false;
  let tasksData = null;
  let filterText = '';
  let filterPriority = 'all';
  let filterFolder = 'all';

  container.innerHTML = `
    <div class="tasks-workspace">
      <div id="tasks-kpis" class="kpi-strip"></div>

      <section class="chart-card" aria-label="Task Controls and Quick Capture">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px">
          <form id="quick-task-form" style="display:flex;flex:1;min-width:260px;gap:8px;flex-wrap:wrap">
            <input
              type="text"
              id="quick-task-input"
              class="sidebar-search-input"
              style="flex:1;min-width:200px"
              placeholder="Capture task to today's journal… (e.g. Ship v1 release !high)"
              aria-label="New task text"
            >
            <select id="quick-task-priority" class="prop-input" style="width:116px" aria-label="Task priority">
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
            <button type="submit" class="btn-primary btn-sm">+ Add to Today</button>
          </form>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="search" id="tasks-search" class="prop-input" style="width:160px" placeholder="Filter tasks…" aria-label="Filter tasks">
            <select id="tasks-priority-filter" class="prop-input" style="width:124px" aria-label="Filter priority">
              <option value="all">All Priorities</option>
              <option value="high">High Priority</option>
              <option value="medium">Medium Priority</option>
              <option value="low">Low Priority</option>
            </select>
            <select id="tasks-folder-filter" class="prop-input" style="width:130px" aria-label="Filter folder">
              <option value="all">All Folders</option>
            </select>
            <button type="button" id="btn-tasks-daily" class="btn-secondary btn-sm">Open Today Note</button>
          </div>
        </div>
      </section>

      <div id="kanban-grid" class="kanban-grid"></div>
    </div>
  `;

  const kpisEl = container.querySelector('#tasks-kpis');
  const kanbanEl = container.querySelector('#kanban-grid');
  const quickForm = container.querySelector('#quick-task-form');
  const quickInput = container.querySelector('#quick-task-input');
  const quickPriority = container.querySelector('#quick-task-priority');
  const searchEl = container.querySelector('#tasks-search');
  const prioFilterEl = container.querySelector('#tasks-priority-filter');
  const folderFilterEl = container.querySelector('#tasks-folder-filter');

  function renderTaskCard(t) {
    const prio = PRIORITY_STYLE[t.priority] || PRIORITY_STYLE.medium;
    const todayStr = new Date().toISOString().slice(0, 10);
    const isOverdue = t.dueDate && !t.done && t.dueDate < todayStr;
    return `
      <div class="task-card">
        <input
          type="checkbox"
          data-task-note="${escapeHtml(t.noteId)}"
          data-task-line="${t.lineNo}"
          aria-label="Toggle task: ${escapeHtml(t.text)}"
          ${t.done ? 'checked' : ''}
        >
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
          <div style="font-size:13.5px;line-height:1.45;${t.done ? 'text-decoration:line-through;color:var(--ink-muted)' : ''}">
            ${escapeHtml(t.text)}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
            <span class="meta-badge" style="background:${prio.bg};color:${prio.color}">${prio.label}</span>
            ${
              t.dueDate
                ? `<span class="meta-badge" style="${isOverdue ? 'background:var(--danger-soft);color:var(--danger)' : ''}">@${escapeHtml(t.dueDate)}</span>`
                : ''
            }
            <button type="button" class="inspector-link-btn" style="padding:2px 6px;font-size:11.5px" data-open-note="${escapeHtml(t.noteId)}">
              ${escapeHtml(t.noteTitle)}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderTasks() {
    if (!tasksData) return;
    const { counts } = tasksData;
    const folders = [...new Set((tasksData.tasks || []).map((t) => t.noteFolder || 'Inbox'))].sort();
    const curFolder = filterFolder;
    folderFilterEl.innerHTML = [
      '<option value="all">All Folders</option>',
      ...folders.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
    ].join('');
    folderFilterEl.value = folders.includes(curFolder) ? curFolder : 'all';

    kpisEl.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">To Do</div>
        <div class="kpi-value" style="color:var(--accent)">${counts.todo}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">In Progress (#doing)</div>
        <div class="kpi-value" style="color:var(--cobalt)">${counts.doing}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Completed</div>
        <div class="kpi-value" style="color:var(--sage)">${counts.done}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Vault Tasks</div>
        <div class="kpi-value">${counts.total}</div>
      </div>
    `;

    const q = filterText.toLowerCase();
    const visible = (tasksData.tasks || []).filter((t) => {
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      if (filterFolder !== 'all' && (t.noteFolder || 'Inbox') !== filterFolder) return false;
      if (q && !t.text.toLowerCase().includes(q) && !t.noteTitle.toLowerCase().includes(q)) return false;
      return true;
    });

    const cols = [
      { title: 'To Do', items: visible.filter((t) => !t.done && !t.doing) },
      { title: 'In Progress', items: visible.filter((t) => !t.done && t.doing) },
      { title: 'Completed', items: visible.filter((t) => t.done) }
    ];

    kanbanEl.innerHTML = cols
      .map(
        (col) => `
          <section class="kanban-col" aria-label="${escapeHtml(col.title)} column">
            <div class="kanban-col-header">
              <span>${escapeHtml(col.title)}</span>
              <span class="meta-badge tabular">${col.items.length}</span>
            </div>
            ${
              col.items.length
                ? col.items.map(renderTaskCard).join('')
                : `<p style="font-size:12.5px;color:var(--ink-muted);margin:6px 0">No items here</p>`
            }
          </section>
        `
      )
      .join('');
  }

  async function loadTasks() {
    const res = await api.listTasks();
    if (destroyed) return;
    tasksData = res;
    renderTasks();
  }

  quickForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = quickInput.value.trim();
    if (!raw) return;
    const prio = quickPriority.value;
    const hasPrioTag = /!(high|medium|low)\b/i.test(raw);
    const taskLine = `- [ ] ${raw}${hasPrioTag ? '' : ` !${prio}`}`;
    try {
      const daily = await api.openDailyNote();
      const note = daily.note;
      const nextContent = `${note.content.replace(/\s+$/, '')}\n${taskLine}\n`;
      await api.updateNote(note.id, {
        title: note.title,
        content: nextContent,
        folder: note.folder,
        status: note.status,
        pinned: note.pinned
      });
      quickInput.value = '';
      showToast(`Added task to "${note.title}"`);
      await loadTasks();
      await actions.refreshCounts();
    } catch (err) {
      showToast(`Could not add task: ${err.message}`);
    }
  });

  kanbanEl.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-task-note]');
    if (!cb) return;
    const noteId = cb.dataset.taskNote;
    const lineNo = Number(cb.dataset.taskLine);
    const done = cb.checked;
    try {
      await api.toggleTask(noteId, lineNo, done);
      await loadTasks();
      await actions.refreshCounts();
      showToast(done ? 'Task marked complete' : 'Task reopened');
    } catch (err) {
      showToast(`Failed to toggle task: ${err.message}`);
      cb.checked = !done;
    }
  });

  kanbanEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-note]');
    if (btn) actions.openNote(btn.dataset.openNote);
  });

  container.querySelector('#btn-tasks-daily').addEventListener('click', () => {
    actions.openDailyNote();
  });

  searchEl.addEventListener('input', () => {
    filterText = searchEl.value.trim();
    renderTasks();
  });
  prioFilterEl.addEventListener('change', () => {
    filterPriority = prioFilterEl.value;
    renderTasks();
  });
  folderFilterEl.addEventListener('change', () => {
    filterFolder = folderFilterEl.value;
    renderTasks();
  });

  loadTasks();

  return {
    refresh: loadTasks,
    destroy: () => {
      destroyed = true;
    }
  };
}
