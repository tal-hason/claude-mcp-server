// claude-mcp-server/ws-bridge.js
// @ai-rules:
// 1. [Pattern]: Minimal WS server for streaming CLI output to VS Code extension.
// 2. [Constraint]: Bind localhost only — never expose to network.
// 3. [Constraint]: Port conflict = retry up to 5 times, then noop broadcast (non-fatal).
// 4. [Gotcha]: broadcast() must tolerate zero connected clients silently.
// 5. [Security]: verifyClient rejects connections with an Origin header (browser requests).
// 6. [Pattern]: HTTP server created separately so its 'error' event is reliably caught
//    (WebSocketServer's internal server error forwarding is unreliable).

import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_PORT = 3456;
const RETRY_MS = 2000;

let _wss = null;
let _httpServer = null;

export function startWSBridge() {
  const port = parseInt(process.env.WS_BRIDGE_PORT, 10) || DEFAULT_PORT;
  const parsed = parseInt(process.env.WS_BRIDGE_MAX_RETRIES, 10);
  const maxRetries = Number.isNaN(parsed) ? 5 : parsed;
  let retries = 0;

  function tryBind() {
    const httpServer = createServer();

    httpServer.on('error', (err) => {
      process.stderr.write(`[ws-bridge] ${err.code === 'EADDRINUSE' ? 'Port in use' : 'Error'}: ${err.message}\n`);
      if (err.code === 'EADDRINUSE' && retries < maxRetries) {
        retries++;
        process.stderr.write(`[ws-bridge] Retry ${retries}/${maxRetries} in ${RETRY_MS}ms\n`);
        setTimeout(tryBind, RETRY_MS);
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      const wss = new WebSocketServer({
        server: httpServer,
        verifyClient: ({ req }) => !req.headers.origin,
      });
      _wss = wss;
      _httpServer = httpServer;
      process.stderr.write(`[ws-bridge] Listening on 127.0.0.1:${port}\n`);
    });
  }

  tryBind();
}

export function broadcast(data) {
  if (!_wss) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function stopWSBridge() {
  if (_wss) { _wss.close(); _wss = null; }
  if (_httpServer) { _httpServer.close(); _httpServer = null; }
}
