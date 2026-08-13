// extension/media/panel.js
// @ai-rules:
// 1. [Constraint]: Runs inside VS Code webview sandbox. No Node.js APIs. No imports.
// 2. [Pattern]: Multi-pane layout — each concurrent task gets its own card (like Darwin BlackBoard).
// 3. [Gotcha]: acquireVsCodeApi() can only be called once per webview lifecycle.
// 4. [Pattern]: Auto-scroll per card. Cards arranged in responsive grid.
// 5. [Pattern]: Model is usually unknown at card creation (modes don't pin models) — a hidden
//    `.task-model` span is created upfront and revealed via setTaskModel() once the server
//    broadcasts a { type: 'model' } event (fired when the CLI's own init line resolves it).

(function () {
  const container = document.getElementById('container');
  const emptyState = document.getElementById('emptyState');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');

  const vscode = acquireVsCodeApi();
  const tasks = new Map();

  document.getElementById('reconnectBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'reconnect' });
  });

  function ts() {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  function hideEmpty() { if (emptyState) emptyState.style.display = 'none'; }
  function showEmpty() { if (emptyState && tasks.size === 0) emptyState.style.display = ''; }

  function clearCompleted() {
    for (const [id, t] of tasks) {
      if (t.card.classList.contains('completed')) {
        t.card.remove();
        tasks.delete(id);
      }
    }
  }

  function setStatus(state) {
    statusDot.className = 'status-dot';
    switch (state) {
      case 'connected': statusDot.classList.add('connected'); statusLabel.textContent = 'connected'; break;
      case 'running':   statusDot.classList.add('running');   statusLabel.textContent = `running (${tasks.size})`; break;
      case 'done':      statusDot.classList.add('connected'); statusLabel.textContent = 'done'; break;
      case 'disconnected': statusLabel.textContent = 'reconnecting'; break;
      default: statusLabel.textContent = 'idle';
    }
  }

  function createTaskCard(taskId, mode, model) {
    hideEmpty();
    const card = document.createElement('div');
    const modeClass = ['architect','planner','reviewer','explorer','executor'].includes(mode) ? mode : 'default';
    card.className = `task-card mode-${modeClass}`;
    card.id = `task-${taskId}`;

    const header = document.createElement('div');
    header.className = 'task-header';

    const badge = document.createElement('span');
    badge.className = `badge ${modeClass}`;
    badge.textContent = mode || 'prompt';
    header.appendChild(badge);

    // Model is usually unknown at spawn time (modes don't pin models) — placeholder
    // element created upfront so setTaskModel() can fill it in once the CLI resolves it.
    const modelSpan = document.createElement('span');
    modelSpan.className = 'task-model';
    modelSpan.textContent = model || '';
    modelSpan.style.display = model ? '' : 'none';
    header.appendChild(modelSpan);

    const idSpan = document.createElement('span');
    idSpan.className = 'task-id';
    idSpan.textContent = taskId;
    header.appendChild(idSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'task-time';
    timeSpan.textContent = ts();
    header.appendChild(timeSpan);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'task-status running';
    statusSpan.textContent = 'running';
    header.appendChild(statusSpan);

    card.appendChild(header);

    const output = document.createElement('div');
    output.className = 'task-output';
    card.appendChild(output);

    container.prepend(card);
    tasks.set(taskId, { card, output, statusSpan, modelSpan, autoScroll: true });
    container.classList.toggle('single-card', tasks.size === 1);

    output.addEventListener('scroll', () => {
      const t = tasks.get(taskId);
      if (t) t.autoScroll = (output.scrollHeight - output.scrollTop - output.clientHeight) < 40;
    });

    return tasks.get(taskId);
  }

  function appendToTask(taskId, text, className) {
    const t = tasks.get(taskId);
    if (!t) return;
    const line = document.createElement('div');
    line.className = 'line' + (className ? ' ' + className : '');
    line.textContent = text;
    t.output.appendChild(line);
    if (t.autoScroll) t.output.scrollTop = t.output.scrollHeight;
  }

  function setTaskModel(taskId, model) {
    if (!model) return;
    const t = tasks.get(taskId);
    if (!t || !t.modelSpan) return;
    t.modelSpan.textContent = model;
    t.modelSpan.style.display = '';
  }

  function finishTask(taskId, exitCode) {
    const t = tasks.get(taskId);
    if (!t) return;
    t.statusSpan.textContent = exitCode === 0 ? 'done' : `exit ${exitCode}`;
    t.statusSpan.className = `task-status ${exitCode === 0 ? 'done' : 'failed'}`;
    t.card.classList.add('completed');
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ws-status':
        setStatus(msg.connected ? 'connected' : 'disconnected');
        break;

      case 'status': {
        const id = msg.taskId || 'default';
        if (msg.state === 'running') {
          clearCompleted();
          createTaskCard(id, msg.mode, msg.model);
          setStatus('running');
        } else if (msg.state === 'done') {
          finishTask(id, msg.exitCode ?? 1);
          const running = [...tasks.values()].filter(t => !t.card.classList.contains('completed'));
          setStatus(running.length > 0 ? 'running' : 'done');
        }
        break;
      }

      case 'content': {
        if (!msg.text) break;
        const id = msg.taskId || 'default';
        if (!tasks.has(id)) createTaskCard(id, null, msg.model);
        else setTaskModel(id, msg.model);
        for (const line of msg.text.split('\n')) {
          if (line.startsWith('[tool] ')) appendToTask(id, line, 'tool-call');
          else if (line.startsWith('[error]')) appendToTask(id, line, 'error-line');
          else appendToTask(id, line);
        }
        break;
      }

      case 'model': {
        setTaskModel(msg.taskId || 'default', msg.model);
        break;
      }
    }
  });

  setStatus('disconnected');
})();
