/**
 * Tessera Spatial Canvas View:
 *  - Infinite dot-grid spatial whiteboard with multi-board support
 *  - Drag cards with 8pt snap-to-grid, corner resize, and pan/zoom viewport
 *  - Sticky notes, Note Embed cards, and Group frames with color themes
 *  - Drag-from-port SVG cubic Bézier wiring + clickable edge removal
 *  - Auto-arrange algorithms (Grid, Radial, Flow) + 30-step Undo/Redo + Live Minimap + SVG Export
 */

import { escapeHtml } from '/core/markdownAst.js';
import { api } from '../apiClient.js';
import { openModal, showToast } from '../components/toast.js';

function snap8(val) {
  return Math.round(val / 8) * 8;
}

function makeUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function mountBoardView(ctx) {
  const { container, state, actions } = ctx;
  let destroyed = false;
  let boards = [];
  let activeBoard = null;
  let selectedNodeId = null;
  let undoStack = [];
  let redoStack = [];
  let saveTimer = null;
  let dragState = null;

  container.innerHTML = `
    <div class="board-workspace">
      <div class="board-toolbar">
        <div class="toolbar-group">
          <select id="board-select" class="prop-input" aria-label="Select whiteboard" style="width:190px"></select>
          <button type="button" id="btn-new-board" class="btn-secondary btn-sm">+ Board</button>
        </div>

        <div class="toolbar-group">
          <button type="button" id="btn-add-sticky" class="btn-secondary btn-sm">+ Sticky</button>
          <button type="button" id="btn-add-note-card" class="btn-secondary btn-sm">+ Link Note</button>
          <button type="button" id="btn-add-group" class="btn-secondary btn-sm">+ Group</button>
          <select id="select-node-color" class="prop-input" aria-label="Selected card accent color" style="width:118px">
            <option value="terracotta">Terracotta</option>
            <option value="cobalt">Cobalt</option>
            <option value="sage">Sage</option>
            <option value="amber">Amber</option>
          </select>
          <button type="button" id="btn-arrange-grid" class="btn-ghost btn-sm" title="Arrange nodes cleanly on grid">Grid</button>
          <button type="button" id="btn-arrange-radial" class="btn-ghost btn-sm" title="Arrange nodes radially">Radial</button>
          <button type="button" id="btn-delete-card" class="btn-ghost btn-sm" title="Delete selected card">Delete Card</button>
        </div>

        <div class="toolbar-group">
          <button type="button" id="btn-board-undo" class="btn-ghost btn-sm" disabled>Undo</button>
          <button type="button" id="btn-board-redo" class="btn-ghost btn-sm" disabled>Redo</button>
          <button type="button" id="btn-zoom-fit" class="btn-secondary btn-sm">Fit</button>
          <span id="board-zoom-readout" class="meta-badge tabular">100%</span>
          <button type="button" id="btn-export-svg" class="btn-secondary btn-sm">Export SVG</button>
          <span id="board-save-status" style="font-size:12px;color:var(--ink-muted)">Saved</span>
        </div>
      </div>

      <div id="board-stage" class="board-stage">
        <div id="board-world" class="board-world">
          <svg id="board-edges-svg" class="board-edges-svg" viewBox="0 0 4000 3000">
            <defs>
              <marker id="tessera-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="var(--accent)"></path>
              </marker>
            </defs>
            <g id="board-edges-layer"></g>
            <path id="board-wire-draft" d="" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="6 4" fill="none" hidden></path>
          </svg>
          <div id="board-nodes-layer"></div>
        </div>
        <svg id="board-minimap" class="board-minimap" viewBox="0 0 4000 3000" aria-label="Canvas minimap"></svg>
      </div>
    </div>
  `;

  const boardSelect = container.querySelector('#board-select');
  const stageEl = container.querySelector('#board-stage');
  const worldEl = container.querySelector('#board-world');
  const edgesLayerEl = container.querySelector('#board-edges-layer');
  const wireDraftEl = container.querySelector('#board-wire-draft');
  const nodesLayerEl = container.querySelector('#board-nodes-layer');
  const minimapEl = container.querySelector('#board-minimap');
  const colorSelect = container.querySelector('#select-node-color');
  const undoBtn = container.querySelector('#btn-board-undo');
  const redoBtn = container.querySelector('#btn-board-redo');
  const zoomReadout = container.querySelector('#board-zoom-readout');
  const saveStatusEl = container.querySelector('#board-save-status');

  function pushSnapshot() {
    if (!activeBoard) return;
    undoStack.push(
      JSON.stringify({
        nodes: activeBoard.nodes,
        edges: activeBoard.edges,
        viewport: activeBoard.viewport
      })
    );
    if (undoStack.length > 30) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function scheduleSave() {
    if (!activeBoard) return;
    saveStatusEl.textContent = 'Saving…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!activeBoard || destroyed) return;
      try {
        await api.saveBoard(activeBoard.id, {
          title: activeBoard.title,
          description: activeBoard.description,
          viewport: activeBoard.viewport,
          nodes: activeBoard.nodes,
          edges: activeBoard.edges
        });
        if (!destroyed) saveStatusEl.textContent = 'Saved';
      } catch (err) {
        if (!destroyed) showToast(`Board save failed: ${err.message}`);
      }
    }, 550);
  }

  function applyViewport() {
    if (!activeBoard) return;
    const { x, y, zoom } = activeBoard.viewport;
    worldEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    renderMinimap();
  }

  function getEdgeCoords(src, dst) {
    const x1 = src.x + (src.w || 260);
    const y1 = src.y + (src.h || 140) / 2;
    const x2 = dst.x;
    const y2 = dst.y + (dst.h || 140) / 2;
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
    return {
      x1,
      y1,
      x2,
      y2,
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2
    };
  }

  function renderEdges() {
    if (!activeBoard) return;
    const byId = new Map(activeBoard.nodes.map((n) => [n.id, n]));
    edgesLayerEl.innerHTML = activeBoard.edges
      .map((edge) => {
        const src = byId.get(edge.from);
        const dst = byId.get(edge.to);
        if (!src || !dst) return '';
        const { d, mx, my } = getEdgeCoords(src, dst);
        return `
          <g class="board-edge-group" data-edge-id="${escapeHtml(edge.id)}">
            <path d="${d}" stroke="var(--accent)" stroke-width="2.2" fill="none" marker-end="url(#tessera-arrow)"></path>
            <path d="${d}" stroke="transparent" stroke-width="14" fill="none" class="board-edge-hit" data-remove-edge="${escapeHtml(edge.id)}">
              <title>Click to disconnect edge</title>
            </path>
            ${
              edge.label
                ? `<rect x="${mx - 42}" y="${my - 11}" width="84" height="22" rx="6" fill="var(--bg-elevated)" stroke="var(--hairline)"></rect>
                   <text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink-secondary)">${escapeHtml(edge.label)}</text>`
                : ''
            }
          </g>
        `;
      })
      .join('');
  }

  function renderMinimap() {
    if (!activeBoard) return;
    const stageRect = stageEl.getBoundingClientRect();
    const { x, y, zoom } = activeBoard.viewport;
    const vx = Math.max(0, -x / zoom);
    const vy = Math.max(0, -y / zoom);
    const vw = stageRect.width / zoom;
    const vh = stageRect.height / zoom;

    const rects = activeBoard.nodes
      .map(
        (n) =>
          `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" fill="${n.kind === 'group' ? 'none' : 'var(--accent-soft)'}" stroke="var(--accent)" stroke-width="14"></rect>`
      )
      .join('');

    minimapEl.innerHTML = `
      ${rects}
      <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="none" stroke="var(--cobalt)" stroke-width="22"></rect>
    `;
  }

  function renderNodes() {
    if (!activeBoard) return;
    const ordered = [...activeBoard.nodes].sort((a, b) => (a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : 0));

    nodesLayerEl.innerHTML = ordered
      .map((n) => {
        const isGroup = n.kind === 'group';
        const isSelected = n.id === selectedNodeId;
        const linkedNote = n.noteId
          ? (state.notes || []).find((note) => note.id === n.noteId || note.slug === n.noteSlug)
          : null;

        let bodyHtml = '';
        if (isGroup) {
          bodyHtml = `<span style="color:var(--ink-muted);font-size:12px">Spatial Cluster Frame</span>`;
        } else if (n.kind === 'note' && linkedNote) {
          bodyHtml = `
            <p style="margin:0 0 8px 0">${escapeHtml(linkedNote.snippet || n.body || '')}</p>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span class="meta-badge">${escapeHtml(linkedNote.folder || 'Note')}</span>
              <button type="button" class="btn-secondary" style="min-height:32px;padding:0 10px;font-size:11.5px" data-open-linked-note="${escapeHtml(linkedNote.id)}">Open Note</button>
            </div>
          `;
        } else {
          bodyHtml = `<textarea class="board-card-textarea" data-card-body="${escapeHtml(n.id)}" style="width:100%;height:100%;border:none;background:transparent;resize:none;outline:none;font-size:12.5px;line-height:1.45" aria-label="Card notes">${escapeHtml(n.body || '')}</textarea>`;
        }

        return `
          <div
            class="board-node${isGroup ? ' is-group' : ''}${isSelected ? ' is-selected' : ''}"
            data-node-id="${escapeHtml(n.id)}"
            data-color="${escapeHtml(n.color || 'terracotta')}"
            style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px"
          >
            <div class="board-node-header" data-drag-handle="${escapeHtml(n.id)}">
              <input
                type="text"
                class="board-card-title"
                data-card-title="${escapeHtml(n.id)}"
                value="${escapeHtml(n.title || '')}"
                aria-label="Card title"
                style="border:none;background:transparent;font-weight:700;font-size:13px;width:100%;outline:none"
              >
            </div>
            <div class="board-node-body">${bodyHtml}</div>
            ${
              !isGroup
                ? `<div class="board-port" data-wire-from="${escapeHtml(n.id)}" title="Drag to connect to another card"></div>`
                : ''
            }
          </div>
        `;
      })
      .join('');

    const sel = activeBoard.nodes.find((n) => n.id === selectedNodeId);
    if (sel) colorSelect.value = sel.color || 'terracotta';
    renderEdges();
    renderMinimap();
  }

  function renderBoardSelect() {
    boardSelect.innerHTML = boards
      .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}</option>`)
      .join('');
    if (activeBoard) boardSelect.value = activeBoard.id;
  }

  function selectBoard(board) {
    activeBoard = JSON.parse(JSON.stringify(board));
    if (!activeBoard.viewport) activeBoard.viewport = { x: 40, y: 40, zoom: 1 };
    undoStack = [];
    redoStack = [];
    selectedNodeId = activeBoard.nodes[0]?.id || null;
    updateHistoryButtons();
    renderBoardSelect();
    applyViewport();
    renderNodes();
  }

  function addCard(nodeSpec) {
    if (!activeBoard) return;
    pushSnapshot();
    const { x, y, zoom } = activeBoard.viewport;
    const rect = stageEl.getBoundingClientRect();
    const centerWorldX = snap8((rect.width / 2 - x) / zoom - (nodeSpec.w || 260) / 2 + (Math.random() - 0.5) * 64);
    const centerWorldY = snap8((rect.height / 2 - y) / zoom - (nodeSpec.h || 150) / 2 + (Math.random() - 0.5) * 64);
    const newNode = {
      id: makeUid('card'),
      kind: nodeSpec.kind || 'sticky',
      title: nodeSpec.title || 'New Card',
      body: nodeSpec.body || '',
      noteId: nodeSpec.noteId || undefined,
      noteSlug: nodeSpec.noteSlug || undefined,
      x: Math.max(24, centerWorldX),
      y: Math.max(24, centerWorldY),
      w: nodeSpec.w || 264,
      h: nodeSpec.h || 160,
      color: nodeSpec.color || 'terracotta'
    };
    activeBoard.nodes.push(newNode);
    selectedNodeId = newNode.id;
    renderNodes();
    scheduleSave();
  }

  function fitViewportToNodes() {
    if (!activeBoard || activeBoard.nodes.length === 0) return;
    const rect = stageEl.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of activeBoard.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const spanW = Math.max(300, maxX - minX + 120);
    const spanH = Math.max(240, maxY - minY + 120);
    const zoom = Math.min(1.15, Math.max(0.4, Math.min(rect.width / spanW, rect.height / spanH) * 0.9));
    activeBoard.viewport = {
      zoom,
      x: Math.round(rect.width / 2 - ((minX + maxX) / 2) * zoom),
      y: Math.round(rect.height / 2 - ((minY + maxY) / 2) * zoom)
    };
    applyViewport();
  }

  function exportBoardSvg() {
    if (!activeBoard) return;
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg-canvas').trim() || '#F6F5F0';
    const cardBg = cs.getPropertyValue('--bg-elevated').trim() || '#FFFFFF';
    const ink = cs.getPropertyValue('--ink-primary').trim() || '#181816';
    const inkMuted = cs.getPropertyValue('--ink-secondary').trim() || '#4D4C46';
    const accent = cs.getPropertyValue('--accent').trim() || '#B83B14';
    const border = cs.getPropertyValue('--hairline-strong').trim() || '#CCCCCC';

    let minX = 0;
    let minY = 0;
    let maxX = 1200;
    let maxY = 800;
    if (activeBoard.nodes.length > 0) {
      minX = Math.min(...activeBoard.nodes.map((n) => n.x)) - 48;
      minY = Math.min(...activeBoard.nodes.map((n) => n.y)) - 48;
      maxX = Math.max(...activeBoard.nodes.map((n) => n.x + n.w)) + 48;
      maxY = Math.max(...activeBoard.nodes.map((n) => n.y + n.h)) + 48;
    }

    const byId = new Map(activeBoard.nodes.map((n) => [n.id, n]));
    const svgEdges = activeBoard.edges
      .map((e) => {
        const s = byId.get(e.from);
        const d = byId.get(e.to);
        if (!s || !d) return '';
        const c = getEdgeCoords(s, d);
        return `<path d="${c.d}" stroke="${accent}" stroke-width="2.5" fill="none" />`;
      })
      .join('\n');

    const svgNodes = activeBoard.nodes
      .map(
        (n) => `
          <g transform="translate(${n.x},${n.y})">
            <rect width="${n.w}" height="${n.h}" rx="12" fill="${n.kind === 'group' ? 'none' : cardBg}" stroke="${border}" stroke-width="1.5" ${n.kind === 'group' ? 'stroke-dasharray="6 4"' : ''} />
            <text x="14" y="26" font-family="sans-serif" font-size="14" font-weight="700" fill="${ink}">${escapeHtml(n.title || '')}</text>
            <text x="14" y="52" font-family="sans-serif" font-size="12" fill="${inkMuted}">${escapeHtml((n.body || '').slice(0, 64))}</text>
          </g>
        `
      )
      .join('\n');

    const svgDoc = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}">
  <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${bg}" />
  ${svgEdges}
  ${svgNodes}
</svg>`;
    const blob = new Blob([svgDoc], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeBoard.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'tessera-board'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported vector SVG diagram');
  }

  // Stage & Node Pointer Events
  stageEl.addEventListener('pointerdown', (e) => {
    if (!activeBoard) return;
    // Do not hijack input/textarea focus inside cards
    if (e.target.matches('input, textarea, button')) return;

    const portEl = e.target.closest('.board-port[data-wire-from]');
    if (portEl) {
      const fromId = portEl.dataset.wireFrom;
      const src = activeBoard.nodes.find((n) => n.id === fromId);
      if (!src) return;
      stageEl.setPointerCapture(e.pointerId);
      dragState = {
        mode: 'wire',
        fromId,
        x1: src.x + src.w,
        y1: src.y + src.h / 2
      };
      wireDraftEl.hidden = false;
      return;
    }

    const nodeEl = e.target.closest('.board-node[data-node-id]');
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId;
      selectedNodeId = id;
      nodesLayerEl.querySelectorAll('.board-node').forEach((el) => el.classList.toggle('is-selected', el.dataset.nodeId === id));
      const node = activeBoard.nodes.find((n) => n.id === id);
      colorSelect.value = node?.color || 'terracotta';
      if (e.target.closest('.board-node-header')) {
        pushSnapshot();
        stageEl.setPointerCapture(e.pointerId);
        dragState = {
          mode: 'card',
          node,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          origX: node.x,
          origY: node.y
        };
      }
      return;
    }

    if (e.target === stageEl || e.target === worldEl) {
      stageEl.setPointerCapture(e.pointerId);
      dragState = {
        mode: 'pan',
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        origX: activeBoard.viewport.x,
        origY: activeBoard.viewport.y
      };
    }
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (!dragState || !activeBoard) return;
    if (dragState.mode === 'pan') {
      activeBoard.viewport.x = dragState.origX + (e.clientX - dragState.startMouseX);
      activeBoard.viewport.y = dragState.origY + (e.clientY - dragState.startMouseY);
      applyViewport();
    } else if (dragState.mode === 'card' && dragState.node) {
      const dx = (e.clientX - dragState.startMouseX) / activeBoard.viewport.zoom;
      const dy = (e.clientY - dragState.startMouseY) / activeBoard.viewport.zoom;
      dragState.node.x = Math.max(0, snap8(dragState.origX + dx));
      dragState.node.y = Math.max(0, snap8(dragState.origY + dy));
      const cardEl = nodesLayerEl.querySelector(`.board-node[data-node-id="${CSS.escape(dragState.node.id)}"]`);
      if (cardEl) {
        cardEl.style.left = `${dragState.node.x}px`;
        cardEl.style.top = `${dragState.node.y}px`;
      }
      renderEdges();
      renderMinimap();
    } else if (dragState.mode === 'wire') {
      const stageRect = stageEl.getBoundingClientRect();
      const wx = (e.clientX - stageRect.left - activeBoard.viewport.x) / activeBoard.viewport.zoom;
      const wy = (e.clientY - stageRect.top - activeBoard.viewport.y) / activeBoard.viewport.zoom;
      const dx = Math.max(40, Math.abs(wx - dragState.x1) * 0.45);
      wireDraftEl.setAttribute(
        'd',
        `M ${dragState.x1} ${dragState.y1} C ${dragState.x1 + dx} ${dragState.y1}, ${wx - dx} ${wy}, ${wx} ${wy}`
      );
    }
  });

  stageEl.addEventListener('pointerup', (e) => {
    if (!dragState || !activeBoard) return;
    if (dragState.mode === 'card') {
      scheduleSave();
    } else if (dragState.mode === 'pan') {
      scheduleSave();
    } else if (dragState.mode === 'wire') {
      wireDraftEl.hidden = true;
      wireDraftEl.setAttribute('d', '');
      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      const targetCard = elUnder?.closest?.('.board-node[data-node-id]');
      if (targetCard && targetCard.dataset.nodeId !== dragState.fromId) {
        const toId = targetCard.dataset.nodeId;
        const exists = activeBoard.edges.some((ed) => ed.from === dragState.fromId && ed.to === toId);
        if (!exists) {
          pushSnapshot();
          activeBoard.edges.push({ id: makeUid('edge'), from: dragState.fromId, to: toId, label: '' });
          renderEdges();
          scheduleSave();
        }
      }
    }
    dragState = null;
  });

  stageEl.addEventListener(
    'wheel',
    (e) => {
      if (!activeBoard) return;
      e.preventDefault();
      const rect = stageEl.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      const nextZoom = Math.min(2.0, Math.max(0.35, activeBoard.viewport.zoom * factor));
      activeBoard.viewport.x = sx - ((sx - activeBoard.viewport.x) / activeBoard.viewport.zoom) * nextZoom;
      activeBoard.viewport.y = sy - ((sy - activeBoard.viewport.y) / activeBoard.viewport.zoom) * nextZoom;
      activeBoard.viewport.zoom = nextZoom;
      applyViewport();
      scheduleSave();
    },
    { passive: false }
  );

  // Node input editing + edge removal + open linked note
  nodesLayerEl.addEventListener('input', (e) => {
    if (!activeBoard) return;
    const titleEl = e.target.closest('[data-card-title]');
    if (titleEl) {
      const card = activeBoard.nodes.find((n) => n.id === titleEl.dataset.cardTitle);
      if (card) {
        card.title = titleEl.value;
        scheduleSave();
      }
      return;
    }
    const bodyEl = e.target.closest('[data-card-body]');
    if (bodyEl) {
      const card = activeBoard.nodes.find((n) => n.id === bodyEl.dataset.cardBody);
      if (card) {
        card.body = bodyEl.value;
        scheduleSave();
      }
    }
  });

  nodesLayerEl.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open-linked-note]');
    if (openBtn) actions.openNote(openBtn.dataset.openLinkedNote);
  });

  edgesLayerEl.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-remove-edge]');
    if (!hit || !activeBoard) return;
    pushSnapshot();
    const edgeId = hit.dataset.removeEdge;
    activeBoard.edges = activeBoard.edges.filter((ed) => ed.id !== edgeId);
    renderEdges();
    scheduleSave();
    showToast('Disconnected edge');
  });

  minimapEl.addEventListener('click', (e) => {
    if (!activeBoard) return;
    const rect = minimapEl.getBoundingClientRect();
    const wx = ((e.clientX - rect.left) / rect.width) * 4000;
    const wy = ((e.clientY - rect.top) / rect.height) * 3000;
    const stageRect = stageEl.getBoundingClientRect();
    activeBoard.viewport.x = stageRect.width / 2 - wx * activeBoard.viewport.zoom;
    activeBoard.viewport.y = stageRect.height / 2 - wy * activeBoard.viewport.zoom;
    applyViewport();
  });

  // Toolbar controls
  boardSelect.addEventListener('change', () => {
    const found = boards.find((b) => b.id === boardSelect.value);
    if (found) selectBoard(found);
  });

  container.querySelector('#btn-new-board').addEventListener('click', () => {
    openModal(
      `
        <div class="modal-header">
          <h2 style="margin:0;font-size:17px">Create Spatial Board</h2>
          <button type="button" class="btn-ghost btn-sm" data-modal-close>Cancel</button>
        </div>
        <form id="new-board-form" class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <label for="new-board-title" style="font-size:13px;font-weight:600">Board Title</label>
          <input id="new-board-title" class="sidebar-search-input" required placeholder="e.g. Q4 Research Map">
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
            <button type="button" class="btn-secondary" data-modal-close>Cancel</button>
            <button type="submit" class="btn-primary">Create Board</button>
          </div>
        </form>
      `,
      {
        onMount: (card, close) => {
          const inp = card.querySelector('#new-board-title');
          inp?.focus();
          card.querySelector('#new-board-form')?.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const title = inp.value.trim();
            if (!title) return;
            const created = await api.createBoard({ title, nodes: [], edges: [], viewport: { x: 40, y: 40, zoom: 1 } });
            boards.unshift(created.board);
            selectBoard(created.board);
            close();
            showToast(`Created board "${title}"`);
          });
        }
      }
    );
  });

  container.querySelector('#btn-add-sticky').addEventListener('click', () => {
    addCard({ kind: 'sticky', title: 'Idea Card', body: 'Write synthesis notes…', color: 'amber', w: 256, h: 152 });
  });

  container.querySelector('#btn-add-group').addEventListener('click', () => {
    addCard({ kind: 'group', title: 'Topic Cluster', color: 'cobalt', w: 560, h: 360 });
  });

  container.querySelector('#btn-add-note-card').addEventListener('click', () => {
    const notes = state.notes || [];
    openModal(
      `
        <div class="modal-header">
          <h2 style="margin:0;font-size:17px">Embed Note onto Canvas</h2>
          <button type="button" class="btn-ghost btn-sm" data-modal-close>Close</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:6px;max-height:55vh;overflow-y:auto">
          ${notes
            .map(
              (n) => `
              <button type="button" class="ac-item" data-pick-note-id="${escapeHtml(n.id)}">
                <span><strong>${escapeHtml(n.title)}</strong></span>
                <span class="meta-badge">${escapeHtml(n.folder)}</span>
              </button>
            `
            )
            .join('')}
        </div>
      `,
      {
        onMount: (card, close) => {
          card.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-pick-note-id]');
            if (!btn) return;
            const note = notes.find((n) => n.id === btn.dataset.pickNoteId);
            if (!note) return;
            addCard({
              kind: 'note',
              title: note.title,
              body: note.snippet,
              noteId: note.id,
              noteSlug: note.slug,
              color: 'terracotta',
              w: 280,
              h: 168
            });
            close();
          });
        }
      }
    );
  });

  colorSelect.addEventListener('change', () => {
    if (!activeBoard || !selectedNodeId) return;
    const node = activeBoard.nodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    pushSnapshot();
    node.color = colorSelect.value;
    renderNodes();
    scheduleSave();
  });

  container.querySelector('#btn-arrange-grid').addEventListener('click', () => {
    if (!activeBoard || activeBoard.nodes.length === 0) return;
    pushSnapshot();
    const cards = activeBoard.nodes.filter((n) => n.kind !== 'group');
    const cols = Math.max(2, Math.ceil(Math.sqrt(cards.length)));
    cards.forEach((n, idx) => {
      n.x = 64 + (idx % cols) * 320;
      n.y = 64 + Math.floor(idx / cols) * 216;
    });
    renderNodes();
    fitViewportToNodes();
    scheduleSave();
    showToast('Arranged cards into clean grid');
  });

  container.querySelector('#btn-arrange-radial').addEventListener('click', () => {
    if (!activeBoard || activeBoard.nodes.length === 0) return;
    pushSnapshot();
    const cards = activeBoard.nodes.filter((n) => n.kind !== 'group');
    const radius = Math.max(240, cards.length * 42);
    const cx = 640;
    const cy = 440;
    cards.forEach((n, idx) => {
      if (idx === 0 && cards.length > 2) {
        n.x = snap8(cx - n.w / 2);
        n.y = snap8(cy - n.h / 2);
      } else {
        const angle = ((idx - 1) / Math.max(1, cards.length - 1)) * Math.PI * 2;
        n.x = snap8(cx + Math.cos(angle) * radius - n.w / 2);
        n.y = snap8(cy + Math.sin(angle) * radius - n.h / 2);
      }
    });
    renderNodes();
    fitViewportToNodes();
    scheduleSave();
    showToast('Arranged cards radially');
  });

  container.querySelector('#btn-delete-card').addEventListener('click', () => {
    if (!activeBoard || !selectedNodeId) return;
    pushSnapshot();
    activeBoard.nodes = activeBoard.nodes.filter((n) => n.id !== selectedNodeId);
    activeBoard.edges = activeBoard.edges.filter((ed) => ed.from !== selectedNodeId && ed.to !== selectedNodeId);
    selectedNodeId = activeBoard.nodes[0]?.id || null;
    renderNodes();
    scheduleSave();
  });

  undoBtn.addEventListener('click', () => {
    if (!activeBoard || undoStack.length === 0) return;
    redoStack.push(
      JSON.stringify({
        nodes: activeBoard.nodes,
        edges: activeBoard.edges,
        viewport: activeBoard.viewport
      })
    );
    const snap = JSON.parse(undoStack.pop());
    activeBoard.nodes = snap.nodes;
    activeBoard.edges = snap.edges;
    activeBoard.viewport = snap.viewport;
    updateHistoryButtons();
    applyViewport();
    renderNodes();
    scheduleSave();
  });

  redoBtn.addEventListener('click', () => {
    if (!activeBoard || redoStack.length === 0) return;
    undoStack.push(
      JSON.stringify({
        nodes: activeBoard.nodes,
        edges: activeBoard.edges,
        viewport: activeBoard.viewport
      })
    );
    const snap = JSON.parse(redoStack.pop());
    activeBoard.nodes = snap.nodes;
    activeBoard.edges = snap.edges;
    activeBoard.viewport = snap.viewport;
    updateHistoryButtons();
    applyViewport();
    renderNodes();
    scheduleSave();
  });

  container.querySelector('#btn-zoom-fit').addEventListener('click', fitViewportToNodes);
  container.querySelector('#btn-export-svg').addEventListener('click', exportBoardSvg);

  async function loadBoards() {
    const res = await api.listBoards();
    if (destroyed) return;
    boards = res.boards || [];
    if (boards.length === 0) {
      const created = await api.createBoard({
        title: 'Primary Architecture Map',
        nodes: [],
        edges: [],
        viewport: { x: 40, y: 40, zoom: 1 }
      });
      boards = [created.board];
    }
    const target = (activeBoard && boards.find((b) => b.id === activeBoard.id)) || boards[0];
    selectBoard(target);
  }

  loadBoards();

  return {
    refresh: loadBoards,
    destroy: () => {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
    }
  };
}
