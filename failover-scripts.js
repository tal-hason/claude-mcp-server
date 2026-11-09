// claude-mcp-server/failover-scripts.js
// @ai-rules: [Pattern]: Shell script generation for failover cascades. [Constraint]: Pure logic, <= 100 lines.

export const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");

export const REDACT_SED = `sed -E ` +
  `-e 's/([bB][eE][aA][rR][eE][rR]|[bB][aA][sS][iI][cC])[[:space:]]+[^[:space:]"'"'"'&]+/\\1 [REDACTED]/g' ` +
  `-e 's/(sk-ant-[a-zA-Z0-9_-]{4}|ya29\\.[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/\\1[REDACTED]/g' ` +
  `-e 's/("?[a-zA-Z0-9_-]*(api[_-]?key|apiKey|private[_-]?key|access[_-]?token|id[_-]?token|password|secret)"?[[:space:]]*[=:][[:space:]]*"?)[^[:space:]"'"'"'&]+/\\1[REDACTED]/g' ` +
  `-e 's/([Cc][Oo][Oo][Kk][Ii][Ee]:[[:space:]]*)[^"'"'"'\\r\\n]+/\\1[REDACTED]/g'`;

export const ERROR_PATTERNS = {
  quota: '(^|[^0-9])429([^0-9]|$)|RESOURCE_EXHAUSTED|[Qq]uota[[:space:]]+exceeded|Too Many Requests',
  infra: '(^|[^0-9])(502|503|504|529)([^0-9]|$)|overloaded_error|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|timed?[[:space:]]*out',
  user: '(HTTP[[:space:]]+|status[[:space:]]*[:=][[:space:]]*)(400|401|403)([^0-9]|$)|' +
    '(^|[^0-9])(400|401|403)[[:space:]]+(Bad Request|Unauthorized|Forbidden)|' +
    'API[[:space:]]+Error:[[:space:]]*(400|401|403)|invalid_request_error',
};

const UNSET_GW = 'unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ENMAAS_KEY ENMAAS_BASE_URL CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';

const prologue = (delim, prompt) => [
  `   _uid=$(id -u 2>/dev/null || echo 0); _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-$_uid}"`,
  `   mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir" 2>/dev/null || _marker_dir="\${TMPDIR:-/tmp}"`,
  `   [ -O "$_marker_dir" ] && [ ! -L "$_marker_dir" ] 2>/dev/null || chmod 0700 "$_marker_dir" 2>/dev/null || true`,
  `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/err.XXXXXX")"`,
  `   _pfile="$(mktemp "$_marker_dir/p.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/p.XXXXXX")"`,
  `   trap 'rm -f "$_err_log" "$_pfile"; exit 130' INT; trap 'rm -f "$_err_log" "$_pfile"; exit 143' TERM; trap 'rm -f "$_err_log" "$_pfile"' EXIT`,
  `   cat <<'${delim}' > "$_pfile"\n${prompt}\n${delim}`,
  `   _redact() { ${REDACT_SED} "$_err_log" >&2; }`,
];

