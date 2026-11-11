// claude-mcp-server/providers.js
// @ai-rules: [Pattern]: Pure logic — gateway routing, env vars, and GCP project resolution. [Constraint]: Zero dependencies, <= 100 lines.

export function resolveGcpProjects(params = {}, env = process.env) {
  const e = env || process.env || {};
  const primaryProject = params.primaryProject || params.project || e.VERTEX_PRIMARY_PROJECT || e.ANTHROPIC_VERTEX_PROJECT_ID || null;
  const primaryCredentials = params.primaryCredentials || params.credentials || e.VERTEX_PRIMARY_CREDENTIALS || e.VERTEX_CREDENTIALS || e.GOOGLE_APPLICATION_CREDENTIALS || null;

  const explicitPrimaryProject = params.primaryProject || params.project || e.VERTEX_PRIMARY_PROJECT || null;
  const explicitPrimaryCredentials = params.primaryCredentials || params.credentials || e.VERTEX_PRIMARY_CREDENTIALS || e.VERTEX_CREDENTIALS || null;

  const secondaryProject = params.secondaryProject || e.VERTEX_SECONDARY_PROJECT || null;
  const secondaryCredentials = params.secondaryCredentials || e.VERTEX_SECONDARY_CREDENTIALS || null;

  const tertiaryProject = params.tertiaryProject || e.VERTEX_TERTIARY_PROJECT || e.VERTEX_FALLBACK_PROJECT || null;
  const tertiaryCredentials = params.tertiaryCredentials || e.VERTEX_TERTIARY_CREDENTIALS || e.VERTEX_FALLBACK_CREDENTIALS || null;

  return {
    primaryProject,
    primaryCredentials,
    explicitPrimaryProject,
    explicitPrimaryCredentials,
    secondaryProject,
    secondaryCredentials,
    tertiaryProject,
    tertiaryCredentials,
    hasTertiary: Boolean(tertiaryProject),
  };
}

export function resolveProvider(provider = 'auto', model = '', env = process.env) {
  if (provider && provider !== 'auto') return provider;
  const m = typeof model === 'string' ? model.toLowerCase() : '';
  const matchEnmaas = m.startsWith('rits/') || m.includes('enmaas') || (Boolean(env?.ENMAAS_KEY) && (m.includes('claude-opus-5-5') || m.includes('claude-sonnet-5-5')));
  return matchEnmaas ? 'enmaas' : 'vertex';
}

export function supportsEffort(model = '') {
  if (!model || typeof model !== 'string') return true;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return false;
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return true;
  return !(m.includes('glm') || m.includes('llama') || m.includes('qwen') || m.startsWith('rits/'));
}

export function buildProviderEnv(provider = 'vertex') {
  if (provider === 'enmaas') {
    return {
      envVars: [
        'CLAUDE_CODE_ENVIRONMENT_KIND=byoc', 'CLAUDE_CODE_USE_VERTEX=0',
        'ANTHROPIC_BASE_URL="${ENMAAS_BASE_URL:-https://api.enmaas.example.com}"',
        'ANTHROPIC_API_KEY="${ENMAAS_KEY:?Error: ENMAAS_KEY is not set in environment}"',
        'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1',
      ],
      settings: { env: { CLAUDE_CODE_USE_VERTEX: '' } },
    };
  }
  return {
    envVars: [
      'CLAUDE_CODE_ENVIRONMENT_KIND=""', 'CLAUDE_CODE_USE_VERTEX=1',
      'ANTHROPIC_API_KEY=""', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=0',
    ],
    settings: null,
  };
}
