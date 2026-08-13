// claude-mcp-server/cli-executor.js
// @ai-rules:
// 1. [Pattern]: Spawns claude CLI with --print --output-format stream-json. Returns { output, sessionId }.
// 2. [Pattern]: onProgress callback receives parsed stream lines for MCP progress notifications (debounced).
// 3. [Pattern]: Concurrency guard — one CLI process at a time via _active flag. Rejects concurrent calls.
// 4. [Pattern]: SIGKILL escalation — if SIGTERM doesn't kill the process within 5s, escalate to SIGKILL.
// 5. [Pattern]: systemPrompt (--system-prompt) and appendSystemPrompt (--append-system-prompt) are
//    independent. Both pass through simultaneously. Neither affects ~/.claude/CLAUDE.md discovery.
// 6. [Pattern]: Result-event text stored as fallback — if stream was interrupted and textAccum is empty,
//    the result event's text is used instead of returning '(no output)'.

import { spawn } from 'node:child_process';
import { parseStreamLine } from './stream-parser.js';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const PROGRESS_DEBOUNCE_MS = 500;
const SIGKILL_DELAY_MS = 5_000;

let _activeChild = null;

function killWithEscalation(child) {
  child.kill('SIGTERM');
  const escalation = setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, SIGKILL_DELAY_MS);
  child.on('exit', () => clearTimeout(escalation));
}

/**
 * Execute Claude CLI and stream progress via callback.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.model]              - Exact model name (e.g. 'claude-sonnet-5')
 * @param {string} [opts.effort]             - Effort level (low|medium|high|xhigh|max)
 * @param {string} [opts.systemPrompt]       - System prompt override (--system-prompt)
 * @param {string} [opts.appendSystemPrompt] - Additive system prompt (--append-system-prompt)
 * @param {string} [opts.sessionId]          - Resume session via --resume
 * @param {string} [opts.cwd]               - Working directory
 * @param {number} [opts.timeoutMs]          - Process timeout
 * @param {(msg: string) => void} [opts.onProgress] - Stream callback (debounced at 500ms)
 * @returns {Promise<{ output: string, sessionId: string|null, exitCode: number }>}
 */
export function executeClaude(opts) {
  if (_activeChild) {
    return Promise.reject(new Error('Claude CLI is already running. One process at a time.'));
  }

  const {
    prompt, model, effort, systemPrompt, appendSystemPrompt,
    sessionId, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress,
  } = opts;

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

    _activeChild = child;

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
      _activeChild = null;

      if (lineBuffer.trim()) {
        const parsed = parseStreamLine(lineBuffer);
        if (parsed?.done && parsed?.text) resultFallback = parsed.text;
        if (parsed?.text && !parsed.done) {
          textAccum += parsed.text + '\n';
          if (onProgress) onProgress(parsed.text);
        }
        if (parsed?.sessionId) capturedSessionId = parsed.sessionId;
      }

      const output = textAccum.trim()
        || resultFallback?.trim()
        || stderr.trim()
        || '(no output)';

      resolve({ output, sessionId: capturedSessionId, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      _activeChild = null;
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/** Kill the active child process if any (for cleanup on server shutdown). */
export function killActive() {
  if (_activeChild) killWithEscalation(_activeChild);
}
