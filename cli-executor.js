// claude-mcp-server/cli-executor.js
// @ai-rules:
// 1. [Pattern]: Spawns claude CLI with --print --output-format stream-json. Returns { output, sessionId }.
// 2. [Pattern]: onProgress callback receives parsed stream lines for MCP progress notifications (debounced).
// 3. [Pattern]: Concurrent pool — up to MAX_CONCURRENT CLI processes tracked by taskId in _children Map.
// 4. [Pattern]: SIGKILL escalation uses exit-flag (not child.killed which is set on signal send, not death).
// 5. [Pattern]: systemPrompt and appendSystemPrompt are independent. Neither affects ~/.claude/CLAUDE.md.
// 6. [Pattern]: Result-event text (resultFallback) is the PRIMARY output. textAccum (which includes tool
//    annotations) is only used as fallback for interrupted streams where the result event never arrived.
// 7. [Pattern]: onBroadcast callback for WS bridge — NOT debounced. Tagged with taskId for panel routing.
// 8. [Pattern]: CLAUDE_BIN env var overrides PATH-based resolution of the claude binary.
// 9. [Pattern]: killWithEscalation (SIGTERM -> SIGKILL after SIGKILL_DELAY_MS) is reused for both
//    graceful shutdown (killActive) and timeout kills — see #11.
// 10. [Pattern]: onBroadcast emits a one-shot { type: 'model' } event once the CLI's system.init line
//     reports the actually-resolved model — the caller-supplied `model` opt is usually undefined
//     (modes don't pin models), so this is the only reliable "which model ran" signal.
// 11. [Pattern]: Timeout is a manual timer (not spawn's built-in timeout/killSignal option) so we can
//     attribute the kill and surface a [TIMEOUT] marker in output instead of silently returning
//     partial/empty text. Reviewer/architect modes reading many large files can legitimately exceed
//     the default — callers should pass a larger `timeoutMs`, not assume 5 min is universal.
// 12. [Pattern]: Async dispatch via dispatchClaude/getDispatchResult — fire-and-forget for long-running
//     tasks (20+ min reviewer/architect audits). dispatchClaude returns a taskId immediately; the CLI
//     runs in background with no tool-call timeout pressure. getDispatchResult polls by taskId,
//     returning { status: 'running', progressTail } or { status: 'done', ...fullResult }.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStreamLine } from './stream-parser.js';

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — deep reviewer/architect audits with many file reads need headroom
const DISPATCH_TIMEOUT_MS = 3_600_000; // 1 hour — async dispatch ceiling (sync callers still use DEFAULT_TIMEOUT_MS)
const PROGRESS_DEBOUNCE_MS = 500;
const SIGKILL_DELAY_MS = 5_000;
const MAX_CONCURRENT = 5;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const _children = new Map();

function killWithEscalation(child) {
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.kill('SIGTERM');
  const escalation = setTimeout(() => {
    if (!exited) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, SIGKILL_DELAY_MS);
  child.on('exit', () => clearTimeout(escalation));
}

/**
 * Execute Claude CLI and stream progress via callback.
 * Supports up to MAX_CONCURRENT parallel executions.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.appendSystemPrompt]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.onProgress]
 * @param {(data: object) => void} [opts.onBroadcast]
 * @returns {Promise<{ output: string, sessionId: string|null, exitCode: number, timedOut: boolean, taskId: string }>}
 */
export function executeClaude(opts) {
  if (_children.size >= MAX_CONCURRENT) {
    return Promise.reject(new Error(`Concurrent limit reached (${MAX_CONCURRENT}). Wait for a running task to finish.`));
  }

  const {
    prompt, model, effort, systemPrompt, appendSystemPrompt,
    sessionId, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress, onBroadcast,
  } = opts;

  const taskId = randomUUID().slice(0, 8);

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
    if (sessionId) args.push('--resume', sessionId);
    args.push('-p', prompt);

    const child = spawn(CLAUDE_BIN, args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    _children.set(taskId, child);
    if (onBroadcast) onBroadcast({ type: 'status', state: 'running', taskId });

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killWithEscalation(child);
    }, timeoutMs);

    let lineBuffer = '';
    let textAccum = '';
    let resultFallback = null;
    let capturedSessionId = null;
    let capturedModel = null;
    let lastProgressTime = 0;

    child.stdout.on('data', (data) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseStreamLine(line);
        if (!parsed) continue;
        if (parsed.sessionId) capturedSessionId = parsed.sessionId;
        if (parsed.model && !capturedModel) {
          capturedModel = parsed.model;
          if (onBroadcast) onBroadcast({ type: 'model', model: capturedModel, taskId });
        }
        if (parsed.done && parsed.text) {
          resultFallback = parsed.text;
        }
        if (onBroadcast && parsed.text && !parsed.done) {
          onBroadcast({ type: 'content', text: parsed.text, taskId });
        }
        if (parsed.text && !parsed.done) {
          textAccum += parsed.text + '\n';
          if (onProgress) {
            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_DEBOUNCE_MS) {
              lastProgressTime = now;
              onProgress(parsed.text);
            }
          }
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      _children.delete(taskId);

      if (lineBuffer.trim()) {
        const parsed = parseStreamLine(lineBuffer);
        if (parsed?.done && parsed?.text) resultFallback = parsed.text;
        if (parsed?.text && !parsed.done) {
          textAccum += parsed.text + '\n';
          if (onProgress) onProgress(parsed.text);
        }
        if (parsed?.sessionId) capturedSessionId = parsed.sessionId;
      }

      if (onBroadcast) onBroadcast({ type: 'status', state: 'done', exitCode: code ?? 1, timedOut, taskId });

      // Result event is the clean final answer (no tool annotations).
      // textAccum includes [tool] lines — only used as fallback for interrupted streams.
      let output = resultFallback?.trim()
        || textAccum.trim()
        || stderr.trim()
        || '(no output)';

      if (timedOut) {
        output += `\n\n[TIMEOUT: killed after ${timeoutMs}ms — pass a larger timeoutMs for large file reads or high/max effort reviews]`;
      }

      resolve({ output, sessionId: capturedSessionId, exitCode: code ?? 1, timedOut, taskId });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      _children.delete(taskId);
      reject(new Error(`Failed to spawn ${CLAUDE_BIN}: ${err.message}`));
    });
  });
}

