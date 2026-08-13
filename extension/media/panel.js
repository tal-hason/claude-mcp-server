// extension/media/panel.js
// @ai-rules:
// 1. [Constraint]: Runs inside VS Code webview sandbox. No Node.js APIs. No imports.
// 2. [Pattern]: Receives messages via window.addEventListener('message'). Renders streaming text.
// 3. [Gotcha]: acquireVsCodeApi() can only be called once per webview lifecycle.
// 4. [Pattern]: Auto-scroll follows bottom unless user scrolls up (sticky scroll).
// 5. [Pattern]: Terminal aesthetic — timestamps, prompt prefixes, blinking cursor when running.

(function () {
  const output = document.getElementById('output');
  const emptyState = document.getElementById('emptyState');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const modeBadge = document.getElementById('modeBadge');

  let autoScroll = true;
  let cursorEl = null;

  output.addEventListener('scroll', () => {
    autoScroll = (output.scrollHeight - output.scrollTop - output.clientHeight) < 40;
  });

  function scrollToBottom() {
    if (autoScroll) output.scrollTop = output.scrollHeight;
  }

  function ts() {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1);
  }

  function clearOutput() {
    while (output.lastChild && output.lastChild !== emptyState) {
      output.removeChild(output.lastChild);
    }
    if (emptyState) emptyState.style.display = '';
    cursorEl = null;
  }

  function hideEmptyState() {
    if (emptyState) emptyState.style.display = 'none';
  }

  function removeCursor() {
    if (cursorEl) { cursorEl.remove(); cursorEl = null; }
  }

  function addCursor() {
    removeCursor();
    cursorEl = document.createElement('span');
    cursorEl.className = 'cursor-blink';
    output.appendChild(cursorEl);
    scrollToBottom();
  }

  function appendLine(text, className) {
    hideEmptyState();
    removeCursor();

    const line = document.createElement('div');
    line.className = 'line' + (className ? ' ' + className : '');

    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = ts() + ' ';
    line.appendChild(tsSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = text;
    line.appendChild(textSpan);

    output.appendChild(line);
    scrollToBottom();
  }

  function appendSystem(text) {
    appendLine(text, 'system-line');
  }

  function setStatus(state) {
    statusDot.className = 'status-dot';
    switch (state) {
      case 'connected':
        statusDot.classList.add('connected');
        statusLabel.textContent = 'connected';
        break;
      case 'running':
        statusDot.classList.add('running');
        statusLabel.textContent = 'running';
        break;
      case 'done':
        statusDot.classList.add('connected');
        statusLabel.textContent = 'done';
        break;
      case 'disconnected':
        statusLabel.textContent = 'reconnecting';
        break;
      default:
        statusLabel.textContent = 'idle';
    }
  }

  function setMode(mode) {
    if (!mode) {
      modeBadge.style.display = 'none';
      return;
    }
    modeBadge.textContent = mode;
    modeBadge.className = 'badge ' + (['architect','planner','reviewer','explorer','executor'].includes(mode) ? mode : 'default');
    modeBadge.style.display = 'inline-block';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ws-status':
        setStatus(msg.connected ? 'connected' : 'disconnected');
        if (msg.connected) appendSystem('ws connected');
        break;

      case 'status': {
        const tag = msg.taskId ? `[${msg.taskId}] ` : '';
        if (msg.state === 'running') {
          setStatus('running');
          setMode(msg.mode || null);
          appendSystem(`${tag}claude` + (msg.mode ? ` --mode ${msg.mode}` : ''));
          addCursor();
        } else if (msg.state === 'done') {
          const code = msg.exitCode ?? '?';
          appendSystem(`${tag}exit ${code}` + (code === 0 ? '' : ' [FAILED]'));
          if (_children === 0) { removeCursor(); setStatus('done'); }
        }
        break;
      }

      case 'content': {
        if (!msg.text) break;
        removeCursor();
        const tag = msg.taskId ? `[${msg.taskId}] ` : '';
        const lines = msg.text.split('\n');
        for (const line of lines) {
          if (line.startsWith('[tool] ')) {
            appendLine(tag + line, 'tool-call');
          } else if (line.startsWith('[error]')) {
            appendLine(tag + line, 'error-line');
          } else {
            appendLine(tag + line);
          }
        }
        addCursor();
        break;
      }
    }
  });

  setStatus('disconnected');
})();
