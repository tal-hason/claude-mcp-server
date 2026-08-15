// claude-mcp-server/server.js
// @ai-rules:
// 1. [Pattern]: MCP stdio server — thin wiring layer, delegates to command-builder.js.
// 2. [Pattern]: Uses @modelcontextprotocol/sdk v1.x (server.tool API).
// 3. [Pattern]: Single tool (claude_prompt) returns { command, cwd } JSON for the agent to execute via Shell.
// 4. [Constraint]: All stderr logging — stdout is the MCP JSON-RPC transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildCommand, MODE_NAMES } from './command-builder.js';

const server = new McpServer({
  name: 'claude-cli',
  version: '0.5.0',
  description: [
    'Claude CLI bridge — builds shell commands with mode defaults resolved.',
    'Returns a command string for the agent to execute via Cursor Shell tool.',
    'Modes: architect, planner, reviewer, explorer, executor.',
  ].join(' '),
});

server.tool(
  'claude_prompt',
  [
    'Build a Claude CLI command with mode defaults resolved.',
    'Returns JSON { command, cwd } — execute the command via Cursor Shell tool.',
    'For long-running tasks, use block_until_ms: 0 to background.',
  ].join(' '),
  {
    prompt: z.string().describe('The prompt to send to Claude'),
    mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor.'),
    model: z.string().optional().describe('Exact model name (e.g. claude-opus-4-8). Defaults to CLI default.'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level.'),
    systemPrompt: z.string().optional().describe('System prompt override (--system-prompt).'),
    sessionId: z.string().optional().describe('Resume a previous session by ID'),
    cwd: z.string().optional().describe('Working directory for Claude CLI'),
  },
  async (params) => buildCommand(params),
);

const transport = new StdioServerTransport();
await server.connect(transport);
