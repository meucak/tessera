import { api } from '../apiClient.js';
import { escapeHtml } from '/core/markdownAst.js';
import { openModal, showToast } from './toast.js';

function renderWordDiffHtml(wordDiff, fallbackText) {
  if (!Array.isArray(wordDiff) || wordDiff.length === 0) {
    return escapeHtml(fallbackText);
  }
  return wordDiff
    .map((p) => {
      if (p.type === 'add') return `<span class="diff-word-add">${escapeHtml(p.text)}</span>`;
      if (p.type === 'del') return `<span class="diff-word-del">${escapeHtml(p.text)}</span>`;
      return escapeHtml(p.text);
    })
    .join('');
}

/**
 * Version Time-Travel & Myers Line Diff Modal.
 */
export async function openDiffModal(noteId, noteTitle, onRestored) {
  let versionsData;
  try {
    versionsData = await api.getVersions(noteId);
  } catch (err) {
    showToast(`Could not load version history: ${err.message}`);
    return;
  }

  const versions = versionsData.versions || [];
  if (versions.length === 0) {
    showToast('No saved snapshots for this note yet.');
    return;
  }

  const defaultFrom = versions.length > 1 ? versions[1].id : versions[0].id;

  openModal(
    `
    <div class="modal-header">
      <div>
        <strong>Version History — ${escapeHtml(noteTitle)}</strong>
        <div style="font-size:12px;color:var(--ink-secondary);">${versions.length} snapshot(s) stored in SQLite</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button type="button" id="btn-restore-ver" class="btn-primary btn-sm">Restore Selected</button>
        <button type="button" class="btn-secondary btn-sm" data-modal-close>Close</button>
      </div>
    </div>
    <div class="modal-body">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <span>From:</span>
          <select id="diff-from-select" class="prop-input" style="width:auto;min-width:220px;">
            ${versions
              .map(
                (v) =>
                  `<option value="${v.id}" ${v.id === defaultFrom ? 'selected' : ''}>#${v.id} • ${new Date(v.createdAt).toLocaleString()}${v.label ? ' — ' + escapeHtml(v.label) : ''}</option>`
              )
              .join('')}
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <span>Compare To:</span>
          <select id="diff-to-select" class="prop-input" style="width:auto;min-width:200px;">
            <option value="current" selected>Current Working Note</option>
            ${versions
              .map(
                (v) =>
                  `<option value="${v.id}">#${v.id} • ${new Date(v.createdAt).toLocaleString()}</option>`
              )
              .join('')}
          </select>
        </label>
        <span id="diff-stats-pill" class="sync-pill"></span>
      </div>
      <div id="diff-view-container" class="diff-table"></div>
    </div>
    `,
    {
      wide: true,
      onMount: (dialog, close) => {
        const fromSel = dialog.querySelector('#diff-from-select');
        const toSel = dialog.querySelector('#diff-to-select');
        const statsPill = dialog.querySelector('#diff-stats-pill');
        const container = dialog.querySelector('#diff-view-container');
        const restoreBtn = dialog.querySelector('#btn-restore-ver');

        const loadDiff = async () => {
          try {
            const data = await api.getDiff(noteId, fromSel.value, toSel.value);
            const st = data.diff.stats;
            statsPill.textContent = `+${st.added} / -${st.removed} lines (${st.unchanged} unchanged)`;
            container.innerHTML = data.diff.hunks
              .map((h) => {
                const cls = h.type === 'add' ? 'is-add' : h.type === 'delete' ? 'is-delete' : '';
                const sym = h.type === 'add' ? '+' : h.type === 'delete' ? '-' : ' ';
                return `<div class="diff-row ${cls}">
                  <span class="diff-ln">${h.oldLine ?? ''}</span>
                  <span class="diff-ln">${h.newLine ?? ''}</span>
                  <span>${sym}</span>
                  <span>${renderWordDiffHtml(h.wordDiff, h.text)}</span>
                </div>`;
              })
              .join('');
          } catch (err) {
            container.innerHTML = `<div style="padding:12px;color:var(--danger);">${escapeHtml(err.message)}</div>`;
          }
        };

        fromSel.addEventListener('change', loadDiff);
        toSel.addEventListener('change', loadDiff);

        restoreBtn.addEventListener('click', async () => {
          try {
            const restored = await api.restoreVersion(noteId, fromSel.value);
            showToast(`Restored snapshot #${fromSel.value}`);
            close();
            if (onRestored) onRestored(restored);
          } catch (err) {
            showToast(`Restore failed: ${err.message}`);
          }
        });

        loadDiff();
      }
    }
  );
}
