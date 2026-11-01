// claude-mcp-server/failover.js
// @ai-rules: [Pattern]: Failover controller for intra-Vertex and cross-provider (EnMaaS -> Vertex).

const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");

export function resolveFailoverConfig(provider = 'vertex', params = {}, env = process.env) {
  if (typeof provider === 'object' && provider !== null) {
    env = (params && Object.keys(params).length > 0) ? params : (env || process.env); params = provider; provider = params.provider || 'vertex';
  }
  const e = params.env || env || {};
  const isEnmaas = provider === 'enmaas' || (provider === 'auto' && (params.model?.startsWith('rits/') || params.model?.includes('enmaas')));
  if (isEnmaas) {
    const secProj = params.secondaryProject || params.primaryProject || e.VERTEX_SECONDARY_PROJECT || e.VERTEX_PRIMARY_PROJECT || null;
    const secCreds = params.secondaryCredentials || params.credentials || params.primaryCredentials || e.VERTEX_SECONDARY_CREDENTIALS || e.VERTEX_CREDENTIALS || e.GOOGLE_APPLICATION_CREDENTIALS || null;
    return secProj ? {
      enabled: true, type: 'cross-provider', primaryProvider: 'enmaas', secondaryProvider: 'vertex',
      secondaryProject: secProj, secondaryCredentials: secCreds,
    } : { enabled: false };
  }
  const p1 = params.primaryProject || e.VERTEX_PRIMARY_PROJECT || e.ANTHROPIC_VERTEX_PROJECT_ID || null;
  const p2 = params.secondaryProject || e.VERTEX_SECONDARY_PROJECT || null;
  return {
    enabled: Boolean(p2 && p1 && p2 !== p1), type: 'vertex', primaryProject: p1, secondaryProject: p2,
    primaryCredentials: params.primaryCredentials || e.VERTEX_PRIMARY_CREDENTIALS || e.GOOGLE_APPLICATION_CREDENTIALS || null,
    secondaryCredentials: params.secondaryCredentials || e.VERTEX_SECONDARY_CREDENTIALS || null,
  };
}

export const resolveVertexFailoverConfig = (p, e) => resolveFailoverConfig('vertex', p, e);

export function resolveSecondaryModel(primaryModel, secondaryModel) {
  if (secondaryModel) return secondaryModel;
  return (!primaryModel || primaryModel.includes('/') || primaryModel.startsWith('rits/')) ? undefined : primaryModel;
}

export function _buildDualSubshellScript({
  markerName, preamble = '', runPrimary, runSecondary,
  regexPattern = '(^|[^a-zA-Z0-9_])(429|502|503|504)([^a-zA-Z0-9_]|$)|Too Many Requests|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|timed?[[:space:]]*out',
  userRegexPattern = '(^|[^0-9])(400|401|403)([^0-9]|$)|Bad Request|Unauthorized|Forbidden',
}) {
  return [
    ` ( _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-\${UID:-0}}"; mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"; _marker="$_marker_dir/${markerName}"`,
    preamble,
    `   _run_primary() (\n     ${runPrimary}\n   )`,
    `   _run_secondary() (\n     ${runSecondary}\n   )`,
    `   if [ -f "$_marker" ] && [ -n "$(find "$_marker" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to secondary..." >&2; _run_secondary; exit $?`,
    `   fi`,
    `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"; trap 'rm -f "$_err_log"; exit 130' INT TERM; trap 'rm -f "$_err_log"' EXIT`,
    `   _code=0; _run_primary 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi`,
    `   if grep -Eiq '${regexPattern}' "$_err_log" && ! grep -Eiq '${userRegexPattern}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failover triggered: routing to secondary..." >&2; touch "$_marker"; _run_secondary; exit $?`,
    `   fi`,
    `   sed -E 's/([bB][eE][aA][rR][eE][rR][[:space:]]+|([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?|[tT][oO][kK][eE][nN][=:][[:space:]]*"?)[^[:space:]"'\\''&]+/\\1[REDACTED]/g' "$_err_log" >&2; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}

export function buildVertexFailoverScript({
  envPrefix = '', args, delim, prompt, fmt, primaryProject, secondaryProject, primaryCredentials, secondaryCredentials,
}) {
  const p1 = quote(primaryProject || ''), p2 = quote(secondaryProject || ''), c1 = primaryCredentials ? quote(primaryCredentials) : "''", c2 = secondaryCredentials ? quote(secondaryCredentials) : "''";
  const markerName = `failover_${(primaryProject || 'p1').replace(/[^a-zA-Z0-9_-]/g, '_')}_${(secondaryProject || 'p2').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const preamble = `   _run_claude() { local p="$1"; local c="$2"; [ -n "$p" ] && export ANTHROPIC_VERTEX_PROJECT_ID="$p"; [ -n "$c" ] && export GOOGLE_APPLICATION_CREDENTIALS="$c"; ${envPrefix}${args.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}\n   }`;
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
  const secExports = `unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY\n     export CLAUDE_CODE_USE_VERTEX=1 ANTHROPIC_VERTEX_PROJECT_ID=${p2} CLOUDSDK_CORE_PROJECT=${p2}${c2 ? ` GOOGLE_APPLICATION_CREDENTIALS=${c2}` : ''}`;
  const runSecondary = `${secExports}\n     ${secondaryArgs.join(' ')} <<'${delim}' | node ${fmt}\n${prompt}\n${delim}`;
  return _buildDualSubshellScript({ markerName, runPrimary, runSecondary });
}

export function buildFailoverScript(opts, pArgs) {
  const o = opts.failoverConfig ? { ...opts, ...opts.failoverConfig } : opts;
  return o.type === 'cross-provider' ? buildCrossProviderFailoverScript(o) : buildVertexFailoverScript({ ...o, args: o.primaryArgs || pArgs || o.args });
}
