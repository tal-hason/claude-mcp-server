// claude-mcp-server/failover-scripts.js
// @ai-rules: [Pattern]: Shell script generation for failover cascades. [Constraint]: Pure logic, <= 100 lines.
export const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");
export const REDACT_SED = 'sed -E -u ' + [
  "s/-----BEGIN[^\\r\\n]*-----END[^\\r\\n]*/[REDACTED_PEM]/g; /-----BEGIN/,/-----END/{ /-----BEGIN/s/.*/[REDACTED_PEM]/; /-----END/d; /^[A-Za-z0-9+\\/=]{16,}/d; /[Bb]ase64/d; }",
  "s/((\\\\?['\"])?\\b(proxy-)?authorization(\\\\?['\"])?[ \\t]*:[ \\t]*(([a-zA-Z0-9_-]+)[ \\t]+)?|\\b(bearer|token)[ \\t]+)((\\\\?\"[^\"]*\\\\?\")|('[^']*')|[^[:space:]\"'&]+)/\\1[REDACTED]/gI",
  "s/(\\bresponse[[:space:]]*=[[:space:]]*)((\\\\?\"[^\"]*\\\\?\")|('([^']*)')|([^[:space:]\"',&]+))/\\1[REDACTED]/gI",
  "s/((\\\\?['\"])?\\b[a-zA-Z0-9_-]{0,128}(key|token|secret|password|credentials|private_key_id)(\\\\?['\"])?[[:space:]]*[=:][[:space:]]*)" +
    "((\\\\?\"[^\"]*\\\\?\")|('[^']*')|[^[:space:]\"'&]+)/\\1[REDACTED]/gI",
  "s/(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/\\1[REDACTED]/g",
  "s/(--api[_-]?key([[:space:]]+|=)|[?&](key|api[_-]?key|token)=)[^[:space:]\"'&]+/\\1[REDACTED]/gI; s/(https?:\\/\\/[^[:space:]\\/@:]+):[^[:space:]\\/@]+@/\\1:[REDACTED]@/g",
  "s/ey[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_.-]{10,}/[REDACTED_JWT]/g",
  "s/([\"']?[Cc]ookie[\"']?[[:space:]]*[:=][[:space:]]*)((\"([^\"]*)\")|('([^']*)')|([^[:space:]\\r\\n\"'}]+))/\\1[REDACTED]/gI; s/([Cc]ookie:[[:space:]]*)[^\\r\\n]+/\\1[REDACTED]/gI",
].map((e) => '-e ' + quote(e)).join(' ');
const qp = '(HTTP[[:space:]]+|status[[:space:]]*[:=][[:space:]]*|code[[:space:]]*[:=][[:space:]]*|API[[:space:]]+Error:[[:space:]]*|^|[[:space:]"({])', qs = '([[:space:]")},]|$)';
export const ERROR_PATTERNS = {
  quota: `${qp}429${qs}|RESOURCE_EXHAUSTED|[Qq]uota[[:space:]]+exceeded|Too Many Requests|Rate[[:space:]]*limit|` +
    'rate_limit_error|credit[[:space:]_-]*balance|insufficient[[:space:]_-]*quota|billing[[:space:]_-]*limit|budget[[:space:]_-]*exceeded',
  infra: `${qp}(500|502|503|504|529)${qs}|overloaded_error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|socket[[:space:]]+hang[[:space:]]+up|UNAVAILABLE`,
  user: '(HTTP[[:space:]]+|status[[:space:]]*[:=][[:space:]]*)(400|401|403)([^0-9]|$)|' +
    '(400|401|403)[[:space:]]+(Bad Request|Unauthorized|Forbidden)|API[[:space:]]+Error:[[:space:]]*(400|401|403)|invalid_request_error',
};
const UNSET_GW = 'unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ENMAAS_KEY ENMAAS_BASE_URL CLAUDE_CODE_ENVIRONMENT_KIND CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';
const prologue = (delim, prompt, sysPrompt) => `   _ou=$(umask); umask 077; _uid=$(id -u 2>/dev/null || echo 0); _cand="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}}/claude-cli-$_uid"
   mkdir -p -m 0700 "$_cand" 2>/dev/null || true; if [ -d "$_cand" ] && [ -O "$_cand" ] && [ ! -L "$_cand" ]; then chmod 0700 "$_cand" 2>/dev/null || true; _marker_dir="$_cand"
   else _marker_dir="$(mktemp -d "\${TMPDIR:-/tmp}/claude-$_uid-XXXXXX" 2>/dev/null || mktemp -d /tmp/claude-XXXXXX)"; fi
   find "$_marker_dir" -maxdepth 1 -type f \\( -name 'p.*' -o -name 'sp.*' -o -name 'err.*' -o -name 'out.*' \\) -mmin +180 -delete 2>/dev/null || true
   _err_log="$(mktemp "$_marker_dir/err.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/err.XXXXXX")"; _pfile="$(mktemp "$_marker_dir/p.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/p.XXXXXX")"
   _spfile="$(mktemp "$_marker_dir/sp.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/sp.XXXXXX")"; umask "$_ou"; _tp=; _last_o=
   _cleanup() { trap - INT TERM EXIT; [ "$_tp" -gt 1 ] 2>/dev/null && kill -TERM -$_tp "$_tp" 2>/dev/null || true
     rm -f "$_err_log" "$_pfile" "$_spfile" "$_last_o"; [ -n "$_marker_dir" ] && rm -f "$_marker_dir"/out.$$.*; exit "$1"; }
   trap '_cleanup 130' INT; trap '_cleanup 143' TERM; trap '_cleanup $?' EXIT
   cat <<'${delim}' > "$_pfile"\n${prompt}\n${delim}
   ${sysPrompt ? `cat <<'${delim}_SP__' > "$_spfile"\n${sysPrompt}\n${delim}_SP__` : ': > "$_spfile"'}
   _redact() { [ -n "$_last_o" ] && [ -f "$_last_o" ] && { { ${REDACT_SED} "$_last_o" 2>/dev/null || cat "$_last_o"; } 2>/dev/null || true; rm -f "$_last_o"; _last_o=; };
     { ${REDACT_SED} "$_err_log" 2>/dev/null || cat "$_err_log"; } >&2 || true; }
   _run_to() { local _o; _o="$(mktemp "$_marker_dir/out.$$.XXXXXX" 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/out.$$.XXXXXX")"; local _r=0
     local _tc="\$(declare -p _pfile _spfile 2>/dev/null); \$(declare -f "\$1" _run_claude 2>/dev/null); "\$1""
     [ -n "$_last_o" ] && rm -f "$_last_o"; _last_o=;
     if command -v timeout >/dev/null 2>&1; then timeout --kill-after=10s "\${CLAUDE_TIMEOUT:-1800}" bash -c "\$_tc" bash "$1" >"$_o" 2>"$_err_log" & _tp=$!; wait "$_tp" || _r=$?; _tp=;
     else echo "[claude-mcp] Warning: 'timeout' not found; executing without time limit" >&2; bash -c "\$_tc" bash "$1" >"$_o" 2>"$_err_log" & _tp=$!; wait "$_tp" || _r=$?; _tp=; fi
     if [ "$_r" -eq 0 ]; then cat "$_o"; rm -f "$_o"; else _last_o="$_o"; fi; return "$_r"; }`;
