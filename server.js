// claude-mcp-server/server.js
// @ai-rules:
// 1. [Pattern]: MCP stdio server wrapping Claude CLI. Cursor spawns this as a child process.
// 2. [Pattern]: serveStdio factory → McpServer with claude_prompt (sync), claude_dispatch + claude_result (async).
// 3. [Pattern]: When mode is set, merge mode defaults (effort, appendSystemPrompt). Caller overrides win.
// 4. [Constraint]: Import only from @modelcontextprotocol/server, zod/v4, and local modules.
// 5. [Constraint]: All stderr logging — stdout is the MCP JSON-RPC transport.
// 6. [Pattern]: SIGTERM/SIGINT → killActive() + stopWSBridge() ensures clean shutdown.
// 7. [Pattern]: WS bridge starts at module level (before serveStdio) so it's ready before first tool call.
// 8. [Pattern]: broadcast model field prefers data.model (CLI-resolved) over the caller's model opt,
//    since callers rarely pin a model explicitly — see cli-executor.js 'model' event.

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
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

serveStdio(() => {
  const server = new McpServer(
    { name: 'claude-cli', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'This tool gives you a second brain — a separate Claude process running on the user\'s machine',
        'with its own context, auth, and reasoning budget. When you call it, you are spawning an',
        'independent agent, not making an API call. That agent sees the local filesystem, has the',
        'user\'s ~/.claude/CLAUDE.md loaded, and runs to completion before returning.',
        '',
        'WHY this exists:',
        'You are a single agent with one context window. This tool lets you delegate work to a peer',
        'that thinks independently. Use it when your own context is full, when you need a fresh',
        'perspective unconstrained by your current reasoning, or when parallel work would be faster',
        'than sequential. The other agent does not share your conversation — it starts clean.',
        '',
        'WHAT the modes mean:',
        'Modes are not parameter presets — they shape how the other agent thinks.',
        '- architect: thinks about system boundaries and trade-offs, not implementation details.',
        '- planner: produces step-by-step plans with verification criteria, does not write code.',
        '- reviewer: adversarial — finds defects, grades severity, challenges assumptions.',
        '- explorer: fast and narrow — answers a specific question with evidence, nothing more.',
        '- executor: writes code in small verifiable batches, focuses on correctness.',
        'Without a mode, the agent has no role constraint — you control its behavior entirely via prompt.',
        '',
        'WHEN to reach for this tool:',
        '- You want a code review but you wrote the code — send it to reviewer for an independent eye.',
        '- You need to explore a codebase you haven\'t read — send explorer to a specific directory.',
        '- You\'re planning a large change — have planner draft the plan while you continue other work.',
        '- You want to validate your architecture — architect will challenge it without being polite.',
        '- You need parallel execution — you can spawn up to 5 agents simultaneously.',
        '',
        'WHAT sessionId means:',
        'Each call returns a sessionId. Passing it back resumes that agent\'s conversation —',
        'it remembers everything from the previous turn. Use this for multi-step delegation,',
        'not for one-shot queries.',
        '',
        'SYNC vs ASYNC — choosing the right tool:',
        'claude_prompt is synchronous — your tool call blocks until the CLI finishes. Fine for',
        'explorer (fast, low effort) and focused reviews. But a deep reviewer/architect audit',
        'reading many large files under max effort can take 15-30+ minutes, which risks timeout.',
        '',
        'For long-running work, use the async pair instead:',
        '1. claude_dispatch — same params as claude_prompt, but returns a dispatchId immediately.',
        '   The CLI runs in background with a 1-hour ceiling. Your tool call is not blocked.',
        '2. claude_result — pass the dispatchId to check status. Returns { status: "running", progressTail }',
        '   if still working, or { status: "done", output, sessionId, ... } when finished.',
        '',
        'Pattern: dispatch all your long-running workers, continue your own work, then collect',
        'results with claude_result when you are ready to merge. If a task is still running, wait',
        'and check again — do not abandon dispatched work just because the first poll returns "running".',
      ].join('\n'),
    },
  );

  server.registerTool(
    'claude_prompt',
    {
      description: [
        'Send a prompt to Claude CLI and get a response.',
        'Uses the locally installed claude CLI with your existing auth and ~/.claude/CLAUDE.md context.',
        'Optional mode param applies role-specific defaults (effort + system prompt).',
        'Supports model selection, effort level, system prompts, and session resume.',
      ].join(' '),
      inputSchema: z.object({
        prompt: z.string().describe('The prompt to send to Claude'),
        mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor. Applies role-specific effort and system prompt defaults.'),
        model: z.string().optional().describe('Exact model name (e.g. claude-sonnet-5). Defaults to CLI default.'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level. Mode default used if not provided.'),
        systemPrompt: z.string().optional().describe('System prompt override (--system-prompt). Independent of mode appendSystemPrompt.'),
        sessionId: z.string().optional().describe('Resume a previous session by ID'),
        cwd: z.string().optional().describe('Working directory for Claude CLI'),
        timeoutMs: z.number().int().positive().optional().describe('Max execution time in ms before the process is killed. Default 600000 (10 min). Increase for large file reads, high/max effort, or big diffs — a timed-out call returns a [TIMEOUT] marker instead of throwing.'),
      }),
    },
    async ({ prompt, mode, model, effort, systemPrompt, sessionId, cwd, timeoutMs }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let progressCount = 0;

      const notifyProgress = async (message) => {
        if (progressToken === undefined) return;
        progressCount++;
        try {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress: progressCount, message },
          });
        } catch { /* non-fatal */ }
      };

      const modeConfig = mode ? MODES[mode] : null;
      const effectiveEffort = effort || modeConfig?.effort;
      const appendSystemPrompt = modeConfig?.appendSystemPrompt;

      await notifyProgress(mode ? `[${mode}] Starting Claude CLI...` : 'Starting Claude CLI...');

      try {
        const result = await executeClaude({
          prompt, model, effort: effectiveEffort, systemPrompt,
          appendSystemPrompt, sessionId, cwd, timeoutMs,
          onProgress: (msg) => { notifyProgress(msg); },
          onBroadcast: (data) => {
            // data.model (resolved from CLI stream) takes priority over the caller-supplied
            // model opt, which is usually undefined since modes don't pin models by design.
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

  server.registerTool(
    'claude_dispatch',
    {
      description: [
        'Fire-and-forget: spawn a Claude CLI agent and return a dispatchId immediately.',
        'The agent runs in background (up to 1 hour) with no tool-call timeout pressure.',
        'Use for long-running reviewer/architect audits on large codebases.',
        'Poll claude_result with the returned dispatchId to collect the output when ready.',
      ].join(' '),
      inputSchema: z.object({
        prompt: z.string().describe('The prompt to send to Claude'),
        mode: z.enum(MODE_NAMES).optional().describe('Dispatch mode: architect, planner, reviewer, explorer, executor.'),
        model: z.string().optional().describe('Exact model name (e.g. claude-opus-4-8). Defaults to CLI default.'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort level.'),
        systemPrompt: z.string().optional().describe('System prompt override.'),
        sessionId: z.string().optional().describe('Resume a previous session by ID'),
        cwd: z.string().optional().describe('Working directory for Claude CLI'),
      }),
    },
    async ({ prompt, mode, model, effort, systemPrompt, sessionId, cwd }) => {
      const modeConfig = mode ? MODES[mode] : null;
      const effectiveEffort = effort || modeConfig?.effort;
      const appendSystemPrompt = modeConfig?.appendSystemPrompt;

      try {
        const dispatchId = dispatchClaude({
          prompt, model, effort: effectiveEffort, systemPrompt,
          appendSystemPrompt, sessionId, cwd,
          onBroadcast: (data) => {
            broadcast({ ...data, mode: mode || null, model: data.model || model || null });
          },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ dispatchId, status: 'running', message: 'Agent dispatched. Poll claude_result to collect output.' }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'claude_result',
    {
      description: [
        'Poll for the result of a dispatched Claude CLI agent.',
        'Returns status "running" with a progress tail if still working,',
        '"done" with the full output when finished, or "not_found" if the dispatchId is invalid.',
      ].join(' '),
      inputSchema: z.object({
        dispatchId: z.string().describe('The dispatchId returned by claude_dispatch'),
      }),
    },
    async ({ dispatchId }) => {
      const result = getDispatchResult(dispatchId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
});
