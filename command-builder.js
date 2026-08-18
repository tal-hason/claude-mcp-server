// claude-mcp-server/command-builder.js
// @ai-rules:
// 1. [Pattern]: Pure logic — no side effects, no I/O, no MCP wiring.
// 2. [Pattern]: Exports shellQuote + buildCommand for both server.js and tests.
// 3. [Constraint]: Must not import MCP SDK or trigger transport connections.

import { randomUUID } from 'node:crypto';
import { MODES, MODE_NAMES } from './modes.js';

export { MODE_NAMES };

export const MAX_PROMPT_BYTES = 100_000;

export function shellQuote(s) {
  if (typeof s !== 'string') return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildCommand(params) {
  if (Buffer.byteLength(params.prompt) > MAX_PROMPT_BYTES) {
    return {
      content: [{ type: 'text', text: 'Error: prompt exceeds 100KB. Write to a temp file and use --input-file, or split the review.' }],
      isError: true,
    };
  }

  const modeConfig = params.mode ? MODES[params.mode] : null;
  const effort = params.effort || modeConfig?.effort;
  const appendPrompt = modeConfig?.appendSystemPrompt;
  const mode = params.mode || 'prompt';
  const model = params.model || 'default';

  const bin = process.env.CLAUDE_BIN || 'claude';

  const args = [shellQuote(bin), '--print', '--output-format', 'text', '--verbose'];
  if (params.model) args.push('--model', shellQuote(params.model));
  if (effort) args.push('--effort', effort);
  if (params.systemPrompt) args.push('--system-prompt', shellQuote(params.systemPrompt));
  if (appendPrompt) args.push('--append-system-prompt', shellQuote(appendPrompt));
  if (params.sessionId) args.push('--resume', shellQuote(params.sessionId));

  const delim = '__PROMPT_' + randomUUID().slice(0, 8) + '__';

  const colors = { architect: '35', reviewer: '31', planner: '34', explorer: '32', executor: '33' };
  const c = colors[mode] || '37';

  const command = [
    `_start=$(date +%s)`,
    `printf '\\033[1;${c}m┌─ %s │ %s │ %s ─┐\\033[0m\\n' ${shellQuote(mode.toUpperCase())} ${shellQuote(model)} "$(date +%H:%M:%S)"`,
    `${args.join(' ')} <<'${delim}'`,
    params.prompt,
    delim,
    `_elapsed=$(( $(date +%s) - _start ))`,
    `printf '\\033[1;${c}m└─ DONE │ %ss ─┘\\033[0m\\n' "$_elapsed"`,
  ].join('\n');

  const label = `Claude CLI ${mode} (effort: ${effort || 'default'})`;

  return { content: [{ type: 'text', text: JSON.stringify({
    command,
    cwd: params.cwd || null,
    description: label,
    block_until_ms: 0,
  }) }] };
}
