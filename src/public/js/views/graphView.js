/**
 * Tessera Knowledge Graph View:
 *  - HiDPI Canvas force-directed layout initialized in cluster rings
 *  - PageRank node radius scaling, semantic cluster colors, ghost link dashed rings
 *  - Pan / zoom / drag nodes / click quick-peek / double-click open in Studio
 *  - Shortest Path Finder (BFS) highlighting trace across nodes & edges
 *  - Graph Health Diagnostics (Hubs, Orphans, Ghost Links)
 */

import { escapeHtml } from '/core/markdownAst.js';
import { api } from '../apiClient.js';
import { showToast } from '../components/toast.js';

function getThemePalette() {
  const cs = getComputedStyle(document.documentElement);
  const read = (v, fb) => cs.getPropertyValue(v).trim() || fb;
  return {
    bgCanvas: read('--bg-canvas', '#F6F5F0'),
    bgElevated: read('--bg-elevated', '#FFFFFF'),
    inkPrimary: read('--ink-primary', '#181816'),
    inkSecondary: read('--ink-secondary', '#4D4C46'),
    inkMuted: read('--ink-muted', '#65645D'),
    hairline: read('--hairline', 'rgba(24,24,22,0.12)'),
    hairlineStrong: read('--hairline-strong', 'rgba(24,24,22,0.28)'),
    accent: read('--accent', '#B83B14'),
    sage: read('--sage', '#166534'),
    cobalt: read('--cobalt', '#1E40AF'),
    amber: read('--amber', '#92400E'),
    danger: read('--danger', '#B91C1C')
  };
}