export function _buildDualSubshellScript({
  markerName, preamble = '', runPrimary, runSecondary, delim, prompt,
  regexPattern = `${ERROR_PATTERNS.quota}|${ERROR_PATTERNS.infra}`, userRegex = ERROR_PATTERNS.user,
}) {
  return [
    ` ( ${prologue(delim, prompt).join('\n')}`,
    `   _marker="$_marker_dir/${markerName}"`,
    preamble,
    `   _run_primary() (\n     ${runPrimary}\n   )`,
    `   _run_secondary() (\n     ${runSecondary}\n   )`,
    `   if [ -f "$_marker" ] && [ -n "$(find "$_marker" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to secondary..." >&2`,
    `     _code=0; _run_secondary 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi`,
    `     rm -f "$_marker" 2>/dev/null || true; fi`,
    `   _code=0; _run_primary 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then rm -f "$_marker" 2>/dev/null || true; _redact; exit 0; fi`,
    `   if grep -Eiq '${userRegex}' "$_err_log"; then _redact; exit "$_code"; fi`,
    `   if grep -Eiq '${regexPattern}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failover triggered: routing to secondary..." >&2`,
    `     _code2=0; _run_secondary 2>"$_err_log" || _code2=$?`,
    `     if [ "$_code2" -eq 0 ]; then touch "$_marker" 2>/dev/null || true; _redact; exit 0; fi; _code=$_code2`,
    `   fi; _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}

export function _buildCascadeScript({
  markerName, runPrimary, runSecondary, runTertiary, isCrossProvider = true, delim, prompt,
  tier1Project, tier1Credentials, tier2Project, tier2Credentials, tier3Project, tier3Credentials,
  quotaRegex = ERROR_PATTERNS.quota, infraRegex = ERROR_PATTERNS.infra, userRegex = ERROR_PATTERNS.user,
}) {
  const [p1, p2, p3] = [tier1Project, tier2Project, tier3Project].map((p) => quote(p || ''));
  const [c1, c2, c3] = [tier1Credentials, tier2Credentials, tier3Credentials].map((c) => (c ? quote(c) : null));
  const t1Exports = (!isCrossProvider && tier1Project)
    ? `export CLOUDSDK_CORE_PROJECT=${p1}; export ANTHROPIC_VERTEX_PROJECT_ID=${p1}\n     ${c1 ? `export GOOGLE_APPLICATION_CREDENTIALS=${c1}\n     ` : ''}` : '';
  const creds = (c) => (c ? `export GOOGLE_APPLICATION_CREDENTIALS=${c}; ` : (c1 ? `export GOOGLE_APPLICATION_CREDENTIALS=${c1}; ` : ''));
  const tierDef = (p, c, run) => `export CLOUDSDK_CORE_PROJECT=${p}; export ANTHROPIC_VERTEX_PROJECT_ID=${p}\n     ` +
    `${creds(c)}export CLAUDE_CODE_USE_VERTEX=1; ${UNSET_GW}\n     ${run}`;

  return [
    ` ( ${prologue(delim, prompt).join('\n')}`,
    `   _marker_t2="$_marker_dir/${markerName}_t2"; _marker_t3="$_marker_dir/${markerName}_t3"`,
    `   _run_tier1() (\n     ${t1Exports}${runPrimary}\n   )`,
    `   _run_tier2() (\n     ${tierDef(p2, c2, runSecondary)}\n   )`,
    `   _run_tier3() (\n     ${tierDef(p3, c3, runTertiary)}\n   )`,
    `   if [ -f "$_marker_t3" ] && [ -n "$(find "$_marker_t3" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 3..." >&2`,
    `     _code=0; _run_tier3 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi; rm -f "$_marker_t3" 2>/dev/null || true`,
    `   elif [ -f "$_marker_t2" ] && [ -n "$(find "$_marker_t2" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 2..." >&2`,
    `     _code=0; _run_tier2 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi; rm -f "$_marker_t2" 2>/dev/null || true`,
    `     echo "[claude-mcp] Tier 2 active failover failed. Escalating to Tier 3..." >&2; _code3=0; _run_tier3 2>"$_err_log" || _code3=$?`,
    `     if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi`,
    `   fi`,
    `   _code=0; _run_tier1 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then rm -f "$_marker_t2" "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi`,
    `   if grep -Eiq '${userRegex}' "$_err_log"; then _redact; exit "$_code"; fi`,
    `   if [ "${isCrossProvider}" = "true" ] && grep -Eiq '${quotaRegex}' "$_err_log"; then`,
    `     echo "[claude-mcp] Shared quota exhausted on Tier 1. Bypassing Tier 2 -> Routing directly to Tier 3..." >&2`,
    `     _code3=0; _run_tier3 2>"$_err_log" || _code3=$?`,
    `     if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; rm -f "$_marker_t2" 2>/dev/null || true; _redact; exit 0; fi; _code=$_code3`,
    `   elif grep -Eiq '${quotaRegex}|${infraRegex}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failure on Tier 1. Routing to Tier 2..." >&2`,
    `     _code2=0; _run_tier2 2>"$_err_log" || _code2=$?`,
    `     if [ "$_code2" -eq 0 ]; then touch "$_marker_t2" 2>/dev/null || true; rm -f "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi; _code=$_code2`,
    `     echo "[claude-mcp] Tier 2 failed. Routing to Tier 3..." >&2; _code3=0; _run_tier3 2>"$_err_log" || _code3=$?`,
    `     if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; rm -f "$_marker_t2" 2>/dev/null || true; _redact; exit 0; fi; _code=$_code3`,
    `   fi; _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}
