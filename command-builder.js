// claude-mcp-server/command-builder.js
// @ai-rules: [Pattern]: Pure logic — exports shellQuote + buildCommand. [Constraint]: Zero I/O or MCP SDK, <= 100 lines.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODES, MODE_NAMES, getModeDefaultModel } from './modes.js';
import { resolveProvider, buildProviderEnv, supportsEffort } from './providers.js';
import { resolveFailoverConfig, resolveSecondaryModel, buildFailoverScript } from './failover.js';
import { REDACT_SED } from './failover-scripts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FORMATTER_PATH = join(__dirname, 'stream-format.js');
export { MODE_NAMES };
export const MAX_PROMPT_BYTES = 100_000;

export function shellQuote(s) {
  return typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildCommand(params, env = process.env) {
  const modeConfig = params.mode ? MODES[params.mode] : null;
  const appendPrompt = modeConfig?.appendSystemPrompt;
  const totalBytes = Buffer.byteLength(params.prompt || '') + Buffer.byteLength(params.systemPrompt || '') + Buffer.byteLength(appendPrompt || '');
  if (totalBytes > MAX_PROMPT_BYTES) {
    return { content: [{ type: 'text', text: 'Error: prompt exceeds 100KB.' }], isError: true };
  }

  const resolvedModel = params.model || getModeDefaultModel(params.mode, env, params.provider);
  const model = resolvedModel || 'default';
  const effort = params.effort || modeConfig?.effort;
  const mode = params.mode || 'prompt';
  const provider = resolveProvider(params.provider, resolvedModel, env);
  const { envVars = [], settings = null } = buildProviderEnv(provider, resolvedModel) || {};

  const failoverConfig = resolveFailoverConfig(provider, params, env);
  const isFailover = Boolean(failoverConfig?.enabled);

  const bin = env.CLAUDE_BIN || 'claude', shared = [];
  if (params.systemPrompt) shared.push('--system-prompt', isFailover ? '"$(< "$_spfile")"' : shellQuote(params.systemPrompt));
  if (appendPrompt) shared.push('--append-system-prompt', shellQuote(appendPrompt));
  if (params.sessionId) shared.push('--resume', shellQuote(params.sessionId));

  const makeTierArgs = (m, e, s) => {
    const a = [shellQuote(bin), '--print', '--output-format', 'stream-json', '--verbose'];
    if (m) a.push('--model', shellQuote(m));
    if (e) a.push('--effort', shellQuote(e));
    if (s) a.push('--settings', shellQuote(JSON.stringify(s)));
    a.push(...shared);
    return a;
  };

  const pEffort = supportsEffort(resolvedModel) ? effort : null;
  const primaryArgs = makeTierArgs(resolvedModel, pEffort, settings);

  const secModel = resolveSecondaryModel(resolvedModel, params.secondaryModel) || (failoverConfig?.type === 'cross-provider' ? 'sonnet' : undefined);
  const secEffort = supportsEffort(secModel || 'sonnet') ? effort : null;
  const secondaryArgs = makeTierArgs(secModel, secEffort);

  const tertModel = resolveSecondaryModel(resolvedModel, params.tertiaryModel || params.secondaryModel) || (failoverConfig?.type === 'cross-provider' ? 'sonnet' : undefined);
  const tertEffort = supportsEffort(tertModel || 'sonnet') ? effort : null;
  const tertiaryArgs = makeTierArgs(tertModel, tertEffort);

  let delim = '__PROMPT_' + randomUUID().replace(/-/g, '') + '__';
  while ((params.prompt && params.prompt.includes(delim)) || (params.systemPrompt && params.systemPrompt.includes(delim))) {
    delim = '__PROMPT_' + randomUUID().replace(/-/g, '') + '__';
  }

  const c = { architect: '35', reviewer: '31', planner: '34', explorer: '32', executor: '33' }[mode] || '37', fmt = shellQuote(FORMATTER_PATH);
  const preflight = `command -v node >/dev/null 2>&1 && [ -f ${fmt} ] || { echo "[claude-mcp] Error: node or formatter missing" >&2; exit 1; }`;
  const commandLines = [preflight, `_start=$(date +%s)`];
  if (params.cwd) commandLines.push(`cd ${shellQuote(params.cwd)} || exit 1`);
  commandLines.push(`printf '\\033[1;${c}m┌─ %s │ %s │ %s ─┐\\033[0m\\n' ${shellQuote(mode.toUpperCase())} ${shellQuote(model)} "$(date +%H:%M:%S)"`);

  const envPrefix = envVars.length > 0 ? `${envVars.join(' ')} ` : '';
  if (failoverConfig?.enabled) {
    commandLines.push(buildFailoverScript({
      failoverConfig, envPrefix, primaryArgs, secondaryArgs, tertiaryArgs, delim,
      prompt: params.prompt, sysPrompt: params.systemPrompt, fmt, ...failoverConfig,
    }));
  } else {
    commandLines.push(`{ { ${envPrefix}${primaryArgs.join(' ')} <<'${delim}' 2>&1 1>&3 | ${REDACT_SED} >&2; } 3>&1 | node ${fmt}; }`, params.prompt, delim);
  }

  commandLines.push(`_elapsed=$(( $(date +%s) - _start ))`, `printf '\\033[1;${c}m└─ DONE │ %ss ─┘\\033[0m\\n' "$_elapsed"`);
  const command = '(set -eo pipefail; ' + commandLines.join('\n') + ')';
  const effortLabel = !supportsEffort(resolvedModel) ? 'unsupported' : (pEffort || (effort ? 'suppressed' : 'default'));
  const failoverLabel = failoverConfig?.enabled ? ` (failover: ${failoverConfig.secondaryProject}${failoverConfig.hasTertiary ? ` -> ${failoverConfig.tertiaryProject}` : ''})` : '';
  const label = `Claude CLI ${mode} [${provider}] (effort: ${effortLabel})${failoverLabel}`;

  return { content: [{ type: 'text', text: JSON.stringify({ command, cwd: params.cwd || null, description: label, block_until_ms: 0 }) }] };
}