export function _buildDualSubshellScript({ markerName, preamble = '', runPrimary, runSecondary, delim, prompt, sysPrompt,
  regexPattern = `${ERROR_PATTERNS.quota}|${ERROR_PATTERNS.infra}`, userRegex = ERROR_PATTERNS.user }) {
  return [
    prologue(delim, prompt, sysPrompt),
    `   _marker="$_marker_dir/${markerName}"`,
    preamble,
    `   _run_primary() (\n     set -o pipefail\n     ${runPrimary}\n   )`,
    `   _run_secondary() (\n     set -o pipefail\n     ${runSecondary}\n   )`,
    `   if [ -f "$_marker" ] && [ -n "$(find "$_marker" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to secondary..." >&2; _code=0; _run_to _run_secondary || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then _redact; else rm -f "$_marker" 2>/dev/null || true; _redact; exit "$_code"; fi`,
    `   else _code=0; _run_to _run_primary || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then rm -f "$_marker" 2>/dev/null || true; _redact`,
    `     elif grep -Eiq '${userRegex}' "$_err_log"; then _redact; exit "$_code"`,
    `     elif [ "$_code" -eq 124 ] || [ "$_code" -eq 137 ] || grep -Eiq '${regexPattern}' "$_err_log"; then`,
    `       echo "[claude-mcp] Failover triggered: routing to secondary..." >&2; _code2=0; _run_to _run_secondary || _code2=$?`,
    `       if [ "$_code2" -eq 0 ]; then touch "$_marker" 2>/dev/null || true; _redact; else _redact; exit "$_code2"; fi`,
    `     else _redact; exit "$_code"; fi; fi`,
  ].filter(Boolean).join('\n');
}

