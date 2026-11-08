// claude-mcp-server/failover.js
// @ai-rules: [Pattern]: Failover controller for intra-Vertex, cross-provider, and cascade. [Constraint]: Pure logic, <= 100 lines.

import { resolveGcpProjects } from './providers.js';
import { quote, _buildDualSubshellScript, _buildCascadeScript } from './failover-scripts.js';

export { _buildDualSubshellScript, _buildCascadeScript } from './failover-scripts.js';

export function resolveFailoverConfig(provider = 'vertex', params = {}, env = process.env) {
  if (typeof provider === 'object' && provider !== null) {
    env = (params && Object.keys(params).length > 0) ? params : (env || process.env);
    params = provider; provider = params.provider || 'vertex';
  }
  const isEnmaas = provider === 'enmaas' || (provider === 'auto' && (params.model?.startsWith('rits/') || params.model?.includes('enmaas')));
  const gcp = resolveGcpProjects(params, env);
  const secProj = gcp.secondaryProject || gcp.explicitPrimaryProject;
  const secCreds = gcp.secondaryCredentials || gcp.primaryCredentials;

  if (isEnmaas) {
    const finalSec = secProj || gcp.tertiaryProject;
    if (!finalSec) return { enabled: false, hasTertiary: false };
    return {
      enabled: true, type: 'cross-provider', primaryProvider: 'enmaas', secondaryProvider: 'vertex',
      secondaryProject: finalSec, secondaryCredentials: secProj ? secCreds : gcp.tertiaryCredentials,
      tertiaryProject: secProj ? gcp.tertiaryProject : undefined,
      tertiaryCredentials: secProj ? gcp.tertiaryCredentials : undefined,
      hasTertiary: Boolean(secProj && gcp.tertiaryProject),
    };
  }

  const p1 = gcp.primaryProject;
  const p2 = gcp.secondaryProject || (p1 !== gcp.tertiaryProject ? gcp.tertiaryProject : undefined);
  const p3 = (gcp.secondaryProject && gcp.tertiaryProject) ? gcp.tertiaryProject : undefined;
  return {
    enabled: Boolean((p2 && p1 && p2 !== p1) || p3), type: 'vertex', primaryProject: p1, secondaryProject: p2,
    primaryCredentials: gcp.primaryCredentials,
    secondaryCredentials: p2 === gcp.tertiaryProject ? gcp.tertiaryCredentials : gcp.secondaryCredentials,
    tertiaryProject: p3, tertiaryCredentials: gcp.tertiaryCredentials,
    hasTertiary: Boolean(p3),
  };
}

export const resolveVertexFailoverConfig = (p, e) => resolveFailoverConfig('vertex', p, e);

export function resolveSecondaryModel(primaryModel, secondaryModel) {
  if (secondaryModel) return secondaryModel;
  return (!primaryModel || primaryModel.includes('/') || primaryModel.startsWith('rits/')) ? undefined : primaryModel;
}

export function buildVertexFailoverScript({
  envPrefix = '', args, delim, prompt, fmt, primaryProject, secondaryProject, primaryCredentials, secondaryCredentials,
}) {
  const p1 = quote(primaryProject || ''), p2 = quote(secondaryProject || '');
  const c1 = primaryCredentials ? quote(primaryCredentials) : "''", c2 = secondaryCredentials ? quote(secondaryCredentials) : "''";
  const markerName = `failover_${(primaryProject || 'p1').replace(/[^a-zA-Z0-9_-]/g, '_')}_${(secondaryProject || 'p2').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const preamble = `   _run_claude() { local p="$1"; local c="$2"; [ -n "$p" ] && export ANTHROPIC_VERTEX_PROJECT_ID="$p"\n` +
    `     [ -n "$c" ] && export GOOGLE_APPLICATION_CREDENTIALS="$c"; ${envPrefix}${args.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}\n   }`;
  return _buildDualSubshellScript({
    markerName, preamble, runPrimary: `_run_claude ${p1} ${c1}`, runSecondary: `_run_claude ${p2} ${c2}`,
    regexPattern: 'RESOURCE_EXHAUSTED|Quota exceeded|429|budget|billing',
  });
}

export function buildCrossProviderFailoverScript({
  envPrefix = '', primaryArgs, secondaryArgs, delim, prompt, fmt, secondaryProject, secondaryCredentials,
}) {
  const p2 = quote(secondaryProject || ''), c2 = secondaryCredentials ? quote(secondaryCredentials) : null;
  const markerName = `failover_enmaas_${(secondaryProject || 'vertex').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const runPrimary = `${envPrefix}${primaryArgs.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`;
  const secExports = 'unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY\n' +
    `     export CLAUDE_CODE_USE_VERTEX=1 ANTHROPIC_VERTEX_PROJECT_ID=${p2} CLOUDSDK_CORE_PROJECT=${p2}${c2 ? ` GOOGLE_APPLICATION_CREDENTIALS=${c2}` : ''}`;
  const runSecondary = `${secExports}\n     ${secondaryArgs.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`;
  return _buildDualSubshellScript({ markerName, runPrimary, runSecondary });
}

export function buildCascadeScript({
  envPrefix = '', primaryArgs, secondaryArgs, tertiaryArgs, delim, prompt, fmt,
  type = 'cross-provider', primaryProject, primaryCredentials,
  secondaryProject, secondaryCredentials, tertiaryProject, tertiaryCredentials,
}) {
  const p1Id = (type === 'cross-provider' ? 'enmaas' : (primaryProject || 'p1')).replace(/[^a-zA-Z0-9_-]/g, '_');
  const p2Id = (secondaryProject || 't2').replace(/[^a-zA-Z0-9_-]/g, '_'), p3Id = (tertiaryProject || 't3').replace(/[^a-zA-Z0-9_-]/g, '_');
  const markerName = `cascade_${p1Id}_${p2Id}_${p3Id}`;
  return _buildCascadeScript({
    markerName, isCrossProvider: type === 'cross-provider',
    runPrimary: `${envPrefix}${primaryArgs.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`,
    runSecondary: `${secondaryArgs.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`,
    runTertiary: `${(tertiaryArgs || secondaryArgs).join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`,
    tier1Project: primaryProject, tier1Credentials: primaryCredentials,
    tier2Project: secondaryProject, tier2Credentials: secondaryCredentials,
    tier3Project: tertiaryProject, tier3Credentials: tertiaryCredentials,
  });
}

export function buildFailoverScript(opts, pArgs) {
  const o = opts.failoverConfig ? { ...opts, ...opts.failoverConfig } : opts;
  if (o.hasTertiary) return buildCascadeScript(o);
  return o.type === 'cross-provider' ? buildCrossProviderFailoverScript(o) : buildVertexFailoverScript({ ...o, args: o.primaryArgs || pArgs || o.args });
}
