// claude-mcp-server/test/failover-cascade.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for 3-tier failover cascade with shared-quota bypass. [Constraint]: Pure logic, node:test + node:assert only.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveFailoverConfig, buildFailoverScript } from '../failover.js';
import { buildCommand, FORMATTER_PATH } from '../command-builder.js';
import { REDACT_SED, quote } from '../failover-scripts.js';
import { resolveGcpProjects } from '../providers.js';
import { createEnvScrubber } from './helpers/env.js';

const scrubber = createEnvScrubber();
beforeEach(() => scrubber.scrub());
afterEach(() => scrubber.restore());

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
    secondaryProject: 'vertex-project-1',
    secondaryCredentials: '/creds/tier2.json',
    tertiaryProject: 'vertex-project-2',
    tertiaryCredentials: '/creds/tier3.json',
  };

  it('generates 3-tier cascade script with isolated tier runners and sticky markers', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_run_tier1()'), 'Command must define _run_tier1');
    assert.ok(cmd.includes('_run_tier2()'), 'Command must define _run_tier2');
    assert.ok(cmd.includes('_run_tier3()'), 'Command must define _run_tier3');
    assert.ok(cmd.includes('_marker_t2='), 'Command must define Tier 2 sticky marker');
    assert.ok(cmd.includes('_marker_t3='), 'Command must define Tier 3 sticky marker');
  });

  it('T-4: enforces subshell project/credential isolation and per-tier --settings overrides for Tier 2 and Tier 3', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="vertex-project-1"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='vertex-project-1'"),
      'Tier 2 subshell must export CLOUDSDK_CORE_PROJECT for Tier 2',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="vertex-project-1"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='vertex-project-1'"),
      'Tier 2 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 2',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier2.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier2.json'"),
      'Tier 2 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 2',
    );
    assert.ok(
      cmd.includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":"1","ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-1","CLOUDSDK_CORE_PROJECT":"vertex-project-1","GOOGLE_APPLICATION_CREDENTIALS":"/creds/tier2.json"},"disableAllHooks":true}\''),
      'Tier 2 command must pass --settings JSON overriding project and credentials',
    );

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="vertex-project-2"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='vertex-project-2'"),
      'Tier 3 subshell must export CLOUDSDK_CORE_PROJECT for Tier 3',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="vertex-project-2"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='vertex-project-2'"),
      'Tier 3 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 3',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier3.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier3.json'"),
      'Tier 3 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 3',
    );
    assert.ok(
      cmd.includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":"1","ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-2","CLOUDSDK_CORE_PROJECT":"vertex-project-2","GOOGLE_APPLICATION_CREDENTIALS":"/creds/tier3.json"},"disableAllHooks":true}\''),
      'Tier 3 command must pass --settings JSON overriding project and credentials',
    );
  });

  it('passes resolvedModel into resolveFailoverConfig and normalizes legacy models across all tiers (Defect D / T-3)', () => {
    const res = buildCommand({
      prompt: 'review repo',
      model: 'claude-opus-5-5',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
      tertiaryProject: 'vertex-project-3',
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(!parsed.command.includes('claude-opus-5-5'), 'Legacy claude-opus-5-5 must not appear in any Vertex tier');
    assert.ok(parsed.command.includes("--model 'opus'"), 'All Vertex tiers must normalize claude-opus-5-5 to canonical opus');
  });

  it('preserves backward compatibility when tertiary project is omitted (2-tier)', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
    }, { ENMAAS_KEY: 'test-key' });
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
    secondaryProject: 'vertex-project-1',
    tertiaryProject: 'vertex-project-2',
  };

  it('contains shared quota error pattern routing directly to Tier 3', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const quotaRegex = /RESOURCE_EXHAUSTED|Quota exceeded|429/i;
    assert.ok(quotaRegex.test(cmd), 'Command must match quota exhaustion pattern');
    assert.ok(cmd.includes('_run_tier3'), 'Quota bypass must invoke _run_tier3 directly');
  });

  it('contains gateway infra error pattern routing to Tier 2 with secondary quota fallback', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const infraRegex = /502\|503\|504/;
    assert.ok(infraRegex.test(cmd), 'Command must match infra outage pattern');
    assert.ok(cmd.includes('_run_tier2'), 'Infra outage must invoke _run_tier2');
  });

  it('T-5/T-6: inspects both stderr and stdout via _grep, resets _last_o at _run_to entry, and cascades on org-policy/model/auth errors', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_grep()'), 'Script must define _grep() helper for stdout+stderr error inspection');
    assert.ok(cmd.includes('allowedModels'), 'Script must include allowedModels org-policy pattern');
    assert.ok(cmd.includes('not[[:space:]]+authorized'), 'Script must include EnMaaS model authorization pattern');
    assert.ok(cmd.includes('ENMAAS_KEY.*not[[:space:]]+set'), 'Script must include unset ENMAAS_KEY pattern');
    assert.ok(
      /_run_to\(\)\s*\{\s*\[ -n "\$_last_o" \] && rm -f "\$_last_o"; _last_o=;/.test(cmd),
      '_run_to must reset _last_o before mktemp'
    );
  });

  it('configures trap cleanup on EXIT, INT, TERM for ephemeral error log and prompt file', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('$_err_log') && cmd.includes('$_pfile'), 'Must trap to remove _err_log and _pfile');
    assert.ok(cmd.includes('trap') && cmd.includes('EXIT'), 'Must trap EXIT');
    assert.ok(cmd.includes('trap') && (cmd.includes('INT') || cmd.includes('TERM')), 'Must trap signals');
  });

  it('filters bearer tokens and api keys with sed -E on terminal failure', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('sed -E'), 'Must use sed -E for secret redaction');
    assert.ok(cmd.includes('[REDACTED]'), 'Must replace secrets with [REDACTED]');
  });

  it('passes bash -n syntax validation', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: parsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Generated 3-tier cascade script must pass bash -n');
  });
});

describe('ATDD Layer 3: Runtime Execution Simulation (Bash Closed-Loop Routing with Production Generator)', () => {
  let tmpDir;
  let mockClaudeBin;
  let behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-runtime-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stubScript = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    QUOTA_429)
      echo "HTTP 429: Quota exceeded RESOURCE_EXHAUSTED" >&2
      exit 1
      ;;
    INFRA_503)
      echo "HTTP 503 Service Unavailable" >&2
      exit 1
      ;;
    USER_401)
      echo "HTTP 401 Unauthorized" >&2
      exit 1
      ;;
    STDOUT_ORG_POLICY_400)
      echo 'API Error: 400 {"error":{"code":400,"message":"Precondition check failed. Organization Policy constraint constraints/vertexai.allowedModels violated","status":"FAILED_PRECONDITION"}}'
      exit 1
      ;;
    STDOUT_ENMAAS_403_UNAUTH)
      echo 'API Error: 403 {"error":{"message":"model is not authorized for this user","type":"permission_error","code":"403"}}'
      exit 1
      ;;
    STDOUT_MODEL_UNAVAIL)
      echo "The model claude-opus-4-8 is not available on your vertex deployment"
      exit 1
      ;;
    STDOUT_USER_400_INVALID)
      echo 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is required"}}'
      echo "HTTP 503 transient noise on stderr" >&2
      exit 1
      ;;
    FATAL_SECRET)
      echo "Fatal error: Bearer secret-token-12345 api_key=super-secret-key" >&2
      exit 1
      ;;
    SUCCESS_*)
      echo "TIER_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      echo "UNKNOWN_MOCK_ACTION: $ACTION" >&2
      exit 1
      ;;
  esac
else
  echo "DEFAULT_SUCCESS proj=$ANTHROPIC_VERTEX_PROJECT_ID"
  exit 0
