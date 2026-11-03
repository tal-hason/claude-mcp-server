// claude-mcp-server/server.js
// @ai-rules:
// 1. [Pattern]: MCP stdio server — thin wiring layer, delegates to command-builder.js and models.js.
// 2. [Pattern]: Uses @modelcontextprotocol/sdk v1.x (server.tool API).
// 3. [Pattern]: Tools: claude_models (model discovery) and claude_prompt (command builder).
// 4. [Constraint]: All stderr logging — stdout is the MCP JSON-RPC transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildCommand, MODE_NAMES } from './command-builder.js';
import { getAvailableModels } from './models.js';

const server = new McpServer({
  name: 'claude-cli',
  version: '0.8.0',
  description: [
    'Claude CLI bridge with model discovery, mode defaults, EnMaaS gateway routing, and Vertex failover.',
    'Instruction: Always call claude_models first to verify available models for EnMaaS or Vertex, then call claude_prompt to generate the shell command.',
  ].join(' '),
});

server.tool(
  'claude_models',
  [
    'List available models for Red Hat EnMaaS AI Gateway and GCP Vertex AI projects.',
    'INSTRUCTION: Call this tool FIRST to inspect supported models before generating a command with claude_prompt.',
    'Returns real-time models for EnMaaS (GLM 5.3, DeepSeek, etc.) and supported Claude models per Vertex AI project.',
  ].join(' '),
  {
    provider: z.enum(['auto', 'enmaas', 'vertex', 'all']).optional().default('all').describe('Provider filter: "enmaas", "vertex", or "all" (default).'),
    project: z.string().optional().describe('Filter for a specific GCP Vertex AI project ID.'),
  },
  async (params) => {
    const data = await getAvailableModels(params, process.env);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'claude_prompt',
  [
    'Build a Claude CLI command with mode defaults, gateway routing, and Vertex failover resolved.',
    'INSTRUCTION: Call claude_models first to discover supported models before calling this tool.',
    'Supports Red Hat EnMaaS AI Gateway (Sonnet/Opus 5.5, GLM 5.3) and GCP Vertex AI with budget failover.',
    'Returns JSON { command, cwd, description, block_until_ms } for agent shell execution.',
  ].join(' '),
  {
    prompt: z.string().describe('The prompt to send to Claude'),
    mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor.'),
    model: z.string().optional().describe('Exact model name (e.g. sonnet, rits/zai-org/glm-5-3). Defaults to CLI default.'),
    secondaryModel: z.string().optional().describe('Fallback model name for cross-provider failover (defaults to Sonnet).'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level.'),
    provider: z.enum(['auto', 'enmaas', 'vertex']).nullish().default('auto').describe('Inference provider: "auto" (default), "enmaas" (requires ENMAAS_KEY), or "vertex".'),
    primaryProject: z.string().optional().describe('Primary GCP project ID for Vertex AI execution.'),
    secondaryProject: z.string().optional().describe('Secondary GCP project ID for automatic quota/budget failover.'),
    primaryCredentials: z.string().optional().describe('Path to primary GCP service account credentials JSON.'),
    secondaryCredentials: z.string().optional().describe('Path to secondary GCP service account credentials JSON.'),
    systemPrompt: z.string().optional().describe('System prompt override (--system-prompt).'),
    sessionId: z.string().optional().describe('Resume a previous session by ID'),
    cwd: z.string().optional().describe('Working directory for Claude CLI'),
  },
  async (params) => buildCommand(params),
);

const transport = new StdioServerTransport();
await server.connect(transport);
