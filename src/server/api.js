import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const CORE_DIR = path.resolve(__dirname, '../core');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON payload');
    err.status = 400;
    throw err;
  }
}

function serveStaticFile(res, baseDir, relPath) {
  const cleanRel = relPath.replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleanRel);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export function createRequestHandler(store, wsHub) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Malformed URL encoding' });
    }
    const method = req.method || 'GET';
    const clientId = req.headers['x-client-id'] || null;

    try {
      // API Routes
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          app: 'tessera',
          version: '1.0.0',
          dbMode: 'wal',
          ...store.getStats()
        });
      }

      if (pathname === '/api/notes' && method === 'GET') {
        const data = store.listNotes({
          q: url.searchParams.get('q') || '',
          folder: url.searchParams.get('folder') || '',
          tag: url.searchParams.get('tag') || '',
          filter: url.searchParams.get('filter') || ''
        });
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/notes' && method === 'POST') {
        const body = await readJsonBody(req);
        const created = store.createNote(body);
        wsHub.broadcast({ type: 'note:created', noteId: created.note.id }, clientId);
        return sendJson(res, 201, created);
      }

      if (pathname === '/api/notes/daily' && method === 'POST') {
        const body = await readJsonBody(req);
        const daily = store.getOrCreateDailyNote(body.date || null);
        if (daily.created) {
          wsHub.broadcast({ type: 'note:created', noteId: daily.note.id }, clientId);
        }
        return sendJson(res, 200, daily);
      }

      const noteSubMatch = pathname.match(/^\/api\/notes\/([^/]+)\/(versions|diff|restore|link-mention)$/);
      if (noteSubMatch) {
        const id = noteSubMatch[1];
        const action = noteSubMatch[2];

        if (action === 'versions' && method === 'GET') {
          return sendJson(res, 200, { versions: store.getVersions(id) });
        }
        if (action === 'diff' && method === 'GET') {
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to') || 'current';
          const diff = store.getVersionDiff(id, from, to);
          if (!diff) return sendJson(res, 404, { error: 'Version or note not found' });
          return sendJson(res, 200, diff);
        }
        if (action === 'restore' && method === 'POST') {
          const body = await readJsonBody(req);
          const restored = store.restoreVersion(id, body.versionId);
          if (!restored) return sendJson(res, 404, { error: 'Version not found' });
          wsHub.broadcast({ type: 'note:updated', noteId: id }, clientId);
          return sendJson(res, 200, restored);
        }
        if (action === 'link-mention' && method === 'POST') {
          const body = await readJsonBody(req);
          const linked = store.linkUnlinkedMention(id, body.sourceId);
          if (!linked) return sendJson(res, 404, { error: 'Note not found' });
          wsHub.broadcast({ type: 'note:updated', noteId: body.sourceId }, clientId);
          return sendJson(res, 200, linked);
        }
      }

      const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (noteMatch) {
        const idOrSlug = noteMatch[1];
        if (method === 'GET') {
          const data = store.getNote(idOrSlug);
          if (!data) return sendJson(res, 404, { error: 'Note not found' });
          return sendJson(res, 200, data);
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const updated = store.updateNote(idOrSlug, body);
          if (!updated) return sendJson(res, 404, { error: 'Note not found' });
          wsHub.broadcast({ type: 'note:updated', noteId: updated.note.id }, clientId);
          return sendJson(res, 200, updated);
        }
        if (method === 'DELETE') {
          const ok = store.deleteNote(idOrSlug);
          if (!ok) return sendJson(res, 404, { error: 'Note not found' });
          wsHub.broadcast({ type: 'note:deleted', noteId: idOrSlug }, clientId);
          return sendJson(res, 200, { deleted: true });
        }
      }

      if (pathname === '/api/graph' && method === 'GET') {
        const includeGhosts = url.searchParams.get('includeGhosts') !== 'false';
        return sendJson(res, 200, store.getGraph(includeGhosts));
      }

      if (pathname === '/api/graph/path' && method === 'GET') {
        const source = url.searchParams.get('source') || '';
        const target = url.searchParams.get('target') || '';
        return sendJson(res, 200, store.getGraphPath(source, target));
      }

      if (pathname === '/api/tasks' && method === 'GET') {
        return sendJson(res, 200, store.listTasks());
      }

      if (pathname === '/api/tasks/toggle' && method === 'POST') {
        const body = await readJsonBody(req);
        const resToggle = store.toggleTask(body.noteId, body.lineNo, body.done);
        if (!resToggle) return sendJson(res, 404, { error: 'Note not found' });
        wsHub.broadcast({ type: 'note:updated', noteId: body.noteId }, clientId);
        return sendJson(res, 200, resToggle);
      }

      if (pathname === '/api/flashcards' && method === 'GET') {
        return sendJson(res, 200, store.listFlashcards());
      }

      const reviewMatch = pathname.match(/^\/api\/flashcards\/([^/]+)\/review$/);
      if (reviewMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const rating = Number(body.rating);
        if (![1, 2, 3, 4].includes(rating)) {
          return sendJson(res, 400, { error: 'Rating must be 1, 2, 3, or 4' });
        }
        const reviewed = store.reviewFlashcard(reviewMatch[1], rating);
        if (!reviewed) return sendJson(res, 404, { error: 'Flashcard not found' });
        wsHub.broadcast({ type: 'card:reviewed', cardId: reviewMatch[1] }, clientId);
        return sendJson(res, 200, reviewed);
      }

      if (pathname === '/api/boards' && method === 'GET') {
        return sendJson(res, 200, { boards: store.listBoards() });
      }

      if (pathname === '/api/boards' && method === 'POST') {
        const body = await readJsonBody(req);
        const board = store.createBoard(body);
        wsHub.broadcast({ type: 'board:updated', boardId: board.id }, clientId);
        return sendJson(res, 201, { board });
      }

      const boardMatch = pathname.match(/^\/api\/boards\/([^/]+)$/);
      if (boardMatch) {
        const id = boardMatch[1];
        if (method === 'GET') {
          const board = store.getBoard(id);
          if (!board) return sendJson(res, 404, { error: 'Board not found' });
          return sendJson(res, 200, { board });
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const board = store.saveBoard(id, body);
          if (!board) return sendJson(res, 404, { error: 'Board not found' });
          wsHub.broadcast({ type: 'board:updated', boardId: board.id }, clientId);
          return sendJson(res, 200, { board });
        }
        if (method === 'DELETE') {
          const ok = store.deleteBoard(id);
          if (!ok) return sendJson(res, 404, { error: 'Board not found' });
          wsHub.broadcast({ type: 'board:deleted', boardId: id }, clientId);
          return sendJson(res, 200, { deleted: true });
        }
      }

      if (pathname === '/api/vault/export' && method === 'GET') {
        const format = url.searchParams.get('format') || 'json';
        if (format === 'zip') {
          const zipBuf = store.exportBundle('zip');
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="tessera-vault-${new Date().toISOString().slice(0, 10)}.zip"`,
            'Content-Length': zipBuf.length
          });
          res.end(zipBuf);
          return;
        }
        const jsonBundle = store.exportBundle('json');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="tessera-vault-${new Date().toISOString().slice(0, 10)}.json"`
        });
        res.end(JSON.stringify(jsonBundle, null, 2));
        return;
      }

      if (pathname === '/api/vault/import' && method === 'POST') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        const result = store.importBundle(body);
        wsHub.broadcast({ type: 'vault:imported' }, clientId);
        return sendJson(res, 200, result);
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: `Unknown endpoint: ${method} ${pathname}` });
      }

      // Isomorphic core JS modules exposed cleanly for browser ES modules
      if (pathname.startsWith('/core/')) {
        const rel = pathname.slice('/core/'.length);
        if (serveStaticFile(res, CORE_DIR, rel)) return;
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Static public UI assets + SPA fallback
      const targetPath = pathname === '/' ? 'index.html' : pathname;
      if (serveStaticFile(res, PUBLIC_DIR, targetPath)) return;
      if (!path.extname(pathname) && serveStaticFile(res, PUBLIC_DIR, 'index.html')) return;

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        console.error('[Tessera API Error]', err);
      }
      sendJson(res, status, { error: err.message || 'Internal Server Error' });
    }
  };
}
