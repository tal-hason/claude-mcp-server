// claude-mcp-server/test/failover-cascade.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for 3-tier failover cascade with shared-quota bypass. [Constraint]: Pure logic, node:test + node:assert only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { resolveFailoverConfig } from '../failover.js';
import { buildCommand } from '../command-builder.js';
import { resolveGcpProjects } from '../providers.js';

describe('ATDD Layer 1: Failover Configuration Resolution (resolveFailoverConfig)', () => {
  it('resolves tertiaryProject and tertiaryCredentials from explicit params', () => {
    const config = resolveFailoverConfig('enmaas', {
      secondaryProject: 'proj-tier2-shared',
      secondaryCredentials: '/path/to/tier2.json',
      tertiaryProject: 'proj-tier3-isolated',
      tertiaryCredentials: '/path/to/tier3.json',
    });

    assert.equal(config.enabled, true);
    assert.equal(config.secondaryProject, 'proj-tier2-shared');
    assert.equal(config.secondaryCredentials, '/path/to/tier2.json');
    assert.equal(config.tertiaryProject, 'proj-tier3-isolated', 'Must resolve tertiaryProject from params');
    assert.equal(config.tertiaryCredentials, '/path/to/tier3.json', 'Must resolve tertiaryCredentials from params');
    assert.equal(config.hasTertiary, true, 'Must flag hasTertiary when tertiary project present');
  });

  it('resolves tertiaryProject and tertiaryCredentials from environment variables', () => {
    const env = {
      ENMAAS_KEY: 'test-key',
      VERTEX_SECONDARY_PROJECT: 'env-tier2-shared',
      VERTEX_SECONDARY_CREDENTIALS: '/env/tier2.json',
      VERTEX_TERTIARY_PROJECT: 'env-tier3-isolated',
      VERTEX_TERTIARY_CREDENTIALS: '/env/tier3.json',
    };

    const config = resolveFailoverConfig('enmaas', {}, env);
    assert.equal(config.enabled, true);
    assert.equal(config.secondaryProject, 'env-tier2-shared');
    assert.equal(config.tertiaryProject, 'env-tier3-isolated', 'Must resolve tertiaryProject from env');
    assert.equal(config.tertiaryCredentials, '/env/tier3.json', 'Must resolve tertiaryCredentials from env');
  });

  it('falls back to VERTEX_FALLBACK_PROJECT and VERTEX_FALLBACK_CREDENTIALS for tertiary tier', () => {
    const env = {
      ENMAAS_KEY: 'test-key',
      VERTEX_SECONDARY_PROJECT: 'env-tier2-shared',
      VERTEX_FALLBACK_PROJECT: 'env-tier3-fallback',
      VERTEX_FALLBACK_CREDENTIALS: '/env/fallback.json',
    };

    const config = resolveFailoverConfig('enmaas', {}, env);
    assert.equal(config.tertiaryProject, 'env-tier3-fallback', 'Must resolve tertiaryProject from fallback env');
    assert.equal(config.tertiaryCredentials, '/env/fallback.json', 'Must resolve tertiaryCredentials from fallback env');
  });
});

describe('ATDD Layer 1 & 2: 3-Tier Cascade Script Generation & Isolation (command-builder.js)', () => {
  const baseParams = {
    prompt: 'implement feature',
    mode: 'executor',
    provider: 'enmaas',
    secondaryProject: 'itpc-ca-3583f32e92',
    secondaryCredentials: '/creds/tier2.json',
    tertiaryProject: 'cnv-ai-insights',
    tertiaryCredentials: '/creds/tier3.json',
  };

  it('generates 3-tier cascade script with isolated tier runners and sticky markers', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_run_tier1()'), 'Command must define _run_tier1');
    assert.ok(cmd.includes('_run_tier2()'), 'Command must define _run_tier2');
    assert.ok(cmd.includes('_run_tier3()'), 'Command must define _run_tier3');
    assert.ok(cmd.includes('_marker_t2='), 'Command must define Tier 2 sticky marker');
    assert.ok(cmd.includes('_marker_t3='), 'Command must define Tier 3 sticky marker');
  });

  it('enforces subshell project and credential isolation for Tier 2 and Tier 3', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="itpc-ca-3583f32e92"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='itpc-ca-3583f32e92'"),
      'Tier 2 subshell must export CLOUDSDK_CORE_PROJECT for Tier 2',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="itpc-ca-3583f32e92"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='itpc-ca-3583f32e92'"),
      'Tier 2 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 2',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier2.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier2.json'"),
      'Tier 2 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 2',
    );

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="cnv-ai-insights"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='cnv-ai-insights'"),
      'Tier 3 subshell must export CLOUDSDK_CORE_PROJECT for Tier 3',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="cnv-ai-insights"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='cnv-ai-insights'"),
      'Tier 3 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 3',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier3.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier3.json'"),
      'Tier 3 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 3',
    );
  });

  it('preserves backward compatibility when tertiary project is omitted (2-tier)', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'itpc-ca-3583f32e92',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_run_primary()') || cmd.includes('_run_tier1()'), '2-tier mode must define primary runner');
    assert.ok(!cmd.includes('_run_tier3()'), '2-tier mode must not define Tier 3 runner');
  });
});

