import { api } from '../apiClient.js';
import { openModal, showToast } from './toast.js';

/**
 * Vault Backup (ZIP / JSON Export & Import) + Keyboard Shortcuts Reference Modal.
 */
export function openVaultModal({ onImported }) {
  openModal(
    `
    <div class="modal-header">
      <strong>Vault Backup, Import & Shortcuts</strong>
      <button type="button" class="btn-secondary btn-sm" data-modal-close>Close</button>
    </div>
    <div class="modal-body">
      <section style="display:flex;flex-direction:column;gap:8px;">
        <h3 style="margin:0;font-size:14px;">Export Complete Vault</h3>
        <p style="margin:0;font-size:13px;color:var(--ink-secondary);">Download all Markdown notes, spatial boards, and FSRS memory metrics as a standard ZIP archive or lossless JSON bundle.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <a href="/api/vault/export?format=zip" download class="btn-primary btn-sm" style="text-decoration:none;">Download ZIP Archive (.zip)</a>
          <a href="/api/vault/export?format=json" download class="btn-secondary btn-sm" style="text-decoration:none;">Download JSON Bundle (.json)</a>
        </div>
      </section>

      <hr style="border:none;border-top:1px solid var(--hairline);width:100%;">

      <section style="display:flex;flex-direction:column;gap:8px;">
        <h3 style="margin:0;font-size:14px;">Import Markdown Files or Vault Bundle</h3>
        <p style="margin:0;font-size:13px;color:var(--ink-secondary);">Select one or more <code>.md</code> files or a previously exported <code>.json</code> / <code>.zip</code> vault.</p>
        <input type="file" id="vault-import-input" accept=".md,.markdown,.json,.zip" multiple style="padding:10px;border:1px dashed var(--hairline-strong);border-radius:var(--radius-md);background:var(--bg-canvas);">
      </section>

      <hr style="border:none;border-top:1px solid var(--hairline);width:100%;">

      <section style="display:flex;flex-direction:column;gap:8px;">
        <h3 style="margin:0;font-size:14px;">Keyboard Shortcuts</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;font-size:12.5px;">
          <div><kbd class="kbd-chip">Ctrl / Cmd + K</kbd> Command Palette & Search</div>
          <div><kbd class="kbd-chip">1 – 5</kbd> Switch Workspaces</div>
          <div><kbd class="kbd-chip">T</kbd> Cycle Light / Sepia / Dark</div>
          <div><kbd class="kbd-chip">Space</kbd> Flip Flashcard (Recall)</div>
          <div><kbd class="kbd-chip">1 – 4</kbd> Rate Card (Again–Easy)</div>
          <div><kbd class="kbd-chip">[[</kbd> &amp; <kbd class="kbd-chip">/</kbd> Autocomplete in Editor</div>
        </div>
      </section>
    </div>
    `,
    {
      onMount: (dialog, close) => {
        const fileInput = dialog.querySelector('#vault-import-input');
        fileInput.addEventListener('change', async () => {
          const files = [...(fileInput.files || [])];
          if (files.length === 0) return;

          try {
            let totalNotes = 0;
            let totalBoards = 0;
            const mdFiles = [];

            for (const f of files) {
              if (f.name.endsWith('.json')) {
                const json = JSON.parse(await f.text());
                const res = await api.importVault(json);
                totalNotes += res.importedNotes;
                totalBoards += res.importedBoards;
              } else if (f.name.endsWith('.zip')) {
                const buf = await f.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                const res = await api.importVault({ zipBase64: btoa(bin) });
                totalNotes += res.importedNotes;
                totalBoards += res.importedBoards;
              } else {
                mdFiles.push({ name: f.name, content: await f.text() });
              }
            }

            if (mdFiles.length > 0) {
              const res = await api.importVault({ files: mdFiles });
              totalNotes += res.importedNotes;
            }

            showToast(`Imported ${totalNotes} note(s) and ${totalBoards} board(s)`);
            close();
            if (onImported) onImported();
          } catch (err) {
            showToast(`Import failed: ${err.message}`);
          }
        });
      }
    }
  );
}
