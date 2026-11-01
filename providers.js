// claude-mcp-server/providers.js
// @ai-rules:
// 1. [Pattern]: Pure logic — gateway routing, env vars, and Vertex failover.
// 2. [Constraint]: Zero dependencies, no side effects, strict hexagonal boundary.

const shellQuote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");

export function resolveProvider(provider = 'auto', model = '') {
  if (provider && provider !== 'auto') return provider;
  const m = typeof model === 'string' ? model.toLowerCase() : '';
  const matchEnmaas = m.startsWith('rits/') || m.includes('enmaas') || m.includes('claude-opus-5-5') || m.includes('claude-sonnet-5-5');
  return matchEnmaas ? 'enmaas' : 'vertex';
}

export function supportsEffort(model = '') {
  if (!model || typeof model !== 'string') return true;
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return true;
  return !(m.includes('glm') || m.includes('llama') || m.includes('qwen') || m.includes('haiku') || m.startsWith('rits/'));
}

export function buildProviderEnv(provider = 'vertex', model = '') {
  if (provider === 'enmaas') {
    return {
      envVars: [
        'CLAUDE_CODE_ENVIRONMENT_KIND=byoc', 'CLAUDE_CODE_USE_VERTEX=0',
        "ANTHROPIC_BASE_URL='https://api.enmaas.devshift.net'",
        'ANTHROPIC_API_KEY="${ENMAAS_KEY:?Error: ENMAAS_KEY is not set in environment}"',
        'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1',
      ],
      settings: { env: { CLAUDE_CODE_USE_VERTEX: '' } },
    };
  }
  return {
    envVars: [
      'CLAUDE_CODE_ENVIRONMENT_KIND=""', 'CLAUDE_CODE_USE_VERTEX=1',
      "ANTHROPIC_BASE_URL=''", 'ANTHROPIC_API_KEY=""',
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=0',
    ],
    settings: null,
  };
}

export function resolveVertexFailoverConfig(params = {}, env = process.env) {
  const e = params.env || env || {};
  const primaryProject = params.primaryProject || e.VERTEX_PRIMARY_PROJECT || e.ANTHROPIC_VERTEX_PROJECT_ID || null;
  const secondaryProject = params.secondaryProject || e.VERTEX_SECONDARY_PROJECT || null;
  const primaryCredentials = params.primaryCredentials || e.VERTEX_PRIMARY_CREDENTIALS || e.GOOGLE_APPLICATION_CREDENTIALS || null;
  const secondaryCredentials = params.secondaryCredentials || e.VERTEX_SECONDARY_CREDENTIALS || null;
  return {
    enabled: Boolean(secondaryProject && primaryProject && secondaryProject !== primaryProject),
    primaryProject, secondaryProject, primaryCredentials, secondaryCredentials,
  };
}

export function buildVertexFailoverScript({
  envPrefix, args, delim, prompt, fmt, primaryProject, secondaryProject, primaryCredentials, secondaryCredentials,
}) {
  const p1 = shellQuote(primaryProject || ''), p2 = shellQuote(secondaryProject || '');
  const c1 = primaryCredentials ? shellQuote(primaryCredentials) : "''", c2 = secondaryCredentials ? shellQuote(secondaryCredentials) : "''";
  const markerName = `failover_${(primaryProject || 'p1').replace(/[^a-zA-Z0-9_-]/g, '_')}_${(secondaryProject || 'p2').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return [
    ` (`,
    `   _marker_dir="\${XDG_RUNTIME_DIR:-\$HOME/.cache/claude-cli}"`,
    `   mkdir -p -m 700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"`,
    `   _marker="$_marker_dir/${markerName}"`,
    `   if [ -f "$_marker" ]; then`,
    `     _mtime=$(date -r "$_marker" +%s 2>/dev/null || stat -c %Y "$_marker" 2>/dev/null || stat -f %m "$_marker" 2>/dev/null || echo 0)`,
    `     [ $(( $(date +%s) - _mtime )) -ge 1800 ] && rm -f "$_marker"`,
    `   fi`,
    `   _err_log=$(mktemp /tmp/claude_err_XXXXXX)`,
    `   trap 'rm -f "$_err_log"' EXIT`,
    `   _run_claude() {`,
    `     local p="$1"; local c="$2"`,
    `     [ -n "$p" ] && export ANTHROPIC_VERTEX_PROJECT_ID="$p"`,
    `     [ -n "$c" ] && export GOOGLE_APPLICATION_CREDENTIALS="$c"`,
    `     ${envPrefix}${args.join(' ')} <<'${delim}' 2>"$_err_log" | node ${fmt}`,
    prompt,
    delim,
    `   }`,
    `   if [ -f "$_marker" ]; then`,
    `     printf '\\033[1;33m[Failover] Secondary project %s active (cached)\\033[0m\\n' ${p2}`,
    `     if ! _run_claude ${p2} ${c2}; then cat "$_err_log" >&2; exit 1; fi`,
    `   else`,
    `     if ! _run_claude ${p1} ${c1}; then`,
    `       if grep -Eq 'RESOURCE_EXHAUSTED|Quota exceeded|429|budget|billing' "$_err_log" 2>/dev/null; then`,
    `         printf '\\033[1;33m[Failover] Primary project %s exhausted. Failing over to %s...\\033[0m\\n' ${p1} ${p2}`,
    `         touch "$_marker"`,
    `         if ! _run_claude ${p2} ${c2}; then cat "$_err_log" >&2; exit 1; fi`,
    `       else`,
    `         cat "$_err_log" >&2; exit 1`,
    `       fi`,
    `     fi`,
    `   fi`,
    ` )`,
  ].join('\n');
}
