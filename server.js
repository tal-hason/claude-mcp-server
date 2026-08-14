// claude-mcp-server/server.js
// @ai-rules:
// 1. [Pattern]: MCP stdio server wrapping Claude CLI. Cursor spawns this as a child process.
// 2. [Pattern]: Uses @modelcontextprotocol/sdk v1.x (server.tool API) — Cursor only discovers
//    tools from this SDK version; the v2.0.0 @modelcontextprotocol/server package's registerTool
//    produces JSON Schema Draft 2020-12 which Cursor silently drops after the first tool.
// 3. [Pattern]: Single tool (claude_prompt) with action param: "prompt" (sync), "dispatch" (async), "result" (poll).
// 4. [Pattern]: When mode is set, merge mode defaults (effort, appendSystemPrompt). Caller overrides win.
// 5. [Constraint]: All stderr logging — stdout is the MCP JSON-RPC transport.
// 6. [Pattern]: SIGTERM/SIGINT → killActive() + stopWSBridge() ensures clean shutdown.
// 7. [Pattern]: WS bridge starts at module level (before server.connect) so it's ready before first tool call.
// 8. [Pattern]: broadcast model field prefers data.model (CLI-resolved) over the caller's model opt.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeClaude, dispatchClaude, getDispatchResult, listDispatched, killActive } from './cli-executor.js';
import { MODES, MODE_NAMES } from './modes.js';
import { startWSBridge, broadcast, stopWSBridge } from './ws-bridge.js';

startWSBridge();

function shutdown() {
  killActive();
  stopWSBridge();
  const t = setTimeout(() => process.exit(0), 6000);
  t.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const server = new McpServer({
  name: 'claude-cli',
  version: '0.3.0',
  description: [
    'Claude CLI bridge — a second brain. Spawns an independent Claude process on the user\'s machine',
    'with its own context, auth, and reasoning budget. Three actions via the action parameter:',
    '"prompt" (sync), "dispatch" (async fire-and-forget for long 15-30 min tasks), "result" (poll dispatched work).',
    'Modes shape how the agent thinks: architect, planner, reviewer, explorer, executor.',
  ].join(' '),
});

server.tool(
  'claude_prompt',
  [
    'Send a prompt to Claude CLI. Three actions:',
    '"prompt" (default) — synchronous, blocks until done.',
    '"dispatch" — fire-and-forget for long tasks (15-30+ min), returns dispatchId immediately.',
    '"result" — poll a dispatched task by dispatchId.',
  ].join(' '),
  {
    action: z.enum(['prompt', 'dispatch', 'result']).optional().describe('Action type. "prompt" (default): sync. "dispatch": async fire-and-forget. "result": poll dispatched task.'),
    prompt: z.string().optional().describe('The prompt to send (required for "prompt" and "dispatch" actions)'),
    mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor.'),
    model: z.string().optional().describe('Exact model name (e.g. claude-opus-4-8). Defaults to CLI default.'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level. Mode default used if not provided.'),
    systemPrompt: z.string().optional().describe('System prompt override (--system-prompt).'),
    sessionId: z.string().optional().describe('Resume a previous session by ID'),
    cwd: z.string().optional().describe('Working directory for Claude CLI'),
    timeoutMs: z.number().int().positive().optional().describe('Max execution time in ms (sync only). Default 600000 (10 min). Dispatch uses 1-hour ceiling.'),
    dispatchId: z.string().optional().describe('For action "result": the dispatchId from a prior "dispatch" call.'),
  },
  async (params) => {
    const action = params.action || 'prompt';

    // --- ACTION: result (poll a dispatched task) ---
    if (action === 'result') {
      if (!params.dispatchId) {
        return { content: [{ type: 'text', text: 'Error: dispatchId is required for action "result"' }], isError: true };
      }
      const result = getDispatchResult(params.dispatchId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    // --- Shared setup for prompt / dispatch ---
    const { prompt, mode, model, effort, systemPrompt, sessionId, cwd, timeoutMs } = params;
    if (!prompt) {
      return { content: [{ type: 'text', text: 'Error: prompt is required for action "prompt" or "dispatch"' }], isError: true };
    }

    const modeConfig = mode ? MODES[mode] : null;
    const effectiveEffort = effort || modeConfig?.effort;
    const appendSystemPrompt = modeConfig?.appendSystemPrompt;
    const makeBroadcast = (data) => {
      broadcast({ ...data, mode: mode || null, model: data.model || model || null });
    };

    // --- ACTION: dispatch (fire-and-forget) ---
    if (action === 'dispatch') {
      try {
        const dispatchId = dispatchClaude({
          prompt, model, effort: effectiveEffort, systemPrompt,
          appendSystemPrompt, sessionId, cwd,
          onBroadcast: makeBroadcast,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              dispatchId, status: 'running',
              message: 'Agent dispatched. Call again with action "result" and this dispatchId to collect output.',
            }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }

    // --- ACTION: prompt (synchronous, default) ---
    try {
      const result = await executeClaude({
        prompt, model, effort: effectiveEffort, systemPrompt,
        appendSystemPrompt, sessionId, cwd, timeoutMs,
        onBroadcast: makeBroadcast,
      });

      const parts = [result.output];
      if (result.sessionId) parts.push(`\n---\nSession ID: ${result.sessionId}`);
      if (result.exitCode !== 0) parts.push(`\n[exit code: ${result.exitCode}]`);

      return { content: [{ type: 'text', text: parts.join('') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
