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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family, monospace));
      font-size: var(--vscode-terminal-font-size, 13px);
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      padding: 4px;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .global-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px 4px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--vscode-terminal-ansiRed, #888); flex-shrink: 0;
    }
    .status-dot.connected { background: var(--vscode-terminal-ansiGreen, #4caf50); }
    .status-dot.running { background: var(--vscode-terminal-ansiYellow, #ff9800); animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: 0.3; } }

    #container {
      flex: 1;
      overflow-y: auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 8px;
      padding: 8px 4px;
      align-content: start;
    }
    .task-card {
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      max-height: 350px;
      overflow: hidden;
      border-left: 3px solid #6b7280;
      transition: opacity 0.3s;
    }
    .task-card.mode-architect { border-left-color: #7c3aed; background: rgba(124,58,237,0.05); }
    .task-card.mode-planner  { border-left-color: #2563eb; background: rgba(37,99,235,0.05); }
    .task-card.mode-reviewer { border-left-color: #dc2626; background: rgba(220,38,38,0.05); }
    .task-card.mode-explorer { border-left-color: #059669; background: rgba(5,150,105,0.05); }
    .task-card.mode-executor { border-left-color: #d97706; background: rgba(217,119,6,0.05); }
    .task-card.mode-default  { border-left-color: #6b7280; background: rgba(107,114,128,0.05); }
    .task-card.completed { opacity: 0.5; }
    .task-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      font-size: 11px;
    }
    .badge {
      padding: 2px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .badge.architect { background: #7c3aed; color: #fff; }
    .badge.planner  { background: #2563eb; color: #fff; }
    .badge.reviewer { background: #dc2626; color: #fff; }
    .badge.explorer { background: #059669; color: #fff; }
    .badge.executor { background: #d97706; color: #fff; }
    .badge.default  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .task-id {
      color: var(--vscode-terminal-ansiBrightBlack, #888);
      font-size: 10px; font-family: monospace;
    }
    .task-time {
      color: var(--vscode-terminal-ansiBrightBlack, #888);
      font-size: 10px;
      margin-left: auto;
    }
    .task-status {
      font-size: 10px; font-weight: 600;
    }
    .task-status.running { color: var(--vscode-terminal-ansiYellow, #ff9800); }
    .task-status.running::after { content: " ●"; animation: pulse 1s infinite; }
    .task-status.done { color: var(--vscode-terminal-ansiGreen, #4caf50); }
    .task-status.failed { color: var(--vscode-terminal-ansiRed, #f44747); }
    .task-output {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      font-size: 12px;
    }
    .task-output .line { padding: 1px 0; }
    .task-output .tool-call { color: var(--vscode-terminal-ansiCyan, #9cdcfe); }
    .task-output .tool-call::before { content: "▸ "; }
    .task-output .error-line { color: var(--vscode-terminal-ansiRed, #f44747); }
    .empty-state {
      grid-column: 1 / -1;
      display: flex; align-items: center; justify-content: center;
      min-height: 200px; color: var(--vscode-descriptionForeground);
      font-style: italic; font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="global-header">
    <span class="status-dot" id="statusDot"></span>
    <span id="statusLabel">disconnected</span>
  </div>
  <div id="container">
    <div class="empty-state" id="emptyState">Waiting for Claude CLI agents…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate() {
  disconnectWS();
  _panel?.dispose();
}
