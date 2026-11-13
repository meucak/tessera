/**
 * Tessera Full-Stack Browser E2E, Visual Screenshot & Accessibility Audit Suite
 * Runs inside isolated `tessera-test` container with real Chromium + Playwright + Axe-core.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8092';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/screenshots';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const AXE_SCRIPT_PATH = '/e2e/node_modules/axe-core/axe.min.js';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const report = {
  baseUrl: BASE_URL,
  consoleErrors: [],
  pageErrors: [],
  httpErrors: [],
  layoutIssues: [],
  axeViolations: [],
  passedFlows: [],
  screenshots: []
};

async function shot(page, filename) {
  const fullPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: fullPath, fullPage: false });
  report.screenshots.push(filename);
}

async function auditLayout(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflowX = doc.scrollWidth - vw;
    const issues = [];

    if (overflowX > 2) {
      issues.push(`Horizontal overflow: scrollWidth=${doc.scrollWidth} > innerWidth=${vw}`);
    }

    // Check interactive elements inside header / toolbars / nav do not overlap or clip horizontally
    const interactive = [...document.querySelectorAll('button, a, input, select')].filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest('#modal-root[hidden]');
    });

    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 4 && !el.closest('.editor-autocomplete') && !el.closest('.board-node')) {
        issues.push(`Clipped right edge (${Math.round(r.right)} > ${vw}): ${el.tagName}#${el.id || el.className}`);
      }
      if (r.height > 0 && (el.classList.contains('btn-primary') || el.classList.contains('btn-secondary') || el.classList.contains('nav-btn'))) {
        if (r.height < 42 || r.width < 42) {
          issues.push(`Touch target <44px (${Math.round(r.width)}x${Math.round(r.height)}): #${el.id || el.className}`);
        }
      }
    }

    // Pairwise overlap check within visible nav-rail & utility bar
    const checkOverlapGroup = (selector, groupName) => {
      const els = [...document.querySelectorAll(selector)].filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      for (let i = 0; i < els.length; i++) {
        for (let j = i + 1; j < els.length; j++) {
          const a = els[i].getBoundingClientRect();
          const b = els[j].getBoundingClientRect();
          const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (overlapX > 3 && overlapY > 3) {
            issues.push(`Overlap in ${groupName}: "${els[i].textContent.trim() || els[i].id}" vs "${els[j].textContent.trim() || els[j].id}"`);
          }
        }
      }
    };

    checkOverlapGroup('.top-utility-bar button', 'top-utility-bar');
    checkOverlapGroup('.nav-rail button', 'nav-rail');

    return { vw, vh, overflowX, issues };
  });

  if (metrics.issues.length > 0) {
    report.layoutIssues.push({ label, issues: metrics.issues });
  }
}

async function runAxe(page, label) {
  if (!fs.existsSync(AXE_SCRIPT_PATH)) return;
  const axeCode = fs.readFileSync(AXE_SCRIPT_PATH, 'utf8');
  await page.addScriptTag({ content: axeCode });
  const results = await page.evaluate(async () => {
    return window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa']
      }
    });
  });

  const critical = (results.violations || []).map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    nodes: v.nodes.slice(0, 4).map((n) => ({
      target: n.target,
      failureSummary: n.failureSummary
    }))
  }));
  if (critical.length > 0) {
    report.axeViolations.push({ label, violations: critical });
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let context = null;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        report.consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      report.pageErrors.push(err.message);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        report.httpErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    // 1. Boot & Live Sync Verification
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note-list-item');
    await page.waitForFunction(() => document.querySelector('#ws-sync-pill')?.classList.contains('is-live'), { timeout: 8000 });
    await page.waitForTimeout(300);
    await auditLayout(page, 'desktop-1440-studio-light');
    await runAxe(page, 'desktop-1440-studio-light');
    await shot(page, '01-studio-light.png');
    report.passedFlows.push('boot-and-ws-live-sync');

    // 2. Create Note, Edit Markdown, [[Wikilink]] Autocomplete, Save, Reload Persistence & Diff Modal
    await page.click('#btn-new-note');
    await page.fill('#new-note-title', 'E2E Consensus Protocol');
    await page.fill('#new-note-folder', 'Architecture');
    await page.click('#new-note-modal-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'E2E Consensus Protocol');

    const mdPayload = [
      '---',
      'folder: Architecture',
      'status: budding',
      'tags: [consensus, e2e-test]',
      '---',
      '',
      '# E2E Consensus Protocol',
      '',
      'Connects directly to [[Tessera Architecture & Philosophy]] for durable state machines.',
      '',
      '> [!TIP] Quorum Invariant',
      '> Any two write quorums intersect in at least one healthy replica.',
      '',
      '- [ ] Verify linearizability tests !high @2026-12-01',
      '',
      'Why require quorum intersection? :: So every subsequent read quorum observes the latest committed write.',
      ''
    ].join('\n');

    await page.fill('#markdown-editor', mdPayload);
    await page.waitForFunction(() => document.querySelector('#studio-save-status')?.textContent?.trim() === 'Saved', { timeout: 5000 });
    const previewHtml = await page.innerHTML('#markdown-preview');
    assert.ok(previewHtml.includes('Quorum Invariant'), 'Callout should render in live preview');
    assert.ok(previewHtml.includes('is-resolved'), '[[Tessera Architecture & Philosophy]] should resolve cleanly');

    // Modify once more to create at least 2 versions for Diff Modal comparison
    await page.fill('#markdown-editor', `${mdPayload}\n## Safety Addendum\n\nEpoch numbers prevent stale leaders.\n`);
    await page.waitForFunction(() => document.querySelector('#studio-save-status')?.textContent?.trim() === 'Saved', { timeout: 5000 });

    // Open Diff Modal
    await page.click('#btn-note-history');
    await page.waitForSelector('.diff-table');
    await page.waitForTimeout(200);
    await shot(page, '02-diff-modal-light.png');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('modal-root')?.hidden === true);
    report.passedFlows.push('studio-create-edit-save-diff');

    // Reload persistence check & wikilink click navigation
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'E2E Consensus Protocol');
    await page.click('#markdown-preview .wikilink.is-resolved');
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'Tessera Architecture & Philosophy');
    report.passedFlows.push('persistence-and-wikilink-navigation');

    // 3. Command Palette Search
    await page.click('#btn-global-search-trigger');
    await page.waitForSelector('#cp-input');
    await page.fill('#cp-input', 'sqlite');
    await page.waitForTimeout(300);
    await shot(page, '03-command-palette-light.png');
    await page.keyboard.press('Escape');
    report.passedFlows.push('command-palette-fts5');

    // 4. Knowledge Graph & Path Tracing
    await page.click('.nav-btn[data-view="graph"]');
    await page.waitForSelector('#graph-canvas');
    await page.waitForTimeout(750);
    await page.click('#btn-find-path');
    await page.waitForTimeout(300);
    const canvasPixels = await page.evaluate(() => {
      const c = document.getElementById('graph-canvas');
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonZero = 0;
      for (let i = 3; i < data.length; i += 400) {
        if (data[i] > 0) nonZero++;
      }
      return nonZero;
    });
    assert.ok(canvasPixels > 20, 'Graph canvas must draw visible pixels');
    await auditLayout(page, 'desktop-1440-graph-light');
    await runAxe(page, 'desktop-1440-graph-light');
    await shot(page, '04-graph-light.png');
    report.passedFlows.push('knowledge-graph-canvas-and-path');

    // 5. Spatial Canvas Whiteboard
    await page.click('.nav-btn[data-view="board"]');
    await page.waitForSelector('.board-node');
    const beforeCards = await page.locator('.board-node').count();
    await page.click('#btn-add-sticky');
    await page.waitForFunction((prev) => document.querySelectorAll('.board-node').length === prev + 1, beforeCards);
    await page.click('#btn-board-undo');
    await page.waitForFunction((prev) => document.querySelectorAll('.board-node').length === prev, beforeCards);
    await page.click('#btn-zoom-fit');
    await page.waitForTimeout(300);
    await auditLayout(page, 'desktop-1440-board-light');
    await runAxe(page, 'desktop-1440-board-light');
    await shot(page, '05-board-light.png');
    report.passedFlows.push('spatial-board-add-undo-fit');

    // 6. Recall Lab FSRS
    await page.click('.nav-btn[data-view="recall"]');
    await page.waitForSelector('#recall-kpis .kpi-card');
    await page.waitForTimeout(250);
    const flipBtn = page.locator('#btn-flip-card');
    if ((await flipBtn.count()) > 0) {
      await flipBtn.click();
      await page.waitForSelector('.rate-btn[data-rating="3"]');
      await shot(page, '06-recall-light.png');
      await page.click('.rate-btn[data-rating="3"]');
      await page.waitForTimeout(250);
    } else {
      await shot(page, '06-recall-light.png');
    }
    await auditLayout(page, 'desktop-1440-recall-light');
    await runAxe(page, 'desktop-1440-recall-light');
    report.passedFlows.push('recall-fsrs-study');

    // 7. Tasks & Kanban Two-Way Toggle
    await page.click('.nav-btn[data-view="tasks"]');
    await page.waitForSelector('.kanban-col');
    const taskCb = page.locator('.task-card input[type="checkbox"]').first();
    if ((await taskCb.count()) > 0) {
      const prevChecked = await taskCb.isChecked();
      await taskCb.click();
      await page.waitForTimeout(250);
      // Toggle back to keep vault state crisp
      const toggled = page.locator(`.task-card input[type="checkbox"][data-task-note="${await taskCb.getAttribute('data-task-note')}"][data-task-line="${await taskCb.getAttribute('data-task-line')}"]`);
      if ((await toggled.count()) > 0 && (await toggled.isChecked()) !== prevChecked) {
        await toggled.click();
        await page.waitForTimeout(200);
      }
    }
    await page.waitForTimeout(200);
    await auditLayout(page, 'desktop-1440-tasks-light');
    await runAxe(page, 'desktop-1440-tasks-light');
    await shot(page, '07-tasks-light.png');
    report.passedFlows.push('tasks-kanban-two-way-toggle');

    // Clean up temporary E2E note from Studio via UI confirmation modal
    await page.click('.nav-btn[data-view="studio"]');
    await page.waitForSelector('.note-list-item');
    const e2eItem = page.locator('.note-list-item', { hasText: 'E2E Consensus Protocol' }).first();
    if ((await e2eItem.count()) > 0) {
      await e2eItem.click();
      await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'E2E Consensus Protocol');
      await page.click('#btn-delete-note');
      await page.waitForSelector('#confirm-delete-note');
      await page.click('#confirm-delete-note');
      await page.waitForTimeout(300);
      report.passedFlows.push('studio-delete-confirmation-modal');
    }

    // 8. Sepia & Dark Theme Checks (1440x900)
    await page.click('#btn-theme-cycle'); // -> Sepia
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'sepia');
    await page.waitForTimeout(250);
    await runAxe(page, 'desktop-1440-studio-sepia');
    await shot(page, '08-studio-sepia.png');

    await page.click('#btn-theme-cycle'); // -> Dark
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    await page.waitForTimeout(250);
    await runAxe(page, 'desktop-1440-studio-dark');
    await shot(page, '09-studio-dark.png');

    await page.click('.nav-btn[data-view="recall"]');
    await page.waitForTimeout(250);
    await runAxe(page, 'desktop-1440-recall-dark');
    await shot(page, '10-recall-dark.png');

    // Reset back to Light for responsive checks
    await page.click('#btn-theme-cycle');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
    await page.click('.nav-btn[data-view="studio"]');

    // 9. Laptop Viewport (1280x800)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(250);
    await auditLayout(page, 'laptop-1280-studio-light');
    await shot(page, '11-laptop-studio-light.png');

    await page.click('.nav-btn[data-view="board"]');
    await page.waitForTimeout(250);
    await auditLayout(page, 'laptop-1280-board-light');
    await shot(page, '12-laptop-board-light.png');

    // 10. Mobile Viewport (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('.nav-btn[data-view="studio"]');
    await page.waitForTimeout(250);
    await auditLayout(page, 'mobile-390-studio-light');
    await shot(page, '13-mobile-studio-light.png');

    await page.click('#btn-mobile-sidebar');
    await page.waitForTimeout(300);
    await shot(page, '14-mobile-drawer-light.png');
    await page.locator('.note-list-item').first().click();
    await page.waitForTimeout(250);

    await page.click('.nav-btn[data-view="tasks"]');
    await page.waitForTimeout(250);
    await auditLayout(page, 'mobile-390-tasks-light');
    await shot(page, '15-mobile-tasks-light.png');

    await page.click('.nav-btn[data-view="recall"]');
    await page.waitForTimeout(250);
    await auditLayout(page, 'mobile-390-recall-light');
    await shot(page, '16-mobile-recall-light.png');

    console.log(JSON.stringify(report, null, 2));

    const hasErrors =
      report.consoleErrors.length > 0 ||
      report.pageErrors.length > 0 ||
      report.httpErrors.length > 0;
    if (hasErrors) {
      process.exitCode = 1;
    }
  } catch (err) {
    try {
      const p = context.pages()[0];
      if (p) await shot(p, 'failure-debug.png');
    } catch {
      // ignore screenshot failure
    }
    console.error('REPORT_BEFORE_FAILURE:', JSON.stringify(report, null, 2));
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
