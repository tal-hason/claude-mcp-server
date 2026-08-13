// claude-mcp-server/ws-bridge.js
// @ai-rules:
// 1. [Pattern]: Minimal WS server for streaming CLI output to VS Code extension.
// 2. [Constraint]: Bind localhost only — never expose to network.
// 3. [Constraint]: Port conflict = noop broadcast + stderr warning (non-fatal).
// 4. [Gotcha]: broadcast() must tolerate zero connected clients silently.
// 5. [Security]: verifyClient rejects connections with an Origin header (browser requests).
//    Only the VS Code extension host (Node.js WS client, no Origin) should connect.

import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_PORT = 3456;

let _wss = null;

export function startWSBridge() {
  const port = parseInt(process.env.WS_BRIDGE_PORT, 10) || DEFAULT_PORT;

  _wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: ({ req }) => {
      if (req.headers.origin) return false;
      return true;
    },
  });

  _wss.on('listening', () => {
    process.stderr.write(`[ws-bridge] Listening on 127.0.0.1:${port}\n`);
  });

  _wss.on('error', (err) => {
    process.stderr.write(`[ws-bridge] ${err.code === 'EADDRINUSE' ? 'Port in use' : 'Error'}: ${err.message}\n`);
    _wss = null;
  });

  return { broadcast };
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
  if (_wss) {
    _wss.close();
    _wss = null;
  }
}