fi
`;
    fs.writeFileSync(mockClaudeBin, stubScript, { mode: 0o755 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('Tier 1 quota error bypasses Tier 2 and jumps directly to Tier 3 (F-2)', () => {
    fs.writeFileSync(behaviorFile, 'QUOTA_429\nSUCCESS_TIER3\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3'), 'Tier 3 must succeed');
    assert.ok(out.includes('proj=proj-t3-isolated'), 'Tier 3 must run with tertiary project');
  });

  it('Tier 1 infra error routes to Tier 2, and Tier 2 failure cascades to Tier 3 (F-2, F-9)', () => {
    fs.writeFileSync(behaviorFile, 'INFRA_503\nINFRA_503\nSUCCESS_TIER3_AFTER_T2\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3_AFTER_T2'), 'Tier 3 must succeed after Tier 2 failure');
    assert.ok(out.includes('proj=proj-t3-isolated'), 'Tier 3 must run with tertiary project');
  });

  it('Tier 1 infra error routes to Tier 2, and Tier 2 user error is vetoed without calling Tier 3 (F-4)', () => {
    fs.writeFileSync(behaviorFile, 'INFRA_503\nUSER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on Tier 2 user error veto');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    assert.ok(!stderr.includes('Routing to Tier 3'), 'Tier 3 must not be routed to');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 3 must never be executed after Tier 2 user error veto');
  });

  it('Tier 1 shared-quota routes to Tier 3, and Tier 3 user error is vetoed without falling back to Tier 2 (F-4)', () => {
    fs.writeFileSync(behaviorFile, 'QUOTA_429\nUSER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on Tier 3 user error veto');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    assert.ok(!stderr.includes('Falling back to Tier 2'), 'Tier 2 fallback must not be routed to');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 2 fallback must never be executed after Tier 3 user error veto');
  });

  it('Tier 1 user error is vetoed and does not failover (F-4, F-5)', () => {
    fs.writeFileSync(behaviorFile, 'USER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on user error');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    // Behavior file must still have SUCCESS_SHOULD_NOT_RUN because Tier 2/3 were not called
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Secondary tiers must not be executed');
  });

  it('terminal failure redacts bearer tokens and api keys from stderr (F-8)', () => {
    fs.writeFileSync(behaviorFile, 'FATAL_SECRET\nFATAL_SECRET\nFATAL_SECRET\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(stderr.includes('Bearer [REDACTED]'), 'Bearer token must be redacted');
    assert.ok(stderr.includes('api_key=[REDACTED]'), 'API key must be redacted');
    assert.ok(!stderr.includes('secret-token-12345'), 'Raw secret token must not leak in stderr');
    assert.ok(!stderr.includes('super-secret-key'), 'Raw API key must not leak in stderr');
  });

  it('large prompt (45KB) in 3-tier cascade executes without E2BIG (F-1)', () => {
    const largePrompt = 'a'.repeat(45 * 1024);
    fs.writeFileSync(behaviorFile, 'SUCCESS_TIER1\n');
    const res = buildCommand({
      prompt: largePrompt,
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    assert.ok(!res.isError, '45KB prompt must be accepted by command builder');

    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER1'), '45KB prompt in 3-tier cascade must execute successfully');
  });

  it('T-5: Tier 1 Vertex org-policy 400 error on stdout is captured via _grep, not vetoed, and cascades to Tier 2', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_ORG_POLICY_400\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test org policy stdout failover',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Tier 2 must succeed after Tier 1 stdout org-policy 400');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 2 must execute with vertex-project-2');
    assert.ok(!out.includes('allowedModels'), 'Tier 1 error stdout must not leak into successful Tier 2 stdout');
  });

  it('T-6: 3-tier cascade routes Tier 1 EnMaaS 403 model auth on stdout -> Tier 2 Vertex org-policy 400 on stdout -> Tier 3 success', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_ENMAAS_403_UNAUTH\nSTDOUT_ORG_POLICY_400\nSUCCESS_TIER3\n');
    const res = buildCommand({
      prompt: 'test 3-tier stdout cascade',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3'), 'Tier 3 must succeed after Tier 1 403 and Tier 2 400');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 3 must execute with vertex-project-2');
    assert.ok(!out.includes('not authorized'), 'Tier 1 stdout error must not leak into final output');
    assert.ok(!out.includes('allowedModels'), 'Tier 2 stdout error must not leak into final output');

    const uid = process.getuid ? process.getuid() : 0;
    const markerDir = path.join(tmpDir, `claude-cli-${uid}`);
    const markers = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
    assert.ok(markers.some((f) => f.endsWith('_t3')), 'Sticky marker _t3 must be created upon Tier 3 success');
  });

  it('T-6b: unset ENMAAS_KEY in subshell cascades from Tier 1 to Tier 2 Vertex fallback', () => {
    fs.writeFileSync(behaviorFile, 'SUCCESS_TIER2_NO_KEY\n');
    const res = buildCommand({
      prompt: 'test missing enmaas key cascade',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const envWithoutKey = { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir };
    delete envWithoutKey.ENMAAS_KEY;

    const out = execSync('bash', {
      input: parsed.command,
      env: envWithoutKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2_NO_KEY'), 'Missing ENMAAS_KEY on Tier 1 must cascade to Tier 2');
    assert.ok(out.includes('proj=vertex-project-1'), 'Tier 2 must run with vertex-project-1');
  });

  it('T-7: genuine 400 invalid_request_error on stdout is vetoed immediately without invoking Tier 2 or Tier 3', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_USER_400_INVALID\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test stdout user 400 veto',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_) {
      failed = true;
    }

    assert.ok(failed, 'Genuine 400 invalid_request_error on stdout must abort with non-zero exit code');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 2/3 must not be invoked on genuine 400 invalid_request_error');
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
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes("export CLOUDSDK_CORE_PROJECT='proj'\\''"), 'Project ID with quotes must be POSIX single-quoted');
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: cmd, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Injected project string must not break bash syntax');
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

describe('Code Review Remediation: Stream Error Formatting, Tail Grep, Model-Scoped Markers & Active Tier 3 Recovery', () => {
  let tmpDir;
  let mockClaudeBin;
  let behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-cr-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stubScript = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    STREAM_JSON_RESULT_ERR_400)
      echo '{"type":"result","is_error":true,"result":"API Error: 400 constraints/vertexai.allowedModels violated"}'
      exit 1
      ;;
    STREAM_JSON_ERROR_EVENT_403)
      echo '{"type":"error","error":{"message":"model is not authorized for this user"}}'
      exit 1
      ;;
    PROSE_SPOOF_VETO_THEN_429)
      echo "Line 1: Discussion of HTTP 401 Unauthorized and invalid_request_error in Turn 1"
      echo "Line 2: Normal assistant prose explaining authentication patterns"
      echo "Line 3: Normal assistant prose"
      echo "Line 4: Normal assistant prose"
      echo "Line 5: Normal assistant prose"
      echo "Line 6: Normal assistant prose"
      echo "Line 7: Normal assistant prose"
      echo "Line 8: Normal assistant prose"
      echo "Line 9: Normal assistant prose"
      echo "Line 10: Normal assistant prose"
      echo "Line 11: Normal tail line 1"
      echo "Line 12: Normal tail line 2"
      echo "Line 13: Normal tail line 3"
      echo "Line 14: Normal tail line 4"
      echo "Line 15: Normal tail line 5"
      echo "API Error: 429 Too Many Requests"
      exit 1
      ;;
    FAIL_TIER3)
      echo "HTTP 503 Service Unavailable" >&2
      exit 1
      ;;
    CHECK_CREDS_UNSET_TIER2)
      echo "TIER_SUCCESS: CHECK_CREDS_UNSET_TIER2 proj=$ANTHROPIC_VERTEX_PROJECT_ID creds=\${GOOGLE_APPLICATION_CREDENTIALS:-UNSET}"
      exit 0
      ;;
    SUCCESS_*)
      echo "TIER_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      echo "UNKNOWN_MOCK_ACTION: $ACTION" >&2
      exit 1
      ;;
  esac
else
  echo "DEFAULT_SUCCESS proj=$ANTHROPIC_VERTEX_PROJECT_ID"
  exit 0
fi
`;
    fs.writeFileSync(mockClaudeBin, stubScript, { mode: 0o755 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('CR-1 (C6-4): stream-format.js surfaces result (is_error: true) and error JSON events so Tier 1 cascades to Tier 2', () => {
    const streamInput = [
      '{"type":"result","is_error":true,"result":"API Error: 400 constraints/vertexai.allowedModels violated"}',
      '{"type":"error","error":{"message":"model is not authorized for this user"}}',
    ].join('\n') + '\n';

    const fmtOut = execSync(`node "${FORMATTER_PATH}"`, {
      input: streamInput,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(
      fmtOut.includes('API Error: 400 constraints/vertexai.allowedModels violated'),
      'stream-format.js must surface result event when is_error is true'
    );
    assert.ok(
      fmtOut.includes('model is not authorized for this user'),
      'stream-format.js must surface error event message'
    );

    fs.writeFileSync(behaviorFile, 'STREAM_JSON_RESULT_ERR_400\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test stream-json result error cascade',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Tier 1 stream-json result is_error:true must cascade to Tier 2');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 2 must execute with vertex-project-2');
  });

  it('CR-2 (R5-2/C6-2/R2/C4): _grep inspects only tail -n 5 of $_last_o so earlier assistant prose does not false-positive _veto', () => {
    fs.writeFileSync(behaviorFile, 'PROSE_SPOOF_VETO_THEN_429\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test tail grep anti-spoofing',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    assert.ok(
      parsed.command.includes('tail -n 5 "$_last_o"'),
      '_grep must inspect only tail -n 5 of $_last_o'
    );

    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(
      out.includes('TIER_SUCCESS: SUCCESS_TIER2'),
      'Earlier assistant prose containing 401/invalid_request_error must not trigger _veto when tail has 429'
    );
  });

  it('CR-3a (C6-1): active _marker_t3 failure removes _marker_t3, falls back to _run_tier2, and touches _marker_t2', () => {
    const uid = process.getuid ? process.getuid() : 0;
    const markerDir = path.join(tmpDir, `claude-cli-${uid}`);

    // Call 1: populate _marker_t3 via Tier 1 429 shared-quota bypass -> Tier 3 success
    fs.writeFileSync(behaviorFile, 'PROSE_SPOOF_VETO_THEN_429\nSUCCESS_TIER3_INIT\n');
    const res = buildCommand({
      prompt: 'call 1',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });
    const parsed = JSON.parse(res.content[0].text);

    // Ensure _marker_t3 is active before Call 2
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const t3Match = parsed.command.match(/_marker_t3="\$_marker_dir\/([^"]+)"/);
    assert.ok(t3Match, 'Cascade script must define _marker_t3');
    const t3MarkerPath = path.join(markerDir, t3Match[1]);
    const t2MarkerPath = t3MarkerPath.replace(/_t3$/, '_t2');
    fs.writeFileSync(t3MarkerPath, '');

    // Call 2: _marker_t3 is active (-mmin -30), _run_tier3 fails with FAIL_TIER3 (503), must fall back to _run_tier2 (SUCCESS_TIER2)
    fs.writeFileSync(behaviorFile, 'FAIL_TIER3\nSUCCESS_TIER2\n');
    const out2 = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out2.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Active _marker_t3 failure must fall back to _run_tier2');
    assert.ok(out2.includes('proj=vertex-project-1'), 'Fallback Tier 2 must run with vertex-project-1');
    assert.ok(!fs.existsSync(t3MarkerPath), '_marker_t3 must be deleted when Tier 3 fails');
    assert.ok(fs.existsSync(t2MarkerPath), '_marker_t2 must be touched when fallback to Tier 2 succeeds');
  });

  it('CR-3b (C4): sticky markers are scoped by resolved model so opus cascade does not force sonnet or glm onto Tier 3', () => {
    const reviewerCmd = JSON.parse(buildCommand({
      prompt: 'reviewer task',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const architectCmd = JSON.parse(buildCommand({
      prompt: 'architect task',
      mode: 'architect',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const explorerCmd = JSON.parse(buildCommand({
      prompt: 'explorer task',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const revMarker = reviewerCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];
    const archMarker = architectCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];
    const expMarker = explorerCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];

    assert.ok(revMarker && archMarker && expMarker, 'All cascade commands must define _marker_t3');
    assert.notEqual(revMarker, archMarker, 'reviewer (opus) and architect (sonnet) must have distinct sticky markers');
    assert.notEqual(revMarker, expMarker, 'reviewer (opus) and explorer (glm-5-3) must have distinct sticky markers');
    assert.notEqual(archMarker, expMarker, 'architect (sonnet) and explorer (glm-5-3) must have distinct sticky markers');
  });

  it('CR-4 (R5-1): 2-tier failover explicitly unsets GOOGLE_APPLICATION_CREDENTIALS when secondaryCredentials is omitted', () => {
    const vertexRes = buildCommand({
      prompt: 'test vertex 2-tier cred unset',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      primaryCredentials: '/creds/tier1-sa.json',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const vertexCmd = JSON.parse(vertexRes.content[0].text).command;

    const crossRes = buildCommand({
      prompt: 'test cross-provider 2-tier cred unset',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });
    const crossCmd = JSON.parse(crossRes.content[0].text).command;

    assert.ok(
      vertexCmd.includes('unset GOOGLE_APPLICATION_CREDENTIALS'),
      'buildVertexFailoverScript (_run_claude) must unset GOOGLE_APPLICATION_CREDENTIALS when credentials argument is empty'
    );
    assert.ok(
      crossCmd.includes('unset GOOGLE_APPLICATION_CREDENTIALS') ||
      /unset [^\n]*GOOGLE_APPLICATION_CREDENTIALS/.test(crossCmd),
      'buildCrossProviderFailoverScript must unset GOOGLE_APPLICATION_CREDENTIALS when secondaryCredentials is omitted'
    );

    // Closed-loop runtime proof: ambient GOOGLE_APPLICATION_CREDENTIALS from parent/Tier 1 must not leak into Tier 2
    fs.writeFileSync(behaviorFile, 'FAIL_TIER3\nCHECK_CREDS_UNSET_TIER2\n');
    const out = execSync('bash', {
      input: crossCmd,
      env: {
        ...process.env,
        MOCK_BEHAVIOR_FILE: behaviorFile,
        ENMAAS_KEY: 'test-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/leaked/ambient-tier1-sa.json',
        XDG_RUNTIME_DIR: tmpDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('creds=UNSET'), 'Tier 2 subshell must have GOOGLE_APPLICATION_CREDENTIALS unset, not inherited from ambient env');
  });
});

describe('ATDD Layer 3: Live FD 3 Streaming, Redaction Resilience & FD Isolation (T-S1, T-S2, T-S3, T-S6)', () => {
  let tmpDir;
  let mockClaudeBin;
  let behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-stream-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stubScript = `#!/bin/bash
ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
case "$ACTION" in
  FIXTURE_*)
    FIX_FILE="${tmpDir}/$ACTION.jsonl"
    [ -f "${tmpDir}/$ACTION.err" ] && cat "${tmpDir}/$ACTION.err" >&2
    EXIT_CODE=$(head -n 1 "$FIX_FILE")
    tail -n +2 "$FIX_FILE"
    exit "$EXIT_CODE"
    ;;
  BG_SLEEP_SUCCESS)
    sleep 10 >/dev/null 2>&1 &
    printf '%s\n' '{"type":"system","subtype":"init","model":"sonnet","session_id":"s-bg"}'
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"CHILD_FD3_ISOLATED\\n"}]}}'
    exit 0
    ;;
  LARGE_STDERR_429)
    cat "${tmpDir}/large-429.err" >&2
    printf '%s\n' '{"type":"error","error":{"message":"API Error: 429 quota"}}'
    exit 1
    ;;
  *)
    echo "UNKNOWN_ACTION: $ACTION" >&2
    exit 1
    ;;
esac
`;
    fs.writeFileSync(mockClaudeBin, stubScript, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFixture = (name, exitCode, events) => {
    fs.writeFileSync(path.join(tmpDir, `${name}.jsonl`), `${exitCode}\n${events.join('\n')}\n`);
  };

  const buildNoTimeoutBinDir = () => {
    const dir = path.join(tmpDir, 'no-timeout-bin');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const bins = [
        'bash', 'sh', 'node', 'sed', 'cat', 'rm', 'mktemp', 'mkdir', 'chmod',
        'find', 'id', 'grep', 'tail', 'touch', 'date', 'printf', 'wc', 'sleep', '[',
        'head', 'mv',
      ];
      for (const bin of bins) {
        const resolved = spawnSync('which', [bin], { encoding: 'utf8' });
        if (resolved.status === 0 && resolved.stdout.trim()) {
          const target = resolved.stdout.trim().split('\n')[0];
          const linkPath = path.join(dir, bin);
          if (!fs.existsSync(linkPath)) fs.symlinkSync(target, linkPath);
        }
      }
    }
    return dir;
  };

  it('T-S1: live FD 3 redacted progress streaming, tier stdout isolation, and standalone REDACT_SED unclosed-quote checks', () => {
    writeFixture('FIXTURE_T1', 1, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p1', session_id: 's1' }),
      JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 400 constraints/vertexai.allowedModels violated' }),
    ]);
    writeFixture('FIXTURE_T2', 0, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p2', session_id: 's2' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'export ENMAAS_KEY="secret-abc\ncurl -H \'Authorization: Bearer super-secret-xyz\' https://example.com' },
          }],
        },
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CLEAN_TIER2_FINAL_ANSWER\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_T1\nFIXTURE_T2\n');

    const res = buildCommand({
      prompt: 'test live fd3 progress',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const { command } = JSON.parse(res.content[0].text);

    const run = spawnSync('bash', {
      input: command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, `Expected exit 0, got ${run.status}; stderr=${run.stderr}`);
    assert.ok(run.stderr.includes('⚡ model:'), 'stderr must include live init progress');
    assert.ok(run.stderr.includes('⏵ Bash'), 'stderr must include live tool_use progress');
    assert.ok(run.stderr.includes('[REDACTED]'), 'stderr must redact secrets in progress stream');
    assert.ok(!run.stderr.includes('secret-abc'), 'stderr must not leak unclosed-quote ENMAAS_KEY value');
    assert.ok(!run.stderr.includes('super-secret-xyz'), 'stderr must not leak Bearer token');
    assert.ok(run.stdout.includes('CLEAN_TIER2_FINAL_ANSWER'), 'stdout must contain Tier 2 final answer');
    assert.ok(!run.stdout.includes('allowedModels'), 'Tier 1 error must not leak into stdout');
    assert.ok(!run.stderr.includes('allowedModels'), 'Tier 1 error must not leak into live stderr progress');
    assert.ok(!run.stdout.includes('⏵'), 'tool_use progress must not leak into stdout');
    assert.ok(!run.stdout.includes('⚡'), 'init progress must not leak into stdout');

    for (const [label, input, secret] of [
      ['unclosed ENMAAS_KEY quote', 'ENMAAS_KEY="secret-abc\n', 'secret-abc'],
      ['unclosed Cookie header quote', 'Cookie: session="tok-xyz\n', 'tok-xyz'],
      ['unclosed JSON cookie quote', '"cookie": "tok-xyz\n', 'tok-xyz'],
    ]) {
      const out = execSync(REDACT_SED, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      assert.ok(out.includes('[REDACTED]'), `${label}: REDACT_SED must emit [REDACTED]`);
      assert.ok(!out.includes(secret), `${label}: REDACT_SED must not leak ${secret}`);
    }
  });

  it('T-S2: non-truncating redact preserves late-offset errors past char 120 for _veto and _grep cascade', () => {
    // Case A (_veto): >150-char result (is_error: true) with Bearer leak near start + 400 invalid_request_error after char 130
    const pad = 'x'.repeat(135);
    writeFixture('FIXTURE_LATE_VETO', 1, [
      JSON.stringify({ type: 'result', is_error: true, result: `Bearer leak-999 ${pad} 400 invalid_request_error` }),
    ]);
    writeFixture('FIXTURE_SHOULD_NOT_RUN', 0, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SUCCESS_SHOULD_NOT_RUN\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_LATE_VETO\nFIXTURE_SHOULD_NOT_RUN\n');

    const vetoRes = buildCommand({
      prompt: 'test late veto',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const vetoCmd = JSON.parse(vetoRes.content[0].text).command;
    const vetoRun = spawnSync('bash', {
      input: vetoCmd,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.notEqual(vetoRun.status, 0, 'Late-offset 400 invalid_request_error must abort non-zero via _veto');
    assert.ok(vetoRun.stdout.includes('[REDACTED]'), 'stdout must contain [REDACTED] for Bearer token');
    assert.ok(!vetoRun.stdout.includes('leak-999') && !vetoRun.stderr.includes('leak-999'), 'must not leak Bearer token on stdout or stderr');
    assert.ok(
      fs.readFileSync(behaviorFile, 'utf8').includes('FIXTURE_SHOULD_NOT_RUN'),
      'Tier 2 must not be invoked when late-offset 400 invalid_request_error triggers _veto'
    );

    // Case B (_grep cascade): >150-char error event with Bearer leak near start + 429 Too Many Requests after char 130
    writeFixture('FIXTURE_LATE_429', 1, [
      JSON.stringify({ type: 'error', error: { message: `Bearer leak-888 ${'y'.repeat(135)} 429 Too Many Requests` } }),
    ]);
    writeFixture('FIXTURE_T2_OK', 0, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CASCADE_LATE_429_OK\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_LATE_429\nFIXTURE_T2_OK\n');

    const cascRes = buildCommand({
      prompt: 'test late 429 cascade',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const cascCmd = JSON.parse(cascRes.content[0].text).command;
    const cascRun = spawnSync('bash', {
      input: cascCmd,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(cascRun.status, 0, `Expected exit 0 on late 429 cascade, got ${cascRun.status}; stderr=${cascRun.stderr}`);
    assert.ok(cascRun.stdout.includes('CASCADE_LATE_429_OK'), 'stdout must include Tier 2 success after late-offset 429');
    assert.ok(!cascRun.stderr.includes('leak-888'), 'stderr must not leak Bearer token from Tier 1 error');
  });

  it('T-S3: broken sed on PATH does not crash failover pipeline or leak Bearer secrets', () => {
    const brokenSedDir = path.join(tmpDir, 'broken-sed');
    fs.mkdirSync(brokenSedDir, { recursive: true });
    fs.writeFileSync(path.join(brokenSedDir, 'sed'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    writeFixture('FIXTURE_429', 1, [
      JSON.stringify({ type: 'error', error: { message: 'API Error: 429 Too Many Requests' } }),
    ]);
    writeFixture('FIXTURE_T2_SED_DOWN', 0, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p2', session_id: 's-sed' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'curl -H "Authorization: Bearer secret-sed-down" https://example.com' },
          }],
        },
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SURVIVED_BROKEN_SED\n' }] } }),
    ]);
    fs.writeFileSync(path.join(tmpDir, 'FIXTURE_T2_SED_DOWN.err'), 'Authorization: Bearer raw-stderr-leak-m2\n');
    fs.writeFileSync(behaviorFile, 'FIXTURE_429\nFIXTURE_T2_SED_DOWN\n');

    const res = buildCommand({
      prompt: 'test broken sed resilience',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const { command } = JSON.parse(res.content[0].text);

    const run = spawnSync('bash', {
      input: command,
      env: {
        ...process.env,
        PATH: `${brokenSedDir}:${process.env.PATH}`,
        MOCK_BEHAVIOR_FILE: behaviorFile,
        XDG_RUNTIME_DIR: tmpDir,
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, `Expected exit 0 with broken sed, got ${run.status}; stderr=${run.stderr}`);
    assert.ok(run.stdout.includes('SURVIVED_BROKEN_SED'), 'stdout must include SURVIVED_BROKEN_SED');
    assert.ok(run.stderr.includes('⚡'), 'stderr must include ⚡ progress indicator');
    assert.ok(run.stderr.includes('[REDACTED]'), 'stderr must include [REDACTED] even when sed exits 1');
    assert.ok(run.stderr.includes('redaction unavailable'), 'stderr must report redaction unavailable on broken sed');
    assert.ok(!run.stderr.includes('secret-sed-down'), 'stderr must not leak secret-sed-down when sed fails');
    assert.ok(!run.stderr.includes('raw-stderr-leak-m2'), 'stderr must not leak raw-stderr-leak-m2 when sed fails');
  });

  it('T-S6: closes FD 3 for background children (3>&-) and handles closed FD 3 EPIPE without leaking progress to stdout', () => {
    const res = buildCommand({
      prompt: 'test fd3 closure',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const { command } = JSON.parse(res.content[0].text);

    assert.ok(
      command.includes('3>&- | CLAUDE_PROGRESS_FD=3 node'),
      'Failover command must close FD 3 on claude child and pass CLAUDE_PROGRESS_FD=3 to formatter'
    );

    fs.writeFileSync(behaviorFile, 'BG_SLEEP_SUCCESS\n');
    const t0 = Date.now();
    const bgRun = spawnSync('bash', {
      input: command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    assert.equal(bgRun.status, 0, `Expected exit 0, got ${bgRun.status}; stderr=${bgRun.stderr}`);
    assert.ok(bgRun.stdout.includes('CHILD_FD3_ISOLATED'), 'stdout must include CHILD_FD3_ISOLATED');
    assert.ok(elapsed < 2000, `Background child must not hold FD 3 open (elapsed ${elapsed}ms)`);

    // Closed-FD 3 / EPIPE non-leak tests directly on stream-format.js
    const events = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', session_id: 's-epipe' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo.js' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CLEAN_STDOUT_AFTER_EPIPE\n' }] } }),
    ].join('\n');

    const epipePipeScript = '{ printf \'%s\\n\' "$EVENTS" | CLAUDE_PROGRESS_FD=3 node "$FORMATTER_PATH" 3>&1 1>&4 4>&- | : ; } 4>&1';
    const epipeClosedScript = 'printf \'%s\\n\' "$EVENTS" | CLAUDE_PROGRESS_FD=3 node "$FORMATTER_PATH" 3>&-';

    for (const [label, script] of [['EPIPE closed pipe reader', epipePipeScript], ['closed FD 3 (3>&-)', epipeClosedScript]]) {
      const r = spawnSync('bash', ['-c', script], {
        env: { ...process.env, EVENTS: events, FORMATTER_PATH },
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(r.stdout.includes('CLEAN_STDOUT_AFTER_EPIPE'), `${label}: stdout must contain assistant text`);
      assert.ok(!r.stdout.includes('⏵'), `${label}: tool_use progress must not leak to stdout`);
      assert.ok(!r.stdout.includes('⚡'), `${label}: init progress must not leak to stdout`);
    }
  });

  it('CR-R2: fatal failure emits terminal API error once on stdout without duplicating into FD 3 stderr', () => {
    writeFixture('FIXTURE_FATAL_400', 1, [
      JSON.stringify({ type: 'error', error: { message: 'API Error: 400 invalid_request_error' } }),
    ]);
    writeFixture('FIXTURE_SHOULD_NOT_RUN', 0, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SHOULD_NOT_RUN\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_FATAL_400\nFIXTURE_SHOULD_NOT_RUN\n');

    const res = buildCommand({
      prompt: 'test fatal single error',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const { command } = JSON.parse(res.content[0].text);

    const run = spawnSync('bash', {
      input: command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 1, `Expected exit 1 on fatal _veto, got ${run.status}`);
    assert.equal(
      (run.stdout.match(/invalid_request_error/g) || []).length,
      1,
      `Terminal API error must appear exactly once on stdout, got stdout=${run.stdout}`
    );
    assert.ok(!run.stderr.includes('invalid_request_error'), 'Terminal API error must not duplicate into FD 3 stderr');
  });

  it('CR-C4-F2: _grep does not fail with SIGPIPE 141 when 429 matches early in >500KB stderr log alongside non-empty $_last_o', () => {
    const largeErr = 'HTTP 429 Too Many Requests\n' + 'padding line for pipe buffer overflow\n'.repeat(15000);
    fs.writeFileSync(path.join(tmpDir, 'large-429.err'), largeErr);
    writeFixture('FIXTURE_RESUMED_OK', 0, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'RESUMED_OK\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'LARGE_STDERR_429\nFIXTURE_RESUMED_OK\n');

    const script = buildFailoverScript({
      type: 'vertex',
      primaryProject: 'vertex-p1',
      secondaryProject: 'vertex-p2',
      primaryArgs: [quote(mockClaudeBin)],
      secondaryArgs: [quote(mockClaudeBin)],
      delim: '__PROMPT_SIGPIPE__',
      prompt: 'test sigpipe',
      fmt: quote(FORMATTER_PATH),
    });

    const run = spawnSync('bash', ['-c', 'set -eo pipefail; ' + script], {
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, `Expected exit 0 without SIGPIPE 141 in _grep, got ${run.status}; stderr=${run.stderr.slice(0, 200)}`);
    assert.ok(run.stdout.includes('RESUMED_OK'), 'Tier 2 must execute and emit RESUMED_OK');
  });

  it('CR-C6-1: stream-format.js redacts secrets and strips control sequences on non-JSON passthrough lines', () => {
    const input = 'FATAL ANTHROPIC_API_KEY=sk-ant-secret-123 authorization: Bearer leaky-tok\x1b[2J\n';
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROGRESS_FD;
    const run = spawnSync('node', [FORMATTER_PATH], {
      input,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, `stream-format.js exited ${run.status}: ${run.stderr}`);
    assert.ok(run.stdout.includes('[REDACTED]'), 'Non-JSON passthrough line must redact secrets');
    assert.ok(!run.stdout.includes('sk-ant-secret-123'), 'Non-JSON passthrough must not leak API key');
    assert.ok(!run.stdout.includes('leaky-tok'), 'Non-JSON passthrough must not leak Bearer token');
    assert.ok(!run.stdout.includes('\x1b[2J'), 'Non-JSON passthrough must strip ANSI control sequences');
  });

  it('CR-R1-parity: stream-format.js redacts response=<secret> inside tool_use command hints matching REDACT_SED', () => {
    const input = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'echo response=supersecret123' },
        }],
      },
    }) + '\n';
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROGRESS_FD;
    const run = spawnSync('node', [FORMATTER_PATH], {
      input,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, `stream-format.js exited ${run.status}: ${run.stderr}`);
    assert.ok(run.stdout.includes('response=[REDACTED]'), `Must redact response=<secret>, got: ${run.stdout}`);
    assert.ok(!run.stdout.includes('supersecret123'), 'Must not leak response secret');
  });

  it('DR-M1: unread stderr FIFO backpressure does not block tier completion or trigger false timeout failover', () => {
    const fifoPath = path.join(tmpDir, 'unread-stderr.fifo');
    const mk = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);

    const toolEvents = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo step_${i}_padding_for_pipe_buffer` } }] },
      })
    );
    writeFixture('FIXTURE_M1_T1', 0, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p1', session_id: 's-m1' }),
      ...toolEvents,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'M1_NO_FALSE_FAILOVER\n' }] } }),
    ]);
    writeFixture('FIXTURE_M1_T2', 0, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SHOULD_NOT_FAILOVER\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_M1_T1\nFIXTURE_M1_T2\n');

    const res = buildCommand({
      prompt: 'test unread stderr fifo backpressure',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockClaudeBin, CLAUDE_TIMEOUT: '5' });
    const { command } = JSON.parse(res.content[0].text);
    const cmdFile = path.join(tmpDir, 'm1-cmd.sh');
    fs.writeFileSync(cmdFile, command);

    const pyDriver = [
      'import os, fcntl, subprocess, time, json, sys',
      'fifo, cmd_file = sys.argv[1], sys.argv[2]',
      'rfd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)',
      'wfd = os.open(fifo, os.O_WRONLY)',
      'with open(cmd_file, "rb") as f: cmd = f.read()',
      't0 = time.monotonic()',
      'p = subprocess.Popen(["bash"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=wfd)',
      'try:',
      '    out, _ = p.communicate(cmd, timeout=8)',
      '    rc = p.returncode',
      'except subprocess.TimeoutExpired:',
      '    p.kill()',
      '    out, _ = p.communicate()',
      '    rc = -1',
      'elapsed_ms = int((time.monotonic() - t0) * 1000)',
      'wfd_blocking = (fcntl.fcntl(wfd, fcntl.F_GETFL) & os.O_NONBLOCK) == 0',
      'os.close(wfd)',
      'chunks = []',
      'while True:',
      '    try:',
      '        d = os.read(rfd, 65536)',
      '        if not d: break',
      '        chunks.append(d)',
      '    except BlockingIOError:',
      '        break',
      'os.close(rfd)',
      'print(json.dumps({"rc": rc, "elapsed_ms": elapsed_ms, "stdout": out.decode("utf8", "replace"), "fifo": b"".join(chunks).decode("utf8", "replace"), "wfd_blocking": wfd_blocking}))',
    ].join('\n');

    const drv = spawnSync('python3', ['-c', pyDriver, fifoPath, cmdFile], {
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(drv.status, 0, `python3 FIFO driver failed: ${drv.stderr}`);
    const result = JSON.parse(drv.stdout);
    assert.equal(result.rc, 0, `Expected child exit 0, got ${result.rc}; stdout=${result.stdout}`);
    assert.ok(result.elapsed_ms < 4000, `Expected <4000ms without FIFO deadlock, took ${result.elapsed_ms}ms`);
    assert.ok(result.stdout.includes('M1_NO_FALSE_FAILOVER'), 'stdout must include M1_NO_FALSE_FAILOVER');
    assert.ok(!result.stdout.includes('SHOULD_NOT_FAILOVER'), 'Must not trigger false failover to Tier 2');
    assert.ok(result.fifo.includes('⚡') || result.fifo.includes('⏵'), 'Drained FIFO must contain progress bytes');
    assert.equal(result.wfd_blocking, true, 'Caller blocking write FD flag must remain blocking');
  });

  it('DR-M3: parametrized 3>&- FD 3 closure across all 7 tier call sites and no-timeout PATH fallback', () => {
    writeFixture('FIXTURE_429', 1, [
      JSON.stringify({ type: 'error', error: { message: 'API Error: 429 Too Many Requests' } }),
    ]);
    writeFixture('FIXTURE_503', 1, [
      JSON.stringify({ type: 'error', error: { message: 'HTTP 503 Service Unavailable' } }),
    ]);

    const cases = [
      ['vertex 2-tier primary', { provider: 'vertex', primaryProject: 'p1', secondaryProject: 'p2' }, { CLAUDE_BIN: mockClaudeBin }, 'BG_SLEEP_SUCCESS\n'],
      ['vertex 2-tier secondary', { provider: 'vertex', primaryProject: 'p1', secondaryProject: 'p2' }, { CLAUDE_BIN: mockClaudeBin }, 'FIXTURE_429\nBG_SLEEP_SUCCESS\n'],
      ['enmaas 2-tier primary', { provider: 'enmaas', secondaryProject: 'p2' }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin }, 'BG_SLEEP_SUCCESS\n'],
      ['enmaas 2-tier secondary', { provider: 'enmaas', secondaryProject: 'p2' }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin }, 'FIXTURE_429\nBG_SLEEP_SUCCESS\n'],
      ['3-tier cascade T1', { provider: 'enmaas', secondaryProject: 'p2', tertiaryProject: 'p3' }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin }, 'BG_SLEEP_SUCCESS\n'],
      ['3-tier cascade T2', { provider: 'vertex', primaryProject: 'p1', secondaryProject: 'p2', tertiaryProject: 'p3' }, { CLAUDE_BIN: mockClaudeBin }, 'FIXTURE_503\nBG_SLEEP_SUCCESS\n'],
      ['3-tier cascade T3', { provider: 'enmaas', secondaryProject: 'p2', tertiaryProject: 'p3' }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin }, 'FIXTURE_429\nBG_SLEEP_SUCCESS\n'],
    ];

    for (const [label, params, buildEnv, behaviors] of cases) {
      const caseRuntime = fs.mkdtempSync(path.join(tmpDir, 'm3-case-'));
      fs.writeFileSync(behaviorFile, behaviors);
      const { command } = JSON.parse(buildCommand({ prompt: label, mode: 'executor', ...params }, buildEnv).content[0].text);
      const t0 = Date.now();
      const r = spawnSync('bash', {
        input: command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: caseRuntime },
        encoding: 'utf8',
        timeout: 5000,
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(elapsed < 2000, `${label}: background sleep must not hold FD 3 open (elapsed ${elapsed}ms)`);
      assert.ok(r.stdout.includes('CHILD_FD3_ISOLATED'), `${label}: stdout must include CHILD_FD3_ISOLATED`);
    }

    // No-timeout PATH branch
    const noTimeoutBinDir = buildNoTimeoutBinDir();

    const noToRuntime = fs.mkdtempSync(path.join(tmpDir, 'm3-noto-'));
    fs.writeFileSync(behaviorFile, 'BG_SLEEP_SUCCESS\n');
    const { command: noToCmd } = JSON.parse(buildCommand({
      prompt: 'no timeout branch',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockClaudeBin }).content[0].text);

    const t0 = Date.now();
    const noToRun = spawnSync(path.join(noTimeoutBinDir, 'bash'), {
      input: noToCmd,
      env: { ...process.env, PATH: noTimeoutBinDir, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: noToRuntime },
      encoding: 'utf8',
      timeout: 5000,
    });
    const noToElapsed = Date.now() - t0;
    assert.equal(noToRun.status, 0, `no-timeout branch: expected exit 0, got ${noToRun.status}; stderr=${noToRun.stderr}`);
    assert.ok(noToElapsed < 2000, `no-timeout branch: background child must not hold FD 3 (elapsed ${noToElapsed}ms)`);
    assert.ok(noToRun.stderr.includes("Warning: 'timeout' not found"), 'no-timeout branch must warn on stderr');
    assert.ok(noToRun.stderr.includes('⚡'), 'no-timeout branch must still stream ⚡ progress');
    assert.ok(noToRun.stdout.includes('CHILD_FD3_ISOLATED'), 'no-timeout branch stdout must include CHILD_FD3_ISOLATED');
  });

  it('DR-M4: shared-corpus redaction parity across REDACT_SED & stream-format.js plus L-2/L-3/L-4 edge cases', () => {
    const corpus = [
      ['escaped digest response', 'Digest username="alice", response=\\"deadbeef987654\\"', ['deadbeef987654']],
      ['unclosed digest response', 'Digest username="alice", response="unclosed-resp-secret', ['unclosed-resp-secret']],
      ['unclosed key', 'ENMAAS_KEY="unclosed-key-secret', ['unclosed-key-secret']],
      ['unclosed cookie', '"cookie": "unclosed-cookie-secret', ['unclosed-cookie-secret']],
      ['escaped cookie', '\\"cookie\\": \\"escaped-cookie-secret\\"', ['escaped-cookie-secret']],
      ['authorization bearer', 'Authorization: Bearer bearer-secret-123', ['bearer-secret-123']],
      ['escaped json authorization', '\\"Authorization\\": \\"Bearer json-bearer-456\\"', ['json-bearer-456']],
      ['sk-ant token', 'sk-ant-api03-secretkey999', ['secretkey999']],
      ['ya29 token', 'ya29.a0AfH6secret999', ['secret999']],
      ['ghp token', 'ghp_1234secret999', ['secret999']],
      ['github_pat token', 'github_pat_1234secret999', ['secret999']],
      ['glpat token', 'glpat-1234secret999', ['secret999']],
      ['jwt token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2VjcmV0c2lnbmF0dXJl', ['c2VjcmV0c2lnbmF0dXJl']],
      ['cli --api-key', '--api-key=cli-secret-777', ['cli-secret-777']],
      ['url basic auth', 'https://admin:url-pass-888@example.com/v1', ['url-pass-888']],
      ['single-line pem', '-----BEGIN PRIVATE KEY-----MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw-----END PRIVATE KEY-----', ['MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw']],
      [
        'unterminated multiline pem preserves post-pem diagnostic',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789abcdef\nNormal diagnostic after pem',
        ['MIIEpAIBAAKCAQEA0123456789abcdef'],
        'Normal diagnostic after pem',
      ],
      [
        'indented multiline pem + short tail',
        '    -----BEGIN RSA PRIVATE KEY-----\n    MIIEpAIBAAKCAQEA0123456789abcdef\n    abCD12==\n    -----END RSA PRIVATE KEY-----',
        ['MIIEpAIBAAKCAQEA0123456789abcdef', 'abCD12==', 'END RSA PRIVATE KEY'],
      ],
      [
        'unindented multiline pem + short tail',
        '-----BEGIN PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789abcdef\nxyz=\n-----END PRIVATE KEY-----',
        ['MIIEpAIBAAKCAQEA0123456789abcdef', 'xyz=', 'END RSA PRIVATE KEY'.replace('RSA ', '')],
      ],
      [
        'unterminated indented pem + short tail preserves post-pem diagnostic',
        '  -----BEGIN RSA PRIVATE KEY-----\n  MIIEpAIBAAKCAQEA0123456789abcdef\n  abCD==\nNormal diagnostic after pem',
        ['MIIEpAIBAAKCAQEA0123456789abcdef', 'abCD=='],
        'Normal diagnostic after pem',
      ],
    ];

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROGRESS_FD;

    for (const [label, payload, secrets, preserve] of corpus) {
      // 1. REDACT_SED
      const sedOut = execSync(REDACT_SED, { input: payload + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      assert.ok(sedOut.includes('[REDACTED'), `REDACT_SED [${label}] must emit [REDACTED*; got: ${sedOut}`);
      for (const s of secrets) assert.ok(!sedOut.includes(s), `REDACT_SED [${label}] leaked ${s}`);
      if (preserve) assert.ok(sedOut.includes(preserve), `REDACT_SED [${label}] must preserve "${preserve}"; got: ${sedOut}`);

      // 2. stream-format.js tool_use Bash.command
      const toolJson = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: payload } }] },
      }) + '\n';
      const toolRun = spawnSync('node', [FORMATTER_PATH], { input: toolJson, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
      assert.equal(toolRun.status, 0, `stream-format tool_use [${label}] exited ${toolRun.status}`);
      assert.ok(toolRun.stdout.includes('[REDACTED'), `stream-format tool_use [${label}] must emit [REDACTED*; got: ${toolRun.stdout}`);
      for (const s of secrets) assert.ok(!toolRun.stdout.includes(s), `stream-format tool_use [${label}] leaked ${s}`);
      if (preserve) assert.ok(toolRun.stdout.includes(preserve), `stream-format tool_use [${label}] must preserve "${preserve}"; got: ${toolRun.stdout}`);

      // 3. stream-format.js result (is_error: true)
      const resJson = JSON.stringify({ type: 'result', is_error: true, result: payload }) + '\n';
      const resRun = spawnSync('node', [FORMATTER_PATH], { input: resJson, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
      assert.equal(resRun.status, 0, `stream-format result [${label}] exited ${resRun.status}`);
      assert.ok(resRun.stdout.includes('[REDACTED'), `stream-format result [${label}] must emit [REDACTED*; got: ${resRun.stdout}`);
      for (const s of secrets) assert.ok(!resRun.stdout.includes(s), `stream-format result [${label}] leaked ${s}`);
      if (preserve) assert.ok(resRun.stdout.includes(preserve), `stream-format result [${label}] must preserve "${preserve}"; got: ${resRun.stdout}`);

      // 4. stream-format.js non-JSON passthrough stdin
      const passRun = spawnSync('node', [FORMATTER_PATH], { input: payload + '\n', env: cleanEnv, encoding: 'utf8', timeout: 5000 });
      assert.equal(passRun.status, 0, `stream-format passthrough [${label}] exited ${passRun.status}`);
      assert.ok(passRun.stdout.includes('[REDACTED'), `stream-format passthrough [${label}] must emit [REDACTED*; got: ${passRun.stdout}`);
      for (const s of secrets) assert.ok(!passRun.stdout.includes(s), `stream-format passthrough [${label}] leaked ${s}`);
      if (preserve) assert.ok(passRun.stdout.includes(preserve), `stream-format passthrough [${label}] must preserve "${preserve}"; got: ${passRun.stdout}`);
    }

    // F-3 & T-1: hostile tool_use block.name redaction, OSC 52 strip, and <=64 char rendered tool name cap
    const hostileName = 'mcp__Authorization: Bearer tool-name-secret\n\x1b]52;c;evil\x07__' + 'z'.repeat(90);
    const f3Json = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: hostileName, input: { command: 'echo ok' } }] },
    }) + '\n';
    const f3Run = spawnSync('node', [FORMATTER_PATH], { input: f3Json, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(f3Run.status, 0, `F-3 exited ${f3Run.status}`);
    assert.ok(!f3Run.stdout.includes('tool-name-secret'), 'F-3 must redact secret inside tool_use block.name');
    assert.ok(!f3Run.stdout.includes('\x1b]52'), 'F-3 must strip OSC 52 escape sequence from tool_use block.name');
    assert.ok(f3Run.stdout.includes('[REDACTED]'), `F-3 must emit [REDACTED]; got: ${f3Run.stdout}`);
    assert.ok(f3Run.stdout.trimEnd().length < 200, `F-3 output line must be < 200 chars, got ${f3Run.stdout.trimEnd().length}`);
    const plainF3 = f3Run.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const nameMatch = plainF3.match(/⏵ ([^\n:]+?)(?:: |\n|$)/);
    assert.ok(nameMatch, `T-1 must render ⏵ tool line; got: ${plainF3}`);
    assert.ok(nameMatch[1].length <= 64, `T-1 rendered tool name must be <= 64 chars (got ${nameMatch[1].length}: ${nameMatch[1]})`);

    // T-2: TOOL_COLOR lookup must not resolve Object.prototype keys
    const t2Input = ['constructor', 'toString', '__proto__'].map((name) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { command: 'echo ok' } }] } })
    ).join('\n') + '\n';
    const t2Run = spawnSync('node', [FORMATTER_PATH], { input: t2Input, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(t2Run.status, 0, `T-2 exited ${t2Run.status}`);
    assert.ok(!t2Run.stdout.includes('function '), `T-2 must not interpolate prototype function into ANSI prefix; got: ${t2Run.stdout}`);
    assert.ok(!t2Run.stdout.includes('[native code]'), `T-2 must not interpolate [native code]; got: ${t2Run.stdout}`);
    assert.ok(t2Run.stdout.includes('⏵ constructor'), `T-2 must render tool name constructor; got: ${t2Run.stdout}`);

    // F-11: object-shaped model, session_id, tool_use.name, tool_use.input.command
    const f11Input = [
      JSON.stringify({ type: 'system', subtype: 'init', model: { id: 'm1' }, session_id: { sid: 's1' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: { tool: 't1' }, input: { command: { cmd: 'Bearer obj-cmd-sec' } } }] },
      }),
    ].join('\n') + '\n';
    const f11Run = spawnSync('node', [FORMATTER_PATH], { input: f11Input, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(f11Run.status, 0, `F-11 exited ${f11Run.status}`);
    assert.ok(!f11Run.stdout.includes('[object Object]'), `F-11 must not emit [object Object]; got: ${f11Run.stdout}`);
    assert.ok(!f11Run.stdout.includes('obj-cmd-sec'), 'F-11 must redact secret inside object command');

    // L-2: object-shaped result (is_error: true) serialized without [object Object] and redacted
    const l2Input = JSON.stringify({ type: 'result', is_error: true, result: { code: 400, auth: 'Bearer obj-secret-1' } }) + '\n';
    const l2Run = spawnSync('node', [FORMATTER_PATH], { input: l2Input, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(l2Run.status, 0, `L-2 exited ${l2Run.status}`);
    assert.ok(!l2Run.stdout.includes('[object Object]'), `L-2 must not emit [object Object]; got: ${l2Run.stdout}`);
    assert.ok(!l2Run.stdout.includes('obj-secret-1'), 'L-2 must redact secret inside object result');
    assert.ok(l2Run.stdout.includes('400'), 'L-2 must serialize JSON payload');

    // L-3: assistant text without trailing \n followed by non-JSON passthrough line
    const l3Input = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no-trailing-nl' }] } }) + '\nraw-line\n';
    const l3Run = spawnSync('node', [FORMATTER_PATH], { input: l3Input, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(l3Run.status, 0, `L-3 exited ${l3Run.status}`);
    assert.ok(l3Run.stdout.includes('no-trailing-nl\nraw-line\n'), `L-3 must insert newline before passthrough line; got: ${JSON.stringify(l3Run.stdout)}`);

    // L-4: CLAUDE_PROGRESS_FD=1 emits ⚡ and Turn1 separated by \n on stdout
    const l4Input = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', session_id: 's-l4' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Turn1' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Turn2' }] } }),
    ].join('\n') + '\n';
    const l4Run = spawnSync('node', [FORMATTER_PATH], {
      input: l4Input,
      env: { ...cleanEnv, CLAUDE_PROGRESS_FD: '1' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(l4Run.status, 0, `L-4 exited ${l4Run.status}`);
    assert.ok(l4Run.stdout.includes('⚡') && l4Run.stdout.includes('\nTurn1'), `L-4 must separate ⚡ and Turn1 with newline; got: ${JSON.stringify(l4Run.stdout)}`);
    assert.ok(l4Run.stdout.includes('Turn1\n') && l4Run.stdout.includes('Turn2'), `L-4 must separate Turn1 and tool_use/Turn2 with newline; got: ${JSON.stringify(l4Run.stdout)}`);
  });

  it('DR-F1: socketpair stderr cascade works undrained without timeout (R-3), drains progress & caps socket queue (T-3)', async () => {
    const t1Tools = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo sp1_${i}_padding_for_socketpair` } }] },
      })
    );
    writeFixture('FIXTURE_SP_T1', 1, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p1', session_id: 's-sp1' }),
      ...t1Tools,
      JSON.stringify({ type: 'error', error: { message: 'API Error: 429 Too Many Requests' } }),
    ]);
    fs.writeFileSync(
      path.join(tmpDir, 'FIXTURE_SP_T1.err'),
      ('STDERR_300K_' + 'x'.repeat(80) + '\n').repeat(3400)
    );

    const t2Tools = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo sp2_${i}_padding_for_socketpair` } }] },
      })
    );
    writeFixture('FIXTURE_SP_T2', 0, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p2', session_id: 's-sp2' }),
      ...t2Tools,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SOCKETPAIR_CASCADE_OK\n' }] } }),
    ]);

    const { command } = JSON.parse(buildCommand({
      prompt: 'test socketpair cascade',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockClaudeBin, CLAUDE_TIMEOUT: '5' }).content[0].text);

    // Part A (R-3): undrained socketpair + no-timeout PATH
    const noTimeoutBinDir = buildNoTimeoutBinDir();
    const noToRuntime = fs.mkdtempSync(path.join(tmpDir, 'sp-noto-'));
    fs.writeFileSync(behaviorFile, 'FIXTURE_SP_T1\nFIXTURE_SP_T2\n');

    const t0 = Date.now();
    let timedOut = false;
    const childA = spawn(path.join(noTimeoutBinDir, 'bash'), {
      env: { ...process.env, PATH: noTimeoutBinDir, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: noToRuntime },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Intentionally do NOT attach any listener or .resume() to childA.stderr
    const stdoutAChunks = [];
    childA.stdout.on('data', (chunk) => stdoutAChunks.push(chunk));
    childA.stdin.end(command);

    const safetyTimer = setTimeout(() => {
      timedOut = true;
      childA.kill('SIGKILL');
    }, 4500);

    const codeA = await new Promise((resolve) => {
      childA.on('close', (exitCode) => {
        clearTimeout(safetyTimer);
        resolve(exitCode);
      });
    });
    const elapsedA = Date.now() - t0;
    const stdoutA = Buffer.concat(stdoutAChunks).toString('utf8');

    assert.equal(timedOut, false, `Part A: socketpair stderr hung past 4500ms safety kill (elapsed ${elapsedA}ms)`);
    assert.equal(codeA, 0, `Part A: expected exit 0 on socketpair cascade without timeout, got ${codeA}`);
    assert.ok(elapsedA < 4000, `Part A: expected <4000ms without socketpair block, took ${elapsedA}ms`);
    assert.ok(stdoutA.includes('SOCKETPAIR_CASCADE_OK'), `Part A: stdout must include SOCKETPAIR_CASCADE_OK, got: ${stdoutA}`);

    // Part B1 (T-3): drained socketpair progress delivery
    const drainedRuntime = fs.mkdtempSync(path.join(tmpDir, 'sp-drain-'));
    fs.writeFileSync(behaviorFile, 'FIXTURE_SP_T1\nFIXTURE_SP_T2\n');
    const childB = spawn('bash', {
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: drainedRuntime },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutBChunks = [];
    const stderrBChunks = [];
    childB.stdout.on('data', (chunk) => stdoutBChunks.push(chunk));
    childB.stderr.on('data', (chunk) => stderrBChunks.push(chunk));
    childB.stdin.end(command);
    const codeB = await new Promise((resolve) => childB.on('close', resolve));
    const stdoutB = Buffer.concat(stdoutBChunks).toString('utf8');
    const stderrB = Buffer.concat(stderrBChunks).toString('utf8');

    assert.equal(codeB, 0, `Part B1: expected exit 0, got ${codeB}`);
    assert.ok(stdoutB.includes('SOCKETPAIR_CASCADE_OK'), 'Part B1: stdout must include SOCKETPAIR_CASCADE_OK');
    assert.ok(stderrB.includes('⚡ model:'), 'Part B1: drained socketpair stderr must deliver ⚡ model: progress');
    assert.ok(stderrB.includes('⏵'), 'Part B1: drained socketpair stderr must deliver ⏵ tool_use progress');

    // Part B2 (T-3): paused/undrained stream-format.js socketpair drops excess progress (16384 writableLength cap)
    const capEvents = [
      ...Array.from({ length: 2000 }, (_, i) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              name: 'Bash',
              input: { command: `echo prog_${String(i).padStart(4, '0')}_${'a'.repeat(80)}` },
            }],
          },
        })
      ),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CAP_DONE\n' }] } }),
    ].join('\n') + '\n';
    const capFile = path.join(tmpDir, 'cap-events.jsonl');
    fs.writeFileSync(capFile, capEvents);

    const pySocketCap = [
      'import os, socket, subprocess, json, sys',
      'fmt, cap_file = sys.argv[1], sys.argv[2]',
      's_parent, s_child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)',
      's_parent.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)',
      's_parent.setblocking(False)',
      'with open(cap_file, "rb") as f: payload = f.read()',
      'env = dict(os.environ, CLAUDE_PROGRESS_FD=str(s_child.fileno()))',
      'p = subprocess.Popen(["node", fmt], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(s_child.fileno(),), env=env)',
      's_child.close()',
      'try:',
      '    out, err = p.communicate(payload, timeout=3)',
      '    rc = p.returncode',
      'except subprocess.TimeoutExpired:',
      '    p.kill()',
      '    out, err = p.communicate()',
      '    rc = -1',
      'total = 0',
      'while True:',
      '    try:',
      '        chunk = s_parent.recv(65536)',
      '        if not chunk: break',
      '        total += len(chunk)',
      '    except BlockingIOError:',
      '        break',
      's_parent.close()',
      'print(json.dumps({"rc": rc, "receivedBytes": total, "stdout": out.decode("utf8", "replace"), "stderr": err.decode("utf8", "replace")}))',
    ].join('\n');

    const capRun = spawnSync('python3', ['-c', pySocketCap, FORMATTER_PATH, capFile], { encoding: 'utf8', timeout: 8000 });
    assert.equal(capRun.status, 0, `Part B2: python3 socketpair driver failed: ${capRun.stderr}`);
    const capRes = JSON.parse(capRun.stdout);
    assert.equal(capRes.rc, 0, `Part B2: stream-format.js exited ${capRes.rc}; stderr=${capRes.stderr}`);
    assert.ok(capRes.stdout.includes('CAP_DONE'), 'Part B2: stdout must emit CAP_DONE');
    assert.ok(
      capRes.receivedBytes > 0 && capRes.receivedBytes < 180000,
      `Part B2: expected 0 < receivedBytes < 180000 due to bounded socket write cap, got ${capRes.receivedBytes}`
    );
  });

  it('DR-R1-R2: preserves >1.1MB raw stderr tail and never leaks O_NONBLOCK onto shell FD 2', () => {
    const bigErr = ('STDERR_1MB_LINE_' + 'x'.repeat(80) + '\n').repeat(11500) + 'FINAL_1MB_STDERR_TAIL_OK\n';
    writeFixture('FIXTURE_1MB_T1', 1, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p1', session_id: 's-1mb-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo t1_prog' } }] } }),
      JSON.stringify({ type: 'error', error: { message: 'API Error: 429 Too Many Requests' } }),
    ]);
    fs.writeFileSync(path.join(tmpDir, 'FIXTURE_1MB_T1.err'), bigErr);

    writeFixture('FIXTURE_1MB_T2', 0, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'vertex-p2', session_id: 's-1mb-2' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'R1_R2_CASCADE_OK\n' }] } }),
    ]);
    fs.writeFileSync(behaviorFile, 'FIXTURE_1MB_T1\nFIXTURE_1MB_T2\n');

    const { command } = JSON.parse(buildCommand({
      prompt: 'test 1.1mb stderr and fd2 flags',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockClaudeBin }).content[0].text);

    const run = spawnSync('bash', {
      input: command + '\ngrep "^flags:" /proc/self/fdinfo/2 >&2\n',
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });

    assert.equal(run.status, 0, `Expected exit 0, got ${run.status}; stderr=${run.stderr.slice(0, 200)}`);
    assert.ok(run.stdout.includes('R1_R2_CASCADE_OK'), 'stdout must include R1_R2_CASCADE_OK');
    assert.ok(run.stderr.length > 1_050_000, `stderr must not truncate >1.1MB output (got ${run.stderr.length})`);
    assert.ok(run.stderr.includes('FINAL_1MB_STDERR_TAIL_OK'), 'stderr must preserve FINAL_1MB_STDERR_TAIL_OK at tail');

    const flagsMatches = [...run.stderr.matchAll(/^flags:\s*([0-7]+)/gm)];
    assert.ok(flagsMatches.length > 0, 'stderr must include /proc/self/fdinfo/2 flags line');
    const octalFlags = flagsMatches[flagsMatches.length - 1][1];
    assert.equal(parseInt(octalFlags, 8) & 0o4000, 0, `O_NONBLOCK (04000) must not leak onto shell FD 2 (flags=${octalFlags})`);
  });

  it('DR-S5: O(n) redaction completes under 1000ms on 200KB trailing spaces and 80KB unclosed key', () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROGRESS_FD;

    const payload = [
      'authorization:' + ' '.repeat(200000),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ENMAAS_KEY="long-sec-val-' + 'x'.repeat(80000) } }] },
      }),
    ].join('\n') + '\n';

    const t0 = Date.now();
    const run = spawnSync('node', [FORMATTER_PATH], { input: payload, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    const elapsed = Date.now() - t0;

    assert.equal(run.status, 0, `stream-format.js exited ${run.status}: ${run.stderr}`);
    assert.ok(elapsed < 1000, `Expected O(n) redaction <1000ms, took ${elapsed}ms`);
    assert.ok(run.stdout.includes('[REDACTED]'), 'Must redact 80KB unclosed key value');
    assert.ok(!run.stdout.includes('long-sec-val-'), 'Must not leak long-sec-val-');
  });
});