describe('ATDD Layer 1: Shared-Quota Bypass Control Flow Specification', () => {
  const baseParams = {
    prompt: 'task',
    mode: 'executor',
    provider: 'enmaas',
    secondaryProject: 'itpc-ca-shared',
    tertiaryProject: 'cnv-ai-insights',
  };

  it('contains shared quota error pattern routing directly to Tier 3', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const quotaRegex = /RESOURCE_EXHAUSTED\|Quota exceeded\|429.*quota\|billing\|budget/i;
    assert.ok(quotaRegex.test(cmd), 'Command must match quota exhaustion pattern');
    assert.ok(cmd.includes('_run_tier3'), 'Quota bypass must invoke _run_tier3 directly');
  });

  it('contains gateway infra error pattern routing to Tier 2 with secondary quota fallback', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const infraRegex = /502\|503\|504\|ECONNREFUSED\|ETIMEDOUT\|timed/i;
    assert.ok(infraRegex.test(cmd), 'Command must match infra outage pattern');
    assert.ok(cmd.includes('_run_tier2'), 'Infra outage must invoke _run_tier2');
  });

  it('configures trap cleanup on EXIT, INT, TERM for ephemeral error log', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes("trap 'rm -f \"$_err_log\"' EXIT"), 'Must trap EXIT to remove _err_log');
    assert.ok(cmd.includes("trap 'rm -f \"$_err_log\"; exit 130' INT TERM"), 'Must trap INT TERM to remove _err_log');
  });

  it('filters bearer tokens and api keys with sed -E on terminal failure', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('sed -E'), 'Must use sed -E for secret redaction');
    assert.ok(cmd.includes('[REDACTED]'), 'Must replace secrets with [REDACTED]');
  });

  it('passes bash -n syntax validation', () => {
    const res = buildCommand(baseParams);
    const parsed = JSON.parse(res.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: parsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Generated 3-tier cascade script must pass bash -n');
  });
});

