// claude-mcp-server/failover-scripts.js
// @ai-rules: [Pattern]: Shell script generation for failover cascades. [Constraint]: Pure logic, <= 100 lines.

export const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");

const REDACT_SED = `sed -E -e 's/([bB][eE][aA][rR][eE][rR][[:space:]]+)[^[:space:]"'"'"'&]+/\\1[REDACTED]/g' ` +
  `-e 's/(sk-ant-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/\\1[REDACTED]/g' -e 's/(ya29\\.[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/\\1[REDACTED]/g' ` +
  `-e 's/(([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?)[^[:space:]"'"'"'&]+/\\1[REDACTED]/g'`;

export function _buildDualSubshellScript({
  markerName, preamble = '', runPrimary, runSecondary,
  regexPattern = '(^|[^a-zA-Z0-9_])(429|502|503|504)([^a-zA-Z0-9_]|$)|Too Many Requests|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|timed?[[:space:]]*out',
  userRegexPattern = '(^|[^0-9])(400|401|403)([^0-9]|$)|Bad Request|Unauthorized|Forbidden',
}) {
  return [
    ` ( _uid=$(id -u 2>/dev/null || echo 0); _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-$_uid}"`,
    `   mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"; _marker="$_marker_dir/${markerName}"`,
    `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"; trap 'rm -f "$_err_log"; exit 130' INT TERM; trap 'rm -f "$_err_log"' EXIT`,
    `   _redact() { ${REDACT_SED} "$_err_log" >&2; }`,
    preamble,
    `   _run_primary() (\n     ${runPrimary}\n   )`,
    `   _run_secondary() (\n     ${runSecondary}\n   )`,
    `   if [ -f "$_marker" ] && [ -n "$(find "$_marker" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to secondary..." >&2`,
    `     _code=0; _run_secondary 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi; _redact; exit "$_code"`,
    `   fi`,
    `   _code=0; _run_primary 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then rm -f "$_marker" 2>/dev/null || true; _redact; exit 0; fi`,
    `   if grep -Eiq '${regexPattern}' "$_err_log" && ! grep -Eiq '${userRegexPattern}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failover triggered: routing to secondary..." >&2`,
    `     _code2=0; _run_secondary 2>"$_err_log" || _code2=$?`,
    `     if [ "$_code2" -eq 0 ]; then touch "$_marker" 2>/dev/null || true; _redact; exit 0; fi; _redact; exit "$_code2"`,
    `   fi`,
    `   _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}

export function _buildCascadeScript({
  markerName, runPrimary, runSecondary, runTertiary, isCrossProvider = true,
  tier1Project, tier1Credentials, tier2Project, tier2Credentials, tier3Project, tier3Credentials,
  quotaRegex = '(^|[^0-9])429([^0-9]|$)|RESOURCE_EXHAUSTED|Quota exceeded|429.*quota|billing|budget',
  infraRegex = '(^|[^0-9])(502|503|504|529)([^0-9]|$)|502|503|504|ECONNREFUSED|ETIMEDOUT|timed?[[:space:]]*out',
  userRegex = '(^|[^0-9])(400|401|403)([^0-9]|$)|Bad Request|Unauthorized|Forbidden',
}) {
  const p1 = quote(tier1Project || ''), c1 = tier1Credentials ? quote(tier1Credentials) : null;
  const p2 = quote(tier2Project || ''), c2 = tier2Credentials ? quote(tier2Credentials) : null;
  const p3 = quote(tier3Project || ''), c3 = tier3Credentials ? quote(tier3Credentials) : null;
  const t1Exports = (!isCrossProvider && tier1Project)
    ? `export CLOUDSDK_CORE_PROJECT=${p1}; export ANTHROPIC_VERTEX_PROJECT_ID=${p1}\n     ${c1 ? `export GOOGLE_APPLICATION_CREDENTIALS=${c1}\n     ` : ''}` : '';
  const unsetGw = 'unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';

  return [
    ` ( _uid=$(id -u 2>/dev/null || echo 0); _marker_dir="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}/claude-cli-$_uid}"`,
    `   mkdir -p -m 0700 "$_marker_dir" 2>/dev/null || mkdir -p "$_marker_dir"`,
    `   _marker_t2="$_marker_dir/${markerName}_t2"; _marker_t3="$_marker_dir/${markerName}_t3"`,
    `   _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"; trap 'rm -f "$_err_log"; exit 130' INT TERM; trap 'rm -f "$_err_log"' EXIT`,
    `   _redact() { ${REDACT_SED} "$_err_log" >&2; }`,
    `   _run_tier1() (\n     ${t1Exports}${runPrimary}\n   )`,
    `   _run_tier2() (\n     export CLOUDSDK_CORE_PROJECT=${p2}; export ANTHROPIC_VERTEX_PROJECT_ID=${p2}`,
    `     ${c2 ? `export GOOGLE_APPLICATION_CREDENTIALS=${c2}` : 'unset GOOGLE_APPLICATION_CREDENTIALS'}; export CLAUDE_CODE_USE_VERTEX=1`,
    `     ${unsetGw}`,
    `     ${runSecondary}\n   )`,
    `   _run_tier3() (\n     export CLOUDSDK_CORE_PROJECT=${p3}; export ANTHROPIC_VERTEX_PROJECT_ID=${p3}`,
    `     ${c3 ? `export GOOGLE_APPLICATION_CREDENTIALS=${c3}` : 'unset GOOGLE_APPLICATION_CREDENTIALS'}; export CLAUDE_CODE_USE_VERTEX=1`,
    `     ${unsetGw}`,
    `     ${runTertiary}\n   )`,
    `   if [ -f "$_marker_t3" ] && [ -n "$(find "$_marker_t3" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 3..." >&2`,
    `     _code=0; _run_tier3 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi`,
    `   elif [ -f "$_marker_t2" ] && [ -n "$(find "$_marker_t2" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 2..." >&2`,
    `     _code=0; _run_tier2 2>"$_err_log" || _code=$?; if [ "$_code" -eq 0 ]; then _redact; exit 0; fi`,
    `     echo "[claude-mcp] Tier 2 active failover failed. Escalating to Tier 3..." >&2`,
    `     _code=0; _run_tier3 2>"$_err_log" || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi; _redact; exit "$_code"`,
    `   fi`,
    `   _code=0; _run_tier1 2>"$_err_log" || _code=$?`,
    `   if [ "$_code" -eq 0 ]; then rm -f "$_marker_t2" "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi`,
    `   if grep -Eiq '${userRegex}' "$_err_log"; then _redact; exit "$_code"; fi`,
    `   if [ "${isCrossProvider}" = "true" ] && grep -Eiq '${quotaRegex}' "$_err_log"; then`,
    `     echo "[claude-mcp] Shared quota exhausted on Tier 1. Bypassing Tier 2 -> Routing directly to Tier 3..." >&2`,
    `     _code3=0; _run_tier3 2>"$_err_log" || _code3=$?`,
    `     if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi; _redact; exit "$_code3"`,
    `   fi`,
    `   if grep -Eiq '${quotaRegex}|${infraRegex}' "$_err_log"; then`,
    `     echo "[claude-mcp] Failure on Tier 1. Routing to Tier 2..." >&2`,
    `     _code2=0; _run_tier2 2>"$_err_log" || _code2=$?`,
    `     if [ "$_code2" -eq 0 ]; then touch "$_marker_t2" 2>/dev/null || true; _redact; exit 0; fi`,
    `     if ! grep -Eiq '${userRegex}' "$_err_log"; then`,
    `       echo "[claude-mcp] Tier 2 failed. Routing to Tier 3..." >&2`,
    `       _code3=0; _run_tier3 2>"$_err_log" || _code3=$?`,
    `       if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; _redact; exit 0; fi`,
    `     fi; _code=$_code2`,
    `   fi; _redact; exit "$_code" )`,
  ].filter(Boolean).join('\n');
}
