// claude-mcp-server/cli-executor.js
// @ai-rules:
// 1. [Pattern]: Spawns claude CLI with --print --output-format stream-json. Returns { output, sessionId }.
// 2. [Pattern]: onProgress callback receives parsed stream lines for MCP progress notifications (debounced).
// 3. [Pattern]: Concurrent pool — up to MAX_CONCURRENT CLI processes tracked by taskId in _children Map.
// 4. [Pattern]: SIGKILL escalation — if SIGTERM doesn't kill within 5s, escalate to SIGKILL.
// 5. [Pattern]: systemPrompt and appendSystemPrompt are independent. Neither affects ~/.claude/CLAUDE.md.
// 6. [Pattern]: Result-event text stored as fallback for interrupted streams.
// 7. [Pattern]: onBroadcast callback for WS bridge — NOT debounced. Tagged with taskId for panel routing.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseStreamLine } from './stream-parser.js';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const PROGRESS_DEBOUNCE_MS = 500;
const SIGKILL_DELAY_MS = 5_000;
const MAX_CONCURRENT = 5;

const _children = new Map();

function killWithEscalation(child) {
  child.kill('SIGTERM');
  const escalation = setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, SIGKILL_DELAY_MS);
  child.on('exit', () => clearTimeout(escalation));
}

/**
 * Execute Claude CLI and stream progress via callback.
 * Supports up to MAX_CONCURRENT parallel executions.
 * Each call is assigned a unique taskId for WS broadcast tagging.
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
 * @returns {Promise<{ output: string, sessionId: string|null, exitCode: number, taskId: string }>}
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

    const child = spawn('claude', args, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    _children.set(taskId, child);
    if (onBroadcast) onBroadcast({ type: 'status', state: 'running', taskId });

    let lineBuffer = '';
    let textAccum = '';
    let resultFallback = null;
    let capturedSessionId = null;
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

      if (onBroadcast) onBroadcast({ type: 'status', state: 'done', exitCode: code ?? 1, taskId });

      const output = textAccum.trim()
        || resultFallback?.trim()
        || stderr.trim()
        || '(no output)';

      resolve({ output, sessionId: capturedSessionId, exitCode: code ?? 1, taskId });
    });

    child.on('error', (err) => {
      _children.delete(taskId);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
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
