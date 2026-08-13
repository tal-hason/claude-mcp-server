// extension/media/panel.js
// @ai-rules:
// 1. [Constraint]: Runs inside VS Code webview sandbox. No Node.js APIs. No imports.
// 2. [Pattern]: Receives messages via window.addEventListener('message'). Renders streaming text.
// 3. [Gotcha]: acquireVsCodeApi() can only be called once per webview lifecycle.
// 4. [Pattern]: Auto-scroll follows bottom unless user scrolls up (sticky scroll).

(function () {
  const output = document.getElementById('output');
  const emptyState = document.getElementById('emptyState');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const modeBadge = document.getElementById('modeBadge');

  let autoScroll = true;
  let currentState = 'idle';

  output.addEventListener('scroll', () => {
    const threshold = 40;
    autoScroll = (output.scrollHeight - output.scrollTop - output.clientHeight) < threshold;
  });

  function scrollToBottom() {
    if (autoScroll) {
      output.scrollTop = output.scrollHeight;
    }
  }

  function clearOutput() {
    while (output.lastChild && output.lastChild !== emptyState) {
      output.removeChild(output.lastChild);
    }
    if (emptyState) emptyState.style.display = '';
  }

  function hideEmptyState() {
    if (emptyState) emptyState.style.display = 'none';
  }

  function appendText(text, className) {
    hideEmptyState();
    const el = document.createElement('div');
    if (className) el.className = className;
    el.textContent = text;
    output.appendChild(el);
    scrollToBottom();
  }

  function setStatus(state) {
    currentState = state;
    statusDot.className = 'status-dot';

    switch (state) {
      case 'connected':
        statusDot.classList.add('connected');
        statusLabel.textContent = 'Connected';
        break;
      case 'running':
        statusDot.classList.add('running');
        statusLabel.textContent = 'Running…';
        break;
      case 'done':
        statusDot.classList.add('connected');
        statusLabel.textContent = 'Done';
        break;
      case 'disconnected':
        statusLabel.textContent = 'Reconnecting…';
        break;
      default:
        statusLabel.textContent = 'Idle';
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
        break;

      case 'status':
        if (msg.state === 'running') {
          clearOutput();
          setStatus('running');
          setMode(msg.mode || null);
        } else if (msg.state === 'done') {
          setStatus('done');
          appendText(`\n— exit ${msg.exitCode ?? '?'} —`, msg.exitCode === 0 ? '' : 'error-line');
        }
        break;

      case 'content':
        if (!msg.text) break;
        const lines = msg.text.split('\n');
        for (const line of lines) {
          if (line.startsWith('[tool] ')) {
            appendText(line, 'tool-call');
          } else if (line.startsWith('[error]')) {
            appendText(line, 'error-line');
          } else {
            appendText(line);
          }
        }
        break;
    }
  });

  setStatus('disconnected');
})();