/** Async dispatch store: dispatchId → { result, resultPath, progressTail, startedAt } */
const _dispatched = new Map();
const PROGRESS_TAIL_BYTES = 4000;
const DISPATCH_DIR = join(process.env.HOME || '/tmp', '.cursor', 'claude-dispatch');

/**
 * Fire-and-forget dispatch. Spawns the CLI and returns a dispatchId immediately.
 * The process runs in background with a generous timeout (DISPATCH_TIMEOUT_MS).
 * Poll via getDispatchResult(dispatchId) to retrieve the output when ready.
 *
 * @param {object} opts - same as executeClaude, minus timeoutMs (uses DISPATCH_TIMEOUT_MS)
 * @param {(data: object) => void} [opts.onBroadcast]
 * @returns {string} dispatchId
 */
export function dispatchClaude(opts) {
  const dispatchId = randomUUID().slice(0, 8);
  const resultPath = join(DISPATCH_DIR, `${dispatchId}.json`);
  const entry = { result: null, resultPath, progressTail: '', startedAt: Date.now() };
  _dispatched.set(dispatchId, entry);

  const callerBroadcast = opts.onBroadcast;
  const wrappedBroadcast = (data) => {
    if (data.type === 'content' && data.text) {
      entry.progressTail += data.text + '\n';
      if (entry.progressTail.length > PROGRESS_TAIL_BYTES * 2) {
        entry.progressTail = entry.progressTail.slice(-PROGRESS_TAIL_BYTES);
      }
    }
    if (callerBroadcast) callerBroadcast({ ...data, dispatchId });
  };

  async function writeResult(result) {
    entry.result = result;
    try {
      await mkdir(DISPATCH_DIR, { recursive: true });
      await writeFile(resultPath, JSON.stringify({
        dispatchId,
        status: 'done',
        elapsedMs: Date.now() - entry.startedAt,
        output: result.output,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      }, null, 2));
    } catch (err) {
      process.stderr.write(`[dispatch] Failed to write result to ${resultPath}: ${err.message}\n`);
    }
    if (callerBroadcast) callerBroadcast({ type: 'dispatch-done', dispatchId, resultPath });
  }

  executeClaude({
    ...opts,
    timeoutMs: DISPATCH_TIMEOUT_MS,
    onBroadcast: wrappedBroadcast,
  })
    .then((result) => writeResult(result))
    .catch((err) => writeResult({
      output: `Error: ${err.message}`, sessionId: null,
      exitCode: 1, timedOut: false, taskId: dispatchId,
    }));

  return { dispatchId, resultPath };
}

/**
 * Poll for the result of a dispatched task.
 *
 * @param {string} taskId - from dispatchClaude
 * @returns {{ status: 'running'|'done'|'not_found', elapsedMs?: number, progressTail?: string, output?: string, sessionId?: string, exitCode?: number, timedOut?: boolean }}
 */
export function getDispatchResult(taskId) {
  const entry = _dispatched.get(taskId);
  if (!entry) return { status: 'not_found' };

  const elapsedMs = Date.now() - entry.startedAt;

  if (entry.result) {
    _dispatched.delete(taskId);
    return {
      status: 'done',
      elapsedMs,
      resultPath: entry.resultPath,
      output: entry.result.output,
      sessionId: entry.result.sessionId,
      exitCode: entry.result.exitCode,
      timedOut: entry.result.timedOut,
    };
  }

  return {
    status: 'running',
    elapsedMs,
    resultPath: entry.resultPath,
    progressTail: entry.progressTail.slice(-PROGRESS_TAIL_BYTES),
  };
}

/** List all dispatched tasks and their statuses. */
export function listDispatched() {
  const tasks = [];
  for (const [id, entry] of _dispatched) {
    tasks.push({
      taskId: id,
      status: entry.result ? 'done' : 'running',
      elapsedMs: Date.now() - entry.startedAt,
    });
  }
  return tasks;
}

/** Kill all active child processes (for cleanup on server shutdown). */
export function killActive() {
  for (const child of _children.values()) {
    killWithEscalation(child);
  }
}

/** Number of currently running CLI processes. */
export function activeCount() {
  return _children.size;
}
