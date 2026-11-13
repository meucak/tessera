import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TesseraStore } from './db.js';
import { seedVaultIfEmpty } from './seedVault.js';
import { WsHub } from './wsHub.js';
import { createRequestHandler } from './api.js';

export async function createAppServer(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || '/app/data/tessera.db';
  const port = options.port ?? Number(process.env.PORT || 8092);
  const host = options.host || process.env.HOST || '0.0.0.0';
  const seed = options.seed !== false;

  const store = new TesseraStore(dbPath);
  if (seed) {
    seedVaultIfEmpty(store);
  }

  const wsHub = new WsHub();
  const handler = createRequestHandler(store, wsHub);
  const server = http.createServer(handler);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      wsHub.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  return {
    server,
    store,
    wsHub,
    close: async () => {
      wsHub.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createAppServer();
  const addr = app.server.address();
  console.log(`Tessera Studio listening on http://${addr.address}:${addr.port}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
