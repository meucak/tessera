import { WebSocketServer, WebSocket } from 'ws';

/**
 * WebSocket broadcast hub for real-time multi-tab synchronization.
 */
export class WsHub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();

    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      this.clients.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'hello' && msg.clientId) {
            ws.clientId = msg.clientId;
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    });

    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
    this.heartbeatTimer.unref?.();
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  broadcast(event, excludeClientId = null) {
    const payload = JSON.stringify({ ...event, ts: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (excludeClientId && ws.clientId === excludeClientId) continue;
      ws.send(payload);
    }
  }

  close() {
    clearInterval(this.heartbeatTimer);
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}
