/**
 * Tessera Recall Lab (FSRS v4.5 Spaced Repetition):
 *  - KPI summary: Due Now, Total Cards, Mastered (>=21d), Retention Rate, Avg Stability
 *  - Interactive card flip stage with Space flip + 1-4 rating hotkeys + interval labels
 *  - Practice mode fallback when queue hits zero due cards
 *  - Accessible SVG 30-day workload & retention forecast chart + 90-day consistency heatmap
 *  - Filterable Card Browser with direct "Open in Studio" links
 */

import { Rating, previewIntervals } from '/core/fsrsEngine.js';
import { escapeHtml } from '/core/markdownAst.js';
import { api } from '../apiClient.js';
import { showToast } from '../components/toast.js';

export function mountRecallView(ctx) {
  const { container, actions } = ctx;
  let destroyed = false;
  let recallData = null;
  let practiceAll = false;
  let flipped = false;
  let currentCardIndex = 0;
  let browserFilter = 'all';
  let browserSearch = '';

  container.innerHTML = `
    <div class="recall-workspace">
      <div id="recall-kpis" class="kpi-strip"></div>
      <div id="recall-study-stage" class="study-stage"></div>
      <section class="chart-card" aria-label="Flashcard Library">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">
          <strong style="font-size:15px">Flashcard Library</strong>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="search" id="recall-browser-search" class="prop-input" style="width:200px" placeholder="Filter cards…" aria-label="Search flashcards">
            <select id="recall-browser-filter" class="prop-input" style="width:140px" aria-label="Filter card state">
              <option value="all">All Cards</option>
              <option value="due">Due Now</option>
              <option value="mastered">Mastered (21d+)</option>
              <option value="new">New</option>
            </select>
          </div>
        </div>
        <div id="recall-browser-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </section>
    </div>
  `;

  const kpisEl = container.querySelector('#recall-kpis');
  const stageEl = container.querySelector('#recall-study-stage');
  const browserSearchEl = container.querySelector('#recall-browser-search');
  const browserFilterEl = container.querySelector('#recall-browser-filter');
  const browserListEl = container.querySelector('#recall-browser-list');

  function getActiveDeck() {
    if (!recallData) return [];
    return practiceAll ? (recallData.cards || []) : (recallData.dueCards || []);
  }

  function renderKpis() {
    if (!recallData) return;
    const { stats } = recallData;
    kpisEl.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Due Queue</div>
        <div class="kpi-value" style="color:${stats.due > 0 ? 'var(--accent)' : 'var(--sage)'}">${stats.due}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Cards</div>
        <div class="kpi-value">${stats.total}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Mastered (21d+)</div>
        <div class="kpi-value">${stats.mastered}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Retention Rate</div>
        <div class="kpi-value">${stats.retentionRate}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Stability</div>
        <div class="kpi-value">${stats.avgStability}d</div>
      </div>
    `;
  }

  function buildForecastSvg(forecast) {
    const data = (forecast || []).slice(0, 30);
    if (data.length === 0) return `<p style="color:var(--ink-muted);font-size:13px">No forecast data yet.</p>`;
    const width = 520;
    const height = 160;
    const padL = 28;
    const padR = 12;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const maxDue = Math.max(4, ...data.map((d) => d.dueCount || 0));
    const barW = Math.max(4, plotW / data.length - 3);

    const bars = data
      .map((d, i) => {
        const bh = ((d.dueCount || 0) / maxDue) * plotH;
        const x = padL + (i / data.length) * plotW + 1.5;
        const y = padT + (plotH - bh);
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.8"><title>${escapeHtml(d.date)}: ${d.dueCount} due · ${Math.round((d.avgRetrievability || 0) * 100)}% R</title></rect>`;
      })
      .join('');

    const linePoints = data
      .map((d, i) => {
        const x = padL + (i / Math.max(1, data.length - 1)) * plotW;
        const r = d.avgRetrievability ?? 0.9;
        const y = padT + (1 - Math.min(1, Math.max(0, r))) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    return `
      <svg viewBox="0 0 ${width} ${height}" width="100%" style="display:block;overflow:visible" role="img" aria-label="30-day review workload and memory retrievability forecast">
        <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="var(--hairline-strong)" />
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--hairline-strong)" />
        ${bars}
        <polyline points="${linePoints}" fill="none" stroke="var(--sage)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
        <text x="${padL}" y="${height - 6}" font-size="10" fill="var(--ink-muted)">Today</text>
        <text x="${width - padR}" y="${height - 6}" font-size="10" text-anchor="end" fill="var(--ink-muted)">+30d</text>
        <text x="${padL - 4}" y="${padT + 8}" font-size="10" text-anchor="end" fill="var(--ink-muted)">${maxDue}</text>
      </svg>
    `;
  }

  function buildHeatmapSvg(heatmap) {
    const byDay = new Map((heatmap || []).map((entry) => [entry.day, entry]));
    const days = [];
    const today = new Date();
    for (let offset = 90; offset >= 0; offset--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
      const iso = d.toISOString().slice(0, 10);
      days.push(byDay.get(iso) || { day: iso, count: 0, passed: 0 });
    }
    const cols = Math.ceil(days.length / 7);
    const cell = 13;
    const gap = 3;
    const w = cols * (cell + gap);
    const h = 7 * (cell + gap);

    const cells = days
      .map((item, idx) => {
        const col = Math.floor(idx / 7);
        const row = idx % 7;
        const x = col * (cell + gap);
        const y = row * (cell + gap);
        let fill = 'var(--bg-subtle)';
        if (item.count >= 6) fill = 'var(--sage)';
        else if (item.count >= 2) fill = 'var(--cobalt)';
        else if (item.count >= 1) fill = 'var(--accent)';
        return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}" opacity="${item.count > 0 ? '0.92' : '1'}"><title>${escapeHtml(item.day)}: ${item.count} review(s)</title></rect>`;
      })
      .join('');

    return `
      <svg viewBox="0 0 ${w} ${h}" width="100%" style="max-height:112px;display:block" role="img" aria-label="91-day study consistency heatmap">
        ${cells}
      </svg>
    `;
  }

  function renderStudyStage() {
    if (!recallData) return;
    const deck = getActiveDeck();
    if (currentCardIndex >= deck.length) currentCardIndex = 0;
    const card = deck[currentCardIndex] || null;

    let deckHtml = '';
    if (!card) {
      deckHtml = `
        <div class="flashcard-deck-box">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span class="fc-badge">Queue Clear</span>
            <span class="meta-badge">${recallData.stats.total} total cards</span>
          </div>
          <div class="flashcard-face" style="align-items:center;text-align:center">
            <h2 style="margin:0;font-size:20px">All due cards reviewed</h2>
            <p style="margin:0;color:var(--ink-secondary);max-width:42ch">
              FSRS schedules reviews just before your memory retention crosses 90%. Add cards in Studio using <code>Q ?? A</code> or <code>{{cloze}}</code>, or practice all cards below.
            </p>
            ${
              recallData.cards.length > 0
                ? `<button type="button" id="btn-practice-all" class="btn-primary">Practice All ${recallData.cards.length} Cards</button>`
                : ''
            }
          </div>
        </div>
      `;
    } else {
      const preview = card.preview || previewIntervals(card);
      const getLabel = (r) => preview[r]?.label || '1d';
      deckHtml = `
        <div class="flashcard-deck-box">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="fc-badge">${escapeHtml(card.kind === 'cloze' ? 'Cloze Recall' : 'Q&A Card')}</span>
              <button type="button" class="inspector-link-btn" data-open-note="${escapeHtml(card.noteId)}">
                From: ${escapeHtml(card.noteTitle)}
              </button>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="meta-badge tabular">${currentCardIndex + 1} / ${deck.length}${practiceAll ? ' (Practice)' : ' due'}</span>
              ${practiceAll ? `<button type="button" id="btn-exit-practice" class="btn-ghost btn-sm">Due Only</button>` : ''}
            </div>
          </div>

          <div class="flashcard-face">
            <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-muted)">Prompt</div>
            <div style="font-size:18px;font-weight:700;line-height:1.45">${escapeHtml(card.front)}</div>

            ${
              flipped
                ? `
                  <hr style="width:100%;border:none;border-top:1px solid var(--hairline);margin:4px 0">
                  <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--sage)">Answer</div>
                  <div style="font-size:16px;line-height:1.55;color:var(--ink-primary)">${escapeHtml(card.back)}</div>
                `
                : ''
            }
          </div>

          ${
            !flipped
              ? `<button type="button" id="btn-flip-card" class="btn-primary" style="width:100%">Show Answer <kbd class="kbd-chip" style="margin-left:6px">Space</kbd></button>`
              : `
                <div class="rating-bar" role="group" aria-label="Rate memory recall">
                  <button type="button" class="rate-btn" data-rating="${Rating.Again}">
                    <span>1 · Again</span>
                    <small>${escapeHtml(getLabel(Rating.Again))}</small>
                  </button>
                  <button type="button" class="rate-btn" data-rating="${Rating.Hard}">
                    <span>2 · Hard</span>
                    <small>${escapeHtml(getLabel(Rating.Hard))}</small>
                  </button>
                  <button type="button" class="rate-btn" data-rating="${Rating.Good}">
                    <span>3 · Good</span>
                    <small>${escapeHtml(getLabel(Rating.Good))}</small>
                  </button>
                  <button type="button" class="rate-btn" data-rating="${Rating.Easy}">
                    <span>4 · Easy</span>
                    <small>${escapeHtml(getLabel(Rating.Easy))}</small>
                  </button>
                </div>
              `
          }
        </div>
      `;
    }

    stageEl.innerHTML = `
      <div>${deckHtml}</div>
      <div class="charts-stack">
        <div class="chart-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:14px">30-Day Review Workload &amp; Retention</strong>
            <span style="font-size:11.5px;color:var(--ink-muted)">Bars: due · Line: R%</span>
          </div>
          ${buildForecastSvg(recallData.forecast)}
        </div>

        <div class="chart-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:14px">90-Day Recall Consistency</strong>
            <span style="font-size:11.5px;color:var(--ink-muted)">FSRS v4.5 log</span>
          </div>
          ${buildHeatmapSvg(recallData.heatmap)}
        </div>
      </div>
    `;
  }

  const STATE_LABELS = ['New', 'Learning', 'Review', 'Relearning'];

  function formatCardState(raw) {
    if (typeof raw === 'number' && STATE_LABELS[raw]) return STATE_LABELS[raw];
    if (/^[0-3]$/.test(String(raw))) return STATE_LABELS[Number(raw)];
    return String(raw || 'New');
  }

  function renderBrowser() {
    if (!recallData) return;
    const q = browserSearch.toLowerCase();
    const cards = (recallData.cards || []).filter((c) => {
      if (browserFilter === 'due' && !c.isDue) return false;
      if (browserFilter === 'mastered' && Number(c.stability || 0) < 21) return false;
      if (browserFilter === 'new' && formatCardState(c.state) !== 'New' && Number(c.reps || 0) > 0) return false;
      if (q && !c.front.toLowerCase().includes(q) && !c.back.toLowerCase().includes(q) && !c.noteTitle.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });

    if (cards.length === 0) {
      browserListEl.innerHTML = `<p style="color:var(--ink-muted);font-size:13px;margin:4px 0">No cards match this filter.</p>`;
      return;
    }

    browserListEl.innerHTML = cards
      .map(
        (c) => `
          <div class="inspector-card" style="flex-direction:row;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="min-width:220px;flex:1">
              <div style="font-weight:700;font-size:13.5px">${escapeHtml(c.front)}</div>
              <div style="font-size:12.5px;color:var(--ink-secondary);margin-top:2px">${escapeHtml(c.back)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="meta-badge">${escapeHtml(formatCardState(c.state))} · S=${Number(c.stability || 0).toFixed(1)}d</span>
              <span class="meta-badge" style="${c.isDue ? 'background:var(--accent-soft);color:var(--accent)' : ''}">
                ${c.isDue ? 'Due now' : `Due ${String(c.dueAt || '').slice(0, 10)}`}
              </span>
              <button type="button" class="btn-secondary btn-sm" data-open-note="${escapeHtml(c.noteId)}">Open Note</button>
            </div>
          </div>
        `
      )
      .join('');
  }

  async function submitRating(rating) {
    const deck = getActiveDeck();
    const card = deck[currentCardIndex];
    if (!card) return;
    try {
      await api.reviewFlashcard(card.id, rating);
      flipped = false;
      if (practiceAll) {
        currentCardIndex = (currentCardIndex + 1) % Math.max(1, deck.length);
      }
      await loadRecall();
      await actions.refreshCounts();
    } catch (err) {
      showToast(`Review failed: ${err.message}`);
    }
  }

  async function loadRecall() {
    const data = await api.listFlashcards();
    if (destroyed) return;
    recallData = data;
    if ((data.dueCards || []).length === 0 && !practiceAll) {
      currentCardIndex = 0;
    }
    renderKpis();
    renderStudyStage();
    renderBrowser();
  }

  // Event delegation
  container.addEventListener('click', (e) => {
    if (e.target.closest('#btn-flip-card')) {
      flipped = true;
      renderStudyStage();
      return;
    }
    if (e.target.closest('#btn-practice-all')) {
      practiceAll = true;
      currentCardIndex = 0;
      flipped = false;
      renderStudyStage();
      return;
    }
    if (e.target.closest('#btn-exit-practice')) {
      practiceAll = false;
      currentCardIndex = 0;
      flipped = false;
      renderStudyStage();
      return;
    }
    const rateBtn = e.target.closest('.rate-btn[data-rating]');
    if (rateBtn) {
      submitRating(Number(rateBtn.dataset.rating));
      return;
    }
    const noteBtn = e.target.closest('[data-open-note]');
    if (noteBtn) {
      actions.openNote(noteBtn.dataset.openNote);
    }
  });

  browserSearchEl.addEventListener('input', () => {
    browserSearch = browserSearchEl.value.trim();
    renderBrowser();
  });

  browserFilterEl.addEventListener('change', () => {
    browserFilter = browserFilterEl.value;
    renderBrowser();
  });

  function onKeyDown(e) {
    if (destroyed) return;
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot && !modalRoot.hidden) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

    const deck = getActiveDeck();
    if (deck.length === 0) return;

    if (e.code === 'Space' && !flipped) {
      e.preventDefault();
      flipped = true;
      renderStudyStage();
    } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      submitRating(Number(e.key));
    }
  }
  document.addEventListener('keydown', onKeyDown);

  loadRecall();

  return {
    refresh: loadRecall,
    destroy: () => {
      destroyed = true;
      document.removeEventListener('keydown', onKeyDown);
    }
  };
}