export function mountGraphView(ctx) {
  const { container, actions } = ctx;
  let destroyed = false;
  let graphData = null;
  let simNodes = [];
  let simNodeById = new Map();
  let simEdges = [];
  let includeGhosts = true;
  let searchFilter = '';
  let selectedNodeId = null;
  let hoveredNodeId = null;
  let pathResult = null;
  let rafId = null;
  let simAlpha = 1.0;

  // Camera transform in screen CSS pixels
  const cam = { x: 0, y: 0, zoom: 1, initialized: false };
  let interaction = {
    mode: null, // 'pan' | 'drag'
    dragNode: null,
    startX: 0,
    startY: 0,
    camStartX: 0,
    camStartY: 0,
    moved: false
  };

  container.innerHTML = `
    <div class="graph-workspace">
      <div class="graph-canvas-wrap">
        <canvas id="graph-canvas" class="graph-canvas" aria-label="Interactive Knowledge Graph"></canvas>
        <div class="graph-floating-bar">
          <div class="floating-panel">
            <input
              type="search"
              id="graph-search-input"
              class="prop-input"
              style="width:170px"
              placeholder="Filter node…"
              aria-label="Filter graph nodes"
            >
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;min-height:36px;cursor:pointer">
              <input type="checkbox" id="graph-toggle-ghosts" checked>
              <span>Ghosts</span>
            </label>
            <button type="button" id="btn-graph-fit" class="btn-secondary btn-sm">Fit</button>
          </div>

          <div class="floating-panel">
            <select id="path-source-select" class="prop-input" aria-label="Path start note" style="width:136px"></select>
            <span style="color:var(--ink-muted);font-weight:700">→</span>
            <select id="path-target-select" class="prop-input" aria-label="Path end note" style="width:136px"></select>
            <button type="button" id="btn-find-path" class="btn-primary btn-sm">Path</button>
            <button type="button" id="btn-clear-path" class="btn-ghost btn-sm" hidden>Clear</button>
          </div>
        </div>
      </div>

      <aside id="graph-sidebar" class="graph-sidebar" aria-label="Graph Inspector and Health"></aside>
    </div>
  `;

  const canvas = container.querySelector('#graph-canvas');
  const ctx2d = canvas.getContext('2d');
  const searchInput = container.querySelector('#graph-search-input');
  const ghostCheckbox = container.querySelector('#graph-toggle-ghosts');
  const fitBtn = container.querySelector('#btn-graph-fit');
  const pathSourceSel = container.querySelector('#path-source-select');
  const pathTargetSel = container.querySelector('#path-target-select');
  const findPathBtn = container.querySelector('#btn-find-path');
  const clearPathBtn = container.querySelector('#btn-clear-path');
  const sidebarEl = container.querySelector('#graph-sidebar');

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    if (!cam.initialized) {
      cam.x = w / 2;
      cam.y = h / 2;
      cam.zoom = 1;
      cam.initialized = true;
    }
    return { w, h, dpr };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - cam.x) / cam.zoom,
      y: (sy - cam.y) / cam.zoom
    };
  }

  function fitGraph() {
    if (simNodes.length === 0) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of simNodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const spanX = Math.max(200, maxX - minX + 140);
    const spanY = Math.max(200, maxY - minY + 160);
    const zoom = Math.min(1.5, Math.max(0.35, Math.min(rect.width / spanX, rect.height / spanY) * 0.85));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    cam.zoom = zoom;
    cam.x = rect.width / 2 - cx * zoom;
    cam.y = rect.height / 2 - cy * zoom;
  }

  function seedSimulationPositions(rawGraph) {
    const prevPos = new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
    const count = rawGraph.nodes.length;
    const clusterRingRadius = Math.max(110, Math.sqrt(count) * 44);

    simNodes = rawGraph.nodes.map((node, idx) => {
      const prev = prevPos.get(node.id);
      if (prev) {
        return {
          ...node,
          x: prev.x,
          y: prev.y,
          vx: prev.vx * 0.5,
          vy: prev.vy * 0.5,
          radius: node.isGhost ? 9 : Math.max(11, Math.min(26, 10 + Math.sqrt((node.pagerank || 0.05) * 420) + node.degree * 1.1))
        };
      }
      const clusterAngle = ((node.clusterId || 0) * 1.9) + (idx / Math.max(1, count)) * Math.PI * 2;
      const rJitter = clusterRingRadius * (node.isGhost ? 1.25 : 0.72 + (idx % 4) * 0.14);
      return {
        ...node,
        x: Math.cos(clusterAngle) * rJitter,
        y: Math.sin(clusterAngle) * rJitter,
        vx: 0,
        vy: 0,
        radius: node.isGhost ? 9 : Math.max(11, Math.min(26, 10 + Math.sqrt((node.pagerank || 0.05) * 420) + node.degree * 1.1))
      };
    });

    simNodeById = new Map(simNodes.map((n) => [n.id, n]));
    simEdges = rawGraph.edges
      .map((e) => ({
        ...e,
        src: simNodeById.get(e.source),
        dst: simNodeById.get(e.target)
      }))
      .filter((e) => e.src && e.dst);
    simAlpha = 1.0;
  }

  function stepPhysics() {
    if (simAlpha < 0.008 || simNodes.length === 0) return;

    const repulsion = 4200;
    const springLen = 115;
    const springK = 0.032;
    const gravity = 0.015;
    const damping = 0.82;

    // Pairwise repulsion
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 25) {
          dx = (Math.random() - 0.5) * 4;
          dy = (Math.random() - 0.5) * 4;
          d2 = 25;
        }
        const dist = Math.sqrt(d2);
        const force = (repulsion / d2) * simAlpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Hooke springs along edges
    for (const edge of simEdges) {
      const dx = edge.dst.x - edge.src.x;
      const dy = edge.dst.y - edge.src.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const targetLen = edge.isGhost ? springLen * 0.9 : springLen;
      const f = (dist - targetLen) * springK * simAlpha;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      edge.src.vx += fx;
      edge.src.vy += fy;
      edge.dst.vx -= fx;
      edge.dst.vy -= fy;
    }

    // Center gravity & velocity integration
    for (const node of simNodes) {
      if (interaction.dragNode === node) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx = (node.vx - node.x * gravity * simAlpha) * damping;
      node.vy = (node.vy - node.y * gravity * simAlpha) * damping;
      node.x += node.vx;
      node.y += node.vy;
    }

    simAlpha *= 0.985;
  }

  function drawGraph() {
    if (destroyed) return;
    stepPhysics();

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const pal = getThemePalette();
    const clusterColors = [pal.accent, pal.cobalt, pal.sage, pal.amber, '#0F766E', '#9F1239'];

    ctx2d.save();
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);

    // Background dot grid in screen space synced with pan/zoom
    const gridGap = 28 * cam.zoom;
    if (gridGap > 10) {
      const offX = ((cam.x % gridGap) + gridGap) % gridGap;
      const offY = ((cam.y % gridGap) + gridGap) % gridGap;
      ctx2d.fillStyle = pal.hairline;
      for (let gx = offX; gx < w; gx += gridGap) {
        for (let gy = offY; gy < h; gy += gridGap) {
          ctx2d.fillRect(gx, gy, 1.5, 1.5);
        }
      }
    }

    ctx2d.translate(cam.x, cam.y);
    ctx2d.scale(cam.zoom, cam.zoom);

    const activeFocusId = hoveredNodeId || selectedNodeId;
    const neighborSet = new Set();
    if (activeFocusId) {
      neighborSet.add(activeFocusId);
      for (const e of simEdges) {
        if (e.source === activeFocusId) neighborSet.add(e.target);
        if (e.target === activeFocusId) neighborSet.add(e.source);
      }
    }
    const pathNodes = new Set(pathResult?.pathIds || []);
    const pathEdges = new Set(pathResult?.edgeKeys || []);
    const q = searchFilter.toLowerCase();

    // Draw edges
    for (const edge of simEdges) {
      const edgeKey = `${edge.source}->${edge.target}`;
      const reverseKey = `${edge.target}->${edge.source}`;
      const onPath = pathEdges.has(edgeKey) || pathEdges.has(reverseKey);
      const isFocusEdge = !activeFocusId || edge.source === activeFocusId || edge.target === activeFocusId;

      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.moveTo(edge.src.x, edge.src.y);
      ctx2d.lineTo(edge.dst.x, edge.dst.y);

      if (onPath) {
        ctx2d.strokeStyle = pal.accent;
        ctx2d.lineWidth = 3 / cam.zoom;
        ctx2d.globalAlpha = 1;
      } else {
        ctx2d.strokeStyle = edge.isGhost ? pal.inkMuted : pal.hairlineStrong;
        ctx2d.lineWidth = (isFocusEdge ? 1.5 : 1) / cam.zoom;
        if (edge.isGhost) ctx2d.setLineDash([4, 4]);
        ctx2d.globalAlpha = activeFocusId ? (isFocusEdge ? 0.9 : 0.16) : 0.65;
      }
      ctx2d.stroke();
      ctx2d.restore();
    }

    // Draw nodes + labels
    for (const node of simNodes) {
      const matchesSearch = !q || node.title.toLowerCase().includes(q) || (node.tags || []).some((t) => t.includes(q));
      const inFocus = (!activeFocusId || neighborSet.has(node.id)) && matchesSearch;
      const isSelected = node.id === selectedNodeId;
      const isHovered = node.id === hoveredNodeId;
      const onPath = pathNodes.has(node.id);
      const color = clusterColors[(node.clusterId || 0) % clusterColors.length];

      ctx2d.save();
      ctx2d.globalAlpha = inFocus ? 1 : 0.22;

      if (onPath || isSelected || isHovered) {
        ctx2d.beginPath();
        ctx2d.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx2d.fillStyle = pal.bgElevated;
        ctx2d.fill();
        ctx2d.lineWidth = 2.5;
        ctx2d.strokeStyle = pal.accent;
        ctx2d.stroke();
      }

      ctx2d.beginPath();
      ctx2d.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      if (node.isGhost) {
        ctx2d.fillStyle = pal.bgElevated;
        ctx2d.fill();
        ctx2d.setLineDash([4, 3]);
        ctx2d.lineWidth = 1.6;
        ctx2d.strokeStyle = pal.inkMuted;
        ctx2d.stroke();
      } else {
        ctx2d.fillStyle = color;
        ctx2d.fill();
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = pal.bgElevated;
        ctx2d.stroke();
      }

      // Label pill below node
      const showLabel = cam.zoom >= 0.65 || node.degree >= 2 || isSelected || isHovered || onPath || (q && matchesSearch);
      if (showLabel) {
        const fontSize = Math.max(10.5, 12 / Math.min(1.1, Math.max(0.75, cam.zoom)));
        ctx2d.font = `${isSelected || isHovered ? 700 : 600} ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'top';
        const label = node.title.length > 26 ? `${node.title.slice(0, 24)}…` : node.title;
        ctx2d.fillStyle = node.isGhost ? pal.inkMuted : pal.inkPrimary;
        ctx2d.fillText(label, node.x, node.y + node.radius + 5);
      }

      ctx2d.restore();
    }

    ctx2d.restore();
    rafId = requestAnimationFrame(drawGraph);
  }

  function pickNodeAtScreen(sx, sy) {
    const pt = screenToWorld(sx, sy);
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      if (Math.hypot(pt.x - n.x, pt.y - n.y) <= n.radius + 6) {
        return n;
      }
    }
    return null;
  }

  async function createGhostNote(node) {
    const cleanTitle = node.title;
    const created = await api.createNote({
      title: cleanTitle,
      folder: 'Concepts',
      content: `# ${cleanTitle}\n\nFleshed out from Knowledge Graph ghost link.\n`
    });
    showToast(`Created note "${created.note.title}"`);
    await actions.syncNotesIndex();
    await actions.openNote(created.note.id);
  }

  function renderSidebar() {
    if (!graphData) return;
    const selected = selectedNodeId ? simNodeById.get(selectedNodeId) : null;

    const selectedHtml = selected
      ? `
        <div class="inspector-card" style="padding:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <strong style="font-size:15px">${escapeHtml(selected.title)}</strong>
            <span class="meta-badge">${selected.isGhost ? 'Ghost' : escapeHtml(selected.folder || 'Vault')}</span>
          </div>
          <div style="font-size:12px;color:var(--ink-secondary);display:flex;gap:12px;flex-wrap:wrap">
            <span>Degree: <strong class="tabular">${selected.degree}</strong> (${selected.inDegree} in / ${selected.outDegree} out)</span>
            <span>Rank: <strong class="tabular">${((selected.pagerank || 0) * 100).toFixed(1)}%</strong></span>
          </div>
          ${
            selected.tags?.length
              ? `<div class="tax-chips">${selected.tags.map((t) => `<span class="inline-tag">#${escapeHtml(t)}</span>`).join('')}</div>`
              : ''
          }
          <div style="display:flex;gap:8px;margin-top:4px">
            ${
              selected.isGhost
                ? `<button type="button" id="btn-peek-create-ghost" class="btn-primary btn-sm">+ Create Note</button>`
                : `<button type="button" id="btn-peek-open-note" class="btn-primary btn-sm">Open in Studio</button>`
            }
          </div>
        </div>
      `
      : `<div class="inspector-card"><span style="color:var(--ink-muted)">Click any node to inspect links, PageRank, and connections. Double-click to open.</span></div>`;

    const pathHtml = pathResult
      ? `
        <section>
          <div class="inspector-heading"><span>Shortest Path</span></div>
          <div class="inspector-card" style="margin-top:6px">
            ${
              pathResult.found
                ? `<div style="font-size:12.5px;font-weight:600;margin-bottom:4px">${pathResult.pathIds.length - 1} hop${pathResult.pathIds.length - 1 === 1 ? '' : 's'}</div>
                   <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
                     ${pathResult.pathIds
                       .map((id) => {
                         const n = simNodeById.get(id);
                         return `<button type="button" class="tax-chip is-active" data-focus-node="${escapeHtml(id)}">${escapeHtml(n ? n.title : id)}</button>`;
                       })
                       .join('<span>→</span>')}
                   </div>`
                : `<span style="color:var(--danger);font-size:12.5px">No connecting path found between those notes.</span>`
            }
          </div>
        </section>
      `
      : '';

    const hubsHtml = (graphData.hubs || [])
      .map(
        (h) => `
          <button type="button" class="inspector-link-btn" style="display:flex;justify-content:space-between;width:100%" data-focus-node="${escapeHtml(h.id)}">
            <span>${escapeHtml(h.title)}</span>
            <span class="meta-badge tabular">${h.degree} links</span>
          </button>
        `
      )
      .join('');

    const orphansHtml = (graphData.orphans || []).length
      ? graphData.orphans
          .map(
            (o) => `
              <button type="button" class="inspector-link-btn" style="display:flex;justify-content:space-between;width:100%" data-open-id="${escapeHtml(o.id)}">
                <span>${escapeHtml(o.title)}</span>
                <span class="meta-badge">0 links</span>
              </button>
            `
          )
          .join('')
      : `<span style="font-size:12px;color:var(--sage)">All notes connected!</span>`;

    const ghostsHtml = (graphData.ghosts || []).length
      ? graphData.ghosts
          .slice(0, 8)
          .map(
            (g) => `
              <div class="inspector-card" style="flex-direction:row;align-items:center;justify-content:space-between">
                <button type="button" class="inspector-link-btn" data-focus-node="${escapeHtml(g.id)}">[[${escapeHtml(g.title)}]]</button>
                <span class="meta-badge tabular">${g.referencedBy?.length || g.inDegree || 1}×</span>
              </div>
            `
          )
          .join('')
      : `<span style="font-size:12px;color:var(--ink-muted)">No dangling links</span>`;

    sidebarEl.innerHTML = `
      <section>
        <div class="inspector-heading"><span>Selected Node</span></div>
        <div style="margin-top:6px">${selectedHtml}</div>
      </section>

      ${pathHtml}

      <section>
        <div class="inspector-heading"><span>Graph Metrics</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">
          <div class="inspector-card">
            <span style="font-size:11px;color:var(--ink-muted)">Notes / Ghosts</span>
            <strong class="tabular" style="font-size:16px">${graphData.stats.noteCount} / ${graphData.stats.ghostCount}</strong>
          </div>
          <div class="inspector-card">
            <span style="font-size:11px;color:var(--ink-muted)">Links / Clusters</span>
            <strong class="tabular" style="font-size:16px">${graphData.stats.edgeCount} / ${graphData.stats.clusterCount}</strong>
          </div>
        </div>
      </section>

      <section>
        <div class="inspector-heading"><span>Central Hubs</span></div>
        <div class="inspector-list" style="margin-top:6px">${hubsHtml}</div>
      </section>

      <section>
        <div class="inspector-heading"><span>Orphan Notes</span><span>${(graphData.orphans || []).length}</span></div>
        <div class="inspector-list" style="margin-top:6px">${orphansHtml}</div>
      </section>

      <section>
        <div class="inspector-heading"><span>Uncreated Ghosts</span><span>${(graphData.ghosts || []).length}</span></div>
        <div class="inspector-list" style="margin-top:6px">${ghostsHtml}</div>
      </section>
    `;

    sidebarEl.querySelector('#btn-peek-open-note')?.addEventListener('click', () => {
      if (selected && !selected.isGhost) actions.openNote(selected.id);
    });
    sidebarEl.querySelector('#btn-peek-create-ghost')?.addEventListener('click', () => {
      if (selected && selected.isGhost) createGhostNote(selected);
    });
  }

  function populatePathSelects(rawGraph) {
    const notes = rawGraph.nodes.filter((n) => !n.isGhost).sort((a, b) => a.title.localeCompare(b.title));
    const optionsHtml = notes.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.title)}</option>`).join('');
    const prevS = pathSourceSel.value;
    const prevT = pathTargetSel.value;
    pathSourceSel.innerHTML = optionsHtml;
    pathTargetSel.innerHTML = optionsHtml;
    if (notes.length >= 2) {
      pathSourceSel.value = notes.some((n) => n.id === prevS) ? prevS : notes[0].id;
      pathTargetSel.value = notes.some((n) => n.id === prevT) ? prevT : notes[notes.length - 1].id;
    }
  }

  async function loadGraph() {
    const data = await api.getGraph(includeGhosts);
    if (destroyed) return;
    graphData = data;
    seedSimulationPositions(data);
    populatePathSelects(data);
    renderSidebar();
  }

  // Canvas Pointer Interactions
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = pickNodeAtScreen(sx, sy);
    canvas.setPointerCapture(e.pointerId);
    interaction = {
      mode: hit ? 'drag' : 'pan',
      dragNode: hit,
      startX: sx,
      startY: sy,
      camStartX: cam.x,
      camStartY: cam.y,
      moved: false
    };
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (!interaction.mode) {
      const hit = pickNodeAtScreen(sx, sy);
      hoveredNodeId = hit ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      return;
    }

    if (Math.hypot(sx - interaction.startX, sy - interaction.startY) > 4) {
      interaction.moved = true;
    }

    if (interaction.mode === 'drag' && interaction.dragNode) {
      const pt = screenToWorld(sx, sy);
      interaction.dragNode.x = pt.x;
      interaction.dragNode.y = pt.y;
      simAlpha = Math.max(simAlpha, 0.25);
    } else if (interaction.mode === 'pan') {
      cam.x = interaction.camStartX + (sx - interaction.startX);
      cam.y = interaction.camStartY + (sy - interaction.startY);
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!interaction.moved) {
      const rect = canvas.getBoundingClientRect();
      const hit = pickNodeAtScreen(e.clientX - rect.left, e.clientY - rect.top);
      selectedNodeId = hit ? hit.id : null;
      renderSidebar();
    }
    interaction.mode = null;
    interaction.dragNode = null;
  });

  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const hit = pickNodeAtScreen(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.isGhost) createGhostNote(hit);
    else actions.openNote(hit.id);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const nextZoom = Math.min(2.8, Math.max(0.32, cam.zoom * factor));
      cam.x = sx - ((sx - cam.x) / cam.zoom) * nextZoom;
      cam.y = sy - ((sy - cam.y) / cam.zoom) * nextZoom;
      cam.zoom = nextZoom;
    },
    { passive: false }
  );

  // Floating controls & sidebar actions
  searchInput.addEventListener('input', () => {
    searchFilter = searchInput.value.trim();
  });

  ghostCheckbox.addEventListener('change', () => {
    includeGhosts = ghostCheckbox.checked;
    loadGraph();
  });

  fitBtn.addEventListener('click', fitGraph);

  findPathBtn.addEventListener('click', async () => {
    const source = pathSourceSel.value;
    const target = pathTargetSel.value;
    if (!source || !target) return;
    pathResult = await api.getGraphPath(source, target);
    clearPathBtn.hidden = false;
    renderSidebar();
  });

  clearPathBtn.addEventListener('click', () => {
    pathResult = null;
    clearPathBtn.hidden = true;
    renderSidebar();
  });

  sidebarEl.addEventListener('click', (e) => {
    const focusBtn = e.target.closest('[data-focus-node]');
    if (focusBtn) {
      const id = focusBtn.dataset.focusNode;
      const node = simNodeById.get(id);
      if (node) {
        selectedNodeId = id;
        const rect = canvas.parentElement.getBoundingClientRect();
        cam.x = rect.width / 2 - node.x * cam.zoom;
        cam.y = rect.height / 2 - node.y * cam.zoom;
        renderSidebar();
      }
      return;
    }

    const openBtn = e.target.closest('[data-open-id]');
    if (openBtn) {
      actions.openNote(openBtn.dataset.openId);
    }
  });

  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(canvas.parentElement);

  resizeCanvas();
  loadGraph().then(() => {
    if (!destroyed) {
      setTimeout(() => {
        if (!destroyed) fitGraph();
      }, 450);
    }
  });
  rafId = requestAnimationFrame(drawGraph);

  return {
    refresh: loadGraph,
    destroy: () => {
      destroyed = true;
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    }
  };
}
