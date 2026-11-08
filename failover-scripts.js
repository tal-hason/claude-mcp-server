// claude-mcp-server/failover-scripts.js
// @ai-rules: [Pattern]: Shell script generation for 2-tier dual subshell and 3-tier cascade failover with credential isolation and secret redaction.

export const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");

export function _buildDualSubshellScript({
  markerName, preamble = '', runPrimary, runSecondary,
  regexPattern = '(^|[^a-zA-Z0-9_])(429|502|503|504)([^a-zA-Z0-9_]|$)|Too Many Requests|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|timed?[[:space:]]*out',
  userRegexPattern = '(^|[^0-9])(400|401|403)([^0-9]|$)|Bad Request|Unauthorized|Forbidden',
}) {
  return [
    ` ( _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-\${UID:-0}}"; mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"; _marker="$_marker_dir/${markerName}"`,
    `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"; trap 'rm -f "$_err_log"; exit 130' INT TERM; trap 'rm -f "$_err_log"' EXIT`,
    `   _redact() { sed -E 's/([bB][eE][aA][rR][eE][rR][[:space:]]+|([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?|[tT][oO][kK][eE][nN][=:][[:space:]]*"?)[^[:space:]"'\\''&]+/\\1[REDACTED]/g' "$_err_log" >&2; }`,
    preamble,
    `   _run_primary() (\n     ${runPrimary}\n   )`,
    `   _run_secondary() (\n     ${runSecondary}\n   )`,
    `   if [ -f "$_marker" ] && [ -n "$(find "$_marker" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to secondary..." >&2; _code=0; _run_secondary 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code"`,
    `   fi`,
    `   _code=0; _run_primary 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi`,
    `   if grep -Eiq '${regexPattern}' "$_err_log" && ! grep -Eiq '${userRegexPattern}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failover triggered: routing to secondary..." >&2; touch "$_marker" 2>/dev/null || true; _code2=0; _run_secondary 2>"$_err_log" || _code2=$?; if [ "$_code2" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code2"`,
    `   fi`,
    `   _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}

export function _buildCascadeScript({
  markerName, runPrimary, runSecondary, runTertiary, tier2Project, tier2Credentials, tier3Project, tier3Credentials,
}) {
  const p2 = quote(tier2Project || ''), c2 = tier2Credentials ? quote(tier2Credentials) : null;
  const p3 = quote(tier3Project || ''), c3 = tier3Credentials ? quote(tier3Credentials) : null;

  return [
    ` ( _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-\${UID:-0}}"`,
    `   mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"`,
    `   _marker_t2="$_marker_dir/${markerName}_t2"; _marker_t3="$_marker_dir/${markerName}_t3"`,
    `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"; trap 'rm -f "$_err_log"; exit 130' INT TERM; trap 'rm -f "$_err_log"' EXIT`,
    `   _redact() { sed -E 's/([bB][eE][aA][rR][eE][rR][[:space:]]+|([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?|[tT][oO][kK][eE][nN][=:][[:space:]]*"?)[^[:space:]"'\\''&]+/\\1[REDACTED]/g' "$_err_log" >&2; }`,
    `   _run_tier1() (\n     ${runPrimary}\n   )`,
    `   _run_tier2() (`,
    `     export CLOUDSDK_CORE_PROJECT=${p2}`,
    `     export ANTHROPIC_VERTEX_PROJECT_ID=${p2}`,
    c2 ? `     export GOOGLE_APPLICATION_CREDENTIALS=${c2}` : ``,
    `     unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`,
    `     export CLAUDE_CODE_USE_VERTEX=1`,
    `     ${runSecondary}`,
    `   )`,
    `   _run_tier3() (`,
    `     export CLOUDSDK_CORE_PROJECT=${p3}`,
    `     export ANTHROPIC_VERTEX_PROJECT_ID=${p3}`,
    c3 ? `     export GOOGLE_APPLICATION_CREDENTIALS=${c3}` : ``,
    `     unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`,
    `     export CLAUDE_CODE_USE_VERTEX=1`,
    `     ${runTertiary}`,
    `   )`,
    `   if [ -f "$_marker_t3" ] && [ -n "$(find "$_marker_t3" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 3 (isolated quota)..." >&2; _code=0; _run_tier3 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code"`,
    `   fi`,
    `   if [ -f "$_marker_t2" ] && [ -n "$(find "$_marker_t2" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 2 (Vertex)..." >&2; _code=0; _run_tier2 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code"`,
    `   fi`,
    `   _code=0; _run_tier1 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi`,
    `   if grep -Eiq 'RESOURCE_EXHAUSTED|Quota exceeded|429.*quota|billing|budget' "$_err_log"; then`,
    `     echo "[claude-mcp] Shared quota exhausted on Tier 1. Bypassing Tier 2 -> Routing directly to Tier 3..." >&2; touch "$_marker_t3" 2>/dev/null || true; _code3=0; _run_tier3 2>"$_err_log" || _code3=$?; if [ "$_code3" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code3"`,
    `   fi`,
    `   if grep -Eiq '502|503|504|ECONNREFUSED|ETIMEDOUT|timed?[[:space:]]*out' "$_err_log"; then`,
    `     echo "[claude-mcp] Gateway infra failure on Tier 1. Routing to Tier 2..." >&2; touch "$_marker_t2" 2>/dev/null || true; _code2=0; _run_tier2 2>"$_err_log" || _code2=$?`,
    `     if [ "$_code2" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi`,
    `     if grep -Eiq 'RESOURCE_EXHAUSTED|Quota exceeded|429.*quota|billing|budget|502|503|504|ECONNREFUSED|ETIMEDOUT|timed?[[:space:]]*out' "$_err_log"; then`,
    `       echo "[claude-mcp] Tier 2 failure. Routing to Tier 3..." >&2; touch "$_marker_t3" 2>/dev/null || true; _code3=0; _run_tier3 2>"$_err_log" || _code3=$?; if [ "$_code3" -eq 0 ]; then cat "$_err_log" >&2; exit 0; fi; _redact; exit "$_code3"`,
    `     fi`,
    `     _code=$_code2`,
    `   fi`,
    `   _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}
