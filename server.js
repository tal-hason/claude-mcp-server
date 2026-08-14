// claude-mcp-server/server.js
// @ai-rules:
// 1. [Pattern]: MCP stdio server wrapping Claude CLI. Cursor spawns this as a child process.
// 2. [Pattern]: Uses @modelcontextprotocol/sdk v1.x (server.tool API) — Cursor only discovers
//    tools from this SDK version; v2.0.0's registerTool produces JSON Schema Draft 2020-12 which
//    Cursor silently drops after the first tool.
// 3. [Pattern]: Single sync tool (claude_prompt). Long-running calls should be wrapped in a Cursor
//    background Task (generalPurpose, run_in_background: true) — Cursor's native notification
//    system handles completion delivery to the right conversation. No custom async dispatch needed.
// 4. [Pattern]: When mode is set, merge mode defaults (effort, appendSystemPrompt). Caller overrides win.
// 5. [Constraint]: All stderr logging — stdout is the MCP JSON-RPC transport.
// 6. [Pattern]: SIGTERM/SIGINT → killActive() + stopWSBridge() ensures clean shutdown.
// 7. [Pattern]: WS bridge starts at module level (before server.connect) so it's ready before first tool call.
// 8. [Pattern]: broadcast model field prefers data.model (CLI-resolved) over the caller's model opt.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeClaude, killActive } from './cli-executor.js';
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
  version: '0.4.0',
  description: [
    'Claude CLI bridge — a second brain. Spawns an independent Claude process with its own',
    'context, auth, and reasoning budget. Modes shape how the agent thinks: architect, planner,',
    'reviewer, explorer, executor. For long-running calls (15-30+ min), wrap in a Cursor',
    'background Task (generalPurpose, run_in_background: true) — Cursor notifies you when done.',
  ].join(' '),
});

server.tool(
  'claude_prompt',
  [
    'Send a prompt to Claude CLI and get a response.',
    'Uses the locally installed claude CLI with your existing auth and ~/.claude/CLAUDE.md context.',
    'Optional mode param applies role-specific defaults (effort + system prompt).',
    'For long-running reviewer/architect audits, wrap this call in a background Task subagent —',
    'Cursor will notify you when it completes. Do not worry about timeouts when using a Task wrapper.',
  ].join(' '),
  {
    prompt: z.string().describe('The prompt to send to Claude'),
    mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor.'),
    model: z.string().optional().describe('Exact model name (e.g. claude-opus-4-8). Defaults to CLI default.'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level. Mode default used if not provided.'),
    systemPrompt: z.string().optional().describe('System prompt override (--system-prompt).'),
    sessionId: z.string().optional().describe('Resume a previous session by ID'),
    cwd: z.string().optional().describe('Working directory for Claude CLI'),
    timeoutMs: z.number().int().positive().optional().describe('Max execution time in ms. Default 600000 (10 min). Increase for large diffs or wrap in a background Task instead.'),
  },
  async (params) => {
    const { prompt, mode, model, effort, systemPrompt, sessionId, cwd, timeoutMs } = params;

    const modeConfig = mode ? MODES[mode] : null;
    const effectiveEffort = effort || modeConfig?.effort;
    const appendSystemPrompt = modeConfig?.appendSystemPrompt;

    try {
      const result = await executeClaude({
        prompt, model, effort: effectiveEffort, systemPrompt,
        appendSystemPrompt, sessionId, cwd, timeoutMs,
        onBroadcast: (data) => {
          broadcast({ ...data, mode: mode || null, model: data.model || model || null });
        },
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