describe('ATDD Layer 3: Runtime Execution Simulation (Bash Closed-Loop Routing)', () => {
  const buildMockCascadeExecutionScript = (tier1Behavior, tier2Behavior, tier3Behavior) => `
(
  _marker_dir="$(mktemp -d /tmp/claude-test-marker-XXXXXX)"
  _marker_t2="$_marker_dir/marker_t2"
  _marker_t3="$_marker_dir/marker_t3"

  _run_tier1() (
    ${tier1Behavior}
  )

  _run_tier2() (
    ${tier2Behavior}
  )

  _run_tier3() (
    ${tier3Behavior}
  )

  _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"
  trap 'rm -rf "$_marker_dir"' EXIT

  _code=0
  _run_tier1 2>"$_err_log" || _code=$?
  if [ "$_code" -eq 0 ]; then
    exit 0
  fi

  if grep -Eiq 'RESOURCE_EXHAUSTED|Quota exceeded|429.*quota|billing|budget' "$_err_log"; then
    echo "BYPASS_TO_TIER3" >&2
    touch "$_marker_t3"
    _run_tier3
    exit $?
  fi

  if grep -Eiq '502|503|504|ECONNREFUSED|ETIMEDOUT|timed?[[:space:]]*out' "$_err_log"; then
    echo "FAILOVER_TO_TIER2" >&2
    touch "$_marker_t2"
    _code2=0
    _run_tier2 2>"$_err_log" || _code2=$?
    if [ "$_code2" -eq 0 ]; then
      exit 0
    fi
    if grep -Eiq 'RESOURCE_EXHAUSTED|Quota exceeded|429.*quota|billing|budget' "$_err_log"; then
      echo "TIER2_QUOTA_TO_TIER3" >&2
      touch "$_marker_t3"
      _run_tier3
      exit $?
    fi
    _code=$_code2
  fi

  sed -E 's/([bB][eE][aA][rR][eE][rR][[:space:]]+|([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?|[tT][oO][kK][eE][nN][=:][[:space:]]*"?)[^[:space:]'\\''&]+/\\1[REDACTED]/g' "$_err_log" >&2
  exit "$_code"
)
`;

  it('Tier 1 quota error bypasses Tier 2 and jumps directly to Tier 3', () => {
    const script = buildMockCascadeExecutionScript(
      'echo "HTTP 429: Quota exceeded RESOURCE_EXHAUSTED" >&2; exit 1',
      'echo "SHOULD_NOT_BE_CALLED" >&2; exit 99',
      'echo "TIER3_SUCCESS"',
    );

    const out = execSync('bash', { input: script, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    assert.ok(out.includes('TIER3_SUCCESS'), 'Tier 3 must succeed');
  });

  it('Tier 1 infra error routes to Tier 2, and Tier 2 quota error cascades to Tier 3', () => {
    const script = buildMockCascadeExecutionScript(
      'echo "HTTP 503 Service Unavailable" >&2; exit 1',
      'echo "HTTP 429 Quota exceeded" >&2; exit 1',
      'echo "TIER3_SUCCESS_AFTER_TIER2"',
    );

    const out = execSync('bash', { input: script, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    assert.ok(out.includes('TIER3_SUCCESS_AFTER_TIER2'), 'Tier 3 must succeed after Tier 2 quota exhaustion');
  });

  it('terminal failure redacts bearer tokens and api keys from stderr', () => {
    const script = buildMockCascadeExecutionScript(
      'echo "Fatal error: Bearer secret-token-12345 api_key=super-secret-key" >&2; exit 1',
      'exit 1',
      'exit 1',
    );

    let stderr = '';
    try {
      execSync('bash', { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(stderr.includes('Bearer [REDACTED]'), 'Bearer token must be redacted');
    assert.ok(stderr.includes('api_key=[REDACTED]'), 'API key must be redacted');
    assert.ok(!stderr.includes('secret-token-12345'), 'Raw secret token must not leak in stderr');
    assert.ok(!stderr.includes('super-secret-key'), 'Raw API key must not leak in stderr');
  });
});

describe('Code Review Remediation: Quoting, Redaction & Project Resolution Deduplication', () => {
  it('applies POSIX single-quote escaping to prevent subshell command injection', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: "proj'; rm -rf /; echo 'hack",
      secondaryCredentials: "/creds/tier'2.json",
      tertiaryProject: 'cnv-ai-insights',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes("export CLOUDSDK_CORE_PROJECT='proj'\\''"), 'Project ID with quotes must be POSIX single-quoted');
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: cmd, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Injected project string must not break bash syntax');
  });

  it('redacts secrets from stderr when fallback Tier 3 fails', () => {
    const script = `
(
  _marker_dir="$(mktemp -d /tmp/claude-test-marker-XXXXXX)"
  _marker_t3="$_marker_dir/marker_t3"
  _err_log="$(mktemp "$_marker_dir/err.XXXXXX")"
  trap 'rm -rf "$_marker_dir"' EXIT
  _redact() { sed -E 's/([bB][eE][aA][rR][eE][rR][[:space:]]+|([aA][pP][iI][_-])?[kK][eE][yY][=:][[:space:]]*"?|[tT][oO][kK][eE][nN][=:][[:space:]]*"?)[^[:space:]"\\x27&]+/\\1[REDACTED]/g' "$_err_log" >&2; }
  _run_tier3() ( echo 'Fatal error: api_key="leaked-secret-999"' >&2; exit 1 )

  _code=0; _run_tier3 2>"$_err_log" || _code=$?
  _redact; exit "$_code"
)
`;
    let stderr = '';
    try {
      execSync('bash', { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      stderr = err.stderr ? err.stderr.toString() : '';
    }
    assert.ok(stderr.includes('api_key="[REDACTED]"'), 'Quoted key value must be redacted without corrupting trailing quote');
    assert.ok(!stderr.includes('leaked-secret-999'), 'Leaked secret must not appear in stderr');
  });

  it('deduplicates project resolution across failover and models via providers.resolveGcpProjects', () => {
    const env = {
      VERTEX_PRIMARY_PROJECT: 'proj-p1',
      VERTEX_SECONDARY_PROJECT: 'proj-p2',
      VERTEX_TERTIARY_PROJECT: 'proj-p3',
    };
    const res = resolveGcpProjects({}, env);
    assert.equal(res.primaryProject, 'proj-p1');
    assert.equal(res.secondaryProject, 'proj-p2');
    assert.equal(res.tertiaryProject, 'proj-p3');
    assert.equal(res.hasTertiary, true);
  });
});
