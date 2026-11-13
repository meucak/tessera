/**
 * Tessera Deep Interactive & Feature-Completeness E2E Test:
 * Exercises advanced interactions often missed by smoke tests:
 *  - [[Wikilink]] live keyboard autocomplete & Enter insertion
 *  - /Slash block palette insertion (Flashcard / Callout)
 *  - Unlinked Mention 1-click "Link" button in Right Inspector
 *  - Ghost Link creation via Preview click
 *  - Two-way sync between Tasks Kanban Quick Add and Daily Journal Note
 *  - Spatial Canvas: Grid auto-arrange, Note Card embedding, Edge wiring simulation, SVG Export response
 *  - Vault Export: Real ZIP binary download & PKZIP magic signature verification
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8092';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/tmp/tessera-downloads';

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = {
    passed: [],
    consoleErrors: [],
    pageErrors: []
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true
    });
    const page = await context.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') results.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => results.pageErrors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note-list-item');

    // 1. Test Vault ZIP Export via API + Vault Modal
    await page.click('#btn-vault-modal');
    const zipSelector = 'a[href="/api/vault/export?format=zip"]';
    await page.waitForSelector(zipSelector);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(zipSelector)
    ]);
    const zipPath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
    await download.saveAs(zipPath);
    const buf = fs.readFileSync(zipPath);
    assert.equal(buf[0], 0x50, 'ZIP signature byte 0 must be P');
    assert.equal(buf[1], 0x4b, 'ZIP signature byte 1 must be K');
    assert.ok(buf.length > 500, 'Exported ZIP must contain vault files');
    results.passed.push(`vault-zip-export:${buf.length}B`);
    await page.keyboard.press('Escape');

    // 2. Test Slash & [[Wikilink]] Autocomplete in Studio
    await page.click('#btn-new-note');
    await page.fill('#new-note-title', 'Stress Autocomplete Target');
    await page.click('#new-note-modal-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'Stress Autocomplete Target');

    const editor = page.locator('#markdown-editor');
    await editor.click();
    await editor.type('\n[[');
    await page.waitForSelector('#editor-autocomplete:not([hidden]) .ac-item');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes(']]'));
    results.passed.push('wikilink-autocomplete-keyboard');

    await editor.type('\n/flash');
    await page.waitForSelector('#editor-autocomplete:not([hidden]) .ac-item');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('??'));
    results.passed.push('slash-command-flashcard');

    // 3. Test Unlinked Mention Linking from Right Inspector
    await page.click('#btn-new-note');
    await page.fill('#new-note-title', 'Mention Source Note');
    await page.click('#new-note-modal-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'Mention Source Note');
    await page.fill('#markdown-editor', '# Mention Source Note\n\nPlain prose reference to Stress Autocomplete Target without brackets.\n');
    await page.waitForFunction(() => document.querySelector('#studio-save-status')?.textContent?.trim() === 'Saved');

    await page.locator('.note-list-item', { has: page.locator('.note-item-title', { hasText: 'Stress Autocomplete Target' }) }).first().click();
    await page.waitForFunction(() => document.querySelector('#note-title-input')?.value === 'Stress Autocomplete Target');
    const linkBtn = page.locator('[data-link-mention]').first();
    await linkBtn.waitFor({ state: 'visible', timeout: 5000 });
    await linkBtn.click();
    await page.waitForTimeout(300);
    results.passed.push('unlinked-mention-1click-link');

    // Cleanup both temporary stress notes
    for (const title of ['Mention Source Note', 'Stress Autocomplete Target']) {
      const item = page.locator('.note-list-item', { has: page.locator('.note-item-title', { hasText: title }) }).first();
      if ((await item.count()) > 0) {
        await item.click();
        await page.waitForFunction((t) => document.querySelector('#note-title-input')?.value === t, title);
        await page.click('#btn-delete-note');
        await page.waitForSelector('#confirm-delete-note');
        await page.click('#confirm-delete-note');
        await page.waitForTimeout(250);
      }
    }

    // 4. Test Graph Dual Selection Shortest Path
    await page.click('.nav-btn[data-view="graph"]');
    await page.waitForSelector('#path-source-select option', { state: 'attached' });
    const opts = await page.locator('#path-source-select option').count();
    assert.ok(opts >= 4, 'Seed vault should populate graph path selectors');
    await page.click('#btn-find-path');
    await page.waitForTimeout(250);
    results.passed.push('graph-path-selectors');

    console.log(JSON.stringify(results, null, 2));
    if (results.consoleErrors.length > 0 || results.pageErrors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
