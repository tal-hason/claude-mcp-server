// extension/src/extension.ts
// @ai-rules:
// 1. [Constraint]: CommonJS module (VS Code extension host requires it). NOT ESM.
// 2. [Pattern]: Singleton WebviewPanel via createOrShow. WS client connects on command.
// 3. [Pattern]: WS reconnect backoff: 1s → 2s → 4s → max 10s. Resets on successful open.
// 4. [Gotcha]: panel.webview.postMessage() silently fails if panel is disposed. Guard with _panel check.
// 5. [Constraint]: CSP nonce generated per panel creation. Scripts via asWebviewUri only.

import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as crypto from 'crypto';

const WS_URL = 'ws://127.0.0.1:3456';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

let _panel: vscode.WebviewPanel | undefined;
let _ws: WebSocket | undefined;
let _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let _reconnectDelay = RECONNECT_BASE_MS;

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('claudeCli.showPanel', () => {
    createOrShowPanel(context);
  });
  context.subscriptions.push(cmd);
}

function createOrShowPanel(context: vscode.ExtensionContext) {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const mediaPath = vscode.Uri.joinPath(context.extensionUri, 'media');

  _panel = vscode.window.createWebviewPanel(
    'claudeCliPanel',
    'Claude CLI',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [mediaPath],
      retainContextWhenHidden: true,
    },
  );

  _panel.webview.html = getWebviewHtml(_panel.webview, context.extensionUri);

  _panel.onDidDispose(() => {
    _panel = undefined;
    disconnectWS();
  }, null, context.subscriptions);

  connectWS();
}

function connectWS() {
  disconnectWS();

  _ws = new WebSocket(WS_URL);

  _ws.on('open', () => {
    _reconnectDelay = RECONNECT_BASE_MS;
    postToPanel({ type: 'ws-status', connected: true });
  });

  _ws.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      postToPanel(msg);
    } catch { /* malformed — ignore */ }
  });

  _ws.on('close', () => {
    postToPanel({ type: 'ws-status', connected: false });
    scheduleReconnect();
  });

  _ws.on('error', () => {
    /* close event follows — reconnect handled there */
  });
}

function disconnectWS() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = undefined;
  }
  if (_ws) {
    _ws.removeAllListeners();
    if (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING) {
      _ws.close();
    }
    _ws = undefined;
  }
}

function scheduleReconnect() {
  if (!_panel) return;
  _reconnectTimer = setTimeout(() => {
    connectWS();
  }, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS);
}

function postToPanel(data: unknown) {
  _panel?.webview.postMessage(data);
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude CLI</title>
  <style nonce="${nonce}">
    :root {
      --gap: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, monospace);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: var(--gap);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      display: flex;
      align-items: center;
      gap: var(--gap);
      padding-bottom: var(--gap);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    .badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.architect { background: #7c3aed; color: #fff; }
    .badge.planner  { background: #2563eb; color: #fff; }
    .badge.reviewer { background: #dc2626; color: #fff; }
    .badge.explorer { background: #059669; color: #fff; }
    .badge.executor { background: #d97706; color: #fff; }
    .badge.default  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconUnset, #888);
      flex-shrink: 0;
    }
    .status-dot.connected { background: var(--vscode-testing-iconPassed, #4caf50); }
    .status-dot.running   { background: var(--vscode-testing-iconQueued, #ff9800); animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: 0.4; } }
    .status-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .output {
      flex: 1;
      overflow-y: auto;
      padding: var(--gap);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
      background: var(--vscode-editor-background);
    }
    .output .tool-call {
      color: var(--vscode-debugTokenExpression-name, #9cdcfe);
    }
    .output .tool-call::before { content: "▸ "; }
    .output .error-line {
      color: var(--vscode-errorForeground, #f44747);
    }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="status-dot" id="statusDot"></span>
    <span class="status-label" id="statusLabel">Disconnected</span>
    <span class="badge default" id="modeBadge" style="display:none"></span>
  </div>
  <div class="output" id="output">
    <div class="empty-state" id="emptyState">Waiting for Claude CLI output…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate() {
  disconnectWS();
  _panel?.dispose();
}
