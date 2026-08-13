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
    :root { --gap: 4px; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family, monospace));
      font-size: var(--vscode-terminal-font-size, 13px);
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      padding: var(--gap);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px 4px;
      border-bottom: 1px solid var(--vscode-terminal-border, var(--vscode-panel-border, #333));
      flex-shrink: 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .badge {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge.architect { background: #7c3aed; color: #fff; }
    .badge.planner  { background: #2563eb; color: #fff; }
    .badge.reviewer { background: #dc2626; color: #fff; }
    .badge.explorer { background: #059669; color: #fff; }
    .badge.executor { background: #d97706; color: #fff; }
    .badge.default  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiRed, #888);
      flex-shrink: 0;
    }
    .status-dot.connected { background: var(--vscode-terminal-ansiGreen, #4caf50); }
    .status-dot.running   { background: var(--vscode-terminal-ansiYellow, #ff9800); animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: 0.3; } }
    .output {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: inherit;
      line-height: 1.35;
    }
    .output .line { display: flex; gap: 0; }
    .output .ts {
      color: var(--vscode-terminal-ansiBrightBlack, #666);
      flex-shrink: 0;
      user-select: none;
    }
    .output .text { flex: 1; }
    .output .tool-call .text {
      color: var(--vscode-terminal-ansiCyan, #9cdcfe);
    }
    .output .error-line .text {
      color: var(--vscode-terminal-ansiRed, #f44747);
    }
    .output .system-line .text {
      color: var(--vscode-terminal-ansiBrightBlack, #666);
      font-style: italic;
    }
    .output .cursor-blink {
      display: inline-block;
      width: 7px;
      height: 1.1em;
      background: var(--vscode-terminalCursor-foreground, var(--vscode-terminal-foreground, #ccc));
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 2px;
    }
    @keyframes blink { 50% { opacity: 0; } }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--vscode-terminal-ansiBrightBlack, var(--vscode-descriptionForeground));
      font-style: italic;
      font-size: 12px;
    }
    .empty-state::before { content: "$ "; opacity: 0.5; }
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
