import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createAppServer } from '../../src/server/index.js';
import { parseZipBuffer } from '../../src/server/zipVault.js';

async function startTempServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-test-'));
  const dbPath = path.join(tmpDir, 'tessera.db');
  const app = await createAppServer({ dbPath, port: 0, host: '127.0.0.1', seed: true });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    port: address.port,
    close: async () => {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('API full lifecycle: health, seeded vault, FTS5 search, CRUD, diff/restore, graph path, tasks, FSRS, boards, ZIP, and WS sync', async () => {
  const srv = await startTempServer();
  try {
    // 1. Health check & seeded data
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.ok(health.notes >= 6);
    assert.ok(health.cards >= 4);
    assert.ok(health.boards >= 1);

    // 2. WebSocket connection check
    const wsEvents = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      try {
        wsEvents.push(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });

    // 3. FTS5 structured search + XSS check
    const searchRes = await fetch(`${srv.baseUrl}/api/notes?q=${encodeURIComponent('SQLite')}`);
    assert.equal(searchRes.status, 200);
    const searchList = await searchRes.json();
    assert.ok(searchList.notes.length >= 1);

    // 4. Create a new note with task, flashcard, wikilink, and XSS attempt
    const createRes = await fetch(`${srv.baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration Verification Note',
        folder: 'Testing',
        content: `---
title: Integration Verification Note
tags: [verification, e2e]
---
# Integration Verification Note
Links to [[Tessera Architecture & Philosophy]].
- [ ] Verify end to end !high @2026-11-25
What is ACID? :: Atomicity, Consistency, Isolation, Durability
<script>window.pwned=true</script>`
      })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.note.slug, 'integration-verification-note');
    assert.doesNotMatch(created.parsed.html, /<script>/i);

    // Wait briefly for WS event
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(wsEvents.some((e) => e.type === 'note:created'));

    // 5. Update note to generate version snapshot, compute Myers diff, and restore
    const v1Content = created.note.content;
    const v2Content = v1Content + '\n\nAdded second revision paragraph.';
    const updRes = await fetch(`${srv.baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: created.note.title,
        content: v2Content,
        folder: 'Testing',
        snapshotLabel: 'v2 edit'
      })
    });
    assert.equal(updRes.status, 200);

    const versRes = await fetch(`${srv.baseUrl}/api/notes/${created.note.id}/versions`);
    const vers = await versRes.json();
    assert.ok(vers.versions.length >= 2);
    const oldestId = vers.versions[vers.versions.length - 1].id;

    const diffRes = await fetch(`${srv.baseUrl}/api/notes/${created.note.id}/diff?from=${oldestId}&to=current`);
    assert.equal(diffRes.status, 200);
    const diffJson = await diffRes.json();
    assert.ok(diffJson.diff.stats.added >= 1);

    const restoreRes = await fetch(`${srv.baseUrl}/api/notes/${created.note.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: oldestId })
    });
    assert.equal(restoreRes.status, 200);
    const restored = await restoreRes.json();
    assert.equal(restored.note.content.trim(), v1Content.trim());

    // 6. Task two-way toggle writes directly back to Markdown
    const tasksRes = await fetch(`${srv.baseUrl}/api/tasks`);
    const tasksData = await tasksRes.json();
    const myTask = tasksData.tasks.find((t) => t.noteId === created.note.id);
    assert.ok(myTask);
    assert.equal(myTask.done, false);

    const toggleRes = await fetch(`${srv.baseUrl}/api/tasks/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId: created.note.id, lineNo: myTask.lineNo, done: true })
    });
    assert.equal(toggleRes.status, 200);
    const noteAfterToggle = await (await fetch(`${srv.baseUrl}/api/notes/${created.note.id}`)).json();
    assert.match(noteAfterToggle.note.content, /- \[x\] Verify end to end/);

    // 7. FSRS Flashcard review
    const fcRes = await fetch(`${srv.baseUrl}/api/flashcards`);
    const fcData = await fcRes.json();
    const myCard = fcData.cards.find((c) => c.noteId === created.note.id);
    assert.ok(myCard);
    assert.ok(myCard.preview[3].label);

    const revRes = await fetch(`${srv.baseUrl}/api/flashcards/${myCard.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 3 })
    });
    assert.equal(revRes.status, 200);
    const revData = await revRes.json();
    assert.equal(revData.card.reps, 1);
    assert.ok(revData.card.stability > 0);

    // 8. Graph & BFS Shortest Path
    const graphRes = await fetch(`${srv.baseUrl}/api/graph?includeGhosts=true`);
    const graphData = await graphRes.json();
    assert.ok(graphData.nodes.length >= 6);
    assert.ok(graphData.ghosts.length >= 1);

    const hub = graphData.nodes.find((n) => n.slug === 'tessera-architecture-philosophy');
    assert.ok(hub);
    const pathRes = await fetch(`${srv.baseUrl}/api/graph/path?source=${created.note.id}&target=${hub.id}`);
    const pathData = await pathRes.json();
    assert.equal(pathData.found, true);
    assert.deepEqual(pathData.pathIds, [created.note.id, hub.id]);

    // 9. Spatial Board CRUD
    const boardsRes = await fetch(`${srv.baseUrl}/api/boards`);
    const boardsData = await boardsRes.json();
    assert.ok(boardsData.boards.length >= 1);
    const firstBoard = boardsData.boards[0];
    const updBoardRes = await fetch(`${srv.baseUrl}/api/boards/${firstBoard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: firstBoard.title,
        description: 'Updated via integration test',
        viewport: { x: 24, y: 16, zoom: 1.1 },
        nodes: firstBoard.nodes,
        edges: firstBoard.edges
      })
    });
    assert.equal(updBoardRes.status, 200);

    // 10. ZIP Vault Export verification
    const zipRes = await fetch(`${srv.baseUrl}/api/vault/export?format=zip`);
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    const zipEntries = parseZipBuffer(zipBuf);
    assert.ok(zipEntries.some((e) => e.name.endsWith('.md')));
    assert.ok(zipEntries.some((e) => e.name === '.tessera/boards.json'));

    ws.close();
  } finally {
    await srv.close();
  }
});
