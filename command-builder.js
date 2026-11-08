// claude-mcp-server/command-builder.js
// @ai-rules: [Pattern]: Pure logic — exports shellQuote + buildCommand. [Constraint]: Zero I/O or MCP SDK.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODES, MODE_NAMES } from './modes.js';
import { resolveProvider, buildProviderEnv, supportsEffort } from './providers.js';
import { resolveFailoverConfig, resolveSecondaryModel, buildFailoverScript } from './failover.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FORMATTER_PATH = join(__dirname, 'stream-format.js');
export { MODE_NAMES };
export const MAX_PROMPT_BYTES = 100_000;

export function shellQuote(s) {
  return typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildCommand(params) {
  if (Buffer.byteLength(params.prompt || '') > MAX_PROMPT_BYTES) {
    return { content: [{ type: 'text', text: 'Error: prompt exceeds 100KB. Write to a temp file and use --input-file, or split the review.' }], isError: true };
  }

  const modeConfig = params.mode ? MODES[params.mode] : null;
  const resolvedModel = params.model || modeConfig?.defaultModel;
  const model = resolvedModel || 'default';
  const effort = params.effort || modeConfig?.effort, appendPrompt = modeConfig?.appendSystemPrompt;
  const mode = params.mode || 'prompt';
  const provider = resolveProvider(params.provider, resolvedModel);
  const { envVars = [], settings = null } = buildProviderEnv(provider, resolvedModel) || {};

  const bin = process.env.CLAUDE_BIN || 'claude', shared = [];
  if (params.systemPrompt) shared.push('--system-prompt', shellQuote(params.systemPrompt));
  if (appendPrompt) shared.push('--append-system-prompt', shellQuote(appendPrompt));
  if (params.sessionId) shared.push('--resume', shellQuote(params.sessionId));

  const pEffort = supportsEffort(resolvedModel) ? effort : null;
  const primaryArgs = [shellQuote(bin), '--print', '--output-format', 'stream-json', '--verbose'];
  if (resolvedModel) primaryArgs.push('--model', shellQuote(resolvedModel));
  if (pEffort) primaryArgs.push('--effort', shellQuote(pEffort));
  if (settings) primaryArgs.push('--settings', shellQuote(JSON.stringify(settings)));
  primaryArgs.push(...shared);

  const failoverConfig = resolveFailoverConfig(provider, params, process.env);
  const secModel = resolveSecondaryModel(resolvedModel, params.secondaryModel) || (failoverConfig?.type === 'cross-provider' ? 'sonnet' : undefined);
  const secEffort = supportsEffort(secModel || 'sonnet') ? effort : null;
  const secondaryArgs = [shellQuote(bin), '--print', '--output-format', 'stream-json', '--verbose'];
  if (secModel) secondaryArgs.push('--model', shellQuote(secModel));
  if (secEffort) secondaryArgs.push('--effort', shellQuote(secEffort));
  secondaryArgs.push(...shared);

  const tertModel = resolveSecondaryModel(resolvedModel, params.tertiaryModel || params.secondaryModel) || (failoverConfig?.type === 'cross-provider' ? 'sonnet' : undefined);
  const tertEffort = supportsEffort(tertModel || 'sonnet') ? effort : null;
  const tertiaryArgs = [shellQuote(bin), '--print', '--output-format', 'stream-json', '--verbose'];
  if (tertModel) tertiaryArgs.push('--model', shellQuote(tertModel));
  if (tertEffort) tertiaryArgs.push('--effort', shellQuote(tertEffort));
  tertiaryArgs.push(...shared);

  let delim = '__PROMPT_' + randomUUID().replace(/-/g, '') + '__';
  while (params.prompt && params.prompt.includes(delim)) delim = '__PROMPT_' + randomUUID().replace(/-/g, '') + '__';

  const c = { architect: '35', reviewer: '31', planner: '34', explorer: '32', executor: '33' }[mode] || '37', fmt = shellQuote(FORMATTER_PATH);
  const commandLines = [`_start=$(date +%s)`];
  if (params.cwd) commandLines.push(`cd ${shellQuote(params.cwd)} || exit 1`);
  commandLines.push(`printf '\\033[1;${c}m┌─ %s │ %s │ %s ─┐\\033[0m\\n' ${shellQuote(mode.toUpperCase())} ${shellQuote(model)} "$(date +%H:%M:%S)"`);

  const envPrefix = envVars.length > 0 ? `${envVars.join(' ')} ` : '';
  if (failoverConfig?.enabled) {
    commandLines.push(buildFailoverScript({ failoverConfig, envPrefix, primaryArgs, secondaryArgs, tertiaryArgs, delim, prompt: params.prompt, fmt, ...failoverConfig }));
  } else {
    commandLines.push(`${envPrefix}${primaryArgs.join(' ')} <<'${delim}' | node ${fmt}`, params.prompt, delim);
  }

  commandLines.push(`_elapsed=$(( $(date +%s) - _start ))`, `printf '\\033[1;${c}m└─ DONE │ %ss ─┘\\033[0m\\n' "$_elapsed"`);
  const command = '(set -eo pipefail; ' + commandLines.join('\n') + ')';
  const effortLabel = !supportsEffort(resolvedModel) ? 'unsupported' : (pEffort || (effort ? 'suppressed' : 'default'));
  const failoverLabel = failoverConfig?.enabled ? ` (failover: ${failoverConfig.secondaryProject}${failoverConfig.hasTertiary ? ` -> ${failoverConfig.tertiaryProject}` : ''})` : '';
  const label = `Claude CLI ${mode} [${provider}] (effort: ${effortLabel})${failoverLabel}`;

  return { content: [{ type: 'text', text: JSON.stringify({ command, cwd: params.cwd || null, description: label, block_until_ms: 0 }) }] };
}
