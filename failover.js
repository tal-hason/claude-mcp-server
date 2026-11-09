// claude-mcp-server/failover.js
// @ai-rules: [Pattern]: Failover controller for intra-Vertex, cross-provider, and cascade. [Constraint]: Pure logic, <= 100 lines.

import { resolveGcpProjects, resolveProvider } from './providers.js';
import { quote, _buildDualSubshellScript, _buildCascadeScript } from './failover-scripts.js';

export { _buildDualSubshellScript, _buildCascadeScript } from './failover-scripts.js';

export function resolveFailoverConfig(provider = 'vertex', params = {}, env = process.env) {
  if (typeof provider === 'object' && provider !== null) {
    env = (params && Object.keys(params).length > 0) ? params : (env || process.env);
    params = provider; provider = params.provider || 'vertex';
  }
  const isEnmaas = resolveProvider(provider, params.model, env) === 'enmaas';
  const gcp = resolveGcpProjects(params, env);
  let secProj = gcp.secondaryProject || gcp.explicitPrimaryProject, secCreds = gcp.secondaryCredentials || gcp.primaryCredentials;
  let tertProj = gcp.tertiaryProject, tertCreds = gcp.tertiaryCredentials;

  if (isEnmaas) {
    if (!secProj && tertProj) { secProj = tertProj; secCreds = tertCreds; tertProj = undefined; tertCreds = undefined; }
    else if (secProj && tertProj === secProj) { tertProj = undefined; tertCreds = undefined; }
    if (!secProj) return { enabled: false, hasTertiary: false };
    return {
      enabled: true, type: 'cross-provider', primaryProvider: 'enmaas', secondaryProvider: 'vertex',
      secondaryProject: secProj, secondaryCredentials: secCreds,
      tertiaryProject: tertProj || undefined, tertiaryCredentials: tertProj ? tertCreds : undefined,
      hasTertiary: Boolean(tertProj),
    };
  }

  const p1 = gcp.primaryProject;
  let p2 = gcp.secondaryProject, p3 = gcp.tertiaryProject;
  if (p2 === p1) p2 = undefined;
  if (!p2 && p3 && p3 !== p1) { p2 = p3; p3 = undefined; }
  if (p3 === p1 || p3 === p2) p3 = undefined;

  const p2Creds = p2 === gcp.tertiaryProject ? gcp.tertiaryCredentials : (gcp.secondaryCredentials || gcp.primaryCredentials);
  return {
    enabled: Boolean((p2 && p1 && p2 !== p1) || p3), type: 'vertex', primaryProject: p1, secondaryProject: p2,
    primaryCredentials: gcp.primaryCredentials, secondaryCredentials: p2Creds,
    tertiaryProject: p3, tertiaryCredentials: p3 ? gcp.tertiaryCredentials : undefined, hasTertiary: Boolean(p3),
  };
}

export const resolveVertexFailoverConfig = (p, e) => resolveFailoverConfig('vertex', p, e);

export function resolveSecondaryModel(primaryModel, secondaryModel) {
  if (secondaryModel) return secondaryModel;
  return (!primaryModel || primaryModel.includes('/') || primaryModel.startsWith('rits/')) ? undefined : primaryModel;
}

export function buildVertexFailoverScript({
  envPrefix = '', args, delim, prompt, sysPrompt, fmt, primaryProject, secondaryProject, primaryCredentials, secondaryCredentials,
}) {
  const p1 = quote(primaryProject || ''), p2 = quote(secondaryProject || '');
  const c1 = primaryCredentials ? quote(primaryCredentials) : "''", c2 = secondaryCredentials ? quote(secondaryCredentials) : "''";
  const markerName = `failover_${(primaryProject || 'p1').replace(/[^a-zA-Z0-9_-]/g, '_')}_${(secondaryProject || 'p2').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const preamble = `   _run_claude() { local p="$1"; local c="$2"; [ -n "$p" ] && export ANTHROPIC_VERTEX_PROJECT_ID="$p" CLOUDSDK_CORE_PROJECT="$p"\n` +
    `     [ -n "$c" ] && export GOOGLE_APPLICATION_CREDENTIALS="$c"; export CLAUDE_CODE_USE_VERTEX=1\n` +
    `     unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ENMAAS_KEY ENMAAS_BASE_URL CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY\n` +
    `     ${envPrefix}${args.join(' ')} < "$_pfile" | node ${fmt}\n   }`;
  return _buildDualSubshellScript({
    markerName, preamble, runPrimary: `_run_claude ${p1} ${c1}`, runSecondary: `_run_claude ${p2} ${c2}`, delim, prompt, sysPrompt,
  });
}

export function buildCrossProviderFailoverScript({
  envPrefix = '', primaryArgs, secondaryArgs, delim, prompt, sysPrompt, fmt, secondaryProject, secondaryCredentials,
}) {
  const p2 = quote(secondaryProject || ''), c2 = secondaryCredentials ? quote(secondaryCredentials) : null;
  const markerName = `failover_enmaas_${(secondaryProject || 'vertex').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const runPrimary = `${envPrefix}${primaryArgs.join(' ')} < "$_pfile" | node ${fmt}`;
  const secExports = 'unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ENMAAS_KEY ENMAAS_BASE_URL CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY\n' +
    `     export CLAUDE_CODE_USE_VERTEX=1 ANTHROPIC_VERTEX_PROJECT_ID=${p2} CLOUDSDK_CORE_PROJECT=${p2}${c2 ? ` GOOGLE_APPLICATION_CREDENTIALS=${c2}` : ''}`;
  const runSecondary = `${secExports}\n     ${secondaryArgs.join(' ')} < "$_pfile" | node ${fmt}`;
  return _buildDualSubshellScript({ markerName, runPrimary, runSecondary, delim, prompt, sysPrompt });
}

export function buildCascadeScript(opts) {
  const { envPrefix = '', primaryArgs, secondaryArgs, tertiaryArgs, delim, prompt, sysPrompt, fmt, type = 'cross-provider' } = opts;
  const p1 = opts.primaryProject, p2 = opts.secondaryProject, p3 = opts.tertiaryProject;
  const p1Id = (type === 'cross-provider' ? 'enmaas' : (p1 || 'p1')).replace(/[^a-zA-Z0-9_-]/g, '_');
  const p2Id = (p2 || 't2').replace(/[^a-zA-Z0-9_-]/g, '_'), p3Id = (p3 || 't3').replace(/[^a-zA-Z0-9_-]/g, '_');
  return _buildCascadeScript({
    markerName: `cascade_${p1Id}_${p2Id}_${p3Id}`, isCrossProvider: type === 'cross-provider', delim, prompt, sysPrompt,
    runPrimary: `${envPrefix}${primaryArgs.join(' ')} < "$_pfile" | node ${fmt}`,
    runSecondary: `${secondaryArgs.join(' ')} < "$_pfile" | node ${fmt}`,
    runTertiary: `${(tertiaryArgs || secondaryArgs).join(' ')} < "$_pfile" | node ${fmt}`,
    tier1Project: p1, tier1Credentials: opts.primaryCredentials,
    tier2Project: p2, tier2Credentials: opts.secondaryCredentials,
    tier3Project: p3, tier3Credentials: opts.tertiaryCredentials,
  });
}

export function buildFailoverScript(opts) {
  const o = opts.failoverConfig ? { ...opts, ...opts.failoverConfig } : opts;
  if (o.hasTertiary) return buildCascadeScript(o);
  return o.type === 'cross-provider' ? buildCrossProviderFailoverScript(o) : buildVertexFailoverScript({ ...o, args: o.primaryArgs || o.args });
}