export function _buildCascadeScript({ markerName, isCrossProvider = false, delim, prompt, sysPrompt, runPrimary, runSecondary,
  runTertiary, tier1Project, tier1Credentials, tier2Project, tier2Credentials, tier3Project, tier3Credentials,
  quotaRegex = ERROR_PATTERNS.quota, infraRegex = ERROR_PATTERNS.infra, userRegex = ERROR_PATTERNS.user }) {
  const p2 = quote(tier2Project || ''), p3 = quote(tier3Project || ''), v = `grep -Eiq '${userRegex}' "$_err_log"`;
  const creds = (c) => c ? `export GOOGLE_APPLICATION_CREDENTIALS=${quote(c)}\n     ` : 'unset GOOGLE_APPLICATION_CREDENTIALS\n     ';
  const tierDef = (p, c, run) => `export CLOUDSDK_CORE_PROJECT=${p}; export ANTHROPIC_VERTEX_PROJECT_ID=${p}\n     ${creds(c)}export CLAUDE_CODE_USE_VERTEX=1; ${UNSET_GW}\n     ${run}`;
  const t1Exp = !isCrossProvider && tier1Project ? tierDef(quote(tier1Project), tier1Credentials, '') : '';
  return [
    prologue(delim, prompt, sysPrompt),
    `   _marker_t2="$_marker_dir/${markerName}_t2"; _marker_t3="$_marker_dir/${markerName}_t3"`,
    `   _run_tier1() (\n     set -o pipefail\n     ${t1Exp}${runPrimary}\n   )`,
    `   _run_tier2() (\n     set -o pipefail\n     ${tierDef(p2, tier2Credentials, runSecondary)}\n   )`,
    `   _run_tier3() (\n     set -o pipefail\n     ${tierDef(p3, tier3Credentials, runTertiary)}\n   )`,
    `   if [ -f "$_marker_t3" ] && [ -n "$(find "$_marker_t3" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 3..." >&2; _code=0; _run_to _run_tier3 || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then _redact; else rm -f "$_marker_t3" 2>/dev/null || true; _redact; exit "$_code"; fi`,
    `   elif [ -f "$_marker_t2" ] && [ -n "$(find "$_marker_t2" -mmin -30 2>/dev/null)" ]; then`,
    `     echo "[claude-mcp] Failover active: routing to Tier 2..." >&2; _code=0; _run_to _run_tier2 || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then _redact; else rm -f "$_marker_t2" 2>/dev/null || true; if ${v}; then _redact; exit "$_code"; fi`,
    `       echo "[claude-mcp] Tier 2 active failover failed. Escalating to Tier 3..." >&2; _code3=0; _run_to _run_tier3 || _code3=$?`,
    `       if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; _redact; else _redact; exit "$_code3"; fi; fi`,
    `   else _code=0; _run_to _run_tier1 || _code=$?`,
    `     if [ "$_code" -eq 0 ]; then rm -f "$_marker_t2" "$_marker_t3" 2>/dev/null || true; _redact`,
    `     elif ${v}; then _redact; exit "$_code"`,
    `     elif [ "${isCrossProvider}" = "true" ] && grep -Eiq '${quotaRegex}' "$_err_log"; then`,
    `       echo "[claude-mcp] Shared quota exhausted on Tier 1. Bypassing Tier 2 -> Routing directly to Tier 3..." >&2; _code3=0; _run_to _run_tier3 || _code3=$?`,
    `       if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; rm -f "$_marker_t2" 2>/dev/null || true; _redact; else if ${v}; then _redact; exit "$_code3"; fi`,
    `         echo "[claude-mcp] Tier 3 failed. Falling back to Tier 2..." >&2; _code2=0; _run_to _run_tier2 || _code2=$?`,
    `         if [ "$_code2" -eq 0 ]; then touch "$_marker_t2" 2>/dev/null || true; _redact; else _redact; exit "$_code2"; fi; fi`,
    `     elif [ "$_code" -eq 124 ] || [ "$_code" -eq 137 ] || grep -Eiq '${quotaRegex}|${infraRegex}' "$_err_log"; then`,
    `       echo "[claude-mcp] Failure on Tier 1. Routing to Tier 2..." >&2; _code2=0; _run_to _run_tier2 || _code2=$?`,
    `       if [ "$_code2" -eq 0 ]; then touch "$_marker_t2" 2>/dev/null || true; rm -f "$_marker_t3" 2>/dev/null || true; _redact; else if ${v}; then _redact; exit "$_code2"; fi`,
    `         echo "[claude-mcp] Tier 2 failed. Routing to Tier 3..." >&2; _code3=0; _run_to _run_tier3 || _code3=$?`,
    `         if [ "$_code3" -eq 0 ]; then touch "$_marker_t3" 2>/dev/null || true; rm -f "$_marker_t2" 2>/dev/null || true; _redact; else _redact; exit "$_code3"; fi; fi`,
    `     else _redact; exit "$_code"; fi; fi`,
  ].filter(Boolean).join('\n');
}
